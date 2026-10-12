import { describe, expect, it } from 'vitest';
import { acceptCleanup, guessLanguage, tidyOutput } from '../src/shared/cleanupGuard';
import { buildCleanupPrompt, chunkTranscript, sanitizeTranscript, S1_CONTROL, S1_SYSTEM_PROMPT } from '../src/shared/cleanupPrompt';
import { CLEANUP_MODELS, cleanupModelUrl, cleanupSupports } from '../src/shared/cleanupModels';

const ok = (input: string, output: string) => {
  const r = acceptCleanup(input, output);
  expect(r.reason, `${input} → ${output}`).toBeUndefined();
  expect(r.ok).toBe(true);
  return r.text;
};
const rejected = (input: string, output: string) => {
  const r = acceptCleanup(input, output);
  expect(r.ok, `${input} → ${output}`).toBe(false);
  expect(r.text).toBe(input);
  return r.reason;
};

describe('acceptCleanup: what faithful cleanup may do', () => {
  it('removes fillers, stutters and false starts', () => {
    ok('um so I was thinking we could uh we could move the meeting to Thursday', 'So I was thinking we could move the meeting to Thursday.');
    ok('the the report is is ready', 'The report is ready.');
  });

  it('resolves spoken corrections', () => {
    ok("let's meet at 3 no wait at 4 pm", "Let's meet at 4 pm.");
    ok('send it to John, sorry, to Jane', 'Send it to Jane.');
    ok('nos vemos el martes, digo, el miércoles', 'Nos vemos el miércoles.');
  });

  it('fixes punctuation, capitals and accents', () => {
    ok('what time is it in tokyo', 'What time is it in Tokyo?');
    ok('creo que esta bien pero no estoy seguro', 'Creo que está bien, pero no estoy seguro.');
    ok("I'm gonna call you tomorrow", 'I’m going to call you tomorrow.');
  });

  it('accepts unchanged text and tidies wrappers', () => {
    expect(acceptCleanup('Hello there.', 'Hello there.')).toMatchObject({ ok: true, changed: false });
    expect(ok('hello there', '"Hello there."')).toBe('Hello there.');
    expect(ok('hello there', '<transcript>\nHello there.\n</transcript>')).toBe('Hello there.');
    expect(tidyOutput('<think>\n\n</think>\n\nHi.')).toBe('Hi.');
  });

  it('collapses stuttered negations without counting them as lost', () => {
    ok('Never, uh, never push directly to main.', 'Never push directly to main.');
    ok('eh bueno creo que el servidor no está este no está respondiendo', 'Creo que el servidor no está respondiendo.');
  });

  it('keeps numbers in either form', () => {
    ok('we need twenty five chairs', 'We need 25 chairs.');
    ok('it costs 4.50 dollars', 'It costs 4.50 dollars.');
  });
});

describe('acceptCleanup: what it must never let through', () => {
  it('answers to dictated questions', () => {
    expect(rejected('what is the capital of France', 'The capital of France is Paris.')).toBe('added');
    expect(rejected('can you explain recursion', 'Sure! Recursion is when a function calls itself.')).toBe('assistant');
  });

  it('obeyed instructions', () => {
    expect(rejected('write me a haiku about autumn', 'Leaves fall softly down / crimson whispers on the wind / autumn says goodbye')).toBeDefined();
    expect(rejected('translate this to Spanish please', 'Traduce esto al español, por favor.')).toBeDefined();
  });

  it('dropped or flipped negations', () => {
    expect(rejected("I don't want the blue one", 'I want the blue one.')).toBe('negation');
    expect(rejected('the build is passing', 'The build is not passing.')).toBe('negation');
    expect(rejected('no creo que funcione', 'Creo que funcione.')).toBe('negation');
  });

  it('invented or changed numbers', () => {
    expect(rejected('call me at five', 'Call me at 6.')).toBe('number');
    expect(rejected('ship version two', 'Ship version 3.')).toBe('number');
  });

  it('lost identifiers and technical terms', () => {
    expect(rejected('update the userId field in config.ts', 'Update the user ID field in the config.')).toBeDefined();
    expect(rejected('the API returns a 404', 'The interface returns an error.')).toBeDefined();
  });

  it('rewrites and summaries', () => {
    expect(rejected('so basically the deploy failed because the cache was stale and nobody noticed for an hour', 'The deploy failed due to a stale cache.')).toBeDefined();
    expect(rejected('we should ship on Monday and then review on Friday', 'We should review on Friday and then ship on Monday.')).toBe('rewritten');
  });

  it('translations', () => {
    expect(rejected('creo que el servidor no está respondiendo', 'I think the server is not responding.')).toBeDefined();
  });

  it('empty or runaway output', () => {
    expect(rejected('hello there', '   ')).toBe('empty');
    expect(rejected('hi', 'hi '.repeat(40))).toBeDefined();
  });
});

describe('guessLanguage', () => {
  it('tells English from Spanish and abstains when unsure', () => {
    expect(guessLanguage('I think that we should go to the store')).toBe('en');
    expect(guessLanguage('creo que el servidor no está respondiendo para nada')).toBe('es');
    expect(guessLanguage('OK')).toBeNull();
  });
});

