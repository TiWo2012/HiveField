//! Voice dictation backend: microphone capture (cpal) + transcription via one of
//! three engines (local Whisper, local Vosk, or an OpenAI-compatible cloud API).
//!
//! Exposes four IPC commands to the frontend:
//!   - `dictation_devices()` — list the microphones available for capture.
//!   - `dictation_start(app, state, engine, device)` — begin mic capture for
//!     the given engine on the given device (id from `dictation_devices`;
//!     omitted or empty = the system default input device).
//!   - `dictation_stop(app, state)` — stop capture, transcribe, emit the result.
//!   - `dictation_status(state)` — return the current `DictationStatus`.
//!
//! Status changes are emitted as `dictation://status` events and transcriptions as
//! `dictation://result` events.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait};
use tauri::{AppHandle, Emitter, Manager, State};

use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

/// Whisper sample rate, in Hz.
pub const TARGET_SAMPLE_RATE: u32 = 16_000;

/// Whisper model file name inside `<app_config_dir>/models/`.
pub const MODEL_FILE: &str = "ggml-base.en.bin";

/// Where to download the Whisper model from when it is missing locally.
pub const MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";

/// Vosk model directory name inside `<app_config_dir>/models/`.
pub const VOSK_MODEL_DIR: &str = "vosk-model-small-en-us-0.15";

/// Where to download the Vosk model archive from when it is missing locally.
pub const VOSK_MODEL_URL: &str =
    "https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip";

/// OpenAI-compatible `/audio/transcriptions` endpoint.
pub const CLOUD_API_URL: &str = "https://api.openai.com/v1/audio/transcriptions";

/// Multipart boundary used when building the cloud transcription request body.
pub const MULTIPART_BOUNDARY: &str = "hivefield-dictation-boundary";

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
    let host = cpal::default_host();
    let Ok(devices) = host.input_devices() else {
        return Vec::new();
    };
    let default_id = host
        .default_input_device()
        .and_then(|d| d.id().ok())
        .map(|id| id.to_string());

    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for device in devices {
        let Ok(id) = device.id() else { continue };
        let id = id.to_string();
        if !seen.insert(id.clone()) {
            continue; // some hosts list the same device more than once
        }
        let name = device
            .description()
            .map(|d| d.name().to_string())
            .unwrap_or_else(|_| id.clone());
        out.push(DictationDevice {
            is_default: default_id.as_deref() == Some(id.as_str()),
            id,
            name,
        });
    }
    out.sort_by(|a, b| {
        b.is_default
            .cmp(&a.is_default)
            .then_with(|| a.name.cmp(&b.name))
    });
    out
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
    ctx: Option<Arc<WhisperContext>>,
    capture: Option<ActiveCapture>,
}

/// A live microphone capture.
struct ActiveCapture {
    stream: cpal::Stream,
    samples: Arc<Mutex<Vec<f32>>>,
    stop: Arc<AtomicBool>,
    sample_rate: u32,
}

/// Normalize the engine argument to a known engine id: `"whisper"` (default),
/// `"vosk"`, or `"cloud"`. Unknown/None map to `"whisper"`.
fn parse_engine(engine: Option<String>) -> String {
    let engine = engine
        .as_deref()
        .map(str::trim)
        .unwrap_or("whisper")
        .to_lowercase();
    match engine.as_str() {
        "whisper" | "vosk" | "cloud" => engine,
        _ => "whisper".to_string(),
    }
}

