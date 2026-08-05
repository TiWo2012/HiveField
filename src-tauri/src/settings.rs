//! File-backed settings store.
//!
//! Settings are stored as an opaque JSON object at
//! `<app_config_dir>/settings.json` (e.g. `~/.config/dev.hivefield.terminal/`).
//! The backend does not interpret the schema — it just persists whatever the
//! frontend writes, so the two sides can evolve independently.

use std::fs;
use std::path::PathBuf;

use serde_json::Value;
use tauri::{AppHandle, Manager};

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

    /// Read the stored settings; returns `{}` when nothing has been saved yet
    /// or the file is corrupt.
    pub fn read(&self) -> Value {
        match fs::read_to_string(&self.path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_else(|_| serde_json::json!({})),
            Err(_) => serde_json::json!({}),
        }
    }

    /// Persist settings to disk (pretty-printed for human inspection).
    pub fn write(&self, settings: &Value) -> Result<(), String> {
        let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
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
        assert_eq!(store.read(), settings);
    }

    #[test]
    fn write_overwrites_previous_settings() {
        let (store, _dir) = temp_store();
        store.write(&json!({"a": 1})).expect("write");
        store.write(&json!({"b": 2})).expect("overwrite");
        assert_eq!(store.read(), json!({"b": 2}));
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
