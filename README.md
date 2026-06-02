<p align="center">
  <img src="site/img/og.jpg" alt="cursy — Cursor, from iMessage" width="100%" />
</p>

Control [Cursor](https://cursor.com) from iMessage. Text your own number (or yourself from another device) and a small daemon on your Mac runs the prompt through the `cursor-agent` CLI and texts the result back. Each iMessage thread maps to a persistent agent session, so it feels like a natural conversation with your codebase.

Everything runs **locally on your Mac**. No cloud relay, no third-party servers, and your iMessage credentials never leave the Messages app.

```
iMessage ──▶ Messages.app ──▶ chat.db
                                 │  (watched for new rows)
                                 ▼
                          cursy daemon (launchd)
                                 │  whitelist + parse
                                 ▼
                cursor-agent -p --resume <chatId> --workspace <dir>
                                 │  stream-json
                                 ▼
                          imessage reply (AppleScript)
```

## Requirements

- macOS 14 (Sonoma) or newer
- Messages.app signed in to iMessage
- A Cursor account (the daemon uses the `cursor-agent` CLI; cursy can install it)
- To build from source: [Bun](https://bun.com) >= 1.2.4

cursy ships as a single self-contained native binary (built with `bun build --compile`), so end users don't need Node, Bun, or any runtime installed.

## Install

### Quick install (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/pontusab/cursy/main/scripts/install.sh | bash
```

This downloads the right native binary for your Mac (arm64 or x64) to `~/.local/bin/cursy`. Then run setup:

```bash
cursy start
```

### Homebrew

```bash
brew install pontusab/tap/cursy
```

### From source

```bash
bun install
bun run build        # compiles + signs dist/cursy
bun run install:bin  # copies dist/cursy -> ~/.local/bin/cursy
```

Make sure `~/.local/bin` is on your PATH, then run `cursy onboard`.

`cursy onboard` (also triggered automatically the first time you run `cursy start`) will:

1. Check and optionally install dependencies (`cursor-agent`).
2. Walk you through the two required macOS permissions.
3. Capture your phone/email whitelist, default workspace, and agent defaults.
4. Install and start the background daemon (a launchd LaunchAgent).

## macOS permissions

cursy needs two permissions that macOS cannot grant programmatically. The wizard opens the right settings pane for each:

- **Full Disk Access** - required to read `~/Library/Messages/chat.db` for incoming messages.
  - During onboarding (run from your terminal), grant it to the app you launched cursy from (Terminal, iTerm, or Cursor). cursy detects and names the exact app for you - you will never see "cursy" itself in the list, because macOS attributes access to the host app.
  - For the background daemon, macOS attributes access to the daemon binary itself. Grant Full Disk Access to `~/.local/bin/cursy` (cursy tells you the exact path if the daemon can't read messages). Because cursy is its own binary - not a shared `node` - this grant is scoped to cursy alone.
- **Automation (Messages)** - required to send replies via AppleScript. A prompt appears the first time; if it was previously denied, onboarding offers to reset it (`tccutil reset AppleEvents`) so macOS asks again instead of looping.
- **Accessibility** - optional; only needed for **tapback reactions** (e.g. a 👍 acknowledgment instead of an "on it..." text). Tapbacks are sent by synthesizing keystrokes via System Events, which macOS gates behind Accessibility. If not granted, cursy automatically falls back to a text reply, so this is never required.

These prompts only appear from a GUI session (not over SSH). Because the daemon runs as a launchd LaunchAgent inside your login session, a single manual approval per machine is enough.

## Usage

Once the daemon is running, just text the whitelisted number. Plain text is sent straight to the agent:

> list the largest files in this repo

> now add a unit test for the parser

Follow-ups keep the full conversation context (the thread resumes the same agent session).

### Built-in commands

Messages starting with `/` are interpreted as commands:

| Command | Description |
| --- | --- |
| `/new` | Start a fresh agent session for this thread |
| `/workspace <path>` | Set the working directory for this thread |
| `/model <name>` | Set the model for this thread |
| `/mode <agent\|plan\|ask>` | Set how the agent responds for this thread |
| `/ping` | Quick health check (no agent call) |
| `/status` | Show the thread's workspace, model, mode, and session |
| `/help` | List commands |

### CLI commands

| Command | Description |
| --- | --- |
| `cursy onboard` | Guided setup (re-run anytime to reconfigure) |
| `cursy doctor` | Check/install dependencies and verify auth |
| `cursy start` | Start the daemon (runs onboarding if unconfigured) |
| `cursy stop` | Stop the daemon |
| `cursy restart` | Restart the daemon |
| `cursy status` | Show daemon state, config, and permission checks |
| `cursy logs [-f]` | Show / follow the activity log |
| `cursy config [--show]` | View or edit configuration |
| `cursy qr [prompt]` | Print a QR code that opens Messages with a starter prompt |

## Configuration

Config lives at `~/.config/cursy/config.json` (mode `600`):

| Field | Meaning |
| --- | --- |
| `whitelist` | Normalized handles allowed to control the agent |
| `commandPrefix` | Optional prefix required before any message is processed |
| `passphrase` | Optional shared secret required in the first message |
| `defaultWorkspace` | Default repo the agent operates on |
| `defaultModel` | Model passed to `cursor-agent` (blank = account default) |
| `defaultMode` | `agent`, `plan`, or `ask` |
| `force` | Pass `--force` to `cursor-agent` (full tool access incl. shell/write) |
| `allowSms` | Allow SMS/RCS (not just iMessage) to control the agent — off by default; SMS sender IDs are spoofable |
| `reactions` | Use iMessage tapbacks for quick acknowledgments (👍), falling back to text if Accessibility isn't granted |
| `threads` | Per-thread session id, workspace, and model |
| `watermark` | Last processed Messages ROWID |

## How it works

- **Incoming**: the daemon reads `chat.db` (read-only) using a ROWID watermark, watching for new rows via filesystem events with a polling fallback. macOS stores message bodies either in the `text` column or an `attributedBody` blob; cursy decodes both.
- **Self-chat safety**: when you text your own number, Messages writes two database rows per message (sent + received echo) and echoes the daemon's replies back as incoming rows. cursy deduplicates these: it tags every outgoing message with an invisible marker, tracks recent outbound text, and collapses `is_from_me` twin pairs so each prompt runs the agent once. On newer macOS versions the prompt may only appear on the `is_from_me=1` row — cursy handles that too. **Note:** iMessage may still show your message twice in the UI (sent bubble + echo) — that's Messages.app behavior and can't be suppressed from the daemon.
- **Agent**: each thread maps to a `cursor-agent` chat session resumed via `--resume <chatId>`. Runs use `--output-format stream-json` and are wrapped in a timeout (and force-killed shortly after the terminal `result` event to work around the CLI's occasional failure to exit).
- **Outgoing**: replies are sent through Messages.app via AppleScript (`osascript`). Long answers are split into multiple bubbles, markdown is cleaned up, and large code/diffs are sent as file attachments.
- **Reactions**: Apple exposes no scripting verb for tapbacks, so cursy sends them the only SIP-safe way - UI automation via System Events (open the chat, ⌘T to open the tapback picker, press the reaction's number). Used for lightweight acknowledgments; falls back to text if it can't (e.g. no Accessibility grant). Inbound tapbacks are filtered out at the SQL layer (`associated_message_type`) so they never get mistaken for prompts.

## Clean thread (optional)

The quickest setup is to text your **own number** — zero extra accounts. The only downside is cosmetic: because you're both sender and receiver, Messages shows your prompt twice (a sent bubble and a received echo). This is [standard iMessage behavior](https://discussions.apple.com/thread/254765422) for self-chats and can't be turned off — cursy still runs each prompt once and replies once.

If you'd rather have a pixel-clean thread (your prompts on the right, cursy's replies on the left, no duplicates), use a **dedicated identity** instead of self-chat:

1. Create a free Apple ID (a spare iCloud account) for "Cursy".
2. On the Mac running the daemon, sign in to Messages with that Cursy Apple ID (Messages → Settings → iMessage).
3. From your everyday iPhone, start a conversation with the Cursy Apple ID and add it to your contacts as "Cursy".
4. Put your everyday number/email in cursy's whitelist (it's the sender), and run `cursy restart`.

Now you text "Cursy" from your own phone like any normal contact — since the sender and receiver are different identities, iMessage never generates the self-echo. Your sending experience is unchanged; the thread is just clean.

## Security

cursy gives whoever can message your whitelisted handle the ability to run `cursor-agent` in your workspace. With `force` enabled (the default), that includes **writing files and running shell commands** on your Mac. Treat it like SSH access. Mitigations cursy applies and options you have:

- **iMessage-only control (default).** SMS/RCS messages are ignored for commands and prompts because their sender IDs can be spoofed. Flip `allowSms` only if your controlling device is SMS-only and you accept the risk.
- **Whitelist.** Only normalized handles in `whitelist` are honored; everything else is dropped before reaching the agent.
- **Passphrase gate (optional).** Set `passphrase` so a thread must send the secret before the agent will act — recommended if you ever enable `allowSms` or share a device.
- **Scope `force`.** For a lower-risk setup, set `force: false` (or `defaultMode: "plan"`/`"ask"`) so the agent proposes instead of executing.
- **Scope the workspace.** Point `defaultWorkspace` at a dedicated repo rather than your home folder to limit blast radius.
- **Prompt injection.** The agent acts on message text and repo contents; don't point it at untrusted repositories while `force` is on.

## Limitations

- macOS only.
- Only locally-cached messages are visible (Messages-in-iCloud history that isn't on this Mac is not readable).
- Group chats, inbound attachments, and multi-user routing are out of scope for v1.
- Self-chat may show duplicate bubbles in Messages (your sent text echoed back visually). cursy won't double-run the agent, but the UI quirk is inherent to iMessage — texting from another device to your Mac avoids it.
- `cursor-agent` is a coding agent scoped to the workspace - it's "talk to your repo," not a general chatbot.

## Development

cursy is written in TypeScript and runs on [Bun](https://bun.com).

```bash
bun install
bun run dev -- --help    # run from source (bun runs TS directly)
bun run typecheck        # type-check with tsc
bun run build            # compile single-file binary -> dist/cursy
bun run install:bin      # install to ~/.local/bin/cursy
```

The iMessage database is read via Bun's built-in `bun:sqlite`, so there is no native module to compile. `bun build --compile` embeds the Bun runtime, and `scripts/sign.sh` signs the result.

```bash
bun test         # run the unit suite
```

### Releasing

`bun run release` (→ `scripts/release.sh`) builds both architectures, signs them with a hardened runtime, optionally notarizes, and writes `dist/cursy-darwin-{arm64,x64}.tar.gz` plus `dist/checksums.txt`.

```bash
bun run release                 # build + sign both arches
CURSY_NOTARIZE=1 bun run release  # also notarize (see scripts/notarize.sh for creds)
```

Then publish a release and update the consumer references:

```bash
gh release create v0.2.0 dist/cursy-darwin-*.tar.gz dist/checksums.txt --generate-notes
```

- **CI:** pushing a `v*` tag runs `.github/workflows/release.yml`, which builds, signs (using the `MACOS_CERT_*` secrets), optionally notarizes (using the `APPLE_*` secrets), and creates the GitHub release.
- **Homebrew:** copy `HomebrewFormula/cursy.rb` into your tap repo and bump `version` + the two `sha256` values from `dist/checksums.txt`.
- **Repo slug:** artifacts point at `pontusab/cursy` (the installer also honors `CURSY_REPO` for forks).

### Code signing & permissions stability

macOS TCC ties a permission grant (Full Disk Access, Accessibility) to the binary's **code requirement**. `scripts/sign.sh` picks the most stable identity available:

1. `$CURSY_SIGN_ID` if set, else
2. the first **Developer ID Application** identity in your keychain, else
3. ad-hoc (`-`).

It always pins a stable `--identifier` (`dev.cursy.daemon`). With a Developer ID, the grant is keyed to your identifier + Team ID, so **rebuilds keep working without re-granting**. With ad-hoc signing the grant is pinned to the per-build hash, so each rebuild at the same path needs re-granting. For distribution to others, add hardened runtime + notarization and ship a `.app` bundle.

## License

MIT
