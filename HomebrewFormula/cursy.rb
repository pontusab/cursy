# Homebrew formula for cursy. Drop this in a tap repo
# (github.com/pontusab/homebrew-tap as Formula/cursy.rb) so users can:
#
#   brew install pontusab/tap/cursy
#
# Per release, update `version` and the two `sha256` values (from
# dist/checksums.txt produced by scripts/release.sh).
class Cursy < Formula
  desc "Control Cursor from iMessage; a local daemon routes messages to cursor-agent"
  homepage "https://cursy.dev"
  version "0.1.0"
  license "MIT"
  depends_on :macos

  on_arm do
    url "https://github.com/pontusab/cursy/releases/download/v#{version}/cursy-darwin-arm64.tar.gz"
    sha256 "REPLACE_WITH_ARM64_SHA256"
  end

  on_intel do
    url "https://github.com/pontusab/cursy/releases/download/v#{version}/cursy-darwin-x64.tar.gz"
    sha256 "REPLACE_WITH_X64_SHA256"
  end

  def install
    bin.install "cursy"
  end

  test do
    assert_match "cursy", shell_output("#{bin}/cursy --version")
  end
end
