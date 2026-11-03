// setup-wizard.mjs — interactive front-end for setup.mjs (thin prompt layer).
//
// Runs ONLY when setup.mjs is invoked with no arguments on a full TTY (stdin
// AND stdout); every real action is delegated back to setup.mjs's flag mode
// as a subprocess, so there is exactly one execution path and zero logic
// duplication. The wizard is a pure prompt layer with an injectable io, so
// tests drive it deterministically without a PTY.
//
// Review-agreed semantics:
//   - language: persisted preference and env-detected default are tracked
//     separately; confirming a language persists it (first adoption included,
//     Enter on an existing preference rewrites nothing). A failed preference
//     write warns and continues — it must never block an install.
//   - paths are confirmed BEFORE any status is read, so the states shown and
//     the patch offer always refer to the paths that will actually be used.
//   - EOF, Ctrl-C and an empty confirm answer all cancel safely; the final
//     confirm defaults to NO. Cancel wording is scoped: no app/plugin files
//     were changed (preferences and diagnostic reports live in this checkout).
//   - a verified host is shown "no change needed" and never re-asked; an
//     unknown/absent/unreadable host offers plugin-only.
//   - subprocess output (stdout AND stderr) is surfaced as marked diagnostic
//     text; launch failures exit nonzero; "report saved" is claimed only when
//     this run actually refreshed the report file.
//   - before the final confirm, applying the host patch prints the backup /
//     code-seal / self-update-override notes (reversibility is verified, the
//     quarantine+Gatekeeper scenario stays out of scope).
import os from 'node:os'
import path from 'node:path'
import { stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import readline from 'node:readline'
import { LOCALES, t, detectLocale, loadSavedLocale, saveLocale } from './setup-i18n.mjs'
import { probeHost, probePlugin, DEFAULT_APP } from './install-status.mjs'

export const MENU_TITLE = 'Language / 选择语言 / 選擇語言 / 言語 / اللغة / Язык / Langue / Sprache / Idioma'

const parseYn = a => {
  const v = (a ?? '').trim().toLowerCase()
  if (v === '') return false
  if (['y', 'yes'].includes(v)) return true
  if (['n', 'no'].includes(v)) return false
  return null
}

// Production io: wraps node:readline (events API). Lines that arrive while no
// question is pending are queued; 'close' (EOF / Ctrl-D) and 'SIGINT' (Ctrl-C)
// settle every pending waiter with null, which the wizard treats as a safe
// cancel. The pending-question rejection hole of readline/promises is closed
// by construction — no blanket .catch disguising program errors as cancels.
export function makeAskAdapter(input = process.stdin, output = process.stdout) {
  const rl = readline.createInterface({ input, output })
  const pending = []
  const queued = []
  let closed = false
  const settleAll = () => { closed = true; while (pending.length) pending.shift()(null) }
  rl.on('line', line => { if (pending.length) pending.shift()(line); else queued.push(line) })
  rl.on('close', () => settleAll())
  rl.on('SIGINT', () => settleAll()) // Ctrl-C cancels; the wizard prints the localized cancel note
  return {
    ask: prompt => {
      output.write(prompt)
      if (queued.length) return Promise.resolve(queued.shift())
      if (closed) return Promise.resolve(null)
      return new Promise(res => pending.push(res))
    },
    close: () => { rl.removeAllListeners(); rl.close() },
  }
}

// io: { ask(prompt) -> Promise<string | null> } — null means EOF / cancel.
// deps: everything else is injectable for deterministic tests.
export async function runWizard(io, deps = {}) {
  const startedAt = Date.now()
  const root = deps.root ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const out = deps.out ?? (l => process.stdout.write(l + '\n'))
  const T = deps.t ?? t
  const loadSaved = deps.loadSavedLocale ?? loadSavedLocale
  const save = deps.saveLocale ?? saveLocale
  const detect = deps.detectLocale ?? detectLocale
  const spawnSetup = deps.spawnSetup ?? (args => spawnSync(process.execPath, [path.join(root, 'scripts', 'setup.mjs'), ...args], { encoding: 'utf8' }))
  const reportPath = deps.reportPath ?? path.join(root, '.local', 'setup-latest.json')
  const probe = deps.probe ?? (async (app, pt) => ({ plugin: await probePlugin(pt), host: await probeHost(app) }))
  const reportFresh = deps.reportFresh ?? (async () => {
    const st = await stat(reportPath).catch(() => null)
    return !!st && st.mtimeMs >= startedAt
  })
  const cancel = async loc => { out(T(loc, 'cancelled')); return 0 }

  // --- 1) language menu (visible every run; Enter keeps the default) ---
  const persisted = await loadSaved()          // null = none / corrupt / unreadable
  const fallback = persisted ?? detect()       // env detection is only a default, never a stored choice
  out('')
  out(MENU_TITLE)
  LOCALES.forEach((l, i) => out(`  ${i + 1}. ${l.endonym}${l.id === fallback ? '  ←' : ''}`))
  let locale = null
  let attempts = 0
  while (locale === null) {
    const a = await io.ask('[1-9 / Enter=←] ')
    if (a === null) return cancel(fallback)
    const v = a.trim()
    if (v === '') locale = fallback
    else if (/^[1-9]$/.test(v)) locale = LOCALES[Number(v) - 1].id
    else { out(T(fallback, 'invalidChoice')); if (++attempts >= 3) return cancel(fallback) }
  }
  // Confirming the language persists it — first adoption included; rewriting
  // an unchanged persisted preference is pointless. Save failures are warnings.
  if (locale !== persisted) {
    try { await save(locale); out(T(locale, 'prefSavedNote')) }
    catch (err) { out(T(locale, 'prefSaveFailed', [String(err?.message ?? err)])) }
  }

  out('')
  out(T(locale, 'wizardIntro'))

  const askYn = async prompt => {
    for (let n = 0; ; ) {
      const a = await io.ask(prompt)
      if (a === null) return null
      const v = parseYn(a)
      if (v !== null) return v
      out(T(locale, 'invalidChoice'))
      if (++n >= 3) return false // persistent invalid input degrades to the safe default (No)
    }
  }
  const askDefault = async (prompt, dflt) => {
    const a = await io.ask(prompt)
    if (a === null) return null
    const v = a.trim()
    return v === '' ? dflt : v
  }

  // --- 2) target paths BEFORE any status read ---
  const app = await askDefault(T(locale, 'appPathPrompt', [DEFAULT_APP]), DEFAULT_APP)
  if (app === null) return cancel(locale)
  const ptDefault = path.join(os.homedir(), '.hermes', 'desktop-plugins')
  const pt = await askDefault(T(locale, 'pluginTargetPrompt', [ptDefault]), ptDefault)
  if (pt === null) return cancel(locale)

  // --- 3) read-only status of the CHOSEN paths (probes never write) ---
  const status = await probe(app, pt)
  out('')
  out(T(locale, 'currentStatus') + ':')
  out('  ' + (status.plugin.state === 'present'
    ? T(locale, 'pluginPresent', [status.plugin.version ?? status.plugin.pluginSha256?.slice(0, 8) ?? '?'])
    : status.plugin.state === 'foreign'
      ? T(locale, 'pluginForeign', [status.plugin.dir ?? pt])
      : T(locale, 'pluginAbsent')))
  const hostKey = { 'patched-verified': 'hostPatched', 'unpatched-supported': 'hostUnpatched', 'unknown': 'hostUnknown' }[status.host.state] ?? 'hostNoApp'
  out('  ' + (hostKey === 'hostNoApp' ? T(locale, 'hostNoApp', [status.host.state]) : T(locale, hostKey)))

  // --- 4) component selection (all four combinations) ---
  const sel = new Set()
  out('')
  const wantPlugin = await askYn(T(locale, 'askPlugin') + ' ')
  if (wantPlugin === null) return cancel(locale)
  if (wantPlugin) sel.add('plugin')
  if (status.host.state === 'patched-verified') {
    out(T(locale, 'hostVerifiedNoChange'))
  } else if (status.host.state === 'unpatched-supported') {
    const wantHost = await askYn(T(locale, 'askHost') + ' ')
    if (wantHost === null) return cancel(locale)
    if (wantHost) sel.add('host')
  } else {
    out(T(locale, 'unknownHostNote'))
  }
  if (sel.size === 0) { out(T(locale, 'nothingSelected')); return 0 }

  // --- 5) plan preview: dry-run of the FLAG mode; output is diagnostic ---
  const components = [...sel].sort().join(',')
  const args = ['--app=' + app, '--plugin-target=' + pt, '--components=' + components]
  out('')
  out(T(locale, 'planTitle'))
  out(T(locale, 'planDiagnostic'))
  const plan = spawnSetup(args)
  const planText = [plan.stdout, plan.stderr].filter(Boolean).join('\n').trim()
  for (const l of planText.split('\n')) out('  ' + l)
  if (plan.error) { out('[error] ' + (plan.error.message ?? plan.error)); out(T(locale, 'failed')); return 1 }
  if ((plan.status ?? 1) !== 0) { out(T(locale, 'failed')); return 1 }

  // --- 6) safety notes, then confirm — default NO ---
  if (sel.has('host')) out(T(locale, 'applyNotes'))
  const go = await askYn(T(locale, 'confirmProceed') + ' ')
  if (go === null || !go) return cancel(locale)

  // --- 7) execute (same subprocess, now with --apply) ---
  out(T(locale, 'proceeding'))
  const r = spawnSetup([...args, '--apply'])
  const runText = [r.stdout, r.stderr].filter(Boolean).join('\n').trim()
  for (const l of runText.split('\n')) out(l)
  if (await reportFresh()) out(T(locale, 'reportSaved', [reportPath]))
  if (r.error) { out('[error] ' + (r.error.message ?? r.error)); out(T(locale, 'failed')); return 1 }
  if ((r.status ?? 1) !== 0) { out(T(locale, 'failed')); return 1 }
  out(sel.has('host') ? T(locale, 'complete') : T(locale, 'pluginOnlyDone'))
  return 0
}
