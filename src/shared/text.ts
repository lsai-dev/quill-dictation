/**
 * Turning raw model output into text worth inserting.
 *
 * Whisper occasionally annotates non-speech ("[BLANK_AUDIO]", "(music)") and,
 * on near-silent input, hallucinates stock phrases from its training data
 * ("Thanks for watching!"). Quill strips both so nothing unexpected lands in
 * your document.
 */

const NON_SPEECH = /\((?:[^)]*\b(?:music|applause|laugh(?:s|ter|ing)?|noise|silence|inaudible|sigh(?:s|ing)?|cough(?:s|ing)?|background|static|wind|breath(?:ing|es)?|clap(?:s|ping)?|crowd|beep(?:s|ing)?|typing|click(?:s|ing)?|blank)\b[^)]*)\)/gi;

/** Phrases that are almost never intentional dictation. */
const ALWAYS_HALLUCINATED = [
  /subtitles? (?:by|provided by|created by)/i,
  /amara\.org/i,
  /thanks? (?:you )?for watching/i,
  /(?:please |don'?t forget to )?(?:like (?:and|&) )?subscribe/i,
  /transcribed by/i,
  /^\s*(?:\.|…|-+)\s*$/,
];

/** Phrases that are hallucinations only when there was barely any speech. */
const SHORT_HALLUCINATIONS = new Set(['you', 'thank you', 'thanks', 'bye', 'okay', 'so', 'uh', 'um', 'hmm', 'the end']);

export interface CleanOptions {
  voiceCommands?: boolean;
  /** Milliseconds of detected speech (from the VAD). */
  speechMs?: number;
}

export function cleanTranscript(raw: string, opts: CleanOptions = {}): string {
  let t = raw ?? '';
  t = t.replace(/\[[^\]]*\]/g, ' '); // [BLANK_AUDIO], [Music], [inaudible]
  t = t.replace(NON_SPEECH, ' ');
  t = t.replace(/[♪♫]+/g, ' ');
  t = t.replace(/\*[^*\n]{1,30}\*/g, ' '); // *laughs*
  t = t.replace(/[ \t ]+/g, ' ').trim();
  if (!t) return '';

  if (ALWAYS_HALLUCINATED.some((r) => r.test(t)) && t.split(/\s+/).length <= 10) return '';
  const norm = t.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, '').trim();
  if (SHORT_HALLUCINATIONS.has(norm) && (opts.speechMs ?? Infinity) < 450) return '';
  // Repetition loops ("I'm going to I'm going to I'm going to…") — collapse.
  t = collapseRepeats(t);

  if (opts.voiceCommands) t = applyVoiceCommands(t);
  return t.trim();
}

export function applyVoiceCommands(text: string): string {
  let t = text;
  const cmd = (word: string, out: string) => {
    // Absorb the punctuation Whisper wraps around a spoken command, but keep a
    // sentence's own full stop: "Hello. New paragraph. Next" → "Hello.\n\nNext".
    const re = new RegExp(`\\s*[,;:]?\\s*\\b${word}\\b[,.;:!?]?\\s*`, 'gi');
    t = t.replace(re, out);
  };
  cmd('new paragraph', '\n\n');
  cmd('new ?line', '\n');
  // Capitalise the first letter after a line break; tidy spaces around breaks.
  t = t.replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n(\p{Ll})/gu, (_, c: string) => '\n' + c.toUpperCase());
  return t.replace(/^\n+/, '');
}

function collapseRepeats(t: string): string {
  const words = t.split(' ');
  if (words.length < 9) return t;
  for (let n = 1; n <= 6; n++) {
    for (let i = 0; i + n * 3 <= words.length; i++) {
      const phrase = words.slice(i, i + n).join(' ').toLowerCase();
      let reps = 1;
      while (words.slice(i + reps * n, i + (reps + 1) * n).join(' ').toLowerCase() === phrase) reps++;
      if (reps >= 3) {
        words.splice(i + n, (reps - 1) * n);
        return collapseRepeats(words.join(' '));
      }
    }
  }
  return t;
}

export interface SpacingContext {
  /** True when inserting into the same window as the previous dictation. */
  sameTarget: boolean;
  /** Last character Quill inserted there, if known. */
  lastChar: string | null;
}

/** Add a leading space when continuing a previous dictation in the same place. */
export function smartSpace(text: string, ctx: SpacingContext): string {
  if (!text || !ctx.sameTarget || !ctx.lastChar) return text;
  if (/\s/.test(ctx.lastChar)) return text;
  if (/^[\s,.;:!?)\]}'"’”]/.test(text)) return text;
  return ' ' + text;
}
