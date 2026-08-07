mod dictation;
mod fonts;
mod git;
mod notifications;
mod pty;
mod settings;
mod windows;
mod workspace;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use tauri::{Emitter, Manager, State};

/// Recover a mutex guard even when the mutex is poisoned (a holder panicked
/// while holding the lock). For the app's session/state maps, degrading to the
/// last consistent value is strictly better than panicking the whole app on a
/// stray panicking thread.
pub trait Unpoisoned<T> {
    fn lock_unpoisoned(&self) -> std::sync::MutexGuard<'_, T>;
}

impl<T> Unpoisoned<T> for std::sync::Mutex<T> {
    fn lock_unpoisoned(&self) -> std::sync::MutexGuard<'_, T> {
        self.lock().unwrap_or_else(|e| e.into_inner())
    }
}

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

/// The git state the app launched against: the repo (if any) containing the
/// process working directory and the HEAD commit at that moment. Kept so the
/// UI can later report how much the repo changed since startup (see the
/// `git_diff_report` command).
pub struct GitLaunchState {
    /// Repo root captured at launch, when the launch dir was inside a repo.
    repo_root: Option<PathBuf>,
    /// HEAD commit hash captured at launch, when the launch dir was a repo.
    commit: Option<String>,
}

impl GitLaunchState {
    /// Capture the repo + HEAD commit of `launch_dir` (best-effort: both
    /// fields stay `None` when it is not inside a git repository).
    fn from_dir(launch_dir: &Path) -> Self {
        let repo_root = git::repo_root(launch_dir);
        let commit = repo_root.as_deref().and_then(git::head_commit);
        Self { repo_root, commit }
    }
}

/// Tracks which "changes since launch" summary has already been delivered to
/// the UI. Polling is re-armed: a repeated poll of the same change set returns
/// nothing, and only a *different* change set since the last delivery produces
/// a fresh report. The state lives in the backend, so a frontend reload never
/// re-shows a toast that was already delivered.
pub struct GitDiffReportState {
    /// Digest (`"changed:insertions:deletions"`) of the last delivered report.
    last_delivered: Mutex<Option<String>>,
}

impl Default for GitDiffReportState {
    fn default() -> Self {
        Self {
            last_delivered: Mutex::new(None),
        }
    }
}

impl GitDiffReportState {
    fn digest(summary: &git::DiffSummary) -> String {
        format!(
            "{}:{}:{}",
            summary.changed, summary.insertions, summary.deletions
        )
    }

    /// Claim `summary` for delivery: returns it (recording the digest) when it
    /// is a non-empty change set that has not been delivered yet, `None`
    /// otherwise.
    fn claim(&self, summary: &git::DiffSummary) -> Option<git::DiffSummary> {
        if summary.changed == 0 {
            return None;
        }
        let digest = Self::digest(summary);
        let mut last = self.last_delivered.lock_unpoisoned();
        if last.as_deref() == Some(digest.as_str()) {
            return None;
        }
        *last = Some(digest);
        Some(summary.clone())
    }
}

