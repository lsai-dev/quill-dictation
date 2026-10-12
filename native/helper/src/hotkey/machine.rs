//! The keyboard-hook decision logic, independent of any OS API.
//!
//! The Windows low-level hook feeds every (non-self-injected) key event to
//! [`KeyboardState::on_key`] and acts on the returned [`Decision`]: swallow or pass the
//! event, emit a protocol event, and possibly inject the mask key first.
//!
//! Everything here must be cheap and must not panic: it runs inside the hook procedure,
//! which Windows silently removes if it is slow.

use super::{modifier_bit, modifiers, vk, HotkeySpec, MODIFIER_KEYS};

/// Hook configuration, packed into one `u32` so the command thread can publish it
/// atomically and the hook can read it without locking.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Config {
    pub hotkey: HotkeySpec,
    pub enabled: bool,
    pub capture_escape: bool,
}

impl Default for Config {
    fn default() -> Self {
        Config { hotkey: HotkeySpec::default(), enabled: true, capture_escape: false }
    }
}

const ENABLED_BIT: u32 = 1 << 12;
const ESCAPE_BIT: u32 = 1 << 13;

impl Config {
    /// Layout: bits 0-7 main vk, 8-11 modifiers, 12 enabled, 13 capture_escape.
    pub fn pack(self) -> u32 {
        u32::from(self.hotkey.vk & 0xFF)
            | (u32::from(self.hotkey.mods & modifiers::ALL) << 8)
            | if self.enabled { ENABLED_BIT } else { 0 }
            | if self.capture_escape { ESCAPE_BIT } else { 0 }
    }

    pub fn unpack(bits: u32) -> Self {
        Config {
            hotkey: HotkeySpec { vk: (bits & 0xFF) as u16, mods: ((bits >> 8) as u8) & modifiers::ALL },
            enabled: bits & ENABLED_BIT != 0,
            capture_escape: bits & ESCAPE_BIT != 0,
        }
    }
}

/// Protocol events produced by the hook.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    HotkeyDown,
    HotkeyUp,
    Escape,
}

/// What the hook should do with one key event.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Decision {
    /// Return 1 from the hook instead of passing the event on.
    pub swallow: bool,
    pub event: Option<Event>,
    /// Inject a mask-key press/release *before* passing this (modifier key-up) event on.
    pub inject_mask: bool,
}

impl Decision {
    const PASS: Decision = Decision { swallow: false, event: None, inject_mask: false };
    const SWALLOW: Decision = Decision { swallow: true, event: None, inject_mask: false };

    fn swallow_with(event: Event) -> Self {
        Decision { swallow: true, event: Some(event), inject_mask: false }
    }
}

/// A combo that fired and whose main key is still held.
#[derive(Clone, Copy, Debug)]
struct Active {
    vk: u16,
    mods: u8,
}

/// Keyboard state as observed by the hook.
#[derive(Debug, Default)]
pub struct KeyboardState {
    /// Keys currently held, as a 256-bit set indexed by virtual-key code.
    down: [u64; 4],
    active: Option<Active>,
    /// The combo ended early (a modifier was released): swallow the main key's
    /// remaining repeats and its release.
    orphan_main: Option<u16>,
    /// Modifiers that took part in a combo during their current press. Their release is
    /// preceded by a mask-key tap so Windows does not treat it as a lone modifier tap:
    /// Win would open the Start menu, Alt would activate the menu bar, Shift toggles some
    /// IMEs, Ctrl+Shift / Alt+Shift switch keyboard layouts.
    disguise: u8,
    /// We swallowed the current Escape press, so swallow its repeats and release too.
    escape_swallowed: bool,
}

