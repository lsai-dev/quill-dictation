//! Keeps stdout reserved for protocol lines.
//!
//! whisper.cpp and ggml are C/C++ libraries. Their log output is routed through
//! [`crate::logging`], but a stray `printf`/`std::cout` (debug paths, future versions,
//! GPU drivers) would corrupt the JSON stream. [`isolate_stdout`] therefore moves the real
//! stdout to a private handle used only by the protocol writer, and points the process's
//! standard output (fd 1, and on Windows also `STD_OUTPUT_HANDLE`) at stderr.

use std::fs::File;
use std::io;

/// Returns a private handle to the original stdout and redirects the process-wide
/// standard output to stderr.
pub fn isolate_stdout() -> io::Result<File> {
    imp::isolate_stdout()
}

#[cfg(unix)]
mod imp {
    use std::fs::File;
    use std::io;
    use std::os::fd::AsFd;

    pub fn isolate_stdout() -> io::Result<File> {
        // Duplicate first (close-on-exec), so nothing is lost if redirecting fails.
        let proto = io::stdout().as_fd().try_clone_to_owned()?;
        // SAFETY: fds 1 and 2 are the standard streams; dup2 has no memory-safety preconditions.
        if unsafe { libc::dup2(libc::STDERR_FILENO, libc::STDOUT_FILENO) } < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(File::from(proto))
    }
}

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use std::fs::File;
    use std::io;
    use std::os::windows::io::AsHandle;

    const STD_OUTPUT_HANDLE: u32 = -11i32 as u32;
    const STD_ERROR_HANDLE: u32 = -12i32 as u32;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetStdHandle(n_std_handle: u32) -> *mut c_void;
        fn SetStdHandle(n_std_handle: u32, handle: *mut c_void) -> i32;
    }

    pub fn isolate_stdout() -> io::Result<File> {
        // DuplicateHandle under the hood; the copy stays valid after the redirects below.
        let proto = io::stdout().as_handle().try_clone_to_owned()?;
        // C runtime: printf / std::cout write to CRT fd 1. whisper.cpp links against the same
        // (dynamic) UCRT as Rust, so this redirect applies to it.
        // SAFETY: dup2 on the CRT's standard descriptors has no memory-safety preconditions.
        if unsafe { libc::dup2(2, 1) } < 0 {
            crate::protocol::log!("note: could not redirect CRT stdout to stderr");
        }
        // Win32: anything that calls GetStdHandle(STD_OUTPUT_HANDLE) (including Rust's println!).
        // SAFETY: plain Win32 calls with valid constants; the stderr handle is owned by the process.
        unsafe {
            let err = GetStdHandle(STD_ERROR_HANDLE);
            if SetStdHandle(STD_OUTPUT_HANDLE, err) == 0 {
                crate::protocol::log!("note: could not redirect STD_OUTPUT_HANDLE to stderr");
            }
        }
        Ok(File::from(proto))
    }
}

#[cfg(not(any(unix, windows)))]
mod imp {
    pub fn isolate_stdout() -> std::io::Result<std::fs::File> {
        Err(std::io::Error::other("stdout isolation is not supported on this platform"))
    }
}
