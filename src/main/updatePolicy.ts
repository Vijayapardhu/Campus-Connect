import type { UpdateState } from '../shared/types';

/**
 * The two decisions the updater kept getting wrong, pulled out so they can be
 * tested. Free of Electron imports for the same reason `migrate.ts` is.
 *
 * Both come from one reported symptom: the same update downloading three or
 * four times over before it finally installed.
 */

/**
 * Whether a check that found `incoming` should send the user back to the
 * download button.
 *
 * It should not, if that exact version is already sitting on disk waiting to be
 * installed. `update-available` fires on every check — six-hourly, and again a
 * few seconds after each launch — and it fired unconditionally, so a finished
 * download was demoted from 'ready' back to 'available' the next time the app
 * looked. The button reappeared, the user pressed it, and ~85 MB came down
 * again for a file that was already there. Repeat until they happened to press
 * "Restart and install" while it was briefly ready.
 *
 * A genuinely newer version must still get through, which is the only reason
 * this is a comparison rather than a flat "ignore when ready".
 */
export function shouldOfferDownload(
  state: UpdateState,
  downloadedVersion: string | undefined,
  incomingVersion: string
): boolean {
  if (!downloadedVersion) {
    return true;
  }
  if (state !== 'ready') {
    return true;
  }
  return downloadedVersion !== incomingVersion;
}

/**
 * Whether a newly found update should be fetched without being asked for.
 *
 * Automatic updates mean automatic: somebody who turned the setting on has
 * already said what they want to happen, and a confirmation step for each
 * version is the thing they turned it on to avoid. It matters more here than in
 * most apps, because two devices on different versions cannot talk to each
 * other at all — an update waiting behind an unclicked button does not look
 * like a pending update, it looks like the network is broken.
 *
 * The exception is a platform that cannot apply what it downloads. An unsigned
 * macOS build is refused by Squirrel.Mac rather than installed, so fetching it
 * automatically would spend somebody's bandwidth on ~170 MB that can only ever
 * be installed by hand anyway.
 */
export function shouldFetchAutomatically(options: {
  autoUpdatesEnabled: boolean;
  canSelfInstall: boolean;
}): boolean {
  return options.autoUpdatesEnabled && options.canSelfInstall;
}

/**
 * Whether a failed download is worth trying again.
 *
 * Retrying is for a connection that died partway through an 85 MB transfer.
 * A file that fails its checksum, a release that is not there, or an update
 * refused for not being signed will fail exactly the same way four times in a
 * row — so those report at once instead of making the user watch three more
 * doomed attempts.
 */
export function isWorthRetrying(message: string): boolean {
  return !/sha512|checksum|signature|not signed|code signature|404|not found|ENOENT|EACCES|ENOSPC/i.test(
    message
  );
}
