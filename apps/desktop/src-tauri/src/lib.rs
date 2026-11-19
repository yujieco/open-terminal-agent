// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

//! Desktop shell entry point: wires the registries, the IPC commands and the
//! terminal events the WebView listens to.

mod agent;
mod commands;
mod error;
mod locale;
mod secrets;
mod state;
mod store;

pub use error::ApiError;

/// Event carrying one batched frame of terminal output.
pub const TERMINAL_OUTPUT_EVENT: &str = "terminal://output";
/// Event emitted when a shell process or remote connection ends.
pub const TERMINAL_EXIT_EVENT: &str = "terminal://exit";

/// Starts the Tauri application.
pub fn run() {
    let builder = tauri::Builder::default()
        .manage(state::SessionRegistry::default())
        .manage(state::SftpRegistry::default())
        .manage(secrets::SecretStore::new())
        .manage(std::sync::Arc::new(agent::AgentControl::default()))
        .setup(|app| {
            use tauri::Manager as _;
            let directory = app
                .path()
                .app_config_dir()
                .map_err(|error| -> Box<dyn std::error::Error> { Box::new(error) })?;
            let store = store::Store::open(&directory.join("sessions.db"))
                .map_err(|error| -> Box<dyn std::error::Error> { Box::new(error) })?;
            app.manage(store);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::spawn_session,
            commands::connect_ssh,
            commands::open_serial,
            commands::write_session,
            commands::resize_session,
            commands::close_session,
            commands::list_sessions,
            commands::screen_snapshot,
            commands::serial_ports,
            commands::system_locale,
            commands::shell_profiles,
            commands::agent_capabilities,
            commands::sftp_connect,
            commands::sftp_list_dir,
            commands::sftp_download,
            commands::sftp_upload,
            commands::sftp_close,
            commands::sftp_connect_saved,
            commands::save_ssh_session,
            commands::list_saved_sessions,
            commands::delete_saved_session,
            commands::connect_saved_session,
            commands::llm_status,
            commands::save_llm_key,
            commands::save_llm_config,
            commands::discover_models,
            commands::suggest_command,
            commands::list_known_hosts,
            commands::forget_host_key,
            commands::probe_ssh_host_key,
            commands::agent_run,
            commands::agent_cancel,
            commands::agent_approve,
            commands::agent_event_names,
            commands::write_keystrokes,
            commands::write_session_bytes,
            commands::list_agent_runs,
            commands::get_agent_run,
        ]);

    if let Err(error) = builder.run(tauri::generate_context!()) {
        eprintln!("open-terminal-agent exited with an error: {error}");
    }
}
