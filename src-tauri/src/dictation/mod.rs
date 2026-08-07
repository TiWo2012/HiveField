//! Voice dictation backend: microphone capture + transcription, orchestrated
//! here and delegated to focused submodules:
//!
//!   - [`audio`] — microphone capture (cpal), resampling, PCM/WAV encoding.
//!   - [`model`] — local Whisper model location / download policy (configurable).
//!   - [`whisper`] — the local Whisper transcription engine.
//!   - [`cloud`] — the OpenAI-compatible cloud transcription engine.
//!
//! This module owns the state machine (idle → listening → transcribing → …),
//! the `DictationState` shared across all commands, and the IPC surface:
//!
//!   - `dictation_devices()` — list the microphones available for capture.
//!   - `dictation_start(app, state, window, engine, device, session_id)` — begin
//!     mic capture for the given engine on the given device (id from
//!     `dictation_devices`; omitted or empty = the system default input
//!     device). Model downloads and the Whisper context load run on background
//!     threads so the command never blocks the webview; the originating window
//!     and the session id active at keydown are recorded so the result lands in
//!     the right window/session. Returns quickly while a download/load is in
//!     flight — the frontend retries once the status returns to idle.
//!   - `dictation_stop(app, state, window)` — stop capture, transcribe, and
//!     emit the result. Only the window that started the capture may stop it;
//!     the result is emitted to that window with the keydown session id.
//!   - `dictation_status(state)` — return the current `DictationStatus`.
//!
//! Status changes are emitted as `dictation://status` events and transcriptions
//! as `dictation://result` events targeted at the originating window.

mod audio;
mod cloud;
mod model;
mod whisper;

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, Manager, State};

/// Whisper sample rate, in Hz.
pub const TARGET_SAMPLE_RATE: u32 = 16_000;

/// Minimum recording length (seconds) worth transcribing.
const MIN_PHRASE_SECONDS: f64 = 0.3;

/// Status payload sent to the frontend (JSON `{ status, detail }`, camelCase).
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationStatus {
    pub status: String,
    pub detail: Option<String>,
}

impl DictationStatus {
    fn new(status: &str, detail: Option<&str>) -> Self {
        Self {
            status: status.to_string(),
            detail: detail.map(|d| d.to_string()),
        }
    }

    fn idle() -> Self {
        Self::new("idle", None)
    }

    fn listening() -> Self {
        Self::new("listening", None)
    }

    fn transcribing() -> Self {
        Self::new("transcribing", None)
    }

    fn model_loading() -> Self {
        Self::new("model_loading", None)
    }

    fn downloading(detail: &str) -> Self {
        Self::new("downloading", Some(detail))
    }

    fn error(detail: &str) -> Self {
        Self::new("error", Some(detail))
    }
}

/// A microphone offered to the user in the dictation settings.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationDevice {
    /// Stable device id, persistable in settings; matches `dictation_start`'s
    /// `device` argument.
    pub id: String,
    /// Human-readable name shown in the settings dropdown.
    pub name: String,
    /// True when this is the host's default input device.
    pub is_default: bool,
}

/// IPC: list the microphones available for dictation, default first.
///
/// Device ids are stable across reboots so a saved preference keeps working;
/// the frontend stores the selected id in settings and passes it back to
/// `dictation_start`.
#[tauri::command]
pub fn dictation_devices() -> Vec<DictationDevice> {
    audio::list_devices()
}

/// Managed state shared across all dictation commands.
pub struct DictationState {
    pub inner: Mutex<DictationInner>,
}

impl Default for DictationState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(DictationInner::default()),
        }
    }
}

/// Inner, lock-protected state.
#[derive(Default)]
pub struct DictationInner {
    status: String,
    detail: Option<String>,
    engine: String,
    model_busy: bool,
    ctx: Option<Arc<whisper_rs::WhisperContext>>,
    capture: Option<audio::ActiveCapture>,
    /// Window label of the window that started the current capture. Only that
    /// window may stop the capture, and the transcription result is emitted
    /// back to it (multi-window: a keyup in another window must not steal the
    /// capture, and a result must never land in every window).
    window_label: Option<String>,
    /// Session id captured at keydown. The result is written into this session
    /// regardless of which pane is active when the transcription finishes.
    session_id: Option<u64>,
}

/// Normalize the engine argument to a known engine id: `"whisper"` (default)
/// or `"cloud"`. Unknown/None map to `"whisper"` (a saved `"vosk"` setting
/// from an older version degrades to whisper).
fn parse_engine(engine: Option<String>) -> String {
    let engine = engine
        .as_deref()
        .map(str::trim)
        .unwrap_or("whisper")
        .to_lowercase();
    match engine.as_str() {
        "whisper" | "cloud" => engine,
        _ => "whisper".to_string(),
    }
}

