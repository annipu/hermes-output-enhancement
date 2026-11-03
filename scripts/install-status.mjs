// Shared READ-ONLY install-status probe: host-patch and plugin facts.
// Safe against the LIVE working app: reads only — never locks, never writes,
// never touches manifests or backups. "Patched" is concluded ONLY from the
// registered recipe table via the FULL chunk sha256 — never from markers,
// substring hits or install records. A build whose anchor chunk does not
// match a registered recipe is reported 'unknown' on purpose: refusing to
// guess is the safety property (an app update or a tampered file both land
// there and are never reported as patched or supported).
//
// Host recipes (full-hash indexed; several builds may coexist — new recipes
// are appended only after their own derivation + isolated A/B verification):
//   - 2026-11-02 stock build: the build the single-file window-sync patch was
//     derived on and A/B-verified (baseline 10/11 -> patched 12/12, rollback
//     byte-exact, signature seal restored).
//   - 2026-11-03 stock build: re-derived for the 2026-11-03 self-update and
//     A/B-verified the same way (baseline 10/11 -> patched 12/12, rollback
//     byte-exact, signature seal restored).
import { readFile, readdir, lstat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const KEY = 'hermes.desktop.pluginDecisions.v2'
export const HOST_RECIPES = [
  {
    label: 'stock 2026-11-02 build (sourceHash 735d8be3…)',
    chunkName: 'layout-lXjPuTgt.js',
    preSha256: '2c2f82c100c6fa51090bc5b7d04787479db26d723202b91bb3ed72c94fc4771e',
    postSha256: '5d47e594ed96dbe5679680ce94930a0b2933d63b8420ac139da04a229f46b125',
  },
  {
    label: 'stock 2026-11-03 build (sourceHash c6807894…)',
    chunkName: 'layout-CSIx4R7D.js',
    preSha256: 'fd49bb08d1ad742350813504fbc75d75a94e9bb6b80a8c9b38ac67136b2a2c20',
    postSha256: '8ad8215687ed76f589f5d54a7b12028b2857941cb955d1d4c4df3bc32384753b',
  },
]
export const DEFAULT_APP = path.join(os.homedir(), '.hermes/hermes-agent/apps/desktop/release/mac-arm64/Hermes.app')
const sha = data => createHash('sha256').update(data).digest('hex')

// Host states:
//   no-app                the app bundle (or its assets dir) is not there
//   unreadable            exists but cannot be read
//   unknown               no unique anchor-chunk hit, or the chunk hash matches
//                         no registered recipe (new build OR modified content)
//   ambiguous             more than one file carries the anchor key
//   unpatched-supported   chunk hash == a recipe's ORIGINAL (pre) hash
//   patched-verified      chunk hash == a recipe's PATCHED (post) hash
// recovery is reported SEPARATELY from patch state (aux-backup facts only).
export async function probeHost(appPath) {
  const app = appPath ?? DEFAULT_APP
  const out = { app, state: 'no-app', sourceHash: null, chunk: null, recipe: null, recovery: 'none' }
  const distDir = path.join(app, 'Contents/Resources/app.asar.unpacked/dist')
  try { out.sourceHash = JSON.parse(await readFile(path.join(distDir, 'hermes-build.json'), 'utf8'))?.inputs?.sourceHash ?? null } catch {}
  const assetsDir = path.join(distDir, 'assets')
  let entries
  try { entries = await readdir(assetsDir) } catch {
    if (await lstat(app).catch(() => null)) out.state = 'unreadable'
    return out
  }
  const keyBuf = Buffer.from(KEY)
  const hits = []
  for (const name of entries) {
    if (!name.endsWith('.js')) continue
    const full = path.join(assetsDir, name)
    const st = await lstat(full).catch(() => null)
    if (!st?.isFile()) continue
    const buf = await readFile(full).catch(() => null)
    if (!buf || !buf.includes(keyBuf)) continue
    hits.push({ name, sha256: sha(buf) })
  }
  if (hits.length !== 1) { out.state = hits.length === 0 ? 'unknown' : 'ambiguous'; return out }
  out.chunk = hits[0]
  const recipe = HOST_RECIPES.find(r => hits[0].sha256 === r.preSha256 || hits[0].sha256 === r.postSha256)
  if (!recipe) { out.state = 'unknown'; return out }
  out.recipe = { label: recipe.label, role: hits[0].sha256 === recipe.postSha256 ? 'patched' : 'original' }
  out.state = out.recipe.role === 'patched' ? 'patched-verified' : 'unpatched-supported'
  const bak = await readFile(path.join(assetsDir, hits[0].name + '.v2bak')).catch(() => null)
  out.recovery = bak ? (sha(bak) === recipe.preSha256 ? 'aux-backup-verified' : 'aux-backup-mismatch') : 'none'
  return out
}

// Plugin facts only (no source comparison — callers combine with their source).
export async function probePlugin(targetBase) {
  const base = targetBase ?? path.join(os.homedir(), '.hermes', 'desktop-plugins')
  const dir = path.join(base, 'hermes-style-plugin')
  const st = await lstat(dir).catch(() => null)
  if (!st) return { dir, state: 'absent' }
  if (!st.isDirectory() || st.isSymbolicLink()) return { dir, state: 'foreign' }
  const files = (await readdir(dir)).sort()
  let info = null
  try { info = JSON.parse(await readFile(path.join(dir, 'build-info.json'), 'utf8')) } catch {}
  let pluginSha256 = null
  try { pluginSha256 = sha(await readFile(path.join(dir, 'plugin.js'))) } catch {}
  return { dir, state: 'present', files, id: info?.id ?? null, version: info?.version ?? null, pluginSha256 }
}

// CLI: node scripts/install-status.mjs [--app=<Hermes.app>] [--plugin-target=<dir>]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opt = name => { const hit = process.argv.slice(2).findLast(a => a.startsWith(`--${name}=`)); return hit ? hit.slice(name.length + 3) : null }
  const host = await probeHost(opt('app'))
  const plugin = await probePlugin(opt('plugin-target'))
  console.log(JSON.stringify({ plugin, host }, null, 2))
  console.log(`[status] plugin: ${plugin.state}${plugin.version ? ` v${plugin.version} (${plugin.pluginSha256 ? plugin.pluginSha256.slice(0, 8) : 'plugin.js unreadable'}…)` : ''}`)
  console.log(`[status] host  : ${host.state}${host.recipe ? ` — ${host.recipe.label}, ${host.recipe.role}` : ''}${host.recovery !== 'none' ? `, recovery: ${host.recovery}` : ''}${host.sourceHash ? ` (build ${String(host.sourceHash).slice(0, 8)}…)` : ''}`)
}