/// IPC command: report the changes since the app launched, once per distinct
/// change set. The launch commit was captured at startup (HEAD of the repo
/// containing the process working directory); this diffs it against the
/// current working tree and reports total files changed plus added/deleted
/// lines. Returns `null` when the app did not launch inside a git repository,
/// when the invoking window is on a different repository, when git is
/// unavailable, or when this exact change set was already reported. The
/// frontend polls this command; the "already reported" deduplication is what
/// re-arms the toast for later change sets and survives frontend reloads.
///
/// Async + `spawn_blocking`: the git queries shell out to the `git` binary and
/// must not block the main thread; results are cached briefly in [`git::GitCache`].
#[tauri::command]
async fn git_diff_report(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Option<git::DiffSummary>, String> {
    // Async commands cannot borrow `State` from the IPC message; resolve the
    // launch snapshot from the app handle inside the task instead.
    let launch_state = app.state::<GitLaunchState>();
    let Some(launch_root) = launch_state.repo_root.clone() else {
        return Ok(None);
    };
    let Some(base) = launch_state.commit.clone() else {
        return Ok(None);
    };
    let Ok(dir) = window_cwd(&window).map(std::path::PathBuf::from) else {
        return Ok(None);
    };
    let cache_app = app.clone();
    let summary = tauri::async_runtime::spawn_blocking(move || {
        let cache = cache_app.state::<git::GitCache>();
        cache.cached_diff_summary(&dir, &launch_root, &base)
    })
    .await
    .map_err(|e| format!("git diff report task failed: {e}"))?;
    let Some(summary) = summary else {
        return Ok(None);
    };
    Ok(app.state::<GitDiffReportState>().claim(&summary))
}

/// The directory a command's window resolves its "launch directory" to: the
/// window's registered cwd when it has one (an extra window opened on a
/// project), otherwise the process working directory (the main window).
fn window_cwd(window: &tauri::WebviewWindow) -> Result<String, String> {
    match windows::window_cwd(window) {
        Some(cwd) => Ok(cwd.to_string_lossy().into_owned()),
        None => workspace::resolve_cwd(),
    }
}

/// IPC command: spawn a new PTY shell session, returns its session id.
///
/// `mode` controls what the session auto-runs. `"raw"` runs a plain shell;
/// any other value is treated as a coding-agent id and auto-runs `<mode>` as
/// the command (codex, copilot, claude, ...). `autorun` optionally pins the
/// exact command: a built-in whose CLI binary differs from its mode id (e.g.
/// mode `cursor` -> `cursor-agent`), a user-configured custom agent's full
/// command line, or the Editor agent's resolved `$EDITOR` command. It is
/// supplied by the frontend agent registry. Default mode (when omitted) is
/// `"opencode"`.
///
/// `cwd` optionally pins the directory the shell starts in (e.g. a git
/// worktree path). When omitted the shell starts in the invoking window's
/// launch directory (see [`window_cwd`]), which is the directory the app was
/// launched from for the main window.
#[tauri::command]
fn pty_spawn(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, PtyState>,
    mode: Option<String>,
    cwd: Option<String>,
    autorun: Option<String>,
) -> Result<u64, String> {
    let session_id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let mode = mode.unwrap_or_else(|| "opencode".to_string());
    // Default the start directory to the window's own launch directory so a
    // project window's sessions land in the project, not the process cwd.
    let cwd = cwd
        .map(std::path::PathBuf::from)
        .or_else(|| windows::window_cwd(&window));
    let window_label = window.label().to_string();
    pty::spawn(&app, session_id, &mode, cwd, autorun, Some(window_label))
        .map_err(|e| e.to_string())?;
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

/// IPC command: resolve the command the built-in "Editor" agent auto-runs
/// (honors `$EDITOR` with a per-platform fallback; see `pty::editor_command`).
#[tauri::command]
fn editor_command() -> String {
    pty::editor_command()
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

/// IPC command: resolve the canonical absolute path of the invoking window's
/// launch directory — its registered cwd when it has one (a window opened via
/// `window_new` on a project), otherwise the process's working directory,
/// falling back to the home directory when that is gone or unreadable. The
/// value keys the window's workspace persistence.
#[tauri::command]
fn workspace_cwd(window: tauri::WebviewWindow) -> Result<String, String> {
    window_cwd(&window)
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

/// One entry in the recent-projects list shown on the welcome/splash screen.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectInfo {
    cwd: String,
    /// Epoch ms when the project was last opened (0 when unknown).
    last_opened: u64,
    /// Whether the directory still exists on disk.
    exists: bool,
}

/// IPC command: list recent projects — directories with a saved workspace —
/// most recently opened first. Missing directories are still listed (the UI
/// greys them out) so the user can forget them.
#[tauri::command]
fn projects_list(app: tauri::AppHandle) -> Vec<ProjectInfo> {
    let store = match workspace::WorkspaceStore::load(&app) {
        Ok(store) => store,
        Err(_) => return Vec::new(),
    };
    let mut projects: Vec<ProjectInfo> = store
        .list()
        .into_iter()
        .map(|(cwd, doc)| ProjectInfo {
            exists: std::path::Path::new(&cwd).is_dir(),
            last_opened: workspace::last_opened(&doc),
            cwd,
        })
        .collect();
    projects.sort_by(|a, b| {
        b.last_opened
            .cmp(&a.last_opened)
            .then_with(|| a.cwd.cmp(&b.cwd))
    });
    projects
}

/// IPC command: record that a project was just opened from the splash screen
/// (updates its `lastOpened` stamp without touching the saved layout).
#[tauri::command]
fn project_touch(app: tauri::AppHandle, cwd: String) -> Result<(), String> {
    let store = workspace::WorkspaceStore::load(&app)?;
    store.touch(&cwd)
}

/// IPC command: open a new app window. `cwd` optionally pins the new window's
/// launch directory (its sessions default there and its workspace document is
/// keyed by it); when omitted the process working directory is used. Returns
/// the new window's label. The frontend passes the invoking window's own
/// launch directory so "New Window" opens a second window on the same project.
///
/// `start_mode` optionally requests a session the new window should open
/// right away instead of showing the splash — used when an agent is dragged
/// out of a window to open it there. The mode is handed to the new window via
/// its URL (`?start=<mode>`), which the frontend reads during init.
///
/// Async on purpose: on Windows, building a window inside a synchronous
/// command deadlocks (see [`tauri::WebviewWindowBuilder`] docs).
#[tauri::command]
async fn window_new(
    app: tauri::AppHandle,
    cwd: Option<String>,
    start_mode: Option<String>,
) -> Result<String, String> {
    windows::new_window(&app, cwd, start_mode)
}

/// IPC command: list the git worktrees of the repo containing the invoking
/// window's launch directory. `root` is `null` when the launch dir is not
/// inside a git repo, in which case `worktrees` is empty. Served from the
/// [`git::GitCache`] (async, never blocks the main thread).
#[tauri::command]
async fn git_worktrees(app: tauri::AppHandle, window: tauri::WebviewWindow) -> git::WorktreesInfo {
    let dir = match window_cwd(&window).map(std::path::PathBuf::from) {
        Ok(dir) => dir,
        Err(_) => return git::WorktreesInfo { root: None, worktrees: Vec::new() },
    };
    tauri::async_runtime::spawn_blocking(move || {
        let cache = app.state::<git::GitCache>();
        cache.cached_worktrees(&dir)
    })
    .await
    .unwrap_or_else(|_| git::WorktreesInfo { root: None, worktrees: Vec::new() })
}

/// IPC command: create a worktree on a new branch in the repo containing the
/// invoking window's launch directory. `path` is optional — when omitted the
/// worktree is created in a sibling directory named `<repo dir>-<branch>`.
/// Returns the absolute path of the new worktree. Invalidates the git cache
/// for that repo so the next listing reflects the new worktree.
#[tauri::command]
async fn git_worktree_create(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    branch: String,
    path: Option<String>,
) -> Result<String, String> {
    let dir = window_cwd(&window).map(std::path::PathBuf::from)?;
    tauri::async_runtime::spawn_blocking(move || {
        let created = git::create(&dir, &branch, path.as_deref());
        app.state::<git::GitCache>().invalidate(&dir);
        created
    })
    .await
    .map_err(|e| format!("git worktree create task failed: {e}"))?
    .map(|p| p.to_string_lossy().into_owned())
}

/// IPC command: remove the worktree at `path` from the repo containing the
/// invoking window's launch directory. Fails (surfacing git's error) when the
/// worktree has uncommitted or untracked files; pass `force` (default false)
/// to run `git worktree remove --force`, which also deletes the working tree.
#[tauri::command]
async fn git_worktree_remove(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    path: String,
    force: Option<bool>,
) -> Result<(), String> {
    let dir = window_cwd(&window).map(std::path::PathBuf::from)?;
    tauri::async_runtime::spawn_blocking(move || {
        let removed = git::remove(&dir, &path, force.unwrap_or(false));
        app.state::<git::GitCache>().invalidate(&dir);
        removed
    })
    .await
    .map_err(|e| format!("git worktree remove task failed: {e}"))?
}

/// IPC command: auto-create a throwaway worktree for a session. `name` is
/// sanitized into a branch (with a timestamp suffix so repeats don't collide)
/// and checked out under `base_dir` (the global "worktree base dir" setting,
/// defaults to `/tmp`). Returns the new checkout's path and branch.
#[tauri::command]
async fn git_worktree_auto_create(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    name: String,
    base_dir: String,
) -> Result<git::AutoWorktree, String> {
    let dir = window_cwd(&window).map(std::path::PathBuf::from)?;
    tauri::async_runtime::spawn_blocking(move || {
        let created = git::auto_create(&dir, &name, &base_dir);
        app.state::<git::GitCache>().invalidate(&dir);
        created
    })
    .await
    .map_err(|e| format!("git worktree auto-create task failed: {e}"))?
}

/// IPC command: whether the given path exists on disk as a directory. Used by
/// the frontend to decide whether a restored session's saved worktree path is
/// still valid before reusing it.
#[tauri::command]
fn dir_exists(path: String) -> bool {
    std::path::Path::new(&path).is_dir()
}

/// Only schemes the terminal should ever hand to the OS opener.
fn allowed_url_scheme(url: &str) -> bool {
    let lower = url.to_lowercase();
    lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("mailto:")
}

/// IPC command: open a URL in the system's default browser / handler.
/// Only `http`, `https` and `mailto` schemes are accepted.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if !allowed_url_scheme(trimmed) {
        return Err(format!("refusing to open URL with disallowed scheme: {trimmed}"));
    }
    use std::process::Command;
    if cfg!(target_os = "macos") {
        Command::new("open")
            .arg(trimmed)
            .spawn()
            .map_err(|e| format!("failed to launch 'open': {e}"))?;
    } else if cfg!(target_os = "windows") {
        Command::new("cmd")
            .args(["/C", "start", "", trimmed])
            .spawn()
            .map_err(|e| format!("failed to launch 'start': {e}"))?;
    } else {
        Command::new("xdg-open")
            .arg(trimmed)
            .spawn()
            .map_err(|e| format!("failed to launch xdg-open: {e}"))?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Capture the repo + HEAD commit the app launched against, so the UI can
    // report changes since startup a few seconds in (git_diff_summary).
    let launch_state = GitLaunchState::from_dir(
        &workspace::resolve_cwd()
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from(".")),
    );
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(PtyState::<tauri::Wry>::default())
        .manage(windows::WindowState::default())
        .manage(git::GitCache::default())
        .manage(dictation::DictationState::default())
        .manage(launch_state)
        .manage(GitDiffReportState::default())
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            editor_command,
            settings_get,
            settings_set,
            workspace_cwd,
            workspace_get,
            workspace_set,
            projects_list,
            project_touch,
            window_new,
            git_worktrees,
            git_worktree_create,
            git_worktree_remove,
            git_worktree_auto_create,
            git_diff_report,
            dir_exists,
            open_url,
            fonts::list_system_fonts,
            dictation::dictation_devices,
            dictation::dictation_start,
            dictation::dictation_stop,
            dictation::dictation_status,
            notifications::notify_desktop,
            notifications::ntfy_send
        ])
        // A minimal File menu exposing "New Window" (plus the standard app
        // menu on macOS). The menu item asks the *focused* window to open the
        // new one — it knows its own launch directory — by broadcasting a
        // `menu://new-window` event that only the focused window acts on.
        .menu(|app| {
            use tauri::menu::{MenuBuilder, SubmenuBuilder};
            let new_window = tauri::menu::MenuItemBuilder::with_id("new_window", "New Window")
                .build(app)?;
            let file = SubmenuBuilder::new(app, "File").item(&new_window).build()?;
            #[cfg(target_os = "macos")]
            let menu = {
                use tauri::menu::PredefinedMenuItem;
                let quit = PredefinedMenuItem::quit(app, None)?;
                let app_menu = SubmenuBuilder::new(app, "hiveField")
                    .item(&quit)
                    .build()?;
                MenuBuilder::new(app).items(&[&app_menu, &file]).build()?
            };
            #[cfg(not(target_os = "macos"))]
            let menu = MenuBuilder::new(app).item(&file).build()?;
            Ok(menu)
        })
        .on_menu_event(|app, event| {
            if event.id() == "new_window" {
                // Only the focused window should act (it knows its cwd).
                let _ = app.emit("menu://new-window", ());
            }
        })
        // When a window closes, tear down the sessions it spawned (the shells
        // would otherwise keep running orphaned in the background) and forget
        // its launch directory. Fires for every window, including on app exit.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let app = window.app_handle();
                let label = window.label().to_string();
                let state = app.state::<PtyState>();
                pty::kill_window_sessions(&state, &label);
                app.state::<windows::WindowState>().remove(&label);
                // A dictation capture owned by the closing window would
                // otherwise keep running (and recording) with no window left
                // to stop it or receive the result.
                dictation::stop_capture_for_window(&app, &label);
            }
        })
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| log::error!("error while running tauri application: {e}"));
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

    #[test]
    fn open_url_accepts_http_https_mailto() {
        for url in [
            "https://example.com",
            "http://example.com/path?q=1",
            "mailto:dev@example.com",
            "  https://trimmed.example.com  ",
        ] {
            assert!(allowed_url_scheme(url.trim()), "{url:?} should be allowed");
        }
    }

    #[test]
    fn open_url_rejects_other_schemes() {
        for url in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "data:text/html,<b>hi</b>",
            "ftp://example.com",
            "HTTPS-not-a-url",
            "",
        ] {
            assert!(!allowed_url_scheme(url.trim()), "{url:?} should be rejected");
        }
    }

    // ---- GitDiffReportState (re-armed "changes since launch" delivery) ----

    fn summary(changed: u64, insertions: u64, deletions: u64) -> git::DiffSummary {
        git::DiffSummary {
            changed,
            insertions,
            deletions,
        }
    }

    #[test]
    fn diff_report_claims_each_change_set_once() {
        let state = GitDiffReportState::default();
        // First delivery of a change set is claimed.
        let first = summary(3, 42, 7);
        assert_eq!(state.claim(&first), Some(first.clone()));
        // Same change set again: nothing new.
        assert_eq!(state.claim(&summary(3, 42, 7)), None);
        // A different change set re-arms the report.
        let second = summary(4, 50, 9);
        assert_eq!(state.claim(&second), Some(second.clone()));
        // ...and is then deduplicated too.
        assert_eq!(state.claim(&summary(4, 50, 9)), None);
    }

    #[test]
    fn diff_report_never_claims_empty_change_sets() {
        let state = GitDiffReportState::default();
        assert_eq!(state.claim(&summary(0, 0, 0)), None);
        // An empty change set must not mark the state as "delivered": a
        // non-empty one right after is still claimed.
        assert_eq!(state.claim(&summary(0, 0, 0)), None);
        assert_eq!(state.claim(&summary(1, 0, 0)), Some(summary(1, 0, 0)));
    }
}