/// IPC: begin microphone capture for the given transcription engine.
///
/// `device` is the stable id of the microphone to capture from (see
/// `dictation_devices`); when omitted or empty the host's default input device
/// is used. Lazily downloads / extracts the local model (Whisper / Vosk), loads
/// the Whisper context exactly once, then starts capturing at 16 kHz if the
/// device supports it. Downloads run on a background thread guarded by
/// `model_busy`.
#[tauri::command]
pub fn dictation_start(
    app: AppHandle,
    state: State<'_, DictationState>,
    engine: Option<String>,
    device: Option<String>,
) -> Result<(), String> {
    let engine = parse_engine(engine);
    let models_dir = models_dir(&app)?;

    {
        let inner = state.inner.lock().map_err(poisoned)?;
        if inner.capture.is_some() {
            return Ok(());
        }
        if inner.model_busy {
            // A model download/extract for some engine is already in flight.
            return Ok(());
        }
    }

    match engine.as_str() {
        "vosk" => {
            let model_dir = vosk_model_dir(&models_dir);
            if !model_dir.exists() {
                set_status(&app, &DictationStatus::downloading("0%"));
                {
                    let mut inner = state.inner.lock().map_err(poisoned)?;
                    inner.model_busy = true;
                }
                let app = app.clone();
                std::thread::spawn(move || {
                    let result = download_vosk_model(&app, &models_dir);
                    finish_model_download(&app, result, "vosk model download failed");
                });
                return Ok(());
            }
        }
        "cloud" => {
            if std::env::var("OPENAI_API_KEY").is_err() {
                set_status(
                    &app,
                    &DictationStatus::error("OPENAI_API_KEY environment variable is not set"),
                );
                return Ok(());
            }
        }
        _ => {
            // whisper
            let model_path = models_dir.join(MODEL_FILE);
            if !model_path.exists() {
                set_status(&app, &DictationStatus::downloading("0%"));
                {
                    let mut inner = state.inner.lock().map_err(poisoned)?;
                    inner.model_busy = true;
                }
                let app = app.clone();
                let path = model_path.clone();
                std::thread::spawn(move || {
                    let result = download_whisper_model(&app, &path);
                    finish_model_download(&app, result, "whisper model download failed");
                });
                return Ok(());
            }
        }
    }

    if engine == "whisper" {
        let needs_load = {
            let inner = state.inner.lock().map_err(poisoned)?;
            inner.ctx.is_none()
        };
        if needs_load {
            set_status(&app, &DictationStatus::model_loading());
            let path = models_dir.join(MODEL_FILE);
            let ctx = load_context(&path)?;
            {
                let mut inner = state.inner.lock().map_err(poisoned)?;
                inner.ctx.get_or_insert(ctx);
            }
            set_status(&app, &DictationStatus::idle());
        }
    }

    let capture = match start_capture(device.as_deref()) {
        Ok(capture) => capture,
        Err(e) => {
            set_status(&app, &DictationStatus::error(&e));
            return Err(e);
        }
    };
    {
        let mut inner = state.inner.lock().map_err(poisoned)?;
        inner.capture = Some(capture);
        inner.engine = engine;
    }
    set_status(&app, &DictationStatus::listening());
    Ok(())
}

