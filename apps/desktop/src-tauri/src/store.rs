// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

//! SQLite storage for saved connections and pinned SSH host keys.
//!
//! Secrets never land here: a saved session stores only a `secret_ref` naming an
//! OS keyring entry, so a stolen database file leaks no credentials.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

/// Storage failures surfaced to the UI.
#[derive(Debug, Error)]
pub enum StoreError {
    /// SQLite rejected a statement or the file could not be opened.
    #[error("storage failure: {0}")]
    Sqlite(String),
    /// A payload could not be encoded or decoded.
    #[error("payload encoding failed: {0}")]
    Encoding(String),
}

impl From<rusqlite::Error> for StoreError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error.to_string())
    }
}

impl From<serde_json::Error> for StoreError {
    fn from(error: serde_json::Error) -> Self {
        Self::Encoding(error.to_string())
    }
}

/// One saved connection as the sidebar renders it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSession {
    /// Stable identifier.
    pub id: String,
    /// User provided display name.
    pub name: String,
    /// `local`, `ssh` or `serial`.
    pub kind: String,
    /// Connection parameters without any secret material.
    pub payload: Value,
    /// Keyring account name holding the secret, when one was remembered.
    pub secret_ref: Option<String>,
    /// Creation time in milliseconds since the Unix epoch.
    pub created_at: i64,
    /// Last update time in milliseconds since the Unix epoch.
    pub updated_at: i64,
}

/// Values needed to insert or replace a saved session.
#[derive(Debug, Clone)]
pub struct NewSavedSession {
    /// Display name.
    pub name: String,
    /// Connection kind.
    pub kind: String,
    /// Connection parameters without secrets.
    pub payload: Value,
    /// Keyring account name, when a secret was stored.
    pub secret_ref: Option<String>,
}

/// One finished (or aborted) agent run, used to replay the timeline.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunRecord {
    /// Stable identifier.
    pub id: String,
    /// Session the run belonged to.
    pub session_id: String,
    /// Task typed by the user.
    pub task: String,
    /// Autonomy mode in force.
    pub mode: String,
    /// Model that answered.
    pub model: String,
    /// `completed`, `stepBudget`, `cancelled` or `failed`.
    pub status: String,
    /// Number of commands that actually ran.
    pub commands: u32,
    /// Milliseconds since the Unix epoch.
    pub started_at: i64,
    /// Milliseconds since the Unix epoch, when the run ended.
    pub finished_at: Option<i64>,
    /// Serialized `AgentEvent` sequence, replayed by the panel.
    pub events: Value,
}

/// Compact row used by the run history list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunSummary {
    /// Stable identifier.
    pub id: String,
    /// Session the run belonged to.
    pub session_id: String,
    /// Task typed by the user.
    pub task: String,
    /// Autonomy mode in force.
    pub mode: String,
    /// Model that answered.
    pub model: String,
    /// Outcome label.
    pub status: String,
    /// Number of commands that actually ran.
    pub commands: u32,
    /// Milliseconds since the Unix epoch.
    pub started_at: i64,
    /// Milliseconds since the Unix epoch, when the run ended.
    pub finished_at: Option<i64>,
}

/// One pinned SSH host key.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHost {
    /// Hostname or IP address.
    pub host: String,
    /// Port the key belongs to.
    pub port: u16,
    /// SHA-256 fingerprint that was pinned.
    pub fingerprint: String,
    /// Milliseconds since the Unix epoch.
    pub first_seen: i64,
}

/// Values needed to persist a finished run.
#[derive(Debug, Clone)]
pub struct NewAgentRun {
    /// Session the run belonged to.
    pub session_id: String,
    /// Task typed by the user.
    pub task: String,
    /// Autonomy mode in force.
    pub mode: String,
    /// Model that answered.
    pub model: String,
    /// Outcome label.
    pub status: String,
    /// Number of commands that actually ran.
    pub commands: u32,
    /// Run start, milliseconds since the Unix epoch.
    pub started_at: i64,
    /// Run end, milliseconds since the Unix epoch.
    pub finished_at: i64,
    /// Serialized `AgentEvent` sequence.
    pub events: Value,
}

