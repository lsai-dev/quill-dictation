// Types shared by the main process, preload scripts and renderers.

export type HotkeyMode = 'auto' | 'toggle' | 'hold';
export type EnginePreference = 'auto' | 'gpu' | 'cpu';
export type MotionPreference = 'system' | 'reduced' | 'full';
export type InsertMethod = 'paste' | 'type';
export type RecommendationGoal = 'balanced' | 'accuracy' | 'speed' | 'memory';

export interface Settings {
  hotkey: string;               // e.g. "win+space"
  hotkeyMode: HotkeyMode;       // auto: tap to toggle, hold to talk
  modelId: string | null;       // null until the user (or onboarding) picks one
  engine: EnginePreference;
  language: string;             // "auto" or ISO code, e.g. "en"
  microphoneId: string;         // "default" or a MediaDeviceInfo.deviceId
  insertMethod: InsertMethod;
  restoreClipboard: boolean;
  smartSpacing: boolean;
  voiceCommands: boolean;       // "new line", "new paragraph"
  sounds: boolean;
  motion: MotionPreference;
  launchAtLogin: boolean;
  onboarded: boolean;
  customVocabulary: string;     // biases recognition toward names and jargon
  cleanup: boolean;             // polish transcripts with a local language model
  cleanupModelId: string | null;
}

export const DEFAULT_SETTINGS: Settings = {
  hotkey: 'win+space',
  hotkeyMode: 'auto',
  modelId: null,
  engine: 'auto',
  language: 'en',
  microphoneId: 'default',
  insertMethod: 'paste',
  restoreClipboard: true,
  smartSpacing: true,
  voiceCommands: true,
  sounds: true,
  motion: 'system',
  launchAtLogin: true,
  onboarded: false,
  customVocabulary: '',
  cleanup: false,
  cleanupModelId: null,
};

export interface CpuInfo {
  brand: string;
  vendor: string;
  physicalCores: number;
  logicalCores: number;
  avx2: boolean;
  avx512: boolean;
  fma: boolean;
  f16c: boolean;
  neon: boolean;
}

export interface GpuInfo {
  name: string;
  vendor: 'nvidia' | 'amd' | 'intel' | 'apple' | 'qualcomm' | 'other';
  vramBytes: number;            // dedicated video memory (0 if unknown/integrated)
  sharedBytes: number;
  integrated: boolean;
}

export interface HardwareProfile {
  cpu: CpuInfo;
  totalMemory: number;
  availableMemory: number;
  gpus: GpuInfo[];
  vulkan: boolean;              // a Vulkan loader is present (GPU engine can run)
  platform: NodeJS.Platform | string;
  source: 'native' | 'fallback';
}

export type ModelFamily = 'tiny' | 'base' | 'small' | 'medium' | 'large-v3' | 'large-v3-turbo';

export interface ModelSpec {
  id: string;                   // e.g. "base.en"
  family: ModelFamily;
  name: string;                 // display name, e.g. "Base"
  englishOnly: boolean;
  quant: 'f16' | 'q8_0' | 'q5_1' | 'q5_0';
  file: string;                 // ggml file name on the model host
  sizeBytes: number;            // download size
  memoryBytes: number;          // approximate working memory when loaded
  accuracy: number;             // 0–100, relative transcription quality
  computeCost: number;          // relative cost of one 30 s encoder pass
  decodeCost: number;           // relative cost per generated token
  blurb: string;
}

/** How a cleanup model expects its prompt (each is spelled out in shared/cleanupPrompt.ts). */
export type PromptFormat = 's1' | 'qwen' | 'granite';

export interface CleanupModelSpec {
  id: string;
  name: string;                 // "Granite 4.0 Micro"
  maker: string;                // "IBM"
  params: number;               // parameter count
  /** Hybrid (recurrent) models can't rewind, so Quill can't draft ahead for them. */
  architecture: 'dense' | 'hybrid';
  format: PromptFormat;
  languages: string[] | 'all';  // ISO codes it handles well
  license: string;
  licenseUrl: string;
  repo: string;                 // Hugging Face repository
  file: string;                 // GGUF file name
  sizeBytes: number;            // download size
  memoryBytes: number;          // approximate working set when loaded
  quality: number;              // 0–100, relative faithful-cleanup quality
  blurb: string;
}

