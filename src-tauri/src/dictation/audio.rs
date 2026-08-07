//! Microphone capture (cpal) plus the audio plumbing shared by every
//! transcription engine: resampling to 16 kHz, f32 → i16 conversion, and WAV
//! encoding. No engine-specific logic lives here.

use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait};

use super::{DictationDevice, TARGET_SAMPLE_RATE};

/// Maximum recording length (seconds). A longer hold keeps the stream alive
/// but stops accumulating samples, so a held key can never grow an unbounded
/// buffer or produce a multi-minute transcription.
const MAX_CAPTURE_SECONDS: f64 = 60.0;

/// A live microphone capture.
pub struct ActiveCapture {
    pub stream: cpal::Stream,
    pub samples: Arc<Mutex<Vec<f32>>>,
    pub stop: Arc<AtomicBool>,
    pub sample_rate: u32,
}

/// List the microphones available for dictation, default first.
///
/// Device ids are stable across reboots so a saved preference keeps working.
pub fn list_devices() -> Vec<DictationDevice> {
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

/// Cap the recording buffer at [`MAX_CAPTURE_SECONDS`] at the given sample
/// rate, so a long hold can never grow an unbounded buffer or produce a
/// multi-minute transcription.
fn sample_cap(rate: u32) -> usize {
    (MAX_CAPTURE_SECONDS * rate as f64) as usize
}

/// Start capturing from the selected input device (`None` = system default).
///
/// Prefers a mono f32 stream at 16 kHz (so no resampling is needed downstream),
/// falling back to the device's default rate / format.
pub fn start_capture(device_id: Option<&str>) -> Result<ActiveCapture, String> {
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
        match build_stream::<f32>(
            &device,
            &config,
            1,
            sample_cap(TARGET_SAMPLE_RATE),
            &samples,
            &stop,
        ) {
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
    match build_stream::<f32>(
        &device,
        &config,
        1,
        sample_cap(default_rate),
        &samples,
        &stop,
    ) {
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
    match build_stream_for_format(
        &device,
        &config,
        channels,
        default.sample_format(),
        sample_cap(default_rate),
        &samples,
        &stop,
    ) {
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
/// `max_samples` caps the accumulated buffer (see [`sample_cap`]).
fn build_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: u16,
    max_samples: usize,
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
                if buf.len() >= max_samples {
                    return;
                }
                let remaining = max_samples - buf.len();
                if channels == 1 {
                    buf.extend(
                        data.iter()
                            .take(remaining)
                            .map(|s| s.to_sample::<f32>()),
                    );
                } else {
                    for frame in data.chunks(channels as usize).take(remaining) {
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
    max_samples: usize,
    samples: &Arc<Mutex<Vec<f32>>>,
    stop: &Arc<AtomicBool>,
) -> Result<cpal::Stream, String> {
    match format {
        cpal::SampleFormat::F32 => {
            build_stream::<f32>(device, config, channels, max_samples, samples, stop)
        }
        cpal::SampleFormat::F64 => {
            build_stream::<f64>(device, config, channels, max_samples, samples, stop)
        }
        cpal::SampleFormat::I16 => {
            build_stream::<i16>(device, config, channels, max_samples, samples, stop)
        }
        cpal::SampleFormat::U16 => {
            build_stream::<u16>(device, config, channels, max_samples, samples, stop)
        }
        cpal::SampleFormat::I8 => build_stream::<i8>(device, config, channels, max_samples, samples, stop),
        cpal::SampleFormat::U8 => build_stream::<u8>(device, config, channels, max_samples, samples, stop),
        other => Err(format!("unsupported capture sample format {other}")),
    }
}

/// Resample arbitrary-rate mono f32 to 16 kHz, preferring rubato and falling
/// back to linear interpolation if rubato cannot process the input.
pub fn resample_to_16k(samples: &[f32], input_rate: u32) -> Result<Vec<f32>, String> {
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
pub fn f32_to_i16(samples: &[f32]) -> Vec<i16> {
    samples
        .iter()
        .map(|&s| (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16)
        .collect()
}

/// Encode 16-bit PCM mono samples as a 44-byte-header RIFF/WAVE buffer
/// (16 kHz by construction; callers must have resampled first).
pub fn encode_wav_pcm16(samples: &[i16]) -> Vec<u8> {
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