/// One user-favorited command snippet shown in the right-hand command handbook.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandSnippet {
    /// Stable identifier.
    pub id: String,
    /// Human-friendly alias, e.g. "Check port 8080".
    pub alias: String,
    /// Exact shell command pasted into the terminal on click.
    pub command: String,
    /// Optional grouping label, e.g. "network", "docker", "logs".
    pub category: String,
    /// Optional short note.
    pub description: String,
    /// Number of times the user pasted this snippet.
    pub usage_count: u32,
    /// Creation time in milliseconds since the Unix epoch.
    pub created_at: i64,
    /// Last update time in milliseconds since the Unix epoch.
    pub updated_at: i64,
}

/// Values needed to create or update a command snippet.
#[derive(Debug, Clone)]
pub struct NewCommandSnippet {
    /// Existing id when updating, or `None` when creating a new snippet.
    pub id: Option<String>,
    /// Human-friendly alias.
    pub alias: String,
    /// Exact shell command.
    pub command: String,
    /// Category label.
    pub category: String,
    /// Short note.
    pub description: String,
}

/// One saved SSH port-forwarding rule.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedTunnel {
    /// Stable identifier.
    pub id: String,
    /// Friendly rule name, e.g. "Prod MySQL".
    pub name: String,
    /// Saved SSH session id this tunnel connects through.
    pub session_id: String,
    /// Forwarding kind: `local`, `remote`, or `dynamic`.
    pub kind: String,
    /// Listen host (`127.0.0.1` by default).
    pub bind_host: String,
    /// Listen port.
    pub bind_port: u16,
    /// Target host (`127.0.0.1` for local/remote; empty for dynamic SOCKS5).
    pub target_host: String,
    /// Target port (`0` for dynamic SOCKS5).
    pub target_port: u16,
    /// Creation time in milliseconds since the Unix epoch.
    pub created_at: i64,
    /// Last update time in milliseconds since the Unix epoch.
    pub updated_at: i64,
}

/// Values needed to create or update a saved SSH tunnel rule.
#[derive(Debug, Clone)]
pub struct NewSavedTunnel {
    /// Existing id when updating, or `None` when creating a new rule.
    pub id: Option<String>,
    /// Friendly rule name.
    pub name: String,
    /// Saved SSH session id.
    pub session_id: String,
    /// Forwarding kind (`local`, `remote`, or `dynamic`).
    pub kind: String,
    /// Listen host.
    pub bind_host: String,
    /// Listen port.
    pub bind_port: u16,
    /// Target host.
    pub target_host: String,
    /// Target port.
    pub target_port: u16,
}

/// Handle to the local database. Cloning is cheap and keeps the same file.
#[derive(Clone)]
pub struct Store {
    connection: Arc<Mutex<Connection>>,
}

