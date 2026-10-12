import type { ModelSpec } from './types';

const MiB = 1024 * 1024;

/**
 * Whisper models Quill can run locally (ggml format, served by whisper.cpp's
 * model repository). Accuracy and cost figures are relative, calibrated from
 * whisper.cpp benchmarks and published WER results — good enough to rank and
 * estimate, never shown to users as raw numbers.
 */
export const MODELS: ModelSpec[] = [
  {
    id: 'tiny.en', family: 'tiny', name: 'Tiny', englishOnly: true, quant: 'f16',
    file: 'ggml-tiny.en.bin', sizeBytes: 75 * MiB, memoryBytes: 273 * MiB,
    accuracy: 62, computeCost: 1, decodeCost: 1,
    blurb: 'Instant and featherweight. Best for short notes on older PCs.',
  },
  {
    id: 'base.en', family: 'base', name: 'Base', englishOnly: true, quant: 'f16',
    file: 'ggml-base.en.bin', sizeBytes: 142 * MiB, memoryBytes: 388 * MiB,
    accuracy: 72, computeCost: 2.2, decodeCost: 1.5,
    blurb: 'Quick and light, with dependable everyday accuracy.',
  },
  {
    id: 'base.en-q5_1', family: 'base', name: 'Base · Compact', englishOnly: true, quant: 'q5_1',
    file: 'ggml-base.en-q5_1.bin', sizeBytes: 57 * MiB, memoryBytes: 260 * MiB,
    accuracy: 71, computeCost: 2.0, decodeCost: 1.3,
    blurb: 'Base, compressed to use the least memory possible.',
  },
  {
    id: 'small.en', family: 'small', name: 'Small', englishOnly: true, quant: 'f16',
    file: 'ggml-small.en.bin', sizeBytes: 466 * MiB, memoryBytes: 852 * MiB,
    accuracy: 84, computeCost: 7, decodeCost: 4,
    blurb: 'A big step up in accuracy that still runs well on most CPUs.',
  },
  {
    id: 'small.en-q5_1', family: 'small', name: 'Small · Compact', englishOnly: true, quant: 'q5_1',
    file: 'ggml-small.en-q5_1.bin', sizeBytes: 181 * MiB, memoryBytes: 480 * MiB,
    accuracy: 83, computeCost: 6.2, decodeCost: 3.4,
    blurb: 'Small’s accuracy at roughly half the memory.',
  },
  // Multilingual variants for dictating in languages other than English.
  {
    id: 'base', family: 'base', name: 'Base · Multilingual', englishOnly: false, quant: 'f16',
    file: 'ggml-base.bin', sizeBytes: 142 * MiB, memoryBytes: 388 * MiB,
    accuracy: 69, computeCost: 2.2, decodeCost: 1.5,
    blurb: 'Quick and light, in 99 languages.',
  },
  {
    id: 'small', family: 'small', name: 'Small · Multilingual', englishOnly: false, quant: 'f16',
    file: 'ggml-small.bin', sizeBytes: 466 * MiB, memoryBytes: 852 * MiB,
    accuracy: 81, computeCost: 7, decodeCost: 4,
    blurb: 'Balanced accuracy across 99 languages.',
  },
  {
    id: 'medium-q5_0', family: 'medium', name: 'Medium · Multilingual', englishOnly: false, quant: 'q5_0',
    file: 'ggml-medium-q5_0.bin', sizeBytes: 514 * MiB, memoryBytes: 1000 * MiB,
    accuracy: 87, computeCost: 18, decodeCost: 9,
    blurb: 'Strong accuracy across languages on a capable CPU.',
  },
  {
    id: 'medium.en-q5_0', family: 'medium', name: 'Medium · Compact', englishOnly: true, quant: 'q5_0',
    file: 'ggml-medium.en-q5_0.bin', sizeBytes: 514 * MiB, memoryBytes: 1000 * MiB,
    accuracy: 89, computeCost: 18, decodeCost: 9,
    blurb: 'Excellent accuracy for long, technical dictation.',
  },
  {
    id: 'large-v3-turbo-q5_0', family: 'large-v3-turbo', name: 'Large Turbo · Compact', englishOnly: false, quant: 'q5_0',
    file: 'ggml-large-v3-turbo-q5_0.bin', sizeBytes: 547 * MiB, memoryBytes: 1100 * MiB,
    accuracy: 93, computeCost: 30, decodeCost: 3.2,
    blurb: 'Near-flagship accuracy in 99 languages, compressed.',
  },
  {
    id: 'large-v3-turbo', family: 'large-v3-turbo', name: 'Large Turbo', englishOnly: false, quant: 'f16',
    file: 'ggml-large-v3-turbo.bin', sizeBytes: 1549 * MiB, memoryBytes: 2100 * MiB,
    accuracy: 94, computeCost: 34, decodeCost: 3.6,
    blurb: 'Flagship accuracy with a fast decoder. Shines on a graphics card.',
  },
  {
    id: 'large-v3-q5_0', family: 'large-v3', name: 'Large · Compact', englishOnly: false, quant: 'q5_0',
    file: 'ggml-large-v3-q5_0.bin', sizeBytes: 1031 * MiB, memoryBytes: 1900 * MiB,
    accuracy: 95, computeCost: 36, decodeCost: 16,
    blurb: 'The most accurate model, compressed for smaller graphics cards.',
  },
  {
    id: 'large-v3', family: 'large-v3', name: 'Large', englishOnly: false, quant: 'f16',
    file: 'ggml-large-v3.bin', sizeBytes: 2952 * MiB, memoryBytes: 3900 * MiB,
    accuracy: 96, computeCost: 40, decodeCost: 18,
    blurb: 'The most accurate model available. Wants a capable graphics card.',
  },
];

export const MODEL_HOST = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';

export function modelById(id: string | null | undefined): ModelSpec | undefined {
  return MODELS.find((m) => m.id === id);
}

export function modelUrl(m: ModelSpec): string {
  return MODEL_HOST + m.file;
}

/** Models suitable for a language setting. English can use every model; other languages need multilingual ones. */
export function modelsForLanguage(language: string): ModelSpec[] {
  const english = language === 'en';
  return MODELS.filter((m) => (english ? true : !m.englishOnly));
}

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(n >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}
