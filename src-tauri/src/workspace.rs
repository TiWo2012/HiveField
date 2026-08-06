//! File-backed per-directory workspace store.
//!
//! Workspaces are stored as an opaque JSON document at
//! `<app_config_dir>/workspaces.json` (e.g. `~/.config/dev.hivefield.terminal/`).
//! The file is a JSON object mapping each launch directory's canonicalized
//! absolute path (`cwd`) to the frontend's serialized dockview layout. The
//! backend does not interpret the layout schema — it just persists whatever the
//! frontend writes, so the two sides can evolve independently.

use std::fs;
use std::path::PathBuf;

use serde_json::Value;
use tauri::{AppHandle, Manager};

pub struct WorkspaceStore {
    path: PathBuf,
}

impl WorkspaceStore {
    /// Resolve the workspaces file path (creating the config dir if needed).
    pub fn load(app: &AppHandle) -> Result<Self, String> {
        let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
        fs::create_dir_all(&dir).map_err(|e| format!("failed to create config dir: {e}"))?;
        Ok(Self::from_path(dir.join("workspaces.json")))
    }

    /// Build a store backed by an explicit file path (used by tests and by
    /// embedders that manage their own storage location).
    pub fn from_path(path: PathBuf) -> Self {
        Self { path }
    }

    /// Read the whole workspace map (cwd -> layout); returns `{}` when nothing
    /// has been saved yet or the file is corrupt.
    pub fn read(&self) -> Value {
        match fs::read_to_string(&self.path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_else(|_| serde_json::json!({})),
            Err(_) => serde_json::json!({}),
        }
    }

    /// Read the stored layout for `cwd`, or `Null` when the cwd is unknown.
    pub fn get(&self, cwd: &str) -> Value {
        match self.read().get(cwd) {
            Some(layout) => layout.clone(),
            None => Value::Null,
        }
    }

    /// Persist `layout` for `cwd` into the workspace map (pretty-printed for
    /// human inspection). A `Null` layout removes the cwd's entry so clearing a
    /// workspace works.
    pub fn set(&self, cwd: &str, layout: &Value) -> Result<(), String> {
        let mut map = self.read();
        if !map.is_object() {
            map = serde_json::json!({});
        }
        let entries = map.as_object_mut().expect("workspace map is an object");
        if layout.is_null() {
            entries.remove(cwd);
        } else {
            entries.insert(cwd.to_string(), layout.clone());
        }
        self.write(&map)
    }

    /// Persist the workspace map to disk.
    fn write(&self, map: &Value) -> Result<(), String> {
        let text = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
        fs::write(&self.path, text).map_err(|e| format!("failed to write workspaces: {e}"))
    }
}

/// Resolve the canonical absolute path of the process's current working
/// directory, falling back to the user's home directory when the cwd is gone
/// or unreadable (same policy as the PTY `start_dir`).
pub fn resolve_cwd() -> Result<String, String> {
    let home_var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    let dir = std::env::current_dir()
        .ok()
        .and_then(|d| d.canonicalize().ok())
        .filter(|d| fs::read_dir(d).is_ok())
        .or_else(|| {
            std::env::var(home_var)
                .ok()
                .map(PathBuf::from)
                .and_then(|d| d.canonicalize().ok())
                .filter(|d| fs::read_dir(d).is_ok())
        })
        .ok_or_else(|| "unable to resolve working directory".to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A store pointing inside a throwaway temp dir; deleted after the test.
    fn temp_store() -> (WorkspaceStore, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("temp dir");
        let store = WorkspaceStore::from_path(dir.path().join("workspaces.json"));
        (store, dir)
    }

    #[test]
    fn read_returns_empty_object_when_no_file() {
        let (store, _dir) = temp_store();
        assert_eq!(store.read(), json!({}));
    }

    #[test]
    fn set_then_get_roundtrips_nested_layout() {
        let (store, _dir) = temp_store();
        let cwd = "/home/user/myproject";
        let layout = json!({
            "grid": { "root": { "type": "row" } },
            "panels": { "left": { "width": 300 } }
        });
        store.set(cwd, &layout).expect("set should succeed");
        assert_eq!(store.get(cwd), layout);
    }

    #[test]
    fn get_returns_null_for_unknown_cwd() {
        let (store, _dir) = temp_store();
        assert_eq!(store.get("/nonexistent/project"), json!(null));
    }

    #[test]
    fn two_cwds_are_stored_independently() {
        let (store, _dir) = temp_store();
        store.set("/project/a", &json!({"tab": "a"})).expect("set A");
        store.set("/project/b", &json!({"tab": "b"})).expect("set B");
        assert_eq!(store.get("/project/a"), json!({"tab": "a"}));
        assert_eq!(store.get("/project/b"), json!({"tab": "b"}));
    }

    #[test]
    fn set_null_layout_removes_cwd() {
        let (store, _dir) = temp_store();
        let cwd = "/home/user/myproject";
        store.set(cwd, &json!({"tab": "hello"})).expect("set");
        store.set(cwd, &json!(null)).expect("clear");
        assert_eq!(store.get(cwd), json!(null));
        assert_eq!(store.read(), json!({}));
    }

    #[test]
    fn read_returns_empty_object_on_corrupt_json() {
        let (store, dir) = temp_store();
        std::fs::write(dir.path().join("workspaces.json"), "{ this is not json !!!")
            .expect("write corrupt file");
        assert_eq!(store.read(), json!({}));
    }
}