impl KeyboardState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Currently held modifiers.
    pub fn mods(&self) -> u8 {
        MODIFIER_KEYS
            .iter()
            .filter(|&&k| self.is_down(k))
            .fold(0, |acc, &k| acc | modifier_bit(k).unwrap_or(0))
    }

    /// Whether a combo is currently held.
    #[cfg(test)]
    pub fn combo_active(&self) -> bool {
        self.active.is_some()
    }

    /// Re-synchronises tracked modifiers with the real key state.
    ///
    /// Low-level hooks miss events while the secure desktop is up (Win+L, UAC,
    /// Ctrl+Alt+Del) or when Windows skips a slow hook, which would leave a modifier
    /// "stuck" and make e.g. a bare Space match `win+space`. The hook calls this before
    /// matching. It does nothing while a combo is active (its own modifier tracking
    /// decides when the combo ends).
    pub fn sync_modifiers(&mut self, mut is_physically_down: impl FnMut(u16) -> bool) {
        if self.active.is_some() {
            return;
        }
        for k in MODIFIER_KEYS {
            let down = is_physically_down(k);
            if is_generic_modifier(k) {
                // The real state of VK_SHIFT/VK_CONTROL/VK_MENU is "either side is down",
                // and the hook only sees their release when software injected them. So only
                // clear them here; setting them would leave a phantom modifier behind after
                // the side-specific release.
                if !down && self.is_down(k) {
                    self.set_down(k, false);
                }
            } else if down != self.is_down(k) {
                self.set_down(k, down);
            }
        }
    }

    /// Processes one key event (`down` = key-down or auto-repeat, otherwise key-up).
    pub fn on_key(&mut self, vk: u16, down: bool, cfg: &Config) -> Decision {
        let was_down = self.is_down(vk);
        self.set_down(vk, down);

        if let Some(bit) = modifier_bit(vk) {
            return if down { Decision::PASS } else { self.on_modifier_up(bit) };
        }
        if vk == vk::ESCAPE {
            return self.on_escape(down, was_down, cfg);
        }
        if down {
            self.on_main_down(vk, was_down, cfg)
        } else {
            self.on_main_up(vk)
        }
    }

    fn on_modifier_up(&mut self, bit: u8) -> Decision {
        let mut d = Decision::PASS;
        let held = self.mods(); // after this release (the other side may still be down)
        if let Some(active) = self.active {
            if active.mods & bit != 0 && held & bit == 0 {
                self.active = None;
                self.orphan_main = Some(active.vk);
                d.event = Some(Event::HotkeyUp);
            }
        }
        if self.disguise & bit != 0 && held & bit == 0 {
            self.disguise &= !bit;
            d.inject_mask = true;
        }
        d
    }

    fn on_escape(&mut self, down: bool, was_down: bool, cfg: &Config) -> Decision {
        if down {
            if was_down {
                // Auto-repeat: follow whatever we did with the initial press.
                return if self.escape_swallowed { Decision::SWALLOW } else { Decision::PASS };
            }
            if cfg.capture_escape {
                self.escape_swallowed = true;
                return Decision::swallow_with(Event::Escape);
            }
            Decision::PASS
        } else if std::mem::take(&mut self.escape_swallowed) {
            Decision::SWALLOW
        } else {
            Decision::PASS
        }
    }

    fn on_main_down(&mut self, vk: u16, was_down: bool, cfg: &Config) -> Decision {
        if was_down {
            // Auto-repeat of a key we swallowed stays swallowed (and emits nothing).
            let ours = self.active.is_some_and(|a| a.vk == vk) || self.orphan_main == Some(vk);
            return if ours { Decision::SWALLOW } else { Decision::PASS };
        }
        let mods = self.mods();
        if cfg.enabled && vk == cfg.hotkey.vk && mods == cfg.hotkey.mods && self.active.is_none() {
            self.active = Some(Active { vk, mods });
            self.orphan_main = None;
            self.disguise |= mods;
            return Decision::swallow_with(Event::HotkeyDown);
        }
        Decision::PASS
    }

    fn on_main_up(&mut self, vk: u16) -> Decision {
        if self.active.is_some_and(|a| a.vk == vk) {
            self.active = None;
            return Decision::swallow_with(Event::HotkeyUp);
        }
        if self.orphan_main == Some(vk) {
            self.orphan_main = None;
            return Decision::SWALLOW;
        }
        Decision::PASS
    }

    fn is_down(&self, vk: u16) -> bool {
        let i = usize::from(vk & 0xFF);
        self.down[i / 64] & (1u64 << (i % 64)) != 0
    }

    fn set_down(&mut self, vk: u16, down: bool) {
        let i = usize::from(vk & 0xFF);
        let bit = 1u64 << (i % 64);
        if down {
            self.down[i / 64] |= bit;
        } else {
            self.down[i / 64] &= !bit;
        }
    }
}

