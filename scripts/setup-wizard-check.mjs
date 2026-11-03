// Unit + integration matrix for setup-wizard.mjs — injected io/deps (no PTY)
// for the deterministic cases, plus two REAL-fixture integrations that spawn
// the real setup.mjs against an isolated plugin target (never the working
// app: components=plugin never invokes the host tool). Any failure fails the
// whole run with a nonzero exit. Creates its own .local dirs.
import { strict as assert } from 'node:assert'
import { writeFile, mkdir, rm, mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PassThrough } from 'node:stream'
import { spawnSync } from 'node:child_process'
import { LOCALES, t, loadSavedLocale } from './setup-i18n.mjs'
import { runWizard, makeAskAdapter, MENU_TITLE } from './setup-wizard.mjs'
import { DEFAULT_APP } from './install-status.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
await mkdir(path.join(root, '.local', 'tmp'), { recursive: true }) // self-created: a fresh clone has no .local at all
const PT_DEFAULT = path.join(os.homedir(), '.hermes', 'desktop-plugins')

class ScriptIO {
  constructor(answers) { this.answers = [...answers]; this.prompts = [] }
  async ask(p) { this.prompts.push(p); const a = this.answers.shift(); return a === undefined ? null : a }
}

function makeDeps(over = {}) {
  const d = {
    out: [], saved: [], loaded: 'en', detected: 'en',
    probes: { plugin: { state: 'absent', dir: '/x/plugins/hermes-style-plugin' }, host: { state: 'unpatched-supported' } },
    probeCalls: [], spawns: [],
    planResult: { status: 0, stdout: '[plan] plugin: install\n[dry-run] no changes written — re-run with --apply to execute.' },
    applyResult: { status: 0, stdout: '[ok] plugin installed\n[report] {"status":"installed"}' },
    reportFresh: async () => true,
    ...over,
  }
  d.deps = {
    out: l => d.out.push(l),
    loadSavedLocale: async () => d.loaded,
    saveLocale: async loc => { d.saved.push(loc) },
    detectLocale: () => d.detected,
    t,
    probe: async (app, pt) => { d.probeCalls.push([app, pt]); return d.probes },
    spawnSetup: args => { d.spawns.push(args); return d.spawns.length === 1 ? d.planResult : d.applyResult },
    reportFresh: d.reportFresh,
    reportPath: '/x/setup-latest.json',
  }
  return d
}

const results = []
let failed = 0
const caseRun = async (id, fn) => {
  try { await fn(); results.push({ case: id, pass: true }); console.log(`PASS ${id}`) }
  catch (err) { failed++; results.push({ case: id, pass: false, error: String(err.message || err) }); console.log(`FAIL ${id}: ${err.message}`) }
}
const joined = d => d.out.join('\n')
const VERIFIED = { plugin: { state: 'present', version: '0.1.0-alpha.2' }, host: { state: 'patched-verified' } }

await caseRun('01-menu-nine-languages-default-marked', async () => {
  const io = new ScriptIO(['', '', '', 'n']), d = makeDeps({ probes: VERIFIED })
  assert.equal(await runWizard(io, d.deps), 0)
  assert.ok(joined(d).includes(MENU_TITLE))
  const entries = d.out.filter(l => /^\s+\d+\.\s+\S/.test(l))
  assert.equal(entries.length, 9)
  assert.ok(entries.some(l => l.includes('English') && l.includes('←')))
  assert.ok(joined(d).includes(t('en', 'pluginPresent').replace('{0}', '0.1.0-alpha.2')))
  assert.ok(joined(d).includes(t('en', 'hostPatched')))
})

await caseRun('02-persisted-enter-no-rewrite', async () => {
  const io = new ScriptIO(['', '', '', 'n']), d = makeDeps({ loaded: 'zh', probes: VERIFIED })
  assert.equal(await runWizard(io, d.deps), 0)
  assert.deepEqual(d.saved, [], 'Enter on a persisted preference must not rewrite it')
  assert.ok(joined(d).includes(t('zh', 'nothingSelected')))
})