/// IPC: stop capture, transcribe the recorded phrase with the active engine,
/// and emit the result.
#[tauri::command]
pub fn dictation_stop(app: AppHandle, state: State<'_, DictationState>) -> Result<(), String> {
    let (capture, engine) = {
        let mut inner = state.inner.lock().map_err(poisoned)?;
        let engine = inner.engine.clone();
        match inner.capture.take() {
            Some(capture) => (capture, engine),
            None => return Ok(()),
        }
    };

    capture.stop.store(true, Ordering::SeqCst);
    drop(capture.stream);

    let samples = {
        let mut buf = capture.samples.lock().map_err(poisoned)?;
        std::mem::take(&mut *buf)
    };

    let duration_seconds = samples.len() as f64 / capture.sample_rate as f64;
    if duration_seconds < MIN_PHRASE_SECONDS {
        set_status(&app, &DictationStatus::idle());
        return Ok(());
    }

    let app = app.clone();
    std::thread::spawn(move || {
        set_status(&app, &DictationStatus::transcribing());
        let result = match engine.as_str() {
            "vosk" => {
                let model_dir = app
                    .path()
                    .app_config_dir()
                    .map(|dir| dir.join("models").join(VOSK_MODEL_DIR))
                    .map_err(|e| e.to_string());
                match model_dir {
                    Ok(dir) => transcribe_vosk(&samples, capture.sample_rate, &dir),
                    Err(e) => Err(e),
                }
            }
            "cloud" => match std::env::var("OPENAI_API_KEY") {
                Ok(key) => transcribe_cloud(&samples, capture.sample_rate, &key),
                Err(_) => Err("OPENAI_API_KEY environment variable is not set".to_string()),
            },
            _ => {
                let ctx = app.try_state::<DictationState>().and_then(|state| {
                    state.inner.lock().ok().and_then(|inner| inner.ctx.clone())
                });
                match ctx {
                    Some(ctx) => transcribe_whisper(&ctx, &samples, capture.sample_rate),
                    None => Err("whisper model is not loaded".to_string()),
                }
            }
        };
        match result {
            Ok(text) => {
                let _ = app.emit("dictation://result", serde_json::json!({ "text": text }));
                set_status(&app, &DictationStatus::idle());
            }
            Err(e) => {
                log::error!("dictation transcription failed: {e}");
                set_status(&app, &DictationStatus::error(&e));
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

fn poisoned<T>(_: std::sync::PoisonError<T>) -> String {
    "dictation state poisoned".to_string()
}

/// Resolve `<app_config_dir>/models`.
fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("models"))
}

/// Resolve the Vosk model directory under a models dir.
fn vosk_model_dir(models_dir: &Path) -> PathBuf {
    models_dir.join(VOSK_MODEL_DIR)
}

/// Load the Whisper context for the given model file, wrapped in an `Arc`.
fn load_context(path: &Path) -> Result<Arc<WhisperContext>, String> {
    let ctx = WhisperContext::new_with_params(path, WhisperContextParameters::default())
        .map_err(|e| format!("failed to load whisper model: {e}"))?;
    Ok(Arc::new(ctx))
}

/// Resample (if needed) to 16 kHz mono f32 and run Whisper, returning the
/// joined transcription.
fn transcribe_whisper(ctx: &WhisperContext, samples: &[f32], input_rate: u32) -> Result<String, String> {
    let audio = resample_to_16k(samples, input_rate)?;

    let mut st = ctx
        .create_state()
        .map_err(|e| format!("failed to create whisper state: {e}"))?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some("en"));
    params.set_translate(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_special(false);

    st.full(params, &audio)
        .map_err(|e| format!("whisper transcription failed: {e}"))?;

    let mut texts = Vec::with_capacity(st.full_n_segments().max(0) as usize);
    for segment in st.as_iter() {
        let text = segment
            .to_str()
            .map_err(|e| format!("whisper segment text failed: {e}"))?;
        texts.push(text.to_string());
    }
    Ok(join_segments(texts))
}

/// Transcribe 16 kHz mono audio with a local Vosk model.
fn transcribe_vosk(samples: &[f32], input_rate: u32, model_dir: &Path) -> Result<String, String> {
    let audio = resample_to_16k(samples, input_rate)?;
    let i16_samples = f32_to_i16(&audio);

    let path_str = model_dir
        .to_str()
        .ok_or_else(|| "vosk model path is not valid UTF-8".to_string())?;
    let model = vosk::Model::new(path_str).ok_or_else(|| "failed to load vosk model".to_string())?;
    // The Recognizer is constructed inside the transcribing thread and never
    // shared across threads.
    let mut rec = vosk::Recognizer::new(&model, TARGET_SAMPLE_RATE as f32)
        .ok_or_else(|| "failed to create vosk recognizer".to_string())?;
    rec.accept_waveform(&i16_samples)
        .map_err(|e| format!("vosk recognition failed: {e}"))?;
    let text = rec
        .final_result()
        .single()
        .map(|r| r.text.to_string())
        .unwrap_or_default();
    Ok(text)
}

/// Transcribe 16 kHz mono audio via an OpenAI-compatible `/audio/transcriptions`
/// endpoint (multipart POST of an in-memory WAV).
fn transcribe_cloud(samples: &[f32], input_rate: u32, api_key: &str) -> Result<String, String> {
    let audio = resample_to_16k(samples, input_rate)?;
    let wav = encode_wav_pcm16(&f32_to_i16(&audio));
    let body = build_transcriptions_multipart(&wav);

    let response = ureq::post(CLOUD_API_URL)
        .set("Authorization", &format!("Bearer {api_key}"))
        .set(
            "Content-Type",
            &format!("multipart/form-data; boundary={MULTIPART_BOUNDARY}"),
        )
        .send_bytes(&body);

    let response = match response {
        Ok(response) => response,
        Err(ureq::Error::Status(code, response)) => {
            let body = response.into_string().unwrap_or_default();
            return Err(format!("cloud transcription returned HTTP {code}: {body}"));
        }
        Err(e) => return Err(format!("cloud transcription request failed: {e}")),
    };

    let text = response
        .into_string()
        .map_err(|e| format!("failed to read cloud response: {e}"))?;
    let json: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("failed to parse cloud response: {e}"))?;
    json.get("text")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("cloud response has no \"text\" field: {text}"))
}

/// Trim each segment and join non-empty segments with a single space.
fn join_segments(texts: impl IntoIterator<Item = String>) -> String {
    texts
        .into_iter()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Download `url` to `dest`, emitting `downloading` progress status events.
fn download_with_progress(app: &AppHandle, url: &str, dest: &Path) -> Result<(), String> {
    let response = ureq::get(url)
        .call()
        .map_err(|e| format!("download request failed: {e}"))?;

    let total: u64 = response
        .header("Content-Length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);

    let mut file = fs::File::create(dest).map_err(|e| format!("failed to create temp file: {e}"))?;

    let mut reader = response.into_reader();
    let mut buf = [0u8; 256 * 1024];
    let mut downloaded: u64 = 0;
    let mut last_percent = 0u8;
    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("download read failed: {e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])
            .map_err(|e| format!("download write failed: {e}"))?;
        downloaded += n as u64;
        if total > 0 {
            let percent = (downloaded * 100 / total) as u8;
            if percent != last_percent {
                last_percent = percent;
                set_status(app, &DictationStatus::downloading(&format!("{percent}%")));
            }
        }
    }
    Ok(())
}

/// Download the Whisper model to a temp file, then rename it into place.
fn download_whisper_model(app: &AppHandle, dest: &Path) -> Result<(), String> {
    let dir = dest
        .parent()
        .ok_or_else(|| "model path has no parent directory".to_string())?;
    fs::create_dir_all(dir).map_err(|e| format!("failed to create models dir: {e}"))?;
    let temp = dir.join(format!("{MODEL_FILE}.part"));
    download_with_progress(app, MODEL_URL, &temp)?;
    fs::rename(&temp, dest).map_err(|e| format!("failed to finalize model file: {e}"))?;
    log::info!("downloaded whisper model to {}", dest.display());
    Ok(())
}

/// Download the Vosk model archive, extract it into `<models>/`, then delete
/// the archive. The archive is written to a `.part` file first.
fn download_vosk_model(app: &AppHandle, models_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(models_dir).map_err(|e| format!("failed to create models dir: {e}"))?;
    if vosk_model_dir(models_dir).exists() {
        return Ok(());
    }

    let archive = models_dir.join(format!("{VOSK_MODEL_DIR}.zip"));
    let part = models_dir.join(format!("{VOSK_MODEL_DIR}.zip.part"));
    download_with_progress(app, VOSK_MODEL_URL, &part)?;
    fs::rename(&part, &archive).map_err(|e| format!("failed to finalize vosk archive: {e}"))?;

    let file =
        fs::File::open(&archive).map_err(|e| format!("failed to open vosk archive: {e}"))?;
    let mut zip =
        zip::ZipArchive::new(file).map_err(|e| format!("failed to read vosk archive: {e}"))?;
    zip.extract(models_dir)
        .map_err(|e| format!("failed to extract vosk model: {e}"))?;
    fs::remove_file(&archive).map_err(|e| format!("failed to remove vosk archive: {e}"))?;

    log::info!("installed vosk model at {}", vosk_model_dir(models_dir).display());
    Ok(())
}

/// Resolve the input device to capture from: `device_id` when it is present and
/// still available, otherwise the host's default input device. A saved id that
/// no longer resolves (unplugged / renamed) is an error rather than a silent
/// fallback, so the user notices the wrong mic isn't being used.
fn resolve_input_device(device_id: Option<&str>) -> Result<cpal::Device, String> {
    let host = cpal::default_host();
    if let Some(id) = device_id {
        let id = id.trim();
        if !id.is_empty() {
            if let Ok(parsed) = cpal::DeviceId::from_str(id) {
                if let Some(device) = host.device_by_id(&parsed) {
                    return Ok(device);
                }
            }
            return Err(format!("selected microphone is no longer available: {id}"));
        }
    }
    host.default_input_device()
        .ok_or_else(|| "no default input device available".to_string())
}

/// Start capturing from the selected input device (`None` = system default).
///
/// Prefers a mono f32 stream at 16 kHz (so no resampling is needed downstream),
/// falling back to the device's default rate / format.
fn start_capture(device_id: Option<&str>) -> Result<ActiveCapture, String> {
    let device = resolve_input_device(device_id)?;
    let default = device
        .default_input_config()
        .map_err(|e| format!("failed to read default input config: {e}"))?;
    let default_rate = default.sample_rate();

    let samples: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
    let stop = Arc::new(AtomicBool::new(false));

    let mut errors: Vec<String> = Vec::new();

    // Preferred: mono f32 at 16 kHz (matches the engines' input format).
    if device_supports_rate(&device, TARGET_SAMPLE_RATE) {
        let config = cpal::StreamConfig {
            channels: 1,
            sample_rate: TARGET_SAMPLE_RATE,
            buffer_size: cpal::BufferSize::Default,
        };
        match build_stream::<f32>(&device, &config, 1, &samples, &stop) {
            Ok(stream) => {
                return Ok(ActiveCapture {
                    stream,
                    samples,
                    stop,
                    sample_rate: TARGET_SAMPLE_RATE,
                });
            }
            Err(e) => errors.push(format!("16 kHz f32: {e}")),
        }
    }

    // Fallback 1: device default rate, mono f32.
    let config = cpal::StreamConfig {
        channels: 1,
        sample_rate: default.sample_rate(),
        buffer_size: cpal::BufferSize::Default,
    };
    match build_stream::<f32>(&device, &config, 1, &samples, &stop) {
        Ok(stream) => {
            return Ok(ActiveCapture {
                stream,
                samples,
                stop,
                sample_rate: default_rate,
            });
        }
        Err(e) => errors.push(format!("default-rate f32: {e}")),
    }

    // Fallback 2: exact default config with its native sample format.
    let config = default.config();
    let channels = config.channels;
    match build_stream_for_format(&device, &config, channels, default.sample_format(), &samples, &stop) {
        Ok(stream) => {
            return Ok(ActiveCapture {
                stream,
                samples,
                stop,
                sample_rate: default_rate,
            });
        }
        Err(e) => errors.push(format!("native format: {e}")),
    }

    Err(format!(
        "failed to start microphone capture: {}",
        errors.join("; ")
    ))
}

/// True if the device advertises a supported input config that includes `rate` Hz.
fn device_supports_rate(device: &cpal::Device, rate: u32) -> bool {
    device
        .supported_input_configs()
        .map(|mut configs| {
            configs.any(|c| c.min_sample_rate() <= rate && rate <= c.max_sample_rate())
        })
        .unwrap_or(false)
}

/// Build a mono-downmixing f32 input stream from a typed sample format.
fn build_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: u16,
    samples: &Arc<Mutex<Vec<f32>>>,
    stop: &Arc<AtomicBool>,
) -> Result<cpal::Stream, String>
where
    T: cpal::SizedSample + cpal::Sample,
    f32: cpal::FromSample<T>,
{
    let samples = Arc::clone(samples);
    let stop = Arc::clone(stop);
    let config = config.clone();
    device
        .build_input_stream::<T, _, _>(
            config,
            move |data: &[T], _| {
                if stop.load(Ordering::Relaxed) {
                    return;
                }
                let mut buf = match samples.lock() {
                    Ok(buf) => buf,
                    Err(_) => return,
                };
                if channels == 1 {
                    buf.extend(data.iter().map(|s| s.to_sample::<f32>()));
                } else {
                    for frame in data.chunks(channels as usize) {
                        let sum: f32 = frame.iter().map(|s| s.to_sample::<f32>()).sum();
                        buf.push(sum / channels as f32);
                    }
                }
            },
            move |err| log::error!("dictation capture stream error: {err}"),
            None,
        )
        .map_err(|e| e.to_string())
}

/// Build an input stream for the given runtime `SampleFormat`.
fn build_stream_for_format(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: u16,
    format: cpal::SampleFormat,
    samples: &Arc<Mutex<Vec<f32>>>,
    stop: &Arc<AtomicBool>,
) -> Result<cpal::Stream, String> {
    match format {
        cpal::SampleFormat::F32 => build_stream::<f32>(device, config, channels, samples, stop),
        cpal::SampleFormat::F64 => build_stream::<f64>(device, config, channels, samples, stop),
        cpal::SampleFormat::I16 => build_stream::<i16>(device, config, channels, samples, stop),
        cpal::SampleFormat::U16 => build_stream::<u16>(device, config, channels, samples, stop),
        cpal::SampleFormat::I8 => build_stream::<i8>(device, config, channels, samples, stop),
        cpal::SampleFormat::U8 => build_stream::<u8>(device, config, channels, samples, stop),
        other => Err(format!("unsupported capture sample format {other}")),
    }
}

/// Resample arbitrary-rate mono f32 to 16 kHz, preferring rubato and falling
/// back to linear interpolation if rubato cannot process the input.
fn resample_to_16k(samples: &[f32], input_rate: u32) -> Result<Vec<f32>, String> {
    if input_rate == TARGET_SAMPLE_RATE {
        return Ok(samples.to_vec());
    }
    if input_rate == 0 {
        return Err("invalid input sample rate 0".to_string());
    }
    match rubato_resample(samples, input_rate, TARGET_SAMPLE_RATE) {
        Ok(out) => Ok(out),
        Err(e) => {
            log::warn!("rubato resampling failed ({e}), falling back to linear interpolation");
            Ok(linear_resample(samples, input_rate, TARGET_SAMPLE_RATE))
        }
    }
}

/// One-shot band-limited resample of a whole clip via rubato.
fn rubato_resample(samples: &[f32], input_rate: u32, output_rate: u32) -> Result<Vec<f32>, String> {
    use rubato::audioadapter_buffers::owned::InterleavedOwned;
    use rubato::{Async, FixedAsync, PolynomialDegree, Resampler};

    if samples.is_empty() {
        return Ok(Vec::new());
    }

    let ratio = output_rate as f64 / input_rate as f64;
    let mut resampler = Async::new_poly(
        ratio,
        10.0,
        PolynomialDegree::Cubic,
        1024,
        1,
        FixedAsync::Input,
    )
    .map_err(|e| e.to_string())?;

    let input = InterleavedOwned::new_from(samples.to_vec(), 1, samples.len())
        .map_err(|e| e.to_string())?;
    let output = resampler
        .process_all(&input, samples.len(), None)
        .map_err(|e| e.to_string())?;
    Ok(output.take_data())
}

/// Simple linear-interpolation resampler (fallback when rubato is unavailable).
fn linear_resample(samples: &[f32], input_rate: u32, output_rate: u32) -> Vec<f32> {
    if samples.is_empty() || input_rate == output_rate {
        return samples.to_vec();
    }
    let ratio = input_rate as f64 / output_rate as f64;
    let out_len = ((samples.len() as f64 - 1.0) * output_rate as f64 / input_rate as f64) as usize
        + 1;
    let last = samples.len() - 1;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src = i as f64 * ratio;
        let idx = (src.floor() as usize).min(last);
        let frac = (src - idx as f64) as f32;
        let a = samples[idx];
        let b = samples[(idx + 1).min(last)];
        out.push(a + (b - a) * frac);
    }
    out
}

/// Convert mono f32 samples in [-1, 1] to 16-bit signed PCM, clamping.
fn f32_to_i16(samples: &[f32]) -> Vec<i16> {
    samples
        .iter()
        .map(|&s| (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16)
        .collect()
}

/// Encode 16-bit PCM mono samples as a 44-byte-header RIFF/WAVE buffer
/// (16 kHz by construction; callers must have resampled first).
fn encode_wav_pcm16(samples: &[i16]) -> Vec<u8> {
    const SAMPLE_RATE: u32 = TARGET_SAMPLE_RATE;
    const CHANNELS: u16 = 1;
    const BITS_PER_SAMPLE: u16 = 16;
    const BYTES_PER_SAMPLE: u32 = BITS_PER_SAMPLE as u32 / 8;

    let data_len = (samples.len() as u32) * BYTES_PER_SAMPLE;
    let byte_rate = SAMPLE_RATE * CHANNELS as u32 * BYTES_PER_SAMPLE;
    let block_align = CHANNELS * (BITS_PER_SAMPLE / 8);

    let mut buf = Vec::with_capacity(44 + samples.len() * 2);
    buf.extend_from_slice(b"RIFF");
    buf.extend_from_slice(&(36 + data_len).to_le_bytes());
    buf.extend_from_slice(b"WAVE");
    buf.extend_from_slice(b"fmt ");
    buf.extend_from_slice(&16u32.to_le_bytes());
    buf.extend_from_slice(&1u16.to_le_bytes());
    buf.extend_from_slice(&CHANNELS.to_le_bytes());
    buf.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    buf.extend_from_slice(&byte_rate.to_le_bytes());
    buf.extend_from_slice(&block_align.to_le_bytes());
    buf.extend_from_slice(&BITS_PER_SAMPLE.to_le_bytes());
    buf.extend_from_slice(b"data");
    buf.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        buf.extend_from_slice(&s.to_le_bytes());
    }
    buf
}

/// Build the multipart/form-data body for an OpenAI-compatible transcription
/// request: `model=whisper-1` plus the WAV `file`.
fn build_transcriptions_multipart(wav: &[u8]) -> Vec<u8> {
    let mut body = Vec::with_capacity(wav.len() + 512);
    body.extend_from_slice(format!("--{MULTIPART_BOUNDARY}\r\n").as_bytes());
    body.extend_from_slice(b"Content-Disposition: form-data; name=\"model\"\r\n\r\n");
    body.extend_from_slice(b"whisper-1\r\n");
    body.extend_from_slice(format!("--{MULTIPART_BOUNDARY}\r\n").as_bytes());
    body.extend_from_slice(
        b"Content-Disposition: form-data; name=\"file\"; filename=\"dictation.wav\"\r\n",
    );
    body.extend_from_slice(b"Content-Type: audio/wav\r\n\r\n");
    body.extend_from_slice(wav);
    body.extend_from_slice(format!("\r\n--{MULTIPART_BOUNDARY}--\r\n").as_bytes());
    body
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Candidate locations for the pre-downloaded Whisper model on this machine.
    fn candidate_model_paths() -> Vec<PathBuf> {
        let mut paths = Vec::new();
        if let Ok(home) = std::env::var("HOME") {
            paths.push(
                PathBuf::from(home)
                    .join(".config/dev.hivefield.terminal/models/ggml-base.en.bin"),
            );
        }
        if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
            paths.push(PathBuf::from(xdg).join("dev.hivefield.terminal/models/ggml-base.en.bin"));
        }
        paths
    }

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
    fn linear_resample_upsamples_two_x() {
        let input = [0.0f32, 1.0, 0.0];
        let out = linear_resample(&input, 8_000, 16_000);
        assert_eq!(out, vec![0.0, 0.5, 1.0, 0.5, 0.0]);
    }

    #[test]
    fn linear_resample_preserves_length_at_same_rate() {
        let input = vec![0.5f32; 100];
        let out = linear_resample(&input, 48_000, 48_000);
        assert_eq!(out, input);
    }

    #[test]
    fn resample_to_16k_is_identity_at_16k() {
        let input = vec![0.25f32; 1600];
        assert_eq!(resample_to_16k(&input, 16_000).unwrap(), input);
    }

    #[test]
    fn resample_to_16k_produces_expected_output_length() {
        let input = vec![0.0f32; 44_100];
        let out = resample_to_16k(&input, 44_100).unwrap();
        let expected = (16_000.0f64 / 44_100.0f64 * 44_100.0f64).ceil() as usize;
        assert_eq!(out.len(), expected);
        assert_eq!(out.len(), 16_000);
    }

    #[test]
    fn join_segments_trims_and_drops_empties() {
        let texts = vec![
            "  hello   ".to_string(),
            "".to_string(),
            "   ".to_string(),
            "world".to_string(),
            " ".to_string(),
        ];
        assert_eq!(join_segments(texts), "hello world");
    }

    #[test]
    fn join_segments_empty_yields_empty_string() {
        assert_eq!(join_segments(Vec::<String>::new()), "");
    }

    #[test]
    fn parse_engine_normalizes_inputs() {
        assert_eq!(parse_engine(None), "whisper");
        assert_eq!(parse_engine(Some("whisper".to_string())), "whisper");
        assert_eq!(parse_engine(Some("vosk".to_string())), "vosk");
        assert_eq!(parse_engine(Some("cloud".to_string())), "cloud");
        assert_eq!(parse_engine(Some("  VOSK  ".to_string())), "vosk");
        assert_eq!(parse_engine(Some("bogus".to_string())), "whisper");
        assert_eq!(parse_engine(Some("".to_string())), "whisper");
    }

    #[test]
    fn f32_to_i16_converts_and_clamps() {
        assert_eq!(
            f32_to_i16(&[0.0, 1.0, -1.0, 0.5]),
            vec![0, i16::MAX, -i16::MAX, i16::MAX / 2]
        );
        assert_eq!(f32_to_i16(&[2.0, -2.0]), vec![i16::MAX, -i16::MAX]);
    }

    #[test]
    fn wav_header_is_44_bytes_with_correct_sizes() {
        let samples = vec![0i16; 10];
        let wav = encode_wav_pcm16(&samples);
        assert_eq!(wav.len(), 44 + 20);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[12..16], b"fmt ");
        assert_eq!(u32::from_le_bytes(wav[16..20].try_into().unwrap()), 16);
        assert_eq!(u16::from_le_bytes(wav[20..22].try_into().unwrap()), 1); // PCM
        assert_eq!(u16::from_le_bytes(wav[22..24].try_into().unwrap()), 1); // mono
        assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 16_000);
        assert_eq!(u32::from_le_bytes(wav[28..32].try_into().unwrap()), 32_000);
        assert_eq!(u16::from_le_bytes(wav[32..34].try_into().unwrap()), 2);
        assert_eq!(u16::from_le_bytes(wav[34..36].try_into().unwrap()), 16);
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()), 20);
        assert_eq!(u32::from_le_bytes(wav[4..8].try_into().unwrap()), 36 + 20);
    }

    #[test]
    fn multipart_body_contains_boundary_and_file() {
        let wav = vec![1u8, 2, 3, 4];
        let body = build_transcriptions_multipart(&wav);
        let body = String::from_utf8(body).unwrap();
        assert!(body.contains(&format!("--{MULTIPART_BOUNDARY}\r\n")));
        assert!(body.contains("name=\"model\""));
        assert!(body.contains("whisper-1"));
        assert!(body.contains("filename=\"dictation.wav\""));
        assert!(body.contains("Content-Type: audio/wav"));
        assert!(body.contains("Content-Type: multipart/form-data") == false);
        assert!(body.contains(&format!("--{MULTIPART_BOUNDARY}--\r\n")));
        assert!(body.contains(&String::from_utf8(vec![1u8, 2, 3, 4]).unwrap()));
    }

    /// Loads the existing Whisper model file from disk to confirm `WhisperContext`
    /// construction succeeds and a state can run the full pipeline.
    #[test]
    #[ignore]
    fn model_loads_from_disk() {
        let path = candidate_model_paths().into_iter().find(|p| p.exists());
        let Some(path) = path else {
            eprintln!("model file not present on this machine; skipping model load test");
            return;
        };

        let ctx = WhisperContext::new_with_params(&path, WhisperContextParameters::default())
            .expect("whisper model should load from disk");

        let mut st = ctx.create_state().expect("create_state should succeed");
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(Some("en"));
        params.set_translate(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_special(false);

        let silence = vec![0.0f32; TARGET_SAMPLE_RATE as usize];
        st.full(params, &silence).expect("full on silence should not fail");
        assert!(st.full_n_segments() >= 0);
    }
}
