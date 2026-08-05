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
        Ok(Self {
            path: dir.join("settings.json"),
        })
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
