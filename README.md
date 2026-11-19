# Open Terminal Agent

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

English · [简体中文](README.zh-CN.md)

Open Terminal Agent is a cross-platform desktop terminal emulator built to be driven by either a human or an LLM agent. You can type into a local shell yourself, or let an agent read the screen, run commands under an explicit permission policy and verify the result — in the same tab, with a permanent take-over escape hatch.

Rust core, Tauri v2 shell, React frontend. The UI ships in six languages: `zh-CN`, `zh-TW`, `en`, `ru`, `ja`, `ko`.

**Status: phase 2 in progress.** Local shells, SSH shells and serial consoles all open as tabs, and SFTP list/upload/download work as commands. Persisted sessions with keyring credentials, the streaming LLM client and the agent executor are the next slices; the SFTP file-browser UI and HEX/UTF-8 dual view are not built yet.

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
- **Serial console tabs** over `serialport` with port enumeration including USB VID/PID and product strings, configurable baud rate, data bits, stop bits, parity and flow control, plus optional timestamped HEX logging to disk.
- **SFTP backend**: `sftp_connect`, `sftp_list_dir`, `sftp_upload`, `sftp_download` and `sftp_close` stream files instead of buffering them. The sidebar browser UI is still pending.
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
| `crates/term-agent` | Permission policy and command risk, tool catalog, Observe→Reason→Act→Verify state machine with step budget, provider/LlmClient contract, local endpoint table |
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
cargo test --workspace           # 38 tests, including a real /bin/sh PTY round trip
cd apps/desktop
npm run typecheck                # tsc --noEmit
npm run build                    # typecheck + vite production build
```

Commit messages follow the Conventional Commits rules in [AGENTS.md](AGENTS.md); commits are atomic per sub-module and land only after `cargo check --workspace` and `npm run typecheck` pass.

## Not built yet

- SQLite session store and OS keyring credential storage; SSH passwords are typed per connection today and known-hosts pinning is not enforced.
- Streaming LLM client, local model discovery probes (only the endpoint table exists) and the agent executor.
- SFTP file-browser UI, serial HEX/UTF-8 dual display and serial quick-connect shortcuts.
- Live SSH, SFTP and serial sessions have not been exercised against real hardware in the verification environment; they are covered by compilation and unit tests only.
- Packaging (`npm run tauri build`) has not been run, and no binary is published.

## License

Apache License 2.0 — see [LICENSE](LICENSE).
