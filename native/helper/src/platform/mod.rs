//! OS integration: global keyboard hook, input injection and foreground-window lookup.
//!
//! Windows has the real implementation; elsewhere every entry point reports
//! "unsupported on this platform" (except [`foreground`], which returns nulls).

use serde::Serialize;

mod keystrokes;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use self::windows::{foreground, paste, type_text, Hook};

#[cfg(not(windows))]
mod unsupported;
#[cfg(not(windows))]
pub use self::unsupported::{foreground, paste, type_text, Hook};

/// Platform name reported in the ready event.
pub const NAME: &str = if cfg!(windows) {
    "windows"
} else if cfg!(target_os = "macos") {
    "macos"
} else if cfg!(target_os = "linux") {
    "linux"
} else {
    "other"
};

/// Whether hotkeys and input injection are implemented on this OS.
pub const SUPPORTED: bool = cfg!(windows);

pub const UNSUPPORTED: &str = "unsupported on this platform";

/// Result of `paste` / `type`.
#[derive(Serialize, Debug)]
pub struct InjectReport {
    /// How long we waited for the user to release modifier keys first.
    pub waited_ms: u64,
    /// A modifier was still held when we gave up waiting and sent anyway.
    pub modifiers_held: bool,
    /// Number of keystrokes sent (`type` only counts characters/Enter/Tab).
    pub keystrokes: usize,
}

/// The window that currently has keyboard focus.
#[derive(Serialize, Debug, Default)]
pub struct Foreground {
    /// HWND as a decimal string (JSON numbers cannot hold every 64-bit value exactly).
    pub handle: Option<String>,
    pub title: Option<String>,
    /// Executable file name, e.g. `notepad.exe`.
    pub process: Option<String>,
}
