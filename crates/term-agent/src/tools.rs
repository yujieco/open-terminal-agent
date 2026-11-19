// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

//! The three tools exposed to the model, plus the control bytes the agent may
//! send without typing a command.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::error::{AgentError, Result};

/// Reads the visible grid, cursor and scrollback tail of a session.
pub const READ_TERMINAL_SCREEN: &str = "read_terminal_screen";

/// Writes a command to the session and waits for completion.
pub const EXECUTE_COMMAND: &str = "execute_command";

/// Sends raw control bytes (Ctrl+C, Ctrl+D, Tab, raw HEX).
pub const SEND_CONTROL_SIGNAL: &str = "send_control_signal";

/// Keyboard-level signals the agent can inject.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlSignal {
    /// Ctrl+C, byte `0x03`.
    CtrlC,
    /// Ctrl+D, byte `0x04`.
    CtrlD,
    /// Ctrl+Z, byte `0x1a`.
    CtrlZ,
    /// Tab, byte `0x09`.
    Tab,
    /// Escape, byte `0x1b`.
    Escape,
    /// Carriage return, byte `0x0d`.
    Enter,
}

impl ControlSignal {
    /// Bytes to write to the transport for this signal.
    pub fn bytes(self) -> &'static [u8] {
        match self {
            Self::CtrlC => b"\x03",
            Self::CtrlD => b"\x04",
            Self::CtrlZ => b"\x1a",
            Self::Tab => b"\t",
            Self::Escape => b"\x1b",
            Self::Enter => b"\r",
        }
    }
}

/// One tool call requested by the model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolCallRequest {
    /// Tool name, one of the constants in this module.
    pub name: String,
    /// JSON arguments produced by the model.
    pub arguments: Value,
}

impl ToolCallRequest {
    /// Builds a request, normalizing a missing argument object to `{}`.
    pub fn new(name: impl Into<String>, arguments: Value) -> Self {
        let arguments = if arguments.is_null() {
            json!({})
        } else {
            arguments
        };
        Self {
            name: name.into(),
            arguments,
        }
    }

    /// Validates the name against the tools that actually exist.
    pub fn validate(&self) -> Result<()> {
        match self.name.as_str() {
            READ_TERMINAL_SCREEN | EXECUTE_COMMAND | SEND_CONTROL_SIGNAL => Ok(()),
            other => Err(AgentError::ToolFailure {
                tool: other.to_owned(),
                message: "unknown tool name".to_owned(),
            }),
        }
    }

    /// Command line carried by an `execute_command` request.
    pub fn command(&self) -> Result<&str> {
        self.arguments
            .get("command")
            .and_then(Value::as_str)
            .ok_or_else(|| AgentError::ToolFailure {
                tool: self.name.clone(),
                message: "missing string argument `command`".to_owned(),
            })
    }
}

/// JSON Schema description of one tool, sent to the model.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolSpec {
    /// Tool name.
    pub name: String,
    /// One-line description used by the model to pick the tool.
    pub description: String,
    /// JSON Schema for the arguments object.
    pub parameters: Value,
}

/// The tool catalog offered to every provider.
pub fn tool_catalog() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: READ_TERMINAL_SCREEN.to_owned(),
            description:
                "Read the visible terminal grid, cursor position and recent clean scrollback lines."
                    .to_owned(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "scrollback_lines": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 2000,
                        "description": "How many scrollback lines to include."
                    }
                },
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: EXECUTE_COMMAND.to_owned(),
            description: "Write a command to the active session and wait for it to finish."
                .to_owned(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "Command line to run, without a trailing newline."
                    },
                    "timeout_ms": {
                        "type": "integer",
                        "minimum": 100,
                        "description": "Idle or total timeout before the tool gives up."
                    }
                },
                "required": ["command"],
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: SEND_CONTROL_SIGNAL.to_owned(),
            description: "Send raw control bytes to the session, for example Ctrl+C to abort."
                .to_owned(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "signal": {
                        "type": "string",
                        "enum": ["ctrl_c", "ctrl_d", "ctrl_z", "tab", "escape", "enter"]
                    }
                },
                "required": ["signal"],
                "additionalProperties": false
            }),
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_bytes_match_the_terminal_conventions() {
        assert_eq!(ControlSignal::CtrlC.bytes(), &[0x03]);
        assert_eq!(ControlSignal::CtrlD.bytes(), &[0x04]);
        assert_eq!(ControlSignal::Tab.bytes(), b"\t");
    }

    #[test]
    fn catalog_covers_the_three_documented_tools() {
        let names: Vec<String> = tool_catalog().into_iter().map(|spec| spec.name).collect();
        assert_eq!(
            names,
            vec![
                READ_TERMINAL_SCREEN.to_owned(),
                EXECUTE_COMMAND.to_owned(),
                SEND_CONTROL_SIGNAL.to_owned()
            ]
        );
    }

    #[test]
    fn validates_names_and_required_arguments() {
        assert!(
            ToolCallRequest::new(EXECUTE_COMMAND, json!({ "command": "ls" }))
                .validate()
                .is_ok()
        );
        assert!(
            ToolCallRequest::new("launch_missiles", json!({}))
                .validate()
                .is_err()
        );

        let missing = ToolCallRequest::new(EXECUTE_COMMAND, json!({}));
        assert!(missing.command().is_err());
    }
}
