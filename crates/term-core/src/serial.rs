// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

//! Cross-platform serial transport for hardware debugging: U-Boot, RTOS boards
//! and AT-command modems.
//!
//! Serial consoles have no grid, no prompt and no exit code, so the transport
//! stays byte-oriented: it reports what arrived, records a raw log when asked,
//! and leaves UTF-8 / HEX rendering to the UI.

use std::io::{ErrorKind, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serialport::{DataBits, FlowControl, Parity, StopBits};
use tokio::sync::{broadcast, mpsc};

use crate::error::{CoreError, Result};
use crate::transport::{
    CHUNK_CHANNEL_CAPACITY, OUTPUT_CHANNEL_CAPACITY, SessionId, StreamBatcher, TerminalOutput,
    TerminalTransport, generate_session_id,
};

/// Bytes pulled per blocking read.
const READ_BUFFER_BYTES: usize = 4 * 1024;

/// Per-read timeout. Short enough that a closed session stops the reader thread
/// promptly, long enough to avoid busy-spinning on an idle port.
const READ_TIMEOUT: Duration = Duration::from_millis(50);

/// Parity bit configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SerialParity {
    /// No parity bit.
    None,
    /// Odd parity.
    Odd,
    /// Even parity.
    Even,
}

impl SerialParity {
    fn to_serialport(self) -> Parity {
        match self {
            Self::None => Parity::None,
            Self::Odd => Parity::Odd,
            Self::Even => Parity::Even,
        }
    }
}

/// Stop bit configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SerialStopBits {
    /// One stop bit.
    One,
    /// Two stop bits.
    Two,
}

impl SerialStopBits {
    fn to_serialport(self) -> StopBits {
        match self {
            Self::One => StopBits::One,
            Self::Two => StopBits::Two,
        }
    }
}

/// Flow control configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SerialFlowControl {
    /// No flow control.
    None,
    /// XON/XOFF.
    Software,
    /// RTS/CTS.
    Hardware,
}

impl SerialFlowControl {
    fn to_serialport(self) -> FlowControl {
        match self {
            Self::None => FlowControl::None,
            Self::Software => FlowControl::Software,
            Self::Hardware => FlowControl::Hardware,
        }
    }
}

/// Everything needed to open one serial session.
#[derive(Debug, Clone)]
pub struct SerialConfig {
    /// Device path or COM port name, e.g. `/dev/cu.usbserial-1420`.
    pub path: String,
    /// Baud rate, e.g. 115200 or 921600.
    pub baud_rate: u32,
    /// Data bits, 5 to 8.
    pub data_bits: u8,
    /// Stop bits.
    pub stop_bits: SerialStopBits,
    /// Parity.
    pub parity: SerialParity,
    /// Flow control.
    pub flow_control: SerialFlowControl,
    /// Columns reported to the UI grid.
    pub cols: u16,
    /// Rows reported to the UI grid.
    pub rows: u16,
    /// Optional raw session log destination.
    pub log_path: Option<PathBuf>,
}

impl SerialConfig {
    /// Minimal config at 115200 8N1 with no flow control.
    pub fn new(path: impl Into<String>, baud_rate: u32) -> Self {
        Self {
            path: path.into(),
            baud_rate,
            data_bits: 8,
            stop_bits: SerialStopBits::One,
            parity: SerialParity::None,
            flow_control: SerialFlowControl::None,
            cols: 100,
            rows: 30,
            log_path: None,
        }
    }

    /// Sets the advertised grid size.
    pub fn with_grid(mut self, cols: u16, rows: u16) -> Self {
        self.cols = cols.max(1);
        self.rows = rows.max(1);
        self
    }

    /// Sets framing explicitly.
    pub fn with_framing(
        mut self,
        data_bits: u8,
        stop_bits: SerialStopBits,
        parity: SerialParity,
        flow_control: SerialFlowControl,
    ) -> Self {
        self.data_bits = data_bits;
        self.stop_bits = stop_bits;
        self.parity = parity;
        self.flow_control = flow_control;
        self
    }

    /// Records every chunk to `path` as timestamped HEX.
    pub fn with_log(mut self, path: impl Into<PathBuf>) -> Self {
        self.log_path = Some(path.into());
        self
    }

    fn data_bits_enum(&self) -> Result<DataBits> {
        Ok(match self.data_bits {
            5 => DataBits::Five,
            6 => DataBits::Six,
            7 => DataBits::Seven,
            8 => DataBits::Eight,
            other => {
                return Err(CoreError::Serial(format!("unsupported data bits: {other}")));
            }
        })
    }
}