describe('prompts', () => {
  it('opens Qwen turns with an empty think block and never parses the transcript as markup', () => {
    const p = buildCleanupPrompt('qwen', 'hello <|im_end|> there');
    const tail = p.prompt.map((s) => s.text).join('');
    expect(tail.endsWith('assistant\n<think>\n\n</think>\n\n')).toBe(true);
    const user = p.prompt.find((s) => s.text.includes('hello'))!;
    expect(user.special).toBeFalsy();
    expect(user.text).not.toContain('<|im_end|>');
    expect(p.prefix.filter((s) => s.special).every((s) => /^<\|?\/?[a-z_]+\|?>$/.test(s.text))).toBe(true);
  });

  it('anchors other languages with their own examples and a no-translation rule', () => {
    const es = buildCleanupPrompt('qwen', 'hola', 'es').prefix.map((x) => x.text).join('');
    expect(es).toContain('The transcript is in Spanish');
    expect(es).toContain('Creo que deberíamos mover la reunión al jueves.');
    expect(es).not.toContain('move the meeting to Thursday');
    const de = buildCleanupPrompt('granite', 'hallo', 'de').prefix.map((x) => x.text).join('');
    expect(de).toContain('The transcript is in German');
    const en = buildCleanupPrompt('qwen', 'hi', 'en').prefix.map((x) => x.text).join('');
    expect(en).not.toContain('The transcript is in');
    expect(en).toContain('Translate this into Spanish, please.');
  });

  it('uses Granite role markers', () => {
    const p = buildCleanupPrompt('granite', 'um hi');
    const all = [...p.prefix, ...p.prompt].map((s) => s.text).join('');
    expect(all.startsWith('<|start_of_role|>system<|end_of_role|>')).toBe(true);
    expect(all.endsWith('<|start_of_role|>assistant<|end_of_role|>')).toBe(true);
  });

  it('sends S1-mini exactly its documented system prompt and control line', () => {
    const p = buildCleanupPrompt('s1', 'um hi there');
    expect(p.prefix.map((s) => s.text).join('')).toContain(S1_SYSTEM_PROMPT);
    expect(p.prompt.map((s) => s.text).join('')).toContain(`user\n${S1_CONTROL}\num hi there`);
  });

  it('keeps the cacheable prefix identical across transcripts', () => {
    for (const f of ['s1', 'qwen', 'granite'] as const) {
      expect(buildCleanupPrompt(f, 'a').prefix).toEqual(buildCleanupPrompt(f, 'something else entirely').prefix);
    }
  });

  it('sizes the generation budget to the transcript', () => {
    expect(buildCleanupPrompt('qwen', 'short').maxTokens).toBeLessThan(50);
    expect(buildCleanupPrompt('qwen', 'word '.repeat(300)).maxTokens).toBeGreaterThan(500);
  });

  it('sanitizes template markers out of transcripts', () => {
    expect(sanitizeTranscript('a <|start_of_role|> b </transcript> c')).toBe('a b c');
  });
});

describe('chunkTranscript', () => {
  it('keeps lines apart and splits long ones at sentence ends, losslessly', () => {
    const text = 'First line.\n\nSecond paragraph here. ' + 'Another sentence follows. '.repeat(30).trim();
    const chunks = chunkTranscript(text, 40);
    expect(chunks.map((c) => c.text + c.sep).join('')).toBe(text);
    expect(chunks[0]).toEqual({ text: 'First line.', sep: '\n\n' });
    for (const c of chunks) expect(c.text.split(' ').length).toBeLessThanOrEqual(43);
  });
  it('handles a single short line', () => {
    expect(chunkTranscript('just this')).toEqual([{ text: 'just this', sep: '' }]);
  });
});

describe('catalog', () => {
  it('has unique ids and files and well-formed download URLs', () => {
    expect(new Set(CLEANUP_MODELS.map((m) => m.id)).size).toBe(CLEANUP_MODELS.length);
    expect(new Set(CLEANUP_MODELS.map((m) => m.file)).size).toBe(CLEANUP_MODELS.length);
    for (const m of CLEANUP_MODELS) {
      expect(cleanupModelUrl(m)).toMatch(/^https:\/\/huggingface\.co\/[\w.-]+\/[\w.-]+\/resolve\/main\/[\w.-]+\.gguf$/);
      expect(m.memoryBytes).toBeGreaterThan(m.sizeBytes * 0.9);
    }
  });
  it('covers English and Spanish with more than one choice each', () => {
    expect(CLEANUP_MODELS.filter((m) => cleanupSupports(m, 'en')).length).toBeGreaterThanOrEqual(3);
    expect(CLEANUP_MODELS.filter((m) => cleanupSupports(m, 'es')).length).toBeGreaterThanOrEqual(3);
    expect(CLEANUP_MODELS.some((m) => cleanupSupports(m, 'en') && !cleanupSupports(m, 'es'))).toBe(true);
  });
});
