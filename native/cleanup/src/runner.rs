//! The worker: owns the model and its context and runs requests one at a time.

use crate::lookup::Lookup;
use crate::protocol::{log, Empty, Output, Request};
use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::context::LlamaContext;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::LlamaModel;
use llama_cpp_2::token::LlamaToken;
use llama_cpp_2::{LlamaStateSeqFlags, SeqState};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::ffi::CStr;
use std::num::NonZeroU32;
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::Arc;
use std::time::Instant;

/// The GPU backend compiled into this binary (`"cpu"` when none).
pub const BACKEND: &str = if cfg!(feature = "vulkan") { "vulkan" } else { "cpu" };

/// Tokens decoded per batch while reading a prompt.
const N_BATCH: u32 = 512;
/// Most tokens proposed per speculative step.
const DRAFT_MAX: usize = 10;
/// First four bytes of a GGUF file.
const GGUF_MAGIC: &[u8; 4] = b"GGUF";

#[derive(Deserialize)]
struct LoadArgs {
    model: PathBuf,
    #[serde(default)]
    gpu: bool,
    #[serde(default)]
    threads: u32,
    #[serde(default = "default_ctx")]
    ctx: u32,
}

fn default_ctx() -> u32 {
    4096
}

/// A piece of prompt text. Template markers are `special` (parsed as control tokens);
/// anything that came from the user never is, so a transcript can't forge a turn.
#[derive(Deserialize)]
struct Segment {
    text: String,
    #[serde(default)]
    special: bool,
}

#[derive(Deserialize)]
struct PrimeArgs {
    prefix: Vec<Segment>,
}

#[derive(Deserialize)]
struct CleanArgs {
    /// Instructions and examples: identical across requests, evaluated once and reused.
    prefix: Vec<Segment>,
    /// This request: the transcript and the opening of the model's turn.
    prompt: Vec<Segment>,
    /// Text to draft from (the transcript). Empty disables drafting.
    #[serde(default)]
    lookup: String,
    #[serde(default = "default_max_tokens")]
    max_tokens: u32,
    /// Generation ends where any of these appears (it is not included).
    #[serde(default)]
    stop: Vec<String>,
}

fn default_max_tokens() -> u32 {
    512
}

#[derive(Serialize)]
struct LoadReport {
    load_ms: u64,
    gpu: bool,
    device: String,
    threads: i32,
    ctx: u32,
    /// Recurrent or hybrid models can't rewind their state, so they are not drafted for.
    recurrent: bool,
    model_bytes: u64,
    params: u64,
}

#[derive(Serialize)]
struct PrimeReport {
    prefix_tokens: usize,
    prime_ms: u64,
}

#[derive(Serialize)]
struct Cleaned {
    text: String,
    /// Why generation ended: `eog` (the model finished), `stop` (a stop string) or `limit`.
    stop: &'static str,
    prompt_tokens: usize,
    /// Prompt tokens served from the cached prefix.
    cached_tokens: usize,
    generated_tokens: usize,
    drafted_tokens: usize,
    accepted_tokens: usize,
    prompt_ms: u64,
    generate_ms: u64,
    process_ms: u64,
}

#[derive(Serialize)]
struct Info {
    model: Option<String>,
    gpu: bool,
    device: Option<String>,
    prefix_tokens: usize,
}

#[derive(Serialize)]
struct Unloaded {
    was_loaded: bool,
}

/// Distinguishes a cancellation from a failure in replies.
const CANCELLED: &str = "cancelled";

