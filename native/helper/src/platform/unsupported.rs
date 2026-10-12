//! Stand-ins for platforms without hotkey / injection support.

use super::{Foreground, InjectReport, UNSUPPORTED};
use crate::hotkey::machine::{Config, Event};
use std::sync::mpsc::Sender;

/// Placeholder keyboard hook; [`Hook::start`] always fails.
pub struct Hook;

impl Hook {
    pub fn start(_config: Config, _events: Sender<Event>) -> Result<Hook, String> {
        Err(UNSUPPORTED.into())
    }

    pub fn publish(&self, _config: Config) {}

    pub fn stop(self) {}
}

pub fn paste() -> Result<InjectReport, String> {
    Err(UNSUPPORTED.into())
}

pub fn type_text(_text: &str) -> Result<InjectReport, String> {
    Err(UNSUPPORTED.into())
}

pub fn foreground() -> Foreground {
    Foreground::default()
}
