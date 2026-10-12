//! quill-native: Quill's OS-integration sidecar.
//!
//! Speaks the line-delimited JSON protocol described in `common/protocol.rs`:
//! commands on stdin (handled sequentially on the main thread), replies and events on
//! stdout. On Windows a low-level keyboard hook runs on its own thread and reports the
//! global hotkey and Escape through a channel drained by an event-writer thread.
//!
//! Commands: `set_hotkey`, `set_hotkey_enabled`, `capture_escape`, `paste`, `type`
//! (Windows only), `hardware`, `foreground`, `vulkan_available`, `ping`, `shutdown`.

#[path = "../../common/protocol.rs"]
mod protocol;

mod hardware;
mod hotkey;
mod platform;
mod vulkan;

use hotkey::machine::{Config, Event};
use hotkey::HotkeySpec;
use platform::Hook;
use protocol::{log, Empty, Frame, Output, Request};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::io;
use std::panic::{self, AssertUnwindSafe};
use std::process::ExitCode;
use std::sync::mpsc::{self, Sender};
use std::thread;

const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Serialize)]
struct Ready<'a> {
    version: &'a str,
    platform: &'a str,
    /// The hotkey active before any `set_hotkey` (canonical form).
    hotkey: String,
}

#[derive(Deserialize)]
struct SetHotkeyArgs {
    hotkey: String,
}

#[derive(Deserialize)]
struct EnabledArgs {
    enabled: bool,
}

#[derive(Deserialize)]
struct TypeArgs {
    text: String,
}

#[derive(Serialize)]
struct HotkeyReply {
    hotkey: String,
    enabled: bool,
    capture_escape: bool,
    /// Whether the keyboard hook is installed (false after a `hook_error`).
    hook_active: bool,
}

enum Flow {
    Continue,
    Exit,
}

struct App {
    out: Output,
    config: Config,
    hook: Option<Hook>,
    events: Sender<Event>,
}

fn main() -> ExitCode {
    let out = Output::new(io::stdout());
    let (events_tx, events_rx) = mpsc::channel::<Event>();

    let ready = Ready { version: VERSION, platform: platform::NAME, hotkey: HotkeySpec::default().to_string() };
    if out.event("ready", ready).is_err() {
        return ExitCode::FAILURE;
    }

    // Event writer: the hook thread only pushes into the channel; this thread does the I/O.
    let writer_out = out.clone();
    let spawned = thread::Builder::new().name("quill-events".into()).spawn(move || {
        for event in events_rx {
            let sent = match event {
                Event::HotkeyDown => writer_out.event("hotkey", json!({ "state": "down" })),
                Event::HotkeyUp => writer_out.event("hotkey", json!({ "state": "up" })),
                Event::Escape => writer_out.event("escape", Empty {}),
            };
            if sent.is_err() {
                break; // stdout is gone; the main loop will see EOF on stdin
            }
        }
    });
    if let Err(e) = spawned {
        log!("could not start the event writer thread: {e}");
        return ExitCode::FAILURE;
    }

    let mut app = App { out: out.clone(), config: Config::default(), hook: None, events: events_tx };
    if platform::SUPPORTED {
        app.ensure_hook();
    }
    log!("ready (platform {}, hook {})", platform::NAME, if app.hook.is_some() { "active" } else { "inactive" });

    let mut input = io::stdin().lock();
    loop {
        // quill-native takes no binary payloads: any "bytes" are consumed and discarded.
        let frame = match protocol::read_frame(&mut input, 0) {
            Ok(Some(frame)) => frame,
            Ok(None) => break,
            Err(e) => {
                log!("stdin read failed: {e}");
                break;
            }
        };
        let result = match frame {
            Frame::Invalid { id, error } => out.reply_err(&id, &error).map(|_| Flow::Continue),
            Frame::Request(req) => app.handle(&req),
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
    if let Some(hook) = app.hook.take() {
        hook.stop();
    }
    ExitCode::SUCCESS
}

impl App {
    /// Installs the keyboard hook if it is not running, reporting failures as a
    /// `hook_error` event. Returns whether the hook is active.
    fn ensure_hook(&mut self) -> bool {
        if self.hook.is_some() {
            return true;
        }
        match Hook::start(self.config, self.events.clone()) {
            Ok(hook) => {
                self.hook = Some(hook);
                true
            }
            Err(message) => {
                log!("keyboard hook unavailable: {message}");
                let _ = self.out.event("hook_error", json!({ "message": message }));
                false
            }
        }
    }

    fn handle(&mut self, req: &Request) -> io::Result<Flow> {
        let id = &req.id;
        if req.cmd == "shutdown" {
            self.out.reply_ok(id, Empty {})?;
            return Ok(Flow::Exit);
        }
        // A panic in a handler becomes an error reply instead of killing the process.
        let result = panic::catch_unwind(AssertUnwindSafe(|| self.dispatch(req))).unwrap_or_else(|payload| {
            let msg = payload
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| payload.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "unknown panic".into());
            log!("panic while handling '{}': {msg}", req.cmd);
            Err(format!("internal error: {msg}"))
        });
        match result {
            Ok(value) => self.out.reply_ok(id, value)?,
            Err(error) => self.out.reply_err(id, &error)?,
        }
        Ok(Flow::Continue)
    }

    fn dispatch(&mut self, req: &Request) -> Result<serde_json::Value, String> {
        match req.cmd.as_str() {
            "set_hotkey" => {
                let args: SetHotkeyArgs = req.args()?;
                let spec = HotkeySpec::parse(&args.hotkey)?;
                self.update_config(|c| c.hotkey = spec)
            }
            "set_hotkey_enabled" => {
                let args: EnabledArgs = req.args()?;
                self.update_config(|c| c.enabled = args.enabled)
            }
            "capture_escape" => {
                let args: EnabledArgs = req.args()?;
                self.update_config(|c| c.capture_escape = args.enabled)
            }
            "paste" => to_value(platform::paste()?),
            "type" => {
                let args: TypeArgs = req.args()?;
                to_value(platform::type_text(&args.text)?)
            }
            "hardware" => to_value(hardware::probe()),
            "foreground" => to_value(platform::foreground()),
            "vulkan_available" => Ok(json!({ "available": vulkan::available() })),
            "ping" => Ok(json!({})),
            other => Err(format!("unknown command '{other}'")),
        }
    }

    /// Applies a configuration change and publishes it to the hook.
    fn update_config(&mut self, change: impl FnOnce(&mut Config)) -> Result<serde_json::Value, String> {
        if !platform::SUPPORTED {
            return Err(platform::UNSUPPORTED.into());
        }
        change(&mut self.config);
        let hook_active = self.ensure_hook(); // retry if an earlier install failed
        if let Some(hook) = &self.hook {
            hook.publish(self.config);
        }
        to_value(HotkeyReply {
            hotkey: self.config.hotkey.to_string(),
            enabled: self.config.enabled,
            capture_escape: self.config.capture_escape,
            hook_active,
        })
    }
}

fn to_value<T: Serialize>(value: T) -> Result<serde_json::Value, String> {
    serde_json::to_value(value).map_err(|e| format!("failed to encode reply: {e}"))
}
