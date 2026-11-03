// Version-aware install/uninstall/upgrade for the hermes-style-plugin disk plugin.
//
// Install states: absent -> fresh install; older -> upgrade (backup first);
// same version -> idempotent no-op, or refuse on byte mismatch without --force;
// newer / unreadable build-info / unexpected or symlinked entries / foreign
// plugin id -> refuse without --force.
//
// Safety properties:
//   - only the KNOWN_FILES whitelist is ever copied from the source, and only
//     an own-identity, all-whitelisted directory is ever removed;
//   - replacements go through a staging directory NEXT TO the target (same
//     filesystem): staged bytes are verified BEFORE the old directory is
//     touched, and a failed switch restores the old directory from the backup;
//   - uninstall never reads the source build — it verifies the target's own
//     identity and refuses on foreign content;
//   - backups live outside the loader-scanned desktop-plugins directory;
//   - dry-run by default; --apply writes; --force overrides refusals (always
//     backing the current target up first). Symlinked or non-directory targets
//     are never handled with --force — resolve those manually.
//   - the plugin alone is NOT the complete installation: after its own verdict
//     the installer probes the HOST patch state (read-only, safe on a running
//     app — scripts/install-status.mjs) and reports both sides. Exit codes:
//     0 = action complete AND (for install) host patch verified, or
//     --plugin-only was explicit; 1 = refused/error; 3 = plugin is in place
//     but the host patch is missing or unverified for this Hermes build
//     (re-run with --plugin-only to accept plugin-only). Uninstall is
//     plugin-scoped and stays independent of the host state.
import { readFile, mkdir, rm, readdir, cp, access, rename, lstat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { probeHost } from './install-status.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN_ID = 'hermes-style-plugin'
const KNOWN_FILES = ['plugin.js', 'build-info.json', 'README.md']

const argv = process.argv.slice(2)
const action = argv.includes('uninstall') ? 'uninstall' : 'install'
const APPLY = argv.includes('--apply')
const FORCE = argv.includes('--force')
// Last occurrence wins: lets callers override earlier flags (e.g. a wrapper
// that pre-seeds defaults). findLast is available on Node >= 18.
const opt = name => { const hit = argv.findLast(a => a.startsWith(`--${name}=`)); return hit ? hit.slice(name.length + 3) : null }
const PLUGIN_ONLY = argv.includes('--plugin-only')
const APP_OPT = opt('app')
const sourceDir = opt('source') ?? path.join(root, 'plugin', PLUGIN_ID)
const targetBase = opt('target') ?? path.join(os.homedir(), '.hermes', 'desktop-plugins')
const targetDir = path.join(targetBase, PLUGIN_ID)
const backupBase = opt('backup-base') ?? path.join(root, '.local', 'plugin-backups')
let backupLabel = 'backup'
const backupPath = () => path.join(backupBase, `${new Date().toISOString().replace(/[:.]/g, '-')}__${backupLabel}`)

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const refuse = message => Object.assign(new Error(message), { code: 1 })
const exists = async p => { try { await access(p); return true } catch { return false } }

// semver-ish compare (core triple + pre-release identifiers); null = unparsable
function compareVersion(a, b) {
  const parse = v => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v ?? ''))
    return m ? { core: [+m[1], +m[2], +m[3]], pre: m[4] ? m[4].split('.') : null } : null
  }
  const A = parse(a), B = parse(b)
  if (!A || !B) return null
  for (let i = 0; i < 3; i++) if (A.core[i] !== B.core[i]) return A.core[i] < B.core[i] ? -1 : 1
  if (!A.pre && !B.pre) return 0
  if (!A.pre) return 1
  if (!B.pre) return -1
  for (let i = 0; i < Math.max(A.pre.length, B.pre.length); i++) {
    const x = A.pre[i], y = B.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y)
    if (xn && yn) { if (+x !== +y) return +x < +y ? -1 : 1 } else if (xn) return -1
    else if (yn) return 1
    else if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

async function loadSource() {
  const infoPath = path.join(sourceDir, 'build-info.json')
  if (!(await exists(infoPath))) throw new Error(`source build missing — run the plugin build first, or pass --source= (looked in ${sourceDir})`)
  const info = JSON.parse(await readFile(infoPath, 'utf8'))
  if (info?.id !== PLUGIN_ID) throw new Error(`source build-info id mismatch: ${info?.id}`)
  const files = {}
  for (const name of ['plugin.js', 'build-info.json']) {
    const st = await lstat(path.join(sourceDir, name)).catch(() => null)
    if (!st?.isFile()) throw new Error(`source missing required file: ${name}`)
    files[name] = path.join(sourceDir, name)
  }
  // README.md is optional for a local build (the packaged candidate ships it).
  if ((await lstat(path.join(sourceDir, 'README.md')).catch(() => null))?.isFile()) files['README.md'] = path.join(sourceDir, 'README.md')
  const jsSha = sha(await readFile(files['plugin.js']))
  if (info.pluginSha256 !== jsSha) throw new Error(`source plugin.js sha256 ${jsSha} does not match build-info ${info.pluginSha256} — rebuild first`)
  return { info, files, jsSha }
}