await caseRun('03-first-run-enter-adopts', async () => {
  const io = new ScriptIO(['', '', '', 'n']), d = makeDeps({ loaded: null, detected: 'en', probes: VERIFIED })
  assert.equal(await runWizard(io, d.deps), 0)
  assert.deepEqual(d.saved, ['en'], 'confirming the detected default on first run must persist it')
  assert.ok(joined(d).includes(t('en', 'prefSavedNote')))
})

await caseRun('04-invalid-then-valid-choice', async () => {
  const io = new ScriptIO(['x', '3', '', '', 'n']), d = makeDeps({ probes: VERIFIED })
  assert.equal(await runWizard(io, d.deps), 0)
  assert.ok(joined(d).includes(t('en', 'invalidChoice')))
  assert.ok(joined(d).includes(t('zh-hant', 'nothingSelected')))
})

await caseRun('05-invalid-3x-safe-cancel', async () => {
  const io = new ScriptIO(['x', 'x', 'x']), d = makeDeps()
  assert.equal(await runWizard(io, d.deps), 0)
  assert.ok(joined(d).includes(t('en', 'cancelled')))
  assert.equal(io.prompts.length, 3)
})

await caseRun('06-eof-at-language-cancels', async () => {
  const io = new ScriptIO([]), d = makeDeps()
  assert.equal(await runWizard(io, d.deps), 0)
  assert.ok(joined(d).includes(t('en', 'cancelled')))
})

await caseRun('07-eof-at-plugin-question-cancels', async () => {
  const io = new ScriptIO(['', '', '']), d = makeDeps()
  assert.equal(await runWizard(io, d.deps), 0)
  assert.ok(joined(d).includes(t('en', 'cancelled')))
  assert.deepEqual(d.probeCalls, [[DEFAULT_APP, PT_DEFAULT]], 'probe runs on the confirmed paths')
  assert.equal(d.spawns.length, 0)
})

await caseRun('08-eof-at-final-confirm-cancels', async () => {
  const io = new ScriptIO(['', '', '', 'y', 'n']), d = makeDeps()
  assert.equal(await runWizard(io, d.deps), 0)
  assert.equal(d.spawns.length, 1, 'dry-run only; EOF at the confirm cancels before apply')
  assert.ok(joined(d).includes(t('en', 'cancelled')))
})

await caseRun('09-plugin-only-dry-decline', async () => {
  const io = new ScriptIO(['', '', '', 'y', 'n', 'n']), d = makeDeps()
  assert.equal(await runWizard(io, d.deps), 0)
  assert.equal(d.spawns.length, 1)
  const args = d.spawns[0].join(' ')
  assert.ok(args.includes('--components=plugin') && !args.includes('--apply'))
  assert.ok(args.includes('--app=' + DEFAULT_APP) && args.includes('--plugin-target=' + PT_DEFAULT))
  assert.ok(io.prompts[1].startsWith(t('en', 'appPathPrompt').split('{0}')[0]), 'paths are asked before the plugin question')
  assert.ok(io.prompts[3].startsWith(t('en', 'askPlugin')), '…and the component question comes after both paths')
  assert.ok(joined(d).includes(t('en', 'cancelled')))
})

await caseRun('10-host-only-dry-decline', async () => {
  const io = new ScriptIO(['', '', '', 'n', 'y', 'n']), d = makeDeps()
  assert.equal(await runWizard(io, d.deps), 0)
  assert.equal(d.spawns.length, 1)
  assert.ok(d.spawns[0].join(' ').includes('--components=host'), 'host-only selection maps to components=host')
  assert.ok(!d.spawns[0].join(' ').includes('--components=plugin'))
})

await caseRun('11-none-under-unpatched-host', async () => {
  const io = new ScriptIO(['', '', '', 'n', 'n']), d = makeDeps()
  assert.equal(await runWizard(io, d.deps), 0)
  assert.ok(joined(d).includes(t('en', 'nothingSelected')))
  assert.equal(d.spawns.length, 0)
})