impl Store {
    /// Opens (and migrates) the database at `path`.
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| StoreError::Sqlite(error.to_string()))?;
        }
        let connection = Connection::open(path)?;
        Self::from_connection(connection)
    }

    /// Opens an in-memory database, used by tests.
    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self, StoreError> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(connection: Connection) -> Result<Self, StoreError> {
        let store = Self {
            connection: Arc::new(Mutex::new(connection)),
        };
        store.migrate()?;
        Ok(store)
    }

    fn migrate(&self) -> Result<(), StoreError> {
        let connection = self.lock()?;
        connection.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS saved_sessions (
                 id TEXT PRIMARY KEY,
                 name TEXT NOT NULL,
                 kind TEXT NOT NULL,
                 payload TEXT NOT NULL,
                 secret_ref TEXT,
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS known_hosts (
                 host TEXT NOT NULL,
                 port INTEGER NOT NULL,
                 fingerprint TEXT NOT NULL,
                 first_seen INTEGER NOT NULL,
                 PRIMARY KEY (host, port)
             );
             CREATE TABLE IF NOT EXISTS agent_runs (
                 id TEXT PRIMARY KEY,
                 session_id TEXT NOT NULL,
                 task TEXT NOT NULL,
                 mode TEXT NOT NULL,
                 model TEXT NOT NULL,
                 status TEXT NOT NULL,
                 commands INTEGER NOT NULL DEFAULT 0,
                 started_at INTEGER NOT NULL,
                 finished_at INTEGER,
                 events TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS agent_runs_by_session
                 ON agent_runs (session_id, started_at DESC);
             CREATE TABLE IF NOT EXISTS settings (
                 key TEXT PRIMARY KEY,
                 value TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS command_snippets (
                 id TEXT PRIMARY KEY,
                 alias TEXT NOT NULL,
                 command TEXT NOT NULL,
                 category TEXT NOT NULL DEFAULT 'general',
                 description TEXT NOT NULL DEFAULT '',
                 usage_count INTEGER NOT NULL DEFAULT 0,
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS ssh_tunnels (
                 id TEXT PRIMARY KEY,
                 name TEXT NOT NULL,
                 session_id TEXT NOT NULL,
                 kind TEXT NOT NULL,
                 bind_host TEXT NOT NULL DEFAULT '127.0.0.1',
                 bind_port INTEGER NOT NULL,
                 target_host TEXT NOT NULL DEFAULT '127.0.0.1',
                 target_port INTEGER NOT NULL DEFAULT 0,
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL
             );
             PRAGMA user_version = 5;",
        )?;
        Ok(())
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>, StoreError> {
        self.connection
            .lock()
            .map_err(|_| StoreError::Sqlite(String::from("database lock poisoned")))
    }

    /// Inserts a saved session, generating its id and timestamps.
    pub fn save(&self, draft: NewSavedSession) -> Result<SavedSession, StoreError> {
        let id = crate::commands::new_stored_id();
        let now = now_millis();
        let payload = serde_json::to_string(&draft.payload)?;

        self.lock()?.execute(
            "INSERT INTO saved_sessions (id, name, kind, payload, secret_ref, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, draft.name, draft.kind, payload, draft.secret_ref, now, now],
        )?;

        Ok(SavedSession {
            id,
            name: draft.name,
            kind: draft.kind,
            payload: draft.payload,
            secret_ref: draft.secret_ref,
            created_at: now,
            updated_at: now,
        })
    }

    /// Updates an existing saved session in place while preserving its id and
    /// `created_at` timestamp (so linked SSH tunnels remain intact).
    pub fn update_session(
        &self,
        id: &str,
        draft: NewSavedSession,
    ) -> Result<Option<SavedSession>, StoreError> {
        let Some(existing) = self.get(id)? else {
            return Ok(None);
        };
        let now = now_millis();
        let payload = serde_json::to_string(&draft.payload)?;
        self.lock()?.execute(
            "UPDATE saved_sessions
             SET name = ?2, kind = ?3, payload = ?4, secret_ref = ?5, updated_at = ?6
             WHERE id = ?1",
            params![id, draft.name, draft.kind, payload, draft.secret_ref, now],
        )?;
        Ok(Some(SavedSession {
            id: existing.id,
            name: draft.name,
            kind: draft.kind,
            payload: draft.payload,
            secret_ref: draft.secret_ref,
            created_at: existing.created_at,
            updated_at: now,
        }))
    }

    /// Lists saved sessions, newest first.
    pub fn list(&self) -> Result<Vec<SavedSession>, StoreError> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT id, name, kind, payload, secret_ref, created_at, updated_at
             FROM saved_sessions ORDER BY updated_at DESC",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
            ))
        })?;

        let mut sessions = Vec::new();
        for row in rows {
            let (id, name, kind, payload, secret_ref, created_at, updated_at) = row?;
            sessions.push(SavedSession {
                id,
                name,
                kind,
                payload: serde_json::from_str(&payload)?,
                secret_ref,
                created_at,
                updated_at,
            });
        }
        Ok(sessions)
    }

    /// Returns one saved session by id.
    pub fn get(&self, id: &str) -> Result<Option<SavedSession>, StoreError> {
        let connection = self.lock()?;
        let row = connection
            .query_row(
                "SELECT id, name, kind, payload, secret_ref, created_at, updated_at
                 FROM saved_sessions WHERE id = ?1",
                params![id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, i64>(5)?,
                        row.get::<_, i64>(6)?,
                    ))
                },
            )
            .optional()?;

        match row {
            None => Ok(None),
            Some((id, name, kind, payload, secret_ref, created_at, updated_at)) => {
                Ok(Some(SavedSession {
                    id,
                    name,
                    kind,
                    payload: serde_json::from_str(&payload)?,
                    secret_ref,
                    created_at,
                    updated_at,
                }))
            }
        }
    }

    /// Deletes one saved session, returning whether a row was removed.
    pub fn delete(&self, id: &str) -> Result<bool, StoreError> {
        let removed = self
            .lock()?
            .execute("DELETE FROM saved_sessions WHERE id = ?1", params![id])?;
        Ok(removed > 0)
    }

    /// Persists one finished run so the timeline can be replayed later.
    pub fn save_agent_run(&self, draft: NewAgentRun) -> Result<AgentRunRecord, StoreError> {
        let id = term_core::generate_session_id("run").into_string();
        let events = serde_json::to_string(&draft.events)?;

        self.lock()?.execute(
            "INSERT INTO agent_runs
                 (id, session_id, task, mode, model, status, commands, started_at, finished_at, events)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                id,
                draft.session_id,
                draft.task,
                draft.mode,
                draft.model,
                draft.status,
                draft.commands,
                draft.started_at,
                draft.finished_at,
                events
            ],
        )?;

        Ok(AgentRunRecord {
            id,
            session_id: draft.session_id,
            task: draft.task,
            mode: draft.mode,
            model: draft.model,
            status: draft.status,
            commands: draft.commands,
            started_at: draft.started_at,
            finished_at: Some(draft.finished_at),
            events: draft.events,
        })
    }

    /// Lists recent runs, newest first, optionally filtered by session.
    pub fn list_agent_runs(
        &self,
        session_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<AgentRunSummary>, StoreError> {
        let connection = self.lock()?;
        let limit = limit.clamp(1, 200) as i64;

        let sql =
            "SELECT id, session_id, task, mode, model, status, commands, started_at, finished_at
                   FROM agent_runs
                   WHERE (?1 IS NULL OR session_id = ?1)
                   ORDER BY started_at DESC
                   LIMIT ?2";
        let mut statement = connection.prepare(sql)?;
        let rows = statement.query_map(params![session_id, limit], |row| {
            Ok(AgentRunSummary {
                id: row.get(0)?,
                session_id: row.get(1)?,
                task: row.get(2)?,
                mode: row.get(3)?,
                model: row.get(4)?,
                status: row.get(5)?,
                commands: row.get(6)?,
                started_at: row.get(7)?,
                finished_at: row.get(8)?,
            })
        })?;

        let mut runs = Vec::new();
        for row in rows {
            runs.push(row?);
        }
        Ok(runs)
    }

    /// Loads one run with its full event sequence.
    pub fn get_agent_run(&self, id: &str) -> Result<Option<AgentRunRecord>, StoreError> {
        let connection = self.lock()?;
        let row = connection
            .query_row(
                "SELECT id, session_id, task, mode, model, status, commands, started_at, finished_at, events
                 FROM agent_runs WHERE id = ?1",
                params![id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, u32>(6)?,
                        row.get::<_, i64>(7)?,
                        row.get::<_, Option<i64>>(8)?,
                        row.get::<_, String>(9)?,
                    ))
                },
            )
            .optional()?;

        match row {
            None => Ok(None),
            Some((
                id,
                session_id,
                task,
                mode,
                model,
                status,
                commands,
                started_at,
                finished_at,
                events,
            )) => Ok(Some(AgentRunRecord {
                id,
                session_id,
                task,
                mode,
                model,
                status,
                commands,
                started_at,
                finished_at,
                events: serde_json::from_str(&events)?,
            })),
        }
    }

    /// Deletes one stored agent run by id, returning whether a row was removed.
    pub fn delete_agent_run(&self, id: &str) -> Result<bool, StoreError> {
        let removed = self
            .lock()?
            .execute("DELETE FROM agent_runs WHERE id = ?1", params![id])?;
        Ok(removed > 0)
    }

    /// Clears stored agent runs, optionally scoped to one `session_id`.
    pub fn clear_agent_runs(&self, session_id: Option<&str>) -> Result<usize, StoreError> {
        let connection = self.lock()?;
        let removed = match session_id {
            Some(id) => {
                connection.execute("DELETE FROM agent_runs WHERE session_id = ?1", params![id])?
            }
            None => connection.execute("DELETE FROM agent_runs", [])?,
        };
        Ok(removed)
    }

    /// Reads one settings value.
    pub fn setting(&self, key: &str) -> Result<Option<String>, StoreError> {
        let connection = self.lock()?;
        Ok(connection
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![key],
                |row| row.get::<_, String>(0),
            )
            .optional()?)
    }

    /// Writes one settings value.
    pub fn set_setting(&self, key: &str, value: &str) -> Result<(), StoreError> {
        self.lock()?.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    /// Returns the pinned fingerprint for a host, if any.
    pub fn host_key(&self, host: &str, port: u16) -> Result<Option<String>, StoreError> {
        let connection = self.lock()?;
        let fingerprint = connection
            .query_row(
                "SELECT fingerprint FROM known_hosts WHERE host = ?1 AND port = ?2",
                params![host, i64::from(port)],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        Ok(fingerprint)
    }

    /// Lists every pinned host key, oldest first.
    pub fn list_known_hosts(&self) -> Result<Vec<KnownHost>, StoreError> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT host, port, fingerprint, first_seen FROM known_hosts ORDER BY host, port",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(KnownHost {
                host: row.get(0)?,
                port: row.get::<_, i64>(1)? as u16,
                fingerprint: row.get(2)?,
                first_seen: row.get(3)?,
            })
        })?;

        let mut hosts = Vec::new();
        for row in rows {
            hosts.push(row?);
        }
        Ok(hosts)
    }

    /// Forgets a pinned host key, returning whether one existed.
    pub fn forget_host_key(&self, host: &str, port: u16) -> Result<bool, StoreError> {
        let removed = self.lock()?.execute(
            "DELETE FROM known_hosts WHERE host = ?1 AND port = ?2",
            params![host, i64::from(port)],
        )?;
        Ok(removed > 0)
    }

    /// Pins a host key, replacing a previous entry for the same host and port.
    pub fn remember_host_key(
        &self,
        host: &str,
        port: u16,
        fingerprint: &str,
    ) -> Result<(), StoreError> {
        self.lock()?.execute(
            "INSERT INTO known_hosts (host, port, fingerprint, first_seen)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(host, port) DO UPDATE SET fingerprint = excluded.fingerprint",
            params![host, i64::from(port), fingerprint, now_millis()],
        )?;
        Ok(())
    }

    /// Creates or updates one user command snippet.
    pub fn save_snippet(&self, draft: NewCommandSnippet) -> Result<CommandSnippet, StoreError> {
        let now = now_millis();
        let category = if draft.category.trim().is_empty() {
            String::from("general")
        } else {
            draft.category.trim().to_owned()
        };
        let alias = draft.alias.trim().to_owned();
        let command = draft.command.trim().to_owned();
        let description = draft.description.trim().to_owned();

        if let Some(existing_id) = draft.id {
            let connection = self.lock()?;
            let updated = connection.execute(
                "UPDATE command_snippets
                 SET alias = ?1, command = ?2, category = ?3, description = ?4, updated_at = ?5
                 WHERE id = ?6",
                params![alias, command, category, description, now, existing_id],
            )?;
            if updated > 0 {
                let row = connection.query_row(
                    "SELECT id, alias, command, category, description, usage_count, created_at, updated_at
                     FROM command_snippets WHERE id = ?1",
                    params![existing_id],
                    |row| {
                        Ok(CommandSnippet {
                            id: row.get(0)?,
                            alias: row.get(1)?,
                            command: row.get(2)?,
                            category: row.get(3)?,
                            description: row.get(4)?,
                            usage_count: row.get::<_, i64>(5)? as u32,
                            created_at: row.get(6)?,
                            updated_at: row.get(7)?,
                        })
                    },
                )?;
                return Ok(row);
            }
        }

        let id = term_core::generate_session_id("snip").into_string();
        self.lock()?.execute(
            "INSERT INTO command_snippets (id, alias, command, category, description, usage_count, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7)",
            params![id, alias, command, category, description, now, now],
        )?;

        Ok(CommandSnippet {
            id,
            alias,
            command,
            category,
            description,
            usage_count: 0,
            created_at: now,
            updated_at: now,
        })
    }

    /// Lists saved command snippets ordered by usage frequency then recency.
    pub fn list_snippets(&self) -> Result<Vec<CommandSnippet>, StoreError> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT id, alias, command, category, description, usage_count, created_at, updated_at
             FROM command_snippets
             ORDER BY usage_count DESC, updated_at DESC",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(CommandSnippet {
                id: row.get(0)?,
                alias: row.get(1)?,
                command: row.get(2)?,
                category: row.get(3)?,
                description: row.get(4)?,
                usage_count: row.get::<_, i64>(5)? as u32,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })?;

        let mut snippets = Vec::new();
        for row in rows {
            snippets.push(row?);
        }
        Ok(snippets)
    }

    /// Increments the usage counter of one snippet when pasted.
    pub fn bump_snippet_usage(&self, id: &str) -> Result<(), StoreError> {
        self.lock()?.execute(
            "UPDATE command_snippets SET usage_count = usage_count + 1, updated_at = ?1 WHERE id = ?2",
            params![now_millis(), id],
        )?;
        Ok(())
    }

    /// Deletes one snippet, returning whether a row was removed.
    pub fn delete_snippet(&self, id: &str) -> Result<bool, StoreError> {
        let removed = self
            .lock()?
            .execute("DELETE FROM command_snippets WHERE id = ?1", params![id])?;
        Ok(removed > 0)
    }

    /// Creates or updates one saved SSH tunnel rule.
    pub fn save_tunnel(&self, draft: NewSavedTunnel) -> Result<SavedTunnel, StoreError> {
        let now = now_millis();
        let name = draft.name.trim().to_owned();
        let bind_host = if draft.bind_host.trim().is_empty() {
            String::from("127.0.0.1")
        } else {
            draft.bind_host.trim().to_owned()
        };
        let target_host = draft.target_host.trim().to_owned();

        if let Some(existing_id) = draft.id {
            let connection = self.lock()?;
            let updated = connection.execute(
                "UPDATE ssh_tunnels
                 SET name = ?1, session_id = ?2, kind = ?3, bind_host = ?4, bind_port = ?5,
                     target_host = ?6, target_port = ?7, updated_at = ?8
                 WHERE id = ?9",
                params![
                    name,
                    draft.session_id,
                    draft.kind,
                    bind_host,
                    i64::from(draft.bind_port),
                    target_host,
                    i64::from(draft.target_port),
                    now,
                    existing_id
                ],
            )?;
            if updated > 0 {
                let row = connection.query_row(
                    "SELECT id, name, session_id, kind, bind_host, bind_port, target_host, target_port, created_at, updated_at
                     FROM ssh_tunnels WHERE id = ?1",
                    params![existing_id],
                    row_to_saved_tunnel,
                )?;
                return Ok(row);
            }
        }

        let id = term_core::generate_session_id("tun").into_string();
        self.lock()?.execute(
            "INSERT INTO ssh_tunnels (id, name, session_id, kind, bind_host, bind_port, target_host, target_port, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                id,
                name,
                draft.session_id,
                draft.kind,
                bind_host,
                i64::from(draft.bind_port),
                target_host,
                i64::from(draft.target_port),
                now,
                now
            ],
        )?;

        Ok(SavedTunnel {
            id,
            name,
            session_id: draft.session_id,
            kind: draft.kind,
            bind_host,
            bind_port: draft.bind_port,
            target_host,
            target_port: draft.target_port,
            created_at: now,
            updated_at: now,
        })
    }

    /// Lists all saved SSH tunnel rules, newest updated first.
    pub fn list_tunnels(&self) -> Result<Vec<SavedTunnel>, StoreError> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT id, name, session_id, kind, bind_host, bind_port, target_host, target_port, created_at, updated_at
             FROM ssh_tunnels
             ORDER BY updated_at DESC, name COLLATE NOCASE",
        )?;
        let rows = statement.query_map([], row_to_saved_tunnel)?;
        let mut tunnels = Vec::new();
        for row in rows {
            tunnels.push(row?);
        }
        Ok(tunnels)
    }

    /// Looks up one saved SSH tunnel rule by id.
    pub fn get_tunnel(&self, id: &str) -> Result<Option<SavedTunnel>, StoreError> {
        let connection = self.lock()?;
        Ok(connection
            .query_row(
                "SELECT id, name, session_id, kind, bind_host, bind_port, target_host, target_port, created_at, updated_at
                 FROM ssh_tunnels WHERE id = ?1",
                params![id],
                row_to_saved_tunnel,
            )
            .optional()?)
    }

    /// Deletes one saved SSH tunnel rule.
    pub fn delete_tunnel(&self, id: &str) -> Result<bool, StoreError> {
        let removed = self
            .lock()?
            .execute("DELETE FROM ssh_tunnels WHERE id = ?1", params![id])?;
        Ok(removed > 0)
    }
}

