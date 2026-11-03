# Hermes Style (alpha)

Version 0.1.0-alpha.1 — a display-only plugin for Hermes Desktop.

This directory is a complete, pre-built distribution. No npm packages, build
steps or backend components are involved:

- `plugin.js` — the runtime entry the app's disk-plugin loader consumes;
- `build-info.json` — version and integrity metadata (plugin/CSS SHA-256, file list);
- `README.md` — this file.

What it does: applies CSS to existing Markdown nodes in assistant replies
only (headings, bold text, inline code, tables). All text, order, table rows
and columns, code whitespace and link text/targets stay exactly as produced
by the model. Enabling adds exactly one `<style>` element to the page;
disabling removes it via `ctx.onDispose`. The plugin imports no SDK
messaging, gateway, configuration or storage APIs, performs no model or
network calls, and never writes to profiles, memory or conversation history.

Install from the repository root:

```bash
node scripts/plugin-install.mjs            # dry-run: prints the plan only
node scripts/plugin-install.mjs --apply    # install / upgrade
```

Manual alternative: copy this whole directory to
`<home>/.hermes/desktop-plugins/hermes-style-plugin/` — the folder name must
equal the plugin id. The plugin is off by default; enable it with the app's
own toggle under Settings → Capabilities → Plugins.

Boundaries: styling targets the app's current DOM structure and was
native-tested on one stock macOS arm64 build; treat other versions as
unverified. On stock Hermes builds, toggling the plugin does not sync live to
other already-open windows until the app is restarted (Hermes host behavior;
a host-side fix ships separately under `host-patch/` in the repository).
