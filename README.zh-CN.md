# Open Terminal Agent

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

[English](README.md) · 简体中文

Open Terminal Agent 是一个跨平台桌面终端模拟器，既可以直接由人操作，也可以交给 LLM Agent 驾驶。你可以自己在本地 Shell 里敲命令，也可以让 Agent 观察屏幕、按明确的权限策略执行命令并校验结果——两者共用同一个标签页，并保留随时紧急接管的口子。

核心为 Rust，外壳为 Tauri v2，界面为 React。UI 内置六种语言：`zh-CN`、`zh-TW`、`en`、`ru`、`ja`、`ko`。

**状态：阶段二进行中。** 本地 Shell、SSH Shell 与串口控制台都能作为标签页打开；SFTP 列目录/上传/下载已作为命令可用；已保存连接存于 SQLite，SSH 密码存于系统钥匙串，主机密钥首次接触即固定。Agent Runtime 已可用：用自然语言提出任务，每条命令在**执行前**先公布，执行后附退出码与输出。SFTP 文件浏览器界面与 HEX/UTF-8 双视图仍未实现。

## 环境要求

| 依赖 | 版本 | 本机验证 |
| --- | --- | --- |
| Rust | 1.90+（stable，由 `rust-toolchain.toml` 固定） | 1.100.0 |
| Node.js | 22.12+ | 26.13.0 |
| Tauri v2 前置 | macOS：Xcode 命令行工具 · Windows：MSVC 构建工具 + WebView2 · Linux：`webkit2gtk-4.1` | macOS 27.2，Apple Silicon |

本次仅在 macOS 上完成构建与启动验证。Windows 与 Linux 是共享 `term-core` 的声明目标，尚未实机测试。

## 快速开始

从源码构建；目前还没有打包发布。

```bash
git clone https://github.com/yujieco/open-terminal-agent.git
cd open-terminal-agent/apps/desktop
npm install
npm run tauri dev
```

窗口打开后会有一个本地 Shell 标签页，光标已在提示符处。输入 `ls`，目录列表随即出现在窗格中。

### 纯浏览器预览

不装 Rust 也能评审界面：

```bash
cd apps/desktop
npm run dev
```

此时 PTY 后端被替换为本地回显 Shell，顶栏会显示「浏览器演示」徽标，避免与真实模式混淆。

## 已具备的能力

- **本地 PTY 会话**：经 `portable-pty` 在 macOS、Windows、Linux 上启动，随标签页关闭而终止。
- **SSH Shell 标签页**：基于 `russh`，支持密码与私钥（Ed25519 / RSA）认证、真实 PTY 请求、随窗口变化发送 window-change，并在握手时记录服务器密钥指纹。
- **串口控制台标签页**：基于 `serialport`，支持端口枚举（含 USB VID/PID 与产品字符串）、可配置波特率/数据位/停止位/校验位/流控，以及可选的带时间戳 HEX 原始日志落盘。窗格上的 `HEX` 开关可切换到十六进制视图（`0D 0A 41  |..A|`），并接受十六进制输入以发送原始字节。
- **SFTP 后端**：`sftp_connect`、`sftp_list_dir`、`sftp_upload`、`sftp_download`、`sftp_close`，上传下载采用流式传输而非整文件缓冲。侧栏浏览器可从已保存的 SSH 连接打开，支持目录导航与上传下载并回显字节数。
- **已保存连接**：应用配置目录下的 SQLite（WAL）保存名称、类型与连接参数；密码与口令写入系统钥匙串，磁盘上只保留钥匙串条目名。侧栏一键重连。
- **SSH 主机密钥固定**：首次接触记录指纹，之后每次连接都要求一致，不一致则握手失败，并在错误中同时给出已固定与实际收到的指纹。设置面板会列出全部已固定的密钥，便于核对或遗忘。
- **Agent Runtime + 可见步骤时间线**：模型负责规划，Runtime 在写入终端**之前**发出 `ToolRequested`（含完整命令行与风险等级），执行后发出 `ToolFinished`（含退出码、耗时与屏幕输出）；推理模型的思考增量实时流出。
- **审批闸门接到界面**：Ask/Supervised/Autonomous 与全局策略同源，被拦截的命令弹出批准/拒绝，拒绝的命令绝不写入终端。
- **风险分类不再能被参数绕过**：未知程序按「改状态」处理，不透明解释器（`sh -c`、`python -c`、`osascript -e`）与危险参数（`find -delete`、`rsync --delete`、`sed -i`、`git clean -fd`、`--force`）按「破坏性」处理，命令替换也不会让一段命令停留在只读。
- **人工输入优先**：Agent 运行时在终端里打字会立即中止循环、拒绝所有待批命令并交回写锁，同时提供全局 `Esc` 接管；状态栏始终显示当前控制权归属。
- **运行历史**：每次运行连同完整事件流存入 SQLite，切换标签页后仍可回放与审计，而不是凭空消失。
- **单步执行模式**：打开后每条命令（包括 `ls`）都要先批准，适合想一步步盯着看而不是一次交付整段计划。
- **`Ctrl+K` 快捷命令浮层**：一句话描述任务，先看到生成的命令再决定是否写入终端——只写入不带换行，按不按 Enter 仍由你决定。
- **上下文有上限**：交给模型的工具输出被截断（8k 字符，保留首尾），嘈杂的构建日志不会挤掉任务本身。
- **Provider 可切换**：设置面板可选 deepseek-flash、deepseek-v4-pro，或本地探测到的 Ollama / LM Studio 模型；选择存 SQLite，各 provider 的密钥存系统钥匙串。
- **16ms 输出聚合**：传输读取按每拍合并为一帧（上限 256 KB），以 base64 送到 WebView，再用流式 `TextDecoder` 解码，保证跨帧被切开的多字节中文字符不损坏。
- **影子屏幕**：每个会话维护一个 `vt100` 解析器，同步接收与窗格相同的字节，向 Agent 侧提供无 ANSI 噪声的纯文本、光标位置与历史滚动。
- **xterm.js 6 + WebGL 渲染器**，创建上下文失败时自动降级为 DOM 渲染器（WebKitGTK 场景），并配置等宽字体栈使 CJK 双宽字符与西里尔单宽字符严格对齐。
- **三栏工作台**：左侧会话栏（含自动探测到的 Shell）、中间多标签终端区、可折叠的 Agent 面板，以及展示 Shell、网格尺寸、自治模式、界面语言与会话数的状态栏。
- **六语言 UI**：启动时经 Rust 侧 `sys-locale` 读取系统语言自动选择，并可在设置面板中随时手动切换。
- **权限策略**：Ask / Supervised / Autonomous 三档，配合只读、改状态、破坏性三档命令风险分类。已接入面板并通过测试；消费它的 Agent 循环在阶段二落地。