async function readTarget() {
  const base = await lstat(targetBase).catch(() => null)
  if (base?.isSymbolicLink()) return { state: 'foreign', why: 'the desktop-plugins base is a symlink' }
  const st = await lstat(targetDir).catch(() => null) // lstat: never follow the target itself
  if (!st) return { state: 'absent' }
  if (!st.isDirectory() || st.isSymbolicLink()) return { state: 'foreign', why: st.isSymbolicLink() ? 'the plugin directory is a symlink' : 'the plugin path is not a directory' }
  const entries = await readdir(targetDir, { withFileTypes: true })
  const unknown = entries.filter(e => !KNOWN_FILES.includes(e.name) || e.isSymbolicLink()).map(e => `${e.name}${e.isSymbolicLink() ? '(symlink)' : ''}`)
  let info = null, jsSha = null
  try { info = JSON.parse(await readFile(path.join(targetDir, 'build-info.json'), 'utf8')) } catch { info = null }
  try { jsSha = sha(await readFile(path.join(targetDir, 'plugin.js'))) } catch { jsSha = null }
  return { state: 'present', unknown, info, jsSha }
}

// Stage the whitelisted source files next to the target (same filesystem),
// verify the staged bytes, then swap; a failed switch restores from backup.
async function stageAndSwap(src, { backup = true } = {}) {
  const staging = path.join(targetBase, `.hermes-style-plugin.staging-${process.pid}`)
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  for (const name of Object.keys(src.files)) await cp(src.files[name], path.join(staging, name))
  const stagedSha = sha(await readFile(path.join(staging, 'plugin.js')))
  if (stagedSha !== src.jsSha) {
    await rm(staging, { recursive: true, force: true })
    throw new Error(`staged copy failed byte verification (${stagedSha.slice(0, 8)}… != ${src.jsSha.slice(0, 8)}…)`)
  }
  let saved = null
  if (backup) {
    saved = backupPath()
    await mkdir(backupBase, { recursive: true })
    await cp(targetDir, saved, { recursive: true })
  }
  await rm(targetDir, { recursive: true, force: true })
  try {
    await rename(staging, targetDir)
  } catch (error) {
    if (saved) await cp(saved, targetDir, { recursive: true })
    throw new Error(`directory switch failed; previous directory restored from backup — ${error.message}`)
  }
  return saved
}

