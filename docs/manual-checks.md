# Manual checks

Everything the automated gates cannot cover. The Rust and TypeScript gates prove
the code compiles, links and passes unit tests; they cannot prove a split pane
keeps both PTYs alive or that the approval prompt actually blocks a command.

Work top to bottom. Record `✅ pass`, `❌ fail (note)` or `⏸ blocked (why)` in the
last column, and keep the row notes short. Re-run the list whenever the UI,
transport or agent loop changes.

Prerequisites:

- `cd apps/desktop && npm install`
- A terminal app build: `npm run tauri dev` (dev) or the bundled `.app`
- For the agent rows: an API key saved in Settings → Model & provider
- For the SSH/SFTP rows: any host you may log into
- For the serial rows: a USB serial adapter, loopback jumper on TX/RX works

## 1. Local shell

| # | Step | Expected | Result |
| --- | --- | --- | --- |
| 1.1 | Launch the app | One tab opens, cursor at the prompt | |
| 1.2 | Type `echo hi` + Enter | `hi` printed, exit code not shown but no error | |
| 1.3 | Run `htop` (or `vim`) then quit | Layout does not tear; CJK/wide glyph columns stay aligned | |
| 1.4 | Resize the window | `stty size` inside the shell matches the visible grid | |
| 1.5 | Close the tab | Shell process disappears (`pgrep -f "bin/zsh"` count drops) | |

## 2. Tabs and split panes

| # | Step | Expected | Result |
| --- | --- | --- | --- |
| 2.1 | Sidebar → New local terminal | Second tab opens, previous one keeps its scrollback | |
| 2.2 | `⌘D` | Active pane splits left/right; both prompts accept input | |
| 2.3 | `⌘⇧D` | Active pane splits top/bottom | |
| 2.4 | Run `sleep 30` in one pane, `ls` in the other | Both run independently; no cross-talk | |
| 2.5 | Narrow one pane below ~24 px, then widen it | Terminal does not stay at a 1×1 grid | |
| 2.6 | `⌘W` with two panes | Only the focused pane closes; the tab and sibling stay | |
| 2.7 | `⌘W` on the last pane | Tab disappears | |

## 3. Language

| # | Step | Expected | Result |
| --- | --- | --- | --- |
| 3.1 | Settings → switch to 简体中文 | All visible strings switch, no leftover English key names | |
| 3.2 | Switch to 日本語, then 한국어 | Same | |
| 3.3 | Restart the app | Last manual choice is not required to persist, but the OS locale must be picked up | |

## 4. SSH and saved connections

| # | Step | Expected | Result |
| --- | --- | --- | --- |
| 4.1 | SSH dialog → host/user/password → Connect | Prompt appears; the status bar shows `user@host` | |
| 4.2 | Run `hostname` remotely | Output matches the remote host | |
| 4.3 | Same dialog, tick Save, reconnect | Sidebar lists the profile; clicking it reconnects without retyping | |
| 4.4 | Connect to a host whose key changed (regenerate host keys) | Connection fails and the error names both fingerprints | |
| 4.5 | Settings → SSH host keys → Forget that host | Reconnect succeeds again | |

## 5. SFTP browser

| # | Step | Expected | Result |
| --- | --- | --- | --- |
| 5.1 | Header → SFTP → pick the saved SSH profile | Home directory lists with folders first | |
| 5.2 | Enter a directory, press ↑ | Path bar and listing move up | |
| 5.3 | Download a small file to `/tmp` | Footer reports byte count; file exists locally with identical size | |
| 5.4 | Upload a small file | Byte count reported; file visible after refresh | |
| 5.5 | Esc | Drawer closes and the connection is released | |

## 6. Serial console

| # | Step | Expected | Result |
| --- | --- | --- | --- |
| 6.1 | Serial dialog → refresh | Adapter appears with VID/PID and product string | |
| 6.2 | Connect at 115200 8N1 | Pane opens; device output appears | |
| 6.3 | Toggle `HEX` | Rolling dump shows `0D 0A 41  \|..A\|` style lines | |
| 6.4 | Send `0D 0A` in the HEX composer | Device receives CRLF; composer clears | |
| 6.5 | Send `0D0` (odd digits) | Inline error, nothing written | |

## 7. Agent runtime

| # | Step | Expected | Result |
| --- | --- | --- | --- |
| 7.1 | Mode Supervised, ask: “列出当前目录里最大的 3 个文件” | Each command card appears **before** it runs, then exit code + output | |
| 7.2 | While it runs, type in the terminal | Run stops, panel says it was taken over, status bar flips to human | |
| 7.3 | Mode Supervised, ask to `touch /tmp/ota-probe` | Card is marked mutating; Approve/Reject appears | |
| 7.4 | Press Reject | Nothing is written; the model reacts without retrying | |
| 7.5 | Tick Step-through, ask to `ls` | Even the read-only command asks first | |
| 7.6 | Press Esc during a run | Run cancels; pending approvals resolve to “no” | |
| 7.7 | Agent → history → pick the run | Timeline replays with the original task and commands | |

## 8. Command palette

| # | Step | Expected | Result |
| --- | --- | --- | --- |
| 8.1 | `⌘K`, type “找出占用 8080 端口的进程” | One command shown in a code block | |
| 8.2 | Press Insert | Command is written to the terminal **without** executing | |
| 8.3 | Press Enter yourself | Command runs | |
| 8.4 | Regenerate | A new command replaces the previous one | |

## 9. Settings and providers

| # | Step | Expected | Result |
| --- | --- | --- | --- |
| 9.1 | Switch model to `deepseek-v4-pro`, save, run an agent task | Task completes; status shows the new model | |
| 9.2 | With Ollama running, press Probe local models | Models appear and are selectable | |
| 9.3 | Select a local model and run a task | Task completes against the local server | |
| 9.4 | Quit and relaunch | The chosen provider/model is still selected | |

## 10. Packaging

| # | Step | Expected | Result |
| --- | --- | --- | --- |
| 10.1 | `npm run tauri build -- --bundles app` | `.app` produced | |
| 10.2 | Launch the `.app` | Window opens, shell spawns (no dev server needed) | |
| 10.3 | Run a task in the bundled app | Works identically to the dev build | |

## Known gaps that these checks cannot close

- Windows and Linux were never built here.
- Serial success paths need real hardware; a pty is **not** a substitute
  (`serialport` asks for modem-control lines, ptys answer `ENOTTY`).
- Keyring writes were deliberately never exercised during verification, to leave
  no credentials behind; rows 4.3 and 9.1 are the first real proof.
