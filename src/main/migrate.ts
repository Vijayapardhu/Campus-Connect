import fs from 'node:fs';
import path from 'node:path';

/**
 * Carrying an existing install across the rename to Campus Connect.
 *
 * Electron names the per-user data directory after the application, so renaming
 * the app moves it: everything the previous version wrote — the device identity,
 * the rooms, the derived room keys, the history — is suddenly in a folder
 * nothing reads. From inside the app that is indistinguishable from a fresh
 * install, and it would cost people every room they are in.
 *
 * So the first run under the new name copies the old directory across. It only
 * ever runs when the new directory has no settings file of its own, so it cannot
 * overwrite anything, and a failure is not fatal — a copy that does not happen
 * leaves the app exactly as it would have been without this.
 *
 * Synchronous on purpose: the store is opened as soon as the main module loads,
 * so this has to be finished before that, not merely started.
 *
 * Free of Electron imports so it can be tested in plain Node.
 */

/** The file whose presence means a directory is already a real install. */
const MARKER_FILE = 'config.json';

export type MigrationResult = {
  migrated: boolean;
  /** The directory copied from, when one was. */
  from?: string;
  /** Set when a copy was attempted and failed. The app carries on regardless. */
  error?: string;
};

export function migrateUserData(options: {
  /** The per-user application data root — `app.getPath('appData')`. */
  appData: string;
  /** Where this build stores its data — `app.getPath('userData')`. */
  userData: string;
  /** Directory names earlier versions used, most recent first. */
  legacyNames: string[];
}): MigrationResult {
  const { appData, userData, legacyNames } = options;

  if (fs.existsSync(path.join(userData, MARKER_FILE))) {
    return { migrated: false };
  }

  for (const name of legacyNames) {
    const legacy = path.join(appData, name);
    if (path.resolve(legacy) === path.resolve(userData)) {
      continue; // The name did not actually change on this platform.
    }
    if (!fs.existsSync(path.join(legacy, MARKER_FILE))) {
      continue;
    }

    /*
     * Copied into a staging directory next to `userData` first, not into
     * `userData` itself. `cpSync` walks the tree file by file and is not
     * atomic — a process killed partway (not merely a caught exception, an
     * actual crash or forced quit) used to leave `userData` holding whatever
     * had copied so far. If that happened to include the marker file this
     * function gates on, the *next* launch saw `config.json` already there,
     * read that as "nothing to do", and never revisited the directory —
     * whatever else had not finished copying (a phone certificate, anything
     * that sorts after the marker) was then permanently missing, with
     * nothing anywhere recording that the migration was ever incomplete.
     * Staging first means the only thing that can be interrupted is a copy
     * nothing has adopted yet; `userData` itself is only ever touched by the
     * one step below meant to be as close to instantaneous as the
     * filesystem allows.
     */
    const staging = `${userData}.migrating-${process.pid}`;
    try {
      fs.rmSync(staging, { recursive: true, force: true });
      fs.mkdirSync(staging, { recursive: true });
      fs.cpSync(legacy, staging, { recursive: true, force: false, errorOnExist: false });
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      return { migrated: false, from: legacy, error: (error as Error).message };
    }

    try {
      /*
       * A rename is atomic on a single volume, which staging is deliberately
       * on (a sibling of `userData`, not a system temp directory that could
       * sit on a different one). It fails outright if `userData` already
       * exists — Electron itself may have created it before this ever runs,
       * for its own crash-reporter/cache directories that have nothing to
       * do with this app's data — which the fallback below handles.
       */
      fs.renameSync(staging, userData);
    } catch {
      try {
        fs.mkdirSync(userData, { recursive: true });
        fs.cpSync(staging, userData, { recursive: true });
      } catch (error) {
        return { migrated: false, from: legacy, error: (error as Error).message };
      } finally {
        fs.rmSync(staging, { recursive: true, force: true });
      }
    }

    return { migrated: true, from: legacy };
  }

  return { migrated: false };
}
