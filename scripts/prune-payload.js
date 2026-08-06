#!/usr/bin/env node
/**
 * An electron-builder `afterPack` hook that deletes the two kinds of file
 * Electron ships for platforms and languages this build will never be.
 *
 * 1. Chromium locale packs. Electron bundles one .pak per language Chromium
 *    has been translated into — 55 of them, about 42 MB in an installed
 *    Windows build. They only hold Chromium's own UI strings: native context
 *    menus, file-picker labels, form validation text, accessibility names.
 *    Campus Connect has no i18n layer; every string in src/ is English, and
 *    Chromium's resource bundle falls back to en-US when the pack for the
 *    user's locale is missing. So 54 of them are paid for by every user and
 *    read by nobody.
 *
 * 2. Foreign robotjs prebuilds. @jitsi/robotjs ships prebuilt binaries for
 *    every platform and architecture it supports, and npm installs the lot
 *    regardless of what we are packaging. A Windows x64 installer has no use
 *    for the macOS and Linux ones.
 *
 * Both run on the unpacked app directory before the installer is assembled,
 * so the files never reach the NSIS/dmg/AppImage payload and the download
 * shrinks along with the install.
 *
 * Why this is a hook and not a `files` pattern in package.json: electron-
 * builder's platform-specific `files` arrays REPLACE the top-level one rather
 * than merging with it. Expressing the per-platform half of this as
 * `win.files` silently dropped every include and packed the whole repo —
 * source, docs, site and all — into the asar. One hook that reads the build
 * context is both smaller and harder to get wrong.
 */

const fs = require('node:fs');
const path = require('node:path');

// Windows and Linux name the packs `en-US.pak`; macOS wraps each one in an
// `en.lproj` directory. Keep both spellings of the one language we ship.
const KEEP_LANGUAGES = new Set(['en-US', 'en']);

// electron-builder's Arch enum, in the spelling node-gyp-build looks for when
// it resolves a prebuild — which is os.arch(), so armv7l appears as `arm`.
const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'arm', 3: 'arm64', 4: 'universal' };

function formatSize(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function sizeOf(target) {
  const stats = fs.statSync(target);
  if (!stats.isDirectory()) return stats.size;
  let total = 0;
  for (const entry of fs.readdirSync(target)) {
    total += sizeOf(path.join(target, entry));
  }
  return total;
}

/**
 * Deletes the entries whose `keep` is false and returns the bytes reclaimed.
 * Refuses to delete every entry: if nothing matched, the naming scheme changed
 * under us, and stripping the lot would ship a broken app.
 */
function removeAllBut(entries, what) {
  const kept = entries.filter((entry) => entry.keep);
  if (kept.length === 0) {
    throw new Error(
      `prune-payload: every one of the ${entries.length} ${what} looks unwanted, which means ` +
        'the naming scheme changed. Refusing to strip them all.',
    );
  }

  let reclaimed = 0;
  for (const entry of entries) {
    if (entry.keep) continue;
    reclaimed += sizeOf(entry.path);
    fs.rmSync(entry.path, { recursive: true, force: true });
  }

  console.log(
    `  prune-payload: kept ${kept.map((e) => e.name).join(', ')}, ` +
      `removed ${entries.length - kept.length} ${what} (${formatSize(reclaimed)})`,
  );
  return reclaimed;
}

/**
 * Where the locale packs live, and what each one is called, differ by platform.
 * Returns an empty list for a layout we do not recognise, so a future Electron
 * that moves them makes this a no-op rather than a wrecking ball.
 */
function localePacks(context) {
  const { appOutDir, electronPlatformName, packager } = context;

  const [dir, suffix] =
    electronPlatformName === 'darwin'
      ? [
          path.join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Resources'),
          '.lproj',
        ]
      : [path.join(appOutDir, 'locales'), '.pak'];

  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(suffix))
    .map((name) => {
      const language = name.slice(0, -suffix.length);
      return { path: path.join(dir, name), name: language, keep: KEEP_LANGUAGES.has(language) };
    });
}

/**
 * Prebuild directories are named `<platform>-<arch>`, and one can cover several
 * architectures (`darwin-x64+arm64`). This mirrors how node-gyp-build itself
 * picks one, so we only delete directories it would have skipped anyway.
 */
function robotjsPrebuilds(context) {
  const { appOutDir, electronPlatformName, arch, packager } = context;

  // The .node files are asarUnpack'ed, so the real bytes live out here. The
  // asar header still lists the directories we delete, which is harmless:
  // node-gyp-build filters that listing by name and never opens the rest.
  const resources =
    electronPlatformName === 'darwin'
      ? path.join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : path.join(appOutDir, 'resources');
  const dir = path.join(
    resources,
    'app.asar.unpacked',
    'node_modules',
    '@jitsi',
    'robotjs',
    'prebuilds',
  );
  if (!fs.existsSync(dir)) return [];

  const wanted = ARCH_NAMES[arch];

  return fs.readdirSync(dir).map((name) => {
    const [platform, architectures] = name.split('-');
    const keep =
      platform === electronPlatformName &&
      // A universal build has to carry every architecture for its platform.
      (wanted === 'universal' || (architectures ?? '').split('+').includes(wanted));
    return { path: path.join(dir, name), name, keep };
  });
}

exports.default = async function prunePayload(context) {
  let reclaimed = 0;

  for (const [what, entries] of [
    ['locale packs', localePacks(context)],
    ['robotjs prebuilds', robotjsPrebuilds(context)],
  ]) {
    if (entries.length === 0) {
      console.log(`  prune-payload: no ${what} found, skipping`);
      continue;
    }
    reclaimed += removeAllBut(entries, what);
  }

  console.log(`  prune-payload: reclaimed ${formatSize(reclaimed)} in total`);
};
