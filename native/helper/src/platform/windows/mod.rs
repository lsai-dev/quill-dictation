//! Win32 implementation.

mod foreground;
mod hook;
mod input;

pub use foreground::foreground;
pub use hook::Hook;
pub use input::{paste, type_text};
