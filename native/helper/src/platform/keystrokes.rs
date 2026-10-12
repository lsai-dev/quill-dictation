//! Text-to-keystroke planning for `type` (pure logic, unit-tested on every OS).

#![cfg_attr(not(windows), allow(dead_code))]

use crate::hotkey::vk;

/// One synthesized keystroke for `type`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Keystroke {
    /// A UTF-16 code unit sent with KEYEVENTF_UNICODE.
    Unicode(u16),
    /// A virtual key (Enter, Tab).
    Virtual(u16),
}

impl Keystroke {
    pub fn is_high_surrogate(self) -> bool {
        matches!(self, Keystroke::Unicode(u) if (0xD800..0xDC00).contains(&u))
    }
}

/// Converts text into keystrokes: `\n`, `\r\n` and lone `\r` become Enter, `\t` becomes Tab,
/// other control characters are dropped, everything else is sent as UTF-16 code units
/// (characters outside the BMP become surrogate pairs, i.e. two units).
pub fn keystrokes(text: &str) -> Vec<Keystroke> {
    let mut out = Vec::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                out.push(Keystroke::Virtual(vk::RETURN));
            }
            '\n' => out.push(Keystroke::Virtual(vk::RETURN)),
            '\t' => out.push(Keystroke::Virtual(vk::TAB)),
            c if c.is_control() => {}
            c => {
                let mut buf = [0u16; 2];
                out.extend(c.encode_utf16(&mut buf).iter().map(|&u| Keystroke::Unicode(u)));
            }
        }
    }
    out
}

/// Splits keystrokes into batches of at most `max` without separating surrogate pairs.
pub fn batches(keys: &[Keystroke], max: usize) -> Vec<&[Keystroke]> {
    let max = max.max(2);
    let mut out = Vec::new();
    let mut rest = keys;
    while !rest.is_empty() {
        let mut n = rest.len().min(max);
        if n < rest.len() && rest[n - 1].is_high_surrogate() {
            n -= 1;
        }
        let (head, tail) = rest.split_at(n);
        out.push(head);
        rest = tail;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::Keystroke::{Unicode as U, Virtual as V};
    use super::*;

    #[test]
    fn plain_text_and_newlines() {
        assert_eq!(keystrokes("Hi\nyo"), vec![U(72), U(105), V(vk::RETURN), U(121), U(111)]);
        assert_eq!(keystrokes("a\r\nb\rc"), vec![U(97), V(vk::RETURN), U(98), V(vk::RETURN), U(99)]);
        assert_eq!(keystrokes("\t"), vec![V(vk::TAB)]);
        assert_eq!(keystrokes(""), vec![]);
    }

    #[test]
    fn control_characters_are_dropped() {
        assert_eq!(keystrokes("a\u{7}\u{8}\u{1b}\u{7f}\u{85}b"), vec![U(97), U(98)]);
    }

    #[test]
    fn non_bmp_characters_become_surrogate_pairs() {
        assert_eq!(keystrokes("é😀"), vec![U(0xE9), U(0xD83D), U(0xDE00)]);
        assert!(U(0xD83D).is_high_surrogate());
        assert!(!U(0xDE00).is_high_surrogate());
    }

    #[test]
    fn batches_never_split_a_surrogate_pair() {
        let keys = keystrokes("ab😀cd😀");
        // [a, b, hi, lo, c, d, hi, lo]
        let b = batches(&keys, 3);
        // [a b] [hi lo c] [d hi lo]
        assert_eq!(b.iter().map(|x| x.len()).collect::<Vec<_>>(), vec![2, 3, 3]);
        assert_eq!(b.concat(), keys);
        for batch in &b {
            assert!(!batch.last().unwrap().is_high_surrogate());
        }
        assert_eq!(batches(&keys, 64).len(), 1);
        assert!(batches(&[], 8).is_empty());
    }
}
