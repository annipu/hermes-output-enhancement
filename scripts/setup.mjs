// Unified install entry (EXPERIMENTAL) — host patch + style plugin in one command.
// A THIN orchestration layer: every piece of component logic stays in
// scripts/host-binary-patch.mjs and scripts/plugin-install.mjs, which are
// spawned as subprocesses — nothing is reimplemented here.
//
// Semantics (review-agreed 2026-11-03):
//   - dry-run by default; --apply writes.
//   - all-or-nothing preflight: BOTH components are dry-run first; if either
//     refuses (unknown host build, foreign/old plugin target, process guards…)
//     NOTHING is written and the entry exits nonzero. In particular an
//     unrecognized host build (e.g. the 2026-11-03 self-update c6807894…)
//     refuses the whole unified install until the patch is re-derived for it.
//   - order: host patch -> plugin install. A plugin failure undoes ONLY the
//     host patch applied by THIS transaction; a pre-existing patch is never
//     rolled back. The persistent record distinguishes the two.
//   - persistent transaction records under .local/setup-transactions/ let a
//     rerun recognize a partially completed run and continue or compensate it.
//   - a cross-component lock (.local/setup.lock) is independent of the
//     component locks; conservative stale handling (malformed = refuse).
//   - --uninstall removes ONLY the plugin (the host patch may serve other
//     plugins); --uninstall --with-host-patch additionally reverts the patch.
//   - a unified machine-readable report is printed and saved to
//     .local/setup-latest.json (checks / changes / recovery / manual-needed).
// INTERNAL fault injection (test matrix only): --inject=crash-after-host
// (exit 70 right after the host switch, record already updated),
// plugin-apply (force the plugin APPLY step to fail after preflight),
// host-rollback-fault (make the compensation rollback fail deterministically).
import { readFile, writeFile, mkdir, rm, open, readdir, lstat, chmod, rename } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
// Read-only host probe (install-status) — reports the NON-selected half without
// gating on it, so a plugin-only run is never blocked by an unknown build.
import { probeHost } from './install-status.mjs'
// Interactive front-end (wizard) — setup-wizard.mjs carries its own locale table.
import { runWizard, makeAskAdapter } from './setup-wizard.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)

const opt = name => { const hit = argv.findLast(a => a.startsWith(`--${name}=`)); return hit ? hit.slice(name.length + 3) : null }
const APPLY = argv.includes('--apply')
const UNINSTALL = argv.includes('--uninstall')
const WITH_HOST = argv.includes('--with-host-patch')
const INJECT = new Set((opt('inject') ?? '').split(',').filter(Boolean))
const COMPONENTS_RAW = opt('components')
if (COMPONENTS_RAW != null && !/^(plugin|host)(,(plugin|host))?$/.test(COMPONENTS_RAW)) die('--components= accepts: plugin, host, or plugin,host')
if (COMPONENTS_RAW != null && UNINSTALL) die('--components= only applies to install mode; uninstall selects components via --with-host-patch')
const appArg = opt('app')
const pluginTarget = opt('plugin-target') ?? path.join(root, '.local', 'unified-test', 'desktop-plugins')
const pluginSource = opt('plugin-source') ?? path.join(root, 'plugin', 'hermes-style-plugin')

const HOST_TOOL = path.join(root, 'scripts', 'host-binary-patch.mjs')
const PLUGIN_TOOL = path.join(root, 'scripts', 'plugin-install.mjs')
const LOCK = path.join(root, '.local', 'setup.lock')
const TX_DIR = path.join(root, '.local', 'setup-transactions')
const REPORT = path.join(root, '.local', 'setup-latest.json')
const KEY = 'hermes.desktop.pluginDecisions.v2'

class Fatal extends Error {}
const say = s => console.log(s)
const die = msg => { console.error(`[error] ${msg}`); throw new Fatal(msg) }
const runNode = (script, args) => spawnSync('node', [script, ...args], { encoding: 'utf8', cwd: root })
const hostRun = args => runNode(HOST_TOOL, ['--app=' + appArg, ...args])
// --plugin-only: the orchestrator owns the host-patch half; the plugin
// installer's complete-install exit check must not double-judge it.
const pluginRun = args => runNode(PLUGIN_TOOL, ['--target=' + pluginTarget, '--source=' + pluginSource, '--plugin-only', ...args])
const firstError = text => (text.split('\n').find(l => l.startsWith('[error]') || l.startsWith('[refuse]')) ?? text.split('\n')[0] ?? '').trim()

