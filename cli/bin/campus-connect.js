#!/usr/bin/env node

/**
 * `npx campus-connect` — fetch the right installer for this machine and run it.
 *
 * This package contains no application code. Campus Connect is an Electron
 * desktop app of about 85MB, which has no business living in a registry that
 * would then have to ship it to people who wanted a different platform. So this
 * is a few kilobytes that reads the GitHub release, works out which of the four
 * builds belongs on the machine it is running on, checks what it downloaded
 * against the checksum the release publishes, and hands it to the installer.
 *
 * Node's standard library only, deliberately: a tool whose entire job is to be
 * small and to be trusted should not be pulling a dependency tree to do it.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { target, pickAsset, pickManifest, sha512For } = require('../lib/select');

const REPO = 'Vijayapardhu/Campus-Connect';
const UA = 'campus-connect-cli';

/* ------------------------------------------------------------------ output */

const tty = process.stderr.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (tty ? `[${code}m${text}[0m` : text);
const dim = (t) => paint('2', t);
const bold = (t) => paint('1', t);
const green = (t) => paint('32', t);
const red = (t) => paint('31', t);

const say = (text) => process.stderr.write(text + '\n');
const step = (text) => say(`${green('✔')} ${text}`);

/* -------------------------------------------------------------- networking */

/**
 * A GET that follows redirects, which downloading a release asset requires —
 * the API hands back a URL that redirects to wherever the bytes actually live.
 */
function get(url, headers, depth = 0) {
  if (depth > 5) {
    return Promise.reject(new Error('Too many redirects.'));
  }

  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'user-agent': UA, ...headers } }, (response) => {
      const { statusCode, headers: got } = response;

      if (statusCode >= 300 && statusCode < 400 && got.location) {
        response.resume();
        resolve(get(new URL(got.location, url).toString(), headers, depth + 1));
        return;
      }

      if (statusCode !== 200) {
        response.resume();
        reject(new Error(`${url} returned ${statusCode}.`));
        return;
      }

      resolve(response);
    });

    request.on('error', reject);
    request.setTimeout(30000, () => request.destroy(new Error('Timed out reaching GitHub.')));
  });
}

/** The whole body, for things small enough to hold — JSON and manifests. */
async function getText(url, headers) {
  const response = await get(url, headers);
  const chunks = [];
  for await (const chunk of response) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Streams to disk, drawing a progress bar and hashing as it goes.
 *
 * Hashed here rather than by re-reading the file afterwards: the bytes are
 * already in hand, and an 85MB installer is not worth reading twice.
 */
async function download(url, destination, expectedSize) {
  const response = await get(url, { accept: 'application/octet-stream' });
  const total = Number(response.headers['content-length']) || expectedSize || 0;
  const hash = crypto.createHash('sha512');

  let done = 0;
  let lastDrawn = -1;

  const draw = () => {
    if (!tty || !total) {
      return;
    }
    const share = done / total;
    const percent = Math.floor(share * 100);
    if (percent === lastDrawn) {
      return;
    }
    lastDrawn = percent;

    const width = 26;
    const filled = Math.round(share * width);
    const bar = '█'.repeat(filled) + dim('░'.repeat(width - filled));
    const mb = (n) => (n / 1048576).toFixed(1);
    process.stderr.write(`\r  ${bar} ${String(percent).padStart(3)}%  ${mb(done)}/${mb(total)} MB`);
  };

  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destination);

    response.on('data', (chunk) => {
      done += chunk.length;
      hash.update(chunk);
      draw();
    });

    response.on('error', reject);
    file.on('error', reject);
    file.on('finish', resolve);
    response.pipe(file);
  });

  if (tty && total) {
    process.stderr.write('\n');
  }

  return { digest: hash.digest('base64'), size: done };
}

/* ----------------------------------------------------------------- running */

/**
 * Hands the file to whatever opens it on this platform.
 *
 * Detached and unreferenced so the installer outlives this process — `npx`
 * should not sit there holding a terminal open while somebody clicks through a
 * setup wizard.
 */
function launch(file, platform) {
  if (platform === 'linux') {
    fs.chmodSync(file, 0o755);
  }

  const [command, args] =
    platform === 'darwin' ? ['open', [file]] :
    platform === 'linux' ? [file, []] :
    [file, []];

  const child = spawn(command, args, { detached: true, stdio: 'ignore', shell: false });
  child.unref();
}

/* -------------------------------------------------------------------- main */

