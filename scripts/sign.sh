#!/usr/bin/env bash
# Sign the compiled cursy binary with a STABLE code-signing identity.
#
# Why this matters: macOS TCC (Full Disk Access, Automation) pins a grant to
# the binary's code requirement. An ad-hoc signature pins it to the per-build
# cdhash, so every rebuild invalidates the grant and forces a re-grant. A
# Developer ID (or any keychain code-signing identity) pins the grant to a
# stable identifier + team, so you grant FDA once and rebuilds keep working.
#
# Identity selection order:
#   1. $CURSY_SIGN_ID if set (exact identity name or SHA-1 hash)
#   2. First "Developer ID Application" identity in the keychain
#   3. Ad-hoc ("-") as a last resort (works, but FDA must be re-granted per build)
set -euo pipefail

BIN="${1:?usage: sign.sh <path-to-binary>}"
IDENTIFIER="dev.cursy.daemon"

pick_identity() {
  if [[ -n "${CURSY_SIGN_ID:-}" ]]; then
    printf '%s' "$CURSY_SIGN_ID"
    return
  fi
  local devid
  devid="$(security find-identity -v -p codesigning 2>/dev/null \
    | grep "Developer ID Application" | head -1 \
    | sed -E 's/^[[:space:]]*[0-9]+\)[[:space:]]+[0-9A-F]+[[:space:]]+"(.*)"$/\1/')"
  if [[ -n "$devid" ]]; then
    printf '%s' "$devid"
    return
  fi
  printf '%s' "-"
}

IDENTITY="$(pick_identity)"

# For release builds destined for notarization, set CURSY_HARDENED=1 to add the
# hardened runtime and a secure timestamp (both required by notarytool). Local
# dev builds leave this unset for speed.
EXTRA=()
if [[ "${CURSY_HARDENED:-}" == "1" ]]; then
  EXTRA+=(--options runtime --timestamp)
fi

if [[ "$IDENTITY" == "-" ]]; then
  echo "sign: ad-hoc signing $BIN (FDA grant will not survive rebuilds)"
  codesign --force --identifier "$IDENTIFIER" --sign - ${EXTRA[@]+"${EXTRA[@]}"} "$BIN"
else
  echo "sign: signing $BIN with identity: $IDENTITY"
  codesign --force --identifier "$IDENTIFIER" --sign "$IDENTITY" ${EXTRA[@]+"${EXTRA[@]}"} "$BIN"
fi

codesign -dvvv "$BIN" 2>&1 | grep -E "Identifier|TeamIdentifier|Authority=Developer ID|Signature" || true