// --- component state classification (dry-run outputs are the interface) ---
function classifyHost(r) {
  if (r.status !== 0) return { state: 'refused', why: firstError(r.stderr || r.stdout) }
  if (/already patched and complete/.test(r.stdout)) return { state: 'already' }
  if (/\[plan\] a previous run switched/.test(r.stdout)) return { state: 'finalizable' }
  if (/\[plan\] patch /.test(r.stdout)) return { state: 'would-patch' }
  if (/\[plan\] restore the pinned original/.test(r.stdout)) return { state: 'would-rollback' }
  if (/target already matches the pinned original/.test(r.stdout)) return { state: 'already-original' }
  return { state: 'unknown', why: 'unrecognized host tool output' }
}
function classifyPlugin(r) {
  if (r.status !== 0) return { state: 'refused', why: firstError(r.stderr || r.stdout) }
  if (/\[plan\] fresh install /.test(r.stdout)) return { state: 'install' }
  if (/\[plan\] UPGRADE /.test(r.stdout)) return { state: 'upgrade' }
  if (/already at .* identical bytes/.test(r.stdout)) return { state: 'noop' }
  if (/\[plan\] uninstall /.test(r.stdout)) return { state: 'would-uninstall' }
  if (/nothing to uninstall/.test(r.stdout)) return { state: 'noop-uninstall' }
  return { state: 'unknown', why: 'unrecognized plugin tool output' }
}

// --- report-only chunk hash (the host tool remains the authority) ---
async function reportChunkSha() {
  try {
    const assets = path.join(appArg, 'Contents/Resources/app.asar.unpacked/dist/assets')
    for (const entry of await readdir(assets)) {
      if (!entry.endsWith('.js')) continue
      const text = await readFile(path.join(assets, entry), 'utf8')
      if (text.includes(KEY)) return createHash('sha256').update(text).digest('hex')
    }
  } catch {}
  return null
}

// --- cross-component lock (conservative: malformed is never auto-deleted) ---
async function acquireLock() {
  await mkdir(path.dirname(LOCK), { recursive: true })
  try {
    const h = await open(LOCK, 'wx')
    try { await h.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + '\n') } finally { await h.close() }
    return true
  } catch (e) {
    if (e.code !== 'EEXIST') die(`setup lock create failed: ${e.message}`)
    let info = null
    try { info = JSON.parse(await readFile(LOCK, 'utf8')) } catch { die(`setup lock ${LOCK} is unreadable or malformed — refusing to guess; inspect and remove it manually if stale`) }
    let alive = false
    try { process.kill(info.pid, 0); alive = true } catch (e) { alive = e.code !== 'ESRCH' }
    if (alive || !Number.isInteger(info.pid)) die(`another setup run holds ${LOCK} (pid ${info.pid ?? '?'}) — refusing`)
    say(`[lock] removing a stale setup lock (pid ${info.pid} is gone)`)
    await rm(LOCK, { force: true })
    const h = await open(LOCK, 'wx')
    try { await h.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + '\n') } finally { await h.close() }
    return true
  }
}

// --- persistent transaction records ---
async function latestPendingTx(mode) {
  try {
    const names = (await readdir(TX_DIR)).filter(n => n.endsWith('.json')).sort()
    for (const name of names.reverse()) {
      try {
        const tx = JSON.parse(await readFile(path.join(TX_DIR, name), 'utf8'))
        if (tx.status === 'pending' && tx.app === appArg && tx.pluginTarget === pluginTarget && (tx.mode ?? 'install') === mode) return tx
      } catch {}
    }
  } catch {}
  return null
}
const txFile = tx => path.join(TX_DIR, tx.file)
async function writeTx(tx) {
  await mkdir(TX_DIR, { recursive: true })
  const f = txFile(tx), tmp = f + '.tmp-' + process.pid
  await writeFile(tmp, JSON.stringify(tx, null, 2) + '\n')
  await rename(tmp, f) // staged + rename: a reader never sees a half-written record
}

