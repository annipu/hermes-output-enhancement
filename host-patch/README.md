# Host patch: live cross-window plugin toggle sync

This is an optional patch for the **Hermes desktop host**. It is not part of the style
plugin and is not required to use it. It removes the stock-build limitation described in
the main README: a plugin enable/disable decision applies only in the window where it was
toggled; other already-open windows pick it up only after an app restart.

With the patch, plugin decisions propagate live between all open windows of the same
Hermes installation. Removed or cleared preference maps restore each plugin to its own
default state, and per-plugin failures are isolated.

- **Target:** `apps/desktop/src/contrib/plugins-store.ts` (single file)
- **Pre-patch file SHA-256:** `88efe4ecf6f72134cddecbf076aa1d85799807b56d7e9587718268964e630b5b`
  — verify before applying; `git apply --check` also fails when the context does not match
- **Patch file SHA-256:** `532710ecf6a44e4a3372ff2e8fa06f85251f3d24e869885eefabae38b76491f1`
- **Generated and verified against:** Hermes commit `bf0203a794a07aac3ff764972ab9087baa4e4f4e`
  (patched build commit `549ba06f0806e4e5d477e8f83dc6015b8e164d62`), macOS arm64 —
  12/12 native checks, including bidirectional live sync between two real windows, rapid
  toggles, re-enable after disable, restart, uninstall and full content fidelity
- **Windows/Linux:** untested
- **License:** Hermes is MIT-licensed; this patch is provided under the same terms,
  maintained by ANNIPU, not submitted upstream

## Applying

```bash
# inside a Hermes source checkout:
git apply --check host-patch/hermes-plugin-window-sync-v2.patch   # dry-run first
git apply host-patch/hermes-plugin-window-sync-v2.patch
# then build the desktop app following Hermes's own instructions
```

## When Hermes ships an update

1. Check whether upstream now fixes the equivalent behavior.
2. If it does: verify, then stop using this patch.
3. If not: adapt the patch and re-run module and native verification before use.
4. If it no longer applies: do not force it — stock builds simply keep the limitation.