fn row_to_saved_tunnel(row: &rusqlite::Row<'_>) -> rusqlite::Result<SavedTunnel> {
    Ok(SavedTunnel {
        id: row.get(0)?,
        name: row.get(1)?,
        session_id: row.get(2)?,
        kind: row.get(3)?,
        bind_host: row.get(4)?,
        bind_port: row.get::<_, i64>(5)? as u16,
        target_host: row.get(6)?,
        target_port: row.get::<_, i64>(7)? as u16,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn draft(name: &str) -> NewSavedSession {
        NewSavedSession {
            name: name.to_owned(),
            kind: String::from("ssh"),
            payload: json!({ "host": "10.0.0.12", "port": 22, "username": "root" }),
            secret_ref: Some(String::from("ssh:10.0.0.12:22:root")),
        }
    }

    #[test]
    fn saves_lists_and_reads_back_a_session() {
        let store = Store::open_in_memory().expect("store");

        let saved = store.save(draft("lab router")).expect("save");
        assert_eq!(saved.name, "lab router");
        assert_eq!(saved.payload["host"], "10.0.0.12");
        assert_eq!(saved.secret_ref.as_deref(), Some("ssh:10.0.0.12:22:root"));

        let listed = store.list().expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, saved.id);

        let fetched = store.get(&saved.id).expect("get").expect("exists");
        assert_eq!(fetched, saved);
    }

    #[test]
    fn deletes_a_session() {
        let store = Store::open_in_memory().expect("store");
        let saved = store.save(draft("temp")).expect("save");

        assert!(store.delete(&saved.id).expect("delete"));
        assert!(!store.delete(&saved.id).expect("delete again"));
        assert!(store.list().expect("list").is_empty());
    }

    #[test]
    fn pins_and_replaces_host_keys() {
        let store = Store::open_in_memory().expect("store");
        assert!(store.host_key("10.0.0.12", 22).expect("lookup").is_none());

        store
            .remember_host_key("10.0.0.12", 22, "SHA256:first")
            .expect("pin");
        assert_eq!(
            store.host_key("10.0.0.12", 22).expect("lookup"),
            Some(String::from("SHA256:first"))
        );

        store
            .remember_host_key("10.0.0.12", 22, "SHA256:second")
            .expect("re-pin");
        assert_eq!(
            store.host_key("10.0.0.12", 22).expect("lookup"),
            Some(String::from("SHA256:second"))
        );
        // Ports are part of the identity.
        assert!(store.host_key("10.0.0.12", 2222).expect("lookup").is_none());
    }

    #[test]
    fn lists_and_forgets_pinned_hosts() {
        let store = Store::open_in_memory().expect("store");
        store
            .remember_host_key("10.0.0.12", 22, "SHA256:a")
            .expect("pin");
        store
            .remember_host_key("10.0.0.9", 2222, "SHA256:b")
            .expect("pin");

        let hosts = store.list_known_hosts().expect("list");
        assert_eq!(hosts.len(), 2);
        assert_eq!(hosts[0].host, "10.0.0.12");
        assert_eq!(hosts[1].port, 2222);

        assert!(store.forget_host_key("10.0.0.12", 22).expect("forget"));
        assert!(
            !store
                .forget_host_key("10.0.0.12", 22)
                .expect("forget again")
        );
        assert_eq!(store.list_known_hosts().expect("list").len(), 1);
    }

    #[test]
    fn stores_and_replays_agent_runs() {
        let store = Store::open_in_memory().expect("store");
        let draft = NewAgentRun {
            session_id: String::from("local-0001"),
            task: String::from("看看目录"),
            mode: String::from("supervised"),
            model: String::from("deepseek-flash"),
            status: String::from("completed"),
            commands: 2,
            started_at: 1,
            finished_at: 2,
            events: json!([{ "type": "runStarted" }]),
        };
        let saved = store.save_agent_run(draft).expect("save run");

        let listed = store
            .list_agent_runs(Some("local-0001"), 10)
            .expect("list runs");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].commands, 2);
        assert_eq!(listed[0].status, "completed");
        assert!(
            store
                .list_agent_runs(Some("ssh-0002"), 10)
                .expect("other session")
                .is_empty()
        );

        let loaded = store
            .get_agent_run(&saved.id)
            .expect("get")
            .expect("exists");
        assert_eq!(loaded.events[0]["type"], "runStarted");
        assert_eq!(loaded.task, "看看目录");

        assert!(store.delete_agent_run(&saved.id).expect("delete"));
        assert!(store.list_agent_runs(None, 10).expect("list").is_empty());

        store
            .save_agent_run(NewAgentRun {
                session_id: String::from("s1"),
                task: String::from("df -h"),
                mode: String::from("supervised"),
                model: String::from("deepseek-chat"),
                status: String::from("completed"),
                commands: 1,
                started_at: 10,
                finished_at: 20,
                events: json!([]),
            })
            .expect("record 1");
        store
            .save_agent_run(NewAgentRun {
                session_id: String::from("s2"),
                task: String::from("uptime"),
                mode: String::from("supervised"),
                model: String::from("deepseek-chat"),
                status: String::from("completed"),
                commands: 1,
                started_at: 30,
                finished_at: 40,
                events: json!([]),
            })
            .expect("record 2");
        assert_eq!(store.clear_agent_runs(None).expect("clear"), 2);
        assert!(store.list_agent_runs(None, 10).expect("empty").is_empty());
    }

    #[test]
    fn stores_settings_round_trip() {
        let store = Store::open_in_memory().expect("store");
        assert!(store.setting("llm.model").expect("read").is_none());
        store
            .set_setting("llm.model", "deepseek-flash")
            .expect("write");
        store
            .set_setting("llm.model", "deepseek-v4-pro")
            .expect("overwrite");
        assert_eq!(
            store.setting("llm.model").expect("read").as_deref(),
            Some("deepseek-v4-pro")
        );
    }

    #[test]
    fn keeps_payload_free_of_secrets() {
        let store = Store::open_in_memory().expect("store");
        let saved = store.save(draft("no secrets")).expect("save");
        let encoded = saved.payload.to_string();
        assert!(!encoded.contains("password"));
        assert!(!encoded.contains("passphrase"));
    }

    #[test]
    fn saves_updates_bumps_and_deletes_snippets() {
        let store = Store::open_in_memory().expect("store");
        let created = store
            .save_snippet(NewCommandSnippet {
                id: None,
                alias: String::from("Port 8080"),
                command: String::from("lsof -i :8080"),
                category: String::from("network"),
                description: String::from("Find process listening on 8080"),
            })
            .expect("create");
        assert_eq!(created.usage_count, 0);

        store.bump_snippet_usage(&created.id).expect("bump");
        let updated = store
            .save_snippet(NewCommandSnippet {
                id: Some(created.id.clone()),
                alias: String::from("Check 8080"),
                command: String::from("lsof -nP -iTCP:8080"),
                category: String::from("network"),
                description: String::new(),
            })
            .expect("update");
        assert_eq!(updated.alias, "Check 8080");
        assert_eq!(updated.usage_count, 1);

        let listed = store.list_snippets().expect("list");
        assert_eq!(listed.len(), 1);
        assert!(store.delete_snippet(&created.id).expect("delete"));
        assert!(store.list_snippets().expect("empty").is_empty());
    }

    #[test]
    fn saves_lists_updates_and_deletes_tunnels() {
        let store = Store::open_in_memory().expect("store");
        let created = store
            .save_tunnel(NewSavedTunnel {
                id: None,
                name: String::from("Prod MySQL"),
                session_id: String::from("saved-0001"),
                kind: String::from("local"),
                bind_host: String::from("127.0.0.1"),
                bind_port: 13306,
                target_host: String::from("127.0.0.1"),
                target_port: 3306,
            })
            .expect("create tunnel");
        assert_eq!(created.bind_port, 13306);

        let updated = store
            .save_tunnel(NewSavedTunnel {
                id: Some(created.id.clone()),
                name: String::from("Prod MySQL RO"),
                session_id: String::from("saved-0001"),
                kind: String::from("local"),
                bind_host: String::from("127.0.0.1"),
                bind_port: 23306,
                target_host: String::from("10.0.0.8"),
                target_port: 3306,
            })
            .expect("update tunnel");
        assert_eq!(updated.name, "Prod MySQL RO");
        assert_eq!(updated.bind_port, 23306);

        assert_eq!(store.list_tunnels().expect("list").len(), 1);
        assert!(store.get_tunnel(&created.id).expect("get").is_some());
        assert!(store.delete_tunnel(&created.id).expect("delete"));
        assert!(store.list_tunnels().expect("empty").is_empty());
    }
}