/// What a start invocation should do, decided under one lock so two racing
/// starts can never both spawn a download or both load the context.
enum StartAction {
    /// Begin capturing immediately.
    Start,
    /// Download the Whisper model on a background thread, then wait.
    DownloadWhisper,
    /// Load the Whisper context on a background thread.
    LoadWhisper,
}

/// IPC: begin microphone capture for the given transcription engine.
///
/// `device` is the stable id of the microphone to capture from (see
/// `dictation_devices`); when omitted or empty the host's default input device
/// is used. `session_id` is the terminal session active at keydown, captured by
/// the frontend so the transcription can be routed back to the same session
/// even if the user switches panes while it runs.
///
/// Downloads / Whisper-context loads run on background threads guarded by
/// `model_busy`, so the command never blocks the webview and never silently
/// loses the hold: when the work finishes the status returns to `idle` and the
/// frontend (which keeps the key held) calls back to start capture. Whether a
/// missing model is downloaded at all is governed by the `dictationAutoDownload`
/// setting (see [`model`]). All decisions happen under one lock so two racing
/// starts can never both spawn a download or both load the context.
#[tauri::command]
pub fn dictation_start(
    app: AppHandle,
    state: State<'_, DictationState>,
    window: tauri::WebviewWindow,
    engine: Option<String>,
    device: Option<String>,
    session_id: Option<u64>,
) -> Result<(), String> {
    let engine = parse_engine(engine);
    let window_label = window.label().to_string();
    let models_dir = model::models_dir(&app)?;

    let action = {
        let mut inner = state.inner.lock().map_err(poisoned)?;

        if inner.capture.is_some() {
            if inner.window_label.as_deref() == Some(window_label.as_str()) {
                // Same window already capturing (e.g. a retry that raced the
                // "listening" status): nothing to do.
                return Ok(());
            }
            // Another window owns the capture. Report the error to *this*
            // window only (an app-wide status would overwrite the owner's
            // "listening" badge) and reject the invocation so this window's
            // frontend clears its active flag.
            set_status_to(
                &app,
                &window_label,
                &DictationStatus::error("dictation is already in progress in another window"),
            );
            return Err("dictation is already in progress in another window".to_string());
        }

        match engine.as_str() {
            "cloud" => {
                if std::env::var("OPENAI_API_KEY").is_err() {
                    // Report as an error *and* reject the invocation: an Ok(())
                    // here would leave the frontend's active flag set through
                    // the whole hold with nothing ever happening.
                    set_status_to(
                        &app,
                        &window_label,
                        &DictationStatus::error(
                            "OPENAI_API_KEY environment variable is not set",
                        ),
                    );
                    return Err("OPENAI_API_KEY environment variable is not set".to_string());
                }
                StartAction::Start
            }
            _ => {
                // whisper
                let model_path = model::model_path(&models_dir);
                if !model_path.exists() {
                    if !model::auto_download(&app) {
                        set_status_to(
                            &app,
                            &window_label,
                            &DictationStatus::error(&format!(
                                "whisper model not found at {}; place it there or enable \
                                 \"auto-download model\" in settings",
                                model_path.display()
                            )),
                        );
                        return Err("whisper model is not downloaded".to_string());
                    }
                    if inner.model_busy {
                        // A download/load is already in flight (possibly started
                        // by another window); the frontend retries once the
                        // status returns to idle.
                        return Ok(());
                    }
                    inner.model_busy = true;
                    StartAction::DownloadWhisper
                } else if inner.ctx.is_none() {
                    if inner.model_busy {
                        return Ok(());
                    }
                    inner.model_busy = true;
                    StartAction::LoadWhisper
                } else {
                    StartAction::Start
                }
            }
        }
    };

    match action {
        StartAction::Start => {
            let capture = match audio::start_capture(device.as_deref()) {
                Ok(capture) => capture,
                Err(e) => {
                    set_status(&app, &DictationStatus::error(&e));
                    return Err(e);
                }
            };
            {
                let mut inner = state.inner.lock().map_err(poisoned)?;
                // Re-check under the lock: another window may have started
                // capturing while this one was setting up its stream (two
                // windows pressing at the same instant). Never overwrite the
                // winner's capture.
                if inner.capture.is_some() {
                    drop(capture);
                    return Err(
                        "dictation is already in progress in another window".to_string()
                    );
                }
                inner.capture = Some(capture);
                inner.engine = engine;
                inner.window_label = Some(window_label);
                inner.session_id = session_id;
            }
            set_status(&app, &DictationStatus::listening());
            Ok(())
        }
        StartAction::DownloadWhisper => {
            set_status(&app, &DictationStatus::downloading("0%"));
            let app = app.clone();
            let path = model::model_path(&models_dir);
            std::thread::spawn(move || {
                let result = download_whisper(&app, &path);
                finish_model_download(&app, result, "whisper model download failed");
            });
            Ok(())
        }
        StartAction::LoadWhisper => {
            set_status(&app, &DictationStatus::model_loading());
            let app = app.clone();
            let path = model::model_path(&models_dir);
            std::thread::spawn(move || load_whisper_in_background(&app, &path));
            Ok(())
        }
    }
}

