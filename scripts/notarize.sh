#!/usr/bin/env bash
# Notarize a compiled cursy binary with Apple's notary service.
#
# A bare Mach-O executable can't have a notarization ticket *stapled* to it
# (stapling only works on .app/.dmg/.pkg), but submitting it still registers the
# binary's hash with Apple so Gatekeeper passes it when checked online. This
# matters for users who download via a browser (which sets the quarantine bit);
# `curl | bash` and Homebrew installs strip quarantine, so notarization is
# optional for those paths.
#
# Credentials (either approach):
#   A) A stored notarytool keychain profile:
#        xcrun notarytool store-credentials cursy-notary \
#          --apple-id you@example.com --team-id TEAMID --password app-specific-pw
#      then: CURSY_NOTARY_PROFILE=cursy-notary bash scripts/notarize.sh <bin>
#   B) Inline env: APPLE_ID, APPLE_TEAM_ID, APPLE_APP_PASSWORD
set -euo pipefail

BIN="${1:?usage: notarize.sh <path-to-binary>}"

ZIP="$(mktemp -d)/$(basename "$BIN").zip"
ditto -c -k --keepParent "$BIN" "$ZIP"

if [[ -n "${CURSY_NOTARY_PROFILE:-}" ]]; then
  xcrun notarytool submit "$ZIP" --keychain-profile "$CURSY_NOTARY_PROFILE" --wait
else
  : "${APPLE_ID:?set APPLE_ID or CURSY_NOTARY_PROFILE}"
  : "${APPLE_TEAM_ID:?set APPLE_TEAM_ID}"
  : "${APPLE_APP_PASSWORD:?set APPLE_APP_PASSWORD (app-specific password)}"
  xcrun notarytool submit "$ZIP" \
    --apple-id "$APPLE_ID" \
    --team-id "$APPLE_TEAM_ID" \
    --password "$APPLE_APP_PASSWORD" \
    --wait
fi

echo "notarize: submitted $BIN (ticket is checked online; bare binaries can't be stapled)"
rm -f "$ZIP"
