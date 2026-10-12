//! quill-cleanup: Quill's transcript-cleanup sidecar (a small language model via llama.cpp).
//!
//! Speaks the line-delimited JSON protocol described in `common/protocol.rs` on
//! stdin/stdout. Model work happens on a worker thread, so the main thread keeps reading
//! requests: a `cancel` stops the running request between two decoding steps.
//!
//! Commands: `load`, `prime`, `clean`, `cancel`, `unload`, `info`, `ping`, `shutdown`.
//! See `native/README.md` for the field list.

#[path = "../../common/protocol.rs"]
mod protocol;
#[path = "../../engine/src/stdio.rs"]
mod stdio;

mod logging;
mod lookup;
mod runner;

use protocol::{log, Empty, Frame, Output, Request};
use serde::Serialize;
use std::ffi::CStr;
use std::io;
use std::process::ExitCode;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;

const VERSION: &str = env!("CARGO_PKG_VERSION");
/// Requests carry no payloads; anything sent is discarded.
const MAX_PAYLOAD_BYTES: u64 = 0;

#[derive(Serialize)]
struct Ready<'a> {
    version: &'a str,
    backend: &'a str,
    system_info: &'a str,
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

    // SAFETY: returns a static NUL-terminated string.
    let system_info = unsafe { CStr::from_ptr(llama_cpp_sys_2::llama_print_system_info()) }
        .to_string_lossy()
        .trim()
        .to_string();
    let ready = Ready { version: VERSION, backend: runner::BACKEND, system_info: &system_info };
    if out.event("ready", ready).is_err() {
        return ExitCode::FAILURE;
    }
    log!("ready (backend {})", runner::BACKEND);

    // Requests with an id at or below this value are cancelled. Ids increase, so one
    // number covers the running request and anything queued behind it.
    let cancelled = Arc::new(AtomicI64::new(-1));
    let (tx, rx) = mpsc::channel::<Request>();
    let worker = {
        let out = out.clone();
        let cancelled = cancelled.clone();
        thread::Builder::new()
            .name("cleanup".into())
            .stack_size(16 * 1024 * 1024)
            .spawn(move || runner::run(rx, out, cancelled))
    };
    let worker = match worker {
        Ok(w) => w,
        Err(e) => {
            log!("could not start the worker: {e}");
            return ExitCode::FAILURE;
        }
    };

    let mut input = io::stdin().lock();
    let mut shutdown_id = None;
    loop {
        let frame = match protocol::read_frame(&mut input, MAX_PAYLOAD_BYTES) {
            Ok(Some(frame)) => frame,
            Ok(None) => break,
            Err(e) => {
                log!("stdin read failed: {e}");
                break;
            }
        };
        let req = match frame {
            Frame::Invalid { id, error } => {
                if out.reply_err(&id, &error).is_err() {
                    break;
                }
                continue;
            }
            Frame::Request(req) => req,
        };
        let sent = match req.cmd.as_str() {
            "cancel" => {
                let target = req.body.get("target").and_then(|v| v.as_i64());
                match target {
                    Some(t) => {
                        cancelled.fetch_max(t, Ordering::SeqCst);
                        out.reply_ok(&req.id, Empty {})
                    }
                    None => out.reply_err(&req.id, "cancel requires a numeric 'target'"),
                }
            }
            "ping" => out.reply_ok(&req.id, Empty {}),
            "shutdown" => {
                shutdown_id = Some(req.id);
                break;
            }
            _ => {
                if tx.send(req).is_err() {
                    break; // the worker is gone
                }
                Ok(())
            }
        };
        if sent.is_err() {
            break;
        }
    }

    // Stop whatever is running, let the worker free the model, then exit.
    cancelled.store(i64::MAX, Ordering::SeqCst);
    drop(tx);
    let _ = worker.join();
    if let Some(id) = shutdown_id {
        let _ = out.reply_ok(&id, Empty {});
    }
    ExitCode::SUCCESS
}
