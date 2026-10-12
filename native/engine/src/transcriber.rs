//! Owns the loaded whisper.cpp model and runs transcriptions.

use crate::audio;
use serde::Serialize;
use std::ffi::CStr;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Instant;
use whisper_rs::{
    FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperError,
    WhisperState,
};

/// The GPU backend compiled into this binary (`"cpu"` when none).
pub const BACKEND: &str = if cfg!(feature = "cuda") {
    "cuda"
} else if cfg!(feature = "vulkan") {
    "vulkan"
} else {
    "cpu"
};

/// Whether this binary was built with a GPU backend.
pub const GPU_COMPILED: bool = cfg!(any(feature = "vulkan", feature = "cuda"));

/// Upper bound for user-supplied thread counts.
const MAX_THREADS: u32 = 64;
/// Upper bound for automatically chosen thread counts (more rarely helps whisper).
const MAX_AUTO_THREADS: usize = 8;
/// Upper bound for the beam width.
const MAX_BEAM_SIZE: u32 = 8;
/// First four bytes of a ggml whisper model ("ggml" as a little-endian u32).
const GGML_MAGIC: u32 = 0x6767_6d6c;

pub struct LoadOptions {
    pub model: PathBuf,
    pub gpu: bool,
    pub flash_attn: bool,
    /// 0 = automatic.
    pub threads: u32,
}

#[derive(Serialize)]
pub struct LoadReport {
    pub load_ms: u64,
    pub warmup_ms: u64,
    /// True when the model runs on a GPU (requested, compiled in, and a device exists).
    pub gpu: bool,
    /// Name of the device the model runs on (`"CPU"` for the CPU backend).
    pub device: String,
    pub threads: u32,
    pub multilingual: bool,
}

pub struct TranscribeOptions {
    /// `"auto"` (or empty) for detection, otherwise an ISO code or whisper language name.
    pub language: String,
    pub translate: bool,
    pub prompt: String,
    /// 0 or 1 = greedy, >1 = beam search with this width.
    pub beam_size: u32,
}

#[derive(Serialize)]
pub struct Segment {
    pub text: String,
    pub no_speech_prob: f32,
}

#[derive(Serialize)]
pub struct Transcript {
    pub text: String,
    pub segments: Vec<Segment>,
    pub language: String,
    pub audio_ms: u64,
    pub process_ms: u64,
}

/// Summary of the loaded model, for `info`.
pub struct ModelStatus<'a> {
    pub path: &'a Path,
    pub gpu: bool,
    pub device: &'a str,
    pub threads: u32,
}

/// The decoding settings a [`FullParams`] value was built for.
#[derive(Clone, PartialEq, Eq)]
struct ParamsKey {
    language: Option<&'static str>,
    translate: bool,
    prompt: String,
    beam_size: u32,
}

struct Loaded {
    ctx: WhisperContext,
    /// Reused across calls so whisper.cpp does not reallocate its buffers every time.
    state: WhisperState,
    path: PathBuf,
    gpu: bool,
    device: String,
    threads: u32,
    multilingual: bool,
    /// whisper-rs leaks the C strings for the language and initial prompt each time they
    /// are set, so parameters are built once per distinct setting and cloned per call.
    params: Option<(ParamsKey, FullParams<'static, 'static>)>,
}

/// The engine: at most one model loaded at a time.
#[derive(Default)]
pub struct Engine {
    loaded: Option<Loaded>,
}

