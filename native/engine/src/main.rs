//! quill-engine: Quill's local speech-to-text sidecar (whisper.cpp via whisper-rs).
//!
//! Speaks the line-delimited JSON protocol described in `common/protocol.rs` on
//! stdin/stdout. Requests are handled sequentially on the main thread.
//!
//! Commands: `load`, `transcribe` (with an f32le PCM payload), `unload`, `info`, `ping`,
//! `shutdown`. See `native/README.md` for the full field list.

#[path = "../../common/protocol.rs"]
mod protocol;

mod audio;
mod logging;
mod stdio;
mod transcriber;

use protocol::{log, Empty, Frame, Output, Payload, Request};
use serde::{Deserialize, Serialize};
use std::io;
use std::panic::{self, AssertUnwindSafe};
use std::path::PathBuf;
use std::process::ExitCode;
use transcriber::{Engine, LoadOptions, TranscribeOptions, BACKEND};

const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Serialize)]
struct Ready<'a> {
    version: &'a str,
    backend: &'a str,
    system_info: &'a str,
    whisper_version: &'a str,
}

#[derive(Serialize)]
struct Info<'a> {
    version: &'a str,
    backend: &'a str,
    system_info: &'a str,
    model: Option<String>,
    gpu: bool,
    device: Option<&'a str>,
    threads: Option<u32>,
}

#[derive(Deserialize)]
struct LoadArgs {
    model: PathBuf,
    #[serde(default = "yes")]
    gpu: bool,
    #[serde(default = "yes")]
    flash_attn: bool,
    #[serde(default)]
    threads: u32,
}

#[derive(Deserialize)]
struct TranscribeArgs {
    #[serde(default = "auto")]
    language: String,
    #[serde(default)]
    translate: bool,
    #[serde(default)]
    prompt: Option<String>,
    #[serde(default)]
    beam_size: u32,
}

#[derive(Serialize)]
struct Unloaded {
    was_loaded: bool,
}

fn yes() -> bool {
    true
}

fn auto() -> String {
    "auto".to_string()
}

/// What the main loop should do after a request.
enum Flow {
    Continue,
    Exit,
}

fn main() -> ExitCode {
    let out = match stdio::isolate_stdout() {
        Ok(file) => Output::new(file),
        Err(e) => {
            log!("warning: could not isolate stdout ({e}); native libraries could corrupt the protocol stream");
            Output::new(io::stdout())
        }
    };
    logging::install();

    let system_info = whisper_rs::print_system_info().trim().to_string();
    let ready = Ready {
        version: VERSION,
        backend: BACKEND,
        system_info: &system_info,
        whisper_version: whisper_rs::WHISPER_CPP_VERSION,
    };
    if out.event("ready", ready).is_err() {
        return ExitCode::FAILURE;
    }
    log!("ready (backend {BACKEND}, whisper.cpp {})", whisper_rs::WHISPER_CPP_VERSION);

    let mut engine = Engine::default();
    let mut input = io::stdin().lock();
    loop {
        let frame = match protocol::read_frame(&mut input, audio::MAX_PAYLOAD_BYTES) {
            Ok(Some(frame)) => frame,
            Ok(None) => break, // EOF: the app went away or closed our stdin
            Err(e) => {
                log!("stdin read failed: {e}");
                break;
            }
        };
        let result = match frame {
            Frame::Invalid { id, error } => out.reply_err(&id, &error).map(|_| Flow::Continue),
            Frame::Request(req) => handle(&mut engine, &out, &system_info, req),
        };
        match result {
            Ok(Flow::Continue) => {}
            Ok(Flow::Exit) => break,
            Err(e) => {
                log!("stdout write failed ({e}); exiting");
                break;
            }
        }
    }
    drop(engine); // free the model (and GPU resources) before exiting
    ExitCode::SUCCESS
}

fn handle(engine: &mut Engine, out: &Output, system_info: &str, req: Request) -> io::Result<Flow> {
    let id = &req.id;
    match req.cmd.as_str() {
        "load" => {
            let args: LoadArgs = match req.args() {
                Ok(a) => a,
                Err(e) => return out.reply_err(id, &e).map(|_| Flow::Continue),
            };
            let opts = LoadOptions {
                model: args.model,
                gpu: args.gpu,
                flash_attn: args.flash_attn,
                threads: args.threads,
            };
            log!("loading {} (gpu: {}, flash_attn: {})", opts.model.display(), opts.gpu, opts.flash_attn);
            match guarded(engine, "load", |e| e.load(&opts)) {
                Ok(report) => {
                    log!(
                        "model loaded on {} in {} ms (warm-up {} ms, {} threads)",
                        report.device, report.load_ms, report.warmup_ms, report.threads
                    );
                    out.reply_ok(id, report)?
                }
                Err(e) => {
                    log!("load failed: {e}");
                    out.reply_err(id, &e)?
                }
            }
        }
        "transcribe" => match transcribe(engine, &req) {
            Ok(t) => out.reply_ok(id, t)?,
            Err(e) => out.reply_err(id, &e)?,
        },
        "unload" => out.reply_ok(id, Unloaded { was_loaded: engine.unload() })?,
        "info" => {
            let status = engine.status();
            let info = Info {
                version: VERSION,
                backend: BACKEND,
                system_info,
                model: status.as_ref().map(|s| s.path.display().to_string()),
                gpu: status.as_ref().is_some_and(|s| s.gpu),
                device: status.as_ref().map(|s| s.device),
                threads: status.as_ref().map(|s| s.threads),
            };
            out.reply_ok(id, info)?
        }
        "ping" => out.reply_ok(id, Empty {})?,
        "shutdown" => {
            out.reply_ok(id, Empty {})?;
            return Ok(Flow::Exit);
        }
        other => out.reply_err(id, &format!("unknown command '{other}'"))?,
    }
    Ok(Flow::Continue)
}

fn transcribe(engine: &mut Engine, req: &Request) -> Result<transcriber::Transcript, String> {
    // The framing layer has already consumed the payload, whatever happens below.
    let bytes = match &req.payload {
        Payload::Data(bytes) => bytes,
        Payload::None => return Err("transcribe requires an audio payload (\"bytes\": N)".into()),
        Payload::Discarded(n) => {
            return Err(format!("audio too long: {n} bytes (max {} s of 16 kHz f32 audio)", audio::MAX_SECONDS))
        }
    };
    let args: TranscribeArgs = req.args()?;
    if engine.status().is_none() {
        return Err("no model loaded".into());
    }
    let samples = audio::decode_f32le(bytes)?;
    let opts = TranscribeOptions {
        language: args.language,
        translate: args.translate,
        prompt: args.prompt.unwrap_or_default(),
        beam_size: args.beam_size,
    };
    guarded(engine, "transcribe", |e| e.transcribe(&opts, samples))
}

/// Runs `f`, turning a panic into an error reply instead of killing the process.
///
/// Note: this catches Rust panics only. A C++ exception or crash inside whisper.cpp still
/// terminates the process; the app is expected to restart the engine.
fn guarded<T>(engine: &mut Engine, what: &str, f: impl FnOnce(&mut Engine) -> Result<T, String>) -> Result<T, String> {
    match panic::catch_unwind(AssertUnwindSafe(|| f(engine))) {
        Ok(result) => result,
        Err(payload) => {
            let msg = payload
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| payload.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "unknown panic".into());
            log!("panic during {what}: {msg}");
            engine.recover();
            Err(format!("internal error during {what}: {msg}"))
        }
    }
}
