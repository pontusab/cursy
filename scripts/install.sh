#!/usr/bin/env bash
# cursy installer. Downloads the latest release binary for your Mac and installs
# it to ~/.local/bin/cursy.
#
#   curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/scripts/install.sh | bash
#
# Override the source repo or a pinned version:
#   CURSY_REPO=owner/repo CURSY_VERSION=v0.2.0 bash install.sh
set -euo pipefail

REPO="${CURSY_REPO:-pontusab/cursy}"
VERSION="${CURSY_VERSION:-latest}"
INSTALL_DIR="${CURSY_INSTALL_DIR:-$HOME/.local/bin}"
BIN="$INSTALL_DIR/cursy"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "cursy is macOS-only (this is $(uname -s))." >&2
  exit 1
fi

case "$(uname -m)" in
  arm64) ARCH="arm64" ;;
  x86_64) ARCH="x64" ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

ASSET="cursy-darwin-${ARCH}.tar.gz"
if [[ "$VERSION" == "latest" ]]; then
  URL="https://github.com/$REPO/releases/latest/download/$ASSET"
else
  URL="https://github.com/$REPO/releases/download/$VERSION/$ASSET"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading $ASSET ($VERSION) from $REPO..."
if ! curl -fSL "$URL" -o "$TMP/$ASSET"; then
  echo "Download failed: $URL" >&2
  echo "Check that a release exists and CURSY_REPO is correct." >&2
  exit 1
fi

tar -xzf "$TMP/$ASSET" -C "$TMP"
if [[ ! -f "$TMP/cursy" ]]; then
  echo "Archive did not contain a 'cursy' binary." >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"
chmod 755 "$TMP/cursy"
# Strip quarantine in case it was set, then atomically move into place so a
# running daemon keeps its old inode until restart.
xattr -dr com.apple.quarantine "$TMP/cursy" 2>/dev/null || true
mv -f "$TMP/cursy" "$BIN.new"
mv -f "$BIN.new" "$BIN"

echo "Installed cursy to $BIN"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo
    echo "⚠️  $INSTALL_DIR is not on your PATH. Add it, e.g.:"
    echo "    echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.zshrc && source ~/.zshrc"
    ;;
esac

echo
echo "Next: run  cursy start  to set up and launch the daemon."
