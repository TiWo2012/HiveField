//! Multi-window support: per-window launch directories and window creation.
//!
//! Every extra window created via the `window_new` command carries its own
//! launch directory (the `cwd` it was opened with). That directory is what the
//! window's sessions default to and what its workspace document is keyed by,
//! so two windows can work on different projects side by side. The main window
//! (label `"main"`, created from `tauri.conf.json`) is never registered and
//! falls back to the process working directory, exactly like before.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// Managed state: window label -> that window's launch directory.
pub struct WindowState {
    pub cwds: Mutex<HashMap<String, PathBuf>>,
}

impl Default for WindowState {
    fn default() -> Self {
        Self {
            cwds: Mutex::new(HashMap::new()),
        }
    }
}

impl WindowState {
    /// Remember the launch directory for a window (idempotent).
    pub fn register(&self, label: &str, cwd: PathBuf) {
        self.cwds.lock().unwrap().insert(label.to_string(), cwd);
    }

    /// The registered launch directory for a window, if any.
    pub fn cwd_for(&self, label: &str) -> Option<PathBuf> {
        self.cwds.lock().unwrap().get(label).cloned()
    }

    /// Forget a window's launch directory (called when the window is destroyed).
    pub fn remove(&self, label: &str) {
        self.cwds.lock().unwrap().remove(label);
    }
}

/// Unique label source for programmatically created windows (`win-1`, ...).
static WINDOW_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Resolve the directory a window should launch in: the explicitly requested
/// `cwd` when given (canonicalized, like the main window's launch directory),
/// otherwise the process working directory (falling back to the home
/// directory, same policy as `workspace::resolve_cwd`).
fn resolve_cwd(requested: Option<String>) -> Option<PathBuf> {
    match requested {
        Some(c) if !c.trim().is_empty() => {
            let path = PathBuf::from(c);
            // Canonicalize so the workspace document key matches what
            // `workspace_cwd` returns for the main window (a non-existent
            // path is kept as-is; it still resolves for session fallbacks).
            Some(path.canonicalize().unwrap_or(path))
        }
        _ => crate::workspace::resolve_cwd().ok().map(PathBuf::from),
    }
}

/// Create a new app window hosting the terminal frontend, mirroring the main
/// window's configuration (size, transparency, drag & drop). Registers the
/// window's launch directory (the provided `cwd`, or the process cwd) so
/// `workspace_cwd` / session defaults are scoped to it. Returns the new
/// window's label.
///
/// The window must be built from a thread that can reach the main loop; Tauri
/// internally marshals window creation to the main thread, but on Windows
/// building from inside a synchronous command deadlocks, so callers should use
/// this from an `async` command (the `window_new` IPC command is async).
pub fn new_window(app: &AppHandle, cwd: Option<String>) -> Result<String, String> {
    let launch_dir = resolve_cwd(cwd);

    // Pick a unique label (counter + existence check, in case a previous
    // `win-N` label is somehow still alive).
    let label = loop {
        let candidate = format!("win-{}", WINDOW_COUNTER.fetch_add(1, Ordering::Relaxed));
        if app.get_webview_window(&candidate).is_none() {
            break candidate;
        }
    };

    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("hiveField Terminal")
        .inner_size(960.0, 600.0)
        .min_inner_size(400.0, 300.0)
        .resizable(true)
        .transparent(true)
        .focused(true);

    // On Windows/Linux the menu is per-window, so a programmatically created
    // window does not inherit the app menu automatically — attach it so File →
    // New Window works there too (on macOS the menu bar is app-wide already).
    #[cfg(desktop)]
    if let Some(menu) = app.menu() {
        builder = builder.menu(menu);
    }

    let window = builder.build().map_err(|e| format!("failed to create window: {e}"))?;

    if let Some(dir) = launch_dir {
        window.state::<WindowState>().register(&label, dir);
    }
    Ok(label)
}

/// The launch directory a window should use for sessions / workspace docs:
/// its registered cwd when it has one (an extra window opened on a project),
/// otherwise the process working directory (the main window).
pub fn window_cwd<R: tauri::Runtime>(window: &WebviewWindow<R>) -> Option<PathBuf> {
    window
        .state::<WindowState>()
        .cwd_for(window.label())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_state_roundtrips_cwd() {
        let state = WindowState::default();
        assert_eq!(state.cwd_for("win-1"), None);
        state.register("win-1", PathBuf::from("/proj/a"));
        assert_eq!(state.cwd_for("win-1"), Some(PathBuf::from("/proj/a")));
        state.remove("win-1");
        assert_eq!(state.cwd_for("win-1"), None);
    }

    #[test]
    fn window_state_stores_windows_independently() {
        let state = WindowState::default();
        state.register("win-1", PathBuf::from("/proj/a"));
        state.register("win-2", PathBuf::from("/proj/b"));
        assert_eq!(state.cwd_for("win-1"), Some(PathBuf::from("/proj/a")));
        assert_eq!(state.cwd_for("win-2"), Some(PathBuf::from("/proj/b")));
        // Removing one never touches the other.
        state.remove("win-1");
        assert_eq!(state.cwd_for("win-2"), Some(PathBuf::from("/proj/b")));
    }

    #[test]
    fn resolve_cwd_falls_back_to_process_cwd() {
        let cwd = resolve_cwd(None).expect("process cwd resolves");
        assert!(cwd.is_absolute(), "resolved cwd must be absolute");
        let explicit = resolve_cwd(Some("/some/explicit/dir".into()));
        assert_eq!(explicit, Some(PathBuf::from("/some/explicit/dir")));
        // Empty / whitespace cwd behaves like None.
        let blank = resolve_cwd(Some("   ".into()));
        assert!(blank.is_some(), "blank cwd falls back to the process cwd");
    }
}
