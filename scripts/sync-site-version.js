#!/usr/bin/env node
/*
 * Points the website's download buttons at a specific release's files.
 *
 * The buttons link straight at the installers rather than at /releases/latest,
 * because GitHub serves those with `Content-Disposition: attachment` — the
 * browser downloads the file and the visitor never leaves the site.
 *
 * The cost of that is a version inside every URL, and a URL with a version in
 * it goes stale the moment the next release lands. A wrong version number on
 * the page is untidy; a dead download button is the product not existing. So
 * the release workflow runs this immediately after publishing, and the site
 * follows the release rather than being remembered about.
 *
 *   node scripts/sync-site-version.js v0.5.0 installers
 *
 * The second argument is a directory holding the built installers, which is
 * where the sizes come from. Sizes are read rather than written by hand for
 * the same reason as everything else here: a number nobody can check is a
 * number that is eventually wrong.
 *
 * ---------------------------------------------------------------------------
 * This used to rewrite docs/index.html in place with a pair of regular
 * expressions. docs/ is now the *output* of the Vite project in site/, so
 * editing it would be editing a build artifact — the next build would drop
 * the change on the floor, and the markup it was matching against is minified
 * and fingerprinted anyway. It writes site/src/data/release.json instead, and
 * the caller rebuilds. See site/src/data/release.ts for the reading end.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const [, , rawVersion, assetDir] = process.argv;

if (!rawVersion || !assetDir) {
  console.error('usage: sync-site-version.js <vX.Y.Z> <installer-dir>');
  process.exit(2);
}

const tag = rawVersion.startsWith('v') ? rawVersion : `v${rawVersion}`;
const version = tag.slice(1);

if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`Not a version: ${rawVersion}`);
  process.exit(2);
}

/** Which built file belongs to which download card. */
const PLATFORMS = [
  { key: 'win', match: (f) => f.endsWith('.exe') },
  { key: 'mac', match: (f) => f.endsWith('.dmg') },
  { key: 'linux', match: (f) => f.endsWith('.AppImage') }
];

const built = fs.readdirSync(assetDir);
const target = path.join(__dirname, '..', 'site', 'src', 'data', 'release.json');
const before = fs.readFileSync(target, 'utf8');
const data = JSON.parse(before);

data.tag = tag;
data.version = version;
data.assets = {};

for (const platform of PLATFORMS) {
  const file = built.find(platform.match);

  /*
   * A missing installer must not quietly leave the old version's entry in
   * place: that link still resolves, so the page would keep handing out the
   * previous release with no sign anything was wrong.
   */
  if (!file) {
    console.error(`No ${platform.key} installer in ${assetDir} — refusing to publish a stale link.`);
    process.exit(1);
  }

  const bytes = fs.statSync(path.join(assetDir, file)).size;
  const size = `${Math.round(bytes / 1048576)} MB`;

  data.assets[platform.key] = { file, size };
  console.log(`${platform.key.padEnd(6)} ${file}  (${size})`);
}

const after = `${JSON.stringify(data, null, 2)}\n`;

if (after === before) {
  console.log('Site already matches this release.');
  process.exit(0);
}

fs.writeFileSync(target, after);
console.log(`site/src/data/release.json now describes ${tag}. Rebuild site/ to publish it.`);