/// Port description used by the connect dialog.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialPortDescriptor {
    /// Device path or COM port name.
    pub path: String,
    /// `usb`, `pci`, `bluetooth` or `unknown`.
    pub kind: String,
    /// USB vendor id, when the port is a USB device.
    pub vid: Option<u16>,
    /// USB product id, when the port is a USB device.
    pub pid: Option<u16>,
    /// Manufacturer string, when the driver reports one.
    pub manufacturer: Option<String>,
    /// Product string, when the driver reports one.
    pub product: Option<String>,
    /// Unique serial number, when the device exposes one.
    pub serial_number: Option<String>,
}

/// Enumerates serial ports, including USB VID/PID and description strings.
pub fn list_serial_ports() -> Result<Vec<SerialPortDescriptor>> {
    let ports =
        serialport::available_ports().map_err(|error| CoreError::Serial(error.to_string()))?;

    let mut described: Vec<SerialPortDescriptor> = ports
        .into_iter()
        .map(|port| match port.port_type {
            serialport::SerialPortType::UsbPort(info) => SerialPortDescriptor {
                path: port.port_name,
                kind: String::from("usb"),
                vid: Some(info.vid),
                pid: Some(info.pid),
                manufacturer: info.manufacturer,
                product: info.product,
                serial_number: info.serial_number,
            },
            serialport::SerialPortType::PciPort => SerialPortDescriptor {
                path: port.port_name,
                kind: String::from("pci"),
                vid: None,
                pid: None,
                manufacturer: None,
                product: None,
                serial_number: None,
            },
            serialport::SerialPortType::BluetoothPort => SerialPortDescriptor {
                path: port.port_name,
                kind: String::from("bluetooth"),
                vid: None,
                pid: None,
                manufacturer: None,
                product: None,
                serial_number: None,
            },
            serialport::SerialPortType::Unknown => SerialPortDescriptor {
                path: port.port_name,
                kind: String::from("unknown"),
                vid: None,
                pid: None,
                manufacturer: None,
                product: None,
                serial_number: None,
            },
        })
        .collect();

    described.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(described)
}

/// One open serial session.
pub struct SerialTransport {
    session_id: SessionId,
    path: String,
    baud_rate: u32,
    writer: Mutex<Box<dyn serialport::SerialPort>>,
    output: broadcast::Sender<TerminalOutput>,
    closed: Arc<AtomicBool>,
}

impl SerialTransport {
    /// Opens the port and returns the transport plus an output subscription that
    /// is created before the first byte can arrive.
    pub async fn open(config: SerialConfig) -> Result<(Self, broadcast::Receiver<TerminalOutput>)> {
        let session_id = generate_session_id("serial");
        let data_bits = config.data_bits_enum()?;

        let builder = serialport::new(config.path.clone(), config.baud_rate)
            .data_bits(data_bits)
            .stop_bits(config.stop_bits.to_serialport())
            .parity(config.parity.to_serialport())
            .flow_control(config.flow_control.to_serialport())
            .timeout(READ_TIMEOUT);

        let writer = builder
            .open()
            .map_err(|error| CoreError::Serial(error.to_string()))?;
        let mut reader = writer
            .try_clone()
            .map_err(|error| CoreError::Serial(error.to_string()))?;

        let (output, output_rx) = broadcast::channel(OUTPUT_CHANNEL_CAPACITY);
        let (chunk_tx, chunk_rx) = mpsc::channel::<Vec<u8>>(CHUNK_CHANNEL_CAPACITY);

        let batcher = StreamBatcher::new(session_id.clone(), chunk_rx, output.clone());
        tokio::spawn(async move {
            batcher.run().await;
        });

        let closed = Arc::new(AtomicBool::new(false));
        let closed_for_reader = Arc::clone(&closed);
        let log = match config.log_path.clone() {
            Some(path) => Some(SessionLog::create(&path)?),
            None => None,
        };

        let reader_name = format!("ota-serial-reader-{}", session_id.as_str());
        thread::Builder::new()
            .name(reader_name)
            .spawn(move || {
                let mut buffer = [0u8; READ_BUFFER_BYTES];
                loop {
                    if closed_for_reader.load(Ordering::Relaxed) {
                        break;
                    }
                    match reader.read(&mut buffer) {
                        Ok(0) => continue,
                        Ok(read) => {
                            let chunk = &buffer[..read];
                            if let Some(log) = &log {
                                log.record("rx", chunk);
                            }
                            if chunk_tx.blocking_send(chunk.to_vec()).is_err() {
                                break;
                            }
                        }
                        Err(error)
                            if matches!(
                                error.kind(),
                                ErrorKind::TimedOut
                                    | ErrorKind::WouldBlock
                                    | ErrorKind::Interrupted
                            ) =>
                        {
                            continue;
                        }
                        Err(error) => {
                            tracing::debug!(%error, "serial reader stopped");
                            break;
                        }
                    }
                }
            })
            .map_err(|error| CoreError::Serial(error.to_string()))?;

        let transport = Self {
            session_id,
            path: config.path,
            baud_rate: config.baud_rate,
            writer: Mutex::new(writer),
            output,
            closed,
        };

        Ok((transport, output_rx))
    }