impl Engine {
    /// The loaded model, if any.
    pub fn status(&self) -> Option<ModelStatus<'_>> {
        self.loaded.as_ref().map(|l| ModelStatus {
            path: &l.path,
            gpu: l.gpu,
            device: &l.device,
            threads: l.threads,
        })
    }

    /// Frees the current model. Returns whether one was loaded.
    pub fn unload(&mut self) -> bool {
        self.loaded.take().is_some()
    }

    /// Loads a model (replacing any loaded one) and warms it up.
    pub fn load(&mut self, opts: &LoadOptions) -> Result<LoadReport, String> {
        // Reject obviously bad requests before touching the loaded model.
        check_model_file(&opts.model)?;
        // Free the old model first so its (V)RAM is available to the new one.
        self.loaded = None;

        let use_gpu = opts.gpu && GPU_COMPILED;
        let device = if use_gpu {
            // whisper.cpp silently falls back to the CPU when no GPU device exists; report
            // that as a failure so the caller can make an explicit CPU choice.
            first_gpu_device().ok_or_else(|| format!("no {BACKEND} GPU device available"))?
        } else {
            "CPU".to_string()
        };
        let threads = resolve_threads(opts.threads);

        let started = Instant::now();
        let mut cparams = WhisperContextParameters::default();
        cparams.use_gpu(use_gpu).flash_attn(opts.flash_attn).gpu_device(0);
        let ctx = WhisperContext::new_with_params(&opts.model, cparams).map_err(|e| {
            format!("failed to load model {} ({}): {e}", opts.model.display(), device_label(use_gpu))
        })?;
        let mut state = ctx
            .create_state()
            .map_err(|e| format!("failed to allocate inference state ({}): {e}", device_label(use_gpu)))?;
        let load_ms = elapsed_ms(started);

        let started = Instant::now();
        warm_up(&mut state, threads).map_err(|e| format!("warm-up failed ({}): {e}", device_label(use_gpu)))?;
        let warmup_ms = elapsed_ms(started);

        let multilingual = ctx.is_multilingual();
        self.loaded = Some(Loaded {
            ctx,
            state,
            path: opts.model.clone(),
            gpu: use_gpu,
            device: device.clone(),
            threads,
            multilingual,
            params: None,
        });
        Ok(LoadReport { load_ms, warmup_ms, gpu: use_gpu, device, threads, multilingual })
    }

    /// Transcribes 16 kHz mono samples.
    pub fn transcribe(&mut self, opts: &TranscribeOptions, mut samples: Vec<f32>) -> Result<Transcript, String> {
        let loaded = self.loaded.as_mut().ok_or("no model loaded")?;
        if samples.is_empty() {
            return Err("audio payload is empty".into());
        }
        let audio_ms = audio::duration_ms(samples.len());
        audio::pad_to_min(&mut samples, audio::MIN_SAMPLES);

        let requested = resolve_language(&opts.language)?;
        // English-only models can neither detect nor translate.
        let (language, translate) = if loaded.multilingual {
            (requested, opts.translate)
        } else {
            (Some("en"), false)
        };
        let key = ParamsKey {
            language,
            translate,
            prompt: opts.prompt.replace('\0', "").trim().to_string(),
            beam_size: opts.beam_size.min(MAX_BEAM_SIZE),
        };
        let params = loaded.params_for(key);

        let started = Instant::now();
        loaded
            .state
            .full(params, &samples)
            .map_err(|e| format!("transcription failed: {e}"))?;

        let n = loaded.state.full_n_segments();
        let mut text = String::new();
        let mut segments = Vec::with_capacity(usize::try_from(n).unwrap_or(0));
        for i in 0..n {
            let Some(seg) = loaded.state.get_segment(i) else { continue };
            let seg_text = seg.to_str_lossy().map_err(|e| format!("failed to read segment {i}: {e}"))?;
            text.push_str(&seg_text);
            segments.push(Segment { text: seg_text.trim().to_string(), no_speech_prob: seg.no_speech_probability() });
        }
        let process_ms = elapsed_ms(started);

        let detected = whisper_rs::get_lang_str(loaded.state.full_lang_id_from_state());
        let language = detected.or(language).unwrap_or("en").to_string();
        Ok(Transcript { text: text.trim().to_string(), segments, language, audio_ms, process_ms })
    }

    /// Rebuilds the inference state after a panic interrupted a call, unloading the model if
    /// that is not possible.
    pub fn recover(&mut self) {
        if let Some(loaded) = self.loaded.as_mut() {
            match loaded.ctx.create_state() {
                Ok(state) => {
                    loaded.state = state;
                    loaded.params = None;
                }
                Err(e) => {
                    crate::protocol::log!("could not rebuild inference state ({e}); unloading model");
                    self.loaded = None;
                }
            }
        }
    }
}

