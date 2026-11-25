// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

//! Unified transport contract shared by local PTY, SSH and serial sessions,
//! plus the 16ms batcher that keeps floods of output from freezing the UI.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use std::{borrow::Cow, fmt};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, mpsc};
use tokio::time::Instant;

use crate::error::Result;

/// Interval used to coalesce transport output before it crosses the IPC bridge.
pub const STREAM_BATCH_INTERVAL: Duration = Duration::from_millis(16);

/// Upper bound of one batched frame. Sized for high-baud serial floods
/// (921600 baud is roughly 92 KB/s) so a stalled UI can never grow buffers
/// without limit.
pub const STREAM_BATCH_MAX_BYTES: usize = 256 * 1024;

/// Capacity of the per-session output broadcast channel.
pub const OUTPUT_CHANNEL_CAPACITY: usize = 512;

/// Capacity of the chunk channel feeding one [`StreamBatcher`].
pub const CHUNK_CHANNEL_CAPACITY: usize = 256;

/// Stable identifier of one terminal session.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SessionId(String);

impl SessionId {
    /// Wraps an existing identifier.
    pub fn new(raw: impl Into<String>) -> Self {
        Self(raw.into())
    }

    /// Borrows the identifier as a string slice.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Consumes the identifier and returns the owned string.
    pub fn into_string(self) -> String {
        self.0
    }
}

impl fmt::Display for SessionId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<&str> for SessionId {
    fn from(value: &str) -> Self {
        Self(value.to_owned())
    }
}

impl From<String> for SessionId {
    fn from(value: String) -> Self {
        Self(value)
    }
}

/// Counter-backed session id, unique within one process run.
pub fn generate_session_id(prefix: &str) -> SessionId {
    static SESSION_COUNTER: AtomicU64 = AtomicU64::new(1);
    let ordinal = SESSION_COUNTER.fetch_add(1, Ordering::Relaxed);
    SessionId::new(format!("{prefix}-{ordinal:04}"))
}

/// One batched frame of transport output.
#[derive(Debug, Clone)]
pub struct TerminalOutput {
    /// Session that produced the bytes.
    pub session_id: SessionId,
    /// Monotonic frame counter, starting at 1.
    pub sequence: u64,
    /// Raw bytes, exactly as the transport delivered them.
    pub bytes: Vec<u8>,
}

impl TerminalOutput {
    /// Number of bytes in this frame.
    pub fn len(&self) -> usize {
        self.bytes.len()
    }

    /// Whether the frame carries no bytes.
    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }

    /// Lossy UTF-8 view, for logging and tests only.
    pub fn to_utf8_lossy(&self) -> Cow<'_, str> {
        String::from_utf8_lossy(&self.bytes)
    }
}

/// Lifecycle events emitted by a transport.
#[derive(Debug, Clone)]
pub enum TransportEvent {
    /// A batched frame of output arrived.
    Output(TerminalOutput),
    /// The underlying process or connection ended.
    Exited {
        /// Session that ended.
        session_id: SessionId,
    },
}

/// The single abstraction every session type implements.
///
/// Local PTYs, SSH channels and serial ports all move bytes, expose a
/// resizable grid and stream output through the same batcher, so the UI and
/// the agent never branch on the transport kind.
#[async_trait]
pub trait TerminalTransport: Send + Sync {
    /// Identifier of this session.
    fn session_id(&self) -> &SessionId;

    /// Writes raw bytes to the remote or local side.
    async fn write_bytes(&self, data: &[u8]) -> Result<()>;

    /// Resizes the terminal grid.
    async fn resize(&self, cols: u16, rows: u16) -> Result<()>;

    /// Subscribes to batched output frames.
    fn subscribe_output(&self) -> broadcast::Receiver<TerminalOutput>;

    /// Terminates the session and releases its OS resources.
    async fn close(&self) -> Result<()>;

    /// Measures round-trip latency in milliseconds when supported by the
    /// transport (e.g. SSH in-band keepalive ping/pong).
    async fn probe_latency(&self) -> Result<Option<u64>> {
        Ok(None)
    }

    /// Runs a short non-interactive command over an auxiliary channel when
    /// supported (e.g. SSH `exec` channel for zero-overhead server telemetry).
    async fn exec_aux(&self, _command: &str) -> Result<Option<String>> {
        Ok(None)
    }
}

/// Coalesces transport chunks into at most one frame per tick.
///
/// A terminal flood at 921600 baud produces thousands of tiny reads per
/// second. Emitting each read separately over Tauri IPC saturates the
/// WebView bridge and drops frames, so the batcher holds bytes for
/// [`STREAM_BATCH_INTERVAL`] and forwards them as one `Vec<u8>`.
pub struct StreamBatcher {
    session_id: SessionId,
    interval: Duration,
    max_bytes: usize,
    chunks: mpsc::Receiver<Vec<u8>>,
    output: broadcast::Sender<TerminalOutput>,
    sequence: u64,
}

impl StreamBatcher {
    /// Builds a batcher with the default 16ms interval and 256 KB frame cap.
    pub fn new(
        session_id: SessionId,
        chunks: mpsc::Receiver<Vec<u8>>,
        output: broadcast::Sender<TerminalOutput>,
    ) -> Self {
        Self {
            session_id,
            interval: STREAM_BATCH_INTERVAL,
            max_bytes: STREAM_BATCH_MAX_BYTES,
            chunks,
            output,
            sequence: 0,
        }
    }

