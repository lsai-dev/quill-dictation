//! Prompt-lookup drafting for speculative decoding.
//!
//! A cleaned transcript is mostly the transcript itself: the model copies long runs of
//! it and edits a few places. So the transcript is an excellent draft. After each step
//! we find where the text generated so far lines up with the transcript and propose the
//! tokens that follow there; the model then checks the whole proposal in a single batch
//! and keeps the prefix it agrees with. With greedy decoding the result is identical to
//! decoding one token at a time, only faster.

/// Longest n-gram used to line the output up with the source.
const MAX_NGRAM: usize = 4;

/// Drafts continuations from a source token sequence.
pub struct Lookup<T> {
    source: Vec<T>,
    /// Where in `source` the output is believed to be (just after the last agreed draft).
    cursor: usize,
}

/// A proposed continuation: `tokens` are copied from `source[start..]`.
pub struct Draft<T> {
    pub start: usize,
    pub tokens: Vec<T>,
}

impl<T: Copy + PartialEq> Lookup<T> {
    pub fn new(source: Vec<T>) -> Self {
        Lookup { source, cursor: 0 }
    }

    /// Proposes up to `max` tokens that should follow `generated`, or an empty draft.
    ///
    /// The longest suffix of `generated` (up to [`MAX_NGRAM`] tokens) that occurs in the
    /// source decides where to copy from. Among several occurrences, the first one at or
    /// after the cursor wins, so the draft follows the transcript forward. A single-token
    /// match is too ambiguous to trust anywhere but ahead of the cursor.
    pub fn draft(&self, generated: &[T], max: usize) -> Draft<T> {
        let none = Draft { start: self.cursor, tokens: Vec::new() };
        if max == 0 || generated.is_empty() || self.source.is_empty() {
            return none;
        }
        for n in (1..=MAX_NGRAM.min(generated.len())).rev() {
            let key = &generated[generated.len() - n..];
            let mut ahead = None;
            let mut behind = None;
            for j in 0..self.source.len().saturating_sub(n) {
                if &self.source[j..j + n] != key {
                    continue;
                }
                let after = j + n;
                if after >= self.cursor {
                    ahead = Some(after);
                    break;
                }
                behind = Some(after);
            }
            let start = match (ahead, behind) {
                (Some(a), _) => a,
                (None, Some(b)) if n >= 2 => b,
                _ => continue,
            };
            let end = (start + max).min(self.source.len());
            if start < end {
                return Draft { start, tokens: self.source[start..end].to_vec() };
            }
        }
        none
    }

    /// Records that `accepted` tokens of a draft starting at `start` were kept.
    pub fn accept(&mut self, start: usize, accepted: usize) {
        self.cursor = (start + accepted).min(self.source.len());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn toks(s: &str) -> Vec<char> {
        s.chars().collect()
    }

    #[test]
    fn copies_the_source_forward() {
        let mut l = Lookup::new(toks("abcdefgh"));
        let d = l.draft(&toks("ab"), 3);
        assert_eq!(d.start, 2);
        assert_eq!(d.tokens, toks("cde"));
        l.accept(d.start, 3);
        let d = l.draft(&toks("abcde"), 8);
        assert_eq!(d.tokens, toks("fgh"));
    }

    #[test]
    fn realigns_after_an_edit() {
        // The output drops "um " from the source and carries on copying.
        let l = Lookup::new(toks("so um we should go now"));
        let d = l.draft(&toks("so we s"), 6);
        assert_eq!(d.tokens, toks("hould "));
    }

    #[test]
    fn prefers_the_occurrence_ahead_of_the_cursor() {
        let mut l = Lookup::new(toks("xab1 xab2"));
        l.accept(5, 0);
        let d = l.draft(&toks("zzxab"), 1);
        assert_eq!(d.tokens, toks("2"));
    }

    #[test]
    fn single_token_matches_only_count_ahead() {
        let mut l = Lookup::new(toks("abcabd"));
        l.accept(6, 0);
        assert!(l.draft(&toks("a"), 2).tokens.is_empty());
    }

    #[test]
    fn empty_inputs_draft_nothing() {
        let l: Lookup<char> = Lookup::new(Vec::new());
        assert!(l.draft(&toks("a"), 4).tokens.is_empty());
        let l = Lookup::new(toks("abc"));
        assert!(l.draft(&[], 4).tokens.is_empty());
        assert!(l.draft(&toks("a"), 0).tokens.is_empty());
    }
}
