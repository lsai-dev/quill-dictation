// Writes a tiny llama-architecture GGUF model with random weights: a few hundred KB,
// loads in milliseconds, and exercises the cleanup engine's real code paths (prompt
// caching, drafting, rewinding, cancellation). Its output is gibberish by design.
//
//   node test/fixtures/tiny-gguf.mjs out.gguf
import { writeFileSync } from 'node:fs';

const T = { U32: 4, I32: 5, F32: 6, BOOL: 7, STRING: 8, ARRAY: 9 };

export function tinyGguf({ seed = 7, layers = 2, embd = 64, heads = 4, kvHeads = 2, ff = 128 } = {}) {
  const specials = ['<unk>', '<s>', '</s>', '<|im_start|>', '<|im_end|>', '<think>', '</think>', '<|start_of_role|>', '<|end_of_role|>', '<|end_of_text|>'];
  const types = [2, 3, 3, 3, 3, 4, 4, 3, 3, 3]; // UNKNOWN, CONTROL…, USER_DEFINED
  const tokens = [...specials];
  for (let b = 0; b < 256; b++) {
    tokens.push(`<0x${b.toString(16).toUpperCase().padStart(2, '0')}>`);
    types.push(6); // BYTE
  }
  const vocab = tokens.length;

  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  };
  const tensor = (name, ne, scale) => {
    const n = ne.reduce((a, b) => a * b, 1);
    const data = new Float32Array(n);
    for (let i = 0; i < n; i++) data[i] = scale === 'ones' ? 1 : rand() * scale;
    return { name, ne, data };
  };
  const headDim = embd / heads;
  // Only printable, non-space ASCII can win the argmax (other rows are zero), so the
  // model's text re-tokenizes to the same tokens — which lets a test feed a model its
  // own output as a draft. With no end-of-turn in reach, generation runs to the limit.
  const output = tensor('output.weight', [embd, vocab], 2);
  for (let t = 0; t < vocab; t++) {
    const byte = t - specials.length;
    if (byte < 0x21 || byte > 0x7e) output.data.fill(0, t * embd, (t + 1) * embd);
  }
  const tensors = [tensor('token_embd.weight', [embd, vocab], 2), tensor('output_norm.weight', [embd], 'ones'), output];
  for (let i = 0; i < layers; i++) {
    tensors.push(
      tensor(`blk.${i}.attn_norm.weight`, [embd], 'ones'),
      tensor(`blk.${i}.attn_q.weight`, [embd, embd], 0.3),
      tensor(`blk.${i}.attn_k.weight`, [embd, kvHeads * headDim], 0.3),
      tensor(`blk.${i}.attn_v.weight`, [embd, kvHeads * headDim], 0.3),
      tensor(`blk.${i}.attn_output.weight`, [embd, embd], 0.3),
      tensor(`blk.${i}.ffn_norm.weight`, [embd], 'ones'),
      tensor(`blk.${i}.ffn_gate.weight`, [embd, ff], 0.3),
      tensor(`blk.${i}.ffn_up.weight`, [embd, ff], 0.3),
      tensor(`blk.${i}.ffn_down.weight`, [ff, embd], 0.3),
    );
  }

  const kv = [
    ['general.architecture', T.STRING, 'llama'],
    ['general.name', T.STRING, 'quill-tiny-test'],
    ['general.alignment', T.U32, 32],
    ['llama.context_length', T.U32, 4096],
    ['llama.embedding_length', T.U32, embd],
    ['llama.block_count', T.U32, layers],
    ['llama.feed_forward_length', T.U32, ff],
    ['llama.attention.head_count', T.U32, heads],
    ['llama.attention.head_count_kv', T.U32, kvHeads],
    ['llama.attention.layer_norm_rms_epsilon', T.F32, 1e-5],
    ['llama.rope.dimension_count', T.U32, headDim],
    ['tokenizer.ggml.model', T.STRING, 'llama'],
    ['tokenizer.ggml.tokens', T.ARRAY, [T.STRING, tokens]],
    ['tokenizer.ggml.scores', T.ARRAY, [T.F32, tokens.map(() => 0)]],
    ['tokenizer.ggml.token_type', T.ARRAY, [T.I32, types]],
    ['tokenizer.ggml.bos_token_id', T.U32, 1],
    ['tokenizer.ggml.eos_token_id', T.U32, 2],
    ['tokenizer.ggml.unknown_token_id', T.U32, 0],
    ['tokenizer.ggml.add_bos_token', T.BOOL, true],
  ];

  const parts = [];
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); parts.push(b); };
  const i32 = (v) => { const b = Buffer.alloc(4); b.writeInt32LE(v); parts.push(b); };
  const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); parts.push(b); };
  const f32 = (v) => { const b = Buffer.alloc(4); b.writeFloatLE(v); parts.push(b); };
  const str = (v) => { const b = Buffer.from(v, 'utf8'); u64(b.length); parts.push(b); };
  const value = (type, v) => {
    if (type === T.U32) u32(v);
    else if (type === T.I32) i32(v);
    else if (type === T.F32) f32(v);
    else if (type === T.BOOL) parts.push(Buffer.from([v ? 1 : 0]));
    else if (type === T.STRING) str(v);
    else if (type === T.ARRAY) {
      const [et, items] = v;
      u32(et);
      u64(items.length);
      for (const it of items) value(et, it);
    }
  };

  parts.push(Buffer.from('GGUF'));
  u32(3);
  u64(tensors.length);
  u64(kv.length);
  for (const [k, type, v] of kv) {
    str(k);
    u32(type);
    value(type, v);
  }
  let offset = 0;
  const align = (n) => Math.ceil(n / 32) * 32;
  for (const t of tensors) {
    str(t.name);
    u32(t.ne.length);
    for (const d of t.ne) u64(d);
    u32(0); // F32
    u64(offset);
    offset = align(offset + t.data.byteLength);
  }
  let head = Buffer.concat(parts);
  head = Buffer.concat([head, Buffer.alloc(align(head.length) - head.length)]);
  const body = Buffer.alloc(offset);
  let at = 0;
  for (const t of tensors) {
    Buffer.from(t.data.buffer).copy(body, at);
    at = align(at + t.data.byteLength);
  }
  return Buffer.concat([head, body]);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const out = process.argv[2] ?? 'tiny.gguf';
  writeFileSync(out, tinyGguf());
  console.log(`wrote ${out}`);
}
