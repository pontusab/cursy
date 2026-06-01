#!/usr/bin/env bash
# Build, sign, (optionally) notarize, and package cursy release artifacts.
#
# Produces, in dist/:
#   cursy-darwin-arm64.tar.gz
#   cursy-darwin-x64.tar.gz
#   checksums.txt            (sha256 of each tarball)
#
# Usage:
#   bash scripts/release.sh                 # build + sign both arches
#   CURSY_NOTARIZE=1 bash scripts/release.sh  # also notarize each binary
#
# Signing identity is chosen by scripts/sign.sh (Developer ID preferred). For
# notarization, see scripts/notarize.sh for the required credentials.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
DIST="$ROOT/dist"
mkdir -p "$DIST"

build_one() {
  local arch="$1"        # arm64 | x64
  local target="bun-darwin-${arch}"
  local bin="$DIST/cursy-darwin-${arch}"

  echo "==> building $target"
  bun build --compile --target="$target" ./src/cli.ts --outfile "$bin"

  # Hardened runtime + timestamp so the binary is eligible for notarization.
  CURSY_HARDENED=1 bash scripts/sign.sh "$bin"

  if [[ "${CURSY_NOTARIZE:-}" == "1" ]]; then
    echo "==> notarizing $bin"
    bash scripts/notarize.sh "$bin"
  fi

  echo "==> packaging $bin"
  # Stage as the final name `cursy` inside the tarball so installs are simple.
  local stage
  stage="$(mktemp -d)"
  cp "$bin" "$stage/cursy"
  chmod 755 "$stage/cursy"
  tar -czf "$DIST/cursy-darwin-${arch}.tar.gz" -C "$stage" cursy
  rm -rf "$stage"
}

build_one arm64
build_one x64

echo "==> writing checksums"
( cd "$DIST" && shasum -a 256 cursy-darwin-*.tar.gz > checksums.txt )

echo
echo "Artifacts in dist/:"
ls -1 "$DIST"/cursy-darwin-*.tar.gz "$DIST/checksums.txt"
echo
echo "Next: create a GitHub release and upload these, e.g."
echo "  gh release create vX.Y.Z dist/cursy-darwin-*.tar.gz dist/checksums.txt --generate-notes"
