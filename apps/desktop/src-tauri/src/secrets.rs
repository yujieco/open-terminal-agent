// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

//! OS keyring access for SSH credentials.
//!
//! Passwords and passphrases live in Keychain / Credential Manager / Secret
//! Service. The database only ever stores the account name of an entry, so the
//! secret is never written to disk by this app.

use crate::error::ApiError;

/// Service name all entries are filed under.
const SERVICE: &str = "EnaviloOTA";

/// Previous service name kept for seamless one-time read migration.
const LEGACY_SERVICE: &str = "co.yujie.open-terminal-agent";

/// Credential slot in the OS keyring.
pub struct SecretStore;

impl SecretStore {
    /// Creates a handle to the platform keyring.
    pub fn new() -> Self {
        Self
    }

    /// Stores or replaces a secret.
    pub fn set(&self, account: &str, secret: &str) -> Result<(), ApiError> {
        keyring::Entry::new(SERVICE, account)
            .map_err(|error| ApiError::Secret(error.to_string()))?
            .set_password(secret)
            .map_err(|error| ApiError::Secret(error.to_string()))
    }

    /// Reads a secret, returning `None` when no entry exists.
    ///
    /// When an entry is not yet present under [`SERVICE`], falls back once to
    /// [`LEGACY_SERVICE`] and migrates any discovered secret forward.
    pub fn get(&self, account: &str) -> Result<Option<String>, ApiError> {
        let entry = keyring::Entry::new(SERVICE, account)
            .map_err(|error| ApiError::Secret(error.to_string()))?;
        match entry.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => self.read_and_migrate_legacy(account),
            Err(error) => Err(ApiError::Secret(error.to_string())),
        }
    }

    /// Deletes a secret from both current and legacy namespaces, ignoring
    /// missing entries.
    pub fn delete(&self, account: &str) -> Result<(), ApiError> {
        let entry = keyring::Entry::new(SERVICE, account)
            .map_err(|error| ApiError::Secret(error.to_string()))?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(error) => return Err(ApiError::Secret(error.to_string())),
        }
        if let Ok(legacy) = keyring::Entry::new(LEGACY_SERVICE, account) {
            let _ = legacy.delete_credential();
        }
        Ok(())
    }

    fn read_and_migrate_legacy(&self, account: &str) -> Result<Option<String>, ApiError> {
        let Ok(legacy) = keyring::Entry::new(LEGACY_SERVICE, account) else {
            return Ok(None);
        };
        match legacy.get_password() {
            Ok(secret) => {
                // Best-effort copy into the new namespace so subsequent reads
                // stay inside `EnaviloOTA`.
                let _ = self.set(account, &secret);
                Ok(Some(secret))
            }
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Ok(None),
        }
    }
}

impl Default for SecretStore {
    fn default() -> Self {
        Self::new()
    }
}

/// Keyring account name for one SSH identity.
pub fn ssh_secret_account(host: &str, port: u16, username: &str) -> String {
    format!("ssh:{username}@{host}:{port}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_names_are_stable_and_unique_per_identity() {
        let account = ssh_secret_account("10.0.0.12", 22, "root");
        assert_eq!(account, "ssh:root@10.0.0.12:22");
        assert_ne!(account, ssh_secret_account("10.0.0.12", 2222, "root"));
        assert_ne!(account, ssh_secret_account("10.0.0.12", 22, "admin"));
    }
}