fn is_generic_modifier(code: u16) -> bool {
    matches!(code, vk::SHIFT | vk::CONTROL | vk::MENU)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOWN: bool = true;
    const UP: bool = false;

    fn cfg(spec: &str) -> Config {
        Config { hotkey: HotkeySpec::parse(spec).unwrap(), enabled: true, capture_escape: false }
    }

    fn pass() -> Decision {
        Decision::default()
    }

    fn swallow(event: Option<Event>) -> Decision {
        Decision { swallow: true, event, inject_mask: false }
    }

    fn masked_pass(event: Option<Event>) -> Decision {
        Decision { swallow: false, event, inject_mask: true }
    }

    #[test]
    fn config_packing_round_trips() {
        for c in [
            Config::default(),
            Config { hotkey: HotkeySpec::parse("ctrl+shift+f24").unwrap(), enabled: false, capture_escape: true },
            Config { hotkey: HotkeySpec::parse("win+alt+backquote").unwrap(), enabled: true, capture_escape: true },
        ] {
            assert_eq!(Config::unpack(c.pack()), c);
        }
        let d = Config::default();
        assert!(d.enabled && !d.capture_escape && d.hotkey == HotkeySpec::default());
    }

    #[test]
    fn win_space_full_cycle() {
        let c = cfg("win+space");
        let mut s = KeyboardState::new();
        assert_eq!(s.on_key(vk::LWIN, DOWN, &c), pass());
        assert_eq!(s.on_key(vk::SPACE, DOWN, &c), swallow(Some(Event::HotkeyDown)));
        // auto-repeat: swallowed, no duplicate event
        assert_eq!(s.on_key(vk::SPACE, DOWN, &c), swallow(None));
        assert_eq!(s.on_key(vk::SPACE, DOWN, &c), swallow(None));
        assert_eq!(s.on_key(vk::SPACE, UP, &c), swallow(Some(Event::HotkeyUp)));
        // Win released after the combo: mask key first so the Start menu stays closed.
        assert_eq!(s.on_key(vk::LWIN, UP, &c), masked_pass(None));
        // A later plain Win tap is left alone.
        assert_eq!(s.on_key(vk::LWIN, DOWN, &c), pass());
        assert_eq!(s.on_key(vk::LWIN, UP, &c), pass());
    }

    #[test]
    fn plain_space_and_other_win_combos_pass_through() {
        let c = cfg("win+space");
        let mut s = KeyboardState::new();
        assert_eq!(s.on_key(vk::SPACE, DOWN, &c), pass());
        assert_eq!(s.on_key(vk::SPACE, UP, &c), pass());
        s.on_key(vk::LWIN, DOWN, &c);
        assert_eq!(s.on_key(0x45, DOWN, &c), pass()); // Win+E
        assert_eq!(s.on_key(0x45, UP, &c), pass());
        assert_eq!(s.on_key(vk::LWIN, UP, &c), pass()); // no combo fired: no mask
    }

    #[test]
    fn extra_modifiers_prevent_a_match() {
        let c = cfg("win+space");
        let mut s = KeyboardState::new();
        s.on_key(vk::LWIN, DOWN, &c);
        s.on_key(vk::LSHIFT, DOWN, &c);
        assert_eq!(s.on_key(vk::SPACE, DOWN, &c), pass());
        assert_eq!(s.on_key(vk::SPACE, UP, &c), pass());
    }

    #[test]
    fn either_side_of_a_modifier_matches() {
        let c = cfg("ctrl+alt+k");
        let mut s = KeyboardState::new();
        s.on_key(vk::RCONTROL, DOWN, &c);
        s.on_key(vk::LMENU, DOWN, &c);
        assert_eq!(s.on_key(0x4B, DOWN, &c), swallow(Some(Event::HotkeyDown)));
        assert_eq!(s.on_key(0x4B, UP, &c), swallow(Some(Event::HotkeyUp)));
        // Every modifier of the combo gets its release masked (Alt: no menu-bar activation).
        assert_eq!(s.on_key(vk::RCONTROL, UP, &c), masked_pass(None));
        assert_eq!(s.on_key(vk::LMENU, UP, &c), masked_pass(None));
        // A later lone Ctrl tap is left alone.
        assert_eq!(s.on_key(vk::LCONTROL, DOWN, &c), pass());
        assert_eq!(s.on_key(vk::LCONTROL, UP, &c), pass());
    }

    #[test]
    fn releasing_a_required_modifier_ends_the_combo() {
        let c = cfg("win+space");
        let mut s = KeyboardState::new();
        s.on_key(vk::LWIN, DOWN, &c);
        assert_eq!(s.on_key(vk::SPACE, DOWN, &c), swallow(Some(Event::HotkeyDown)));
        assert_eq!(s.on_key(vk::LWIN, UP, &c), masked_pass(Some(Event::HotkeyUp)));
        // The main key is still held: its repeats and release stay swallowed, silently.
        assert_eq!(s.on_key(vk::SPACE, DOWN, &c), swallow(None));
        assert_eq!(s.on_key(vk::SPACE, UP, &c), swallow(None));
        // Back to normal afterwards.
        assert_eq!(s.on_key(vk::SPACE, DOWN, &c), pass());
        assert_eq!(s.on_key(vk::SPACE, UP, &c), pass());
    }

    #[test]
    fn releasing_one_side_while_the_other_is_held_keeps_the_combo() {
        let c = cfg("shift+f9");
        let mut s = KeyboardState::new();
        s.on_key(vk::LSHIFT, DOWN, &c);
        s.on_key(vk::RSHIFT, DOWN, &c);
        // Both shifts held -> still exactly the SHIFT modifier.
        assert_eq!(s.on_key(0x78, DOWN, &c), swallow(Some(Event::HotkeyDown)));
        assert_eq!(s.on_key(vk::LSHIFT, UP, &c), pass()); // right Shift still held
        assert_eq!(s.on_key(0x78, UP, &c), swallow(Some(Event::HotkeyUp)));
        assert_eq!(s.on_key(vk::RSHIFT, UP, &c), masked_pass(None)); // last Shift released
    }

    #[test]
    fn modifier_pressed_after_main_key_does_not_trigger() {
        let c = cfg("win+space");
        let mut s = KeyboardState::new();
        assert_eq!(s.on_key(vk::SPACE, DOWN, &c), pass());
        s.on_key(vk::LWIN, DOWN, &c);
        // Space auto-repeat while Win is now held: not a fresh press.
        assert_eq!(s.on_key(vk::SPACE, DOWN, &c), pass());
        assert_eq!(s.on_key(vk::SPACE, UP, &c), pass());
    }

    #[test]
    fn disabled_hotkey_passes_through() {
        let mut c = cfg("win+space");
        c.enabled = false;
        let mut s = KeyboardState::new();
        s.on_key(vk::LWIN, DOWN, &c);
        assert_eq!(s.on_key(vk::SPACE, DOWN, &c), pass());
        assert_eq!(s.on_key(vk::SPACE, UP, &c), pass());
        assert_eq!(s.on_key(vk::LWIN, UP, &c), pass());
    }

    #[test]
    fn disabling_mid_combo_still_completes_it() {
        let mut c = cfg("win+space");
        let mut s = KeyboardState::new();
        s.on_key(vk::LWIN, DOWN, &c);
        assert_eq!(s.on_key(vk::SPACE, DOWN, &c), swallow(Some(Event::HotkeyDown)));
        c.enabled = false;
        c.hotkey = HotkeySpec::parse("ctrl+f1").unwrap();
        assert_eq!(s.on_key(vk::SPACE, DOWN, &c), swallow(None));
        assert_eq!(s.on_key(vk::SPACE, UP, &c), swallow(Some(Event::HotkeyUp)));
        assert_eq!(s.on_key(vk::LWIN, UP, &c), masked_pass(None));
    }

    #[test]
    fn modifierless_hotkey() {
        let c = cfg("f9");
        let mut s = KeyboardState::new();
        assert_eq!(s.on_key(0x78, DOWN, &c), swallow(Some(Event::HotkeyDown)));
        assert_eq!(s.on_key(0x78, UP, &c), swallow(Some(Event::HotkeyUp)));
        s.on_key(vk::LCONTROL, DOWN, &c);
        assert_eq!(s.on_key(0x78, DOWN, &c), pass()); // ctrl+f9 is not f9
    }

    #[test]
    fn escape_capture() {
        let mut c = cfg("win+space");
        let mut s = KeyboardState::new();
        assert_eq!(s.on_key(vk::ESCAPE, DOWN, &c), pass());
        assert_eq!(s.on_key(vk::ESCAPE, UP, &c), pass());
        c.capture_escape = true;
        assert_eq!(s.on_key(vk::ESCAPE, DOWN, &c), swallow(Some(Event::Escape)));
        assert_eq!(s.on_key(vk::ESCAPE, DOWN, &c), swallow(None)); // auto-repeat
        assert_eq!(s.on_key(vk::ESCAPE, UP, &c), swallow(None));
        // Capture turned off between press and release: the release is still swallowed.
        assert_eq!(s.on_key(vk::ESCAPE, DOWN, &c), swallow(Some(Event::Escape)));
        c.capture_escape = false;
        assert_eq!(s.on_key(vk::ESCAPE, UP, &c), swallow(None));
        // Pressed before capture was enabled: the release passes.
        assert_eq!(s.on_key(vk::ESCAPE, DOWN, &c), pass());
        c.capture_escape = true;
        assert_eq!(s.on_key(vk::ESCAPE, DOWN, &c), pass()); // repeat of an unswallowed press
        assert_eq!(s.on_key(vk::ESCAPE, UP, &c), pass());
    }

    #[test]
    fn hotkey_and_escape_together() {
        let mut c = cfg("win+space");
        c.capture_escape = true;
        let mut s = KeyboardState::new();
        s.on_key(vk::LWIN, DOWN, &c);
        assert_eq!(s.on_key(vk::SPACE, DOWN, &c), swallow(Some(Event::HotkeyDown)));
        assert_eq!(s.on_key(vk::ESCAPE, DOWN, &c), swallow(Some(Event::Escape)));
        assert_eq!(s.on_key(vk::ESCAPE, UP, &c), swallow(None));
        assert_eq!(s.on_key(vk::SPACE, UP, &c), swallow(Some(Event::HotkeyUp)));
    }

    #[test]
    fn stuck_modifier_is_cleared_by_sync() {
        // Win+L: the Win release happens on the secure desktop and is never seen.
        let c = cfg("win+space");
        let mut s = KeyboardState::new();
        s.on_key(vk::LWIN, DOWN, &c);
        s.on_key(0x4C, DOWN, &c);
        assert_eq!(s.mods(), modifiers::WIN);
        // Later, a bare Space: after syncing with the real state it must not match.
        s.sync_modifiers(|_| false);
        assert_eq!(s.mods(), 0);
        assert_eq!(s.on_key(vk::SPACE, DOWN, &c), pass());
    }

    #[test]
    fn missed_modifier_press_is_picked_up_by_sync() {
        let c = cfg("win+space");
        let mut s = KeyboardState::new();
        s.sync_modifiers(|k| k == vk::RWIN);
        assert_eq!(s.on_key(vk::SPACE, DOWN, &c), swallow(Some(Event::HotkeyDown)));
        // Sync is a no-op while the combo is active.
        s.sync_modifiers(|_| false);
        assert!(s.combo_active());
        assert_eq!(s.on_key(vk::SPACE, UP, &c), swallow(Some(Event::HotkeyUp)));
        assert_eq!(s.on_key(vk::RWIN, UP, &c), masked_pass(None));
    }

    #[test]
    fn sync_does_not_invent_generic_modifiers() {
        // GetAsyncKeyState reports VK_SHIFT/VK_MENU down whenever either side is down.
        let physical = |k: u16| matches!(k, vk::LMENU | vk::MENU);
        let c = cfg("alt+space");
        let mut s = KeyboardState::new();
        s.on_key(vk::LMENU, DOWN, &c);
        s.sync_modifiers(physical);
        assert_eq!(s.on_key(vk::SPACE, DOWN, &c), swallow(Some(Event::HotkeyDown)));
        // Releasing the (only) Alt ends the combo and masks the release.
        assert_eq!(s.on_key(vk::LMENU, UP, &c), masked_pass(Some(Event::HotkeyUp)));
        assert_eq!(s.mods(), 0);
        // A stuck generic code (injected down, never released) is cleared by sync.
        s.on_key(vk::SPACE, UP, &c);
        s.on_key(vk::CONTROL, DOWN, &c);
        s.sync_modifiers(|_| false);
        assert_eq!(s.mods(), 0);
    }

    #[test]
    fn second_combo_in_the_same_win_press_masks_once() {
        let c = cfg("win+space");
        let mut s = KeyboardState::new();
        s.on_key(vk::LWIN, DOWN, &c);
        for _ in 0..2 {
            assert_eq!(s.on_key(vk::SPACE, DOWN, &c), swallow(Some(Event::HotkeyDown)));
            assert_eq!(s.on_key(vk::SPACE, UP, &c), swallow(Some(Event::HotkeyUp)));
        }
        assert_eq!(s.on_key(vk::LWIN, UP, &c), masked_pass(None));
    }

    #[test]
    fn generic_modifier_codes_from_injected_input() {
        let c = cfg("ctrl+shift+a");
        let mut s = KeyboardState::new();
        s.on_key(vk::CONTROL, DOWN, &c);
        s.on_key(vk::SHIFT, DOWN, &c);
        assert_eq!(s.on_key(0x41, DOWN, &c), swallow(Some(Event::HotkeyDown)));
        assert_eq!(s.on_key(vk::SHIFT, UP, &c), masked_pass(Some(Event::HotkeyUp)));
        assert_eq!(s.on_key(0x41, UP, &c), swallow(None));
        assert_eq!(s.on_key(vk::CONTROL, UP, &c), masked_pass(None));
    }
}
