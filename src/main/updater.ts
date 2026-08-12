import { app, autoUpdater as _electronAutoUpdater } from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
import type { UpdateStatus } from '../shared/types';
import { isWorthRetrying, shouldFetchAutomatically, shouldOfferDownload } from './updatePolicy';

/**
 * Keeping the app up to date from the GitHub releases feed.
 *
 * This exists because of a real failure: the wire protocol changed several
 * times in a day, and two machines on different versions cannot talk to each
 * other at all. Leaving that to whoever remembers to re-download an installer
 * is how people end up staring at an app that worked yesterday.
 *
 * That same reasoning is why nothing here waits to be asked. With automatic
 * updates on, a new version is found, downloaded in the background and applied
 * the next time the app is closed — no prompt, no button, no restart anybody
 * did not choose. A confirmation step sounds careful and is not: an update
 * sitting behind an unclicked button leaves two devices unable to see each
 * other, which looks exactly like the network being broken and is far more
 * disruptive than the install it was protecting them from.
 *
 * One honest limitation. **Automatic installation on macOS requires the app to
 * be code-signed**, and this project is not signed yet. Squirrel.Mac refuses an
 * unsigned update rather than installing one, so on macOS the check still runs
 * and reports what is available, but the download is left to the user. Windows
 * and Linux install normally.
 */

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Retries for a download that dies mid-transfer. Delay grows with each try. */
const DOWNLOAD_ATTEMPTS = 4;
const RETRY_DELAY_MS = 5000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type UpdaterEvents = {
  onStatus: (status: UpdateStatus) => void;
};

export class Updater {
  private status: UpdateStatus = { state: 'idle', currentVersion: app.getVersion() };
  private timer: NodeJS.Timeout | null = null;
  private started = false;

  /** The version already written to the updater cache, once one has been. */
  private downloadedVersion: string | undefined;
  /**
   * Whether a found update is fetched without being asked for.
   *
   * Tracks the same setting as the periodic check: somebody who has asked for
   * automatic updates has already said what they want to happen, and being
   * asked to confirm each one is the thing they turned it on to avoid.
   */
  private autoFetch = false;
  /** The download in progress, so a second request joins it rather than starting another. */
  private inFlight: Promise<UpdateStatus> | null = null;

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

    this.autoFetch = enabled;

    /*
     * Left false, and the download started from the `update-available` handler
     * below instead — which is not the same as leaving it to the user.
     *
     * electron-updater's own auto-download bypasses `runDownload`, and with it
     * the resume-and-retry loop that exists because an ~85 MB installer over a
     * congested network really does die partway through. Turning this on to get
     * automatic downloads would have quietly traded a download that survives a
     * dropped connection for one that gives up on the first.
     */
    autoUpdater.autoDownload = false;
    /*
     * Applied on the way out rather than by interrupting anybody. Nothing here
     * ever restarts the app to install: a quit is a moment the user chose, and
     * it is the one moment an update cannot land in the middle of a call, a
     * file transfer or a remote session.
     */
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = log;
    autoUpdater.allowPrerelease = false;

    autoUpdater.on('checking-for-update', () => this.set({ state: 'checking' }));

    autoUpdater.on('update-available', (info) => {
      /*
       * A check finding the version that is already downloaded must not undo
       * the download. This fires on every check, so without the guard a
       * finished update was demoted from 'ready' back to 'available' a few
       * seconds after each launch — the download button came back, and the
       * whole installer was fetched again for a file already on disk.
       */
      if (!shouldOfferDownload(this.status.state, this.downloadedVersion, info.version)) {
        log.info(`Update ${info.version} is already downloaded; leaving it ready to install.`);
        return;
      }

      this.set({
        state: 'available',
        availableVersion: info.version,
        releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined
      });
      log.info(`Update available: ${info.version}`);

      /*
       * Fetched immediately, in the background, without asking. 'available' is
       * then a state this passes through in a moment rather than one it sits in
       * waiting to be noticed — which matters more here than in most apps,
       * because two devices on different versions cannot talk to each other at
       * all, and an update nobody clicks is indistinguishable from the network
       * being broken.
       *
       * Not on macOS: an unsigned build cannot apply what it downloads, so
       * fetching it would spend somebody's bandwidth on a file that can only
       * ever be installed by hand.
       */
      if (
        shouldFetchAutomatically({
          autoUpdatesEnabled: this.autoFetch,
          canSelfInstall: Updater.canSelfInstall
        })
      ) {
        void this.download();
      }
    });

