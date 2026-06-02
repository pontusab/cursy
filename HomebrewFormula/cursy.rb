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
    sha256 "0a08d65e84ddef8f3ebb0b362f637d9f5f1179357b0dbf98995c2c0658f07599"
  end

  on_intel do
    url "https://github.com/pontusab/cursy/releases/download/v#{version}/cursy-darwin-x64.tar.gz"
    sha256 "3621351d20766e8075ca09e9748e5067797ffff08cb9948527a9568425e7c9c4"
  end

  def install
    bin.install "cursy"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/cursy --version")
  end
end
