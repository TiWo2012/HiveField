mod dictation;
mod fonts;
mod git;
mod pty;
mod settings;
mod workspace;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use tauri::State;

/// Managed state holding all live PTY sessions, keyed by session id.
pub struct PtyState<R: tauri::Runtime = tauri::Wry> {
    pub sessions: Mutex<HashMap<u64, pty::PtySession<R>>>,
    next_id: AtomicU64,
}

impl<R: tauri::Runtime> Default for PtyState<R> {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
        }
    }
}

/// IPC command: spawn a new PTY shell session, returns its session id.
///
/// `mode` controls what the session auto-runs:
///   - `"opencode"` (default): the shell auto-runs `opencode`
///   - `"raw"`: plain shell, no auto-run
///
/// `cwd` optionally pins the directory the shell starts in (e.g. a git
/// worktree path). When omitted the shell starts in the directory the app was
/// launched from.
#[tauri::command]
fn pty_spawn(
    app: tauri::AppHandle,
    state: State<'_, PtyState>,
    mode: Option<String>,
    cwd: Option<String>,
) -> Result<u64, String> {
    let session_id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let mode = mode.unwrap_or_else(|| "opencode".to_string());
    let cwd = cwd.map(std::path::PathBuf::from);
    pty::spawn(&app, session_id, &mode, cwd).map_err(|e| e.to_string())?;
    Ok(session_id)
}

/// IPC command: send input (keystrokes) from the frontend to a session's PTY.
#[tauri::command]
fn pty_write(state: State<'_, PtyState>, session_id: u64, data: String) -> Result<(), String> {
    pty::write(&state, session_id, &data).map_err(|e| e.to_string())
}

/// IPC command: resize a session's PTY to match the frontend terminal viewport.
#[tauri::command]
fn pty_resize(
    state: State<'_, PtyState>,
    session_id: u64,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    pty::resize(&state, session_id, cols, rows).map_err(|e| e.to_string())
}

/// IPC command: kill a PTY session by id.
#[tauri::command]
fn pty_kill(state: State<'_, PtyState>, session_id: u64) -> Result<(), String> {
    pty::kill(&state, session_id).map_err(|e| e.to_string())
}

/// IPC command: read all stored settings as a JSON object ({} if none yet).
#[tauri::command]
fn settings_get(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let store = settings::SettingsStore::load(&app)?;
    Ok(store.read())
}

/// IPC command: persist the full settings object (opaque JSON blob).
#[tauri::command]
fn settings_set(app: tauri::AppHandle, settings: serde_json::Value) -> Result<(), String> {
    let store = settings::SettingsStore::load(&app)?;
    store.write(&settings)
}

/// IPC command: resolve the canonical absolute path of the process's working
/// directory, falling back to the home directory when the cwd is gone or
/// unreadable.
#[tauri::command]
fn workspace_cwd() -> Result<String, String> {
    workspace::resolve_cwd()
}

/// IPC command: read the stored layout for a launch directory (`cwd`), or
/// `null` when none has been saved.
#[tauri::command]
fn workspace_get(app: tauri::AppHandle, cwd: String) -> Result<serde_json::Value, String> {
    let store = workspace::WorkspaceStore::load(&app)?;
    Ok(store.get(&cwd))
}

/// IPC command: persist a layout for a launch directory (`cwd`); a `null`
/// layout clears that directory's saved workspace.
#[tauri::command]
fn workspace_set(
    app: tauri::AppHandle,
    cwd: String,
    layout: serde_json::Value,
) -> Result<(), String> {
    let store = workspace::WorkspaceStore::load(&app)?;
    store.set(&cwd, &layout)
}

/// IPC command: list the git worktrees of the repo containing the launch
/// directory. `root` is `null` when the launch dir is not inside a git repo,
/// in which case `worktrees` is empty.
#[tauri::command]
fn git_worktrees() -> git::WorktreesInfo {
    match workspace::resolve_cwd().map(std::path::PathBuf::from) {
        Ok(dir) => git::list(&dir),
        Err(_) => git::WorktreesInfo { root: None, worktrees: Vec::new() },
    }
}

/// IPC command: create a worktree on a new branch in the repo containing the
/// launch directory. `path` is optional — when omitted the worktree is created
/// in a sibling directory named `<repo dir>-<branch>`. Returns the absolute
/// path of the new worktree.
#[tauri::command]
fn git_worktree_create(branch: String, path: Option<String>) -> Result<String, String> {
    let dir = workspace::resolve_cwd().map(std::path::PathBuf::from)?;
    git::create(&dir, &branch, path.as_deref()).map(|p| p.to_string_lossy().into_owned())
}

/// IPC command: remove the worktree at `path` from the repo containing the
/// launch directory. Fails (surfacing git's error) when the worktree has
/// uncommitted or untracked files.
#[tauri::command]
fn git_worktree_remove(path: String) -> Result<(), String> {
    let dir = workspace::resolve_cwd().map(std::path::PathBuf::from)?;
    git::remove(&dir, &path)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(PtyState::<tauri::Wry>::default())
        .manage(dictation::DictationState::default())
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            settings_get,
            settings_set,
            workspace_cwd,
            workspace_get,
            workspace_set,
            git_worktrees,
            git_worktree_create,
            git_worktree_remove,
            fonts::list_system_fonts,
            dictation::dictation_start,
            dictation::dictation_stop,
            dictation::dictation_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::test::MockRuntime;

    #[test]
    fn default_state_starts_with_next_id_one() {
        let state = PtyState::<MockRuntime>::default();
        let first = state.next_id.fetch_add(1, Ordering::Relaxed);
        let second = state.next_id.fetch_add(1, Ordering::Relaxed);
        assert_eq!(first, 1);
        assert_eq!(second, 2);
    }

    #[test]
    fn default_state_has_no_sessions() {
        let state = PtyState::<MockRuntime>::default();
        assert!(state.sessions.lock().unwrap().is_empty());
    }

    #[test]
    fn next_id_is_unique_under_concurrency() {
        let state = std::sync::Arc::new(PtyState::<MockRuntime>::default());
        let mut handles = Vec::new();
        for _ in 0..8 {
            let state = std::sync::Arc::clone(&state);
            handles.push(std::thread::spawn(move || {
                let mut ids = std::collections::HashSet::new();
                for _ in 0..100 {
                    ids.insert(state.next_id.fetch_add(1, Ordering::Relaxed));
                }
                ids
            }));
        }
        let mut all = std::collections::HashSet::new();
        for h in handles {
            all.extend(h.join().unwrap());
        }
        assert_eq!(all.len(), 800, "fetch_add must hand out unique ids");
    }
}
