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

    try {
      fs.mkdirSync(userData, { recursive: true });
      /*
       * The old directory is left alone rather than moved. If this build turns
       * out to be a mistake, the previous one still starts and still has
       * everything it had — which matters more than the disk space.
       */
      fs.cpSync(legacy, userData, { recursive: true, force: false, errorOnExist: false });
      return { migrated: true, from: legacy };
    } catch (error) {
      return { migrated: false, from: legacy, error: (error as Error).message };
    }
  }

  return { migrated: false };
}