/// The worker loop. Returns when the request channel closes.
pub fn run(rx: Receiver<Request>, out: Output, cancelled: Arc<AtomicI64>) {
    let backend = match LlamaBackend::init() {
        Ok(b) => b,
        Err(e) => {
            log!("llama backend init failed: {e}");
            // Keep answering so the app gets errors instead of silence.
            for req in rx {
                let _ = out.reply_err(&req.id, &format!("cleanup backend unavailable: {e}"));
            }
            return;
        }
    };
    let mut next: Option<Request> = None;
    loop {
        let req = match next.take() {
            Some(r) => r,
            None => match rx.recv() {
                Ok(r) => r,
                Err(_) => return,
            },
        };
        match req.cmd.as_str() {
            "load" => {
                let args: LoadArgs = match req.args() {
                    Ok(a) => a,
                    Err(e) => {
                        let _ = out.reply_err(&req.id, &e);
                        continue;
                    }
                };
                match load_model(&backend, &args) {
                    Ok((model, device)) => {
                        // Serve requests until a different model is wanted or the app leaves.
                        next = serve(&backend, &model, device, &args, req, &rx, &out, &cancelled);
                        if next.is_none() && is_closed(&rx) {
                            return;
                        }
                    }
                    Err(e) => {
                        log!("load failed: {e}");
                        let _ = out.reply_err(&req.id, &e);
                    }
                }
            }
            "unload" => {
                let _ = out.reply_ok(&req.id, Unloaded { was_loaded: false });
            }
            "info" => {
                let _ = out.reply_ok(&req.id, Info { model: None, gpu: false, device: None, prefix_tokens: 0 });
            }
            "prime" | "clean" => {
                let _ = out.reply_err(&req.id, "no model loaded");
            }
            other => {
                let _ = out.reply_err(&req.id, &format!("unknown command '{other}'"));
            }
        }
    }
}

fn is_closed(rx: &Receiver<Request>) -> bool {
    matches!(rx.try_recv(), Err(std::sync::mpsc::TryRecvError::Disconnected))
}

fn load_model(backend: &LlamaBackend, args: &LoadArgs) -> Result<(LlamaModel, String), String> {
    check_model_file(&args.model)?;
    let gpu = args.gpu && cfg!(feature = "vulkan");
    let device = if gpu {
        // llama.cpp quietly runs on the CPU when no GPU is found; make that an explicit
        // failure so the app can choose the CPU build instead.
        first_gpu_device().ok_or_else(|| format!("no {BACKEND} GPU device available"))?
    } else {
        "CPU".to_string()
    };
    let params = LlamaModelParams::default().with_n_gpu_layers(if gpu { 999 } else { 0 });
    let model = LlamaModel::load_from_file(backend, &args.model, &params)
        .map_err(|e| format!("could not load {}: {e}", args.model.display()))?;
    Ok((model, device))
}

fn check_model_file(path: &PathBuf) -> Result<(), String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).map_err(|e| format!("failed to open {}: {e}", path.display()))?;
    let mut magic = [0u8; 4];
    f.read_exact(&mut magic).map_err(|_| format!("{} is not a GGUF model", path.display()))?;
    if &magic != GGUF_MAGIC {
        return Err(format!("{} is not a GGUF model", path.display()));
    }
    Ok(())
}

fn first_gpu_device() -> Option<String> {
    use llama_cpp_sys_2 as sys;
    // SAFETY: ggml's device registry is initialised by llama_backend_init and the
    // returned strings are owned by the registry for the life of the process.
    unsafe {
        for i in 0..sys::ggml_backend_dev_count() {
            let dev = sys::ggml_backend_dev_get(i);
            if dev.is_null() {
                continue;
            }
            let kind = sys::ggml_backend_dev_type(dev);
            if kind == sys::GGML_BACKEND_DEVICE_TYPE_GPU || kind == sys::GGML_BACKEND_DEVICE_TYPE_IGPU {
                let desc = sys::ggml_backend_dev_description(dev);
                let name = if desc.is_null() { "GPU".into() } else { CStr::from_ptr(desc).to_string_lossy().into_owned() };
                return Some(name);
            }
        }
    }
    None
}

fn resolve_threads(requested: u32) -> i32 {
    if requested > 0 {
        return requested.min(64) as i32;
    }
    let logical = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    (logical / 2).clamp(1, 8) as i32
}

/// The cached instruction prefix for the loaded model.
struct Prefix {
    tokens: Vec<LlamaToken>,
    /// For models that can't rewind (recurrent/hybrid): the state right after the prefix.
    snapshot: Option<SeqState>,
}