## 架构

| 路径 | 职责 |
| --- | --- |
| `crates/term-core` | `TerminalTransport` Trait、16ms `StreamBatcher`、`vt100` 影子屏幕、本地 PTY、SSH Shell、SFTP 客户端与串口传输 |
| `crates/term-agent` | 流式 OpenAI 兼容客户端、本地端点探测、权限策略与命令风险、工具目录、`AgentRuntime` 步骤循环，以及把 Tauri 与 UI 挡在门外的 `AgentTerminal`/`Approver`/`StreamSink` 端口 |
| `apps/desktop/src-tauri` | Tauri 命令、会话注册表、输出扇出到 WebView、语言探测 |
| `apps/desktop/src` | React 19 + TypeScript 界面、xterm.js 窗格、i18next 资源 |

所有会话类型共用同一个 Trait，因此 UI 与 Agent 都不必按传输类型分支：

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

## 开发

```bash
cargo check --workspace          # 整个工作区的编译闸门
cargo test --workspace           # 54 个测试，含真实 /bin/sh PTY 回环
DEEPSEEK_API_KEY=sk-... cargo test -p term-agent --test deepseek_runtime -- --ignored --nocapture
                                 # 真实模型 + 真实 PTY：创建并校验文件
cd apps/desktop
npm run typecheck                # tsc --noEmit
npm run build                    # 类型检查 + vite 生产构建
```

提交信息遵循 [AGENTS.md](AGENTS.md) 中的 Conventional Commits 规范；按子模块拆成原子提交，且必须 `cargo check --workspace` 与 `npm run typecheck` 双零错误后才允许提交。

## 尚未完成

- 更完整的密钥管理界面（目前只能为选中 provider 粘贴密钥，删除/轮换请走系统钥匙串应用）。
- 跨任务的对话历史：每个任务从新会话开始（已运行的记录可回放，但不会作为上下文喂回模型）。
- 串口快捷连接入口。
- 真实 SSH / SFTP / 串口会话未在验证环境中对接真实硬件；失败路径（端口关闭、设备不存在、无硬件时的枚举）已有测试覆盖，成功路径仍需真实服务器与串口对。**pty 不是替代品**：`serialport` 会向设备索取调制解调器控制线，伪终端以 `ENOTTY` 拒绝，因此这条回环方案被放弃，而不是留成一个跳过状态的测试；钥匙串路径也只对账号命名做了单元测试，因为验证时写入真实 Keychain 会留下凭据。
- Agent Runtime 已对真实模型端到端验证，但界面时间线本身只经过类型检查、生产构建与启动冒烟。
- 尚未发布 release：`.app` 仅本地构建，未签名、未公证。

## 打包

```bash
cd apps/desktop
npm run tauri build -- --bundles app
```

产出 `target/release/bundle/macos/Open Terminal Agent.app`（macOS arm64 上 11.9 MiB）。
已实际启动该 bundle 并确认能拉起本地 Shell，说明 release 构建内嵌了前端资源，
`tauri dev` 之外的 IPC 与 PTY 路径同样成立。Windows 与 Linux 的 bundle 未在此构建。

## 人工验收清单

`docs/manual-checks.md` 是被自动化闸门覆盖不到的部分的验收清单：分屏、审批、HEX 视图、
SFTP 传输、provider 切换、打包产物。每行给出步骤、期望结果与「实际结果」空格，便于
逐项勾选。

## 已知历史限制

提交 `a668408`（SFTP 后端那一切片）早于之后的一行 clippy 修复，单独 checkout
会挂 `cargo clippy -D warnings`。`main` 本身是绿的，CI 门禁针对 push 与 PR 而非
历史提交，因此只有恰好检出那一个提交时才会遇到。三次脚本化 rebase 尝试都因后续提交
依赖它而冲突；`backup-before-rebase`、`backup-pre-rebase2`、`backup-pre-squash`
三个分支已保留，将来若值得，仍可手工修复这段历史。

## 持续集成

每次推送都会跑 `.github/workflows/ci.yml`：`cargo fmt --check`、
`cargo clippy --workspace --all-targets -- -D warnings`、`cargo test --workspace`，
以及前端的 `npm run typecheck` 与 `npm run build`。本地验证用的就是同一组命令。

## 许可证

Apache License 2.0 —— 见 [LICENSE](LICENSE)。
