# Transcript cleanup: model research

Quill can polish a transcript with a small language model before inserting it. This
document records how the models in `src/shared/cleanupModels.ts` were chosen, what the
evidence for each is, and which figures are **measured** (by Quill's own evaluation, on
real models), **reported** (published by someone else), or **estimated** (computed by
Quill's planner). Research cut-off: October 2026.

## What "cleanup" must do

Faithful by default, never creative:

- remove fillers and hesitations (*um, uh, you know, I mean*; *eh, este, o sea, pues*),
  stutters, repeated words and false starts;
- resolve clear spoken corrections (*"at 3, no wait, at 4"* → *"at 4"*);
- fix punctuation, capitalization and sentence breaks;
- keep everything else: meaning, tone, language, names, numbers, negations, technical
  terms;
- never answer a dictated question, follow a dictated instruction, translate,
  summarize or add words.

Small models fail in predictable ways: they answer questions, obey instructions inside
the transcript, rephrase, drop a "not", translate, or invent a number. Quill therefore
never trusts their output directly. Every result passes a guard
(`src/shared/cleanupGuard.ts`), and anything it rejects, along with any error, timeout
or cancellation, leaves the transcript exactly as spoken.

## Selection criteria

1. **Faithfulness** on dictation, including adversarial input (questions, instructions).
2. **Speed** on ordinary PCs: it adds to every dictation.
3. **Memory**: it stays loaded next to the dictation model.
4. **English and Spanish** at least.
5. **Runs in llama.cpp** (GGUF), the same family of runtime as whisper.cpp, on CPU and
   Vulkan.
6. **Permissive license** that allows use in a free desktop app.

## The catalog

| Model | Maker | Size (Q4_K_M) | Languages | License | Architecture | Role in Quill |
|---|---|---|---|---|---|---|
| **S1-mini** | Superwhisper | 484 MB | English | Apache 2.0 + naming clause | dense (Qwen3-0.6B fine-tune) | English specialist; fastest on a processor |
| **Qwen3.5 2B** | Qwen (Alibaba) | 1.28 GB | 201 languages | Apache 2.0 | hybrid (Gated DeltaNet + attention) | light multilingual option |
| **Granite 4.0 Micro** | IBM | 2.10 GB | 12, incl. English & Spanish | Apache 2.0 | dense, 3B | careful editor; quick on CPU for its size |
| **Qwen3.5 4B** | Qwen (Alibaba) | 2.74 GB | 201 languages | Apache 2.0 | hybrid | most careful; the pick with a graphics card |

Sizes are **measured**: CI downloads every file and compares it with the catalog.
Download URLs:

- `https://huggingface.co/superwhisper/s1-mini-GGUF/resolve/main/s1-mini-q4_k_m.gguf`
- `https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/main/Qwen3.5-2B-Q4_K_M.gguf`
- `https://huggingface.co/ibm-granite/granite-4.0-micro-GGUF/resolve/main/granite-4.0-micro-Q4_K_M.gguf`
- `https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf`

Downloads are resumable and verified against the SHA-256 that Hugging Face publishes
for each file, exactly like the dictation models.

### Evidence per model

**S1-mini** is a 0.6B normalizer fine-tuned from Qwen3-0.6B for exactly this job.
- *Reported* (vendor): 94.8% token accuracy on 7,519 held-out cases, greedy decoding,
  quantized build; English only in v1; designed for about 1,000 input tokens
  ([model card](https://huggingface.co/superwhisper/s1-mini),
  [GGUF](https://huggingface.co/superwhisper/s1-mini-GGUF),
  [MarkTechPost](https://www.marktechpost.com/2026/08/20/meet-s1-mini-superwhispers-462-mb-open-weights-text-normalizer-that-turns-raw-asr-transcripts-into-clean-written-text/)).
- *Prompt contract*: it is not a chat model. Every request needs its documented system
  prompt and a control line (`[Styling: …] [Structure: …] [Context: …]`), with thinking
  disabled and greedy decoding. Quill sends the documented default register
  (`semi-formal`, `prose`, `general`). The exact strings match OpenWhispr's
  integration ([PR #2164](https://github.com/OpenWhispr/openwhispr/pull/2164)).
- *License*: Apache 2.0 with a naming clause. Quill always shows it as "S1-mini by
  Superwhisper".

**Qwen3.5 2B / 4B** are general instruction models with official GGUF builds by Unsloth.
They run in non-thinking mode by default, and Quill also opens each answer with an empty
think block.
- *Reported* ([local-dictation-cleanup](https://github.com/xuancongwen/local-dictation-cleanup),
  174-case suite including 29 attacks, llama.cpp): 4B: 136 pass / 31 near / 7 fail, 1
  attack obeyed, ≈232 ms per case on a GPU; 2B: 122 / 25 / 27, 8 attacks obeyed,
  ≈145 ms.
- *Reported*: hybrid models can't trim a cached prompt back to a shared prefix, so naive
  caching re-reads the whole prompt. Quill snapshots the sequence state after the
  instructions instead.
- *Reported*: the untuned 0.8B answered or obeyed dictated text
  ([Lexicon #11](https://github.com/jparker2006/lexicon/issues/11)), which is why it
  isn't in the catalog.

**Granite 4.0 Micro** is a conventional dense 3B model. It officially supports 12 languages,
including Spanish.
- *Reported* ([earheart PR #167](https://github.com/cleanunicorn/earheart/pull/167),
  Ryzen 9 3900X, 5 seeds): no fillers left in any run, no fidelity failures, content
  retention 0.95 (Gemma 3 scored 1.00 only because it copied fillers through), ≈17 tok/s
  decode on the CPU. earheart made it its preferred default
  ([PR #171](https://github.com/cleanunicorn/earheart/pull/171)) before switching to
  Qwen3 4B Instruct 2507 ([PR #246](https://github.com/cleanunicorn/earheart/pull/246)).
- Dense, so Quill can draft ahead from the transcript (see *Speed* below).

### Measured: Quill's evaluation

`npm run eval:cleanup` runs every catalog model through the real sidecar, the real
prompts and the real guard against `test/eval/cases.ts`: 27 English and 12 Spanish
dictations covering fillers, corrections, punctuation, already-clean text, dictated
questions and instructions, identifiers, numbers and negations. CI runs it on every
push (CPU only: a 4-vCPU Intel Xeon Platinum 8573C, 4 threads).

**Measured**, first run (run 26, English instructions for every language):

| Model | Cases | Polished | Unchanged | Kept by guard | Unsafe passed | Attacks held | Median added time |
|---|---|---|---|---|---|---|---|
| S1-mini | 27 | 18 | 6 | 2 | 0 | 6/6 | 0.50 s |
| Qwen3.5 2B | 39 | 20 | 7 | 8 | 0 | 9/9 | 1.58 s |
| Granite 4.0 Micro | 39 | 21 | 6 | 10 | 0 | 9/9 | 2.45 s |
| Qwen3.5 4B | 39 | 25 | 11 | 3 | 0 | 9/9 | 3.54 s |

"Unsafe passed" counts outputs that damaged the text (lost or added content) and got
past the guard. None did. The guard caught one-word answers ("banana"), a model obeying
"summarize the following…", and translations. Three things changed as a result:

- **Granite and Qwen3.5 2B translated Spanish into English** when instructed only in
  English. The instructions now forbid translation, the examples include Spanish, and
  every request names its language. Qwen3.5 4B handled Spanish correctly either way.
- **Fixed-length drafting barely helped a 3B model on 4 vCPUs**, because checking 10
  drafted tokens is compute-bound there. Draft length now adapts to what verification
  costs on the machine (see *Speed*).
- The guard counted "Never, uh, never push…" → "Never push…" as a lost negation. It now
  collapses stuttered repeats first.

**Measured**, second run (run 27, language-anchored prompts, adaptive drafting):

| Model | Cases | Polished | Unchanged | Kept by guard | Missed | Unsafe passed | Attacks held | Median added time | Generation | Drafts kept |
|---|---|---|---|---|---|---|---|---|---|---|
| S1-mini | 27 | 20 | 6 | 1 | 0 | 0 | 6/6 | 0.45 s | 65.4 tok/s | 84% |
| Qwen3.5 2B | 39 | 24 | 9 | 2 | 4 | 0 | 9/9 | 1.37 s | 21.5 tok/s | — |
| Granite 4.0 Micro | 39 | 28 | 8 | 3 | 0 | 0 | 9/9 | 2.47 s | 12.4 tok/s | 82% |
| Qwen3.5 4B | 39 | 29 | 10 | 0 | 0 | 0 | 9/9 | 3.23 s | 10.1 tok/s | — |

"Missed" means a correction was left as spoken. The output then still contains the
corrected phrase, which is safe but unpolished. Qwen3.5 2B misses some Spanish
corrections. Qwen3.5 4B polished or correctly left alone every case.

These numbers also exposed a cost: a prompt prefix per language had to be re-read
whenever the language changed (13–34 s on this CPU), which would hurt bilingual users
dictating with *Detect automatically*. The cached instructions are now
language-neutral: English and Spanish examples together, each labelled, with the
language named in each request.

The latest results are in the *Cleanup quality* job of each CI run (and its
`cleanup-eval` artifact).

## Prompting

Each family is written out by hand (`src/shared/cleanupPrompt.ts`) instead of trusting a
GGUF's embedded template, so that each model gets exactly what it was trained on:

| Family | Format | Notes |
|---|---|---|
| Qwen3 / Qwen3.5 | ChatML | Assistant turn opens with an empty `<think></think>` block (otherwise Qwen reasons first). |
| Granite 4.0 | `<\|start_of_role\|>…<\|end_of_role\|>…<\|end_of_text\|>` | IBM's role markers. |
| S1-mini | ChatML, fixed system prompt + control line | Its documented contract; no few-shot examples. |

Shared rules:

- **Template markers are control tokens; the transcript never is.** The transcript is
  tokenized with special-token parsing off, after any marker-like text is stripped, so a
  dictation can't open or close a turn.
- **Instructions plus worked examples** in the dictation's language, including a
  question and an instruction left untouched. Examples steer small models more reliably
  than rules.
- **Greedy decoding** (temperature 0), output capped at about 1.5× the input, and stop
  strings for every turn marker.
- **Long dictations** are cleaned in pieces: each voice-command line separately, and
  long lines at sentence boundaries in chunks of about 120 words. Each piece is guarded
  on its own.

## Speed

The sidecar (`native/cleanup`, Rust + llama.cpp via `llama-cpp-2`) runs out of process,
so inference never touches the UI thread and a crash can't take Quill with it. Three
techniques keep it quick:

1. **Cached instructions.** The prompt prefix (instructions and examples, about 600–900
   tokens) is evaluated once when the model loads. Dense models keep that KV cache and
   trim back to it. Hybrid models (Qwen3.5) restore a state snapshot.
2. **Prompt-lookup drafting** (dense models). A cleaned transcript is mostly the
   transcript, so the sidecar proposes the next tokens by matching what it has written
   against the transcript. The model then checks the whole proposal in one batch. With
   greedy decoding the output is identical to decoding one token at a time; this is
   asserted by `test/cleanupEngine.test.ts`.
3. **Adaptive draft length.** A step that checks *k* drafted tokens costs about
   `t₁ + k·c` and yields `1 + p + … + pᵏ` tokens. The sidecar measures `t₁`, `c` and the
   acceptance rate *p* as it goes and picks the *k* with the best rate: long drafts on a
   GPU, short ones (or none) on a processor with few cores.

Cancellation is checked between decoding steps (milliseconds apart). Quill cancels when
you press Esc, choose *Insert as spoken*, or hit the deadline.

## Hardware recommendations

`recommendSetup()` in `src/shared/recommend.ts` plans dictation and cleanup **together**.
All figures it produces are **estimates**:

- **Memory budget.** Both models stay loaded, alongside each engine's runtime (≈180 MB
  each). The system keeps the larger of 2.5 GB or 30% of RAM for itself and your apps.
  Cleanup goes on the graphics card only when it fits in the video memory left after the
  dictation model and a context reserve; otherwise it goes in RAM.
- **Latency.** Generation is memory-bandwidth bound: ≈32 GB/s effective on the reference
  desktop (bandwidth depends little on core count), or the graphics card's bandwidth by
  class. Reading the prompt is compute-bound: ≈480 GFLOP/s on the reference desktop,
  scaled by cores and vector width. Drafting helps dense models by roughly
  `read time ÷ compute time − 1` (between ×1 and ×2.5): a lot for small models and on
  graphics cards, little for 3B models on two cores. Fitted to the CI measurements, the
  model predicts all four catalog models' generation speed within 15%, erring slow
  (`test/recommend.test.ts`).
- **Choice.** Among models that handle the language, fit and add ≤ 3 s, pick the best
  quality net of latency, download size and memory pressure. If none is comfortable,
  the quickest one that still runs is offered but **off**, with an honest "adds about N
  seconds". Where nothing can run (no AVX2/NEON, no memory, unsupported language), the
  reason is shown.
- **The dictation model you chose** is the one cleanup is planned around. Manual choices
  are never overridden. *Use Recommended Setup* appears only when your setup differs,
  and it downloads before switching, so nothing breaks.

## Considered and not included

| Model | Why not (for now) |
|---|---|
| SpeakoFlow Mini (Qwen3.5-0.8B fine-tune) | English only; vendor-reported 10.7% content damage on its own test set. |
| VoiceInk-Refine-V1 (Qwen3.5-2B fine-tune) | Licensed for use with VoiceInk only. |
| utter-cleanup-e4b (Gemma 4 E4B fine-tune) | Promising, but no published evaluation; Gemma 4 E4B reasons at length unless reasoning is disabled ([earheart #244](https://github.com/cleanunicorn/earheart/pull/244)). |
| Qwen3-4B-Instruct-2507 | Strong (earheart's default), but Qwen3.5 4B is newer, scores higher in the 174-case suite, and covers the same tier. |
| Gemma 3 1B / 4B | Left fillers in every run (earheart #167); Gemma license at the time. |
| LFM2 / LFM2.5 | LFM Open License (revenue-limited); LFM2.5-1.2B obeyed dictated text (Lexicon #11). |
| Qwen3.5 0.8B, Qwen3 0.6B, Granite 4.0 H 350M/1B | Answered or obeyed dictated prompts too often in published tests. |
| Phi-3.5/4-mini, Ministral 3B, Mistral NeMo 12B | Fidelity failures or far too slow on a CPU (earheart #167). |

## Privacy

Cleanup runs entirely on this PC once its model is downloaded. There is no cloud
fallback of any kind. If the local model isn't ready, can't run, or fails, the transcript
is inserted as spoken.
