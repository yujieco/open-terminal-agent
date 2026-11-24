// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

//! Invisible OSC 133 shell integration so the terminal pane can highlight prompt
//! lines with a crisp left-gutter marker without injecting ugly characters or
//! emojis into the user's prompt text.

use std::fs;
use std::path::{Path, PathBuf};

use term_core::PtyConfig;

use crate::error::ApiError;

const ZSHENV_SHIM: &str = r#"# Open Terminal Agent zsh shim
_ota_orig="${OTA_ORIG_ZDOTDIR:-$HOME}"
[[ -r "$_ota_orig/.zshenv" ]] && source "$_ota_orig/.zshenv"
unset _ota_orig
"#;

const ZPROFILE_SHIM: &str = r#"# Open Terminal Agent zsh shim
_ota_orig="${OTA_ORIG_ZDOTDIR:-$HOME}"
[[ -r "$_ota_orig/.zprofile" ]] && source "$_ota_orig/.zprofile"
unset _ota_orig
"#;

const ZLOGIN_SHIM: &str = r#"# Open Terminal Agent zsh shim
_ota_orig="${OTA_ORIG_ZDOTDIR:-$HOME}"
[[ -r "$_ota_orig/.zlogin" ]] && source "$_ota_orig/.zlogin"
unset _ota_orig
"#;

const ZSHRC_SHIM: &str = r#"# Open Terminal Agent invisible OSC 133 shell integration
_ota_orig="${OTA_ORIG_ZDOTDIR:-$HOME}"
if [[ -n "${OTA_HAD_ZDOTDIR:-}" ]]; then
  export ZDOTDIR="$OTA_ORIG_ZDOTDIR"
else
  unset ZDOTDIR
fi
[[ -r "$_ota_orig/.zshrc" ]] && source "$_ota_orig/.zshrc"
unset _ota_orig

_ota_cmd_ran=""
_ota_osc133_precmd() {
  local _ota_ec=$?
  if [[ -n "$_ota_cmd_ran" ]]; then
    printf '\033]133;D;%s\007' "$_ota_ec"
    _ota_cmd_ran=""
  fi
  printf '\033]133;A\007'
}
_ota_osc133_preexec() {
  _ota_cmd_ran=1
  printf '\033]133;C\007'
}

autoload -Uz add-zsh-hook
add-zsh-hook precmd _ota_osc133_precmd
add-zsh-hook preexec _ota_osc133_preexec
"#;

const BASHRC_SHIM: &str = r#"# Open Terminal Agent invisible OSC 133 shell integration
[[ -r /etc/profile ]] && source /etc/profile
if [[ -r "$HOME/.bash_profile" ]]; then
  source "$HOME/.bash_profile"
elif [[ -r "$HOME/.profile" ]]; then
  source "$HOME/.profile"
fi
[[ -r "$HOME/.bashrc" ]] && source "$HOME/.bashrc"

_ota_osc133_ready=""
_ota_osc133_prompt() {
  local _ota_ec=$?
  if [[ -n "$_ota_osc133_ready" ]]; then
    printf '\033]133;D;%s\007' "$_ota_ec"
  fi
  _ota_osc133_ready=1
  printf '\033]133;A\007'
}

if [[ -n "${PROMPT_COMMAND:-}" ]]; then
  PROMPT_COMMAND="_ota_osc133_prompt; ${PROMPT_COMMAND}"
else
  PROMPT_COMMAND="_ota_osc133_prompt"
fi
"#;

/// Holds paths to the generated OSC 133 shell integration shims.
#[derive(Debug, Clone)]
pub struct ShellIntegration {
    zsh_dir: PathBuf,
    bash_rc: PathBuf,
}

impl ShellIntegration {
    /// Initializes the shell integration shim directory.
    pub fn init(app_config_dir: &Path) -> Result<Self, ApiError> {
        let base = app_config_dir.join("shell-integration");
        let zsh_dir = base.join("zsh");
        fs::create_dir_all(&zsh_dir).map_err(|error| {
            ApiError::InvalidRequest(format!("could not create shell integration dir: {error}"))
        })?;

        write_if_changed(&zsh_dir.join(".zshenv"), ZSHENV_SHIM)?;
        write_if_changed(&zsh_dir.join(".zprofile"), ZPROFILE_SHIM)?;
        write_if_changed(&zsh_dir.join(".zshrc"), ZSHRC_SHIM)?;
        write_if_changed(&zsh_dir.join(".zlogin"), ZLOGIN_SHIM)?;

        let bash_rc = base.join("bashrc.sh");
        write_if_changed(&bash_rc, BASHRC_SHIM)?;

        Ok(Self { zsh_dir, bash_rc })
    }

    /// Configures `PtyConfig` with invisible OSC 133 hooks for zsh and bash.
    #[cfg(unix)]
    pub fn attach_to_pty(&self, config: &mut PtyConfig) {
        let resolved = config.resolved_shell();

        if resolved.ends_with("/zsh") || resolved == "zsh" {
            if let Ok(existing) = std::env::var("ZDOTDIR") {
                config
                    .env
                    .push((String::from("OTA_ORIG_ZDOTDIR"), existing));
                config
                    .env
                    .push((String::from("OTA_HAD_ZDOTDIR"), String::from("1")));
            }
            config.env.push((
                String::from("ZDOTDIR"),
                self.zsh_dir.to_string_lossy().into_owned(),
            ));
            config.args.push(String::from("-l"));
        } else if resolved.ends_with("/bash") || resolved == "bash" {
            config.args.push(String::from("--rcfile"));
            config
                .args
                .push(self.bash_rc.to_string_lossy().into_owned());
            config.args.push(String::from("-i"));
        } else if resolved.ends_with("/fish") || resolved == "fish" {
            config.args.push(String::from("-l"));
        }
    }

    #[cfg(not(unix))]
    pub fn attach_to_pty(&self, _config: &mut PtyConfig) {}
}

fn write_if_changed(path: &Path, content: &str) -> Result<(), ApiError> {
    if let Ok(existing) = fs::read_to_string(path)
        && existing == content
    {
        return Ok(());
    }
    fs::write(path, content).map_err(|error| {
        ApiError::InvalidRequest(format!(
            "could not write shell integration file {}: {error}",
            path.display()
        ))
    })
}