await caseRun('12-host-verified-skips-question', async () => {
  const io = new ScriptIO(['', '', '', 'y', 'n']), d = makeDeps({ probes: VERIFIED })
  assert.equal(await runWizard(io, d.deps), 0)
  assert.ok(joined(d).includes(t('en', 'hostVerifiedNoChange')))
  assert.ok(!io.prompts.some(p => p.startsWith(t('en', 'askHost'))))
  assert.ok(d.spawns[0].join(' ').includes('--components=plugin'))
})

await caseRun('13-host-unknown-plugin-only', async () => {
  const io = new ScriptIO(['', '', '', 'y', 'n']), d = makeDeps({ probes: { plugin: { state: 'absent' }, host: { state: 'unknown' } } })
  assert.equal(await runWizard(io, d.deps), 0)
  assert.ok(joined(d).includes(t('en', 'hostUnknown')))
  assert.ok(joined(d).includes(t('en', 'unknownHostNote')))
  assert.ok(!io.prompts.some(p => p.startsWith(t('en', 'askHost'))))
})

await caseRun('14-host-no-app-label-and-plugin-only', async () => {
  const io = new ScriptIO(['', '', '', 'y', 'n']), d = makeDeps({ probes: { plugin: { state: 'absent' }, host: { state: 'no-app' } } })
  assert.equal(await runWizard(io, d.deps), 0)
  assert.ok(joined(d).includes(t('en', 'hostNoApp').replace('{0}', 'no-app')), 'raw state is shown for diagnostics')
  assert.ok(joined(d).includes(t('en', 'unknownHostNote')))
  assert.ok(d.spawns[0].join(' ').includes('--components=plugin'))
})

await caseRun('15-plugin-foreign-label', async () => {
  const io = new ScriptIO(['', '', '', 'n']), d = makeDeps({ probes: { plugin: { state: 'foreign', dir: '/x/plugins/hermes-style-plugin' }, host: { state: 'patched-verified' } } })
  assert.equal(await runWizard(io, d.deps), 0)
  assert.ok(joined(d).includes(t('en', 'pluginForeign').replace('{0}', '/x/plugins/hermes-style-plugin')))
})

await caseRun('16-custom-paths-reach-probe-and-spawn', async () => {
  const io = new ScriptIO(['', '/tmp/fake.app', '/tmp/fake-pt', 'y', 'n', '', '', 'n']), d = makeDeps()
  assert.equal(await runWizard(io, d.deps), 0)
  assert.deepEqual(d.probeCalls, [['/tmp/fake.app', '/tmp/fake-pt']], 'status is read for the CHOSEN paths')
  assert.ok(d.spawns[0].join(' ').includes('--app=/tmp/fake.app') && d.spawns[0].join(' ').includes('--plugin-target=/tmp/fake-pt'))
})

await caseRun('17-both-selected-applies', async () => {
  const io = new ScriptIO(['', '', '', 'y', 'y', 'y']), d = makeDeps()
  assert.equal(await runWizard(io, d.deps), 0)
  assert.equal(d.spawns.length, 2)
  assert.ok(d.spawns[0].join(' ').includes('--components=host,plugin') && !d.spawns[0].join(' ').includes('--apply'))
  assert.ok(d.spawns[1].join(' ').includes('--apply') && d.spawns[1].join(' ').includes('--components=host,plugin'))
  assert.ok(joined(d).includes(t('en', 'applyNotes')), 'host selection prints the backup/seal/update notes before the confirm')
  assert.ok(joined(d).includes(t('en', 'complete')))
  assert.ok(joined(d).includes(t('en', 'reportSaved').replace('{0}', '/x/setup-latest.json')))
})

