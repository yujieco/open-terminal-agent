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

/// Interpreters whose payload we cannot inspect, so any use counts as
/// destructive: `sh -c ...`, `python -c ...`, `osascript -e ...`.
const OPAQUE_INTERPRETERS: &[&str] = &[
    "sh",
    "bash",
    "zsh",
    "dash",
    "ksh",
    "python",
    "python3",
    "perl",
    "ruby",
    "node",
    "osascript",
    "eval",
    "source",
];

/// Flags that turn an otherwise read-only program into a destructive one,
/// found empirically: `find -delete` was previously classified read-only.
const DANGEROUS_FLAGS: &[&str] = &[
    "-delete",
    "-exec",
    "-execdir",
    "-ok",
    "--delete",
    "--remove-files",
    "--no-preserve-root",
    "--remove-destination",
    "--force",
    "--hard",
];

/// Wrappers that elevate whatever they run.
const ELEVATION_PROGRAMS: &[&str] = &["sudo", "doas", "su"];

/// Transparent execution wrappers whose target program is the real command.
const WRAPPER_PROGRAMS: &[&str] = &[
    "env", "nohup", "nice", "time", "command", "builtin", "stdbuf",
];

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
/// Segment splitting respects single/double quotes and backslash escapes so
/// literals like `grep "a|b" app.log` stay intact.
pub fn classify_command(command: &str) -> CommandRisk {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return CommandRisk::ReadOnly;
    }

    let mut risk = CommandRisk::ReadOnly;
    for segment in split_shell_segments(trimmed) {
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

/// Splits a shell command line on unquoted `;`, `\n`, `|`, and `&`.
fn split_shell_segments(command: &str) -> Vec<String> {
    let mut segments = Vec::new();
    let mut current = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut escaped = false;

    for ch in command.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }
        if !in_single && ch == '\\' {
            current.push(ch);
            escaped = true;
            continue;
        }
        if !in_double && ch == '\'' {
            in_single = !in_single;
            current.push(ch);
            continue;
        }
        if !in_single && ch == '"' {
            in_double = !in_double;
            current.push(ch);
            continue;
        }
        if !in_single && !in_double && matches!(ch, ';' | '\n' | '|' | '&') {
            if !current.trim().is_empty() {
                segments.push(std::mem::take(&mut current));
            } else {
                current.clear();
            }
            continue;
        }
        current.push(ch);
    }

    if !current.trim().is_empty() {
        segments.push(current);
    }
    segments
}

/// Tokenizes one shell segment while preserving quote boundaries, and reports
/// whether an unquoted redirection (`>`, `>>`) or expandable command
/// substitution (`$(...)`, backticks) was observed.
fn scan_segment(segment: &str) -> (Vec<String>, bool, bool) {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut escaped = false;
    let mut has_redirect = false;
    let mut has_substitution = false;

    let chars: Vec<char> = segment.chars().collect();
    let mut idx = 0;
    while idx < chars.len() {
        let ch = chars[idx];
        if escaped {
            current.push(ch);
            escaped = false;
            idx += 1;
            continue;
        }
        if !in_single && ch == '\\' {
            escaped = true;
            idx += 1;
            continue;
        }
        if !in_double && ch == '\'' {
            in_single = !in_single;
            idx += 1;
            continue;
        }
        if !in_single && ch == '"' {
            in_double = !in_double;
            idx += 1;
            continue;
        }

        // Command substitutions execute outside single quotes (including inside
        // double quotes in POSIX shells).
        if !in_single && (ch == '`' || (ch == '$' && chars.get(idx + 1) == Some(&'('))) {
            has_substitution = true;
        }

        // Unquoted `>` or `>>` redirects output to disk, even with no spaces
        // around the operator (e.g. `echo hi>out.txt` or `cmd 2>err.log`).
        if !in_single && !in_double && ch == '>' {
            has_redirect = true;
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
            idx += 1;
            continue;
        }

        if !in_single && !in_double && ch.is_whitespace() {
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
            idx += 1;
            continue;
        }

        current.push(ch);
        idx += 1;
    }

    if !current.is_empty() {
        tokens.push(current);
    }

    (tokens, has_redirect, has_substitution)
}

