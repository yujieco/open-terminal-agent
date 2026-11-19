// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

//! Command risk classification and the per-session control arbitration that
//! decides when the agent may write to a terminal without asking a human.

use serde::{Deserialize, Serialize};

use crate::error::{AgentError, Result};

/// User-selectable autonomy level for one session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PermissionMode {
    /// Every write needs an explicit approval.
    Ask,
    /// Read-only inspection runs freely; state changes need approval.
    #[default]
    Supervised,
    /// Commands run until the task finishes or the step budget runs out.
    Autonomous,
}

/// Who currently owns the terminal write lock.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlState {
    /// The human owns the keyboard.
    #[default]
    Human,
    /// The agent loop is executing steps.
    AgentRunning,
    /// The agent stopped and waits for an approval decision.
    WaitingApproval,
}

/// How dangerous a command is considered to be.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CommandRisk {
    /// Inspection only; cannot change state.
    ReadOnly,
    /// Changes state but is recoverable.
    Mutating,
    /// Destructive, hardware level or irreversible.
    Destructive,
}

/// Outcome of a policy evaluation for one command.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PolicyDecision {
    /// Safe to run without interrupting the user.
    AutoApprove,
    /// Pause the loop and surface an approve/reject prompt.
    RequiresApproval,
}

/// Programs that only read state.
const READ_ONLY_PROGRAMS: &[&str] = &[
    "ls",
    "cat",
    "head",
    "tail",
    "ps",
    "df",
    "du",
    "ip",
    "ifconfig",
    "dmesg",
    "uname",
    "whoami",
    "id",
    "pwd",
    "free",
    "top",
    "htop",
    "grep",
    "find",
    "stat",
    "file",
    "wc",
    "date",
    "env",
    "printenv",
    "hostname",
    "uptime",
    "netstat",
    "ss",
    "ping",
    "traceroute",
    "tree",
    "less",
    "more",
    "man",
    "which",
    "echo",
    "lsblk",
    "lsof",
    "vm_stat",
    "sw_vers",
    "ioreg",
];

/// Programs that can destroy data, kill processes or reflash hardware.
const DESTRUCTIVE_PROGRAMS: &[&str] = &[
    "rm", "rmdir", "unlink", "dd", "fdisk", "wipefs", "shred", "truncate", "mkfs", "flashrom",
    "reboot", "shutdown", "halt", "poweroff", "kill", "killall", "pkill", "chmod", "chown",
    "chgrp", "mount", "umount",
];

/// Substrings that mark a command as destructive even when the program name is
/// wrapped (`sudo mkfs.ext4`, `dd if=... of=/dev/sda`).
const DESTRUCTIVE_FRAGMENTS: &[&str] = &[
    "mkfs", "dd if=", "of=/dev/", "rm -rf /", "flashrom", "wipefs", "shutdown", "poweroff", ":(){",
];

/// Wrappers that elevate whatever they run.
const ELEVATION_PROGRAMS: &[&str] = &["sudo", "doas", "su"];

/// Git subcommands that never mutate the repository.
const READ_ONLY_GIT_SUBCOMMANDS: &[&str] = &[
    "status",
    "log",
    "diff",
    "show",
    "branch",
    "remote",
    "rev-parse",
    "describe",
    "blame",
];

/// `systemctl` subcommands that only report state.
const READ_ONLY_SYSTEMCTL_SUBCOMMANDS: &[&str] = &[
    "status",
    "list-units",
    "list-unit-files",
    "list",
    "show",
    "is-active",
    "is-enabled",
];

/// Classifies a full command line, including pipes and `&&` chains.
///
/// A chain is only as safe as its riskiest segment, so the maximum risk wins.
pub fn classify_command(command: &str) -> CommandRisk {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return CommandRisk::ReadOnly;
    }

    let mut risk = CommandRisk::ReadOnly;
    for segment in trimmed.split([';', '\n', '|', '&']) {
        let segment = segment.trim();
        if segment.is_empty() {
            continue;
        }
        risk = risk.max(classify_segment(segment));
        if risk == CommandRisk::Destructive {
            return CommandRisk::Destructive;
        }
    }
    risk
}

