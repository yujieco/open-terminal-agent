// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

//! Local shell transport backed by `portable-pty`, available on macOS,
//! Windows and Linux through one code path.

use std::io::{ErrorKind, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use async_trait::async_trait;
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tokio::sync::{broadcast, mpsc};

use crate::error::{CoreError, Result};
use crate::transport::{
    CHUNK_CHANNEL_CAPACITY, OUTPUT_CHANNEL_CAPACITY, SessionId, StreamBatcher, TerminalOutput,
    TerminalTransport, generate_session_id,
};

/// Bytes pulled from the PTY per blocking read.
const READ_BUFFER_BYTES: usize = 8 * 1024;

/// Terminal type advertised to the shell so TUI apps emit 256-color output.
const TERM_VALUE: &str = "xterm-256color";

/// Describes the shell a local session should run.
#[derive(Debug, Clone)]
pub struct PtyConfig {
    /// Shell binary. Defaults to [`default_shell`].
    pub shell: Option<String>,
    /// Extra arguments passed to the shell.
    pub args: Vec<String>,
    /// Working directory; inherits the app cwd when `None`.
    pub cwd: Option<String>,
    /// Additional environment variables.
    pub env: Vec<(String, String)>,
    /// Initial column count.
    pub cols: u16,
    /// Initial row count.
    pub rows: u16,
}

impl PtyConfig {
    /// Builds a config that runs the platform default shell.
    pub fn new(cols: u16, rows: u16) -> Self {
        Self {
            shell: None,
            args: Vec::new(),
            cwd: None,
            env: Vec::new(),
            cols,
            rows,
        }
    }

    /// Overrides the shell binary.
    pub fn with_shell(mut self, shell: impl Into<String>) -> Self {
        self.shell = Some(shell.into());
        self
    }

    /// Overrides the working directory.
    pub fn with_cwd(mut self, cwd: impl Into<String>) -> Self {
        self.cwd = Some(cwd.into());
        self
    }

    /// Adds one environment variable.
    pub fn with_env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.env.push((key.into(), value.into()));
        self
    }

    /// Shell binary this config will run.
    pub fn resolved_shell(&self) -> String {
        self.shell.clone().unwrap_or_else(default_shell)
    }
}

/// Shell that the platform normally starts for an interactive terminal.
pub fn default_shell() -> String {
    #[cfg(windows)]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_owned())
    }
    #[cfg(target_os = "macos")]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_owned())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_owned())
    }
}

/// A live local shell session.
pub struct PtyTransport {
    session_id: SessionId,
    shell: String,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    output: broadcast::Sender<TerminalOutput>,
    closed: AtomicBool,
}

impl PtyTransport {
    /// Spawns a shell and returns the transport alone.
    pub async fn spawn(config: PtyConfig) -> Result<Self> {
        let (transport, _output) = Self::spawn_with_output(config).await?;
        Ok(transport)
    }

    /// Spawns a shell and returns an output subscription created before the
    /// first byte can flow, so no banner or prompt is lost.
    pub async fn spawn_with_output(
        config: PtyConfig,
    ) -> Result<(Self, broadcast::Receiver<TerminalOutput>)> {
        let session_id = generate_session_id("local");
        let shell = config.resolved_shell();

        let pty_system = native_pty_system();
        let size = PtySize {
            rows: config.rows.max(1),
            cols: config.cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        };
        let pair = pty_system
            .openpty(size)
            .map_err(|error| CoreError::PtySpawn(error.to_string()))?;

        let mut command = CommandBuilder::new(&shell);
        for arg in &config.args {
            command.arg(arg);
        }
        if let Some(cwd) = &config.cwd {
            command.cwd(cwd);
        }
        for (key, value) in &config.env {
            command.env(key, value);
        }
        command.env("TERM", TERM_VALUE);
        command.env("COLORTERM", "truecolor");
        command.env("CLICOLOR", "1");
        command.env("TERM_PROGRAM", "OpenTerminalAgent");

        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| CoreError::PtySpawn(error.to_string()))?;

        // The slave handle must drop so the child sees EOF once the master closes.
        drop(pair.slave);

