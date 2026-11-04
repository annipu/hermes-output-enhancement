# hermes-plugin-contentstyle

Style-only content presentation plugin for [Hermes Desktop](https://hermes-agent.nousresearch.com/docs). It adjusts how **existing** Markdown renders in assistant replies — headings, bold and italic emphasis and tables — and nothing else.

> Unofficial community plugin. Not affiliated with or endorsed by Nous Research.

## The guarantee: display only

- Enabling injects exactly one `<style>` element into the page; disabling or uninstalling removes it. That is the plugin's entire runtime footprint.
- Reply content is never modified: no rewriting, summarizing, adding, deleting or reordering. Heading levels, list order, code content and whitespace, link text and targets, and table row/column counts, headers and cell values stay exactly as the model produced them.
- No model or gateway calls, no session reads, no writes to SOUL, profiles, memory or conversation history.

## Current status

- Version `0.1.2`, **off by default**; opt in via the app's own plugin toggle.
- v0.1.2 color scheme: component-level 29/29 checks and an isolated native four-quadrant run (light/dark × on/off, 22/22 checks) verified headings/bold/italic coloring with inline code, font weights, list markers, alerts, link colors and strikethrough kept native.
- The repository ships this exact verified build as a pre-built, installable distribution directory (`plugin/hermes-style-plugin/`) — see *Install*; no build step is needed.
- Native verification on one stock macOS arm64 build (Electron 44.9.3 / Chromium 152.0.7977.167 / Node 24.22.0): **10 of 11 checks passed**.
- Known limitation on stock builds: toggling the plugin does **not** sync to other already-open windows until the app is restarted. This is Hermes host behavior (`plugins-store.ts` persists the decision but applies it only in the toggling window), not something this plugin can fix from inside the plugin sandbox.
- A host-side fix for that limitation has been developed and verified in a patched Hermes build: **12 of 12 native checks passed** there, including bidirectional live sync between two real windows, rapid toggles, re-enable after disable, restart, uninstall and full content fidelity (identical plugin bytes). The patch ships in this repository under [`host-patch/`](host-patch/) with usage notes (generated against a pinned Hermes source revision; ANNIPU-maintained, not submitted upstream). Stock Hermes builds keep the limitation until they include such a fix.
- The patch was re-derived for Hermes's 2026-11-03 self-update build and A/B-verified the same way on a frozen copy of that build (baseline 10/11 → patched 12/12, rollback byte-exact, signature seal restored). Both builds are registered in the recipe table inside `scripts/install-status.mjs`.
- Interaction coverage on the patched build: the code-block `Copy code` button's clipboard output is byte-identical to the fixture contract in every light/dark × on/off combination, a real column-drag resize keeps all five columns and every cell in both plugin states (the drag state persists across reloads), and dark mode — switched via the app's own palette command — preserves content structure. Link handling is covered by a dedicated fixture of explicit fake `.invalid` URLs: a real click is handled by the app's own browsing layer (a managed-browser consent dialog on the first click per session; subsequent clicks open the app's internal browser pane), and declining the dialog leaves the page and link structure unchanged (verified with the style on and off; the dialog's re-appearance timing is Hermes host behavior). An earlier revision of this paragraph claimed an intercepted external handoff with the exact href — that claim was wrong (the original fixture contained no links) and is retracted. The native UI offers no separate table-copy button (the whole-reply Copy covers tables). Windows and Linux remain untested.
- Hermes's plugin static scan reports 0 rejections and 1 `app markup selector` review notice.

## What changes visually

Within assistant replies only — ordinary paragraphs, user messages and app chrome are untouched:

- Headings H1–H6: violet accent in both themes — deep `#704098` on light, `#9d7cd8` on dark; same violet family, adjusted for each theme.
- Bold: orange accent (`#d68c27` light / `#f5a742` dark). Italic: gold (`#b0851f` light / `#e5c07b` dark). Font weights stay native — nothing is forced bolder.
- Inline code: left fully native (the tinted-chip styling of earlier alphas was removed in v0.1.2).
- Tables: layout enhancements kept — distinct header row, full grid, roomier cells, smarter first-column width for two-column tables — with header text back to its native muted tone. All data is preserved; wide tables scroll instead of being crushed.
- Exclusions: alerts/callouts, code blocks, list markers, strikethrough and link colors stay native in every tested state; emphasis nested inside a link follows the emphasis color (visible in the snapshots below).

Colors follow the active theme's light/dark variants.

## Snapshots (v0.1.2)

Same-content four-quadrant comparisons captured from the real desktop app in an isolated native run (plugin bytes `65c3fdfa…`). Each row is one theme × plugin state; columns are the Chinese and English fixture runs.

| Theme × state | zh-CN | English |
|---|---|---|
| Light / off | ![zh-CN light off](snapshots/0.1.2/zh-CN-light-off.png) | ![en light off](snapshots/0.1.2/en-light-off.png) |
| Light / on | ![zh-CN light on](snapshots/0.1.2/zh-CN-light-on.png) | ![en light on](snapshots/0.1.2/en-light-on.png) |
| Dark / on | ![zh-CN dark on](snapshots/0.1.2/zh-CN-dark-on.png) | ![en dark on](snapshots/0.1.2/en-dark-on.png) |
| Dark / off | ![zh-CN dark off](snapshots/0.1.2/zh-CN-dark-off.png) | ![en dark off](snapshots/0.1.2/en-dark-off.png) |

## Build (only if you change the stylesheet)

Requires Node.js 22+. No npm dependencies.

```sh
npm run build
```

This regenerates `plugin/hermes-style-plugin/plugin.js` and `build-info.json`
from `styles/p1-candidate.css`. The stylesheet is the source of truth; edit it,
not the generated file. The committed `plugin/` files are the pre-built
distribution (see *Install*) — most users never need this step.

## Install

No build is needed: the repository ships the natively tested plugin as a
pre-built distribution directory, `plugin/hermes-style-plugin/`. From a
checkout of this repository (or its "Download ZIP"):

```bash
node scripts/plugin-install.mjs            # dry-run: prints the plan only
node scripts/plugin-install.mjs --apply    # install / upgrade
node scripts/plugin-install.mjs uninstall --apply
```

Requires Node.js 22+. The installer is a plain Node script with no npm
dependencies — there is no `npm install` step. Note that GitHub's
"Download ZIP" downloads the whole repository; extract it and run from the
repository root. There is no separate binary release attachment at the moment.

The installer also checks the OTHER half of a complete installation — the
host-side window-sync patch — and reports its state read-only (safe while
the app is running; see `scripts/install-status.mjs`, which can also be run
standalone). Exit codes: `0` — action complete and, for installs, host patch
verified (or `--plugin-only` was explicit); `1` — refused / error; `3` — the
plugin is in place but the host patch is missing or unverified for your
Hermes build. `3` is not a plugin failure: the style plugin works, what is
missing is live cross-window sync of the on/off toggle. To accept
plugin-only explicitly: `node scripts/plugin-install.mjs --apply --plugin-only`.
Host states you may see: `unpatched-supported` (your build is a registered
patch target and the patch is not applied), `patched-verified` (full-file
hash match against the registered recipe — never inferred from markers or
install records), `unknown` (a build/patch combination that has not been
verified, e.g. after a Hermes update), `no-app`. Plugin uninstall stays
independent of the host state.

### Unified setup entry (interactive wizard + flags)

`scripts/setup.mjs` orchestrates host patch + plugin install as one
all-or-nothing transaction. Run it with no arguments in a real terminal for
the **interactive wizard**:

```bash
node scripts/setup.mjs        # no arguments + a terminal → wizard
```

- **Language first**: a nine-language menu (English, 简体中文, 繁體中文, 日本語,
  العربية, Русский, Français, Deutsch, Español) appears on every run; Enter
  keeps the remembered preference, and the first confirmed choice is saved
  inside this checkout. Questions and safety notes are localized; the plan
  preview prints the underlying tools' diagnostic output as-is.
- **Paths before status**: you confirm the app path and plugin target (with
  defaults) first, so the status shown and the questions asked always refer to
  those paths.
- **All four combinations**: plugin only, host patch only, both, or nothing.
  A `patched-verified` host shows "no change needed" and is never re-asked;
  an unknown or missing host offers plugin-only.
- **Nothing silent**: the plan is previewed as a dry-run first. Selecting the
  host patch prints the safety notes before the final confirmation — triple
  backup before writing, the code-signature seal is invalid until rollback
  (rollback is byte-exact and verified), and a future Hermes self-update
  overwrites the patch. The final confirmation defaults to **No**; EOF
  (Ctrl-D) and Ctrl-C cancel safely at any prompt. Before that confirmation
  your Hermes app and plugin files are never modified — only the language
  preference and diagnostic reports are stored inside this checkout.

Flag mode keeps the full contract for non-interactive contexts: it requires
an explicit `--app=<Hermes.app>` (a no-argument run without a TTY is a usage
error, never a wait), dry-runs first, and if either half refuses (unknown
host build, foreign plugin target, process guards…) nothing is written.
`--components=plugin|host|plugin,host` scopes the run; the unselected half is
still reported read-only. A unified report is saved to
`.local/setup-latest.json`, and a failed plugin step rolls back only a host
patch applied by the same transaction (a pre-existing patch is never
touched). `--uninstall` removes only the plugin; add `--with-host-patch` to
also revert the patch. Two defaults apply: the plugin target defaults to a
`.local` test directory in flag mode (pass `--plugin-target=` for a real
location), and the host half (`scripts/host-binary-patch.mjs`) is write-gated
by an explicit `--production` flag — dry-run is the read-only default on any
app copy (the target app must not be running); full-file SHA-256 pinned
recipes, transactional write, triple backup (in-app `.v2bak` + external
original + manifest) and byte-exact rollback. Visitors wanting the host fix
should use the source patch route under [`host-patch/`](host-patch/) instead.

The verification matrices are published for transparency:
`scripts/host-binary-patch-check.mjs` (36 cases) and `scripts/setup-check.mjs`
(16 cases) need project-internal frozen build fixtures under `.local/` and
are not expected to run in a fresh clone — they fail cleanly with a nonzero
exit instead. `scripts/setup-wizard-check.mjs` (29 cases — injectable-IO
unit matrix plus two real-fixture integrations against an isolated plugin
target; never writes the working app) creates its own `.local` scratch and
does run in a fresh clone (verified: `npm run setup:wizard:check` → 29/29).

Files in the distribution directory:

- `plugin.js` — the runtime entry the app's disk-plugin loader consumes; these are the exact bytes that passed native verification (SHA-256 `e3e921a533eb19e76de57928aafa520b17ca54ec263ddc7b5302ff7e39453d6e`, version `0.1.0-alpha.2`).
- `build-info.json` — version and integrity metadata (plugin/CSS SHA-256, file list).
- `README.md` — notes for the installed directory.

The installer is version-aware. Re-running it after a rebuild upgrades an older
install (backing the old directory up first), reports an identical install as a
no-op, and refuses to touch anything it cannot verify — unexpected files, a
foreign plugin id, a newer version — unless you pass `--force` (which still
backs the current directory up first). Only `plugin.js`, `build-info.json` and
(when present) `README.md` are ever copied: the copy is staged next to the
target, verified, then switched; a failed switch restores the previous
directory. Backups go to `.local/plugin-backups/` inside your checkout.

This places the plugin at the application-level directory shared across agent
profiles (default `<home>/.hermes/desktop-plugins/hermes-style-plugin/`; pass
`--target=` to override). Keep the folder name — it matches the plugin id. The
app watches this directory: the plugin appears in Settings → Capabilities →
Plugins, disabled by default. Enable/disable with its toggle; Uninstall on the
plugin's detail page removes the directory (or use the uninstall command above,
which backs it up first).

Manual alternative: copy the whole `plugin/hermes-style-plugin/` directory to
the location above yourself — those three files are all it takes (no npm
package, no separate CSS file or manifest). Installing the plugin does not
include the host-side multi-window fix: on stock Hermes builds the
window-sync limitation above remains; `host-patch/` is a separate,
version-gated component.

## Compatibility

The stylesheet targets the app's current DOM structure and may need adjusting after Hermes updates. Only the build listed under *Current status* has been native-tested; treat other versions as unverified.

The repository ships the pre-built distribution directory `plugin/hermes-style-plugin/` (the exact bytes that passed native verification). `npm run build` regenerates `plugin.js` and `build-info.json` from the stylesheet; a rebuilt `plugin.js` only counts as the tested candidate when its SHA-256 matches the shipped `pluginSha256`.

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 ANNIPU.
