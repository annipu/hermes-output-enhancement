// EXPERIMENTAL finished-app patch tool — hardening v3 (2026-11-03, review round 2).
// Applies the window-sync v2 change directly inside a Hermes.app bundle by
// transforming the plugins-store module region in the renderer layout chunk.
//
// Hardening model (all enforced in code, not by convention):
//   - experiment root: the app realpath MUST be under <project>/.local — the
//     working app and anything outside is refused before it is ever touched.
//     Every directory of the chain (experiment root -> app -> assets) is
//     lstat-checked; any symlink is refused. The anchor scan refuses symlinked
//     or non-regular .js candidates instead of silently skipping them.
//   - pinned identity at BOTH ends: pre sha256 (original build) AND post
//     sha256 (the A/B-verified patched build). A manifest is never trusted on
//     its own: its app/chunk/pre/post fields must match the built-in pins and
//     the target bytes must hash to one of the two pinned values — anything
//     else refuses. "Already patched" requires the full post hash.
//   - existence semantics: only ENOENT counts as "absent"; permission errors,
//     unreadable files and corrupt JSON all refuse.
//   - backups are created exclusively (O_EXCL) — no TOCTOU; an existing
//     external backup is verified against the pinned pre hash or refused.
//   - staged writes: exclusive stage file + fsync + hash verification + atomic
//     same-dir rename + target mode preservation + finally-cleanup. The
//     manifest itself is staged, verified and renamed atomically.
//   - single-flight lock: an app-external lock file (O_EXCL, pid+timestamp)
//     shared by install and rollback; released only by the process that
//     acquired it (a refused run must not delete the holder's lock). A lock
//     whose pid is dead is stale and is removed once; a live pid refuses.
//     Normal exits release the lock in a finally (die throws instead of
//     exiting); the only leaked lock is a simulated crash (--inject=…,
//     exit 70) — recovered by the stale rule.
//   - process guard: pgrep with the path REGEX-ESCAPED, fail-closed, checked
//     at start AND re-checked immediately before the target switch.
//   - pending state machine (interrupted runs):
//       target == pre  -> never switched: the pending record is preserved as
//                         manifest.json.aborted-<ts> and a fresh install runs;
//       target == post -> switched but not finalized: the external backup is
//                         verified and the install record is finalized;
//       anything else  -> refuse, never overwrite.
//   - recovery: on any in-transaction fault the target is restored from the
//     bytes pinned this run, then the target hash is RE-READ — "restored" is
//     reported only after that re-read. If recovery itself fails, the manifest
//     records status=broken and the tool fails loudly with the backup path.
//   - fault injection (--inject=a,b — INTERNAL, test matrix only): throw
//     points (external-backup, v2bak, before-switch, installed-manifest,
//     recovery-write, write-interrupt:<label>) and crash points
//     (pending-manifest, after-v2bak, after-switch — exit 70, simulating a
//     killed process) drive the state-machine tests.
//   - dry-run default: --apply writes. Dry-run is read-only validation; the
//     syntax check uses a temporary file inside the project, cleaned up.
// Verified facts this relies on (2026-11-03): the target file lives in
// app.asar.unpacked (outside the asar archive); fuses have
// EnableEmbeddedAsarIntegrityValidation=Disabled and OnlyLoadAppFromAsar=Disabled.
// The app is ad-hoc signed; patching breaks the resource seal (the patched
// copy still launches; rollback restores the seal — A/B evidence 2026-11-03).
import { readFile, writeFile, readdir, mkdir, rm, rename, lstat, stat, chmod, open, realpath } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

class FatalError extends Error {}

