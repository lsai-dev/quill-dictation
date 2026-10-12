import type { CleanupModelSpec } from './types';

const MB = 1000 * 1000;
const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/**
 * Small language models Quill can run locally to polish a transcript (GGUF, run by
 * llama.cpp). Curated for faithful cleanup — removing fillers, fixing punctuation,
 * resolving clear spoken corrections — rather than rewriting. The research behind
 * this list, with sources and which figures are measured versus estimated, is in
 * docs/cleanup-models.md.
 *
 * `quality` is a relative 0–100 ranking derived from the published third-party
 * evaluations; `memoryBytes` is an estimate of the loaded working set (weights,
 * a 4096-token context and compute buffers) used for fit checks.
 */
export const CLEANUP_MODELS: CleanupModelSpec[] = [
  {
    id: 's1-mini',
    name: 'S1-mini',
    maker: 'Superwhisper',
    params: 0.6e9,
    architecture: 'dense',
    format: 's1',
    languages: ['en'],
    license: 'Apache 2.0 with a naming clause',
    licenseUrl: 'https://huggingface.co/superwhisper/s1-mini-GGUF/blob/main/LICENSE',
    repo: 'superwhisper/s1-mini-GGUF',
    file: 's1-mini-q4_k_m.gguf',
    sizeBytes: 462 * MiB,
    memoryBytes: 900 * MiB,
    quality: 80,
    blurb: 'A tiny specialist trained only to tidy dictation. English.',
  },
  {
    id: 'qwen3.5-2b',
    name: 'Qwen3.5 2B',
    maker: 'Qwen',
    params: 2.3e9,
    architecture: 'hybrid',
    format: 'qwen',
    languages: 'all',
    license: 'Apache 2.0',
    licenseUrl: 'https://huggingface.co/Qwen/Qwen3.5-2B/blob/main/LICENSE',
    repo: 'unsloth/Qwen3.5-2B-GGUF',
    file: 'Qwen3.5-2B-Q4_K_M.gguf',
    sizeBytes: 1300 * MB,
    memoryBytes: 1.6 * GiB,
    quality: 78,
    blurb: 'Light and multilingual. A good fit for machines with less memory.',
  },
  {
    id: 'granite-4.0-micro',
    name: 'Granite 4.0 Micro',
    maker: 'IBM',
    params: 3.4e9,
    architecture: 'dense',
    format: 'granite',
    languages: ['en', 'de', 'es', 'fr', 'ja', 'pt', 'ar', 'cs', 'it', 'ko', 'nl', 'zh'],
    license: 'Apache 2.0',
    licenseUrl: 'https://huggingface.co/ibm-granite/granite-4.0-micro/blob/main/LICENSE',
    repo: 'ibm-granite/granite-4.0-micro-GGUF',
    file: 'granite-4.0-micro-Q4_K_M.gguf',
    sizeBytes: 2100 * MB,
    memoryBytes: 2.8 * GiB,
    quality: 86,
    blurb: 'Careful and quick on a processor. Twelve languages, including Spanish.',
  },
  {
    id: 'qwen3.5-4b',
    name: 'Qwen3.5 4B',
    maker: 'Qwen',
    params: 4.5e9,
    architecture: 'hybrid',
    format: 'qwen',
    languages: 'all',
    license: 'Apache 2.0',
    licenseUrl: 'https://huggingface.co/Qwen/Qwen3.5-4B/blob/main/LICENSE',
    repo: 'unsloth/Qwen3.5-4B-GGUF',
    file: 'Qwen3.5-4B-Q4_K_M.gguf',
    sizeBytes: 2740 * MB,
    memoryBytes: 3.1 * GiB,
    quality: 90,
    blurb: 'The most careful editor here. Best with a graphics card.',
  },
];

export const CLEANUP_HOST = 'https://huggingface.co/';

export function cleanupModelById(id: string | null | undefined): CleanupModelSpec | undefined {
  return CLEANUP_MODELS.find((m) => m.id === id);
}

export function cleanupModelUrl(m: CleanupModelSpec): string {
  return `${CLEANUP_HOST}${m.repo}/resolve/main/${m.file}`;
}

/** Whether a model polishes text in `language` (an ISO code; "auto" needs a multilingual model). */
export function cleanupSupports(m: CleanupModelSpec, language: string): boolean {
  if (m.languages === 'all') return true;
  if (language === 'auto') return m.languages.length > 1;
  return m.languages.includes(language);
}

export function cleanupModelsForLanguage(language: string): CleanupModelSpec[] {
  return CLEANUP_MODELS.filter((m) => cleanupSupports(m, language));
}
