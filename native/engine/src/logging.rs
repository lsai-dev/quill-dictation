//! Routes whisper.cpp and ggml log output to stderr.
//!
//! `whisper_log_set` installs one callback for both whisper.cpp and ggml (it forwards to
//! `ggml_log_set`). Verbosity is controlled by `QUILL_ENGINE_LOG`
//! (`off` | `error` | `warn` | `info` (default) | `debug`).

use std::ffi::{c_char, c_void, CStr};
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use whisper_rs::GGMLLogLevel;

const OFF: u8 = 0;
const ERROR: u8 = 1;
const WARN: u8 = 2;
const INFO: u8 = 3;
const DEBUG: u8 = 4;

static THRESHOLD: AtomicU8 = AtomicU8::new(INFO);
/// Whether the previous message was shown; continuation fragments follow it.
static LAST_SHOWN: AtomicBool = AtomicBool::new(true);

/// Installs the log callback. Call once, before any other whisper.cpp function.
pub fn install() {
    let threshold = match std::env::var("QUILL_ENGINE_LOG").ok().as_deref().map(str::trim) {
        Some("off" | "none" | "0") => OFF,
        Some("error") => ERROR,
        Some("warn" | "warning") => WARN,
        Some("debug" | "trace") => DEBUG,
        _ => INFO,
    };
    THRESHOLD.store(threshold, Ordering::Relaxed);
    // SAFETY: `log_to_stderr` matches ggml_log_callback's signature, never unwinds, and
    // ignores the (null) user data pointer.
    unsafe { whisper_rs::set_log_callback(Some(log_to_stderr), std::ptr::null_mut()) };
}

unsafe extern "C" fn log_to_stderr(
    level: whisper_rs::whisper_rs_sys::ggml_log_level,
    text: *const c_char,
    _user_data: *mut c_void,
) {
    if text.is_null() {
        return;
    }
    let show = match GGMLLogLevel::from(level) {
        // A continuation fragment is shown iff the message it continues was.
        GGMLLogLevel::Cont => LAST_SHOWN.load(Ordering::Relaxed),
        other => {
            let rank = match other {
                GGMLLogLevel::Error => ERROR,
                GGMLLogLevel::Warn => WARN,
                GGMLLogLevel::Debug => DEBUG,
                _ => INFO,
            };
            let show = rank <= THRESHOLD.load(Ordering::Relaxed); // OFF (0) hides everything
            LAST_SHOWN.store(show, Ordering::Relaxed);
            show
        }
    };
    if show {
        // SAFETY: ggml passes a valid NUL-terminated string that outlives this call.
        let bytes = unsafe { CStr::from_ptr(text) }.to_bytes();
        // Never panic here: unwinding across the FFI boundary would abort the process.
        let _ = std::io::stderr().lock().write_all(bytes);
    }
}