impl Loaded {
    fn params_for(&mut self, key: ParamsKey) -> FullParams<'static, 'static> {
        if let Some((cached_key, params)) = &self.params {
            if *cached_key == key {
                return params.clone();
            }
        }
        let params = build_params(&key, self.threads);
        self.params = Some((key, params.clone()));
        params
    }
}

fn build_params(key: &ParamsKey, threads: u32) -> FullParams<'static, 'static> {
    let strategy = if key.beam_size > 1 {
        SamplingStrategy::BeamSearch { beam_size: key.beam_size as i32, patience: -1.0 }
    } else {
        SamplingStrategy::Greedy { best_of: 1 }
    };
    let mut p = base_params(strategy, threads);
    p.set_translate(key.translate);
    // `None` means auto-detect (a null pointer for whisper.cpp, nothing allocated).
    p.set_language(key.language);
    if !key.prompt.is_empty() {
        p.set_initial_prompt(&key.prompt);
    }
    p
}

/// Settings shared by real transcriptions and the warm-up pass.
fn base_params(strategy: SamplingStrategy, threads: u32) -> FullParams<'static, 'static> {
    let mut p = FullParams::new(strategy);
    p.set_n_threads(threads as i32);
    p.set_no_context(true);
    p.set_no_timestamps(true);
    p.set_single_segment(false);
    p.set_token_timestamps(false);
    p.set_suppress_blank(true);
    p.set_suppress_nst(true);
    p.set_print_special(false);
    p.set_print_progress(false);
    p.set_print_realtime(false);
    p.set_print_timestamps(false);
    p
}

/// Runs one second of silence through the model so that the first real dictation does not
/// pay for one-time setup (e.g. Vulkan pipeline compilation, buffer allocation).
fn warm_up(state: &mut WhisperState, threads: u32) -> Result<(), WhisperError> {
    let mut p = base_params(SamplingStrategy::Greedy { best_of: 1 }, threads);
    // Language stays at whisper.cpp's static default ("en"): no detection pass, no allocation.
    p.set_single_segment(true);
    p.set_max_tokens(8);
    p.set_temperature_inc(0.0); // no fallback re-decodes
    let silence = vec![0.0f32; audio::MIN_SAMPLES];
    state.full(p, &silence)
}

/// Maps `"auto"`/empty to `None` and anything else to whisper's canonical language code.
fn resolve_language(language: &str) -> Result<Option<&'static str>, String> {
    let lang = language.trim().to_ascii_lowercase();
    if lang.is_empty() || lang == "auto" {
        return Ok(None);
    }
    // whisper-rs panics on interior NULs; whisper names are short ASCII words.
    if lang.len() > 32 || !lang.bytes().all(|b| b.is_ascii_alphabetic() || b == b' ' || b == b'-') {
        return Err(format!("unsupported language '{language}'"));
    }
    whisper_rs::get_lang_id(&lang)
        .and_then(whisper_rs::get_lang_str)
        .map(Some)
        .ok_or_else(|| format!("unsupported language '{language}'"))
}

fn resolve_threads(requested: u32) -> u32 {
    if requested == 0 {
        num_cpus::get_physical().clamp(1, MAX_AUTO_THREADS) as u32
    } else {
        requested.clamp(1, MAX_THREADS)
    }
}

