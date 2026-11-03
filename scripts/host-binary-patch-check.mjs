// Adversarial matrix for scripts/host-binary-patch.mjs (hardening v3).
// Node-assert based: every case checks exit code, output, and byte hashes
// before/after; any failure fails the whole run (nonzero exit) and a
// machine-readable JSON report is written to .local/.
// Coverage (36 cases): the 15 scenarios of the v2 matrix (updated for v3
// messages) plus the review-round-2 debt: pending-restart state machine
// (pre-switch / post-switch), deterministic fault injections (external-backup,
// v2bak via chmod, installed-manifest, recovery-write), concurrent execution
// (single-flight lock), experiment-root refusal (the working app itself),
// symlink refusal (candidate entry and bundle segment).
// Each case builds a fresh minimal fake app tree (only the target chunk — the
// tool touches nothing else) under .local/tmp/hbp-check-<ts>/; trees are kept
// for forensics; manifests accumulate under .local/host-binary-patch-manifests/.
// The source chunk is the project's frozen old-build copy (.local/host-binary-
// patch-test): the working app self-updated on 2026-11-03 (new build
// sourceHash c6807894…, chunk layout-CSIx4R7D.js), so the matrix must never
// depend on the live working tree. Case 22 still points the TOOL at the
// working app (refusal happens at path enforcement before any read).
import { readFile, writeFile, mkdir, rm, chmod, realpath, readdir, symlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawnSync, spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TOOL = path.join(root, 'scripts', 'host-binary-patch.mjs')
const CHUNK = path.join(root, '.local/host-binary-patch-test/Hermes.app/Contents/Resources/app.asar.unpacked/dist/assets/layout-lXjPuTgt.js')
const PINNED = '2c2f82c100c6fa51090bc5b7d04787479db26d723202b91bb3ed72c94fc4771e'
const EXPECTED_POST = '5d47e594ed96dbe5679680ce94930a0b2933d63b8420ac139da04a229f46b125'
const base = path.join(root, '.local', 'tmp', `hbp-check-${Date.now()}`)
await mkdir(base, { recursive: true })

const sha = async f => createHash('sha256').update(await readFile(f)).digest('hex')
const exists = async f => { try { await readFile(f); return true } catch { return false } }
const run = args => spawnSync('node', [TOOL, ...args], { encoding: 'utf8' })
const runAsync = args => new Promise(resolve => {
  const child = spawn('node', [TOOL, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', err = ''
  child.stdout.on('data', d => { out += d })
  child.stderr.on('data', d => { err += d })
  child.on('error', e => resolve({ status: -1, stdout: out, stderr: err + String(e) }))
  child.on('exit', code => resolve({ status: code ?? -1, stdout: out, stderr: err }))
})
const results = []
let failed = 0
const apps = {}

async function makeApp(id) {
  const dir = path.join(base, `app-${id}`)
  const assets = path.join(dir, 'Contents/Resources/app.asar.unpacked/dist/assets')
  await mkdir(assets, { recursive: true })
  const chunk = path.join(assets, 'layout-lXjPuTgt.js')
  await writeFile(chunk, await readFile(CHUNK))
  const appReal = await realpath(dir)
  apps[id] = { appReal, chunk, assets }
  return apps[id]
}
const manifestDirOf = id => path.join(root, '.local', 'host-binary-patch-manifests', createHash('sha256').update(apps[id].appReal).digest('hex').slice(0, 12))
const manifestOf = id => path.join(manifestDirOf(id), 'manifest.json')
const chunkOf = id => apps[id].chunk
const appArg = id => '--app=' + apps[id].appReal

async function caseRun(id, fn) {
  try { await fn(); results.push({ case: id, pass: true }); console.log(`PASS ${id}`) }
  catch (err) { failed++; results.push({ case: id, pass: false, error: String(err.message || err) }); console.log(`FAIL ${id}: ${err.message}`) }
}
const modify = async (file, from, to) => {
  const text = (await readFile(file, 'utf8'))
  assert.ok(text.includes(from), `precondition failed: pattern not found: ${from.slice(0, 40)}`)
  await writeFile(file, text.replace(from, to))
}

await caseRun('01-dry-run', async () => {
  await makeApp('01'); const chunk = chunkOf('01')
  const r = run([appArg('01')])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /\[plan\]/); assert.match(r.stdout, /\[dry-run\]/)
  assert.equal(await sha(chunk), PINNED, 'target must be untouched by dry-run')
  assert.equal(await exists(chunk + '.v2bak'), false, 'dry-run must not create backups')
})
await caseRun('02-apply', async () => {
  await makeApp('02'); const chunk = chunkOf('02')
  const r = run([appArg('02'), '--production'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /\[ok\] patched/)
  const manifest = JSON.parse(await readFile(manifestOf('02'), 'utf8'))
  assert.equal(manifest.status, 'installed')
  assert.equal(manifest.preSha256, PINNED)
  assert.equal(manifest.postSha256, EXPECTED_POST, 'post-hash regression pin')
  assert.equal(await sha(chunk), EXPECTED_POST)
  assert.equal(await sha(chunk + '.v2bak'), PINNED, 'in-app backup must hold original bytes')
  assert.equal(await sha(path.join(manifestDirOf('02'), 'original.js')), PINNED, 'authoritative external backup must hold original bytes')
})
await caseRun('03-idempotent-reapply', async () => {
  const r = run([appArg('02'), '--production'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /already patched and complete/)
  assert.equal(await sha(chunkOf('02')), EXPECTED_POST)
})
await caseRun('04-anchor-tamper-refused', async () => {
  await makeApp('04'); const chunk = chunkOf('04')
  await modify(chunk, 'pluginDecisions.v2`,pe=', 'pluginDecisions.vX`,pe=')
  const before = await sha(chunk)
  const r = run([appArg('04'), '--production'])
  assert.notEqual(r.status, 0, 'must refuse on unknown anchor')
  assert.match(r.stderr, /anchor scan/)
  assert.equal(await sha(chunk), before, 'target must be untouched')
})
await caseRun('05-region-interior-tamper-refused', async () => {
  await makeApp('05'); const chunk = chunkOf('05')
  await modify(chunk, 'function he(e,t=!0){', 'function he(e,t=!1){')
  const before = await sha(chunk)
  const r = run([appArg('05'), '--production'])
  assert.notEqual(r.status, 0, 'anchors kept but bytes differ -> must refuse via the pre pin')
  assert.match(r.stderr, /no registered recipe/)
  assert.equal(await sha(chunk), before)
})
await caseRun('06-outside-region-modification-refused', async () => {
  await makeApp('06'); const chunk = chunkOf('06')
  await writeFile(chunk, Buffer.concat([await readFile(chunk), Buffer.from('//x')]))
  const before = await sha(chunk)
  const r = run([appArg('06'), '--production'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /no registered recipe/)
  assert.equal(await sha(chunk), before)
})
await caseRun('07-marker-present-body-tampered-refused', async () => {
  await makeApp('07'); const chunk = chunkOf('07')
  assert.equal(run([appArg('07'), '--production']).status, 0, 'precondition: clean install')
  await modify(chunk, 'pdv=new Map', 'pdv=new Map ')
  const before = await sha(chunk)
  const r = run([appArg('07'), '--production'])
  assert.notEqual(r.status, 0, 'marker alone must not count as installed')
  assert.match(r.stderr, /no registered recipe/)
  assert.equal(await sha(chunk), before)
})
await caseRun('08-preexisting-v2bak-refused', async () => {
  await makeApp('08'); const chunk = chunkOf('08')
  await writeFile(chunk + '.v2bak', 'garbage-not-a-backup')
  const r = run([appArg('08'), '--production'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /pre-existing \.v2bak/)
  assert.equal(await sha(chunk), PINNED)
  assert.equal((await readFile(chunk + '.v2bak', 'utf8')), 'garbage-not-a-backup', 'existing file must not be overwritten')
})
await caseRun('09-rollback-restores-original', async () => {
  const chunk = chunkOf('02')
  const r = run([appArg('02'), '--rollback', '--production'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /rolled back/)
  assert.equal(await sha(chunk), PINNED)
  assert.equal(await exists(chunk + '.v2bak'), false, 'rollback must clean the in-app backup')
  assert.equal(JSON.parse(await readFile(manifestOf('02'), 'utf8')).status, 'rolled-back')
})
await caseRun('10-rollback-after-simulated-update-refused', async () => {
  await makeApp('10'); const chunk = chunkOf('10')
  assert.equal(run([appArg('10'), '--production']).status, 0, 'precondition: clean install')
  await writeFile(chunk, Buffer.concat([await readFile(CHUNK), Buffer.from('//official-update')]))
  const before = await sha(chunk)
  const r = run([appArg('10'), '--rollback', '--production'])
  assert.notEqual(r.status, 0, 'must refuse to overwrite a target changed by someone else')
  assert.match(r.stderr, /no registered recipe/)
  assert.equal(await sha(chunk), before, 'simulated update must be preserved')
})
await caseRun('11-rollback-without-manifest-refused', async () => {
  await makeApp('11'); const chunk = chunkOf('11')
  assert.equal(run([appArg('11'), '--production']).status, 0, 'precondition: clean install')
  await rm(manifestOf('11'), { force: true })
  const r = run([appArg('11'), '--rollback', '--production'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /no trusted install record/)
  assert.equal(await sha(chunk), EXPECTED_POST, 'target must be left alone')
})
await caseRun('12-backup-failure-aborts-safely', async () => {
  await makeApp('12'); const { chunk, assets } = apps['12']
  await chmod(assets, 0o555)
  try {
    const r = run([appArg('12'), '--production'])
    assert.notEqual(r.status, 0, 'install must fail when the in-app backup cannot be written')
    assert.match(r.stderr, /install failed/)
    assert.equal(await sha(chunk), PINNED, 'target must still be the pristine original')
    const manifest = JSON.parse(await readFile(manifestOf('12'), 'utf8'))
    assert.equal(manifest.status, 'aborted')
  } finally { await chmod(assets, 0o755) }
})
await caseRun('13-reapply-after-abort-not-wedged', async () => {
  const chunk = chunkOf('12')
  const r = run([appArg('12'), '--production'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(await sha(chunk), EXPECTED_POST)
  assert.equal(JSON.parse(await readFile(manifestOf('12'), 'utf8')).status, 'installed')
})
await caseRun('14-dry-run-on-installed-idempotent', async () => {
  const r = run([appArg('12')])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /already patched and complete/)
})
await caseRun('15-process-guard-refuses', async () => {
  await makeApp('15')
  const { appReal } = apps['15']
  const dummy = spawn('node', ['-e', 'setTimeout(() => {}, 20000)', appReal + '/Contents/MacOS/Hermes'], { stdio: 'ignore' })
  try {
    await new Promise(resolve => setTimeout(resolve, 300))
    const r = run([appArg('15'), '--production'])
    assert.notEqual(r.status, 0, 'must refuse while a matching process runs')
    assert.match(r.stderr, /is running/)
    assert.equal(await sha(chunkOf('15')), PINNED)
  } finally { dummy.kill() }
})
await caseRun('16-pending-restart-pre-switch', async () => {
  await makeApp('16'); const chunk = chunkOf('16')
  const crash = run([appArg('16'), '--production', '--inject=pending-manifest'])
  assert.equal(crash.status, 70, 'injected crash must exit 70')
  assert.equal(await sha(chunk), PINNED, 'crash happened before the switch')
  const r = run([appArg('16'), '--production'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /evidence preserved/)
  assert.equal(await sha(chunk), EXPECTED_POST)
  assert.equal(JSON.parse(await readFile(manifestOf('16'), 'utf8')).status, 'installed')
  const archived = (await readdir(manifestDirOf('16'))).filter(n => /^manifest\.json\.aborted-\d+$/.test(n))
  assert.ok(archived.length >= 1, 'the interrupted pending record must be preserved as evidence')
})
await caseRun('17-pending-restart-post-switch', async () => {
  await makeApp('17'); const chunk = chunkOf('17')
  const crash = run([appArg('17'), '--production', '--inject=after-switch'])
  assert.equal(crash.status, 70, 'injected crash must exit 70')
  assert.equal(await sha(chunk), EXPECTED_POST, 'crash happened after the switch')
  const r = run([appArg('17'), '--production'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /recovered/)
  assert.equal(await sha(chunk), EXPECTED_POST)
  const manifest = JSON.parse(await readFile(manifestOf('17'), 'utf8'))
  assert.equal(manifest.status, 'installed')
  assert.equal(manifest.recoveredFrom, 'pending')
  assert.equal(await sha(path.join(manifestDirOf('17'), 'original.js')), PINNED)
})
await caseRun('18-installed-manifest-fault-recovers', async () => {
  await makeApp('18'); const chunk = chunkOf('18')
  const r = run([appArg('18'), '--production', '--inject=installed-manifest'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /install failed/)
  assert.equal(await sha(chunk), PINNED, 'recovery must restore the pinned original')
  assert.equal(JSON.parse(await readFile(manifestOf('18'), 'utf8')).status, 'aborted')
  assert.equal(await exists(chunk + '.v2bak'), false)
})
await caseRun('19-recovery-write-fault-honest-broken', async () => {
  await makeApp('19'); const chunk = chunkOf('19')
  const r = run([appArg('19'), '--production', '--inject=installed-manifest,recovery-write'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /RECOVERY FAILED/)
  assert.equal(await sha(chunk), EXPECTED_POST, 'target must be left as-is (restore failed) — never falsely reported restored')
  const manifest = JSON.parse(await readFile(manifestOf('19'), 'utf8'))
  assert.equal(manifest.status, 'broken')
  assert.equal(await sha(path.join(manifestDirOf('19'), 'original.js')), PINNED, 'authoritative backup must remain intact')
})
await caseRun('20-concurrent-single-flight', async () => {
  await makeApp('20')
  const first = runAsync([appArg('20'), '--production'])
  await new Promise(resolve => setTimeout(resolve, 100))
  const second = runAsync([appArg('20'), '--production'])
  const [r1, r2] = await Promise.all([first, second])
  const codes = [r1.status, r2.status]
  assert.ok(codes.includes(0), `at least one apply must succeed: ${JSON.stringify({ codes, e1: r1.stderr.slice(-200), e2: r2.stderr.slice(-200) })}`)
  if (codes.filter(c => c === 0).length === 2) {
    assert.ok([r1, r2].some(r => /already patched and complete/.test(r.stdout)), 'two successes must mean one serialized behind the other (idempotent)')
  }
  for (const [label, r] of [['first', r1], ['second', r2]]) {
    if (r.status !== 0) assert.match(r.stderr, /another patch operation holds|stale lock/, `${label} loser must refuse on the lock, not corrupt`)
  }
  assert.equal(await sha(chunkOf('20')), EXPECTED_POST)
  assert.equal(JSON.parse(await readFile(manifestOf('20'), 'utf8')).status, 'installed')
  assert.equal(await sha(chunkOf('20') + '.v2bak'), PINNED)
})
await caseRun('21-external-backup-fault-aborts', async () => {
  await makeApp('21'); const chunk = chunkOf('21')
  const r = run([appArg('21'), '--production', '--inject=external-backup'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /install failed/)
  assert.equal(await sha(chunk), PINNED, 'target must remain the pinned original')
  assert.equal(JSON.parse(await readFile(manifestOf('21'), 'utf8')).status, 'aborted')
  assert.equal(await exists(chunk + '.v2bak'), false)
})
await caseRun('22-running-working-app-refused-by-process-guard', async () => {
  const WORK_APP = path.join(os.homedir(), '.hermes/hermes-agent/apps/desktop/release/mac-arm64/Hermes.app')
  const assetsDir = path.join(WORK_APP, 'Contents/Resources/app.asar.unpacked/dist/assets')
  let anchor = null
  for (const n of await readdir(assetsDir)) {
    if (n.endsWith('.js') && (await readFile(path.join(assetsDir, n), 'utf8')).includes('hermes.desktop.pluginDecisions.v2')) { anchor = n; break }
  }
  assert.ok(anchor, 'anchor chunk present in the real working app')
  const before = await sha(path.join(assetsDir, anchor))
  const r = run(['--app=' + WORK_APP])
  assert.notEqual(r.status, 0, 'a running working app must still be refused')
  assert.match(r.stderr, /is running/, 'refusal must name the running process')
  assert.doesNotMatch(r.stderr, /experiment root/, 'the path restriction is gone — only the process guard refuses')
  assert.equal(await sha(path.join(assetsDir, anchor)), before, 'the working app must not be touched even on refusal')
})
await caseRun('23-symlink-candidate-refused', async () => {
  await makeApp('23')
  const { assets } = apps['23']
  await symlink('layout-lXjPuTgt.js', path.join(assets, 'zz-suspicious.js'))
  const r = run([appArg('23')])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /non-regular or symlinked/)
  assert.equal(await sha(chunkOf('23')), PINNED)
})
await caseRun('24-bundle-segment-symlink-refused', async () => {
  const dir = path.join(base, 'app-24')
  const payload = path.join(base, 'app-24-payload')
  const payloadAssets = path.join(payload, 'dist/assets')
  await mkdir(payloadAssets, { recursive: true })
  await writeFile(path.join(payloadAssets, 'layout-lXjPuTgt.js'), await readFile(CHUNK))
  await mkdir(path.join(dir, 'Contents/Resources'), { recursive: true })
  await symlink(payload, path.join(dir, 'Contents/Resources/app.asar.unpacked'))
  const r = run(['--app=' + await realpath(dir)])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /symlink inside the app bundle/)
})

await caseRun('25-pending-crash-after-v2bak-recovers-own-backup', async () => {
  await makeApp('25'); const chunk = chunkOf('25')
  const crash = run([appArg('25'), '--production', '--inject=after-v2bak'])
  assert.equal(crash.status, 70, 'injected crash must exit 70')
  assert.equal(await sha(chunk), PINNED, 'crash happened before the switch')
  assert.equal(await exists(chunk + '.v2bak'), true, 'own leftover backup present')
  const r = run([appArg('25'), '--production'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /own leftover in-app backup|evidence preserved/)
  assert.equal(await sha(chunk), EXPECTED_POST)
  assert.equal(JSON.parse(await readFile(manifestOf('25'), 'utf8')).status, 'installed')
})
await caseRun('26-dry-run-on-pending-does-not-mutate-records', async () => {
  await makeApp('26')
  const crash = run([appArg('26'), '--production', '--inject=pending-manifest'])
  assert.equal(crash.status, 70)
  const r = run([appArg('26')])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(JSON.parse(await readFile(manifestOf('26'), 'utf8')).status, 'pending', 'dry-run must not archive or rewrite the pending record')
  assert.equal((await readdir(manifestDirOf('26'))).filter(n => /^manifest\.json\.aborted-/.test(n)).length, 0, 'dry-run must not create archived records')
  assert.equal(await sha(chunkOf('26')), PINNED, 'dry-run must not touch the target')
})
await caseRun('27-malformed-lock-refused-conservatively', async () => {
  await makeApp('27')
  await mkdir(manifestDirOf('27'), { recursive: true })
  await writeFile(path.join(manifestDirOf('27'), 'lock'), 'not-json{')
  const r = run([appArg('27')])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /unreadable or malformed/)
  assert.equal(await readFile(path.join(manifestDirOf('27'), 'lock'), 'utf8'), 'not-json{', 'the lock must not be auto-deleted')
})
await caseRun('28-third-hash-target-with-pending-refused', async () => {
  await makeApp('28'); const chunk = chunkOf('28')
  const crash = run([appArg('28'), '--production', '--inject=after-switch'])
  assert.equal(crash.status, 70)
  await writeFile(chunk, Buffer.concat([await readFile(chunk), Buffer.from('//third-party')]))
  const before = await sha(chunk)
  const r = run([appArg('28'), '--production'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /no registered recipe/)
  assert.equal(await sha(chunk), before)
})
await caseRun('29-backup-write-interrupt-cleans-half-file', async () => {
  await makeApp('29'); const chunk = chunkOf('29')
  const r = run([appArg('29'), '--production', '--inject=write-interrupt:external-backup'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /install failed/)
  assert.equal(await sha(chunk), PINNED)
  assert.equal(await exists(path.join(manifestDirOf('29'), 'original.js')), false, 'a half-written backup must never be left behind')
  assert.equal(JSON.parse(await readFile(manifestOf('29'), 'utf8')).status, 'aborted')
})
await caseRun('30-input-path-symlink-refused', async () => {
  await makeApp('30')
  const linkApp = path.join(base, 'app-30-link')
  await symlink(apps['30'].appReal, linkApp)
  const r = run(['--app=' + linkApp])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /INPUT app path/)
  assert.equal(await sha(chunkOf('30')), PINNED)
})

const NEW_CHUNK_SRC = path.join(root, '.local/host-binary-patch-test-c6807894/Hermes.app/Contents/Resources/app.asar.unpacked/dist/assets/layout-CSIx4R7D.js')
const NEW_PINNED = 'fd49bb08d1ad742350813504fbc75d75a94e9bb6b80a8c9b38ac67136b2a2c20'
const NEW_POST = '8ad8215687ed76f589f5d54a7b12028b2857941cb955d1d4c4df3bc32384753b'
const newApps = {}
async function makeAppNew(id) {
  const dir = path.join(base, `newapp-${id}`)
  const assets = path.join(dir, 'Contents/Resources/app.asar.unpacked/dist/assets')
  await mkdir(assets, { recursive: true })
  const chunk = path.join(assets, 'layout-CSIx4R7D.js')
  await writeFile(chunk, await readFile(NEW_CHUNK_SRC))
  newApps[id] = { appReal: await realpath(dir), chunk }
  return newApps[id]
}
const newAppArg = id => '--app=' + newApps[id].appReal
const newManifestOf = id => path.join(root, '.local', 'host-binary-patch-manifests', createHash('sha256').update(newApps[id].appReal).digest('hex').slice(0, 12), 'manifest.json')
await caseRun('31-new-recipe-experimental-apply', async () => {
  await makeAppNew('31'); const chunk = newApps['31'].chunk
  const dry = run([newAppArg('31')])
  assert.equal(dry.status, 0, dry.stderr)
  assert.doesNotMatch(dry.stdout, /\[experimental\] recipe/, 'verified recipe must not carry the recipe-level experimental banner (tool-level banner stays by design)')
  const r = run([newAppArg('31'), '--production'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(await sha(chunk), NEW_POST)
  const manifest = JSON.parse(await readFile(newManifestOf('31'), 'utf8'))
  assert.equal(manifest.status, 'installed')
  assert.equal(manifest.recipeId, 'c-c6807894')
  assert.equal(await sha(chunk + '.v2bak'), NEW_PINNED)
})
await caseRun('32-new-recipe-rollback', async () => {
  const chunk = newApps['31'].chunk
  const r = run([newAppArg('31'), '--rollback', '--production'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(await sha(chunk), NEW_PINNED, 'rollback restores the new build original bytes')
  assert.equal(await exists(chunk + '.v2bak'), false)
})
await caseRun('33-new-recipe-reapply-idempotent', async () => {
  const chunk = newApps['31'].chunk
  assert.equal(run([newAppArg('31'), '--production']).status, 0, 're-apply after rollback')
  const r = run([newAppArg('31'), '--production'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /already patched and complete/)
  assert.equal(await sha(chunk), NEW_POST)
})
await caseRun('34-new-recipe-third-hash-refused', async () => {
  await makeAppNew('34'); const chunk = newApps['34'].chunk
  assert.equal(run([newAppArg('34'), '--production']).status, 0, 'precondition: clean install')
  await writeFile(chunk, Buffer.concat([await readFile(chunk), Buffer.from('//third')]))
  const before = await sha(chunk)
  const r = run([newAppArg('34'), '--production'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /no registered recipe/)
  assert.equal(await sha(chunk), before)
})

await caseRun('35-cross-build-bytes-name-mismatch-refused', async () => {
  const dir = path.join(base, 'app-35')
  const assets = path.join(dir, 'Contents/Resources/app.asar.unpacked/dist/assets')
  await mkdir(assets, { recursive: true })
  const chunk = path.join(assets, 'layout-lXjPuTgt.js')
  await writeFile(chunk, await readFile(NEW_CHUNK_SRC))
  const appReal35 = await realpath(dir)
  const before = await sha(chunk)
  const r = run(['--app=' + appReal35, '--production'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /does not match recipe/)
  assert.equal(await sha(chunk), before)
})

await caseRun('36-outside-local-tmpdir-app-fully-usable', async () => {
  // macOS: os.tmpdir() starts with /var, itself a symlink on macOS — the
  // input-chain symlink defense refuses that on purpose. Resolve first so this
  // case tests path-independence, not symlink tolerance (cases 24/30 cover that).
  const dir = path.join(await realpath(os.tmpdir()), 'hbp-36-' + Date.now())
  const assets = path.join(dir, 'Contents/Resources/app.asar.unpacked/dist/assets')
  await mkdir(assets, { recursive: true })
  const chunk = path.join(assets, 'layout-CSIx4R7D.js')
  await writeFile(chunk, await readFile(NEW_CHUNK_SRC))
  const dry = run(['--app=' + dir])
  assert.equal(dry.status, 0, dry.stderr)
  assert.match(dry.stdout, /\[plan\] patch layout-CSIx4R7D\.js/, 'dry-run must work outside .local (no path restriction)')
  assert.equal(await sha(chunk), NEW_PINNED, 'dry-run wrote nothing')
  const r = run(['--app=' + dir, '--production'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(await sha(chunk), NEW_POST, '--production writes outside .local')
  const rb = run(['--app=' + dir, '--rollback', '--production'])
  assert.equal(rb.status, 0, rb.stderr)
  assert.equal(await sha(chunk), NEW_PINNED, 'rollback restores outside .local')
  await rm(dir, { recursive: true, force: true })
})

const report = { at: new Date().toISOString(), base, total: results.length, failed, results }
await writeFile(path.join(root, '.local', 'host-binary-patch-check-latest.json'), JSON.stringify(report, null, 2) + '\n')
console.log(`\n${results.length - failed}/${results.length} cases passed (report: .local/host-binary-patch-check-latest.json, trees: ${base})`)
process.exit(failed ? 1 : 0)
