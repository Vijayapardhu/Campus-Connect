#!/usr/bin/env node
/**
 * Checks that a packaged build actually contains everything it needs to start.
 *
 *   npm run verify:package
 *
 * This exists because of a real shipped bug. The `files` glob in package.json
 * was narrowed to `dist/main` and `dist/renderer`, which silently dropped
 * `dist/shared` — the types module that main.js requires on its very first
 * line. The installer built and published perfectly happily, and the app died
 * on launch with no window, no log and no error, because it could not resolve
 * a require before any logging was set up.
 *
 * Nothing in a typecheck or a unit test catches that: the fault is in the
 * packaging, not the code. So this reads the built asar and asserts that every
 * directory under dist/ made it in, and that every relative require in the
 * compiled main process resolves to something packaged.
 */

const fs = require('node:fs');
const path = require('node:path');
const asarTool = require('@electron/asar');

const root = path.join(__dirname, '..');
const distDir = path.join(root, 'dist');
const releaseDir = path.join(root, 'release');

function fail(message) {
  console.error(`\n  FAIL  ${message}\n`);
  process.exit(1);
}

function findAsar() {
  if (!fs.existsSync(releaseDir)) {
    fail('No release/ directory. Run a packaging script first.');
  }

  const candidates = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name === 'app.asar') candidates.push(full);
    }
  };
  walk(releaseDir, 0);

  if (candidates.length === 0) {
    fail('No app.asar found under release/.');
  }
  return candidates[0];
}

const asar = findAsar();
console.log(`\nVerifying ${path.relative(root, asar)}`);

let entries;
try {
  // Paths come back with the platform separator; normalise before comparing.
  entries = asarTool.listPackage(asar, { isPack: false }).map((entry) => entry.replace(/\\/g, '/'));
} catch (error) {
  fail(`Could not read the asar: ${error.message}`);
}

let problems = 0;

// 1. Every directory under dist/ must be present.
const distSubdirs = fs
  .readdirSync(distDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

console.log('\n  dist/ directories');
for (const name of distSubdirs) {
  const present = entries.some((entry) => entry.startsWith(`/dist/${name}/`));
  console.log(`    ${present ? 'ok  ' : 'MISSING'}  dist/${name}`);
  if (!present) problems += 1;
}

// 2. Every relative require the compiled main process makes must resolve.
console.log('\n  relative requires from dist/main');
const mainFiles = fs.readdirSync(path.join(distDir, 'main')).filter((f) => f.endsWith('.js'));
const required = new Set();

for (const file of mainFiles) {
  const source = fs.readFileSync(path.join(distDir, 'main', file), 'utf8');
  for (const match of source.matchAll(/require\("(\.\.?\/[^"]+)"\)/g)) {
    required.add(path.posix.normalize(path.posix.join('/dist/main', match[1])));
  }
}

for (const target of [...required].sort()) {
  const present = entries.some((entry) => entry === `${target}.js` || entry === target);
  console.log(`    ${present ? 'ok  ' : 'MISSING'}  ${target}`);
  if (!present) problems += 1;
}

// 3. The entry point named in package.json must exist.
const main = require(path.join(root, 'package.json')).main;
const entryPresent = entries.includes(`/${main.replace(/\\/g, '/')}`);
console.log(`\n  entry point\n    ${entryPresent ? 'ok  ' : 'MISSING'}  ${main}`);
if (!entryPresent) problems += 1;

if (problems > 0) {
  fail(`${problems} thing(s) the app needs are not in the package. It would fail to start.`);
}

console.log('\n  package looks complete\n');