/// IPC: stop capture, transcribe the recorded phrase with the active engine,
/// and emit the result.
///
/// Only the window that started the capture may stop it: a keyup in another
/// window must not steal this window's capture (the capture is app-global but
/// the keybind is per-window). The transcription result is emitted back to the
/// originating window carrying the session id captured at keydown, so it lands
/// in the right window and the right session even when the user switched
/// panes (or windows) while it was transcribing.
#[tauri::command]
pub fn dictation_stop(
    app: AppHandle,
    state: State<'_, DictationState>,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    let window_label = window.label().to_string();
    let (capture, engine, session_id, owner) = {
        let mut inner = state.inner.lock().map_err(poisoned)?;
        // Only the window that started the capture may stop it: a keyup in
        // another window must not steal this window's capture. A capture with
        // no recorded owner (shouldn't happen, but defensively) is stoppable
        // by anyone rather than stuck forever.
        if inner.capture.is_some()
            && inner.window_label.is_some()
            && inner.window_label.as_deref() != Some(window_label.as_str())
        {
            // Another window owns the capture; leave it alone. No status emit
            // (that would clobber the owner's badge), just reject.
            return Err("dictation is active in another window".to_string());
        }
        let Some(capture) = inner.capture.take() else {
            return Ok(());
        };
        let engine = inner.engine.clone();
        let session_id = inner.session_id;
        let owner = inner.window_label.clone();
        inner.window_label = None;
        inner.session_id = None;
        (capture, engine, session_id, owner)
    };

    capture.stop.store(true, Ordering::SeqCst);
    drop(capture.stream);

    let samples = {
        let mut buf = capture.samples.lock().map_err(poisoned)?;
        std::mem::take(&mut *buf)
    };

    let duration_seconds = samples.len() as f64 / capture.sample_rate as f64;
    if duration_seconds < MIN_PHRASE_SECONDS {
        // Status is targeted at the owner so a short tap in one window does
        // not clear another window's badge.
        if let Some(label) = owner.as_deref() {
            set_status_to(&app, label, &DictationStatus::idle());
        } else {
            set_status(&app, &DictationStatus::idle());
        }
        return Ok(());
    }

    let app = app.clone();
    let owner_label = owner.clone();
    std::thread::spawn(move || {
        // Transcription statuses go to the owning window only: a stop in one
        // window must not flash "Transcribing…" on every other window's badge.
        if let Some(label) = owner_label.as_deref() {
            set_status_to(&app, label, &DictationStatus::transcribing());
        } else {
            set_status(&app, &DictationStatus::transcribing());
        }
        let result = match engine.as_str() {
            "cloud" => match std::env::var("OPENAI_API_KEY") {
                Ok(key) => cloud::transcribe(&samples, capture.sample_rate, &key),
                Err(_) => Err("OPENAI_API_KEY environment variable is not set".to_string()),
            },
            _ => {
                let ctx = app.try_state::<DictationState>().and_then(|state| {
                    state.inner.lock().ok().and_then(|inner| inner.ctx.clone())
                });
                match ctx {
                    Some(ctx) => whisper::transcribe(&ctx, &samples, capture.sample_rate),
                    None => Err("whisper model is not loaded".to_string()),
                }
            }
        };
        match result {
            Ok(text) => {
                // Route the result to the window that started the dictation so
                // a second window's listener never writes into its own active
                // pane; the keydown session id pins the target session.
                let payload = serde_json::json!({ "text": text, "sessionId": session_id });
                match owner {
                    Some(label) => {
                        let _ = app.emit_to(&label, "dictation://result", payload);
                    }
                    None => {
                        let _ = app.emit("dictation://result", payload);
                    }
                }
                if let Some(label) = owner_label.as_deref() {
                    set_status_to(&app, label, &DictationStatus::idle());
                } else {
                    set_status(&app, &DictationStatus::idle());
                }
            }
            Err(e) => {
                log::error!("dictation transcription failed: {e}");
                if let Some(label) = owner_label.as_deref() {
                    set_status_to(&app, label, &DictationStatus::error(&e));
                } else {
                    set_status(&app, &DictationStatus::error(&e));
                }
            }
        }
    });
    Ok(())
}

/// IPC: return the current dictation status.
#[tauri::command]
pub fn dictation_status(state: State<'_, DictationState>) -> Result<DictationStatus, String> {
    let inner = state.inner.lock().map_err(poisoned)?;
    Ok(DictationStatus {
        status: inner.status.clone(),
        detail: inner.detail.clone(),
    })
}

