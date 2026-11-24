// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

//! Desktop shell entry point: wires the registries, the IPC commands and the
//! terminal streams the WebView listens to.

mod agent;
mod commands;
mod error;
mod locale;
mod secrets;
mod shell_integration;
mod state;
mod store;
mod updater;

pub use error::ApiError;

/// Starts the Tauri application.
pub fn run() {
    let builder = tauri::Builder::default();

    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build());

    let builder = builder
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
            let shell_integration = shell_integration::ShellIntegration::init(&directory)
                .map_err(|error| -> Box<dyn std::error::Error> { Box::new(error) })?;
            app.manage(store);
            app.manage(shell_integration);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::session::spawn_session,
            commands::session::connect_ssh,
            commands::session::open_serial,
            commands::session::write_session,
            commands::session::write_keystrokes,
            commands::session::write_session_bytes,
            commands::session::resize_session,
            commands::session::close_session,
            commands::session::list_sessions,
            commands::session::screen_snapshot,
            commands::session::serial_ports,
            commands::session::system_locale,
            commands::session::shell_profiles,
            commands::sftp::sftp_connect,
            commands::sftp::sftp_connect_saved,
            commands::sftp::sftp_list_dir,
            commands::sftp::sftp_download,
            commands::sftp::sftp_upload,
            commands::sftp::sftp_close,
            commands::store::save_ssh_session,
            commands::store::list_saved_sessions,
            commands::store::delete_saved_session,
            commands::store::connect_saved_session,
            commands::store::list_known_hosts,
            commands::store::forget_host_key,
            commands::store::probe_ssh_host_key,
            commands::store::list_snippets,
            commands::store::save_snippet,
            commands::store::delete_snippet,
            commands::store::bump_snippet_usage,
            commands::agent::agent_capabilities,
            commands::agent::llm_status,
            commands::agent::save_llm_key,
            commands::agent::save_llm_config,
            commands::agent::discover_models,
            commands::agent::suggest_command,
            commands::agent::suggest_next_task,
            commands::agent::agent_run,
            commands::agent::agent_cancel,
            commands::agent::agent_approve,
            commands::agent::agent_event_names,
            commands::agent::list_agent_runs,
            commands::agent::get_agent_run,
            updater::check_for_updates,
            updater::install_and_relaunch_update,
            updater::open_external_url,
        ]);

    if let Err(error) = builder.run(tauri::generate_context!()) {
        eprintln!("open-terminal-agent exited with an error: {error}");
    }
}