struct Session<'m> {
    model: &'m LlamaModel,
    ctx: LlamaContext<'m>,
    batch: LlamaBatch<'static>,
    recurrent: bool,
    prefix: Option<Prefix>,
    gpu: bool,
    device: String,
    path: PathBuf,
}

/// Runs requests against a loaded model. Returns the request that needs a different
/// model (a new `load`), or `None` after `unload` or when the channel closes.
#[allow(clippy::too_many_arguments)]
fn serve(
    backend: &LlamaBackend,
    model: &LlamaModel,
    device: String,
    args: &LoadArgs,
    load_req: Request,
    rx: &Receiver<Request>,
    out: &Output,
    cancelled: &AtomicI64,
) -> Option<Request> {
    let started = Instant::now();
    let threads = resolve_threads(args.threads);
    let n_ctx = args.ctx.clamp(512, 32768).min(model.n_ctx_train().max(512));
    let params = LlamaContextParams::default()
        .with_n_ctx(NonZeroU32::new(n_ctx))
        .with_n_batch(N_BATCH)
        .with_n_ubatch(N_BATCH)
        .with_n_threads(threads)
        .with_n_threads_batch(threads);
    let ctx = match model.new_context(backend, params) {
        Ok(c) => c,
        Err(e) => {
            let _ = out.reply_err(&load_req.id, &format!("could not create a context: {e}"));
            return None;
        }
    };
    let gpu = device != "CPU";
    // QUILL_CLEANUP_SNAPSHOT=1 treats any model like a recurrent one (tests that path on small dense models).
    let recurrent = model.is_recurrent() || model.is_hybrid() || std::env::var_os("QUILL_CLEANUP_SNAPSHOT").is_some();
    let mut s = Session {
        model,
        ctx,
        batch: LlamaBatch::new(N_BATCH as usize, 1),
        recurrent,
        prefix: None,
        gpu,
        device: device.clone(),
        path: args.model.clone(),
    };
    let report = LoadReport {
        load_ms: started.elapsed().as_millis() as u64,
        gpu,
        device,
        threads,
        ctx: n_ctx,
        recurrent,
        model_bytes: model.size(),
        params: model.n_params(),
    };
    log!(
        "loaded {} on {} ({} threads, ctx {n_ctx}{}) in {} ms",
        args.model.display(),
        report.device,
        threads,
        if recurrent { ", recurrent" } else { "" },
        report.load_ms
    );
    let _ = out.reply_ok(&load_req.id, report);

    for req in rx.iter() {
        let id = req.id.as_i64().unwrap_or(i64::MAX);
        let is_cancelled = || cancelled.load(Ordering::SeqCst) >= id;
        match req.cmd.as_str() {
            "load" => {
                // A file that can't be a model is refused before the current one is let go.
                match req.args::<LoadArgs>().and_then(|a| check_model_file(&a.model)) {
                    Ok(()) => return Some(req),
                    Err(e) => {
                        let _ = out.reply_err(&req.id, &e);
                    }
                }
            }
            "unload" => {
                let _ = out.reply_ok(&req.id, Unloaded { was_loaded: true });
                return None;
            }
            "info" => {
                let info = Info {
                    model: Some(s.path.display().to_string()),
                    gpu: s.gpu,
                    device: Some(s.device.clone()),
                    prefix_tokens: s.prefix.as_ref().map_or(0, |p| p.tokens.len()),
                };
                let _ = out.reply_ok(&req.id, info);
            }
            "prime" => {
                let result = req.args::<PrimeArgs>().and_then(|a| {
                    let t = Instant::now();
                    let tokens = tokenize(s.model, &a.prefix, true);
                    s.ensure_prefix(&tokens, &is_cancelled)?;
                    Ok(PrimeReport { prefix_tokens: tokens.len(), prime_ms: t.elapsed().as_millis() as u64 })
                });
                reply(out, &req.id, result);
            }
            "clean" => {
                if is_cancelled() {
                    let _ = out.reply_err(&req.id, CANCELLED);
                    continue;
                }
                let result = req.args::<CleanArgs>().and_then(|a| s.clean(&a, &is_cancelled));
                if let Err(e) = &result {
                    if e != CANCELLED {
                        log!("clean failed: {e}");
                    }
                    // Whatever happened mid-request, the next one starts from a clean slate.
                    s.prefix = None;
                }
                reply(out, &req.id, result);
            }
            "ping" => {
                let _ = out.reply_ok(&req.id, Empty {});
            }
            other => {
                let _ = out.reply_err(&req.id, &format!("unknown command '{other}'"));
            }
        }
    }
    None
}