/// Persist the status in managed state and emit it as a `dictation://status` event.
fn set_status(app: &AppHandle, status: &DictationStatus) {
    if let Some(state) = app.try_state::<DictationState>() {
        if let Ok(mut inner) = state.inner.lock() {
            inner.status = status.status.clone();
            inner.detail = status.detail.clone();
        }
    }
    let _ = app.emit("dictation://status", status);
}

/// Emit a status event to a single window (used for errors that concern only
/// the invoking window, e.g. "dictation is already in progress in another
/// window") so the other windows' badges are left alone.
fn set_status_to(app: &AppHandle, window_label: &str, status: &DictationStatus) {
    let _ = app.emit_to(window_label, "dictation://status", status);
}

/// Clear the `model_busy` guard and publish the final download status.
fn finish_model_download(app: &AppHandle, result: Result<(), String>, err_label: &str) {
    if let Some(state) = app.try_state::<DictationState>() {
        if let Ok(mut inner) = state.inner.lock() {
            inner.model_busy = false;
        }
    }
    let status = match result {
        Ok(()) => DictationStatus::idle(),
        Err(e) => {
            log::error!("{err_label}: {e}");
            DictationStatus::error(&e)
        }
    };
    set_status(app, &status);
}

/// Load the Whisper context on a background thread (a ~75 MB model parse must
/// never run on the webview/IPC thread: it freezes every window for seconds).
/// On success the context is stored and the status returns to `idle` so a
/// still-held dictation key can retry and start capture; on failure an error
/// status is emitted (instead of the badge hanging on "Loading…" forever).
fn load_whisper_in_background(app: &AppHandle, path: &std::path::Path) {
    match whisper::load_context(path) {
        Ok(ctx) => {
            if let Some(state) = app.try_state::<DictationState>() {
                if let Ok(mut inner) = state.inner.lock() {
                    inner.ctx.get_or_insert(ctx);
                    inner.model_busy = false;
                }
            }
            set_status(app, &DictationStatus::idle());
        }
        Err(e) => {
            log::error!("failed to load whisper model: {e}");
            if let Some(state) = app.try_state::<DictationState>() {
                if let Ok(mut inner) = state.inner.lock() {
                    inner.model_busy = false;
                }
            }
            set_status(app, &DictationStatus::error(&e));
        }
    }
}

/// Stop and discard any capture owned by `window_label`. Called when a window
/// is destroyed so a capture cannot keep running (and recording) with nobody
/// left to stop it and no window to receive the result.
pub fn stop_capture_for_window(app: &AppHandle, window_label: &str) {
    if let Some(state) = app.try_state::<DictationState>() {
        let capture = {
            let mut inner = match state.inner.lock() {
                Ok(inner) => inner,
                Err(_) => return,
            };
            if inner.window_label.as_deref() != Some(window_label) {
                return;
            }
            inner.window_label = None;
            inner.session_id = None;
            inner.capture.take()
        };
        if let Some(capture) = capture {
            capture.stop.store(true, Ordering::SeqCst);
            drop(capture.stream);
        }
    }
}

/// Download the Whisper model to `dest`, emitting download-progress status
/// events (runs on a background thread; see [`model::download_whisper_model`]).
fn download_whisper(app: &AppHandle, dest: &std::path::Path) -> Result<(), String> {
    model::download_whisper_model(app, dest, |percent| {
        set_status(app, &DictationStatus::downloading(&format!("{percent}%")));
    })
}

fn poisoned<T>(_: std::sync::PoisonError<T>) -> String {
    "dictation state poisoned".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn status_serializes_to_camel_case_keys() {
        let listening = DictationStatus::listening();
        assert_eq!(
            serde_json::to_value(&listening).unwrap(),
            json!({ "status": "listening", "detail": null })
        );

        let downloading = DictationStatus::downloading("34%");
        assert_eq!(
            serde_json::to_value(&downloading).unwrap(),
            json!({ "status": "downloading", "detail": "34%" })
        );

        let error = DictationStatus::error("boom");
        assert_eq!(
            serde_json::to_value(&error).unwrap(),
            json!({ "status": "error", "detail": "boom" })
        );
    }

    #[test]
    fn parse_engine_normalizes_inputs() {
        assert_eq!(parse_engine(None), "whisper");
        assert_eq!(parse_engine(Some("whisper".to_string())), "whisper");
        assert_eq!(parse_engine(Some("cloud".to_string())), "cloud");
        assert_eq!(parse_engine(Some("  CLOUD  ".to_string())), "cloud");
        assert_eq!(parse_engine(Some("vosk".to_string())), "whisper");
        assert_eq!(parse_engine(Some("bogus".to_string())), "whisper");
        assert_eq!(parse_engine(Some("".to_string())), "whisper");
    }
}
