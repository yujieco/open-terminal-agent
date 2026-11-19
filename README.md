# Open Terminal Agent

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

English · [简体中文](README.zh-CN.md)

Open Terminal Agent is a cross-platform desktop terminal emulator built to be driven by either a human or an LLM agent. You can type into a local shell yourself, or let an agent read the screen, run commands under an explicit permission policy and verify the result — in the same tab, with a permanent take-over escape hatch.

Rust core, Tauri v2 shell, React frontend. The UI ships in six languages: `zh-CN`, `zh-TW`, `en`, `ru`, `ja`, `ko`.

**Status: phase 2 in progress.** Local shells, SSH shells and serial consoles all open as tabs; SFTP list/upload/download work as commands; saved connections live in SQLite with SSH passwords in the OS keyring and host keys pinned on first contact. The agent runtime is live: ask in natural language and every command is announced *before* it runs, then shown with its exit code and output. The SFTP file-browser UI and HEX/UTF-8 dual view are still missing.

## Requirements

| Dependency | Version | Verified here |
| --- | --- | --- |
| Rust | 1.90+ (stable, pinned by `rust-toolchain.toml`) | 1.100.0 |
| Node.js | 22.12+ | 26.13.0 |
| Tauri v2 prerequisites | macOS: Xcode command line tools · Windows: MSVC build tools + WebView2 · Linux: `webkit2gtk-4.1` | macOS 27.2, Apple Silicon |

Only macOS has been built and launched in this checkout. Windows and Linux are declared targets of the shared `term-core` crate and are not yet tested.

## Quick start

Build from source; there are no packaged releases yet.

```bash
git clone https://github.com/yujieco/open-terminal-agent.git
cd open-terminal-agent/apps/desktop
npm install
npm run tauri dev
```

The window opens with one local shell tab and the cursor already in the prompt. Type `ls` and the listing appears in the pane.

### Browser-only preview

To review the interface without Rust:

```bash
cd apps/desktop
npm run dev
```

This swaps the PTY backend for a local echo shell — the header shows a "Browser demo" badge so the two modes are never confused.

## What works

- **Local PTY sessions** on macOS, Windows and Linux through `portable-pty`, spawned per tab and killed when the tab closes.
- **SSH shell tabs** over `russh` with password or private-key authentication (Ed25519 and RSA), a real PTY request, window-change on resize, and the server key fingerprint captured at handshake.
- **Serial console tabs** over `serialport` with port enumeration including USB VID/PID and product strings, configurable baud rate, data bits, stop bits, parity and flow control, plus optional timestamped HEX logging to disk. A `HEX` switch turns the pane into a hex dump (`0D 0A 41  |..A|`) and accepts hex input to send raw bytes.
- **SFTP backend**: `sftp_connect`, `sftp_list_dir`, `sftp_upload`, `sftp_download` and `sftp_close` stream files instead of buffering them. The sidebar browser opens from a saved SSH profile, walks directories, and uploads or downloads files with byte counts.
- **Saved connections**: SQLite (WAL) at the app config directory stores name, kind and connection parameters; passwords and passphrases go to the OS keyring and only the keyring account name is written to disk. The sidebar reopens them with one click.
- **SSH host key pinning**: the fingerprint is recorded on first contact and every later connection must match, otherwise the handshake fails with the pinned and presented fingerprints in the error. Settings lists every pinned key so it can be reviewed or forgotten.
- **Agent runtime with a visible step timeline**: the model plans, the runtime announces `ToolRequested` with the exact command and its risk *before* writing anything, then `ToolFinished` with exit code, duration and the captured screen. Reasoning deltas stream while the model thinks.
- **Approval gate wired to the UI**: Ask/Supervised/Autonomous run through the same policy as the rest of the app, so a gated command surfaces an Approve/Reject prompt and a rejected command never reaches the terminal.
- **Risk classification you cannot slip past with a flag**: unknown programs are mutating, opaque interpreters (`sh -c`, `python -c`, `osascript -e`) and destructive flags (`find -delete`, `rsync --delete`, `sed -i`, `git clean -fd`, `--force`) are destructive, and command substitution never leaves a segment read-only.
- **Human input wins**: typing in a terminal while the agent runs aborts the loop, rejects pending approvals and returns the write lock, with a global `Esc` take-over. The status bar always shows who owns the terminal.
- **Run history**: every run is stored in SQLite with its full event stream, so the timeline can be replayed and audited after the fact instead of vanishing when you switch tabs.
- **Step-through mode**: toggle it and every command — including `ls` — waits for approval, for when you want to watch each move rather than the whole plan.
- **`Ctrl+K` command palette**: describe a task in one sentence, review the generated command, and only then write it to the terminal — it is inserted without a newline, so pressing Enter stays your decision.
- **Bounded context**: tool output handed to the model is capped (8k characters, head and tail kept), so a noisy build log cannot crowd out the actual task.
- **Provider switching**: Settings picks deepseek-flash, deepseek-v4-pro, or a model hosted by a locally probed Ollama / LM Studio server; the choice lives in SQLite and each provider's key in the OS keyring.
- **16 ms output batching.** Transport reads are coalesced into one frame per tick (capped at 256 KB) and shipped to the WebView as base64, then decoded with a streaming `TextDecoder` so multi-byte CJK characters survive frame boundaries.
- **Headless shadow screen.** A `vt100` parser per session mirrors the same bytes the pane receives and exposes clean text, cursor position and scrollback to the agent side — no ANSI noise.
- **xterm.js 6 with a WebGL renderer** and automatic fallback to the DOM renderer when a context cannot be created (the WebKitGTK case), plus a monospace stack that keeps CJK wide glyphs and Cyrillic one-cell glyphs aligned.
- **Three-column workbench**: session sidebar with detected shells, multi-tab terminal area, collapsible agent panel, and a status bar showing shell, grid size, autonomy mode, UI language and session count.
- **Six-language UI** selected from the OS locale at launch (`sys-locale` on the Rust side) and switchable at any time from Settings.
- **Permission policy** — Ask / Supervised / Autonomous, with read-only, mutating and destructive command classification. Wired to the panel and tested; the loop that consumes it lands in phase 2.