fn classify_segment(segment: &str) -> CommandRisk {
    let lower = segment.to_ascii_lowercase();

    // Serial debug consoles speak AT commands, which never touch the shell.
    if lower == "at" || lower.starts_with("at+") {
        return CommandRisk::ReadOnly;
    }

    if DESTRUCTIVE_FRAGMENTS
        .iter()
        .any(|fragment| lower.contains(fragment))
    {
        return CommandRisk::Destructive;
    }

    let mut tokens = segment.split_whitespace();
    let first = match tokens.next() {
        Some(token) => base_name(token),
        None => return CommandRisk::ReadOnly,
    };

    let (program, escalated) = if ELEVATION_PROGRAMS.contains(&first.as_str()) {
        match tokens.next() {
            Some(token) => (base_name(token), true),
            None => return CommandRisk::Mutating,
        }
    } else {
        (first, false)
    };

    let rest: Vec<String> = tokens.map(|token| token.to_ascii_lowercase()).collect();

    let mut risk = if program == "git" {
        match rest.first().map(String::as_str) {
            Some(subcommand) if READ_ONLY_GIT_SUBCOMMANDS.contains(&subcommand) => {
                CommandRisk::ReadOnly
            }
            _ => CommandRisk::Mutating,
        }
    } else if program == "systemctl" || program == "launchctl" {
        match rest.first().map(String::as_str) {
            Some(subcommand) if READ_ONLY_SYSTEMCTL_SUBCOMMANDS.contains(&subcommand) => {
                CommandRisk::ReadOnly
            }
            _ => CommandRisk::Mutating,
        }
    } else if DESTRUCTIVE_PROGRAMS.contains(&program.as_str()) {
        CommandRisk::Destructive
    } else if READ_ONLY_PROGRAMS.contains(&program.as_str()) {
        CommandRisk::ReadOnly
    } else {
        CommandRisk::Mutating
    };

    // Redirection writes to disk even when the program itself only reads.
    if risk == CommandRisk::ReadOnly && (lower.contains(" >>") || lower.contains(" >")) {
        risk = CommandRisk::Mutating;
    }

    if escalated {
        risk.max(CommandRisk::Mutating)
    } else {
        risk
    }
}

fn base_name(token: &str) -> String {
    token
        .rsplit('/')
        .next()
        .unwrap_or(token)
        .to_ascii_lowercase()
}

/// Per-session policy and control arbitration.
#[derive(Debug, Clone)]
pub struct SessionPolicy {
    mode: PermissionMode,
    control: ControlState,
}

impl Default for SessionPolicy {
    fn default() -> Self {
        Self {
            mode: PermissionMode::default(),
            control: ControlState::default(),
        }
    }
}

impl SessionPolicy {
    /// Creates a policy in `Human` control with the given autonomy mode.
    pub fn new(mode: PermissionMode) -> Self {
        Self {
            mode,
            control: ControlState::default(),
        }
    }

    /// Current autonomy mode.
    pub fn mode(&self) -> PermissionMode {
        self.mode
    }

    /// Switches autonomy mode; allowed at any time, including mid-run.
    pub fn set_mode(&mut self, mode: PermissionMode) {
        self.mode = mode;
    }

    /// Current control owner.
    pub fn control(&self) -> ControlState {
        self.control
    }

    /// Hands the write lock to the agent loop.
    pub fn begin_run(&mut self) -> Result<()> {
        match self.control {
            ControlState::Human | ControlState::WaitingApproval => {
                self.control = ControlState::AgentRunning;
                Ok(())
            }
            ControlState::AgentRunning => Err(AgentError::ControlTransition(
                "agent loop is already running",
            )),
        }
    }