fn reply<T: Serialize>(out: &Output, id: &Value, result: Result<T, String>) {
    let _ = match result {
        Ok(v) => out.reply_ok(id, v),
        Err(e) => out.reply_err(id, &e),
    };
}

fn tokenize(model: &LlamaModel, segments: &[Segment], at_start: bool) -> Vec<LlamaToken> {
    let vocab = model.vocab();
    let mut tokens = Vec::new();
    for (i, seg) in segments.iter().enumerate() {
        if seg.text.is_empty() {
            continue;
        }
        // BOS (for models that want one) only at the very start of the prompt.
        let add_special = at_start && i == 0;
        tokens.extend(vocab.tokenize(seg.text.as_bytes(), add_special, seg.special));
    }
    tokens
}

fn argmax(logits: &[f32]) -> LlamaToken {
    let mut best = 0usize;
    let mut best_v = f32::NEG_INFINITY;
    for (i, &v) in logits.iter().enumerate() {
        if v > best_v {
            best_v = v;
            best = i;
        }
    }
    LlamaToken(best as i32)
}

impl<'m> Session<'m> {
    /// Makes the context hold exactly `tokens` (the instruction prefix) in sequence 0.
    fn ensure_prefix(&mut self, tokens: &[LlamaToken], cancelled: &dyn Fn() -> bool) -> Result<usize, String> {
        if let Some(p) = &self.prefix {
            if p.tokens == tokens {
                let restored = match &p.snapshot {
                    Some(snap) => {
                        self.ctx.clear_kv_cache();
                        self.ctx.state_seq_set(snap, 0).is_ok()
                    }
                    None => self.ctx.kv_cache_seq_rm(0, Some(tokens.len() as u32), None).is_ok(),
                };
                if restored {
                    return Ok(tokens.len());
                }
            }
        }
        self.prefix = None;
        self.ctx.clear_kv_cache();
        self.decode_prompt(tokens, 0, cancelled)?;
        let snapshot = if self.recurrent {
            Some(self.ctx.state_seq_get(0, LlamaStateSeqFlags::empty()).map_err(|e| format!("could not save the prompt state: {e}"))?)
        } else {
            None
        };
        self.prefix = Some(Prefix { tokens: tokens.to_vec(), snapshot });
        Ok(0)
    }

    /// Decodes `tokens` starting at position `pos`. Logits are kept for the last token only.
    fn decode_prompt(&mut self, tokens: &[LlamaToken], pos: usize, cancelled: &dyn Fn() -> bool) -> Result<(), String> {
        let n = tokens.len();
        for (c, chunk) in tokens.chunks(N_BATCH as usize).enumerate() {
            if cancelled() {
                return Err(CANCELLED.into());
            }
            self.batch.clear();
            let base = pos + c * N_BATCH as usize;
            for (i, &t) in chunk.iter().enumerate() {
                let p = base + i;
                self.batch.add(t, p as i32, &[0], p + 1 == pos + n).map_err(|e| e.to_string())?;
            }
            self.ctx.decode(&mut self.batch).map_err(|e| format!("decode failed: {e}"))?;
        }
        Ok(())
    }

