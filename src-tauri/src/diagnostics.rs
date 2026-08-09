//! Diagnostics blob: environment context for bug reports.
//!
//! Collects everything a bug report needs — app version, OS/arch, install
//! dir, launch dir, git context, settings schema version, worktree base dir,
//! dictation engine, and the log file path — into one flat JSON object. The
//! same data is exposed two ways:
//!
//!   - the `diagnostics()` IPC command, invoked by the palette action
//!     "Copy diagnostics" (pastes the formatted blob via `clipboard.ts`);
//!   - `hivefield --doctor`, a `main()` arg check that prints the identical
//!     blob to stdout before the Tauri app boots — for users who can't open
//!     the UI. That path has no `AppHandle`, so it resolves the app-scoped
//!     directories from the platform dirs (via the `dirs` crate) instead of
//!     `tauri::Manager::path()`, mirroring exactly what Tauri would resolve
//!     in-process (see `tauri::path::PathResolver::app_log_dir`).

use std::path::PathBuf;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::dictation;
use crate::git;
use crate::settings::{SettingsStore, SETTINGS_SCHEMA_VERSION};
use crate::updater;
use crate::workspace;

/// Bundle identifier from `tauri.conf.json` — the directory name Tauri
/// appends to the platform dirs for app-scoped config/data/log paths.
/// Mirrored here (rather than read from the compiled config) so the
/// `--doctor` CLI can resolve paths before any Tauri context exists.
const BUNDLE_IDENTIFIER: &str = "dev.hivefield.terminal";

/// The log file name the logging setup writes (see `docs/INFRA_PLAN.md` #1).
const LOG_FILE_NAME: &str = "hivefield.log";

/// The effective worktree base dir when settings carry none (mirrors the
/// frontend's `DEFAULT_SETTINGS.worktreeBaseDir`).
const DEFAULT_WORKTREE_BASE_DIR: &str = "/tmp";

/// The assembled diagnostics, ready to render as a flat JSON blob.
struct Diagnostics {
    /// Install dir (where the binary lives / the updater installs to).
    install_dir: String,
    /// Process launch directory (what sessions default to).
    launch_dir: String,
    /// Git repo root containing the launch dir, when it is inside a repo.
    git_repo: Option<String>,
    /// HEAD commit of that repo at the time diagnostics ran.
    git_commit: Option<String>,
    /// Effective worktree base dir (settings value or the default).
    worktree_base_dir: String,
    /// Resolved dictation engine id (`whisper` / `cloud`).
    dictation_engine: String,
    /// The rotated log file the app writes to.
    log_file: String,
}

impl Diagnostics {
    /// Render the blob as a flat JSON object. `gitRepo`/`gitCommit` are
    /// `null` when the launch dir is not inside a git repository; resolution
    /// failures keep their reason inline (e.g. `"(unavailable: …)"`) so the
    /// paste stays informative for a bug report.
    fn to_json(&self) -> Value {
        json!({
            "app": "hivefield",
            "version": env!("CARGO_PKG_VERSION"),
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "installDir": self.install_dir,
            "launchDir": self.launch_dir,
            "gitRepo": self.git_repo,
            "gitCommit": self.git_commit,
            "settingsSchemaVersion": SETTINGS_SCHEMA_VERSION,
            "worktreeBaseDir": self.worktree_base_dir,
            "dictationEngine": self.dictation_engine,
            "logFile": self.log_file,
        })
    }
}

/// Diagnostics resolved from a live app (the `diagnostics()` IPC command).
pub fn from_app(app: &AppHandle) -> Value {
    let settings = SettingsStore::load(app)
        .map(|store| store.read())
        .unwrap_or_default();
    let log_dir = app.path().app_log_dir().map_err(|e| e.to_string());
    collect(&settings, log_dir)
}

/// Diagnostics resolved without a Tauri app (`hivefield --doctor`): reads the
/// stored settings from disk and mirrors Tauri's app-scoped dir resolution.
pub fn collect_cli() -> Value {
    let settings = dirs::config_dir()
        .map(|dir| {
            SettingsStore::from_path(dir.join(BUNDLE_IDENTIFIER).join("settings.json")).read()
        })
        .unwrap_or_default();
    collect(&settings, cli_log_dir())
}

/// Build the blob from the settings document and the resolved log directory.
/// Shared by the IPC and CLI paths so both always report identical data.
fn collect(settings: &Value, log_dir: Result<PathBuf, String>) -> Value {
    let launch_dir = workspace::resolve_cwd();
    let git_repo = launch_dir
        .as_deref()
        .ok()
        .map(std::path::Path::new)
        .and_then(git::repo_root);
    let git_commit = git_repo.as_deref().and_then(git::head_commit);
    Diagnostics {
        install_dir: or_error(updater::install_dir()),
        launch_dir: or_error(launch_dir),
        git_repo: git_repo.map(|p| p.to_string_lossy().into_owned()),
        git_commit,
        worktree_base_dir: worktree_base_dir(settings),
        dictation_engine: dictation_engine(settings),
        log_file: or_error(
            log_dir.map(|d| d.join(LOG_FILE_NAME).to_string_lossy().into_owned()),
        ),
    }
    .to_json()
}

/// The effective worktree base dir: the stored `worktreeBaseDir` setting when
/// present and non-empty, else the frontend's default (`/tmp`).
fn worktree_base_dir(settings: &Value) -> String {
    settings
        .get("worktreeBaseDir")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_WORKTREE_BASE_DIR)
        .to_string()
}

