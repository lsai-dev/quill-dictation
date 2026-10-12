//! PCM payload decoding and conditioning.
//!
//! Audio arrives as raw little-endian `f32` mono samples at 16 kHz, the format
//! whisper.cpp consumes directly.

/// Sample rate whisper.cpp expects.
pub const SAMPLE_RATE: usize = 16_000;

/// Inputs shorter than this are padded with trailing silence; whisper misbehaves on very
/// short clips (empty output or hallucinations).
pub const MIN_SAMPLES: usize = SAMPLE_RATE; // 1.0 s

/// Longest accepted dictation.
pub const MAX_SECONDS: usize = 10 * 60;

/// Largest accepted payload. Larger payloads are consumed and rejected.
pub const MAX_PAYLOAD_BYTES: u64 = (SAMPLE_RATE * MAX_SECONDS * BYTES_PER_SAMPLE) as u64;

const BYTES_PER_SAMPLE: usize = std::mem::size_of::<f32>();

/// Decodes little-endian `f32` PCM.
///
/// Non-finite samples (NaN/inf) are replaced with silence and all samples are clamped to
/// `[-1, 1]` so a misbehaving capture pipeline cannot push garbage into the model.
pub fn decode_f32le(bytes: &[u8]) -> Result<Vec<f32>, String> {
    if bytes.len() % BYTES_PER_SAMPLE != 0 {
        return Err(format!(
            "audio payload is {} bytes, which is not a whole number of f32 samples",
            bytes.len()
        ));
    }
    Ok(bytes
        .chunks_exact(BYTES_PER_SAMPLE)
        .map(|c| {
            let s = f32::from_le_bytes([c[0], c[1], c[2], c[3]]);
            if s.is_finite() {
                s.clamp(-1.0, 1.0)
            } else {
                0.0
            }
        })
        .collect())
}

/// Appends silence so that `samples` holds at least `min_len` samples.
pub fn pad_to_min(samples: &mut Vec<f32>, min_len: usize) {
    if samples.len() < min_len {
        samples.resize(min_len, 0.0);
    }
}

/// Duration of `n` samples in milliseconds.
pub fn duration_ms(n: usize) -> u64 {
    n as u64 * 1000 / SAMPLE_RATE as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode(samples: &[f32]) -> Vec<u8> {
        samples.iter().flat_map(|s| s.to_le_bytes()).collect()
    }

    #[test]
    fn decodes_little_endian_samples() {
        let input = [0.0f32, 0.5, -0.25, 1.0, -1.0];
        assert_eq!(decode_f32le(&encode(&input)).unwrap(), input);
        // 0x3f800000 == 1.0f32, written little-endian.
        assert_eq!(decode_f32le(&[0x00, 0x00, 0x80, 0x3f]).unwrap(), vec![1.0]);
    }

    #[test]
    fn sanitizes_out_of_range_and_non_finite_samples() {
        let input = [2.0f32, -3.5, f32::NAN, f32::INFINITY, f32::NEG_INFINITY, 0.1];
        assert_eq!(decode_f32le(&encode(&input)).unwrap(), vec![1.0, -1.0, 0.0, 0.0, 0.0, 0.1]);
    }

    #[test]
    fn rejects_partial_samples() {
        assert!(decode_f32le(&[0, 0, 0]).is_err());
        assert!(decode_f32le(&[0; 6]).is_err());
        assert_eq!(decode_f32le(&[]).unwrap(), Vec::<f32>::new());
    }

    #[test]
    fn pads_short_audio_with_trailing_silence() {
        let mut s = vec![0.5f32; 100];
        pad_to_min(&mut s, MIN_SAMPLES);
        assert_eq!(s.len(), MIN_SAMPLES);
        assert_eq!(s[99], 0.5);
        assert!(s[100..].iter().all(|&x| x == 0.0));
    }

    #[test]
    fn leaves_long_audio_untouched() {
        let mut s = vec![0.25f32; MIN_SAMPLES + 7];
        pad_to_min(&mut s, MIN_SAMPLES);
        assert_eq!(s.len(), MIN_SAMPLES + 7);
    }

    #[test]
    fn durations() {
        assert_eq!(duration_ms(SAMPLE_RATE), 1000);
        assert_eq!(duration_ms(SAMPLE_RATE * 42 / 10), 4200);
        assert_eq!(duration_ms(0), 0);
        assert_eq!(MAX_PAYLOAD_BYTES, 38_400_000);
    }
}
