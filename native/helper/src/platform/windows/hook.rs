//! `WH_KEYBOARD_LL` hook on a dedicated message-loop thread.
//!
//! The hook procedure must return quickly (Windows silently removes slow low-level
//! hooks), so it only: reads the configuration from an atomic, updates thread-local
//! keyboard state ([`KeyboardState`]), pushes events into a channel (written to stdout by
//! another thread) and, when needed, injects the mask key. It never blocks and never
//! panics (a panic in an `extern "system"` function would abort the process).

use super::input::{self, INJECT_TAG};
use crate::hotkey::machine::{Config, Event, KeyboardState};
use crate::hotkey::modifier_bit;
use std::cell::RefCell;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::OnceLock;
use std::thread::{self, JoinHandle};
use std::time::Duration;
use windows::Win32::Foundation::{HINSTANCE, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::{
    GetCurrentThread, GetCurrentThreadId, SetThreadPriority, THREAD_PRIORITY_TIME_CRITICAL,
};
use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetMessageW, PeekMessageW, PostThreadMessageW, SetWindowsHookExW, UnhookWindowsHookEx,
    HC_ACTION, KBDLLHOOKSTRUCT, MSG, PM_NOREMOVE, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_QUIT,
    WM_SYSKEYDOWN, WM_SYSKEYUP, WM_USER,
};

/// Current configuration, packed with [`Config::pack`]. Written by the command thread,
/// read (lock-free) by the hook.
static CONFIG: AtomicU32 = AtomicU32::new(0);
/// Where the hook sends events. Set once; the same channel serves hook restarts.
static EVENTS: OnceLock<Sender<Event>> = OnceLock::new();

thread_local! {
    /// Only ever touched by the hook thread, from inside the hook procedure.
    static STATE: RefCell<KeyboardState> = RefCell::new(KeyboardState::new());
}

/// A running keyboard hook. Dropping it without [`Hook::stop`] leaves the hook running
/// until the process exits.
pub struct Hook {
    thread_id: u32,
    thread: Option<JoinHandle<()>>,
}

impl Hook {
    /// Installs the hook on a new thread and waits until installation succeeded or failed.
    pub fn start(config: Config, events: Sender<Event>) -> Result<Hook, String> {
        CONFIG.store(config.pack(), Ordering::SeqCst);
        let _ = EVENTS.set(events); // already set on a restart: same channel
        let (ready_tx, ready_rx) = mpsc::sync_channel::<Result<u32, String>>(1);
        let thread = thread::Builder::new()
            .name("quill-keyboard-hook".into())
            .spawn(move || hook_thread(ready_tx))
            .map_err(|e| format!("could not start the keyboard hook thread: {e}"))?;
        match ready_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(thread_id)) => Ok(Hook { thread_id, thread: Some(thread) }),
            Ok(Err(e)) => {
                let _ = thread.join();
                Err(e)
            }
            Err(_) => Err("the keyboard hook thread did not start in time".into()),
        }
    }

    /// Publishes a new configuration to the hook.
    pub fn publish(&self, config: Config) {
        CONFIG.store(config.pack(), Ordering::SeqCst);
    }

    /// Removes the hook and joins its thread.
    pub fn stop(mut self) {
        // SAFETY: posting WM_QUIT to a thread that owns a message queue.
        if unsafe { PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0)) }.is_ok() {
            if let Some(t) = self.thread.take() {
                let _ = t.join();
            }
        }
    }
}

fn hook_thread(ready: mpsc::SyncSender<Result<u32, String>>) {
    // SAFETY: straightforward Win32 calls on the current thread; `msg` outlives every use.
    unsafe {
        // Keep the hook responsive under load; it does almost no work.
        let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
        // Create the thread's message queue before publishing the thread id, so a
        // WM_QUIT posted right away cannot be lost.
        let mut msg = MSG::default();
        let _ = PeekMessageW(&mut msg, None, WM_USER, WM_USER, PM_NOREMOVE);

        let module = GetModuleHandleW(None).ok().map(|m| HINSTANCE(m.0));
        let hook = match SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), module, 0) {
            Ok(h) => h,
            Err(e) => {
                let _ = ready.send(Err(format!("could not install the keyboard hook: {e}")));
                return;
            }
        };
        let _ = ready.send(Ok(GetCurrentThreadId()));

        // Low-level hooks are called through this thread's message loop.
        loop {
            let r = GetMessageW(&mut msg, None, 0, 0);
            if r.0 == 0 || r.0 == -1 {
                break; // WM_QUIT or error
            }
        }
        let _ = UnhookWindowsHookEx(hook);
    }
}

unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 && lparam.0 != 0 {
        // SAFETY: for HC_ACTION, lparam points to a KBDLLHOOKSTRUCT valid for this call.
        let kb = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
        // Our own injected input (paste, type, mask key) is invisible to the state machine.
        // This also makes re-entrant calls caused by SendInput inside this proc harmless.
        if kb.dwExtraInfo != INJECT_TAG {
            if let Some(swallow) = handle(kb, wparam.0 as u32) {
                if swallow {
                    return LRESULT(1);
                }
            }
        }
    }
    // SAFETY: forwarding the unchanged arguments to the next hook.
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

/// Runs the state machine for one event. Returns whether to swallow it.
fn handle(kb: &KBDLLHOOKSTRUCT, message: u32) -> Option<bool> {
    let down = match message {
        WM_KEYDOWN | WM_SYSKEYDOWN => true,
        WM_KEYUP | WM_SYSKEYUP => false,
        _ => return None,
    };
    let vk = u16::try_from(kb.vkCode).ok().filter(|&v| v < 256)?;
    let config = Config::unpack(CONFIG.load(Ordering::Relaxed));

    let decision = STATE
        .try_with(|cell| {
            // try_borrow_mut: never panic, even if somehow re-entered.
            let mut state = cell.try_borrow_mut().ok()?;
            if down && modifier_bit(vk).is_none() {
                state.sync_modifiers(is_physically_down);
            }
            Some(state.on_key(vk, down, &config))
        })
        .ok()
        .flatten()?;
    // The RefCell borrow is released here, before anything that can re-enter the hook.

    if let Some(event) = decision.event {
        if let Some(tx) = EVENTS.get() {
            let _ = tx.send(event); // unbounded channel: never blocks
        }
    }
    if decision.inject_mask {
        // Must reach the system before the modifier release we are about to pass on.
        input::send_mask_key();
    }
    Some(decision.swallow)
}

fn is_physically_down(vk: u16) -> bool {
    // SAFETY: GetAsyncKeyState has no preconditions.
    (unsafe { GetAsyncKeyState(i32::from(vk)) } as u16) & 0x8000 != 0
}