try {
  // Uninstall never touches the source build.
  const src = action === 'install' ? await loadSource() : null
  const tgt = await readTarget()
  console.log(JSON.stringify({ action, apply: APPLY, force: FORCE,
    source: src ? { dir: sourceDir, version: src.info.version, pluginSha256: src.jsSha } : null,
    target: { dir: targetDir, state: tgt.state, version: tgt.info?.version ?? null, id: tgt.info?.id ?? null, unknownFiles: tgt.unknown ?? (tgt.why ? [tgt.why] : []) } }, null, 2))

  let verdict, planText, run = null
  if (action === 'uninstall') {
    if (tgt.state === 'absent') { verdict = 'noop'; planText = 'target absent — nothing to uninstall' }
    else if (tgt.state === 'foreign') throw refuse(`refuse: ${tgt.why} — resolve it manually; this tool does not remove or replace such paths (intentionally, even with --force).`)
    else if (tgt.unknown.length && !FORCE) throw refuse(`refuse: target contains unexpected entries (${tgt.unknown.join(', ')}) — not removing; use --force to remove everything after a backup.`)
    else if (tgt.info?.id && tgt.info.id !== PLUGIN_ID && !FORCE) throw refuse(`refuse: target holds a foreign plugin id '${tgt.info.id}' — this tool only removes '${PLUGIN_ID}'; use --force to remove it anyway after a backup.`)
    else if (!tgt.info && !FORCE) throw refuse('refuse: target has no readable build-info — cannot verify it is ours; use --force to remove everything after a backup.')
    else {
      verdict = 'uninstall'; backupLabel = 'uninstall'
      planText = `uninstall ${targetDir} (backup first)`
      run = async () => { const b = backupPath(); await mkdir(backupBase, { recursive: true }); await cp(targetDir, b, { recursive: true }); await rm(targetDir, { recursive: true, force: true }); return b }
    }
  } else {
    if (tgt.state === 'foreign') throw refuse(`refuse: ${tgt.why} — resolve it manually before installing here (intentionally not overridable with --force).`)
    const foreignId = tgt.state === 'present' && tgt.info?.id && tgt.info.id !== PLUGIN_ID
    const unknownish = tgt.state === 'present' && (tgt.unknown.length || !tgt.info || !tgt.jsSha || compareVersion(tgt.info?.version, src.info.version) === null)
    if (tgt.state === 'absent') {
      verdict = 'install'; backupLabel = 'fresh'
      planText = `fresh install v${src.info.version} -> ${targetDir}`
      run = async () => {
        const staging = path.join(targetBase, `.hermes-style-plugin.staging-${process.pid}`)
        await mkdir(staging, { recursive: true })
        for (const name of Object.keys(src.files)) await cp(src.files[name], path.join(staging, name))
        const stagedSha = sha(await readFile(path.join(staging, 'plugin.js')))
        if (stagedSha !== src.jsSha) { await rm(staging, { recursive: true, force: true }); throw new Error('staged copy failed byte verification') }
        await rename(staging, targetDir)
        return null
      }
    } else if (foreignId) {
      if (!FORCE) throw refuse(`refuse: target holds a foreign plugin id '${tgt.info.id}' — refusing to replace another plugin's directory.`)
      verdict = 'force-replace'; backupLabel = 'force-foreign-id'
      planText = `FORCE replace foreign-id target '${tgt.info.id}' with v${src.info.version} (backup first)`
      run = () => stageAndSwap(src)
    } else if (unknownish) {
      const why = tgt.unknown.length ? `unexpected entries (${tgt.unknown.join(', ')})` : tgt.info ? `unparsable version ${JSON.stringify(tgt.info.version)}` : 'missing/corrupt build-info or plugin.js'
      if (!FORCE) throw refuse(`refuse: target unreadable — ${why}. Re-run with --force (a backup is taken first).`)
      verdict = 'force-replace'; backupLabel = 'force-unknown'
      planText = `FORCE replace unreadable target with v${src.info.version} (${why}; backup first)`
      run = () => stageAndSwap(src)
    } else {
      const cmp = compareVersion(tgt.info.version, src.info.version)
      if (cmp < 0) {
        verdict = 'upgrade'; backupLabel = `upgrade-${tgt.info.version}-to-${src.info.version}`
        planText = `UPGRADE v${tgt.info.version} -> v${src.info.version} (backup first, staged swap)`
        run = () => stageAndSwap(src)
      } else if (cmp === 0 && tgt.jsSha === src.jsSha) {
        verdict = 'noop'
        planText = `already at v${src.info.version} with identical bytes — nothing to do`
      } else if (cmp === 0) {
        if (!FORCE) throw refuse(`refuse: target v${tgt.info.version} has the same version but different plugin.js bytes (${tgt.jsSha.slice(0, 8)}… vs ${src.jsSha.slice(0, 8)}…) — re-run with --force (a backup is taken first).`)
        verdict = 'force-replace'; backupLabel = 'force-same-version'
        planText = 'FORCE replace same-version divergent target (backup first, staged swap)'
        run = () => stageAndSwap(src)
      } else {
        if (!FORCE) throw refuse(`refuse: target v${tgt.info.version} is NEWER than source v${src.info.version} — refusing downgrade; use --force if intentional (backup first).`)
        verdict = 'force-downgrade'; backupLabel = `downgrade-to-${src.info.version}`
        planText = `FORCE downgrade v${tgt.info.version} -> v${src.info.version} (backup first, staged swap)`
        run = () => stageAndSwap(src)
      }
    }
  }

  console.log(`[plan] ${planText}`)
  // The plugin alone is NOT the complete installation: probe the host-patch
  // state read-only (safe on a running app) and report both sides. A probe
  // failure degrades to 'probe-error' and is never reported as patched.
  const host = await probeHost(APP_OPT).catch(error => ({ state: 'probe-error', error: error.message }))
  const hostNote = host.state === 'probe-error' ? ` (${host.error})` : ''
  console.log(`[status] host patch: ${host.state}${host.recipe ? ` — ${host.recipe.label}, ${host.recipe.role}` : ''}${host.recovery && host.recovery !== 'none' ? `, recovery: ${host.recovery}` : ''}${hostNote}`)
  if (!APPLY) { console.log('[dry-run] no changes written — re-run with --apply to execute.'); process.exit(0) }
  const b = run ? await run() : null
  if (b) console.log(`[ok] backup -> ${b}`)
  console.log(`[ok] ${verdict} complete`)
  // Uninstall is plugin-scoped and stays independent of the host patch state.
  if (action === 'uninstall') process.exit(0)
  if (PLUGIN_ONLY) {
    console.log('[status] plugin-only mode: the host patch is intentionally out of scope for this run (limitation: no live cross-window sync of the toggle on stock builds).')
    process.exit(0)
  }
  if (host.state !== 'patched-verified') {
    console.error(`[incomplete] the style plugin is in place, but the host patch is ${host.state === 'unpatched-supported' ? 'NOT applied' : 'not verified for this Hermes build'} (${host.state}${hostNote}).`)
    console.error('            The plugin itself works; what is missing is live cross-window sync of the on/off toggle.')
    console.error('            Re-run with --plugin-only to accept plugin-only, or see README — the host patch is a separate, version-gated component (host-patch/).')
    process.exit(3)
  }
  console.log('[status] complete installation verified: plugin installed + host patch verified.')
} catch (error) {
  console.error(`[${error.code === 1 ? 'refuse' : 'error'}] ${error.message}`)
  process.exit(1)
}
