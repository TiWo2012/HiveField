//! Local model management for the Whisper dictation engine.
//!
//! Model acquisition is configurable instead of an unconditional, surprise
//! multi-megabyte download at first use:
//!
//!   - `dictationModelDir` (optional) points at a directory that already
//!     contains the model file; default `<app_config_dir>/models`.
//!   - `dictationModelUrl` (optional) overrides the download URL; default the
//!     upstream `ggml-base.en.bin` release. Self-hosted mirrors or pinned CI
//!     builds can set their own.
//!   - `dictationAutoDownload` (default true) gates whether a missing model is
//!     downloaded at first use. When disabled, dictation fails with a clear
//!     status message telling the user where to place the model.

#[cfg(feature = "whisper")]
use std::fs;
#[cfg(feature = "whisper")]
use std::path::{Path, PathBuf};

#[cfg(feature = "whisper")]
use tauri::{AppHandle, Manager};

#[cfg(feature = "whisper")]
use crate::net::HttpClient;

/// Whisper model file name inside the model directory.
#[cfg(feature = "whisper")]
pub const MODEL_FILE: &str = "ggml-base.en.bin";

/// Default download URL for the Whisper model. Override via the
/// `dictationModelUrl` setting (see the module docs).
#[cfg(feature = "whisper")]
pub const DEFAULT_MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";

/// Read a trimmed, non-empty string setting, if present.
#[cfg(feature = "whisper")]
fn setting(app: &AppHandle, key: &str) -> Option<String> {
    let store = crate::settings::SettingsStore::load(app).ok()?;
    store
        .read()
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Resolve the directory that holds local dictation models: the
/// `dictationModelDir` setting when set, otherwise `<app_config_dir>/models`.
#[cfg(feature = "whisper")]
pub fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    match setting(app, "dictationModelDir") {
        Some(dir) => Ok(PathBuf::from(dir)),
        None => {
            let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
            Ok(dir.join("models"))
        }
    }
}

/// Whether a missing model should be downloaded automatically at first use
/// (`dictationAutoDownload` setting; default true).
#[cfg(feature = "whisper")]
pub fn auto_download(app: &AppHandle) -> bool {
    let settings = crate::settings::SettingsStore::load(app)
        .map(|store| store.read())
        .unwrap_or_default();
    settings
        .get("dictationAutoDownload")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(true)
}

/// The URL to download the Whisper model from (`dictationModelUrl` override,
/// falling back to [`DEFAULT_MODEL_URL`]).
#[cfg(feature = "whisper")]
pub fn model_url(app: &AppHandle) -> String {
    setting(app, "dictationModelUrl").unwrap_or_else(|| DEFAULT_MODEL_URL.to_string())
}

/// Path to the Whisper model file under a models dir.
#[cfg(feature = "whisper")]
pub fn model_path(models_dir: &Path) -> PathBuf {
    models_dir.join(MODEL_FILE)
}

/// Download the Whisper model to `dest`, invoking `on_progress` with the
/// download percentage (0..=100) as it advances. The file is written to a
/// `.part` temp file first and renamed into place on success, so a failed or
/// interrupted download never leaves a half-written model behind.
#[cfg(feature = "whisper")]
pub fn download_whisper_model(
    app: &AppHandle,
    dest: &Path,
    mut on_progress: impl FnMut(u8),
) -> Result<(), String> {
    let dir = dest
        .parent()
        .ok_or_else(|| "model path has no parent directory".to_string())?;
    fs::create_dir_all(dir).map_err(|e| format!("failed to create models dir: {e}"))?;
    let temp = dir.join(format!("{MODEL_FILE}.part"));
    let client = HttpClient::default();
    client.get_to_file(&model_url(app), &temp, |percent| on_progress(percent))?;
    fs::rename(&temp, dest).map_err(|e| format!("failed to finalize model file: {e}"))?;
    log::info!("downloaded whisper model to {}", dest.display());
    Ok(())
}

#[cfg(test)]
#[cfg(feature = "whisper")]
mod tests {
    use super::*;

    #[test]
    fn model_path_joins_file_into_dir() {
        assert_eq!(
            model_path(Path::new("/cfg/models")),
            PathBuf::from("/cfg/models/ggml-base.en.bin")
        );
    }

    #[test]
    fn default_model_url_is_https() {
        // Guard against accidentally regressing to a plaintext download.
        assert!(DEFAULT_MODEL_URL.starts_with("https://"), "{DEFAULT_MODEL_URL}");
    }
}
