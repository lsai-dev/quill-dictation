import { cleanupModelById, cleanupSupports } from '../../shared/cleanupModels';
import { formatBytes, modelById } from '../../shared/models';
import type { AppSnapshot, DownloadProgress } from '../../shared/types';

/**
 * The state of "your setup" — the dictation model plus (optionally) the cleanup
 * model — derived from a snapshot. Shared by the Models view and first-run setup so
 * both always agree on what's chosen, what's missing and what to do next.
 */
export interface SetupState {
  dictationId: string;
  /** The cleanup model for this setup (chosen or recommended); null if none suits this PC. */
  cleanupId: string | null;
  cleanupOn: boolean;
  /** Models this setup still needs, in download order. */
  needed: string[];
  neededBytes: number;
  /** Bytes already on disk from interrupted downloads of `needed`. */
  resumableBytes: number;
  downloading: DownloadProgress | null;
  failed: DownloadProgress | null;
  readiness: 'ready' | 'downloading' | 'loading' | 'attention' | 'incomplete';
  /** A plain-language reason when readiness is 'attention'. */
  problem: string | null;
  /** The chosen models differ from the recommendation. */
  custom: boolean;
}

export function setupState(s: AppSnapshot, cleanupOverride?: boolean): SetupState {
  const installed = (id: string | null) => !!id && !!s.models.find((m) => m.id === id)?.installed;
  const rec = s.setup;
  const chosenDictation = s.settings.modelId && modelById(s.settings.modelId) ? s.settings.modelId : null;
  const dictationId = chosenDictation ?? rec?.dictationId ?? s.recommendations?.recommended.modelId ?? 'base.en';
  const chosenCleanup = s.settings.cleanupModelId && cleanupModelById(s.settings.cleanupModelId) ? s.settings.cleanupModelId : null;
  const cleanupId =
    chosenCleanup && cleanupSupports(cleanupModelById(chosenCleanup)!, s.settings.language)
      ? chosenCleanup
      : rec?.cleanupId ?? rec?.cleanupFallbackId ?? null;
  const cleanupOn = (cleanupOverride ?? s.settings.cleanup) && !!cleanupId;

  const wanted = [dictationId, ...(cleanupOn && cleanupId ? [cleanupId] : [])];
  const needed = wanted.filter((id) => !installed(id));
  const size = (id: string) => modelById(id)?.sizeBytes ?? cleanupModelById(id)?.sizeBytes ?? 0;
  const neededBytes = needed.reduce((a, id) => a + size(id), 0);
  const resumableBytes = needed.reduce((a, id) => a + (s.models.find((m) => m.id === id)?.partialBytes ?? 0), 0);
  const downloading = s.downloads.find((d) => (d.state === 'downloading' || d.state === 'verifying') && wanted.includes(d.modelId)) ?? null;
  const failed = s.downloads.find((d) => d.state === 'error' && wanted.includes(d.modelId)) ?? null;

  const dictEngine = s.engine;
  const cleanEngine = s.cleanupEngine;
  let readiness: SetupState['readiness'] = 'ready';
  let problem: string | null = null;
  if (downloading) readiness = 'downloading';
  else if (failed) {
    readiness = 'attention';
    problem = failed.error ?? 'The download didn’t finish.';
  } else if (needed.length) readiness = 'incomplete';
  else if (dictEngine.state === 'error') {
    readiness = 'attention';
    problem = dictEngine.message;
  } else if (cleanupOn && cleanEngine.state === 'error') {
    readiness = 'attention';
    problem = cleanEngine.message;
  } else if (dictEngine.state === 'loading' || (cleanupOn && cleanEngine.state === 'loading')) readiness = 'loading';

  // The plan's cleanup pick already accounts for the dictation model you chose.
  const recommendedDictation = s.recommendations?.recommended.modelId;
  const custom = !!rec && ((!!recommendedDictation && dictationId !== recommendedDictation) || (cleanupOn && !!rec.cleanupId && cleanupId !== rec.cleanupId));
  return { dictationId, cleanupId, cleanupOn, needed, neededBytes, resumableBytes, downloading, failed, readiness, problem, custom };
}

export function modelName(id: string | null | undefined): string {
  return modelById(id)?.name ?? cleanupModelById(id)?.name ?? '';
}

export function modelSize(id: string): number {
  return modelById(id)?.sizeBytes ?? cleanupModelById(id)?.sizeBytes ?? 0;
}

/** "Download Setup · 3.7 GB", "Resume Download · 1.2 GB left", "Download Cleanup · 2.7 GB". */
export function downloadLabel(st: SetupState): string {
  const left = Math.max(0, st.neededBytes - st.resumableBytes);
  if (st.resumableBytes > 0) return `Resume Download · ${formatBytes(left)} left`;
  const both = st.needed.length > 1;
  const onlyCleanup = st.needed.length === 1 && st.needed[0] === st.cleanupId;
  return `${both ? 'Download Setup' : onlyCleanup ? 'Download Cleanup' : 'Download'} · ${formatBytes(st.neededBytes)}`;
}

/** Spoken-style seconds: "about half a second", "about 2 seconds". */
export function addsLatency(sec: number): string {
  if (sec < 0.35) return 'adds a moment';
  if (sec < 0.75) return 'adds about half a second';
  if (sec < 1.4) return 'adds about a second';
  return `adds about ${Math.round(sec)} seconds`;
}

export function etaText(d: DownloadProgress): string {
  if (d.state === 'verifying') return 'Verifying…';
  if (!d.bytesPerSec) return 'Starting…';
  const sec = Math.max(1, Math.round((d.total - d.received) / d.bytesPerSec));
  return sec < 60 ? `${sec} s left` : `${Math.round(sec / 60)} min left`;
}