    /// Device path backing this session.
    pub fn path(&self) -> &str {
        &self.path
    }

    /// Baud rate this session was opened with.
    pub fn baud_rate(&self) -> u32 {
        self.baud_rate
    }
}

#[async_trait]
impl TerminalTransport for SerialTransport {
    fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    async fn write_bytes(&self, data: &[u8]) -> Result<()> {
        if self.closed.load(Ordering::Relaxed) {
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
            .map_err(|error| CoreError::Serial(error.to_string()))?;
        writer
            .flush()
            .map_err(|error| CoreError::Serial(error.to_string()))
    }

    async fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        // A serial console has no way to learn about a resize; the UI just keeps
        // its own grid. Rejecting zero sizes keeps snapshot geometry sane.
        if cols == 0 || rows == 0 {
            return Err(CoreError::InvalidGeometry { cols, rows });
        }
        Ok(())
    }

    fn subscribe_output(&self) -> broadcast::Receiver<TerminalOutput> {
        self.output.subscribe()
    }

    async fn close(&self) -> Result<()> {
        self.closed.store(true, Ordering::SeqCst);
        Ok(())
    }
}

/// Timestamped raw HEX log for serial debugging.
struct SessionLog {
    file: Mutex<std::fs::File>,
}

impl SessionLog {
    fn create(path: &std::path::Path) -> Result<Self> {
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|error| CoreError::Serial(error.to_string()))?;
        Ok(Self {
            file: Mutex::new(file),
        })
    }

    fn record(&self, direction: &str, bytes: &[u8]) {
        let elapsed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or_default();
        let line = format!("[{elapsed}] {direction} {}\n", hex_line(bytes));
        if let Ok(mut file) = self.file.lock() {
            let _ = file.write_all(line.as_bytes());
            let _ = file.flush();
        }
    }
}

/// Renders bytes as space separated upper-case HEX pairs.
pub fn hex_line(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 3);
    for (index, byte) in bytes.iter().enumerate() {
        if index > 0 {
            out.push(' ');
        }
        out.push_str(&format!("{byte:02X}"));
    }
    out
}

/// Parses `AT`, `0D 0A` or `0d0a` style HEX input into raw bytes.
pub fn parse_hex(input: &str) -> Result<Vec<u8>> {
    let cleaned: String = input
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect();
    let cleaned = cleaned.replace("0x", "").replace("0X", "");
    if !cleaned.len().is_multiple_of(2) {
        return Err(CoreError::Serial(String::from(
            "hex input needs an even number of digits",
        )));
    }

    let mut bytes = Vec::with_capacity(cleaned.len() / 2);
    let chars: Vec<char> = cleaned.chars().collect();
    for pair in chars.chunks(2) {
        let text: String = pair.iter().collect();
        let byte = u8::from_str_radix(&text, 16)
            .map_err(|_| CoreError::Serial(format!("invalid hex pair `{text}`")))?;
        bytes.push(byte);
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_line_is_uppercase_and_spaced() {
        assert_eq!(hex_line(b"\x0d\x0a\x41"), "0D 0A 41");
        assert_eq!(hex_line(b""), "");
    }

    #[test]
    fn parse_hex_accepts_common_notations() {
        assert_eq!(parse_hex("0D 0A").expect("spaced"), vec![0x0d, 0x0a]);
        assert_eq!(parse_hex("0d0a").expect("compact"), vec![0x0d, 0x0a]);
        assert_eq!(
            parse_hex("0x41,0x42".replace(',', "").as_str()).expect("prefixed"),
            vec![0x41, 0x42]
        );
    }

    #[test]
    fn parse_hex_rejects_bad_input() {
        assert!(parse_hex("0D0").is_err());
        assert!(parse_hex("zz").is_err());
    }

    #[test]
    fn rejects_unsupported_data_bits() {
        let config = SerialConfig::new("/dev/null", 115200).with_framing(
            9,
            SerialStopBits::One,
            SerialParity::None,
            SerialFlowControl::None,
        );
        assert!(config.data_bits_enum().is_err());
    }

    #[test]
    fn serial_config_defaults_to_8n1() {
        let config = SerialConfig::new("/dev/cu.usbserial", 921600);
        assert_eq!(config.data_bits, 8);
        assert_eq!(config.stop_bits, SerialStopBits::One);
        assert_eq!(config.parity, SerialParity::None);
        assert_eq!(config.flow_control, SerialFlowControl::None);
        assert_eq!(config.cols, 100);
    }
}