const HELP = `
${bold('campus-connect')} — install Campus Connect on this machine

  ${dim('$')} npx campus-connect              ${dim('download the latest build and run it')}
  ${dim('$')} npx campus-connect --tag v0.4.0 ${dim('a specific release')}
  ${dim('$')} npx campus-connect --save-only  ${dim('download it, do not run it')}

Options
  --tag <tag>     Install this release instead of the latest
  --dir <path>    Where to put the download (default: a temporary folder)
  --save-only     Download and verify, then stop
  --help, -h      This text
  --version, -v   Version of this installer

Campus Connect is a desktop app for moving your clipboard, files, chat, calls
and screen between the devices on your own network. It is free, open source and
never uses the internet to do any of it.

  https://github.com/${REPO}
`;

function parse(argv) {
  const options = { tag: null, dir: null, saveOnly: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      process.stdout.write(HELP);
      process.exit(0);
    } else if (arg === '--version' || arg === '-v') {
      process.stdout.write(require('../package.json').version + '\n');
      process.exit(0);
    } else if (arg === '--save-only' || arg === '--download-only') {
      options.saveOnly = true;
    } else if (arg === '--tag') {
      options.tag = argv[++i];
    } else if (arg === '--dir') {
      options.dir = argv[++i];
    } else {
      throw new Error(`Unknown option ${arg}. Try --help.`);
    }
  }

  if (options.tag !== null && !options.tag) {
    throw new Error('--tag needs a value, for example --tag v0.4.0.');
  }
  if (options.dir !== null && !options.dir) {
    throw new Error('--dir needs a path.');
  }

  return options;
}

async function main() {
  const options = parse(process.argv.slice(2));
  const platform = process.platform;
  const arch = process.arch;

  say('');
  say(`  ${bold('Campus Connect')}`);
  say('');

  const { suffix, label } = target(platform, arch);
  step(`This machine: ${bold(`${platform} ${arch}`)} — ${label}`);

  const endpoint = options.tag
    ? `https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(options.tag)}`
    : `https://api.github.com/repos/${REPO}/releases/latest`;

  const release = JSON.parse(await getText(endpoint, { accept: 'application/vnd.github+json' }));
  step(`Release ${bold(release.tag_name)}${release.published_at ? dim(`  ${release.published_at.slice(0, 10)}`) : ''}`);

  const asset = pickAsset(release.assets, suffix);

  // The checksum comes from the release itself, so a download that was truncated
  // or tampered with in transit is caught before anything is executed.
  let expected = null;
  const manifest = pickManifest(release.assets, platform);
  if (manifest) {
    try {
      expected = sha512For(await getText(manifest.browser_download_url, {}), asset.name);
    } catch {
      // A manifest that will not download is not a reason to refuse to install;
      // it only costs the verification, which is reported honestly below.
    }
  }

  const directory = options.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'campus-connect-'));
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, asset.name);

  say('');
  say(`  ${dim(asset.name)}`);
  const { digest, size } = await download(asset.browser_download_url, file, asset.size);

  if (expected) {
    if (digest !== expected) {
      fs.unlinkSync(file);
      throw new Error(
        'The download does not match the checksum published with the release.\n' +
          'Nothing has been installed and the file has been deleted. Try again;\n' +
          'if it keeps happening, please open an issue.'
      );
    }
    step(`Verified against the release checksum ${dim('(sha512)')}`);
  } else {
    step(`Downloaded ${dim(`${(size / 1048576).toFixed(1)} MB`)} ${dim('— this release publishes no checksum to verify against')}`);
  }

  if (options.saveOnly) {
    say('');
    say(`  Saved to ${bold(file)}`);
    say('');
    return;
  }

  launch(file, platform);
  step('Launching the installer');

  say('');
  if (platform === 'win32') {
    say(dim('  Windows will warn about an unknown publisher — the app is not code-signed.'));
    say(dim('  Choose More info → Run anyway.'));
  } else if (platform === 'darwin') {
    say(dim('  Drag the app across, then right-click it and choose Open the first time.'));
  } else {
    say(dim('  The AppImage is now executable and starting. Move it wherever you like.'));
  }
  say('');
  say(dim(`  Install it on every device you want to connect, then create a room on one`));
  say(dim(`  and join it from the others.`));
  say('');
}

main().catch((error) => {
  say('');
  say(`${red('✖')} ${error.message}`);
  say('');
  process.exit(1);
});
