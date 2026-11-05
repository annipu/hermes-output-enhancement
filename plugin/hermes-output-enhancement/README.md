# Hermes Output Enhancement (alpha)

Version 0.1.4 — a display-only plugin for Hermes Desktop.

This directory is a complete, pre-built distribution in the plugin-catalog
layout. No npm packages, build steps or backend components are involved:

- `desktop/plugin.js` — the runtime entrypoint the plugin loader consumes;
- `plugin.yaml` — the plugin manifest (id, version, `requires_hermes`);
- `build-info.json` — version and integrity metadata (plugin/CSS SHA-256, file list);
- `README.md` — this file.

What it does: applies CSS to existing Markdown nodes in assistant replies
only (headings, bold text, inline code, tables). All text, order, table rows
and columns, code whitespace and link text/targets stay exactly as produced
by the model. Enabling adds exactly one `<style>` element to the page;
disabling removes it via `ctx.onDispose`. The plugin imports no SDK
messaging, gateway, configuration or storage APIs, performs no model or
network calls, and never writes to profiles, memory or conversation history.

Install:

```bash
# once the plugin-catalog entry is merged (recommended)
hermes plugins install hermes-output-enhancement

# or manually: copy this whole directory to
# <home>/.hermes/desktop-plugins/hermes-output-enhancement/
```

The folder name must equal the plugin id. The plugin is off by default;
enable it with the app's own toggle under Settings → Capabilities → Plugins.

Boundaries: styling targets the app's current DOM structure and was
native-tested on stock macOS arm64 builds (Hermes 0.22.x line, most recently
0.22.6); treat other versions as unverified. On stock Hermes builds,
toggling the plugin does not sync live to other already-open windows until
the app is restarted — that is a host limitation tracked upstream at
https://github.com/NousResearch/hermes-agent/issues/149541. This plugin
contains no host patch and never modifies the Hermes application.
