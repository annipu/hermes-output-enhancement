# hermes-plugin-contentstyle

Style-only content presentation plugin for [Hermes Desktop](https://hermes-agent.nousresearch.com/docs). It adjusts how **existing** Markdown renders in assistant replies — headings, bold text, inline code and tables — and nothing else.

> Unofficial community plugin. Not affiliated with or endorsed by Nous Research.

## The guarantee: display only

- Enabling injects exactly one `<style>` element into the page; disabling or uninstalling removes it. That is the plugin's entire runtime footprint.
- Reply content is never modified: no rewriting, summarizing, adding, deleting or reordering. Heading levels, list order, code content and whitespace, link text and targets, and table row/column counts, headers and cell values stay exactly as the model produced them.
- No model or gateway calls, no session reads, no writes to SOUL, profiles, memory or conversation history.

## Current status — alpha

- Version `0.1.0-alpha.1`, **off by default**; opt in via the app's own plugin toggle.
- Native verification on one stock macOS arm64 build (Electron 44.9.3 / Chromium 152.0.7977.167 / Node 24.22.0): **10 of 11 checks passed**.
- Known limitation on stock builds: toggling the plugin does **not** sync to other already-open windows until the app is restarted. This is Hermes host behavior (`plugins-store.ts` persists the decision but applies it only in the toggling window), not something this plugin can fix from inside the plugin sandbox.
- A host-side fix for that limitation has been developed and verified in a project-local patched Hermes build: **12 of 12 native checks passed** there, including bidirectional live sync between two real windows, rapid toggles, re-enable after disable, restart, uninstall and full content fidelity (identical plugin bytes). It requires a Hermes host change, is **not** part of this repository, and stock Hermes builds keep the limitation until they include such a fix.
- Interaction coverage on the patched build passed a further 17 native checks: the code-block `Copy code` button's clipboard output is byte-identical to the fixture contract in every light/dark × on/off combination, a real column-drag resize keeps all five columns and every cell, external links hand off with the exact href (intercepted, no outbound request), and dark mode — switched via the app's own palette command — preserves content structure. The native UI offers no separate table-copy button (the whole-reply Copy covers tables). Windows and Linux remain untested.
- Hermes's plugin static scan reports 0 rejections and 1 `app markup selector` review notice.

## What changes visually

Within assistant replies only — ordinary paragraphs, user messages and app chrome are untouched:

- Headings and bold text: accent color and weight, so already-marked emphasis stands out.
- Inline code: tinted background, border and padding.
- Tables: distinct header row, full grid, roomier cells, and a smarter first-column width for two-column tables. All data is preserved; wide tables scroll instead of being crushed.

Colors follow the active theme's light/dark variants.

## Build

Requires Node.js 22+. No npm dependencies.

```sh
npm run build
```

This generates `plugin/hermes-style-plugin/plugin.js` (plus `build-info.json`) from `styles/p1-candidate.css`. The stylesheet is the source of truth; edit it, not the generated file.

## Install

1. Run the build above.
2. Copy the generated directory so the plugin lives at:

   ```text
   <application-level Hermes home>/desktop-plugins/hermes-style-plugin/plugin.js
   ```

   `desktop-plugins` is the application-level directory shared across agent profiles — not a per-profile directory. Keep the folder name `hermes-style-plugin`; it matches the plugin id.
3. The app watches this directory. The plugin then appears in the app's plugin list (Settings → Capabilities → Plugins, also reachable via the command palette), disabled by default. Enable it with its toggle; disable it the same way; Uninstall on the plugin's detail page removes the directory.

The natively tested candidate shipped `plugin.js`, a `README.md` and `build-info.json` in that directory; the loader consumes `plugin.js`. Building from this repository generates `plugin.js` and `build-info.json`; the `files` list inside `build-info.json` describes the packaged candidate's three-file layout, not the output of a local build.

## Compatibility

The stylesheet targets the app's current DOM structure and may need adjusting after Hermes updates. Only the build listed under *Current status* has been native-tested; treat other versions as unverified.

This repository contains source only — generated files under `plugin/` are built locally and not committed.

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 ANNIPU.
