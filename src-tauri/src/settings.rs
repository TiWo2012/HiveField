//! File-backed settings store.
//!
//! Settings are stored as a JSON object at
//! `<app_config_dir>/settings.json` (e.g. `~/.config/dev.hivefield.terminal/`).
//! The document carries a `schemaVersion` field; the backend validates it so a
//! future rename/restructure of the schema can never silently corrupt (or
//! drop) the user's settings:
//!
//! - a document written by a *newer* app is refused on write, so a downgrade
//!   never clobbers settings the older app cannot represent;
//! - `migrate()` is the place to add version-to-version migrations as the
//!   shape evolves;
//! - documents without a `schemaVersion` (written before versioning) are
//!   treated as schema v1 and stamped on the next write.

use std::fs;
use std::path::PathBuf;

use serde_json::Value;
use tauri::{AppHandle, Manager};

/// Version of the settings document shape. Bump on any incompatible change
/// (rename/restructure) and add a step to [`migrate`].
pub const SETTINGS_SCHEMA_VERSION: u64 = 1;

/// Migrate a stored settings document to the current schema version.
///
/// Called by [`SettingsStore::read`] before the document is handed to the
/// frontend. Version 1 (the original opaque shape) is current, so this is
/// the identity; as the shape evolves, add `v1 -> v2` style steps here, each
/// with a test in the `migrate` test module.
pub fn migrate(value: Value) -> Value {
    // v1: the original settings shape. Nothing to do.
    value
}

pub struct SettingsStore {
    path: PathBuf,
}

impl SettingsStore {
    /// Resolve the settings file path (creating the config dir if needed).
    pub fn load(app: &AppHandle) -> Result<Self, String> {
        let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
        fs::create_dir_all(&dir).map_err(|e| format!("failed to create config dir: {e}"))?;
        Ok(Self::from_path(dir.join("settings.json")))
    }

    /// Build a store backed by an explicit file path (used by tests and by
    /// embedders that manage their own storage location).
    pub fn from_path(path: PathBuf) -> Self {
        Self { path }
    }

    /// Read the stored settings (migrated to the current schema); returns
    /// `{}` when nothing has been saved yet or the file is corrupt.
    pub fn read(&self) -> Value {
        match fs::read_to_string(&self.path) {
            Ok(text) => serde_json::from_str::<Value>(&text)
                .map(migrate)
                .unwrap_or_else(|_| serde_json::json!({})),
            Err(_) => serde_json::json!({}),
        }
    }

    /// The `schemaVersion` of the document currently on disk, if any.
    fn stored_version(&self) -> Option<u64> {
        let text = fs::read_to_string(&self.path).ok()?;
        let doc = serde_json::from_str::<Value>(&text).ok()?;
        doc.get("schemaVersion").and_then(Value::as_u64)
    }