/// Fails early, with a readable message, for missing files and non-whisper files.
fn check_model_file(path: &Path) -> Result<(), String> {
    let mut file = File::open(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => format!("model file not found: {}", path.display()),
        _ => format!("cannot open model file {}: {e}", path.display()),
    })?;
    let mut magic = [0u8; 4];
    file.read_exact(&mut magic).map_err(|e| match e.kind() {
        std::io::ErrorKind::UnexpectedEof => format!("{} is not a whisper.cpp ggml model", path.display()),
        _ => format!("cannot read model file {}: {e}", path.display()),
    })?;
    if u32::from_le_bytes(magic) != GGML_MAGIC {
        return Err(format!("{} is not a whisper.cpp ggml model", path.display()));
    }
    Ok(())
}

/// Description of the first GPU device ggml knows about: the one whisper.cpp picks for
/// `gpu_device = 0`.
fn first_gpu_device() -> Option<String> {
    use whisper_rs::whisper_rs_sys as sys;
    // SAFETY: the ggml device registry is initialised on first use and lives for the whole
    // process; the returned description strings are owned by it.
    unsafe {
        (0..sys::ggml_backend_dev_count()).find_map(|i| {
            let dev = sys::ggml_backend_dev_get(i);
            if dev.is_null() {
                return None;
            }
            let ty = sys::ggml_backend_dev_type(dev);
            if ty != sys::ggml_backend_dev_type_GGML_BACKEND_DEVICE_TYPE_GPU
                && ty != sys::ggml_backend_dev_type_GGML_BACKEND_DEVICE_TYPE_IGPU
            {
                return None;
            }
            let desc = sys::ggml_backend_dev_description(dev);
            let name = if desc.is_null() { sys::ggml_backend_dev_name(dev) } else { desc };
            Some(if name.is_null() {
                "GPU".to_string()
            } else {
                CStr::from_ptr(name).to_string_lossy().trim().to_string()
            })
        })
    }
}

fn device_label(gpu: bool) -> &'static str {
    if gpu {
        BACKEND
    } else {
        "cpu"
    }
}

fn elapsed_ms(since: Instant) -> u64 {
    since.elapsed().as_millis().try_into().unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn languages() {
        assert_eq!(resolve_language("auto").unwrap(), None);
        assert_eq!(resolve_language("").unwrap(), None);
        assert_eq!(resolve_language("EN").unwrap(), Some("en"));
        assert_eq!(resolve_language("german").unwrap(), Some("de"));
        assert!(resolve_language("xx").is_err());
        assert!(resolve_language("e\0n").is_err());
    }

    #[test]
    fn threads() {
        assert!((1..=MAX_AUTO_THREADS as u32).contains(&resolve_threads(0)));
        assert_eq!(resolve_threads(3), 3);
        assert_eq!(resolve_threads(1000), MAX_THREADS);
    }

    #[test]
    fn model_file_checks() {
        let dir = std::env::temp_dir().join(format!("quill-engine-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let missing = dir.join("missing.bin");
        assert!(check_model_file(&missing).unwrap_err().contains("not found"));
        let tiny = dir.join("tiny.bin");
        std::fs::write(&tiny, b"gg").unwrap();
        assert!(check_model_file(&tiny).unwrap_err().contains("not a whisper.cpp ggml model"));
        let bogus = dir.join("bogus.bin");
        std::fs::write(&bogus, b"not a model").unwrap();
        assert!(check_model_file(&bogus).unwrap_err().contains("not a whisper.cpp ggml model"));
        let fake = dir.join("fake.bin");
        std::fs::write(&fake, GGML_MAGIC.to_le_bytes()).unwrap();
        assert!(check_model_file(&fake).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn transcribe_without_model() {
        let mut engine = Engine::default();
        let opts = TranscribeOptions { language: "en".into(), translate: false, prompt: String::new(), beam_size: 0 };
        assert_eq!(engine.transcribe(&opts, vec![0.0; 10]).err().as_deref(), Some("no model loaded"));
    }
}