fn is_env_assignment(token: &str) -> bool {
    let Some((name, _)) = token.split_once('=') else {
        return false;
    };
    !name.is_empty()
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
        && !name.starts_with(|ch: char| ch.is_ascii_digit())
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

    let (tokens, has_redirect, has_substitution) = scan_segment(segment);
    let mut index = 0;

    // Skip leading `VAR=val` assignments so `LANG=C rm -rf /tmp/x` is not
    // misclassified as an unknown program.
    while index < tokens.len() && is_env_assignment(&tokens[index]) {
        index += 1;
    }

    let mut escalated = false;
    while index < tokens.len() {
        let candidate = base_name(&tokens[index]);
        if ELEVATION_PROGRAMS.contains(&candidate.as_str()) {
            escalated = true;
            index += 1;
            // Skip flags belonging to sudo/doas (e.g. `sudo -u root`).
            while index < tokens.len() && tokens[index].starts_with('-') {
                let flag = &tokens[index];
                index += 1;
                if matches!(flag.as_str(), "-u" | "-g" | "-C" | "-p" | "-h") && index < tokens.len()
                {
                    index += 1;
                }
            }
            continue;
        }
        if WRAPPER_PROGRAMS.contains(&candidate.as_str()) {
            index += 1;
            while index < tokens.len()
                && (tokens[index].starts_with('-') || is_env_assignment(&tokens[index]))
            {
                index += 1;
            }
            continue;
        }
        break;
    }

    let program = match tokens.get(index) {
        Some(token) => base_name(token),
        None => {
            return if escalated {
                CommandRisk::Mutating
            } else {
                CommandRisk::ReadOnly
            };
        }
    };

    let rest: Vec<String> = tokens[index + 1..]
        .iter()
        .map(|token| token.to_ascii_lowercase())
        .collect();

    // Code we cannot read is code we cannot vouch for.
    if OPAQUE_INTERPRETERS.contains(&program.as_str()) {
        return CommandRisk::Destructive;
    }

    // `xargs` invokes an arbitrary target command on stdin items.
    if program == "xargs" {
        let target = rest
            .iter()
            .find(|token| !token.starts_with('-'))
            .map(|token| base_name(token));
        return match target.as_deref() {
            Some(cmd)
                if DESTRUCTIVE_PROGRAMS.contains(&cmd)
                    || OPAQUE_INTERPRETERS.contains(&cmd)
                    || ELEVATION_PROGRAMS.contains(&cmd) =>
            {
                CommandRisk::Destructive
            }
            _ => CommandRisk::Mutating,
        };
    }

    // `awk` can spawn arbitrary commands via `system(...)`.
    if matches!(program.as_str(), "awk" | "gawk" | "nawk" | "mawk") && lower.contains("system(") {
        return CommandRisk::Destructive;
    }

    // A read-only program becomes destructive when it carries a flag that
    // deletes or overwrites, e.g. `find . -delete`.
    if rest
        .iter()
        .any(|token| DANGEROUS_FLAGS.contains(&token.as_str()))
    {
        return CommandRisk::Destructive;
    }

    // `sed -i` edits files in place; the short flag needs its own rule because
    // `-i` is also used for "case insensitive" elsewhere.
    if program == "sed"
        && rest
            .iter()
            .any(|token| token == "-i" || token == "--in-place" || token.starts_with("-i'"))
    {
        return CommandRisk::Destructive;
    }

    // `git clean -fd` and friends discard work irreversibly.
    if program == "git" && rest.first().map(String::as_str) == Some("clean") {
        return CommandRisk::Destructive;
    }

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

    // Unquoted redirection writes to disk even when the program itself only reads.
    if risk == CommandRisk::ReadOnly && has_redirect {
        risk = CommandRisk::Mutating;
    }

    // Command substitution hides a second command inside a read-only one:
    // `ls $(rm -rf x)` must not look like `ls`.
    if risk == CommandRisk::ReadOnly && has_substitution {
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
#[derive(Debug, Clone, Default)]
pub struct SessionPolicy {
    mode: PermissionMode,
    control: ControlState,
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
    fn read_only_programs_with_destructive_flags_are_destructive() {
        assert_eq!(
            classify_command("find /tmp -delete"),
            CommandRisk::Destructive
        );
        assert_eq!(
            classify_command("find . -name '*.log' -exec rm {} +"),
            CommandRisk::Destructive
        );
        assert_eq!(
            classify_command("rsync -a --delete a/ b/"),
            CommandRisk::Destructive
        );
        assert_eq!(
            classify_command("tar --remove-files -cf a.tar x"),
            CommandRisk::Destructive
        );
        assert_eq!(
            classify_command("sed -i '' s/a/b/ f.txt"),
            CommandRisk::Destructive
        );
        assert_eq!(classify_command("git clean -fd"), CommandRisk::Destructive);
        assert_eq!(
            classify_command("git push --force origin main"),
            CommandRisk::Destructive
        );
    }

    #[test]
    fn opaque_interpreters_are_destructive() {
        assert_eq!(
            classify_command("sh -c 'rm -rf /tmp/x'"),
            CommandRisk::Destructive
        );
        assert_eq!(
            classify_command("python3 -c \"import shutil; shutil.rmtree('/tmp/x')\""),
            CommandRisk::Destructive
        );
        assert_eq!(
            classify_command("osascript -e 'quit app'"),
            CommandRisk::Destructive
        );
    }

    #[test]
    fn command_substitution_is_not_read_only() {
        assert_eq!(
            classify_command("ls $(cat /etc/hosts)"),
            CommandRisk::Mutating
        );
        assert_eq!(classify_command("echo `rm -rf x`"), CommandRisk::Mutating);
        // Plain read-only commands must stay read-only.
        assert_eq!(classify_command("ls -la"), CommandRisk::ReadOnly);
        assert_eq!(
            classify_command("grep -i error app.log"),
            CommandRisk::ReadOnly
        );
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

    #[test]
    fn handles_quotes_unspaced_redirects_and_wrappers() {
        // Quoted operators must not break a read-only command.
        assert_eq!(
            classify_command("grep \"error|warn\" app.log"),
            CommandRisk::ReadOnly
        );
        assert_eq!(
            classify_command("grep 'a>b' app.log"),
            CommandRisk::ReadOnly
        );
        // Unspaced redirection still writes to disk.
        assert_eq!(classify_command("echo hi>notes.txt"), CommandRisk::Mutating);
        assert_eq!(
            classify_command("cat /etc/hosts>>copy.txt"),
            CommandRisk::Mutating
        );
        // Transparent wrappers and env assignments cannot mask destructive commands.
        assert_eq!(
            classify_command("LANG=C rm -rf /tmp/test"),
            CommandRisk::Destructive
        );
        assert_eq!(
            classify_command("env rm -rf /tmp/test"),
            CommandRisk::Destructive
        );
        assert_eq!(
            classify_command("nohup dd if=/dev/zero of=/tmp/a"),
            CommandRisk::Destructive
        );
        assert_eq!(
            classify_command("find . -name '*.tmp' | xargs rm -f"),
            CommandRisk::Destructive
        );
        assert_eq!(
            classify_command("awk 'BEGIN { system(\"rm -rf /tmp/x\") }'"),
            CommandRisk::Destructive
        );
    }
}