    /// Persist settings to disk (pretty-printed for human inspection).
    ///
    /// Refuses to overwrite a document written by a newer app than this one
    /// (see the module docs). Stamps `schemaVersion` when the document does
    /// not carry one yet.
    pub fn write(&self, settings: &Value) -> Result<(), String> {
        if let Some(stored) = self.stored_version() {
            if stored > SETTINGS_SCHEMA_VERSION {
                return Err(format!(
                    "settings were written by a newer app (schema v{stored}); \
                     refusing to overwrite them (this build understands v{SETTINGS_SCHEMA_VERSION})"
                ));
            }
        }
        let mut doc = settings.clone();
        if doc.get("schemaVersion").is_none() {
            doc["schemaVersion"] = serde_json::json!(SETTINGS_SCHEMA_VERSION);
        }
        let text = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
        fs::write(&self.path, text).map_err(|e| format!("failed to write settings: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A store pointing inside a throwaway temp dir; deleted after the test.
    fn temp_store() -> (SettingsStore, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("temp dir");
        let store = SettingsStore::from_path(dir.path().join("settings.json"));
        (store, dir)
    }

    #[test]
    fn read_returns_empty_object_when_no_file() {
        let (store, _dir) = temp_store();
        assert_eq!(store.read(), json!({}));
    }

    #[test]
    fn write_then_read_roundtrips() {
        let (store, _dir) = temp_store();
        let settings = json!({
            "fontSize": 14,
            "theme": "dark",
            "nerdFonts": true,
            "unicode11": true
        });
        store.write(&settings).expect("write should succeed");
        let stored = store.read();
        // The version is stamped on first write; everything else round-trips.
        assert_eq!(stored["schemaVersion"], json!(SETTINGS_SCHEMA_VERSION));
        assert_eq!(stored["fontSize"], json!(14));
        assert_eq!(stored["theme"], json!("dark"));
        assert_eq!(stored["nerdFonts"], json!(true));
        assert_eq!(stored["unicode11"], json!(true));
    }

    #[test]
    fn write_stamps_the_schema_version_when_missing() {
        let (store, dir) = temp_store();
        store.write(&json!({ "a": 1 })).expect("write");
        let text = std::fs::read_to_string(dir.path().join("settings.json")).expect("read file");
        assert!(text.contains("\"schemaVersion\": 1"), "missing stamp: {text}");
    }

    #[test]
    fn write_keeps_an_up_to_date_documents_version() {
        let (store, dir) = temp_store();
        store
            .write(&json!({ "schemaVersion": 1, "a": 1 }))
            .expect("write");
        let text = std::fs::read_to_string(dir.path().join("settings.json")).expect("read file");
        assert!(text.contains("\"schemaVersion\": 1"), "{text}");
    }

    #[test]
    fn write_refuses_documents_from_a_newer_app() {
        let (store, _dir) = temp_store();
        // Simulate a downgrade: the file on disk was written by a newer app.
        store
            .write(&json!({ "schemaVersion": 99, "future": true }))
            .expect("newer app writes its own file");
        let err = store
            .write(&json!({ "fontSize": 12 }))
            .expect_err("older app must refuse to overwrite");
        assert!(
            err.contains("newer app") && err.contains("99"),
            "unexpected error: {err}"
        );
        // And the newer document is untouched.
        assert_eq!(store.read()["future"], json!(true));
    }

    #[test]
    fn legacy_documents_without_a_version_are_readable() {
        let (store, _dir) = temp_store();
        std::fs::write(&store.path, r#"{ "fontSize": 15 }"#).expect("write legacy file");
        // Legacy = schema v1: readable, and the next write stamps the version.
        assert_eq!(store.read()["fontSize"], json!(15));
        store.write(&json!({ "fontSize": 15 })).expect("write");
        assert_eq!(store.read()["schemaVersion"], json!(SETTINGS_SCHEMA_VERSION));
    }

    #[test]
    fn migrate_is_identity_for_the_current_version() {
        let doc = json!({ "fontSize": 14, "theme": "dark" });
        assert_eq!(migrate(doc.clone()), doc);
    }

    #[test]
    fn write_overwrites_previous_settings() {
        let (store, _dir) = temp_store();
        store.write(&json!({ "a": 1 })).expect("write");
        store.write(&json!({ "b": 2 })).expect("overwrite");
        let stored = store.read();
        assert_eq!(stored["b"], json!(2));
        assert!(stored.get("a").is_none());
    }

    #[test]
    fn read_returns_empty_object_on_corrupt_json() {
        let (store, dir) = temp_store();
        std::fs::write(dir.path().join("settings.json"), "{ this is not json !!!")
            .expect("write corrupt file");
        assert_eq!(store.read(), json!({}));
    }

    #[test]
    fn read_returns_empty_object_on_unreadable_file() {
        let (store, dir) = temp_store();
        std::fs::write(dir.path().join("settings.json"), b"not utf8: \xFF\xFE")
            .expect("write binary file");
        // Invalid UTF-8 contents are treated as corrupt -> empty object.
        assert_eq!(store.read(), json!({}));
    }

    #[test]
    fn write_fails_when_parent_dir_missing() {
        let (_, dir) = temp_store();
        let store = SettingsStore::from_path(dir.path().join("missing").join("settings.json"));
        let err = store.write(&json!({"a": 1})).expect_err("write should fail");
        assert!(err.contains("failed to write settings"), "unexpected error: {err}");
    }
}
