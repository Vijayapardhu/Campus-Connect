/**
 * Choosing what to download.
 *
 * Kept apart from the downloading itself, and free of any network or disk
 * access, so the part that decides *which* file a machine gets can be tested
 * against every platform rather than only the one the tests happen to run on.
 */

'use strict';

/**
 * The installer for a platform, as a predicate over asset names.
 *
 * Matched on the suffix the release workflow produces rather than on a full
 * filename, because the version number is in the middle of it and this package
 * deliberately does not know which version it is fetching.
 */
const TARGETS = {
  'win32-x64': { suffix: '-win-x64.exe', label: 'Windows installer' },
  'darwin-x64': { suffix: '-mac-universal.dmg', label: 'macOS disk image' },
  'darwin-arm64': { suffix: '-mac-universal.dmg', label: 'macOS disk image' },
  'linux-x64': { suffix: '-linux-x86_64.AppImage', label: 'Linux AppImage' }
};

/** The update manifest for a platform, which is where the checksums live. */
const MANIFESTS = {
  win32: 'latest.yml',
  darwin: 'latest-mac.yml',
  linux: 'latest-linux.yml'
};

/**
 * What this machine should download, or an explanation of why nothing fits.
 *
 * macOS is a single universal build, so Apple silicon and Intel resolve to the
 * same file; Windows on ARM is deliberately absent rather than silently handed
 * the x64 build.
 */
function target(platform, arch) {
  const found = TARGETS[`${platform}-${arch}`];
  if (found) {
    return found;
  }

  const supported = Object.keys(TARGETS).join(', ');
  throw new Error(
    `There is no Campus Connect build for ${platform}-${arch}.\n` +
      `Builds exist for: ${supported}.\n` +
      'You can still run it from source: https://github.com/Vijayapardhu/Campus-Connect#from-source'
  );
}

/** The release asset matching a target, by name. */
function pickAsset(assets, suffix) {
  const asset = (assets || []).find((a) => typeof a.name === 'string' && a.name.endsWith(suffix));
  if (!asset) {
    throw new Error(`This release has no ${suffix} file. It may still be uploading — try again shortly.`);
  }
  return asset;
}

/** The manifest asset for a platform, or null when the release predates them. */
function pickManifest(assets, platform) {
  const name = MANIFESTS[platform];
  return (assets || []).find((a) => a.name === name) || null;
}

/**
 * The checksum for one file, out of an electron-updater manifest.
 *
 * The manifest is YAML, but only ever the same handful of shapes, so this reads
 * the two fields it needs rather than taking on a YAML parser for a package
 * whose whole point is being small. `sha512` is base64, not hex.
 *
 * Returns null rather than throwing when the file is not listed — an older
 * release with no entry should still install, just without the check.
 */
function sha512For(manifest, filename) {
  const lines = String(manifest).split(/\r?\n/);
  let current = null;

  for (const line of lines) {
    const url = line.match(/^\s*-?\s*url:\s*(.+?)\s*$/);
    if (url) {
      current = url[1].replace(/^['"]|['"]$/g, '');
      continue;
    }

    const sha = line.match(/^\s*-?\s*sha512:\s*(.+?)\s*$/);
    if (sha && current === filename) {
      return sha[1].replace(/^['"]|['"]$/g, '');
    }
  }

  return null;
}

module.exports = { TARGETS, MANIFESTS, target, pickAsset, pickManifest, sha512For };
