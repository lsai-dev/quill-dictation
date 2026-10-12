//! Input injection with `SendInput`.

use crate::hotkey::vk;
use crate::platform::keystrokes::{batches, keystrokes, Keystroke};
use crate::platform::InjectReport;
use std::time::{Duration, Instant};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS,
    KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MAPVK_VK_TO_VSC, VIRTUAL_KEY,
};

/// `dwExtraInfo` marker on everything we inject ("QUIL"), so our own hook ignores it.
pub const INJECT_TAG: usize = 0x5155_494C;

/// Longest we wait for the user to let go of modifiers before injecting.
const MODIFIER_WAIT: Duration = Duration::from_millis(400);
/// Keystrokes per SendInput call when typing (each is a down + up pair).
const TYPE_BATCH: usize = 64;
/// Pause between typing batches, so slow applications keep up.
const TYPE_BATCH_PAUSE: Duration = Duration::from_millis(2);

/// Modifiers that would turn Ctrl+V into a different shortcut (Win+Ctrl+V, Ctrl+Alt+V...).
const PASTE_BLOCKERS: [u16; 6] = [vk::LWIN, vk::RWIN, vk::LMENU, vk::RMENU, vk::LSHIFT, vk::RSHIFT];
/// For typing, Ctrl matters too (Ctrl+letter is a shortcut, Shift+Enter differs from Enter).
const TYPE_BLOCKERS: [u16; 8] =
    [vk::LWIN, vk::RWIN, vk::LMENU, vk::RMENU, vk::LSHIFT, vk::RSHIFT, vk::LCONTROL, vk::RCONTROL];

/// Synthesizes Ctrl+V.
pub fn paste() -> Result<InjectReport, String> {
    let (waited_ms, modifiers_held) = wait_for_release(&PASTE_BLOCKERS);
    send(&[
        vk_input(vk::CONTROL, false),
        vk_input(vk::KEY_V, false),
        vk_input(vk::KEY_V, true),
        vk_input(vk::CONTROL, true),
    ])?;
    Ok(InjectReport { waited_ms, modifiers_held, keystrokes: 1 })
}

/// Types `text` as Unicode keystrokes (Enter for newlines, Tab for tabs).
pub fn type_text(text: &str) -> Result<InjectReport, String> {
    let keys = keystrokes(text);
    let (waited_ms, modifiers_held) = wait_for_release(&TYPE_BLOCKERS);
    let mut inputs = Vec::with_capacity(TYPE_BATCH * 2);
    for (i, batch) in batches(&keys, TYPE_BATCH).into_iter().enumerate() {
        if i > 0 {
            std::thread::sleep(TYPE_BATCH_PAUSE);
        }
        inputs.clear();
        for &key in batch {
            match key {
                Keystroke::Unicode(unit) => {
                    inputs.push(unicode_input(unit, false));
                    inputs.push(unicode_input(unit, true));
                }
                Keystroke::Virtual(code) => {
                    inputs.push(vk_input(code, false));
                    inputs.push(vk_input(code, true));
                }
            }
        }
        send(&inputs)?;
    }
    Ok(InjectReport { waited_ms, modifiers_held, keystrokes: keys.len() })
}

/// Injects a press and release of the unassigned mask key. Called from the hook, so it
/// avoids anything slow (no scan-code lookup).
pub fn send_mask_key() {
    let inputs = [keyboard_input(vk::MASK, 0, KEYBD_EVENT_FLAGS(0)), keyboard_input(vk::MASK, 0, KEYEVENTF_KEYUP)];
    // SAFETY: valid INPUT array and size.
    unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
}

/// Waits (polling) until none of `keys` is physically held, up to [`MODIFIER_WAIT`].
/// Returns (milliseconds waited, whether a key was still held at the end).
fn wait_for_release(keys: &[u16]) -> (u64, bool) {
    let start = Instant::now();
    loop {
        // SAFETY: GetAsyncKeyState has no preconditions.
        let held = keys.iter().any(|&k| (unsafe { GetAsyncKeyState(i32::from(k)) } as u16) & 0x8000 != 0);
        let waited = start.elapsed();
        if !held || waited >= MODIFIER_WAIT {
            return (waited.as_millis() as u64, held);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn send(inputs: &[INPUT]) -> Result<(), String> {
    if inputs.is_empty() {
        return Ok(());
    }
    // SAFETY: valid INPUT array and size.
    let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent as usize == inputs.len() {
        Ok(())
    } else {
        Err(format!(
            "SendInput injected {sent} of {} events: {}",
            inputs.len(),
            std::io::Error::last_os_error()
        ))
    }
}

fn vk_input(code: u16, up: bool) -> INPUT {
    // SAFETY: MapVirtualKeyW has no preconditions.
    let scan = unsafe { MapVirtualKeyW(u32::from(code), MAPVK_VK_TO_VSC) } as u16;
    keyboard_input(code, scan, if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) })
}

fn unicode_input(unit: u16, up: bool) -> INPUT {
    let flags = if up { KEYEVENTF_UNICODE | KEYEVENTF_KEYUP } else { KEYEVENTF_UNICODE };
    keyboard_input(0, unit, flags)
}

fn keyboard_input(code: u16, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT { wVk: VIRTUAL_KEY(code), wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: INJECT_TAG },
        },
    }
}
