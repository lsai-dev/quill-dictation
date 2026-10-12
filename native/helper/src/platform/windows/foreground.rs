//! Foreground window lookup.

use crate::platform::Foreground;
use std::path::Path;
use windows::core::PWSTR;
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId};

pub fn foreground() -> Foreground {
    // SAFETY: no preconditions; may return a null HWND (e.g. while focus is changing).
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() {
        return Foreground::default();
    }
    let mut title = vec![0u16; 512];
    // SAFETY: the buffer is valid and writable; the length is derived from the slice.
    let len = unsafe { GetWindowTextW(hwnd, &mut title) }.max(0) as usize;
    let title = String::from_utf16_lossy(&title[..len.min(title.len())]);

    let mut pid = 0u32;
    // SAFETY: valid out-pointer.
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };

    Foreground {
        handle: Some((hwnd.0 as usize).to_string()),
        title: Some(title),
        process: (pid != 0).then(|| process_name(pid)).flatten(),
    }
}

/// Executable file name of a process, e.g. `notepad.exe`.
fn process_name(pid: u32) -> Option<String> {
    // SAFETY: OpenProcess/QueryFullProcessImageNameW with a valid buffer; the handle is
    // closed before returning.
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = vec![0u16; 1024];
        let mut len = buf.len() as u32;
        let result = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len);
        let _ = CloseHandle(process);
        result.ok()?;
        let path = String::from_utf16_lossy(&buf[..(len as usize).min(buf.len())]);
        Path::new(&path).file_name().map(|n| n.to_string_lossy().into_owned())
    }
}
