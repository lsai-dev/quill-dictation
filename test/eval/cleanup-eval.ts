/**
 * Measures transcript cleanup with real models: quality against the evaluation set
 * (test/eval/cases.ts), the guard's verdicts, and speed on this machine's processor.
 *
 *   npm run eval:cleanup -- --bin native/target-cleanup/release/quill-cleanup --dir models [--download] [--only s1-mini,granite-4.0-micro]
 *
 * Every output passes through the same guard Quill uses, so the result is what a
 * user would get. Exits non-zero if any model fails to load, or if an output that
 * breaks a case's rules got past the guard (an unsafe result reaching a document).
 */
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { acceptCleanup } from '../../src/shared/cleanupGuard';
import { CLEANUP_MODELS, cleanupModelUrl, cleanupSupports } from '../../src/shared/cleanupModels';
import { buildCleanupPrompt, cleanupPrefix } from '../../src/shared/cleanupPrompt';
import { LineProcess } from '../../src/main/lineProcess';
import type { CleanupModelSpec } from '../../src/shared/types';
import { CASES, type EvalCase } from './cases';

const arg = (name: string, d?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const bin = arg('bin', 'native/target-cleanup/release/quill-cleanup')!;
const dir = arg('dir', 'models')!;
const only = arg('only')?.split(',');
const out = arg('out', 'cleanup-eval.json')!;
const download = process.argv.includes('--download');
const threads = Number(arg('threads', String(Math.min(8, availableParallelism()))));

interface Cleaned {
  text: string;
  stop: string;
  prompt_tokens: number;
  cached_tokens: number;
  generated_tokens: number;
  drafted_tokens: number;
  accepted_tokens: number;
  prompt_ms: number;
  generate_ms: number;
  process_ms: number;
}

type Status = 'polished' | 'unchanged' | 'kept' | 'missed' | 'UNSAFE';

interface CaseResult {
  id: string;
  kind: EvalCase['kind'];
  status: Status;
  exact: boolean | null;
  guard: string | null;
  raw: string;
  final: string;
  ms: number;
  genMs: number;
  promptMs: number;
  promptTokens: number;
  tokens: number;
  drafted: number;
  accepted: number;
  violations: string[];
}

async function fetchModel(m: CleanupModelSpec): Promise<string> {
  const path = join(dir, m.file);
  if (existsSync(path)) return path;
  if (!download) throw new Error(`${path} is missing (pass --download)`);
  mkdirSync(dir, { recursive: true });
  const url = cleanupModelUrl(m);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  const size = Number(res.headers.get('content-length'));
  const drift = size ? (size - m.sizeBytes) / m.sizeBytes : NaN;
  console.log(`↓ ${m.id}: ${url} (${(size / 1e6).toFixed(0)} MB; catalog says ${(m.sizeBytes / 1e6).toFixed(0)} MB, ${(drift * 100).toFixed(1)}% off)`);
  const tmp = path + '.partial';
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
  renameSync(tmp, path);
  return path;
}

function check(c: EvalCase, final: string): string[] {
  const v: string[] = [];
  const lower = final.toLowerCase();
  for (const m of c.must ?? []) if (!lower.includes(m.toLowerCase())) v.push(`missing “${m}”`);
  for (const n of c.never ?? []) {
    const hit = n.startsWith('^') ? lower.trimStart().startsWith(n.slice(1).toLowerCase()) : lower.includes(n.toLowerCase());
    if (hit) v.push(`contains “${n}”`);
  }
  return v;
}

const norm = (s: string) => s.replace(/[’]/g, "'").replace(/\s+/g, ' ').trim();

async function evaluate(m: CleanupModelSpec) {
  const path = await fetchModel(m);
  const fileBytes = statSync(path).size;
  const p = new LineProcess(`cleanup:${m.id}`, bin, []);
  await p.start(30000);
  const t0 = Date.now();
  await p.request('load', { model: path, threads, ctx: 4096 }, undefined, 300000);
  const loadMs = Date.now() - t0;
  const t1 = Date.now();
  // As in the app with "Detect automatically": both languages' instructions ready.
  for (const lang of ['en', 'es']) if (cleanupSupports(m, lang)) await p.request('prime', { prefix: cleanupPrefix(m, lang) }, undefined, 600000);
  const primeMs = Date.now() - t1;
  const results: CaseResult[] = [];
  for (const c of CASES.filter((x) => cleanupSupports(m, x.lang))) {
    const pr = buildCleanupPrompt(m.format, c.input, c.lang);
    const r = await p.request<Cleaned>('clean', { prefix: pr.prefix, prompt: pr.prompt, lookup: c.input, max_tokens: pr.maxTokens, stop: pr.stop }, undefined, 300000);
    const verdict = r.stop === 'limit' ? { ok: false, text: c.input, changed: false, reason: 'runaway' as const } : acceptCleanup(c.input, r.text);
    const final = verdict.ok ? verdict.text : c.input;
    const violations = check(c, final);
    // Unsafe means the cleanup did the damage: it lost something the speaker said, or
    // added something they didn't. A rule the spoken text already broke (an unresolved
    // correction left as spoken) is a missed polish, never a safety problem.
    const before = new Set(check(c, c.input));
    const introduced = violations.filter((v) => !before.has(v));
    let status: Status;
    if (!verdict.ok) status = violations.length ? 'missed' : 'kept';
    else if (introduced.length) status = 'UNSAFE';
    else if (violations.length) status = 'missed';
    else status = verdict.changed ? 'polished' : 'unchanged';
    results.push({
      id: c.id,
      kind: c.kind,
      status,
      exact: c.ideal ? norm(final) === norm(c.ideal) : null,
      guard: verdict.ok ? null : verdict.reason ?? 'rejected',
      raw: r.text,
      final,
      ms: r.process_ms,
      genMs: r.generate_ms,
      promptMs: r.prompt_ms,
      promptTokens: r.prompt_tokens - r.cached_tokens,
      tokens: r.generated_tokens,
      drafted: r.drafted_tokens,
      accepted: r.accepted_tokens,
      violations,
    });
    const mark = { polished: '✓', unchanged: '=', kept: '·', missed: '○', UNSAFE: '✗' }[status];
    console.log(`  ${mark} ${c.id.padEnd(14)} ${String(r.process_ms).padStart(5)} ms  ${status}${verdict.ok ? '' : ` (guard: ${verdict.reason})`}${violations.length ? ` — ${violations.join(', ')}` : ''}`);
    if (status !== 'polished' && status !== 'unchanged') console.log(`      raw: ${JSON.stringify(r.text).slice(0, 220)}`);
  }
  await p.stop();
  const times = results.map((r) => r.ms).sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  const tokens = results.reduce((a, r) => a + r.tokens, 0);
  const genMs = results.reduce((a, r) => a + r.genMs, 0);
  const drafted = results.reduce((a, r) => a + r.drafted, 0);
  const accepted = results.reduce((a, r) => a + r.accepted, 0);
  const count = (s: Status) => results.filter((r) => r.status === s).length;
  const promptTok = results.reduce((a, r) => a + r.promptTokens, 0);
  const promptMs = results.reduce((a, r) => a + r.promptMs, 0);
  console.log(`  timing: prompt ${Math.round(promptTok / results.length)} new tokens at ${Math.round((promptTok / Math.max(1, promptMs)) * 1000)} tok/s · ` +
    `output ${Math.round(tokens / results.length)} tokens at ${Math.round((tokens / Math.max(1, genMs)) * 10000) / 10} tok/s · drafts ${accepted}/${drafted} kept`);
  const exact = results.filter((r) => r.exact !== null);
  return {
    model: m.id,
    fileBytes,
    loadMs,
    primeMs,
    cases: results.length,
    polished: count('polished'),
    unchanged: count('unchanged'),
    kept: count('kept'),
    missed: count('missed'),
    unsafe: count('UNSAFE'),
    exact: `${exact.filter((r) => r.exact).length}/${exact.length}`,
    attacksHeld: results.filter((r) => r.kind === 'attack' && r.status !== 'UNSAFE').length + '/' + results.filter((r) => r.kind === 'attack').length,
    medianMs: median,
    tokensPerSec: Math.round((tokens / Math.max(1, genMs)) * 1000 * 10) / 10,
    draftAcceptance: drafted ? Math.round((accepted / drafted) * 100) / 100 : null,
    results,
  };
}

async function main() {
  console.log(`cleanup eval: ${cpus()[0]?.model} · ${availableParallelism()} threads · ${(totalmem() / 2 ** 30).toFixed(1)} GB · using ${threads} threads`);
  const models = CLEANUP_MODELS.filter((m) => !only || only.includes(m.id));
  const summaries = [];
  let failed = false;
  for (const m of models) {
    console.log(`\n▸ ${m.name} (${m.id})`);
    try {
      summaries.push(await evaluate(m));
    } catch (e) {
      failed = true;
      console.log(`  ✗ ${(e as Error).message}`);
    }
  }
  console.log('\n| Model | Cases | Polished | Unchanged | Kept (guard) | Missed | Unsafe | Exact | Attacks held | Median | Tok/s | Draft acc. | Load |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const s of summaries) {
    console.log(`| ${s.model} | ${s.cases} | ${s.polished} | ${s.unchanged} | ${s.kept} | ${s.missed} | ${s.unsafe} | ${s.exact} | ${s.attacksHeld} | ${s.medianMs} ms | ${s.tokensPerSec} | ${s.draftAcceptance ?? '—'} | ${s.loadMs + s.primeMs} ms |`);
    if (s.unsafe) failed = true;
  }
  writeFileSync(out, JSON.stringify({ cpu: cpus()[0]?.model, threads, summaries }, null, 2));
  console.log(`\nwrote ${out}`);
  process.exit(failed ? 1 : 0);
}

void main();
