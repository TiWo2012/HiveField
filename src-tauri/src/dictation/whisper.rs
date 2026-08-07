//! Local Whisper transcription engine.
//!
//! Owns everything specific to whisper.cpp: loading the model into a
//! [`WhisperContext`] and running a full transcription pass. The model's
//! location / download policy lives in [`super::model`]; the shared audio
//! plumbing (resampling) lives in [`super::audio`].

use std::path::Path;
use std::sync::Arc;

use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use super::audio::resample_to_16k;

/// Load the Whisper context for the given model file, wrapped in an `Arc` so
/// the (expensive) model can be shared across transcription runs.
pub fn load_context(path: &Path) -> Result<Arc<WhisperContext>, String> {
    let ctx = WhisperContext::new_with_params(path, WhisperContextParameters::default())
        .map_err(|e| format!("failed to load whisper model: {e}"))?;
    Ok(Arc::new(ctx))
}

/// Resample (if needed) to 16 kHz mono f32 and run Whisper, returning the
/// joined transcription.
pub fn transcribe(ctx: &WhisperContext, samples: &[f32], input_rate: u32) -> Result<String, String> {
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

/// Trim each segment and join non-empty segments with a single space.
fn join_segments(texts: impl IntoIterator<Item = String>) -> String {
    texts
        .into_iter()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

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

        let silence = vec![0.0f32; super::super::TARGET_SAMPLE_RATE as usize];
        st.full(params, &silence).expect("full on silence should not fail");
        assert!(st.full_n_segments() >= 0);
    }
}