    fn clean(&mut self, a: &CleanArgs, cancelled: &dyn Fn() -> bool) -> Result<Cleaned, String> {
        let started = Instant::now();
        let prefix = tokenize(self.model, &a.prefix, true);
        let prompt = tokenize(self.model, &a.prompt, prefix.is_empty());
        if prompt.is_empty() {
            return Err("empty prompt".into());
        }
        let n_ctx = self.ctx.n_ctx() as usize;
        let max_tokens = a.max_tokens.max(1) as usize;
        if prefix.len() + prompt.len() + max_tokens + 1 > n_ctx {
            return Err(format!(
                "input too long: {} prompt tokens + {max_tokens} to generate exceed the {n_ctx}-token context",
                prefix.len() + prompt.len()
            ));
        }

        let cached = self.ensure_prefix(&prefix, cancelled)?;
        self.decode_prompt(&prompt, prefix.len(), cancelled)?;
        let prompt_ms = started.elapsed().as_millis() as u64;

        let model: &'m LlamaModel = self.model;
        let vocab = model.vocab();
        let mut n_past = prefix.len() + prompt.len();
        let mut next = argmax(self.ctx.get_logits_ith(self.batch.n_tokens() - 1));
        let mut lookup = Lookup::new(if self.recurrent || a.lookup.is_empty() {
            Vec::new()
        } else {
            vocab.tokenize(a.lookup.as_bytes(), false, false)
        });
        let stop_max = a.stop.iter().map(|s| s.len()).max().unwrap_or(0);
        let mut out: Vec<LlamaToken> = Vec::new();
        let mut text: Vec<u8> = Vec::new();
        let mut drafted = 0usize;
        let mut accepted_total = 0usize;
        let mut tuner = DraftTuner::new(self.gpu);
        let gen_started = Instant::now();

        // Appends a token's text; returns why generation must end, if it must.
        let push = |tok: LlamaToken, out: &mut Vec<LlamaToken>, text: &mut Vec<u8>| -> Option<&'static str> {
            if vocab.is_eog(tok) {
                return Some("eog");
            }
            out.push(tok);
            let before = text.len();
            text.extend(vocab.token_to_piece(tok, false, None));
            if stop_max > 0 {
                let from = before.saturating_sub(stop_max);
                for s in &a.stop {
                    if s.is_empty() {
                        continue;
                    }
                    if let Some(at) = find(&text[from..], s.as_bytes()) {
                        text.truncate(from + at);
                        return Some("stop");
                    }
                }
            }
            if out.len() >= max_tokens {
                return Some("limit");
            }
            None
        };

        let stop = 'gen: loop {
            if cancelled() {
                return Err(CANCELLED.into());
            }
            if let Some(why) = push(next, &mut out, &mut text) {
                break why;
            }
            let budget = max_tokens - out.len();
            let cap = tuner.choose(DRAFT_MAX);
            let draft = lookup.draft(&out, cap.min(budget).min(n_ctx.saturating_sub(n_past + 2)));
            let step = Instant::now();
            self.batch.clear();
            self.batch.add(next, n_past as i32, &[0], true).map_err(|e| e.to_string())?;
            for (i, &d) in draft.tokens.iter().enumerate() {
                self.batch.add(d, (n_past + 1 + i) as i32, &[0], true).map_err(|e| e.to_string())?;
            }
            self.ctx.decode(&mut self.batch).map_err(|e| format!("decode failed: {e}"))?;
            n_past += 1;
            drafted += draft.tokens.len();

            let mut candidate = argmax(self.ctx.get_logits_ith(0));
            let mut accepted = 0usize;
            for (i, &d) in draft.tokens.iter().enumerate() {
                if candidate != d {
                    break;
                }
                accepted += 1;
                n_past += 1;
                if let Some(why) = push(d, &mut out, &mut text) {
                    accepted_total += accepted;
                    break 'gen why;
                }
                candidate = argmax(self.ctx.get_logits_ith(i as i32 + 1));
            }
            accepted_total += accepted;
            tuner.record(draft.tokens.len(), accepted, step.elapsed().as_secs_f64());
            if accepted < draft.tokens.len() {
                // Forget the rejected part of the draft.
                self.ctx
                    .kv_cache_seq_rm(0, Some(n_past as u32), None)
                    .map_err(|e| format!("could not rewind: {e}"))?;
            }
            if !draft.tokens.is_empty() {
                lookup.accept(draft.start, accepted);
            }
            next = candidate;
            if n_past + 2 >= n_ctx {
                break 'gen "limit";
            }
        };

        Ok(Cleaned {
            text: String::from_utf8_lossy(&text).into_owned(),
            stop,
            prompt_tokens: prefix.len() + prompt.len(),
            cached_tokens: cached,
            generated_tokens: out.len(),
            drafted_tokens: drafted,
            accepted_tokens: accepted_total,
            prompt_ms,
            generate_ms: gen_started.elapsed().as_millis() as u64,
            process_ms: started.elapsed().as_millis() as u64,
        })
    }
}