await caseRun('18-apply-report-not-fresh-no-claim', async () => {
  const io = new ScriptIO(['', '', '', 'y', 'n', 'y']), d = makeDeps({ reportFresh: async () => false })
  assert.equal(await runWizard(io, d.deps), 0)
  assert.ok(!joined(d).includes('reportSaved'), 'no "report saved" claim when this run did not refresh it')
  assert.ok(!joined(d).includes(t('en', 'reportSaved').split(':')[0]))
})

await caseRun('19-plan-refused-exit-1', async () => {
  const d = makeDeps({ planResult: { status: 1, stdout: '[refuse] preflight failed — NOTHING was written' } })
  const io = new ScriptIO(['', '', '', 'y', 'n', ''])
  assert.equal(await runWizard(io, d.deps), 1)
  assert.ok(joined(d).includes(t('en', 'failed')))
  assert.equal(io.prompts.length, 5, 'no confirm prompt after a refused plan')
})

await caseRun('20-plan-stderr-only-refusal', async () => {
  const d = makeDeps({ planResult: { status: 1, stdout: '', stderr: '[refuse] app is running — refused' } })
  const io = new ScriptIO(['', '', '', 'y', 'n', ''])
  assert.equal(await runWizard(io, d.deps), 1)
  assert.ok(joined(d).includes('[refuse] app is running'), 'stderr is surfaced, not swallowed')
  assert.ok(joined(d).includes(t('en', 'failed')))
})

await caseRun('21-plan-spawn-error', async () => {
  const d = makeDeps({ planResult: { error: new Error('spawn ENOENT'), status: null } })
  const io = new ScriptIO(['', '', '', 'y', 'n', ''])
  assert.equal(await runWizard(io, d.deps), 1)
  assert.ok(joined(d).includes('[error] spawn ENOENT'))
  assert.ok(joined(d).includes(t('en', 'failed')))
})

await caseRun('22-apply-failure-exit-1', async () => {
  const d = makeDeps({ applyResult: { status: 1, stdout: '[error] boom', stderr: 'detail' } })
  const io = new ScriptIO(['', '', '', 'y', 'n', 'y'])
  assert.equal(await runWizard(io, d.deps), 1)
  assert.ok(joined(d).includes('[error] boom') && joined(d).includes('detail'))
  assert.ok(joined(d).includes(t('en', 'failed')))
})

await caseRun('23-save-failure-warns-not-blocks', async () => {
  const io = new ScriptIO(['2', '', '', 'n']), d = makeDeps({ probes: VERIFIED })
  d.deps.saveLocale = async () => { throw new Error('EACCES') }
  assert.equal(await runWizard(io, d.deps), 0)
  assert.ok(joined(d).includes(t('zh', 'prefSaveFailed').replace('{0}', 'EACCES')), 'save failure warns')
  assert.ok(joined(d).includes(t('zh', 'nothingSelected')), '…and the flow continues in the chosen language')
})

await caseRun('24-yn-invalid-3x-degrades-no', async () => {
  const io = new ScriptIO(['', '', '', 'x', 'x', 'x']), d = makeDeps({ probes: VERIFIED })
  assert.equal(await runWizard(io, d.deps), 0)
  assert.equal(io.prompts.length, 6, 'lang + app + pt + 3 invalid answers')
  assert.ok(joined(d).includes(t('en', 'nothingSelected')))
})

await caseRun('25-nine-locales-full-flow', async () => {
  for (const l of LOCALES) {
    const d = makeDeps({ loaded: l.id, probes: VERIFIED })
    const io = new ScriptIO(['', '', '', 'y', 'n'])
    assert.equal(await runWizard(io, d.deps), 0, l.id)
    assert.equal(io.prompts[3], t(l.id, 'askPlugin') + ' ', `${l.id}: localized plugin question`)
    assert.ok(joined(d).includes(t(l.id, 'cancelled')), `${l.id}: localized cancel note`)
    assert.ok(d.spawns[0].join(' ').includes('--components=plugin'), `${l.id}: preview still runs`)
  }
})

