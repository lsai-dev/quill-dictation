import { app, Notification } from 'electron';
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater';
import type { UpdateStatus } from '../shared/types';
import { log } from './log';

const FIRST_CHECK_DELAY_MS = 15_000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/**
 * In-app updates from GitHub Releases.
 *
 * Quill checks quietly in the background. When a newer version exists it says
 * so — in the app, the tray and a notification — and downloads only when you
 * ask. Downloads are differential (only the changed blocks of the installer),
 * and the new version installs when you choose "Restart to Update" or the next
 * time Quill quits. Voice models live in your profile and are never touched.
 */
export class Updater extends EventEmitter {
  status: UpdateStatus = { state: 'idle', currentVersion: app.getVersion() };
  private timer: NodeJS.Timeout | null = null;
  private manual = false;
  private notifiedVersion: string | null = null;
  /** Set by the app so a restart never interrupts a dictation. */
  isBusy: () => boolean = () => false;
  onOpenApp: () => void = () => undefined;

  get supported() {
    return app.isPackaged || !!process.env.QUILL_UPDATE_DEV;
  }

  start() {
    if (!this.supported) {
      this.set({ state: 'unsupported', currentVersion: app.getVersion() });
      return;
    }
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    if (process.env.QUILL_UPDATE_DEV) autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.logger = { info: (m: unknown) => log.info(`updater: ${m}`), warn: (m: unknown) => log.warn(`updater: ${m}`), error: (m: unknown) => log.error(`updater: ${m}`), debug: () => undefined };

    autoUpdater.on('checking-for-update', () => this.set({ ...this.base(), state: 'checking' }));
    autoUpdater.on('update-not-available', () => this.set({ ...this.base(), state: 'up-to-date', checkedAt: Date.now() }));
    autoUpdater.on('update-available', (info: UpdateInfo) => {
      this.set({ ...this.base(), state: 'available', version: info.version, notes: notesText(info), checkedAt: Date.now() });
      this.notify(info.version);
    });
    autoUpdater.on('download-progress', (p: ProgressInfo) => {
      this.set({ ...this.base(), state: 'downloading', version: this.version, notes: this.notes, percent: p.percent, bytesPerSecond: p.bytesPerSecond, total: p.total });
    });
    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      this.set({ ...this.base(), state: 'ready', version: info.version, notes: notesText(info) });
    });
    autoUpdater.on('error', (e: Error) => {
      log.warn(`updater: ${e?.message ?? e}`);
      // Background checks fail silently (offline, rate limits); only a check you
      // asked for reports a problem.
      const wasDownloading = this.status.state === 'downloading';
      if (this.manual || wasDownloading) {
        this.set({ ...this.base(), state: 'error', version: this.version, message: friendly(e, wasDownloading) });
      } else if (this.status.state === 'checking') {
        this.set({ ...this.base(), state: 'idle' });
      }
      this.manual = false;
    });

    this.timer = setTimeout(() => void this.check(false), FIRST_CHECK_DELAY_MS);
    setInterval(() => void this.check(false), CHECK_INTERVAL_MS).unref();
  }

  async check(manual = true) {
    if (!this.supported) return;
    // Don't re-check over a pending or finished download.
    if (['downloading', 'ready'].includes(this.status.state)) return;
    this.manual = manual;
    try {
      await autoUpdater.checkForUpdates();
    } catch {
      /* reported through the 'error' event */
    } finally {
      this.manual = false;
    }
  }

  async download() {
    if (this.status.state !== 'available' && this.status.state !== 'error') return;
    this.set({ ...this.base(), state: 'downloading', version: this.version, notes: this.notes, percent: 0 });
    try {
      await autoUpdater.downloadUpdate();
    } catch {
      /* reported through the 'error' event */
    }
  }

  /** Restart into the new version — deferred if you're mid-dictation. */
  install() {
    if (this.status.state !== 'ready') return;
    if (this.isBusy()) {
      setTimeout(() => this.install(), 1500);
      return;
    }
    log.info(`updater: restarting into ${this.version}`);
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
  }

  private notify(version: string) {
    if (this.notifiedVersion === version || !Notification.isSupported()) return;
    this.notifiedVersion = version;
    const n = new Notification({
      title: `Quill ${version} is available`,
      body: 'Open Quill to download the update. Your settings and voice models stay as they are.',
      silent: true,
    });
    n.on('click', () => this.onOpenApp());
    n.show();
  }

  private base() {
    return { currentVersion: app.getVersion() };
  }

  private get version(): string | undefined {
    return 'version' in this.status ? this.status.version : undefined;
  }

  private get notes(): string | undefined {
    return 'notes' in this.status ? this.status.notes : undefined;
  }

  private set(s: UpdateStatus) {
    this.status = s;
    this.emit('status', s);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
  }

  /**
   * CI self-test against the real release feed: optionally pretend to be an
   * older version, check, download, and write what happened to a JSON file.
   */
  async selfTest(outFile: string, pretendVersion?: string) {
    const result: Record<string, unknown> = { currentVersion: app.getVersion() };
    try {
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = false;
      if (process.env.QUILL_UPDATE_DEV) autoUpdater.forceDevUpdateConfig = true;
      if (pretendVersion) {
        // Use electron-updater's own SemVer class (it may bundle its own semver copy).
        const u = autoUpdater as unknown as { currentVersion: object };
        const Version = u.currentVersion.constructor as new (v: string) => object;
        u.currentVersion = new Version(pretendVersion);
      }
      result.pretendVersion = pretendVersion ?? null;
      const check = await autoUpdater.checkForUpdates();
      result.isUpdateAvailable = !!check?.isUpdateAvailable;
      result.latestVersion = check?.updateInfo.version ?? null;
      result.files = check?.updateInfo.files.map((f) => ({ url: f.url, size: f.size })) ?? [];
      if (check?.isUpdateAvailable) {
        const files = await autoUpdater.downloadUpdate();
        result.downloaded = files;
      }
      result.ok = true;
    } catch (e) {
      result.ok = false;
      result.error = (e as Error).message;
    }
    writeFileSync(outFile, JSON.stringify(result, null, 2));
  }
}

function notesText(info: UpdateInfo): string | undefined {
  const n = info.releaseNotes;
  const raw = typeof n === 'string' ? n : Array.isArray(n) ? n.map((x) => x.note ?? '').join('\n') : '';
  // Release notes arrive as HTML from GitHub; keep plain text for the UI.
  const text = raw.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  return text ? text.slice(0, 600) : undefined;
}

function friendly(e: Error, downloading: boolean): string {
  const m = e?.message ?? '';
  if (/ENOTFOUND|ECONN|ETIMEDOUT|net::|network/i.test(m)) return downloading ? 'The download was interrupted. Check your connection and try again.' : 'Couldn’t reach the update server. Check your connection.';
  if (/404|Not Found|Unable to find latest version/i.test(m)) return 'No published releases are available yet.';
  if (/sha512|checksum/i.test(m)) return 'The download didn’t verify, so it was discarded. Try again.';
  return downloading ? 'The update couldn’t be downloaded. Try again later.' : 'Couldn’t check for updates right now.';
}