        let writer = pair
            .master
            .take_writer()
            .map_err(|error| CoreError::PtyIo(error.to_string()))?;
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| CoreError::PtyIo(error.to_string()))?;

        let (output, output_rx) = broadcast::channel(OUTPUT_CHANNEL_CAPACITY);
        let (chunk_tx, chunk_rx) = mpsc::channel::<Vec<u8>>(CHUNK_CHANNEL_CAPACITY);

        let batcher = StreamBatcher::new(session_id.clone(), chunk_rx, output.clone());
        tokio::spawn(async move {
            batcher.run().await;
        });

        let reader_name = format!("ota-pty-reader-{}", session_id.as_str());
        thread::Builder::new()
            .name(reader_name)
            .spawn(move || {
                let mut buffer = [0u8; READ_BUFFER_BYTES];
                loop {
                    match reader.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(read) => {
                            if chunk_tx.blocking_send(buffer[..read].to_vec()).is_err() {
                                break;
                            }
                        }
                        Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                        Err(error) => {
                            tracing::debug!(%error, "pty reader stopped");
                            break;
                        }
                    }
                }
            })
            .map_err(|error| CoreError::PtySpawn(error.to_string()))?;

        let transport = Self {
            session_id,
            shell,
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            output,
            closed: AtomicBool::new(false),
        };

        Ok((transport, output_rx))
    }

    /// Shell binary backing this session.
    pub fn shell(&self) -> &str {
        &self.shell
    }

    /// Whether [`close`](TerminalTransport::close) already ran.
    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Relaxed)
    }
}

#[async_trait]
impl TerminalTransport for PtyTransport {
    fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    async fn write_bytes(&self, data: &[u8]) -> Result<()> {
        if self.is_closed() {
            return Err(CoreError::SessionClosed(
                self.session_id.as_str().to_owned(),
            ));
        }
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| CoreError::WriterUnavailable)?;
        writer
            .write_all(data)
            .map_err(|error| CoreError::PtyIo(error.to_string()))?;
        writer
            .flush()
            .map_err(|error| CoreError::PtyIo(error.to_string()))
    }

    async fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        if cols == 0 || rows == 0 {
            return Err(CoreError::InvalidGeometry { cols, rows });
        }
        let master = self
            .master
            .lock()
            .map_err(|_| CoreError::PtyIo("pty master lock poisoned".to_owned()))?;
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| CoreError::PtyIo(error.to_string()))
    }

    fn subscribe_output(&self) -> broadcast::Receiver<TerminalOutput> {
        self.output.subscribe()
    }

    async fn close(&self) -> Result<()> {
        if self.closed.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        let mut child = self
            .child
            .lock()
            .map_err(|_| CoreError::PtyIo("pty child lock poisoned".to_owned()))?;
        child
            .kill()
            .map_err(|error| CoreError::PtyIo(error.to_string()))?;
        Ok(())
    }
}

impl Drop for PtyTransport {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            // The shell may already be gone; a failed kill is not actionable.
            let _ = child.kill();
        }
    }
}

/// Shared handle type used by session registries.
pub type SharedPtyTransport = Arc<PtyTransport>;

#[cfg(unix)]
#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn echoes_through_a_real_shell() {
        let (transport, mut output) = PtyTransport::spawn_with_output(
            PtyConfig::new(80, 24)
                .with_shell("/bin/sh")
                .with_env("PS1", "$ "),
        )
        .await
        .expect("spawn pty");

        transport
            .write_bytes(b"echo ota-ready\r")
            .await
            .expect("write");

        let mut seen = String::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while tokio::time::Instant::now() < deadline {
            match tokio::time::timeout(Duration::from_millis(250), output.recv()).await {
                Ok(Ok(frame)) => {
                    seen.push_str(&frame.to_utf8_lossy());
                    if seen.contains("ota-ready") {
                        break;
                    }
                }
                Ok(Err(_)) => break,
                Err(_) => continue,
            }
        }

        assert!(
            seen.contains("ota-ready"),
            "shell output should round-trip, got {seen:?}"
        );
        transport.close().await.expect("close");
    }
}