## Architecture

| Path | Responsibility |
| --- | --- |
| `crates/term-core` | `TerminalTransport` trait, 16 ms `StreamBatcher`, `vt100` shadow screen, local PTY, SSH shell, SFTP client and serial transports |
| `crates/term-agent` | Streaming OpenAI-compatible client, local discovery probes, permission policy and command risk, tool catalog, the `AgentRuntime` step loop, and the `AgentTerminal`/`Approver`/`StreamSink` ports that keep it free of Tauri and UI code |
| `apps/desktop/src-tauri` | Tauri commands, session registry, output fan-out to the WebView, locale detection |
| `apps/desktop/src` | React 19 + TypeScript UI, xterm.js panes, i18next resources |

One trait carries every session kind, so the UI and the agent never branch on transport:

```rust
#[async_trait]
pub trait TerminalTransport: Send + Sync {
    fn session_id(&self) -> &SessionId;
    async fn write_bytes(&self, data: &[u8]) -> Result<()>;
    fn resize(&self, cols: u16, rows: u16) -> Result<()>;
    fn subscribe_output(&self) -> broadcast::Receiver<TerminalOutput>;
    async fn close(&self) -> Result<()>;
}
```

## Development

```bash
cargo check --workspace          # compile gate for the whole workspace
cargo test --workspace           # 54 tests, including a real /bin/sh PTY round trip
DEEPSEEK_API_KEY=sk-... cargo test -p term-agent --test deepseek_runtime -- --ignored --nocapture
                                 # real model + real PTY: creates and verifies a file
cd apps/desktop
npm run typecheck                # tsc --noEmit
npm run build                    # typecheck + vite production build
```

Commit messages follow the Conventional Commits rules in [AGENTS.md](AGENTS.md); commits are atomic per sub-module and land only after `cargo check --workspace` and `npm run typecheck` pass.

## Not built yet

- Per-provider key management UI beyond "paste a key for the selected provider" (delete/rotate lives in the keychain app for now).
- Conversation history across runs: each task starts a fresh transcript (stored runs are replayable, but their messages are not fed back to the model).
- Serial quick-connect shortcuts on the sidebar.
- Live SSH, SFTP and serial sessions have not been exercised against real hardware in the verification environment; they are covered by compilation and unit tests only. The keyring path is likewise unit-tested through account naming only, because writing to the real Keychain during verification would leave credentials behind.
- The agent runtime was verified end to end against a real model, but the GUI timeline itself was only verified by type checks, a production build and a launch smoke test.
- No release is published: the `.app` is built locally, not signed or notarised.

## Packaging

```bash
cd apps/desktop
npm run tauri build -- --bundles app
```

Produces `target/release/bundle/macos/Open Terminal Agent.app` (11.9 MiB on
macOS arm64). The bundled app was launched and confirmed to start a local shell,
so the release build embeds the frontend assets and the IPC/PTY path works outside
`tauri dev`. Windows and Linux bundles have not been built here.

## Continuous integration

Every push runs `.github/workflows/ci.yml`: `cargo fmt --check`,
`cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`,
then `npm run typecheck` and `npm run build` for the frontend. The same commands
are what this repository was verified with locally.

## License

Apache License 2.0 — see [LICENSE](LICENSE).
