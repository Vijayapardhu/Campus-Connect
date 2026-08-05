#!/usr/bin/env node
/*
 * Points the website's download buttons at a specific release's files.
 *
 * The buttons used to link to /releases/latest, which meant leaving the site
 * to fetch the app. They now link straight at the installers, because GitHub
 * serves those with `Content-Disposition: attachment` — the browser downloads
 * the file and the visitor never goes anywhere.
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
const page = path.join(__dirname, '..', 'docs', 'index.html');
let html = fs.readFileSync(page, 'utf8');
const before = html;

for (const platform of PLATFORMS) {
  const file = built.find(platform.match);

  /*
   * A missing installer must not quietly leave the old version's link in
   * place: that link still resolves, so the page would keep handing out the
   * previous release with no sign anything was wrong.
   */
  if (!file) {
    console.error(`No ${platform.key} installer in ${assetDir} — refusing to publish a stale link.`);
    process.exit(1);
  }

  const size = fs.statSync(path.join(assetDir, file)).size;
  const mb = `${Math.round(size / 1048576)} MB`;
  const url = `https://github.com/Vijayapardhu/Clipboard/releases/download/${tag}/${file}`;

  // Rewrite the href and the size that sit inside this platform's card. The
  // card runs from its data-dl anchor to the closing </a>.
  const card = new RegExp(`(<a[^>]*data-dl="${platform.key}"[^>]*href=")[^"]*(")([\\s\\S]*?</a>)`);
  if (!card.test(html)) {
    console.error(`No download card marked data-dl="${platform.key}" in docs/index.html.`);
    process.exit(1);
  }

  html = html.replace(card, (_all, head, quote, rest) => {
    const resized = rest.replace(/(<span data-size>)[^<]*(<\/span>)/, `$1${mb}$2`);
    return `${head}${url}${quote}${resized}`;
  });

  console.log(`${platform.key.padEnd(6)} ${file}  (${mb})`);
}

// The two places the version is stated in prose.
html = html
  .replace(/(<i><\/i> Version )\d+\.\d+\.\d+/, `$1${version}`)
  .replace(/(Version )\d+\.\d+\.\d+(\. Free, and open source\.)/, `$1${version}$2`);

if (html === before) {
  console.log('Site already matches this release.');
  process.exit(0);
}

fs.writeFileSync(page, html);
console.log(`docs/index.html now points at ${tag}.`);
