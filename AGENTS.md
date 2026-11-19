# Project Specification: open-terminal-agent

## 1. Project Overview & Licensing

- **Repository / Package Name:** `open-terminal-agent` (Display Name: `Open Terminal Agent`, CLI alias: `ota`)
- **Remote Repository:** `https://github.com/yujieco/open-terminal-agent.git` (default branch: `main`)
- **License:** Apache License 2.0 (`SPDX-License-Identifier: Apache-2.0`). Include the following header in all new `.rs`, `.ts`, and `.tsx` source files:

  ```text
  // Copyright 2026 yujieco
  // SPDX-License-Identifier: Apache-2.0
  ```

**Core Vision:** An open-source, lightweight, cross-platform AI-native terminal emulator and autonomous terminal agent built with Rust and Tauri v2. Users can manually operate Local Shells, SSH/SFTP sessions, and Serial ports, OR delegate terminal control to an LLM Agent that observes the screen, executes commands, verifies output, and troubleshoots autonomously under human supervision.

## 2. Documentation & README.md Standards

**Skill Reference:** Whenever creating, structuring, or updating `README.md` (and any localized README variants), you MUST first inspect and strictly follow the guidelines, structure, and conventions defined in the local skill directory:

```text
/Users/yujie/Documents/yujie/skills.yujie.co/yujie-readme-editor
```

Read `SKILL.md` and any referenced templates/assets inside that folder before writing `README.md`.

## 3. Target Platforms & Monorepo Architecture

Design the repository as a Cargo Workspace + Frontend Monorepo so desktop and future tablet clients share 100% of the Rust core:

- **Phase 1 (Current Target):** Desktop clients for macOS, Windows, and Linux (`apps/desktop`).
- **Phase 2 (Future-Proofing):** Reserve clean platform-agnostic traits in `crates/` so iPadOS and Android tablets (`apps/mobile`) can later attach a touch-optimized UI (virtual modifier toolbar, Android USB-Serial OTG bridge, iPadOS BLE/Network-Serial bridge) without rewriting core logic.

```text
open-terminal-agent/
├── AGENTS.md
├── LICENSE                         # Apache License 2.0
├── README.md                       # Authored following yujie-readme-editor skill
├── .gitignore
├── Cargo.toml                      # Cargo Workspace root
├── crates/
│   ├── term-core/                  # Pure Rust async transport & headless terminal state
│   │   └── src/
│   │       ├── transport.rs        # TerminalTransport trait & 16ms IPC stream batcher
│   │       ├── pty.rs              # Local Shell via portable-pty
│   │       ├── ssh.rs              # Async SSH & SFTP via russh + russh-sftp
│   │       ├── serial.rs           # Serial port enumeration & HEX/UTF-8 I/O via serialport
│   │       ├── screen.rs           # Headless shadow terminal synced via vt100::Parser
│   │       └── error.rs            # Structured errors via thiserror
│   └── term-agent/                 # Autonomous terminal agent & LLM provider abstraction
│       └── src/
│           ├── llm.rs              # OpenAI-compatible SSE & Tool-Calling client (reqwest + rustls)
│           ├── discovery.rs        # Auto-discovery for local Ollama (:11434) & LM Studio (:1234)
│           ├── tools.rs            # Agent tools: read_terminal_screen, execute_command, send_control_signal
│           ├── loop_engine.rs      # Observe -> Reason -> Act -> Verify execution state machine
│           └── policy.rs           # Permission modes (Ask / Supervised / Autonomous) & Take-Over lock
└── apps/
    └── desktop/                    # Tauri v2 Desktop App (macOS, Windows, Linux)
        ├── src-tauri/              # Tauri commands, SQLite session store, OS keyring credentials
        └── src/                    # React + TypeScript + Vite + Tailwind CSS + xterm.js + i18next
```

## 4. Core Functional Requirements

### A. Terminal Transports (`crates/term-core`)

- **Unified `TerminalTransport` Trait:** Abstract `write_bytes`, `resize(cols, rows)`, `subscribe_output`, and `close`.
- **High-Throughput Flow Control:** Batch outgoing byte streams at 16ms intervals before emitting over Tauri IPC Channels to prevent UI freezes during high-baud (e.g., `921600`) serial floods.
- **Local PTY:** Cross-platform shell spawning via `portable-pty`.
- **SSH & SFTP:** Pure Rust async `russh` + `russh-sftp` supporting password and Ed25519/RSA private key authentication, basic SFTP directory browsing, file upload, and file download.
- **Serial Port Debugging:** Cross-platform `serialport` supporting port enumeration (port name, VID/PID, manufacturer/product description), configurable baud rate, data bits, stop bits, parity, flow control, UTF-8 / HEX dual display & send modes, and raw session log recording to disk.
- **Headless Shadow Screen (`vt100`):** Maintain a `vt100::Parser` instance per active session synced with every byte chunk and resize event, allowing the Agent to query clean visible screen text, cursor coordinates, and stripped scrollback history without raw ANSI noise.