async function main() {
  // Interactive wizard: no arguments AND a full TTY (stdin AND stdout). Any
  // other invocation keeps the flag contract (missing --app is a usage error).
  // makeAskAdapter settles pending questions on EOF/Ctrl-C with null — the
  // wizard turns that into a safe localized cancel (no blanket catch).
  if (argv.length === 0 && process.stdin.isTTY && process.stdout.isTTY) {
    const io = makeAskAdapter()
    try { return await runWizard(io) } finally { io.close() }
  }
  say('[experimental] unified install entry — host patch + style plugin (thin orchestrator)')
  if (!appArg) die('usage: node scripts/setup.mjs --app=<Hermes.app> [--apply] [--components=plugin|host|plugin,host] [--uninstall [--with-host-patch]] [--plugin-target=…] [--plugin-source=…]')
  if (WITH_HOST && !UNINSTALL) die('--with-host-patch only makes sense together with --uninstall')

  // ---------- component selection ----------
  // selected = what THIS run may modify. Flag defaults keep the original
  // semantics (install: host+plugin; uninstall: plugin, +host only with
  // --with-host-patch); --components= narrows an install explicitly. The
  // interactive wizard uses the same model.
  const mode = UNINSTALL ? 'uninstall' : 'install'
  const selected = new Set(UNINSTALL
    ? (WITH_HOST ? ['plugin', 'host'] : ['plugin'])
    : (COMPONENTS_RAW ? COMPONENTS_RAW.split(',') : ['host', 'plugin']))

  const pending = await latestPendingTx(mode)
  if (pending) say(`[tx] continuing interrupted transaction ${pending.file} (started ${pending.at})`)

  // ---------- preflight (read-only) ----------
  // Only SELECTED components gate the run; the other half is probed read-only
  // and reported, so plugin-only is never blocked by an unknown host build or
  // a running app, and host-only never touches the plugin directory.
  const hostState = selected.has('host')
    ? classifyHost(hostRun(UNINSTALL && WITH_HOST ? ['--rollback'] : []))
    : { state: 'not-selected', why: null, probe: (await probeHost(appArg)).state }
  const pluginState = selected.has('plugin')
    ? classifyPlugin(pluginRun(UNINSTALL ? ['uninstall'] : []))
    : { state: 'not-selected', why: null }
  const chunkSha = await reportChunkSha()
  const report = {
    mode, components: [...selected].sort(), apply: APPLY, app: appArg, pluginTarget, pluginSource,
    host: { state: hostState.state, why: hostState.why ?? null, probe: hostState.probe ?? null, chunkSha256: chunkSha, patchedByThisRun: false },
    plugin: { state: pluginState.state, why: pluginState.why ?? null },
    steps: [], status: 'planned', manualNeeded: null, overall: null,
  }
  say(`[plan] host: ${hostState.state}${hostState.why ? ` — ${hostState.why}` : ''}${hostState.probe ? ` (report-only probe: ${hostState.probe})` : ''}`)
  say(`[plan] plugin: ${pluginState.state}${pluginState.why ? ` — ${pluginState.why}` : ''}`)
  if (pending) say(`[tx] the interrupted record says hostPatchedByUs=${pending.hostPatchedByUs}`)

  const refused = s0 => s0.state === 'refused' || s0.state === 'unknown'
  if ([...selected].some(c => refused(c === 'host' ? hostState : pluginState))) {
    report.status = 'refused'
    say('[refuse] preflight failed — NOTHING was written (all-or-nothing across the selected components)')
    if (selected.has('host') && hostState.state === 'refused' && /pinned|unknown build|running/.test(hostState.why ?? '')) {
      say('[hint] the host build is not a registered patch target (or the app is running) —')
      say('       use --components=plugin for the plugin alone, or npm run plugin:install')
    }
    await mkdir(path.dirname(REPORT), { recursive: true }); await writeFile(REPORT, JSON.stringify(report, null, 2) + '\n')
    return 1
  }

  if (!APPLY) { say('[dry-run] no changes written — re-run with --apply to execute.'); report.status = 'dry-run' }
  else {
    // ---------- apply ----------
    const held = await acquireLock()
    // (hardening) re-classify the SELECTED components INSIDE the lock: the
    // preflight above ran unlocked and the world may have moved since.
    const hostNow = selected.has('host') ? classifyHost(hostRun(UNINSTALL && WITH_HOST ? ['--rollback'] : [])) : hostState
    const pluginNow = selected.has('plugin') ? classifyPlugin(pluginRun(UNINSTALL ? ['uninstall'] : [])) : pluginState
    const tx = pending ?? {
      schema: 1, file: `${new Date().toISOString().replace(/[:]/g, '-')}.json`, at: new Date().toISOString(),
      mode, components: [...selected], app: appArg, pluginTarget,
      hostPre: hostNow.state, pluginPre: pluginNow.state,
      hostPatchedByUs: false, steps: [], status: 'pending',
    }
    try {
      if ([...selected].some(c => refused(c === 'host' ? hostNow : pluginNow))) {
        report.status = 'refused'; tx.status = 'refused'; await writeTx(tx)
        report.host.state = hostNow.state; report.host.why = hostNow.why ?? null
        report.plugin.state = pluginNow.state; report.plugin.why = pluginNow.why ?? null
        say('[refuse] state changed under the lock — NOTHING was written')
        return 1
      }
      // (hardening) the pending record is persisted BEFORE any mutation.
      tx.status = 'pending'; await writeTx(tx)

      if (UNINSTALL) {
        if (pluginNow.state === 'would-uninstall') {
          const r = pluginRun(['uninstall', '--apply'])
          report.steps.push({ name: 'plugin-uninstall', ok: r.status === 0, detail: firstError(r.status === 0 ? r.stdout : r.stderr) })
          if (r.status !== 0) { report.status = 'failed'; die(`plugin uninstall failed: ${firstError(r.stderr)}`) }
        } else report.steps.push({ name: 'plugin-uninstall', ok: true, detail: 'noop' })
        if (WITH_HOST && selected.has('host') && hostNow.state === 'would-rollback') {
          const r = hostRun(['--rollback', '--production'])
          report.steps.push({ name: 'host-rollback', ok: r.status === 0, detail: firstError(r.status === 0 ? r.stdout : r.stderr) })
          if (r.status !== 0) { report.status = 'failed'; die(`host rollback failed: ${firstError(r.stderr)}`) }
        }
        report.status = 'uninstalled'
        tx.status = 'uninstalled'; await writeTx(tx)
      } else {
        // step 1: host patch. Ownership is claimed from the tool's REAL output
        // ('already patched and complete' means THIS run changed nothing), not
        // from the pre-lock classification.
        if (selected.has('host') && (hostNow.state === 'would-patch' || hostNow.state === 'finalizable')) {
          const r = hostRun(['--production'])
          const ok = r.status === 0
          report.steps.push({ name: 'host-patch', ok, detail: firstError(ok ? r.stdout : r.stderr) })
          if (!ok) { report.status = 'failed'; tx.status = 'failed'; await writeTx(tx); die(`host patch failed: ${firstError(r.stderr)}`) }
          if (/\[ok\] patched /.test(r.stdout)) { tx.hostPatchedByUs = true; report.host.patchedByThisRun = true }
          else if (!/already patched and complete/.test(r.stdout)) {
            say('[warn] host tool output not recognized for ownership — conservatively assuming THIS run patched (compensation-eligible)')
            tx.hostPatchedByUs = true; report.host.patchedByThisRun = true
          }
          tx.steps.push('host-patch'); await writeTx(tx)
          if (INJECT.has('crash-after-host')) { console.error('[inject] simulating a crash after the host switch'); process.exit(70) }
        } else if (selected.has('host')) {
          report.steps.push({ name: 'host-patch', ok: true, detail: `skipped: host is ${hostNow.state} (verified, no change needed)` })
        }
        // step 2: plugin install — only when selected; failure compensates
        // ONLY a patch this transaction applied (a pre-existing patch stays).
        if (selected.has('plugin')) {
          const pluginArgs = ['--apply']
          if (INJECT.has('plugin-apply')) pluginArgs.push('--source=' + path.join(root, '.local', 'unified-test', 'nonexistent-source'))
          const r = pluginRun(pluginArgs)
          if (r.status !== 0) {
            report.steps.push({ name: 'plugin-install', ok: false, detail: firstError(r.stderr) })
            if (tx.hostPatchedByUs) {
              say('[compensate] plugin install failed — rolling back the host patch THIS transaction applied')
              let cr
              if (INJECT.has('host-rollback-fault')) {
                const assets = path.join(appArg, 'Contents/Resources/app.asar.unpacked/dist/assets')
                await chmod(assets, 0o555).catch(() => {})
                cr = hostRun(['--rollback', '--production'])
                await chmod(assets, 0o755).catch(() => {})
              } else cr = hostRun(['--rollback', '--production'])
              if (cr.status === 0 && /rolled back/.test(cr.stdout)) {
                report.steps.push({ name: 'host-rollback-compensation', ok: true, detail: 'patch applied by this transaction was rolled back' })
                report.status = 'compensated'; tx.status = 'compensated'; await writeTx(tx)
                die('plugin install failed — host patch rolled back (compensated); nothing left behind')
              }
              report.steps.push({ name: 'host-rollback-compensation', ok: false, detail: firstError(cr.stderr || cr.stdout) })
              report.status = 'compensation-failed'; report.manualNeeded = `host patch is still applied but the plugin failed: run node scripts/host-binary-patch.mjs --app='${appArg}' --rollback --production manually`
              tx.status = 'compensation-failed'; await writeTx(tx)
              die('plugin install failed AND compensation failed — MANUAL ACTION REQUIRED (see report)')
            }
            report.status = 'failed'; tx.status = 'failed'; await writeTx(tx)
            die(`plugin install failed: ${firstError(r.stderr)} (host patch was pre-existing and was NOT touched)`)
          }
          report.steps.push({ name: 'plugin-install', ok: true, detail: firstError(r.stdout) })
        } else {
          report.steps.push({ name: 'plugin-install', ok: true, detail: 'skipped: plugin not selected' })
        }
        // step 3: post-verify — SELECTED components only; a failure here is a
        // NONZERO exit, never a quiet "warnings" success.
        if (INJECT.has('post-verify-tamper') && selected.has('host')) {
          const assets = path.join(appArg, 'Contents/Resources/app.asar.unpacked/dist/assets')
          for (const n of await readdir(assets)) {
            if (!n.endsWith('.js')) continue
            const f = path.join(assets, n)
            if ((await readFile(f, 'utf8')).includes(KEY)) await writeFile(f, (await readFile(f)) + '//drift')
          }
        }
        const hostAfter = selected.has('host') ? classifyHost(hostRun([])) : hostState
        const pluginAfter = selected.has('plugin') ? classifyPlugin(pluginRun([])) : pluginState
        const okAfter = (!selected.has('host') || hostAfter.state === 'already') && (!selected.has('plugin') || pluginAfter.state === 'noop')
        report.steps.push({ name: 'post-verify', ok: okAfter, detail: `host=${hostAfter.state} plugin=${pluginAfter.state}` })
        report.status = okAfter ? 'installed' : 'installed-with-warnings'
        tx.status = report.status; await writeTx(tx)
      }
    } catch (e) {
      // A mid-apply failure must still persist the unified report — the
      // compensation-failure evidence has to survive the nonzero exit.
      await mkdir(path.dirname(REPORT), { recursive: true })
      await writeFile(REPORT, JSON.stringify(report, null, 2) + '\n').catch(() => {})
      throw e
    } finally {
      if (held) await rm(LOCK, { force: true }).catch(() => {})
    }
  }

  // Overall completeness is reported independently of what was SELECTED:
  // a plugin-only success is NOT a complete installation.
  const hostProbe = await probeHost(appArg)
  let pluginPresent = false
  try { await readdir(path.join(pluginTarget, 'hermes-style-plugin')); pluginPresent = true } catch {}
  report.overall = hostProbe.state === 'patched-verified' && pluginPresent ? 'complete' : 'incomplete'

  await mkdir(path.dirname(REPORT), { recursive: true })
  await writeFile(REPORT, JSON.stringify(report, null, 2) + '\n')
  say('[report] ' + JSON.stringify({ status: report.status, overall: report.overall, host: report.host.state, plugin: report.plugin.state, manualNeeded: report.manualNeeded }))
  return report.status === 'planned' || /refused|failed|warnings/.test(report.status) ? 1 : 0
}

try { process.exit(await main()) } catch (e) { if (!(e instanceof Fatal)) console.error(`[error] unexpected failure: ${e.stack || e.message}`); process.exit(1) }