async function main() {
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const ROLLBACK = argv.includes('--rollback')
const appPath = (() => { const hit = argv.find(a => a.startsWith('--app=')); return hit ? hit.slice(6) : null })()
const INJECT = new Set((() => { const hit = argv.find(a => a.startsWith('--inject=')); return hit ? hit.slice(9).split(',') : [] })())
const sha = data => createHash('sha256').update(data).digest('hex')
const shaFile = async f => sha(await readFile(f))
const say = s => console.log(s)
const die = msg => { console.error(`[error] ${msg}`); throw new FatalError(msg) }
const inject = name => { if (INJECT.has(name)) throw new Error(`injected fault: ${name}`) }
const injectExit = name => { if (INJECT.has(name)) { console.error(`[inject] simulating a crash at ${name}`); process.exit(70) } }

const EXPERIMENT_ROOT = path.join(root, '.local')
const KEY = 'hermes.desktop.pluginDecisions.v2'
// Recipe table: full-hash indexed per build; 'verified' = isolated A/B passed;
// 'experimental' = syntax + sandbox matrix only — internal project copies,
// never advertised by the public status probe until its A/B passes. Old
// recipes and their A/B evidence stay untouched; new recipes are APPENDED.
const RECIPES = [
  {
    id: 'b-735d8be3', status: 'verified', label: 'stock 2026-11-02 build (sourceHash 735d8be3…)',
    chunkName: 'layout-lXjPuTgt.js',
    preSha256: '2c2f82c100c6fa51090bc5b7d04787479db26d723202b91bb3ed72c94fc4771e',
    postSha256: '5d47e594ed96dbe5679680ce94930a0b2933d63b8420ac139da04a229f46b125',
    regionBefore: 962, regionAfter: 2218, geRegionCount: 2,
    startAnchor: 'var fe=`hermes.desktop.pluginDecisions.v2`,pe=`hermes.desktop.disabledPlugins.v1`;',
    endAnchor: 'var Ce=0,we=e=>', patchedMarker: 'pdv=new Map',
    freshIds: ['pdv', 'pqp', 'pqe', 'pwe', 'prd', 'pds', 'pdo', 'pkl'],
    replacement: "var fe=`hermes.desktop.pluginDecisions.v2`,pe=`hermes.desktop.disabledPlugins.v1`;function me(){try{let e=window.localStorage.getItem(fe);if(e)return JSON.parse(e);let t=window.localStorage.getItem(pe);if(t)return Object.fromEntries(JSON.parse(t).map(e=>[e,!1]))}catch{}return{}}var m=e(me()),pdv=new Map;function he(e,t=!0){pdv.set(e,t);let n=m.get();return e in n?n[e]:t}function ge(e,t){m.set({...m.get(),[e]:t});try{let n=prd()??{};window.localStorage.setItem(fe,JSON.stringify({...n,[e]:t}))}catch{}}var h=e({}),_e=new Map;function ve(e,t){h.set({...h.get(),[e.id]:e}),t&&_e.set(e.id,t)}function ye(e,t){let n=h.get()[e];n&&h.set({...h.get(),[e]:{...n,...t}})}function be(e){let{[e]:t,...n}=h.get();h.set(n),_e.delete(e)}async function xe(e,{keepUserChoice:t=!1}={}){let n=m.get();for(let r of Object.values(h.get()))r.packageName===e&&r.status===`disabled`&&(!t||!(r.id in n))&&await Se(r.id,!0)}var pqp=Promise.resolve();function pqe(e){return pqp=pqp.then(e).catch(()=>void 0),pqp}async function pwe(e,t){let n=_e.get(e);n&&(t?await n.activate():(n.deactivate(),ye(e,{status:`disabled`})))}async function Se(e,t){ge(e,t),await pqe(()=>pwe(e,t))}function prd(){try{let e=window.localStorage.getItem(fe);if(e===null)return null;let t=JSON.parse(e);if(typeof t!=`object`||!t||Array.isArray(t))return null;let n=Object.entries(t);return n.some(([,e])=>typeof e!=`boolean`)?null:Object.fromEntries(n)}catch{return null}}async function pds(){let e=prd();if(!e)return;let t=m.get();m.set(e);for(let n of new Set([...Object.keys(t),...Object.keys(e)])){if(t[n]===e[n])continue;let r=n in e?e[n]:pdv.get(n)??!0;try{await pwe(n,r)}catch{ye(n,{status:`error`,error:`Could not apply a plugin preference from another window.`})}}}async function pdo(){let e=me(),t=m.get();m.set(e);for(let n of new Set([...Object.keys(t),...Object.keys(e)])){if(t[n]===e[n])continue;let r=n in e?e[n]:pdv.get(n)??!0;try{await pwe(n,r)}catch{ye(n,{status:`error`,error:`Could not restore plugin defaults after a preference reset.`})}}}function pkl(e){if(e.storageArea!==window.localStorage)return;let t=e.key===null,n=e.key===fe&&e.newValue===null;t||n?pqe(pdo):e.key===fe&&pqe(pds)}typeof window<`u`&&window.addEventListener(`storage`,pkl);",
  },
  {
    id: 'c-c6807894', status: 'verified', label: 'stock 2026-11-03 build (sourceHash c6807894…)',
    chunkName: 'layout-CSIx4R7D.js',
    preSha256: 'fd49bb08d1ad742350813504fbc75d75a94e9bb6b80a8c9b38ac67136b2a2c20',
    postSha256: '8ad8215687ed76f589f5d54a7b12028b2857941cb955d1d4c4df3bc32384753b',
    regionBefore: 967, regionAfter: 2227, geRegionCount: 1,
    startAnchor: 'var fe=`hermes.desktop.pluginDecisions.v2`,pe=`hermes.desktop.disabledPlugins.v1`;',
    endAnchor: 'var we=0,Te=e=>', patchedMarker: 'pdv=new Map',
    freshIds: ['pdv', 'pqp', 'pqe', 'pwe', 'prd', 'pds', 'pdo', 'pkl'],
    replacement: "var fe=`hermes.desktop.pluginDecisions.v2`,pe=`hermes.desktop.disabledPlugins.v1`;function me(){try{let e=window.localStorage.getItem(fe);if(e)return JSON.parse(e);let t=window.localStorage.getItem(pe);if(t)return Object.fromEntries(JSON.parse(t).map(e=>[e,!1]))}catch{}return{}}var he=u(me()),pdv=new Map;function ge(e,t=!0){pdv.set(e,t);let n=he.get();return e in n?n[e]:t}function _e(e,t){he.set({...he.get(),[e]:t});try{let n=prd()??{};window.localStorage.setItem(fe,JSON.stringify({...n,[e]:t}))}catch{}}var m=u({}),ve=new Map;function ye(e,t){m.set({...m.get(),[e.id]:e}),t&&ve.set(e.id,t)}function be(e,t){let n=m.get()[e];n&&m.set({...m.get(),[e]:{...n,...t}})}function xe(e){let{[e]:t,...n}=m.get();m.set(n),ve.delete(e)}async function Se(e,{keepUserChoice:t=!1}={}){let n=he.get();for(let r of Object.values(m.get()))r.packageName===e&&r.status===`disabled`&&(!t||!(r.id in n))&&await Ce(r.id,!0)}async function Ce(e,t){_e(e,t),await pqe(()=>pwe(e,t))}var pqp=Promise.resolve();function pqe(e){return pqp=pqp.then(e).catch(()=>void 0),pqp}async function pwe(e,t){let n=ve.get(e);n&&(t?await n.activate():(n.deactivate(),be(e,{status:`disabled`})))}function prd(){try{let e=window.localStorage.getItem(fe);if(e===null)return null;let t=JSON.parse(e);if(typeof t!=`object`||!t||Array.isArray(t))return null;let n=Object.entries(t);return n.some(([,e])=>typeof e!=`boolean`)?null:Object.fromEntries(n)}catch{return null}}async function pds(){let e=prd();if(!e)return;let t=he.get();he.set(e);for(let n of new Set([...Object.keys(t),...Object.keys(e)])){if(t[n]===e[n])continue;let r=n in e?e[n]:pdv.get(n)??!0;try{await pwe(n,r)}catch{be(n,{status:`error`,error:`Could not apply a plugin preference from another window.`})}}}async function pdo(){let e=me(),t=he.get();he.set(e);for(let n of new Set([...Object.keys(t),...Object.keys(e)])){if(t[n]===e[n])continue;let r=n in e?e[n]:pdv.get(n)??!0;try{await pwe(n,r)}catch{be(n,{status:`error`,error:`Could not restore plugin defaults after a preference reset.`})}}}function pkl(e){if(e.storageArea!==window.localStorage)return;let t=e.key===null,n=e.key===fe&&e.newValue===null;t||n?pqe(pdo):e.key===fe&&pqe(pds)}typeof window<`u`&&window.addEventListener(`storage`,pkl);",
  },
]

say('[experimental] finished-app patch tool — project-internal copies only')
if (!appPath) die('usage: node scripts/host-binary-patch.mjs --app=<Hermes.app> [--apply] [--rollback] (internal: --inject=point,point)')

// ---- experiment-root + symlink-chain enforcement ----
// The ORIGINAL input chain is lstat-checked first: realpath would silently
// resolve symlinks, so an input path that traverses one is refused (round 3 #1).
{
  const parts = path.resolve(appPath).split(path.sep)
  let cur = ''
  for (const part of parts) {
    cur = cur ? path.join(cur, part) : path.sep
    if (cur === path.sep) continue
    const st = await lstat(cur).catch(() => null)
    if (!st) break // missing component is reported by realpath below
    if (st.isSymbolicLink()) die(`symlink in the INPUT app path: ${cur} — refusing`)
  }
}
if ((await lstat(EXPERIMENT_ROOT).catch(() => null))?.isSymbolicLink()) die('the experiment root itself is a symlink — refusing')
const appReal = await realpath(appPath)
if (!appReal.startsWith(EXPERIMENT_ROOT + path.sep)) die(`app realpath must be inside the experiment root ${EXPERIMENT_ROOT} — refusing (working apps are off-limits while this tool is experimental)`)
{
  const parts = path.relative(EXPERIMENT_ROOT, appReal).split(path.sep)
  let cur = EXPERIMENT_ROOT
  for (const part of parts) {
    cur = path.join(cur, part)
    if ((await lstat(cur)).isSymbolicLink()) die(`symlink in the app path chain: ${cur} — refusing`)
  }
}
const assetsDir = path.join(appReal, 'Contents/Resources/app.asar.unpacked/dist/assets')
for (const seg of ['Contents', 'Contents/Resources', 'Contents/Resources/app.asar.unpacked', 'Contents/Resources/app.asar.unpacked/dist', 'Contents/Resources/app.asar.unpacked/dist/assets']) {
  if ((await lstat(path.join(appReal, seg))).isSymbolicLink()) die(`symlink inside the app bundle: ${path.join(appReal, seg)} — refusing`)
}

const manifestDir = path.join(EXPERIMENT_ROOT, 'host-binary-patch-manifests', sha(appReal).slice(0, 12))
const manifestFile = path.join(manifestDir, 'manifest.json')
const originalCopy = path.join(manifestDir, 'original.js')
const lockPath = path.join(manifestDir, 'lock')
if ((await lstat(manifestDir).catch(() => null))?.isSymbolicLink()) die(`the manifest/backup directory is a symlink: ${manifestDir} — refusing`)

// ---- process guard (regex-escaped, fail-closed) ----
const escapedApp = appReal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const processGuard = label => {
  const r = spawnSync('pgrep', ['-f', `${escapedApp}/Contents/MacOS`], { encoding: 'utf8' })
  if (r.error) die(`process guard failed${label} (pgrep unavailable: ${r.error.message}) — refusing`)
  if (r.status === 0) die(`a process matching '${appReal}/Contents/MacOS' is running — quit it first (matched PIDs: ${r.stdout.trim().split('\n').join(' ')})`)
  if (r.status !== 1) die(`process guard returned unexpected status ${r.status}${label} — refusing (fail-closed)`)
}
processGuard('')

// ---- existence semantics: only ENOENT is "absent" ----
const fileState = async p => {
  try { await lstat(p); return 'present' }
  catch (e) { if (e.code === 'ENOENT') return 'absent'; return `error:${e.code || e.message}` }
}

// ---- staged, verified, atomic writes ----
async function stagedWrite(target, bytes, expectSha, label, mode) {
  const tmp = `${target}.stage-${randomUUID().slice(0, 8)}`
  try {
    const h = await open(tmp, 'wx')
    try { await h.writeFile(bytes); await h.sync() } finally { await h.close() }
    if ((await shaFile(tmp)) !== expectSha) throw new Error(`staged ${label} failed hash verification`)
    if (mode !== undefined) await chmod(tmp, mode)
    await rename(tmp, target)
  } finally { await rm(tmp, { force: true }) }
}
async function exclusiveWriteVerified(dest, bytes, expectSha, label) {
  const h = await open(dest, 'wx')
  try {
    try { await h.writeFile(bytes); await h.sync() } finally { await h.close() }
    // Fault point between write and verification: a half-written file must be
    // cleaned up, never left behind as if valid (round 3 #6).
    inject(`write-interrupt:${label}`)
    if ((await shaFile(dest)) !== expectSha) throw new Error(`${label}: written bytes failed verification`)
  } catch (e) {
    await rm(dest, { force: true })
    throw e
  }
}
const baseRecord = () => ({ schema: 1, app: appReal, chunk: PINNED_CHUNK, recipeId: recipe.id, recipeStatus: recipe.status, preSha256: PINNED_PRE_SHA256, postSha256: PINNED_POST_SHA256, regionBefore: PINNED_REGION_BEFORE, regionAfter: PINNED_REGION_AFTER, ...(INJECT.size ? { inject: [...INJECT] } : {}) })
const writeManifest = async obj => { const buf = Buffer.from(JSON.stringify(obj, null, 2) + '\n'); await stagedWrite(manifestFile, buf, sha(buf), 'manifest') }

// ---- a record is only trusted if it matches the built-in pins ----
async function readManifestVerified() {
  const st = await fileState(manifestFile)
  if (st === 'absent') return null
  if (st !== 'present') die(`manifest unreadable (${st}) — refusing`)
  let m
  try { m = JSON.parse(await readFile(manifestFile, 'utf8')) } catch { die('manifest is not valid JSON — refusing (inspect manually)') }
  if (m.app !== appReal || m.chunk !== PINNED_CHUNK || m.preSha256 !== PINNED_PRE_SHA256 || m.postSha256 !== PINNED_POST_SHA256) die('manifest does not match the pinned identity — refusing (inspect manually)')
  if (m.recipeId && m.recipeId !== recipe.id) die(`manifest was written for recipe ${m.recipeId}, this build selected ${recipe.id} — refusing (inspect manually)`)
  return m
}

// ---- anchor scan (symlinks/non-regular are refused, never skipped) ----
const hits = [], suspicious = []
for (const entry of await readdir(assetsDir, { withFileTypes: true })) {
  if (!entry.name.endsWith('.js')) continue
  const full = path.join(assetsDir, entry.name)
  const st = await lstat(full)
  if (!st.isFile()) { suspicious.push(entry.name); continue }
  const buf = await readFile(full)
  const count = buf.toString('utf8').split(KEY).length - 1
  if (count > 0) hits.push({ name: entry.name, count, sha256: sha(buf) })
}
if (suspicious.length) die(`non-regular or symlinked .js entries in the assets dir: ${suspicious.join(', ')} — refusing (ambiguous target)`)
if (hits.length !== 1 || hits[0].count !== 1) die(`anchor scan: expected exactly one file with exactly one '${KEY}' hit, found ${JSON.stringify(hits)} — refusing (unknown build?)`)
const recipe = RECIPES.find(r => hits[0].sha256 === r.preSha256 || hits[0].sha256 === r.postSha256)
if (!recipe) die(`no registered recipe for this build (anchor chunk ${hits[0].name}, sha256 ${hits[0].sha256.slice(0, 8)}…) — refusing (updated or unknown build)`)
if (hits[0].name !== recipe.chunkName) die(`anchor chunk name ${hits[0].name} does not match recipe ${recipe.id} (expects ${recipe.chunkName}) — refusing (cross-build mix-up)`)
if (recipe.status !== 'verified') say(`[experimental] recipe ${recipe.id} (${recipe.label}) has NOT passed its isolated A/B — project copies only`)
const PINNED_CHUNK = recipe.chunkName
const PINNED_PRE_SHA256 = recipe.preSha256
const PINNED_POST_SHA256 = recipe.postSha256
const PINNED_REGION_BEFORE = recipe.regionBefore
const PINNED_REGION_AFTER = recipe.regionAfter
const START_ANCHOR = recipe.startAnchor
const END_ANCHOR = recipe.endAnchor
const PATCHED_MARKER = recipe.patchedMarker
const REPLACEMENT = recipe.replacement
const FRESH_IDS = recipe.freshIds
const file = path.join(assetsDir, PINNED_CHUNK)
const v2bak = file + '.v2bak'
const mode = (await stat(file)).mode & 0o777

// ---- single-flight lock (stale = dead pid, removed once; released only by its owner) ----
let lockHeld = false
async function acquireLock() {
  await mkdir(manifestDir, { recursive: true })
  for (let attempt = 0; ; attempt++) {
    try {
      const h = await open(lockPath, 'wx')
      try { await h.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + '\n'); await h.sync() } finally { await h.close() }
      lockHeld = true
      return
    } catch (e) {
      if (e.code !== 'EEXIST') die(`lock create failed: ${e.message}`)
      let info = null
      let lockReadable = true
      try { info = JSON.parse(await readFile(lockPath, 'utf8')) } catch { lockReadable = false }
      // An unreadable or malformed lock is NEVER auto-deleted — guessing could
      // destroy a live holder's lock (round 3 #4).
      if (!lockReadable || !Number.isInteger(info?.pid)) die(`lock ${lockPath} exists but is unreadable or malformed — refusing to guess; inspect and remove it manually if stale`)
      let alive = false
      try { process.kill(info.pid, 0); alive = true } catch (e) { alive = e.code !== 'ESRCH' }
      if (alive) die(`another patch operation holds ${lockPath} (pid ${info.pid}) — refusing; if you are certain it is stale, remove that file manually`)
      if (attempt >= 1) die(`lock re-acquisition failed after one stale recovery — refusing (possible concurrent recoverer)`)
      say(`[lock] removing a stale lock (pid ${info.pid} is gone)`)
      await rm(lockPath, { force: true })
    }
  }
}
const releaseLock = async () => { try { await rm(lockPath, { force: true }) } catch {} }
await acquireLock()