### B. LLM Providers: Local AI & BYOK (`crates/term-agent`)

- **Unified OpenAI-Compatible Protocol:** Implement streaming SSE and Function Calling / Tool Use over `reqwest` + `rustls`. Properly preserve and pass back `reasoning_content` across multi-turn tool calls for reasoning models (e.g., DeepSeek).
- **Zero-Config Local AI Discovery:** Concurrently probe `http://localhost:11434` (Ollama) and `http://localhost:1234` (LM Studio) on startup/settings refresh to list locally available models.
- **Custom Cloud LLM (BYOK):** Allow users to configure custom Base URL, Model ID, and API Key (DeepSeek, OpenAI, OpenRouter, etc.). Store all API keys and SSH secrets strictly in the OS native credential store via the `keyring` crate — never in plaintext config files.

### C. Agentic Terminal Control & Safety Governance (`crates/term-agent`)

**Agent Built-in Tools:**

- `read_terminal_screen`: Read current visible terminal grid, cursor position, and recent clean scrollback lines.
- `execute_command`: Write a command to the active transport and wait for completion:
  - **POSIX Shell / SSH:** Detect completion via lightweight sentinel markers (e.g., `; echo "__OTA_END_${?}__"`) or OSC 133 sequences to capture exit code and exact output.
  - **Serial (U-Boot / RTOS / AT commands):** Detect completion via configurable prompt regex matching OR a 300ms byte-stream idle timeout.
- `send_control_signal`: Send raw control bytes (Ctrl+C / `0x03`, Ctrl+D / `0x04`, Tab, or raw HEX bytes).

**Session Control Arbitration & Permission Modes:**

Track per-session control state: `Human`, `AgentRunning`, `WaitingApproval`.

Support 3 user-selectable autonomy modes:

| Mode | Behavior |
| --- | --- |
| **Ask** | Every terminal write requires explicit user approval. |
| **Supervised (Default)** | Auto-approve read-only inspection commands (`ls`, `cat`, `ps`, `df`, `ip`, `dmesg`, `AT+...`); pause and request approval for state-mutating or destructive commands (`rm`, `reboot`, `shutdown`, `dd`, `mkfs`, `chmod`, `kill`, firmware flashing, etc.). |
| **Autonomous** | Execute commands automatically until task completion or max-step limit. |

**Hardware-Level Emergency Override (Take Over):** Provide a persistent **Take Over** button (`Esc` shortcut) and automatic human-keystroke detection that immediately aborts the Agent loop, revokes the session write lock, sends `0x03` (Ctrl+C) if requested, and returns control to the user.

### D. Desktop UI & 6-Language Internationalization (`apps/desktop`)

- **Terminal Renderer:** `@xterm/xterm` + `@xterm/addon-fit` + `@xterm/addon-webgl` (with automatic graceful fallback to default canvas/DOM renderer if WebGL initialization fails on Linux WebKitGTK).
- **Typography:** Configure monospace font stack `"JetBrains Mono", "Sarasa Mono SC", "Noto Sans Mono CJK SC", "Menlo", "Consolas", monospace` so CJK wide characters (2-cell width) and Cyrillic characters (1-cell width) align strictly in TUI apps (`htop`, `vim`, tables).

**Workspace Layout:**

- **Left collapsible sidebar:** Saved Sessions (stored in local SQLite), Serial Quick-Connect, and SFTP file browser.
- **Center workspace:** Multi-tab + split-pane terminal view with top status bar showing connection info, Autonomy Mode selector, and prominent **Take Over** emergency stop button when Agent is active.
- **Right collapsible sidebar:** Agent task panel displaying step-by-step reasoning, tool call cards, inline Approve / Reject prompts for gated commands, plus a `Ctrl+K` quick command generator overlay.

**Internationalization (i18n):**

- Detect OS locale via `sys-locale` on launch and allow manual switching in Settings.
- Must support 6 languages out of the box with complete UI translation keys:
  - `zh-CN` (简体中文)
  - `zh-TW` (繁体中文)
  - `en` (English)
  - `ru` (Русский)
  - `ja` (日本語)
  - `ko` (한국어)

## 5. Git Workflow & Commit Conventions

- **Repository Initialization:** Ensure Git is initialized on branch `main` with remote `origin` set to `https://github.com/yujieco/open-terminal-agent.git`.
- **`.gitignore` Hygiene:** Maintain a comprehensive `.gitignore` excluding `target/`, `node_modules/`, `dist/`, `.DS_Store`, `*.db`, `*.sqlite*`, `.env*`, and local IDE/agent cache directories if untracked. Never commit API keys, tokens, or private keys.

### Conventional Commits Format

Every commit message MUST strictly follow:

```text
<type>(<scope>): <imperative lowercase subject>

[optional body explaining why and architectural notes]
```

