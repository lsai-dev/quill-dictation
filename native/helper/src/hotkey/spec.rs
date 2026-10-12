//! Hotkey specification strings.
//!
//! Grammar: `+`-separated, case-insensitive, surrounding whitespace ignored.
//! * modifiers: `win`, `ctrl`, `alt`, `shift` (each at most once, any order)
//! * exactly one main key: `space`, `a`-`z`, `0`-`9`, `f1`-`f24`, `enter`, `tab`,
//!   `capslock`, `insert`, `pause`, `scrolllock`, `backquote`
//!
//! Keys that produce text (`space`, letters, digits, `enter`, `tab`, `backquote`) require
//! at least one modifier: as a bare hotkey they would be swallowed on every keystroke.

use super::{modifiers, vk};
use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HotkeySpec {
    /// Required modifiers ([`modifiers`] bits); extra held modifiers prevent a match.
    pub mods: u8,
    /// Virtual-key code of the main key (always < 256).
    pub vk: u16,
}

impl Default for HotkeySpec {
    /// `win+space`.
    fn default() -> Self {
        HotkeySpec { mods: modifiers::WIN, vk: vk::SPACE }
    }
}

impl HotkeySpec {
    pub fn parse(spec: &str) -> Result<Self, String> {
        let mut mods = 0u8;
        let mut main: Option<u16> = None;
        if spec.trim().is_empty() {
            return Err("hotkey is empty".into());
        }
        for raw in spec.split('+') {
            let part = raw.trim().to_ascii_lowercase();
            if part.is_empty() {
                return Err(format!("invalid hotkey '{spec}': empty key name"));
            }
            if let Some(bit) = modifier_from_name(&part) {
                if mods & bit != 0 {
                    return Err(format!("invalid hotkey '{spec}': '{part}' appears twice"));
                }
                mods |= bit;
                continue;
            }
            let code = key_from_name(&part)
                .ok_or_else(|| format!("invalid hotkey '{spec}': unknown key '{}'", raw.trim()))?;
            if main.replace(code).is_some() {
                return Err(format!("invalid hotkey '{spec}': more than one non-modifier key"));
            }
        }
        let vk = main.ok_or_else(|| format!("invalid hotkey '{spec}': no main key (e.g. 'space')"))?;
        if mods == 0 && produces_text(vk) {
            return Err(format!("invalid hotkey '{spec}': this key needs at least one modifier"));
        }
        Ok(HotkeySpec { mods, vk })
    }
}

impl fmt::Display for HotkeySpec {
    /// Canonical form, e.g. `ctrl+shift+f9`.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (bit, name) in [
            (modifiers::WIN, "win"),
            (modifiers::CTRL, "ctrl"),
            (modifiers::ALT, "alt"),
            (modifiers::SHIFT, "shift"),
        ] {
            if self.mods & bit != 0 {
                write!(f, "{name}+")?;
            }
        }
        match key_name(self.vk) {
            Some(name) => f.write_str(&name),
            None => write!(f, "vk{:#04x}", self.vk),
        }
    }
}

fn modifier_from_name(name: &str) -> Option<u8> {
    match name {
        "win" => Some(modifiers::WIN),
        "ctrl" => Some(modifiers::CTRL),
        "alt" => Some(modifiers::ALT),
        "shift" => Some(modifiers::SHIFT),
        _ => None,
    }
}

fn key_from_name(name: &str) -> Option<u16> {
    let named = match name {
        "space" => Some(vk::SPACE),
        "enter" => Some(vk::RETURN),
        "tab" => Some(vk::TAB),
        "capslock" => Some(vk::CAPITAL),
        "insert" => Some(vk::INSERT),
        "pause" => Some(vk::PAUSE),
        "scrolllock" => Some(vk::SCROLL),
        "backquote" => Some(vk::OEM_3),
        _ => None,
    };
    if named.is_some() {
        return named;
    }
    let bytes = name.as_bytes();
    match bytes {
        [c @ b'a'..=b'z'] => Some(vk::KEY_A + u16::from(c - b'a')),
        [d @ b'0'..=b'9'] => Some(vk::KEY_0 + u16::from(d - b'0')),
        [b'f', rest @ ..] if !rest.is_empty() && rest.len() <= 2 && rest[0] != b'0' => {
            let n: u16 = std::str::from_utf8(rest).ok()?.parse().ok()?;
            (1..=24).contains(&n).then(|| vk::F1 + n - 1)
        }
        _ => None,
    }
}

