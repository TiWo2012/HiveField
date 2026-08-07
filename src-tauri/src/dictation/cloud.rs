//! OpenAI-compatible cloud transcription engine.
//!
//! Uploads the recorded phrase as a multipart WAV to a
//! `/audio/transcriptions` endpoint using the shared [`crate::net::HttpClient`]
//! and returns the transcribed text. The API key comes from the
//! `OPENAI_API_KEY` environment variable (checked by the orchestrator in
//! [`super::mod`] before capture starts).

use super::audio::{encode_wav_pcm16, f32_to_i16, resample_to_16k};
use crate::net::HttpClient;

/// OpenAI-compatible `/audio/transcriptions` endpoint.
pub const CLOUD_API_URL: &str = "https://api.openai.com/v1/audio/transcriptions";

/// Multipart boundary used when building the cloud transcription request body.
pub const MULTIPART_BOUNDARY: &str = "hivefield-dictation-boundary";

/// Transcribe 16 kHz mono audio via an OpenAI-compatible `/audio/transcriptions`
/// endpoint (multipart POST of an in-memory WAV).
pub fn transcribe(samples: &[f32], input_rate: u32, api_key: &str) -> Result<String, String> {
    let audio = resample_to_16k(samples, input_rate)?;
    let wav = encode_wav_pcm16(&f32_to_i16(&audio));
    let body = build_transcriptions_multipart(&wav);

    let auth = format!("Bearer {api_key}");
    let content_type = format!("multipart/form-data; boundary={MULTIPART_BOUNDARY}");
    let text = HttpClient::default().post_bytes(
        CLOUD_API_URL,
        &[
            ("Authorization", auth.as_str()),
            ("Content-Type", content_type.as_str()),
        ],
        &body,
    )?;

    let json: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("failed to parse cloud response: {e}"))?;
    json.get("text")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("cloud response has no \"text\" field: {text}"))
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
}