try {
  if (ROLLBACK) {
    const manifest = await readManifestVerified()
    if (!manifest || !manifest.status) die('no trusted install record — refusing to roll back (inspect manually)')
    const curSt = await fileState(file)
    if (curSt !== 'present') die(`target unreadable (${curSt}) — refusing`)
    const cur = await shaFile(file)
    if (cur === PINNED_PRE_SHA256) {
      say('[ok] target already matches the pinned original — nothing to restore')
      if (!APPLY) { say('[dry-run] target App not modified'); return 0 }
    } else if (cur !== PINNED_POST_SHA256) {
      die(`target sha256 ${cur.slice(0, 8)}… is neither the pinned original (${PINNED_PRE_SHA256.slice(0, 8)}…) nor the recorded patch (${PINNED_POST_SHA256.slice(0, 8)}…) — the app may have been updated or modified elsewhere; refusing to overwrite it`)
    } else {
      const obSt = await fileState(originalCopy)
      if (obSt !== 'present') die('authoritative external backup missing — refusing; inspect manually')
      const bytes = await readFile(originalCopy)
      if (sha(bytes) !== PINNED_PRE_SHA256) die('external backup bytes do not match the pinned pre-hash — refusing')
      say('[plan] restore the pinned original bytes from the external backup (hash verified)')
      if (!APPLY) { say('[dry-run] target App not modified — re-run with --rollback --apply'); return 0 }
      processGuard(' (pre-rollback re-check)')
      await stagedWrite(file, bytes, PINNED_PRE_SHA256, 'rollback', mode)
      const final = await shaFile(file)
      if (final !== PINNED_PRE_SHA256) die('post-rollback verification failed — manual intervention required')
      say(`[ok] rolled back ${file} (target re-read and verified against the pinned pre-hash)`)
    }
    if (APPLY) {
      await rm(v2bak, { force: true })
      await writeManifest({ ...manifest, status: 'rolled-back', rolledBackAt: new Date().toISOString() })
    }
    return 0
  }

  // ---- apply / recover ----
  const text = await readFile(file, 'utf8')
  const originalBuf = Buffer.from(text, 'utf8')
  const curSha = sha(originalBuf)
  if (curSha !== PINNED_PRE_SHA256 && curSha !== PINNED_POST_SHA256 && text.includes(PATCHED_MARKER)) die('patch marker present but the file verifies as neither pinned build — refusing; inspect manually')

  const manifest = await readManifestVerified()
  if (manifest?.status === 'installed' && curSha === PINNED_POST_SHA256) {
    const obSt = await fileState(originalCopy)
    const obOk = obSt === 'present' && (await shaFile(originalCopy).catch(() => null)) === PINNED_PRE_SHA256
    say(`[ok] already patched and complete (${PINNED_CHUNK}, full post-hash verified) — nothing to do`)
    if (!obOk) say(`[warn] the authoritative external backup is ${obSt === 'absent' ? 'MISSING' : 'INVALID'} (${originalCopy}) — restore it from a trusted copy before you need to roll back`)
    return 0
  }
  if (curSha === PINNED_POST_SHA256) {
    // interrupted AFTER the switch: finalize (identity verified at both ends).
    const obSt = await fileState(originalCopy)
    if (obSt !== 'present') die('target is patched but the authoritative external backup is missing — refusing to finalize; inspect manually')
    if ((await shaFile(originalCopy)) !== PINNED_PRE_SHA256) die('external backup does not hold the pinned original bytes — refusing to finalize')
    say('[plan] a previous run switched the target but did not finalize — finalize the install record (backup verified, both pinned hashes hold)')
    if (!APPLY) { say('[dry-run] target App not modified'); return 0 }
    await writeManifest({ ...baseRecord(), status: 'installed', appliedAt: new Date().toISOString(), recoveredFrom: manifest?.status ?? 'no-record' })
    say('[ok] recovered: install finalized (interrupted run detected post-switch)')
    return 0
  }
  if (curSha !== PINNED_PRE_SHA256) die(`target sha256 ${curSha.slice(0, 8)}… does not match the pinned original build ${PINNED_PRE_SHA256.slice(0, 8)}… — refusing (updated or unknown build)`)
  if (manifest?.status === 'pending') {
    // interrupted BEFORE the switch: on --apply, preserve the evidence and
    // start fresh; a dry-run only reports the plan and must never mutate the
    // transaction record (round 3 #2).
    const archived = `${manifestFile}.aborted-${Date.now()}`
    if (!APPLY) say(`[plan] would archive the interrupted pending record to ${path.basename(archived)} (dry-run: not modified)`)
    else {
      await rename(manifestFile, archived)
      say(`[lock] previous run left a pending record with the target untouched — evidence preserved at ${path.basename(archived)}`)
    }
  }

  // validations on the pinned original
  const start = text.indexOf(START_ANCHOR)
  if (start < 0) die('start anchor not found — refusing')
  const end = text.indexOf(END_ANCHOR, start)
  if (end < 0 || end - start !== PINNED_REGION_BEFORE) die(`end anchor not found or region size ${end - start} != pinned ${PINNED_REGION_BEFORE} — refusing`)
  const region = text.slice(start, end)
  const geCount = (region.match(/\bge\(/g) ?? []).length
  if (geCount !== recipe.geRegionCount) die(`unexpected internal occurrence count for ge() in module region: ${geCount} (expected ${recipe.geRegionCount} for recipe ${recipe.id}) — refusing`)
  for (const id of FRESH_IDS) if (new RegExp(`\\b${id}\\b`).test(text)) die(`fresh identifier '${id}' already exists elsewhere in the chunk — refusing (collision risk)`)
  const outside = ((text.slice(0, start).match(/\bge\(/g) ?? []).length) + ((text.slice(end).match(/\bge\(/g) ?? []).length)
  if (outside > 0) die(`ge() referenced outside the module region (${outside} hit(s)) — refusing; interface assumption violated`)

  const patchedBuf = Buffer.from(text.slice(0, start) + REPLACEMENT + text.slice(end), 'utf8')
  const postSha = sha(patchedBuf)
  if (postSha !== PINNED_POST_SHA256) die(`transformed bytes hash to ${postSha.slice(0, 8)}… instead of the pinned patched build ${PINNED_POST_SHA256.slice(0, 8)}… — refusing (transformation drift)`)

  const tmpDir = path.join(EXPERIMENT_ROOT, 'tmp', `syntax-${randomUUID().slice(0, 8)}`)
  await mkdir(tmpDir, { recursive: true })
  let syntaxOk = true
  try {
    const tmpCheck = path.join(tmpDir, 'check.mjs')
    await writeFile(tmpCheck, patchedBuf)
    const check = spawnSync('node', ['--check', tmpCheck], { encoding: 'utf8' })
    if (check.status !== 0) { syntaxOk = false; say(`transformed file fails node --check:\n${check.stderr}`) }
  } finally { await rm(tmpDir, { recursive: true, force: true }) }
  if (!syntaxOk) die('syntax check failed — refusing')

  say(`[plan] patch ${PINNED_CHUNK}`)
  say(`  module region: ${region.length} chars -> ${REPLACEMENT.length} chars (window-sync v2)`)
  say(`  pre  sha256: ${PINNED_PRE_SHA256} (pinned build verified)`)
  say(`  post sha256: ${PINNED_POST_SHA256}`)
  say(`  authoritative backup: ${originalCopy}`)
  say(`  auxiliary in-app backup: ${v2bak}`)
  if (!APPLY) { say('[dry-run] target App not modified — re-run with --apply to execute.'); return 0 }

  // preconditions (outside the transaction: failures must not trigger recovery)
  const obSt = await fileState(originalCopy)
  if (obSt === 'present') { if ((await shaFile(originalCopy)) !== PINNED_PRE_SHA256) die('existing external backup does not match the pinned pre-hash — refusing') }
  else if (obSt !== 'absent') die(`external backup unreadable (${obSt}) — refusing`)
  const vbSt = await fileState(v2bak)
  if (vbSt === 'present') {
    // A leftover .v2bak from OUR OWN interrupted pending run (trusted record +
    // pinned original bytes) is cleaned up; anything else is foreign and refused.
    const ours = manifest?.status === 'pending' && (await shaFile(v2bak).catch(() => null)) === PINNED_PRE_SHA256
    if (!ours) die('unexpected pre-existing .v2bak in the app — refusing to overwrite it')
    if (APPLY) { await rm(v2bak, { force: true }); say('[lock] removed our own leftover in-app backup from the interrupted run') }
    else say('[plan] would remove our own leftover in-app backup from the interrupted run (dry-run: not modified)')
  }
  if (vbSt !== 'absent' && vbSt !== 'present') die(`.v2bak unreadable (${vbSt}) — refusing`)

  try {
    // transaction: external backup -> pending record -> aux backup -> re-check -> switch -> finalize
    if (obSt === 'absent') await exclusiveWriteVerified(originalCopy, originalBuf, PINNED_PRE_SHA256, 'external-backup')
    inject('external-backup')

    await writeManifest({ ...baseRecord(), status: 'pending', appliedAt: null })
    injectExit('pending-manifest')

    await exclusiveWriteVerified(v2bak, originalBuf, PINNED_PRE_SHA256, 'in-app-backup')
    inject('v2bak')
    injectExit('after-v2bak')

    processGuard(' (pre-switch re-check)')
    inject('before-switch')

    await stagedWrite(file, patchedBuf, PINNED_POST_SHA256, 'target', mode)
    if ((await shaFile(file)) !== PINNED_POST_SHA256) throw new Error('post-install verification failed')
    injectExit('after-switch')

    inject('installed-manifest')
    await writeManifest({ ...baseRecord(), status: 'installed', appliedAt: new Date().toISOString() })
    say(`[ok] patched ${file}`)
    say(`[ok] rollback: node scripts/host-binary-patch.mjs --app='${appPath}' --rollback --apply`)
    return 0
  } catch (err) {
    say(`[recover] install failed: ${err.message} — attempting recovery`)
    try {
      let cur = null
      try { cur = await shaFile(file) } catch { cur = 'unreadable' }
      if (cur !== PINNED_PRE_SHA256) {
        // Only restore a target holding OUR pinned post bytes (or unreadable).
        // A third hash means something else changed it mid-transaction (e.g. an
        // app update) — never overwrite that (round 3 #5).
        if (cur !== PINNED_POST_SHA256 && cur !== 'unreadable') throw new Error(`target changed to unknown hash ${String(cur).slice(0, 8)}… mid-transaction — refusing to overwrite it`)
        inject('recovery-write')
        await stagedWrite(file, originalBuf, PINNED_PRE_SHA256, 'recovery', mode)
      }
      await rm(v2bak, { force: true })
      const final = await shaFile(file).catch(() => 'unreadable')
      if (final !== PINNED_PRE_SHA256) throw new Error(`target is ${String(final).slice(0, 10)}… after recovery — restoration NOT verified`)
      await writeManifest({ ...baseRecord(), status: 'aborted', abortReason: err.message, abortedAt: new Date().toISOString() })
      console.error('[error] install failed — target re-read and VERIFIED restored to the pinned original; manifest records the abort')
      return 1
    } catch (err2) {
      await writeManifest({ ...baseRecord(), status: 'broken', abortReason: err.message, recoveryError: err2.message, brokenAt: new Date().toISOString() }).catch(() => {})
      console.error(`[error] RECOVERY FAILED — manual intervention required (authoritative backup: ${originalCopy}): ${err2.message}`)
      return 1
    }
  }
} catch (e) {
  if (!(e instanceof FatalError)) console.error(`[error] unexpected failure: ${e.stack || e.message}`)
  return 1
} finally {
  if (lockHeld) await releaseLock()
}
}

process.exit(await main())