    /// Parks the loop until a human answers an approval prompt.
    pub fn await_approval(&mut self) -> Result<()> {
        match self.control {
            ControlState::AgentRunning => {
                self.control = ControlState::WaitingApproval;
                Ok(())
            }
            ControlState::Human => Err(AgentError::ControlTransition("agent loop is not running")),
            ControlState::WaitingApproval => Ok(()),
        }
    }

    /// Emergency stop: always returns the cookie to the human, whatever the
    /// current state was.
    pub fn take_over(&mut self) {
        self.control = ControlState::Human;
    }

    /// Finishes a run and returns the write lock to the human.
    pub fn finish_run(&mut self) {
        self.control = ControlState::Human;
    }

    /// Decides whether one command may run without asking.
    pub fn decide(&self, command: &str) -> PolicyDecision {
        match self.mode {
            PermissionMode::Ask => PolicyDecision::RequiresApproval,
            PermissionMode::Autonomous => PolicyDecision::AutoApprove,
            PermissionMode::Supervised => match classify_command(command) {
                CommandRisk::ReadOnly => PolicyDecision::AutoApprove,
                CommandRisk::Mutating | CommandRisk::Destructive => {
                    PolicyDecision::RequiresApproval
                }
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_read_only_inspection() {
        assert_eq!(classify_command("ls -la /tmp"), CommandRisk::ReadOnly);
        assert_eq!(
            classify_command("ps aux | grep node"),
            CommandRisk::ReadOnly
        );
        assert_eq!(classify_command("git status"), CommandRisk::ReadOnly);
        assert_eq!(classify_command("AT+CSQ"), CommandRisk::ReadOnly);
        assert_eq!(classify_command("   "), CommandRisk::ReadOnly);
    }

    #[test]
    fn classifies_state_changes() {
        assert_eq!(classify_command("npm install"), CommandRisk::Mutating);
        assert_eq!(
            classify_command("echo hi > notes.txt"),
            CommandRisk::Mutating
        );
        assert_eq!(classify_command("sudo ls"), CommandRisk::Mutating);
    }

    #[test]
    fn classifies_destructive_commands() {
        assert_eq!(
            classify_command("rm -rf /tmp/build"),
            CommandRisk::Destructive
        );
        assert_eq!(
            classify_command("sudo mkfs.ext4 /dev/sda1"),
            CommandRisk::Destructive
        );
        assert_eq!(
            classify_command("dd if=/dev/zero of=/dev/sda"),
            CommandRisk::Destructive
        );
        assert_eq!(classify_command("ls && reboot"), CommandRisk::Destructive);
    }

    #[test]
    fn supervised_mode_gates_only_state_changes() {
        let policy = SessionPolicy::new(PermissionMode::Supervised);
        assert_eq!(policy.decide("ls"), PolicyDecision::AutoApprove);
        assert_eq!(
            policy.decide("rm -rf build"),
            PolicyDecision::RequiresApproval
        );
    }

    #[test]
    fn ask_mode_gates_everything() {
        let policy = SessionPolicy::new(PermissionMode::Ask);
        assert_eq!(policy.decide("ls"), PolicyDecision::RequiresApproval);
    }

    #[test]
    fn autonomous_mode_never_asks() {
        let policy = SessionPolicy::new(PermissionMode::Autonomous);
        assert_eq!(policy.decide("reboot"), PolicyDecision::AutoApprove);
    }

    #[test]
    fn take_over_returns_control_from_any_state() {
        let mut policy = SessionPolicy::new(PermissionMode::Supervised);
        policy.begin_run().expect("run starts");
        policy.await_approval().expect("waits");
        assert_eq!(policy.control(), ControlState::WaitingApproval);

        policy.take_over();
        assert_eq!(policy.control(), ControlState::Human);
        assert!(policy.begin_run().is_ok());
    }
}