fn key_name(code: u16) -> Option<String> {
    let name = match code {
        vk::SPACE => "space",
        vk::RETURN => "enter",
        vk::TAB => "tab",
        vk::CAPITAL => "capslock",
        vk::INSERT => "insert",
        vk::PAUSE => "pause",
        vk::SCROLL => "scrolllock",
        vk::OEM_3 => "backquote",
        c if (vk::KEY_A..vk::KEY_A + 26).contains(&c) => {
            return Some(char::from(b'a' + (c - vk::KEY_A) as u8).to_string())
        }
        c if (vk::KEY_0..vk::KEY_0 + 10).contains(&c) => {
            return Some(char::from(b'0' + (c - vk::KEY_0) as u8).to_string())
        }
        c if (vk::F1..vk::F1 + 24).contains(&c) => return Some(format!("f{}", c - vk::F1 + 1)),
        _ => return None,
    };
    Some(name.to_string())
}

fn produces_text(code: u16) -> bool {
    matches!(code, vk::SPACE | vk::RETURN | vk::TAB | vk::OEM_3)
        || (vk::KEY_A..vk::KEY_A + 26).contains(&code)
        || (vk::KEY_0..vk::KEY_0 + 10).contains(&code)
}

#[cfg(test)]
mod tests {
    use super::*;
    use modifiers::{ALT, CTRL, SHIFT, WIN};

    fn p(s: &str) -> HotkeySpec {
        HotkeySpec::parse(s).unwrap_or_else(|e| panic!("{s:?} should parse: {e}"))
    }

    fn err(s: &str) -> String {
        HotkeySpec::parse(s).expect_err(&format!("{s:?} should be rejected"))
    }

    #[test]
    fn default_is_win_space() {
        assert_eq!(HotkeySpec::default(), p("win+space"));
        assert_eq!(HotkeySpec::default().to_string(), "win+space");
    }

    #[test]
    fn parses_modifiers_in_any_order_and_case() {
        assert_eq!(p("win+space"), HotkeySpec { mods: WIN, vk: vk::SPACE });
        assert_eq!(p("Ctrl+Shift+A"), HotkeySpec { mods: CTRL | SHIFT, vk: 0x41 });
        assert_eq!(p("shift+ctrl+a"), p("ctrl+shift+a"));
        assert_eq!(p(" alt + win + z "), HotkeySpec { mods: ALT | WIN, vk: 0x5A });
        assert_eq!(p("WIN+CTRL+ALT+SHIFT+F12").mods, WIN | CTRL | ALT | SHIFT);
    }

    #[test]
    fn parses_every_main_key() {
        assert_eq!(p("ctrl+0").vk, 0x30);
        assert_eq!(p("ctrl+9").vk, 0x39);
        assert_eq!(p("ctrl+a").vk, 0x41);
        assert_eq!(p("ctrl+z").vk, 0x5A);
        assert_eq!(p("f1").vk, 0x70);
        assert_eq!(p("f9").vk, 0x78);
        assert_eq!(p("f10").vk, 0x79);
        assert_eq!(p("f24").vk, 0x87);
        assert_eq!(p("ctrl+enter").vk, 0x0D);
        assert_eq!(p("alt+tab").vk, 0x09);
        assert_eq!(p("capslock").vk, 0x14);
        assert_eq!(p("insert").vk, 0x2D);
        assert_eq!(p("pause").vk, 0x13);
        assert_eq!(p("scrolllock").vk, 0x91);
        assert_eq!(p("ctrl+backquote").vk, 0xC0);
        assert_eq!(p("F5").mods, 0);
    }

    #[test]
    fn rejects_malformed_specs() {
        assert!(err("").contains("empty"));
        assert!(err("   ").contains("empty"));
        assert!(err("win+").contains("empty key name"));
        assert!(err("+space").contains("empty key name"));
        assert!(err("win++space").contains("empty key name"));
        assert!(err("win").contains("no main key"));
        assert!(err("ctrl+shift").contains("no main key"));
        assert!(err("win+win+space").contains("twice"));
        assert!(err("ctrl+a+b").contains("more than one"));
        assert!(err("win+space+enter").contains("more than one"));
        assert!(err("win+escape").contains("unknown key"));
        assert!(err("hyper+space").contains("unknown key"));
        assert!(err("f0").contains("unknown key"));
        assert!(err("f25").contains("unknown key"));
        assert!(err("f01").contains("unknown key"));
        assert!(err("ctrl+aa").contains("unknown key"));
        assert!(err("ctrl+é").contains("unknown key"));
        assert!(err("control+space").contains("unknown key"));
    }

    #[test]
    fn text_keys_need_a_modifier() {
        for s in ["space", "a", "7", "enter", "tab", "backquote"] {
            assert!(err(s).contains("modifier"), "{s}");
        }
        for s in ["f9", "capslock", "insert", "pause", "scrolllock"] {
            p(s);
        }
    }

    #[test]
    fn canonical_display_round_trips() {
        for s in ["win+space", "ctrl+shift+a", "win+ctrl+alt+shift+f24", "alt+backquote", "f1", "ctrl+0", "capslock"] {
            assert_eq!(p(s).to_string(), s);
            assert_eq!(p(&p(s).to_string()), p(s));
        }
        assert_eq!(p("Shift+Ctrl+Win+X").to_string(), "win+ctrl+shift+x");
    }
}