await caseRun('26-ask-adapter-unit', async () => {
  const input = new PassThrough(), output = new PassThrough()
  const io = makeAskAdapter(input, output)
  input.write('queued\n')                                    // (a) queued line answered on ask
  assert.equal(await io.ask('p1: '), 'queued')
  const p2 = io.ask('p2: ')                                   // (b) pending resolved by a later line
  await new Promise(r => setImmediate(r))
  input.write('late\n')
  assert.equal(await p2, 'late')
  const p3 = io.ask('p3: ')                                   // (c) close settles pending with null
  await new Promise(r => setImmediate(r))
  input.end()
  assert.equal(await p3, null)
  assert.equal(await io.ask('p4: '), null)                    // (d) ask after close → null
  io.close()
})

await caseRun('27-corrupt-pref-safely-ignored', async () => {
  const pref = path.join(root, '.local', 'setup-language.json')
  await mkdir(path.dirname(pref), { recursive: true })
  await writeFile(pref, '{ this is not json !!!', 'utf8')
  try { assert.equal(await loadSavedLocale(), null, 'a corrupt preference file must read back null') }
  finally { await rm(pref, { force: true }) }
})

// --- REAL-fixture integrations: real setup.mjs subprocess, isolated plugin
// target, components=plugin (never invokes the host tool — the working app is
// only ever probed read-only). ---
const intDeps = tmp => {
  const d = { out: [], saved: [], spawns: [] }
  d.deps = {
    out: l => d.out.push(l),
    loadSavedLocale: async () => 'en',
    saveLocale: async () => {},
    detectLocale: () => 'en',
    t,
    spawnSetup: args => { d.spawns.push(args); return spawnSync(process.execPath, [path.join(root, 'scripts', 'setup.mjs'), ...args], { encoding: 'utf8' }) },
    reportPath: path.join(root, '.local', 'setup-latest.json'),
  }
  d.tmp = tmp
  return d
}

await caseRun('28-real-preview-decline-no-write', async () => {
  const tmp = await mkdtemp(path.join(root, '.local', 'tmp', 'wiz-a-'))
  try {
    const d = intDeps(tmp)
    const io = new ScriptIO(['', '', tmp, 'y', 'n'])   // lang / app default / custom pt / plugin yes / confirm NO
    const code = await runWizard(io, d.deps)
    assert.equal(code, 0)
    assert.equal(d.spawns.length, 1, 'dry-run only')
    assert.ok(d.spawns[0].join(' ').includes(`--plugin-target=${tmp}`) && !d.spawns[0].includes('--apply'))
    const dir = path.join(tmp, 'hermes-style-plugin')
    const st = await (await import('node:fs/promises')).stat(dir).catch(() => null)
    assert.equal(st, null, 'declined preview must leave the isolated target untouched')
  } finally { await rm(tmp, { recursive: true, force: true }) }
})

await caseRun('29-real-full-execute-isolated-target', async () => {
  const tmp = await mkdtemp(path.join(root, '.local', 'tmp', 'wiz-b-'))
  try {
    const d = intDeps(tmp)
    const io = new ScriptIO(['', '', tmp, 'y', 'y'])   // confirm YES
    const code = await runWizard(io, d.deps)
    assert.equal(code, 0)
    assert.equal(d.spawns.length, 2, 'dry-run then apply')
    assert.ok(d.spawns[1].includes('--apply'))
    const info = JSON.parse(await readFile(path.join(tmp, 'hermes-style-plugin', 'build-info.json'), 'utf8'))
    assert.equal(info.version, '0.1.0-alpha.2')
    assert.ok(joined(d).includes(t('en', 'pluginOnlyDone')))
  } finally { await rm(tmp, { recursive: true, force: true }) }
})

await writeFile(path.join(root, '.local', 'setup-wizard-check-latest.json'), JSON.stringify({ at: new Date().toISOString(), total: results.length, failed, results }, null, 2) + '\n')
console.log(`\n${results.length - failed}/${results.length} cases passed (report: .local/setup-wizard-check-latest.json)`)
process.exit(failed ? 1 : 0)