**Allowed `<type>`:**

| Type | Meaning |
| --- | --- |
| `feat` | New feature |
| `fix` | Bug fix |
| `refactor` | Code restructuring |
| `perf` | Performance / batching optimization |
| `docs` | README / AGENTS / comments |
| `i18n` | Translations / locale |
| `build` | Cargo / Vite / Tauri config |
| `ci` | GitHub Actions |
| `test` | Unit / integration tests |
| `chore` | Maintenance / gitignore / license |

**Allowed `<scope>`:** `repo`, `core`, `pty`, `ssh`, `serial`, `screen`, `agent`, `llm`, `policy`, `desktop`, `ui`, `i18n`, `deps`.

**Examples:**

```text
chore(repo): initialize workspace skeleton, apache-2.0 license, and gitignore
feat(core): implement TerminalTransport trait, 16ms batcher, and vt100 shadow screen
feat(pty): add cross-platform local shell transport via portable-pty
feat(i18n): add 6-language localization support with system locale detection
docs(repo): author project README following yujie-readme-editor guidelines
```

### Atomic Commits & Pre-Commit Gate

- **Atomic Commits:** Group changes into logical, atomic commits per completed sub-module rather than one giant commit.
- **Mandatory Gate:** Never run `git commit` until `cargo check --workspace` and frontend `npx tsc --noEmit` succeed with zero errors.
- **Push Policy:** Push to `origin main` only when explicitly instructed or at the end of a verified milestone.

## 6. Coding Standards & Verification Rules

- **Compile Verification:** After creating or modifying any Rust files, ALWAYS run `cargo check --workspace` (and `npx tsc --noEmit` for frontend changes) before concluding a turn.
- **Error Handling:** Never use `.unwrap()` or `.expect()` in `crates/`; define typed errors with `thiserror` and map them cleanly to serializable Tauri command errors.
- **Async Runtime:** Use `tokio` consistently across `term-core`, `term-agent`, and `src-tauri`. Keep Tauri commands non-blocking.
- **Incremental Delivery:** Implement and verify one vertical milestone at a time rather than dumping unverified code across all modules at once.

---

## 附录：更新后的 PI 启动提示词（直接复制发送给 PI）

将 `AGENTS.md` 放入空文件夹并启动 `pi` 后，粘贴以下提示词即可：

```text
请仔细阅读项目根目录的 `AGENTS.md`，并先读取 `/Users/yujie/Documents/yujie/skills.yujie.co/yujie-readme-editor` 目录下的技能规范文件，了解 `README.md` 的撰写标准。

本轮请按规范完成【阶段一：仓库初始化 + Rust/Tauri 骨架 + 本地终端 MVP + 6 国语言支持】，并按 Conventional Commits 规范完成分步提交：

1. **初始化 Git 仓库与开源基础文件：**
   - 检查并初始化 Git（默认分支 `main`），关联远程仓库 `https://github.com/yujieco/open-terminal-agent.git`（先不要强行 push，等本地验证通过后再推送）。
   - 创建规范的 `.gitignore`、标准 Apache License 2.0 `LICENSE` 文件，以及严格遵循 `/Users/yujie/Documents/yujie/skills.yujie.co/yujie-readme-editor` 规范撰写的 `README.md`。
   - 初始化根目录 `Cargo.toml`（Workspace），创建 `crates/term-core`、`crates/term-agent` 骨架以及 `apps/desktop`（Tauri v2 + React + TypeScript + Vite + Tailwind CSS）。

2. **实现 `crates/term-core` 基础核心：**
   - 实现统一的异步 `TerminalTransport` Trait（`write_bytes`、`resize`、`subscribe_output`、`close`）与 16ms 字节流聚合缓冲器。
   - 接入 `vt100::Parser` 实现与字节流实时同步的影子屏幕缓冲区（`screen.rs`）。
   - 实现基于 `portable-pty` 的本地 Shell 传输层（`pty.rs`）。

3. **实现 `apps/desktop` 桌面工作台与 6 国语言 i18n：**
   - 集成 `sys-locale` 与前端 `i18next`，完整配置 `zh-CN`、`zh-TW`、`en`、`ru`、`ja`、`ko` 六种语言的自动识别、手动切换及基础 UI 翻译文件。
   - 搭建三栏式工作台骨架（左侧会话栏、中间集成 `@xterm/xterm` + WebGL 自动降级 + CJK/西里尔等宽字体栈的多标签终端区、右侧可折叠的 Agent 侧边栏占位与状态栏），打通本地终端交互。

4. **验证与规范提交：**
   - 运行 `cargo check --workspace` 与前端 `npx tsc --noEmit`，确保零报错。
   - 严格按照 `AGENTS.md` 中的 Conventional Commits 规范，将本阶段成果拆分为 3~4 个清晰的原子 Commit 提交到本地 `main` 分支（并告知我是否已准备好执行 `git push -u origin main`）。
```
