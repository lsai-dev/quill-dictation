/**
 * Checks a cleaned transcript before it can replace the original.
 *
 * Cleanup may only take things away (fillers, stutters, a corrected phrase) and fix
 * punctuation and capitals. Small models sometimes do more — answer a dictated
 * question, follow a dictated instruction, rephrase, translate, drop a "not", invent
 * a number. Every such output is rejected here and the original transcript is used.
 * The checks are deliberately strict: a false alarm costs a little polish; a false
 * pass could put words in your mouth.
 */

export interface GuardResult {
  ok: boolean;
  /** The tidied output when accepted; the original otherwise. */
  text: string;
  changed: boolean;
  reason?:
    | 'empty'
    | 'assistant'
    | 'added'
    | 'rewritten'
    | 'dropped'
    | 'number'
    | 'negation'
    | 'term'
    | 'language'
    | 'runaway';
}

const CONTRACTIONS: [RegExp, string][] = [
  [/\bcan['’]t\b/g, 'can not'],
  [/\bcannot\b/g, 'can not'],
  [/\bwon['’]t\b/g, 'will not'],
  [/\bshan['’]t\b/g, 'shall not'],
  [/\bain['’]t\b/g, 'is not'],
  [/n['’]t\b/g, ' not'],
  [/['’]re\b/g, ' are'],
  [/['’]ve\b/g, ' have'],
  [/['’]ll\b/g, ' will'],
  [/['’]d\b/g, ' would'],
  [/\bi['’]m\b/g, 'i am'],
  [/\b(it|that|there|here|what|who|where|how|he|she|let)['’]s\b/g, '$1 is'],
  [/\bgonna\b/g, 'going to'],
  [/\bwanna\b/g, 'want to'],
  [/\bgotta\b/g, 'got to'],
  [/\bkinda\b/g, 'kind of'],
  [/\bsorta\b/g, 'sort of'],
  [/\bdunno\b/g, 'do not know'],
  [/['’]cause\b/g, 'because'],
  [/\bok\b/g, 'okay'],
];

const FILLERS = new Set([
  'um', 'umm', 'uh', 'uhh', 'er', 'erm', 'ah', 'eh', 'hmm', 'mm', 'mhm', 'like', 'so', 'well', 'basically', 'actually',
  'literally', 'right', 'okay', 'yeah', 'you', 'know', 'i', 'mean', 'just', 'este', 'pues', 'bueno', 'o', 'sea', 'digo',
  'vale', 'mira', 'oye', 'osea', 'tipo', 'wait', 'sorry', 'no', 'espera', 'perdón', 'perdon', 'scratch', 'that',
]);

/** Phrases a speaker uses to correct themselves. Their presence licenses removing the corrected part. */
const CORRECTION_CUE =
  /,\s*(?:sorry|perdón|perdon)\s*,|\b(?:no,? wait|wait,? no|no,? sorry|sorry,? no|i mean|scratch that|actually,? no|or rather|let me rephrase|correction|no,? espera|espera,? no|perdón|perdon|digo|mejor dicho|quiero decir|o sea,? no|no,? no)\b/i;

const NEGATIONS = /\b(?:not|no|never|nothing|nobody|none|nowhere|neither|nor|without|nunca|nada|nadie|ningun[oa]?|ningún|tampoco|ni|sin|jamás|jamas)\b/gi;

const ASSISTANT_OPENERS =
  /^(?:sure|certainly|of course|absolutely|here(?:['’]s| is| are)|i(?:['’]m| am) sorry|i can(?:not|['’]t)|as an ai|great question|the answer is|claro|por supuesto|aquí (?:está|tienes)|lo siento|no puedo)\b/i;

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  hundred: 100, thousand: 1000, million: 1e6, first: 1, second: 2, third: 3, fourth: 4, fifth: 5, half: 0.5,
  cero: 0, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciséis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19,
  veinte: 20, treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90,
  cien: 100, ciento: 100, mil: 1000, millón: 1e6, primero: 1, primera: 1, segundo: 2, segunda: 2, tercero: 3, tercera: 3,
};

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();

function canonicalWords(text: string): string[] {
  let t = text.toLowerCase().replace(/[’]/g, "'");
  for (const [re, rep] of CONTRACTIONS) t = t.replace(re, rep);
  return (fold(t).match(/[\p{L}\p{N}]+(?:['.][\p{L}\p{N}]+)*/gu) ?? []).map((w) => w.replace(/'/g, ''));
}

/** Every number the text mentions, as digits or words ("twenty five" → 25, "4:30" → 4, 30). */
function numbersIn(text: string): Set<number> {
  const set = new Set<number>();
  for (const d of text.match(/\d+(?:[.,]\d+)?/g) ?? []) {
    set.add(Number(d.replace(',', '.')));
    for (const part of d.split(/[.,]/)) set.add(Number(part));
  }
  const words = fold(text).match(/\p{L}+/gu) ?? [];
  let acc: number | null = null;
  let last: number | null = null;
  const flush = () => {
    if (acc !== null) set.add(acc);
    acc = null;
    last = null;
  };
  for (const w of words) {
    const v = NUMBER_WORDS[w] ?? spanishCompound(w);
    if (v === undefined) {
      if (w !== 'and' && w !== 'y') flush();
      continue;
    }
    set.add(v);
    if (acc === null) acc = v;
    else if (v >= 100) acc = acc * v;
    else if (last !== null && last >= 20 && last % 10 === 0 && v < 10) acc += v;
    else {
      flush();
      acc = v;
    }
    last = v;
  }
  flush();
  return set;
}

const isNumberWord = (w: string) => NUMBER_WORDS[w] !== undefined || spanishCompound(w) !== undefined;

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

function spanishCompound(w: string): number | undefined {
  // veintiuno … veintinueve
  const m = w.match(/^veinti(\p{L}+)$/u);
  if (m) {
    const u = NUMBER_WORDS[m[1] === 'un' ? 'uno' : m[1]];
    if (u !== undefined && u < 10) return 20 + u;
  }
  return undefined;
}

/** Tokens that must survive cleanup verbatim: identifiers, acronyms, versions, addresses. */
function protectedTerms(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\s+/)) {
    const w = raw.replace(/^[("'“‘[]+|[)"'”’\].,;:!?…]+$/g, '');
    if (w.length < 2) continue;
    const technical =
      /[a-z][A-Z]/.test(w) || // camelCase, iPhone
      /^[A-Z]{2,}s?$/.test(w) || // API, NASA, URLs
      (/\d/.test(w) && /\p{L}/u.test(w)) || // Q3, v2, 4K
      /[_@/\\#]/.test(w) || // user_id, @name, a/b
      /\p{L}\.\p{L}/u.test(w); // file.ts, example.com
    if (technical) out.push(w);
  }
  return out;
}

const EN_HINTS = new Set(['the', 'and', 'is', 'are', 'to', 'of', 'it', 'that', 'this', 'you', 'we', 'i', 'with', 'for', 'have', 'be', 'not', 'what', 'can']);
const ES_HINTS = new Set(['el', 'la', 'los', 'las', 'que', 'de', 'y', 'es', 'en', 'un', 'una', 'por', 'para', 'con', 'no', 'se', 'lo', 'está', 'pero', 'como']);

/** "en", "es", or null when the text is too short or mixed to tell. */
export function guessLanguage(text: string): 'en' | 'es' | null {
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (words.length < 4) return null;
  let en = 0;
  let es = 0;
  for (const w of words) {
    if (EN_HINTS.has(w)) en++;
    if (ES_HINTS.has(w)) es++;
  }
  if (en >= 2 && en >= es * 2.5) return 'en';
  if (es >= 2 && es >= en * 2.5) return 'es';
  return null;
}

/** Removes the wrappers small models sometimes put around an answer. */
export function tidyOutput(output: string): string {
  let t = output.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<\/?transcript>/gi, '');
  t = t.replace(/^\s*(?:cleaned(?: text| transcript)?|output|texto limpio)\s*:\s*/i, '');
  t = t.trim();
  const q = t.match(/^(["“'`])([\s\S]*)(["”'`])$/);
  if (q && !/["“”]/.test(q[2])) t = q[2].trim();
  return t.replace(/\s*\n+\s*/g, ' ').replace(/[ \t]{2,}/g, ' ');
}

export function acceptCleanup(original: string, output: string): GuardResult {
  const reject = (reason: GuardResult['reason']): GuardResult => ({ ok: false, text: original, changed: false, reason });
  const text = tidyOutput(output);
  if (!text || !/[\p{L}\p{N}]/u.test(text)) return reject('empty');

  const inWords = canonicalWords(original);
  const outWords = canonicalWords(text);
  if (outWords.join(' ') === inWords.join(' ')) return { ok: true, text, changed: text !== original };

  const corrected = CORRECTION_CUE.test(original);
  if (ASSISTANT_OPENERS.test(text) && !ASSISTANT_OPENERS.test(original.trim())) return reject('assistant');
  if (outWords.length > inWords.length * 3 + 20) return reject('runaway');

  // Nothing new: every word of the output must come from the transcript.
  const inSet = new Set(inWords);
  const novel = outWords.filter((w) => !inSet.has(w) && !/^\d+$/.test(w) && !isNumberWord(w));
  // A new word is only tolerated as a spelling variant of a spoken one ("towards" → "toward").
  const unexplained = novel.filter((w) => w.length > 3 && !inWords.some((x) => editDistance(x, w) <= (w.length > 6 ? 2 : 1)));
  if (unexplained.length || novel.length > Math.max(1, Math.floor(outWords.length * 0.06))) return reject('added');
  if (outWords.length > inWords.length + Math.max(2, Math.ceil(inWords.length * 0.08))) return reject('added');

  // Numbers: never invented.
  const inNums = numbersIn(original);
  for (const n of numbersIn(text)) if (!inNums.has(n)) return reject('number');

  // Negations: never lost (beyond the "no" in "no, wait") and never added.
  const negations = (s: string) => (canonicalWords(s).join(' ').match(NEGATIONS) ?? []).length;
  const negOut = negations(text);
  if (negOut < negations(original.replace(new RegExp(CORRECTION_CUE.source, 'gi'), ' ')) - (corrected ? 1 : 0)) return reject('negation');
  if (negOut > negations(original)) return reject('negation');

  // Identifiers and acronyms: kept verbatim.
  const terms = protectedTerms(original);
  const missing = terms.filter((t) => !text.includes(t));
  if (missing.length > (corrected ? 1 : 0)) return reject('term');

  // Language: never translated.
  const li = guessLanguage(original);
  const lo = guessLanguage(text);
  if (li && lo && li !== lo) return reject('language');

  // Nothing important lost: cleanup removes fillers and corrected phrases, not content.
  const content = inWords.filter((w) => w.length >= 3 && !FILLERS.has(w) && !isNumberWord(w));
  if (content.length >= 3) {
    const outSet = new Set(outWords);
    const kept = content.filter((w) => outSet.has(w)).length / content.length;
    if (kept < (corrected ? 0.55 : 0.8)) return reject('dropped');
  }
  if (inWords.length >= 8 && outWords.length < inWords.length * (corrected ? 0.35 : 0.5)) return reject('dropped');

  // Order is part of meaning: the kept words must appear in the same order.
  if (orderScore(inWords, outWords) < 0.85) return reject('rewritten');

  return { ok: true, text, changed: true };
}

/** Fraction of output words that appear in the input in increasing order (longest common subsequence). */
function orderScore(a: string[], b: string[]): number {
  if (!b.length) return 1;
  const m = a.length;
  const n = b.length;
  let prev = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    const cur = new Array<number>(n + 1).fill(0);
    for (let j = 1; j <= n; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev = cur;
  }
  const common = b.filter((w) => a.includes(w)).length;
  return common ? prev[n] / common : 1;
}
