// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

//! Desktop shell entry point: wires the session registry, the IPC commands and
//! the two terminal events the WebView listens to.

mod commands;
mod error;
mod locale;
mod state;

pub use error::ApiError;

/// Event carrying one batched frame of terminal output.
pub const TERMINAL_OUTPUT_EVENT: &str = "terminal://output";
/// Event emitted when a shell process ends.
pub const TERMINAL_EXIT_EVENT: &str = "terminal://exit";

/// Starts the Tauri application.
pub fn run() {
    let builder = tauri::Builder::default()
        .manage(state::SessionRegistry::default())
        .invoke_handler(tauri::generate_handler![
            commands::spawn_session,
            commands::write_session,
            commands::resize_session,
            commands::close_session,
            commands::list_sessions,
            commands::screen_snapshot,
            commands::system_locale,
            commands::shell_profiles,
            commands::agent_capabilities,
        ]);

    if let Err(error) = builder.run(tauri::generate_context!()) {
        eprintln!("open-terminal-agent exited with an error: {error}");
    }
}
