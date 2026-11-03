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
import { readFile, writeFile, mkdir, rm, open, readdir, lstat, chmod } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const opt = name => { const hit = argv.findLast(a => a.startsWith(`--${name}=`)); return hit ? hit.slice(name.length + 3) : null }
const APPLY = argv.includes('--apply')
const UNINSTALL = argv.includes('--uninstall')
const WITH_HOST = argv.includes('--with-host-patch')
const INJECT = new Set((opt('inject') ?? '').split(',').filter(Boolean))
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
async function latestPendingTx() {
  try {
    const names = (await readdir(TX_DIR)).filter(n => n.endsWith('.json')).sort()
    for (const name of names.reverse()) {
      try {
        const tx = JSON.parse(await readFile(path.join(TX_DIR, name), 'utf8'))
        if (tx.status === 'pending' && tx.app === appArg) return tx
      } catch {}
    }
  } catch {}
  return null
}
const txFile = tx => path.join(TX_DIR, tx.file)
async function writeTx(tx) { await mkdir(TX_DIR, { recursive: true }); await writeFile(txFile(tx), JSON.stringify(tx, null, 2) + '\n') }

async function main() {
  say('[experimental] unified install entry — host patch + style plugin (thin orchestrator)')
  if (!appArg) die('usage: node scripts/setup.mjs --app=<Hermes.app> [--apply] [--uninstall [--with-host-patch]] [--plugin-target=…] [--plugin-source=…]')
  if (WITH_HOST && !UNINSTALL) die('--with-host-patch only makes sense together with --uninstall')

  const pending = await latestPendingTx()
  if (pending) say(`[tx] continuing interrupted transaction ${pending.file} (started ${pending.at})`)

  // ---------- preflight (read-only) ----------
  const hostState = classifyHost(hostRun(UNINSTALL && WITH_HOST ? ['--rollback'] : []))
  const pluginState = classifyPlugin(pluginRun(UNINSTALL ? ['uninstall'] : []))
  const chunkSha = await reportChunkSha()
  const report = {
    mode: UNINSTALL ? 'uninstall' : 'install', apply: APPLY, app: appArg, pluginTarget, pluginSource,
    host: { state: hostState.state, why: hostState.why ?? null, chunkSha256: chunkSha, patchedByThisRun: false },
    plugin: { state: pluginState.state, why: pluginState.why ?? null },
    steps: [], status: 'planned', manualNeeded: null,
  }
  say(`[plan] host: ${hostState.state}${hostState.why ? ` — ${hostState.why}` : ''}`)
  say(`[plan] plugin: ${pluginState.state}${pluginState.why ? ` — ${pluginState.why}` : ''}`)
  if (pending) say(`[tx] the interrupted record says hostPatchedByUs=${pending.hostPatchedByUs}`)

  const refused = s => s.state === 'refused' || s.state === 'unknown'
  if (refused(hostState) || refused(pluginState)) {
    report.status = 'refused'
    say('[refuse] preflight failed — NOTHING was written (all-or-nothing)')
    if (hostState.state === 'refused' && /pinned|unknown build|running/.test(hostState.why ?? '')) {
      say('[hint] the host build is not the pinned patch build — until the patch is re-derived for it,')
      say('       this entry refuses the whole install; the plugin alone remains available via: npm run plugin:install')
    }
    await mkdir(path.dirname(REPORT), { recursive: true }); await writeFile(REPORT, JSON.stringify(report, null, 2) + '\n')
    return 1
  }

  if (!APPLY) { say('[dry-run] no changes written — re-run with --apply to execute.'); report.status = 'dry-run' }
  else {
    // ---------- apply ----------
    const held = await acquireLock()
    const tx = pending ?? {
      schema: 1, file: `${new Date().toISOString().replace(/[:.]/g, '-')}.json`, at: new Date().toISOString(),
      app: appArg, pluginTarget, hostPre: hostState.state, pluginPre: pluginState.state,
      hostPatchedByUs: false, steps: [], status: 'pending',
    }
    try {
      if (UNINSTALL) {
        if (pluginState.state === 'would-uninstall') {
          const r = pluginRun(['uninstall', '--apply'])
          report.steps.push({ name: 'plugin-uninstall', ok: r.status === 0, detail: firstError(r.status === 0 ? r.stdout : r.stderr) })
          if (r.status !== 0) { report.status = 'failed'; die(`plugin uninstall failed: ${firstError(r.stderr)}`) }
        } else report.steps.push({ name: 'plugin-uninstall', ok: true, detail: 'noop' })
        if (WITH_HOST && hostState.state === 'would-rollback') {
          const r = hostRun(['--rollback', '--production'])
          report.steps.push({ name: 'host-rollback', ok: r.status === 0, detail: firstError(r.status === 0 ? r.stdout : r.stderr) })
          if (r.status !== 0) { report.status = 'failed'; die(`host rollback failed: ${firstError(r.stderr)}`) }
        }
        report.status = 'uninstalled'
        tx.status = 'uninstalled'; await writeTx(tx)
      } else {
        // step 1: host patch (skipped when already done — by us in this tx, or pre-existing)
        const hostOwned = pending?.hostPatchedByUs ?? false
        if (hostState.state === 'would-patch' || hostState.state === 'finalizable') {
          const r = hostRun(['--production'])
          const ok = r.status === 0
          report.steps.push({ name: 'host-patch', ok, detail: firstError(ok ? r.stdout : r.stderr) })
          if (!ok) { report.status = 'failed'; tx.status = 'failed'; await writeTx(tx); die(`host patch failed: ${firstError(r.stderr)}`) }
          if (hostState.state === 'would-patch') { tx.hostPatchedByUs = true; report.host.patchedByThisRun = true }
          tx.steps.push('host-patch'); await writeTx(tx)
          if (INJECT.has('crash-after-host')) { console.error('[inject] simulating a crash after the host switch'); process.exit(70) }
        } else {
          report.steps.push({ name: 'host-patch', ok: true, detail: `skipped: host is ${hostState.state}${hostOwned ? ' (patched by this transaction earlier)' : ' (pre-existing — never rolled back by us)'}` })
        }
        // step 2: plugin install — failure compensates ONLY a patch we applied
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
            report.status = 'compensation-failed'; report.manualNeeded = `host patch is still applied but the plugin failed: run node scripts/host-binary-patch.mjs --app='${appArg}' --rollback --apply manually`
            tx.status = 'compensation-failed'; await writeTx(tx)
            die('plugin install failed AND compensation failed — MANUAL ACTION REQUIRED (see report)')
          }
          report.status = 'failed'; tx.status = 'failed'; await writeTx(tx)
          die(`plugin install failed: ${firstError(r.stderr)} (host patch was pre-existing and was NOT touched)`)
        }
        report.steps.push({ name: 'plugin-install', ok: true, detail: firstError(r.stdout) })
        // step 3: post-verify
        const hostAfter = classifyHost(hostRun([]))
        const pluginAfter = classifyPlugin(pluginRun([]))
        const okAfter = hostAfter.state === 'already' && pluginAfter.state === 'noop'
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

  await mkdir(path.dirname(REPORT), { recursive: true })
  await writeFile(REPORT, JSON.stringify(report, null, 2) + '\n')
  say('[report] ' + JSON.stringify({ status: report.status, host: report.host.state, plugin: report.plugin.state, manualNeeded: report.manualNeeded }))
  return report.status === 'planned' || /refused|failed/.test(report.status) ? 1 : 0
}

try { process.exit(await main()) } catch (e) { if (!(e instanceof Fatal)) console.error(`[error] unexpected failure: ${e.stack || e.message}`); process.exit(1) }
