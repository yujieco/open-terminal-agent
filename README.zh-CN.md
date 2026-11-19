# Open Terminal Agent

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

[English](README.md) · 简体中文

Open Terminal Agent 是一个跨平台桌面终端模拟器，既可以直接由人操作，也可以交给 LLM Agent 驾驶。你可以自己在本地 Shell 里敲命令，也可以让 Agent 观察屏幕、按明确的权限策略执行命令并校验结果——两者共用同一个标签页，并保留随时紧急接管的口子。

核心为 Rust，外壳为 Tauri v2，界面为 React。UI 内置六种语言：`zh-CN`、`zh-TW`、`en`、`ru`、`ja`、`ko`。

**状态：阶段二进行中。** 本地 Shell、SSH Shell 与串口控制台都已能作为标签页打开，SFTP 的列目录/上传/下载也已作为命令可用。会话持久化与钥匙串凭据、流式 LLM 客户端、Agent 执行器属于后续切片；SFTP 文件浏览器界面与 HEX/UTF-8 双视图尚未实现。

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
- **串口控制台标签页**：基于 `serialport`，支持端口枚举（含 USB VID/PID 与产品字符串）、可配置波特率/数据位/停止位/校验位/流控，以及可选的带时间戳 HEX 原始日志落盘。
- **SFTP 后端**：`sftp_connect`、`sftp_list_dir`、`sftp_upload`、`sftp_download`、`sftp_close`，上传下载采用流式传输而非整文件缓冲。侧栏浏览器界面仍待接入。
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
| `crates/term-agent` | 权限策略与命令风险分类、工具目录、带步数预算的「观察→推理→执行→校验」状态机、Provider/`LlmClient` 契约、本地端点表 |
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
cargo test --workspace           # 38 个测试，含真实 /bin/sh PTY 回环
cd apps/desktop
npm run typecheck                # tsc --noEmit
npm run build                    # 类型检查 + vite 生产构建
```

提交信息遵循 [AGENTS.md](AGENTS.md) 中的 Conventional Commits 规范；按子模块拆成原子提交，且必须 `cargo check --workspace` 与 `npm run typecheck` 双零错误后才允许提交。

## 尚未完成

- SQLite 会话库与系统钥匙串凭据存储；目前 SSH 密码按次输入，known_hosts 固定尚未强制。
- 流式 LLM 客户端、本地模型探测（目前只有端点表）与 Agent 执行器。
- SFTP 文件浏览器界面、串口 HEX/UTF-8 双视图与串口快捷连接入口。
- 真实 SSH / SFTP / 串口会话未在验证环境中对接真实硬件，仅通过编译与单元测试验证。
- 打包（`npm run tauri build`）尚未执行，也没有发布任何二进制。

## 许可证

Apache License 2.0 —— 见 [LICENSE](LICENSE)。
