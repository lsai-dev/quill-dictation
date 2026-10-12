//! Global hotkey support shared by all platforms.
//!
//! * [`spec`] parses user-facing hotkey strings such as `"win+space"`.
//! * [`machine`] decides, key event by key event, what the keyboard hook does.
//!
//! Both are pure logic (no OS calls), so they are unit-tested on every platform; the
//! Windows hook in `platform::windows::hook` only feeds them events.

// Only the Windows hook drives the state machine; elsewhere it is exercised by tests.
#![cfg_attr(not(windows), allow(dead_code))]

pub mod machine;
pub mod spec;

pub use spec::HotkeySpec;

/// Windows virtual-key codes used by the hotkey logic. These are plain numbers, kept
/// here so the parser and state machine compile (and are tested) on every OS.
#[allow(dead_code)] // some codes are only referenced by the Windows-only code
pub mod vk {
    pub const TAB: u16 = 0x09;
    pub const RETURN: u16 = 0x0D;
    pub const SHIFT: u16 = 0x10;
    pub const CONTROL: u16 = 0x11;
    pub const MENU: u16 = 0x12; // Alt
    pub const PAUSE: u16 = 0x13;
    pub const CAPITAL: u16 = 0x14; // Caps Lock
    pub const ESCAPE: u16 = 0x1B;
    pub const SPACE: u16 = 0x20;
    pub const INSERT: u16 = 0x2D;
    pub const KEY_0: u16 = 0x30;
    pub const KEY_A: u16 = 0x41;
    pub const KEY_V: u16 = 0x56;
    pub const LWIN: u16 = 0x5B;
    pub const RWIN: u16 = 0x5C;
    pub const F1: u16 = 0x70;
    pub const SCROLL: u16 = 0x91;
    pub const LSHIFT: u16 = 0xA0;
    pub const RSHIFT: u16 = 0xA1;
    pub const LCONTROL: u16 = 0xA2;
    pub const RCONTROL: u16 = 0xA3;
    pub const LMENU: u16 = 0xA4;
    pub const RMENU: u16 = 0xA5;
    /// The `` ` `` / `~` key on US layouts (VK_OEM_3).
    pub const OEM_3: u16 = 0xC0;
    /// Unassigned virtual key, injected to "disguise" a Win/Alt release so Windows does
    /// not open the Start menu / activate the menu bar after a swallowed combo.
    pub const MASK: u16 = 0xE8;
}

/// Modifier bit set.
pub mod modifiers {
    pub const WIN: u8 = 1 << 0;
    pub const CTRL: u8 = 1 << 1;
    pub const ALT: u8 = 1 << 2;
    pub const SHIFT: u8 = 1 << 3;
    pub const ALL: u8 = WIN | CTRL | ALT | SHIFT;
}

/// The modifier bit a virtual key contributes, if it is a modifier key.
///
/// Low-level hooks report side-specific codes (`LSHIFT`, `RMENU`, ...), but software can
/// inject the generic ones, so both are recognised.
pub fn modifier_bit(vk: u16) -> Option<u8> {
    match vk {
        vk::LWIN | vk::RWIN => Some(modifiers::WIN),
        vk::LCONTROL | vk::RCONTROL | vk::CONTROL => Some(modifiers::CTRL),
        vk::LMENU | vk::RMENU | vk::MENU => Some(modifiers::ALT),
        vk::LSHIFT | vk::RSHIFT | vk::SHIFT => Some(modifiers::SHIFT),
        _ => None,
    }
}

/// Every virtual key that counts as a modifier.
pub const MODIFIER_KEYS: [u16; 11] = [
    vk::LWIN,
    vk::RWIN,
    vk::LCONTROL,
    vk::RCONTROL,
    vk::CONTROL,
    vk::LMENU,
    vk::RMENU,
    vk::MENU,
    vk::LSHIFT,
    vk::RSHIFT,
    vk::SHIFT,
];
