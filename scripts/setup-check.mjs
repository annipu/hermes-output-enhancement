// Unified-entry matrix for scripts/setup.mjs (thin orchestrator).
// Node-assert based: per-case exit code, output, target byte hashes, plugin
// directory state, transaction-record status and the unified report are all
// checked; any failure fails the whole run with a nonzero exit.
// Coverage (13 cases, review-agreed 2026-11-03):
//   dry-run zero-write / fresh install (host+plugin+tx record) / idempotent
//   rerun / unknown host build refuses AND the plugin is untouched / plugin
//   preflight failure leaves the host untouched / host-success-then-plugin-
//   failure compensates (restores the host patch THIS transaction applied) /
//   a PRE-EXISTING patch is never rolled back on plugin failure / compensation
//   failure reports honestly (manual-needed) / interrupted-run recovery both
//   ways (continue to install; or compensate because this tx owned the patch) /
//   uninstall removes only the plugin / uninstall --with-host-patch also
//   reverts the host patch / an older plugin version upgrades through the entry.
// Each case uses a fresh fake app tree (frozen old-build chunk) and a fresh
// isolated plugin-target root — nothing here touches the working machine.
import { readFile, writeFile, mkdir, rm, realpath, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SETUP = path.join(root, 'scripts', 'setup.mjs')
const CHUNK_SRC = path.join(root, '.local/host-binary-patch-test/Hermes.app/Contents/Resources/app.asar.unpacked/dist/assets/layout-lXjPuTgt.js')
const PLUGIN_SOURCE = path.join(root, 'plugin', 'hermes-style-plugin')
const PINNED = '2c2f82c100c6fa51090bc5b7d04787479db26d723202b91bb3ed72c94fc4771e'
const POST = '5d47e594ed96dbe5679680ce94930a0b2933d63b8420ac139da04a229f46b125'
const TX_DIR = path.join(root, '.local', 'setup-transactions')
const base = path.join(root, '.local', 'tmp', `su-check-${Date.now()}`)
await mkdir(base, { recursive: true })
const sourceInfo = JSON.parse(await readFile(path.join(PLUGIN_SOURCE, 'build-info.json'), 'utf8'))

const sha = async f => createHash('sha256').update(await readFile(f)).digest('hex')
const exists = async p => { try { await readFile(p); return true } catch { return false } }
const run = args => spawnSync('node', [SETUP, ...args], { encoding: 'utf8', cwd: root })
const results = []
let failed = 0
const apps = {}

async function makeApp(id) {
  const dir = path.join(base, `app-${id}`)
  const assets = path.join(dir, 'Contents/Resources/app.asar.unpacked/dist/assets')
  await mkdir(assets, { recursive: true })
  const chunk = path.join(assets, 'layout-lXjPuTgt.js')
  await writeFile(chunk, await readFile(CHUNK_SRC))
  apps[id] = { appReal: await realpath(dir), chunk }
  return apps[id]
}
const ptOf = id => path.join(base, `pt-${id}`)
const pluginDirOf = id => path.join(ptOf(id), 'hermes-style-plugin')
async function makePT(id, seed) {
  const pt = ptOf(id)
  await mkdir(pt, { recursive: true })
  if (seed === 'old') {
    await mkdir(pluginDirOf(id), { recursive: true })
    await writeFile(path.join(pluginDirOf(id), 'plugin.js'), '// old build bytes')
    await writeFile(path.join(pluginDirOf(id), 'build-info.json'), JSON.stringify({ id: 'hermes-style-plugin', version: '0.0.1' }, null, 2))
  }
  return pt
}
const setupArgs = (id, extra = []) => ['--app=' + apps[id].appReal, '--plugin-target=' + ptOf(id), ...extra]
async function latestTxOf(id) {
  let names
  try { names = (await readdir(TX_DIR)).filter(n => n.endsWith('.json')).sort().reverse() } catch { return null }
  for (const n of names) {
    try {
      const t = JSON.parse(await readFile(path.join(TX_DIR, n), 'utf8'))
      if (t.app === apps[id].appReal) return t
    } catch {}
  }
  return null
}

async function caseRun(id, fn) {
  try { await fn(); results.push({ case: id, pass: true }); console.log(`PASS ${id}`) }
  catch (err) { failed++; results.push({ case: id, pass: false, error: String(err.message || err) }); console.log(`FAIL ${id}: ${err.message}`) }
}

await caseRun('01-dry-run-zero-write', async () => {
  await makeApp('01'); await makePT('01')
  const r = run(setupArgs('01'))
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /host: would-patch/)
  assert.match(r.stdout, /plugin: install/)
  assert.match(r.stdout, /\[dry-run\] no changes written/)
  assert.equal(await sha(apps['01'].chunk), PINNED)
  assert.equal(await exists(pluginDirOf('01')), false)
  assert.equal(await latestTxOf('01'), null, 'dry-run must not create transaction records')
})
await caseRun('02-fresh-install-host-and-plugin', async () => {
  await makeApp('02'); await makePT('02')
  const r = run(setupArgs('02', ['--apply']))
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /"status":"installed"/)
  assert.equal(await sha(apps['02'].chunk), POST)
  assert.equal(await exists(path.join(pluginDirOf('02'), 'plugin.js')), true)
  const info = JSON.parse(await readFile(path.join(pluginDirOf('02'), 'build-info.json'), 'utf8'))
  assert.equal(info.id, 'hermes-style-plugin')
  assert.equal(info.pluginSha256, sourceInfo.pluginSha256, 'installed plugin must be the verified source bytes')
  const tx = await latestTxOf('02')
  assert.equal(tx.status, 'installed')
  assert.equal(tx.hostPatchedByUs, true)
})
await caseRun('03-idempotent-rerun', async () => {
  const before = await sha(path.join(pluginDirOf('02'), 'plugin.js'))
  const r = run(setupArgs('02', ['--apply']))
  assert.equal(r.status, 0, r.stderr)
  assert.equal(await sha(apps['02'].chunk), POST, 'host stays patched')
  assert.equal(await sha(path.join(pluginDirOf('02'), 'plugin.js')), before, 'plugin bytes unchanged')
})
await caseRun('04-unknown-host-refuses-and-plugin-untouched', async () => {
  await makeApp('04'); await makePT('04')
  await writeFile(apps['04'].chunk, Buffer.concat([await readFile(apps['04'].chunk), Buffer.from('//unknown-build')]))
  const before = await sha(apps['04'].chunk)
  const r = run(setupArgs('04', ['--apply']))
  assert.notEqual(r.status, 0, 'an unknown host build must refuse the whole install')
  assert.match(r.stdout + r.stderr, /NOTHING was written|refused/)
  assert.equal(await sha(apps['04'].chunk), before, 'host bytes untouched')
  assert.equal(await exists(pluginDirOf('04')), false, 'the plugin must not change when the host refuses')
})
await caseRun('05-plugin-preflight-failure-leaves-host-untouched', async () => {
  await makeApp('05'); await makePT('05')
  const r = run(setupArgs('05', ['--apply', '--plugin-source=' + path.join(base, 'nonexistent-source')]))
  assert.notEqual(r.status, 0)
  assert.match(r.stdout + r.stderr, /NOTHING was written|refused/)
  assert.equal(await sha(apps['05'].chunk), PINNED, 'host must stay pristine')
  assert.equal(await exists(pluginDirOf('05')), false)
})
await caseRun('06-plugin-failure-compensates-this-transaction-patch', async () => {
  await makeApp('06'); await makePT('06')
  const r = run(setupArgs('06', ['--apply', '--inject=plugin-apply']))
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /compensated|rolled back/)
  assert.equal(await sha(apps['06'].chunk), PINNED, 'the patch applied by THIS transaction must be rolled back')
  assert.equal(await exists(pluginDirOf('06')), false)
  assert.equal((await latestTxOf('06')).status, 'compensated')
})
await caseRun('07-preexisting-patch-never-rolled-back', async () => {
  await makeApp('07'); await makePT('07')
  assert.equal(run(setupArgs('07', ['--apply'])).status, 0, 'precondition: clean install')
  await rm(pluginDirOf('07'), { recursive: true, force: true }) // plugin gone, host patch stays (pre-existing)
  const r = run(setupArgs('07', ['--apply', '--inject=plugin-apply']))
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /pre-existing and was NOT touched/)
  assert.equal(await sha(apps['07'].chunk), POST, 'a pre-existing patch must NOT be rolled back')
  assert.equal((await latestTxOf('07')).status, 'failed')
})
await caseRun('08-compensation-failure-reports-manual-action', async () => {
  await makeApp('08'); await makePT('08')
  const r = run(setupArgs('08', ['--apply', '--inject=plugin-apply,host-rollback-fault']))
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /MANUAL ACTION REQUIRED|compensation/)
  assert.equal(await sha(apps['08'].chunk), POST, 'rollback failed — the patch stays (honestly reported, not silently dropped)')
  assert.equal((await latestTxOf('08')).status, 'compensation-failed')
  const report = JSON.parse(await readFile(path.join(root, '.local', 'setup-latest.json'), 'utf8'))
  assert.ok(report.manualNeeded, 'the report must carry a manualNeeded instruction')
})
await caseRun('09-interrupted-run-continues-to-install', async () => {
  await makeApp('09'); await makePT('09')
  const crash = run(setupArgs('09', ['--apply', '--inject=crash-after-host']))
  assert.equal(crash.status, 70, 'injected crash must exit 70')
  assert.equal(await sha(apps['09'].chunk), POST, 'crash happened after the host switch')
  assert.equal(await exists(pluginDirOf('09')), false, 'plugin not yet installed')
  const r = run(setupArgs('09', ['--apply']))
  assert.equal(r.status, 0, r.stderr)
  assert.equal(await sha(apps['09'].chunk), POST)
  assert.equal(await exists(path.join(pluginDirOf('09'), 'plugin.js')), true, 'rerun completes the plugin install')
  assert.equal((await latestTxOf('09')).status, 'installed')
})
await caseRun('10-interrupted-run-compensates-because-this-tx-owned-patch', async () => {
  await makeApp('10'); await makePT('10')
  const crash = run(setupArgs('10', ['--apply', '--inject=crash-after-host']))
  assert.equal(crash.status, 70)
  const r = run(setupArgs('10', ['--apply', '--inject=plugin-apply']))
  assert.notEqual(r.status, 0)
  assert.equal(await sha(apps['10'].chunk), PINNED, 'the record proves THIS transaction patched the host — compensation rolls it back')
  assert.equal((await latestTxOf('10')).status, 'compensated')
})
await caseRun('11-uninstall-removes-only-plugin', async () => {
  await makeApp('11'); await makePT('11')
  assert.equal(run(setupArgs('11', ['--apply'])).status, 0, 'precondition: installed')
  const r = run(setupArgs('11', ['--uninstall', '--apply']))
  assert.equal(r.status, 0, r.stderr)
  assert.equal(await exists(pluginDirOf('11')), false, 'plugin removed')
  assert.equal(await sha(apps['11'].chunk), POST, 'default uninstall must NOT touch the host patch')
})
await caseRun('12-uninstall-with-host-patch-reverts-both', async () => {
  await makeApp('12'); await makePT('12')
  assert.equal(run(setupArgs('12', ['--apply'])).status, 0, 'precondition: installed')
  const r = run(setupArgs('12', ['--uninstall', '--with-host-patch', '--apply']))
  assert.equal(r.status, 0, r.stderr)
  assert.equal(await exists(pluginDirOf('12')), false)
  assert.equal(await sha(apps['12'].chunk), PINNED, 'explicit combined undo reverts the host patch too')
})
await caseRun('13-older-plugin-upgrades-through-entry', async () => {
  await makeApp('13'); await makePT('13', 'old')
  const r = run(setupArgs('13', ['--apply']))
  assert.equal(r.status, 0, r.stderr)
  const info = JSON.parse(await readFile(path.join(pluginDirOf('13'), 'build-info.json'), 'utf8'))
  assert.equal(info.version, sourceInfo.version, 'the old target must be upgraded to the source version')
  assert.equal(info.pluginSha256, sourceInfo.pluginSha256)
  assert.equal(await sha(apps['13'].chunk), POST)
})

const report = { at: new Date().toISOString(), base, total: results.length, failed, results }
await writeFile(path.join(root, '.local', 'setup-check-latest.json'), JSON.stringify(report, null, 2) + '\n')
console.log(`\n${results.length - failed}/${results.length} cases passed (report: .local/setup-check-latest.json, trees: ${base})`)
process.exit(failed ? 1 : 0)