/// Picks how many tokens to draft, from what drafting has cost and gained so far.
///
/// A step that checks `k` drafted tokens costs about `t1 + k·c` (one token's pass plus
/// the extra compute per drafted token) and yields `1 + p + … + p^k` tokens on average,
/// where `p` is how often a drafted token is right. Reading the weights dominates on a
/// GPU, so long drafts are nearly free; on a processor with few cores the extra compute
/// is real, and shorter drafts (or none) are faster. Both costs are measured as it goes.
struct DraftTuner {
    t1: Option<f64>,
    c: Option<f64>,
    p: f64,
    /// Plain steps since the last draft; now and then a short draft re-checks the odds.
    plain: u32,
}

impl DraftTuner {
    fn new(gpu: bool) -> Self {
        DraftTuner { t1: None, c: if gpu { Some(0.0005) } else { None }, p: 0.6, plain: 0 }
    }

    fn choose(&self, max: usize) -> usize {
        let Some(t1) = self.t1 else { return 0 }; // measure a plain step first
        let Some(c) = self.c else { return max.min(4) }; // then one drafted step
        let mut best = (0usize, 1.0 / t1);
        let mut expected = 1.0;
        let mut pk = 1.0;
        for k in 1..=max {
            pk *= self.p;
            expected += pk;
            let rate = expected / (t1 + k as f64 * c);
            if rate > best.1 * 1.02 {
                best = (k, rate);
            }
        }
        if best.0 == 0 && self.plain >= 8 {
            return 2.min(max);
        }
        best.0
    }

    fn record(&mut self, drafted: usize, accepted: usize, secs: f64) {
        let ema = |old: Option<f64>, new: f64| Some(old.map_or(new, |o| o * 0.7 + new * 0.3));
        if drafted == 0 {
            self.t1 = ema(self.t1, secs);
            self.plain += 1;
            return;
        }
        self.plain = 0;
        if let Some(t1) = self.t1 {
            self.c = ema(self.c, ((secs - t1) / drafted as f64).max(0.0));
        }
        // Accepted drafts are a prefix: `accepted` successes, then one miss (unless all landed).
        let trials = accepted + usize::from(accepted < drafted);
        let rate = accepted as f64 / trials.max(1) as f64;
        self.p = (self.p * 0.7 + rate * 0.3).clamp(0.05, 0.98);
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_stop_strings() {
        assert_eq!(find(b"hello</t>", b"</t>"), Some(5));
        assert_eq!(find(b"he", b"hello"), None);
        assert_eq!(find(b"abc", b""), None);
    }

    #[test]
    fn drafts_long_when_checking_is_cheap_and_not_at_all_when_it_is_dear() {
        let mut t = DraftTuner::new(false);
        assert_eq!(t.choose(10), 0);
        t.record(0, 0, 0.050);
        assert_eq!(t.choose(10), 4);
        // Cheap verification (GPU-like) and good guesses: draft far ahead.
        t.record(4, 4, 0.052);
        for _ in 0..5 {
            t.record(8, 8, 0.054);
        }
        assert!(t.choose(10) >= 8);
        // Expensive verification (few CPU cores) and poor guesses: don't draft.
        let mut slow = DraftTuner::new(false);
        slow.record(0, 0, 0.050);
        for _ in 0..6 {
            slow.record(4, 0, 0.250);
        }
        assert_eq!(slow.choose(10), 0);
    }

    #[test]
    fn picks_the_largest_logit() {
        assert_eq!(argmax(&[0.1, 3.0, -1.0, 2.9]).0, 1);
    }

    #[test]
    fn automatic_threads_stay_in_range() {
        let t = resolve_threads(0);
        assert!((1..=8).contains(&t));
        assert_eq!(resolve_threads(3), 3);
    }
}
