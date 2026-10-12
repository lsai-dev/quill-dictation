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
  models: ModelState[];
  engine: EngineStatus;
  downloads: DownloadProgress[];
  history: DictationResult[];
  version: string;
  platform: string;
  hotkeyAvailable: boolean;
  hotkeyError: string | null;
  update: UpdateStatus;
}
