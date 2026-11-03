#!/usr/bin/env bash
# Apply the window-sync v2 host patch to a Hermes source checkout.
#
# Safe by default:
#   - verifies the target file against the pinned pre-patch SHA-256 and refuses
#     any mismatch (first step of the three-branch update flow in README.md);
#   - idempotent: if the file already matches the patched hash, exits 0;
#   - verifies the post-apply hash before declaring success;
#   - does NOT build anything — follow Hermes's own build instructions after.
#
# usage: ./host-patch/apply.sh <path-to-hermes-source-checkout>
set -euo pipefail

TARGET_FILE="apps/desktop/src/contrib/plugins-store.ts"
PRE_PATCH_SHA256="88efe4ecf6f72134cddecbf076aa1d85799807b56d7e9587718268964e630b5b"
PATCHED_SHA256="25875dbd769f20339bf1952c0b81ec02eca797d2db009ec9d524501642ed5cd5"
PATCH_FILE="$(cd "$(dirname "$0")" && pwd)/hermes-plugin-window-sync-v2.patch"

hash_file() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else sha256sum "$1" | cut -d' ' -f1; fi
}

usage() { echo "usage: ./host-patch/apply.sh <path-to-hermes-source-checkout>" >&2; exit 2; }
[ $# -eq 1 ] || usage
CHECKOUT="$1"
# Absolutize BEFORE any cd: the post-apply verification re-uses $FILE after
# `cd "$CHECKOUT"`, which breaks relative checkout paths (caught by the
# baseline test matrix — patch applied fine, verification crashed).
if ! CHECKOUT="$(cd "$CHECKOUT" 2>/dev/null && pwd)"; then
  echo "error: checkout directory not found: $1" >&2
  exit 1
fi
FILE="$CHECKOUT/$TARGET_FILE"

[ -f "$PATCH_FILE" ] || { echo "error: patch file missing next to this script: $PATCH_FILE" >&2; exit 1; }
[ -f "$FILE" ] || { echo "error: $FILE not found — is this a Hermes source checkout?" >&2; exit 1; }

CURRENT="$(hash_file "$FILE")"

if [ "$CURRENT" = "$PATCHED_SHA256" ]; then
  echo "ok: patch already applied ($TARGET_FILE matches the patched hash) — nothing to do"
  exit 0
fi

if [ "$CURRENT" != "$PRE_PATCH_SHA256" ]; then
  echo "error: $TARGET_FILE does not match the pinned pre-patch hash — refusing." >&2
  echo "  expected (pre-patch): $PRE_PATCH_SHA256" >&2
  echo "  expected (patched):   $PATCHED_SHA256" >&2
  echo "  actual:               $CURRENT" >&2
  echo "  This patch is generated against one specific Hermes revision. See" >&2
  echo "  host-patch/README.md (\"When Hermes ships an update\") for how to proceed." >&2
  exit 1
fi

cd "$CHECKOUT"
if git apply --check "$PATCH_FILE" 2>/dev/null; then
  git apply "$PATCH_FILE"
  AFTER="$(hash_file "$FILE")"
  [ "$AFTER" = "$PATCHED_SHA256" ] || { echo "error: applied, but post-apply hash mismatch: $AFTER" >&2; exit 1; }
  echo "ok: patch applied; $TARGET_FILE now matches the patched hash"
  echo "next: build the desktop app following Hermes's own instructions, then restart it."
else
  echo "error: git apply --check failed — the checkout does not match the patch context." >&2
  echo "  (file hash matched the pin but git context differs; see host-patch/README.md)" >&2
  exit 1
fi
