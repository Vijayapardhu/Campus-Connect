import { app, autoUpdater as _electronAutoUpdater } from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
import type { UpdateStatus } from '../shared/types';

/**
 * Keeping the app up to date from the GitHub releases feed.
 *
 * This exists because of a real failure: the wire protocol changed several
 * times in a day, and two machines on different versions cannot talk to each
 * other at all. Leaving that to whoever remembers to re-download an installer
 * is how people end up staring at an app that worked yesterday.
 *
 * One honest limitation. **Automatic installation on macOS requires the app to
 * be code-signed**, and this project is not signed yet. Squirrel.Mac refuses an
 * unsigned update rather than installing one, so on macOS the check still runs
 * and reports what is available, but the download is left to the user. Windows
 * and Linux install normally.
 */

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type UpdaterEvents = {
  onStatus: (status: UpdateStatus) => void;
};

export class Updater {
  private status: UpdateStatus = { state: 'idle', currentVersion: app.getVersion() };
  private timer: NodeJS.Timeout | null = null;
  private started = false;

  constructor(private readonly events: UpdaterEvents) {}

  /** True when this platform can actually apply an update by itself. */
  static get canSelfInstall(): boolean {
    // Unsigned Squirrel.Mac updates are refused outright, so do not pretend.
    return process.platform !== 'darwin';
  }

  getStatus(): UpdateStatus {
    return this.status;
  }

  start(enabled: boolean): void {
    if (this.started) {
      return;
    }
    this.started = true;

    // Downloading is explicit, so the user is never surprised by a restart.
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = log;
    autoUpdater.allowPrerelease = false;

    autoUpdater.on('checking-for-update', () => this.set({ state: 'checking' }));

    autoUpdater.on('update-available', (info) => {
      this.set({
        state: 'available',
        availableVersion: info.version,
        releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined
      });
      log.info(`Update available: ${info.version}`);
    });

    autoUpdater.on('update-not-available', () => this.set({ state: 'current' }));

    autoUpdater.on('download-progress', (progress) => {
      this.set({ state: 'downloading', percent: Math.round(progress.percent) });
    });

    autoUpdater.on('update-downloaded', (info) => {
      this.set({ state: 'ready', availableVersion: info.version });
      log.info(`Update ${info.version} downloaded and ready`);
    });

    autoUpdater.on('error', (error) => {
      // A dev build with no published feed errors on every check; that is not
      // worth showing anyone.
      const message = error?.message ?? String(error);
      log.warn(`Update check failed: ${message}`);
      this.set({ state: 'error', error: message });
    });

    if (enabled) {
      this.schedule();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Turns the periodic check on or off without restarting the app. */
  setEnabled(enabled: boolean): void {
    this.stop();
    if (enabled) {
      this.schedule();
    }
  }

  async check(manual: boolean): Promise<UpdateStatus> {
    if (!app.isPackaged) {
      // A build run from source has no release to compare itself against.
      this.set({ state: manual ? 'unsupported' : 'idle', error: 'Updates apply to installed builds only.' });
      return this.status;
    }

    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      this.set({ state: 'error', error: (error as Error).message });
    }
    return this.status;
  }

  async download(): Promise<UpdateStatus> {
    if (!Updater.canSelfInstall) {
      this.set({ state: 'manual' });
      return this.status;
    }

    try {
      this.set({ state: 'downloading', percent: 0 });
      await autoUpdater.downloadUpdate();
    } catch (error) {
      this.set({ state: 'error', error: (error as Error).message });
    }
    return this.status;
  }

  /** Restarts into the new version. Only valid once state is 'ready'. */
  installNow(): void {
    if (this.status.state !== 'ready') {
      return;
    }
    // isSilent false so the installer still shows progress; isForceRunAfter so
    // the app comes back up rather than leaving the user staring at a desktop.
    autoUpdater.quitAndInstall(false, true);
  }

  private schedule(): void {
    // A short delay first: startup is busy enough without a network round trip.
    setTimeout(() => void this.check(false), 8000).unref?.();
    this.timer = setInterval(() => void this.check(false), CHECK_INTERVAL_MS);
    this.timer.unref?.();
  }

  private set(patch: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...patch, currentVersion: app.getVersion() };
    this.events.onStatus(this.status);
  }
}