    /// Overrides the batching interval (minimum 1ms).
    pub fn with_interval(mut self, interval: Duration) -> Self {
        self.interval = interval.max(Duration::from_millis(1));
        self
    }

    /// Overrides the per-frame byte cap (minimum 1 byte).
    pub fn with_max_bytes(mut self, max_bytes: usize) -> Self {
        self.max_bytes = max_bytes.max(1);
        self
    }

    /// Drains chunks until the producer disconnects, returning the number of
    /// frames emitted.
    pub async fn run(mut self) -> u64 {
        let mut pending: Vec<u8> = Vec::with_capacity(8 * 1024);
        let mut deadline: Option<Instant> = None;

        loop {
            tokio::select! {
                chunk = self.chunks.recv() => match chunk {
                    Some(bytes) => {
                        pending.extend_from_slice(&bytes);
                        if pending.len() >= self.max_bytes {
                            // Oversized burst: split immediately so latency and
                            // memory stay bounded even if the tick is late.
                            while pending.len() > self.max_bytes {
                                let rest = pending.split_off(self.max_bytes);
                                let frame = std::mem::replace(&mut pending, rest);
                                self.flush(frame);
                            }
                        }
                        if deadline.is_none() {
                            deadline = Some(Instant::now() + self.interval);
                        }
                    }
                    None => {
                        self.flush(std::mem::take(&mut pending));
                        break;
                    }
                },
                _ = wait_for(deadline) => {
                    self.flush(std::mem::take(&mut pending));
                    deadline = None;
                }
            }
        }

        self.sequence
    }

    fn flush(&mut self, bytes: Vec<u8>) {
        if bytes.is_empty() {
            return;
        }
        self.sequence += 1;
        let frame = TerminalOutput {
            session_id: self.session_id.clone(),
            sequence: self.sequence,
            bytes,
        };
        if self.output.send(frame).is_err() {
            tracing::trace!(session = %self.session_id, "terminal output frame had no subscribers");
        }
    }
}

/// Sleeps until `deadline`, or forever when no frame is pending.
async fn wait_for(deadline: Option<Instant>) {
    match deadline {
        Some(instant) => tokio::time::sleep_until(instant).await,
        None => std::future::pending().await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn channel() -> (
        mpsc::Sender<Vec<u8>>,
        broadcast::Sender<TerminalOutput>,
        broadcast::Receiver<TerminalOutput>,
    ) {
        let (chunk_tx, chunk_rx) = mpsc::channel(CHUNK_CHANNEL_CAPACITY);
        let (out_tx, out_rx) = broadcast::channel(OUTPUT_CHANNEL_CAPACITY);
        let batcher = StreamBatcher::new(SessionId::from("test-0001"), chunk_rx, out_tx.clone());
        // Keep the batcher alive by leaking its task; the channel ends when
        // `chunk_tx` is dropped.
        tokio::spawn(batcher.with_interval(Duration::from_millis(30)).run());
        (chunk_tx, out_tx, out_rx)
    }

    #[tokio::test]
    async fn coalesces_chunks_into_one_frame() {
        let (chunk_tx, _out_tx, mut out_rx) = channel();

        chunk_tx.send(b"hel".to_vec()).await.expect("send 1");
        chunk_tx.send(b"lo ".to_vec()).await.expect("send 2");
        chunk_tx.send(b"ota".to_vec()).await.expect("send 3");
        drop(chunk_tx);

        let frame = out_rx.recv().await.expect("frame");
        assert_eq!(frame.session_id.as_str(), "test-0001");
        assert_eq!(frame.sequence, 1);
        assert_eq!(frame.bytes, b"hello ota".to_vec());
    }

    #[tokio::test]
    async fn splits_frames_above_the_byte_cap() {
        let (chunk_tx, chunk_rx) = mpsc::channel(CHUNK_CHANNEL_CAPACITY);
        let (out_tx, mut out_rx) = broadcast::channel(OUTPUT_CHANNEL_CAPACITY);
        let batcher = StreamBatcher::new(SessionId::from("test-0002"), chunk_rx, out_tx)
            .with_interval(Duration::from_millis(30))
            .with_max_bytes(4);
        tokio::spawn(batcher.run());

        chunk_tx.send(b"0123456789".to_vec()).await.expect("send");
        drop(chunk_tx);

        let mut sizes = Vec::new();
        while let Ok(frame) = out_rx.recv().await {
            sizes.push(frame.bytes.len());
            if frame.bytes == b"89".to_vec() {
                break;
            }
        }
        assert_eq!(sizes, vec![4, 4, 2]);
    }

    #[tokio::test]
    async fn flushes_pending_bytes_on_the_interval() {
        let (chunk_tx, _out_tx, mut out_rx) = channel();

        chunk_tx.send(b"tick".to_vec()).await.expect("send");
        let frame = tokio::time::timeout(Duration::from_millis(500), out_rx.recv())
            .await
            .expect("frame before timeout")
            .expect("frame");
        assert_eq!(frame.bytes, b"tick".to_vec());
    }
}
