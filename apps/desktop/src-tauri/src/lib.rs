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

use std::fs;
use std::path::{Path, PathBuf};

/// Folder name inside the platform config root (e.g.
/// `~/Library/Application Support/EnaviloOTA` on macOS, `%APPDATA%\EnaviloOTA`
/// on Windows, `~/.config/EnaviloOTA` on Linux).
const CONFIG_DIR_NAME: &str = "EnaviloOTA";

/// Legacy config folder name from v0.1.0–v0.1.4 kept for one-time migration.
const LEGACY_CONFIG_DIR_NAME: &str = "co.yujie.open-terminal-agent";

/// Resolves the app's persistent config directory (`<config_root>/EnaviloOTA`)
/// and performs a non-destructive one-time copy of `sessions.db` from the
/// legacy `co.yujie.open-terminal-agent` folder when present.
fn resolve_config_dir(app: &tauri::App) -> Result<PathBuf, Box<dyn std::error::Error>> {
    use tauri::Manager as _;

    if let Ok(config_root) = app.path().config_dir() {
        let target = config_root.join(CONFIG_DIR_NAME);
        let legacy = config_root.join(LEGACY_CONFIG_DIR_NAME);
        if let Err(error) = migrate_legacy_database(&target, &legacy) {
            eprintln!("EnaviloOTA legacy database migration skipped: {error}");
        }
        return Ok(target);
    }

    app.path()
        .app_config_dir()
        .map_err(|error| -> Box<dyn std::error::Error> { Box::new(error) })
}

/// Copies `sessions.db` (and SQLite WAL/SHM sidecars if present) from
/// `legacy_dir` into `target_dir` when `target_dir/sessions.db` does not exist.
fn migrate_legacy_database(target_dir: &Path, legacy_dir: &Path) -> std::io::Result<bool> {
    let target_db = target_dir.join("sessions.db");
    let legacy_db = legacy_dir.join("sessions.db");
    if target_db.exists() || !legacy_db.is_file() {
        return Ok(false);
    }

    fs::create_dir_all(target_dir)?;
    for name in ["sessions.db", "sessions.db-wal", "sessions.db-shm"] {
        let src = legacy_dir.join(name);
        if src.is_file() {
            fs::copy(&src, target_dir.join(name))?;
        }
    }
    Ok(true)
}

/// Starts the Tauri application.
pub fn run() {
    let builder = tauri::Builder::default();

    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build());

    let builder = builder
        .manage(state::SessionRegistry::default())
        .manage(state::SftpRegistry::default())
        .manage(state::TunnelRegistry::default())
        .manage(secrets::SecretStore::new())
        .manage(std::sync::Arc::new(agent::AgentControl::default()))
        .setup(|app| {
            use tauri::Manager as _;
            let directory = resolve_config_dir(app)?;
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
            commands::session::probe_session_latency,
            commands::session::probe_server_metrics,
            commands::session::serial_ports,
            commands::session::system_locale,
            commands::session::shell_profiles,
            commands::session::default_export_dir,
            commands::session::export_session_log,
            commands::session::reveal_in_folder,
            commands::sftp::sftp_connect,
            commands::sftp::sftp_connect_saved,
            commands::sftp::sftp_list_dir,
            commands::sftp::sftp_download,
            commands::sftp::sftp_upload,
            commands::sftp::sftp_upload_bytes,
            commands::sftp::sftp_mkdir,
            commands::sftp::sftp_delete,
            commands::sftp::sftp_rename,
            commands::sftp::sftp_read_text,
            commands::sftp::sftp_write_text,
            commands::sftp::sftp_close,
            commands::tunnel::list_tunnels,
            commands::tunnel::save_tunnel,
            commands::tunnel::delete_tunnel,
            commands::tunnel::start_tunnel,
            commands::tunnel::stop_tunnel,
            commands::store::save_ssh_session,
            commands::store::list_saved_sessions,
            commands::store::delete_saved_session,
            commands::store::connect_saved_session,
            commands::store::scan_ssh_config,
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
            commands::agent::delete_agent_run,
            commands::agent::clear_agent_runs,
            updater::check_for_updates,
            updater::install_and_relaunch_update,
            updater::open_external_url,
        ]);

    if let Err(error) = builder.run(tauri::generate_context!()) {
        eprintln!("open-terminal-agent exited with an error: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "enavilo-ota-test-{label}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).expect("create temp test dir");
        dir
    }

    #[test]
    fn migrates_legacy_sessions_db_and_sidecars_once() {
        let root = unique_temp_dir("migrate");
        let legacy = root.join(LEGACY_CONFIG_DIR_NAME);
        let target = root.join(CONFIG_DIR_NAME);
        fs::create_dir_all(&legacy).expect("create legacy dir");
        fs::write(legacy.join("sessions.db"), b"sqlite-main").expect("write db");
        fs::write(legacy.join("sessions.db-wal"), b"sqlite-wal").expect("write wal");

        let migrated = migrate_legacy_database(&target, &legacy).expect("migrate");
        assert!(migrated);
        assert_eq!(
            fs::read(target.join("sessions.db")).expect("read target db"),
            b"sqlite-main"
        );
        assert_eq!(
            fs::read(target.join("sessions.db-wal")).expect("read target wal"),
            b"sqlite-wal"
        );

        // Subsequent runs must not overwrite the new database.
        fs::write(target.join("sessions.db"), b"updated-new").expect("overwrite new db");
        let migrated_again = migrate_legacy_database(&target, &legacy).expect("second check");
        assert!(!migrated_again);
        assert_eq!(
            fs::read(target.join("sessions.db")).expect("read preserved db"),
            b"updated-new"
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn migration_is_noop_without_legacy_database() {
        let root = unique_temp_dir("noop");
        let legacy = root.join(LEGACY_CONFIG_DIR_NAME);
        let target = root.join(CONFIG_DIR_NAME);

        let migrated = migrate_legacy_database(&target, &legacy).expect("noop");
        assert!(!migrated);
        assert!(!target.exists());

        let _ = fs::remove_dir_all(&root);
    }
}