    autoUpdater.on('update-not-available', () => this.set({ state: 'current' }));

    autoUpdater.on('download-progress', (progress) => {
      this.set({ state: 'downloading', percent: Math.round(progress.percent) });
    });

    autoUpdater.on('update-downloaded', (info) => {
      this.downloadedVersion = info.version;
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

  /** Turns the periodic check and the automatic fetch on or off, without a restart. */
  setEnabled(enabled: boolean): void {
    this.autoFetch = enabled;
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

    // Already on disk. Asking again should install what is there, not fetch it
    // a second time.
    if (this.status.state === 'ready' && this.downloadedVersion) {
      log.info(`Update ${this.downloadedVersion} is already downloaded; not fetching it again.`);
      return this.status;
    }

    // One at a time. Two presses of the button used to start two transfers of
    // the same file, each reporting progress over the top of the other.
    if (this.inFlight) {
      return this.inFlight;
    }

    this.inFlight = this.runDownload();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async runDownload(): Promise<UpdateStatus> {
    // An installer is ~85 MB, and on a congested network that is several
    // minutes with the connection open the whole time. A single reset partway
    // through used to end the attempt outright, leaving the user on the old
    // version until the next six-hourly check came round. Observed in practice:
    // net::ERR_CONNECTION_RESET twelve minutes into a download.
    //
    // electron-updater keeps its partial file in the updater cache, so a retry
    // resumes rather than starting over. Waiting a little longer between tries
    // gives a network that is briefly overloaded time to recover.
    let lastError = '';
    let tried = 0;

    for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
      tried = attempt;
      try {
        // Only the first attempt starts the bar at nothing. A resumed transfer
        // carries on from where it stopped, and zeroing it every time made a
        // download that was making progress look like it kept starting over.
        this.set(attempt === 1 ? { state: 'downloading', percent: 0, error: undefined } : { state: 'downloading', error: undefined });
        await autoUpdater.downloadUpdate();
        return this.status;
      } catch (error) {
        lastError = (error as Error).message;

        /*
         * The file can be complete even when the call reports a failure — the
         * 'update-downloaded' event has already fired by then. Retrying at that
         * point fetches an installer that is sitting on disk, which is most of
         * how one update came to be downloaded three and four times over.
         *
         * Matched against `availableVersion`, not just checked for existence —
         * `downloadedVersion` survives across separate downloads (it is only
         * ever overwritten, never cleared), so a *second*, later update whose
         * own transfer genuinely fails would otherwise find the *first*
         * update's leftover `downloadedVersion` still sitting there, report
         * itself "ready", and skip its own retries and error entirely — every
         * install-now from that point on would silently install the old
         * version instead of the one the user just tried to download.
         */
        if (this.downloadedVersion && this.downloadedVersion === this.status.availableVersion) {
          log.info(`Download reported "${lastError}" after ${this.downloadedVersion} had already been written; it is ready.`);
          this.set({ state: 'ready', availableVersion: this.downloadedVersion, error: undefined });
          return this.status;
        }

        log.warn(`Update download attempt ${attempt} of ${DOWNLOAD_ATTEMPTS} failed: ${lastError}`);

        // A checksum that does not match will not match on the fourth go.
        if (!isWorthRetrying(lastError)) {
          log.warn('That failure will not come out differently; not retrying.');
          break;
        }

        if (attempt < DOWNLOAD_ATTEMPTS) {
          this.set({ state: 'retrying', attempt, error: lastError });
          await delay(RETRY_DELAY_MS * attempt);
        }
      }
    }

    // The count is what was actually tried, not the ceiling — a failure that
    // stopped after one go should not claim to have been attempted four times.
    this.set({
      state: 'error',
      error: tried > 1 ? `${lastError} (after ${tried} attempts)` : lastError
    });
    return this.status;
  }

  /**
   * Restarts into the new version. Only valid once state is 'ready'; returns
   * false otherwise, so the caller can say so rather than promising a restart
   * that was never going to happen.
   */
  installNow(): boolean {
    if (this.status.state !== 'ready') {
      log.warn(`Install asked for while the update was '${this.status.state}'; ignoring`);
      return false;
    }

    // isSilent false so the installer still shows progress; isForceRunAfter so
    // the app comes back up rather than leaving the user staring at a desktop.
    autoUpdater.quitAndInstall(false, true);
    return true;
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
