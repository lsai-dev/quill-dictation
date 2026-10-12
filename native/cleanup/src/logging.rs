//! Routes llama.cpp and ggml log output to stderr.
//!
//! Verbosity is controlled by `QUILL_CLEANUP_LOG` (`off` | `error` | `warn` (default) |
//! `info` | `debug`). llama.cpp is chatty at `info` (every tensor on load), so the
//! default keeps only what matters.

use llama_cpp_sys_2::{self as sys, ggml_log_level};
use std::ffi::{c_char, c_void, CStr};
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};

const OFF: u8 = 0;
const ERROR: u8 = 1;
const WARN: u8 = 2;
const INFO: u8 = 3;
const DEBUG: u8 = 4;

static THRESHOLD: AtomicU8 = AtomicU8::new(WARN);
/// Whether the previous message was shown; continuation fragments follow it.
static LAST_SHOWN: AtomicBool = AtomicBool::new(true);

/// Installs the log callback. Call once, before loading a model.
pub fn install() {
    let threshold = match std::env::var("QUILL_CLEANUP_LOG").ok().as_deref().map(str::trim) {
        Some("off" | "none" | "0") => OFF,
        Some("error") => ERROR,
        Some("info") => INFO,
        Some("debug" | "trace") => DEBUG,
        _ => WARN,
    };
    THRESHOLD.store(threshold, Ordering::Relaxed);
    // SAFETY: `log_to_stderr` matches ggml_log_callback's signature, never unwinds, and
    // ignores the (null) user data pointer.
    unsafe { sys::llama_log_set(Some(log_to_stderr), std::ptr::null_mut()) };
}

unsafe extern "C" fn log_to_stderr(level: ggml_log_level, text: *const c_char, _user_data: *mut c_void) {
    if text.is_null() {
        return;
    }
    let show = if level == sys::GGML_LOG_LEVEL_CONT {
        LAST_SHOWN.load(Ordering::Relaxed)
    } else {
        let rank = match level {
            sys::GGML_LOG_LEVEL_ERROR => ERROR,
            sys::GGML_LOG_LEVEL_WARN => WARN,
            sys::GGML_LOG_LEVEL_DEBUG => DEBUG,
            _ => INFO,
        };
        let show = rank <= THRESHOLD.load(Ordering::Relaxed);
        LAST_SHOWN.store(show, Ordering::Relaxed);
        show
    };
    if show {
        // SAFETY: ggml passes a valid NUL-terminated string that outlives this call.
        let bytes = unsafe { CStr::from_ptr(text) }.to_bytes();
        // Never panic here: unwinding across the FFI boundary would abort the process.
        let _ = std::io::stderr().lock().write_all(bytes);
    }
}