export interface CleanupEstimate {
  modelId: string;
  latencySec: number;           // added to a typical 10 s dictation
  memoryBytes: number;
  fits: boolean;                // fits alongside the dictation model, with headroom
  device: 'gpu' | 'cpu';
  rating: 'great' | 'good' | 'slow' | 'unsupported';
  supported: boolean;           // language and processor can run it at all
}

/** Dictation and cleanup chosen together for this PC. */
export interface SetupRecommendation {
  dictationId: string;
  /** null when no cleanup model runs comfortably next to the dictation model. */
  cleanupId: string | null;
  cleanup: CleanupEstimate | null;
  /** When nothing is comfortable: the quickest model that still runs here, offered but off. */
  cleanupFallbackId: string | null;
  cleanupEstimates: CleanupEstimate[];
  /** Total time from finishing speaking to text, with cleanup on (seconds). */
  totalLatencySec: number;
  /** Memory both models need together, including runtimes. */
  memoryBytes: number;
  memoryBudget: number;
  reason: string;               // one sentence on the cleanup choice
}

export interface ModelEstimate {
  modelId: string;
  latencySec: number;           // for a typical 10 s dictation
  memoryBytes: number;
  fits: boolean;                // memory fits comfortably
  device: 'gpu' | 'cpu';
  rating: 'great' | 'good' | 'slow' | 'unsupported';
}

export interface Recommendation {
  goal: RecommendationGoal;
  modelId: string;
  title: string;
  reason: string;
  estimate: ModelEstimate;
}

export interface RecommendationSet {
  recommended: Recommendation;  // what Quill picks by default
  picks: Recommendation[];      // one per goal (may repeat models)
  estimates: ModelEstimate[];   // every catalog model on this machine
  device: 'gpu' | 'cpu';
  deviceLabel: string;          // "NVIDIA GeForce RTX 4070 · 12 GB" or "8-core CPU"
  summary: string;              // one sentence about this PC
}

export interface DownloadProgress {
  modelId: string;
  received: number;
  total: number;
  bytesPerSec: number;
  state: 'downloading' | 'verifying' | 'done' | 'error' | 'cancelled';
  error?: string;
}

export interface ModelState {
  id: string;
  installed: boolean;
  path: string | null;
  /** Bytes of an unfinished download that the next attempt resumes from. */
  partialBytes?: number;
}

export type EngineStatus =
  | { state: 'idle' }
  | { state: 'loading'; modelId: string }
  | { state: 'ready'; modelId: string; device: 'gpu' | 'cpu'; loadMs: number }
  | { state: 'error'; message: string };

/** What the overlay should show. */
export type OverlayCommand =
  | { type: 'show'; reducedMotion: boolean | null; dark: boolean; sounds: boolean; microphoneId: string; hotkeyLabel: string; mode: HotkeyMode }
  | { type: 'stop' }                       // stop capturing; send audio back
  | { type: 'process' }
  | { type: 'refine' }                     // transcript ready; the cleanup model is polishing it
  | { type: 'success'; text: string }
  | { type: 'cancel' }
  | { type: 'error'; message: string }
  | { type: 'hint'; message: string }
  | { type: 'theme'; dark: boolean; reducedMotion: boolean | null };

export interface DictationResult {
  text: string;
  audioMs: number;
  processMs: number;
  modelId: string;
  at: number;
  /** The transcript before cleanup, when cleanup changed it. */
  original?: string;
  /** What cleanup did: polished the text, kept it as is, or fell back to the original. */
  cleanup?: 'polished' | 'unchanged' | 'fallback' | 'skipped';
  cleanupMs?: number;
}

export type UpdateStatus =
  | { state: 'idle' | 'checking' | 'up-to-date' | 'unsupported'; currentVersion: string; checkedAt?: number }
  | { state: 'available'; currentVersion: string; version: string; notes?: string; checkedAt?: number }
  | { state: 'downloading'; currentVersion: string; version?: string; notes?: string; percent: number; bytesPerSecond?: number; total?: number }
  | { state: 'ready'; currentVersion: string; version: string; notes?: string }
  | { state: 'error'; currentVersion: string; version?: string; message: string };

export interface AppSnapshot {
  settings: Settings;
  hardware: HardwareProfile | null;
  recommendations: RecommendationSet | null;
  setup: SetupRecommendation | null;
  models: ModelState[];
  engine: EngineStatus;
  cleanupEngine: EngineStatus;
  downloads: DownloadProgress[];
  history: DictationResult[];
  version: string;
  platform: string;
  hotkeyAvailable: boolean;
  hotkeyError: string | null;
  update: UpdateStatus;
}