/// The resolved dictation engine id, normalized exactly like `dictation_start`
/// normalizes its argument (unknown/absent values degrade to the build
/// default: `whisper` when the feature is on, else `cloud`).
fn dictation_engine(settings: &Value) -> String {
    dictation::parse_engine(
        settings
            .get("dictationEngine")
            .and_then(Value::as_str)
            .map(str::to_string),
    )
}

/// The log directory as Tauri would resolve it in-process, computed from the
/// platform dirs alone (`--doctor` runs before any Tauri context exists).
fn cli_log_dir() -> Result<PathBuf, String> {
    // Mirrors tauri::path::PathResolver::app_log_dir: macOS puts logs in
    // `~/Library/Logs/{identifier}` (no `logs` subdir); Linux/Windows use
    // `{local_data_dir}/{identifier}/logs`.
    #[cfg(target_os = "macos")]
    let base = dirs::home_dir()
        .ok_or_else(|| "home directory unavailable".to_string())?
        .join("Library/Logs");
    #[cfg(not(target_os = "macos"))]
    let base =
        dirs::data_local_dir().ok_or_else(|| "local data directory unavailable".to_string())?;
    Ok(base.join(BUNDLE_IDENTIFIER).join("logs"))
}

/// Render a resolution result as a string, keeping the failure reason so the
/// blob never silently drops a missing piece of context.
fn or_error(result: Result<String, String>) -> String {
    result.unwrap_or_else(|e| format!("(unavailable: {e})"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> Diagnostics {
        Diagnostics {
            install_dir: "/home/u/.local/bin".to_string(),
            launch_dir: "/home/u/projects/foo".to_string(),
            git_repo: Some("/home/u/projects/foo".to_string()),
            git_commit: Some("abc123".to_string()),
            worktree_base_dir: "/tmp".to_string(),
            dictation_engine: "cloud".to_string(),
            log_file: "/home/u/.local/share/dev.hivefield.terminal/logs/hivefield.log"
                .to_string(),
        }
    }

    #[test]
    fn blob_contains_the_full_flat_key_set() {
        let blob = sample().to_json();
        let obj = blob.as_object().expect("blob must be a JSON object");
        for key in [
            "app",
            "version",
            "os",
            "arch",
            "installDir",
            "launchDir",
            "gitRepo",
            "gitCommit",
            "settingsSchemaVersion",
            "worktreeBaseDir",
            "dictationEngine",
            "logFile",
        ] {
            assert!(obj.contains_key(key), "missing key {key}: {blob}");
        }
    }

    #[test]
    fn blob_reports_version_platform_and_schema() {
        let blob = sample().to_json();
        assert_eq!(blob["app"], "hivefield");
        assert_eq!(blob["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(blob["os"], std::env::consts::OS);
        assert_eq!(blob["arch"], std::env::consts::ARCH);
        assert_eq!(blob["settingsSchemaVersion"], json!(SETTINGS_SCHEMA_VERSION));
    }

    #[test]
    fn blob_echoes_resolved_fields() {
        let blob = sample().to_json();
        assert_eq!(blob["installDir"], "/home/u/.local/bin");
        assert_eq!(blob["launchDir"], "/home/u/projects/foo");
        assert_eq!(blob["gitRepo"], "/home/u/projects/foo");
        assert_eq!(blob["gitCommit"], "abc123");
        assert_eq!(blob["worktreeBaseDir"], "/tmp");
        assert_eq!(blob["dictationEngine"], "cloud");
        assert_eq!(
            blob["logFile"],
            "/home/u/.local/share/dev.hivefield.terminal/logs/hivefield.log"
        );
    }

    #[test]
    fn git_fields_are_null_outside_a_repo() {
        let d = Diagnostics {
            git_repo: None,
            git_commit: None,
            ..sample()
        };
        let blob = d.to_json();
        assert_eq!(blob["gitRepo"], Value::Null);
        assert_eq!(blob["gitCommit"], Value::Null);
    }

    #[test]
    fn worktree_base_dir_defaults_when_settings_have_none() {
        assert_eq!(worktree_base_dir(&json!({})), DEFAULT_WORKTREE_BASE_DIR);
        assert_eq!(
            worktree_base_dir(&json!({ "worktreeBaseDir": "" })),
            DEFAULT_WORKTREE_BASE_DIR
        );
    }

    #[test]
    fn worktree_base_dir_prefers_the_setting() {
        assert_eq!(
            worktree_base_dir(&json!({ "worktreeBaseDir": "  /home/u/wt  " })),
            "/home/u/wt"
        );
    }

    #[test]
    fn dictation_engine_normalizes_like_dictation_start() {
        assert_eq!(
            dictation_engine(&json!({ "dictationEngine": "CLOUD" })),
            dictation::parse_engine(Some("cloud".to_string()))
        );
        assert_eq!(
            dictation_engine(&json!({ "dictationEngine": "whisper" })),
            dictation::parse_engine(Some("whisper".to_string()))
        );
        // Absent/unknown settings degrade to the build default.
        assert_eq!(
            dictation_engine(&json!({})),
            dictation::parse_engine(None)
        );
    }

    #[test]
    fn or_error_keeps_the_reason() {
        assert_eq!(or_error(Ok("/tmp".to_string())), "/tmp");
        assert!(or_error(Err("HOME unset".to_string())).contains("unavailable"));
        assert!(or_error(Err("HOME unset".to_string())).contains("HOME unset"));
    }
}
