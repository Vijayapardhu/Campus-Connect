# Building & Releasing

How to turn the source into installers and get them in front of people.

For *using* the app or setting up a dev environment, see
[QUICKSTART.md](QUICKSTART.md). Runtime troubleshooting lives there too.

1. [Before you release](#before-you-release)
2. [Building](#building)
3. [Installer configuration](#installer-configuration)
4. [Publishing a release](#publishing-a-release)
5. [Code signing](#code-signing)
6. [Build problems](#build-problems)
7. [Performance notes](#performance-notes)

---

## Before you release

```bash
npm run typecheck    # both projects, zero errors
npm test             # all assertions pass
npm run build        # compiles cleanly
```

Then the manual pass that CI cannot do — clipboard sync is a two-device feature:

- [ ] Public room: create on A, join from B, copy both directions
- [ ] Private room: **wrong password is rejected**, correct one produces a
      pending request, approval grants access
- [ ] Removing a member takes effect — B no longer receives anything from A
- [ ] Restart both apps: rooms, keys and history survive
- [ ] Images sync; an oversized image produces the warning rather than silence
- [ ] Light and dark themes, and a non-default text size and font
- [ ] Tray: window closes to tray, "Share my clipboard" toggles, Quit exits
- [ ] Installed build works, not just `npm run dev`

The security-critical path is the private room test. If you only do one thing,
do that one.

---

## Building

```bash
npm run build          # compile only — dist/main + dist/renderer
npm run dist           # compile, then package for the current platform
npm run build:exe      # Windows NSIS installer
npm run package:mac    # macOS DMG
npm run package:linux  # Linux AppImage
```

### Where things land

| Directory | Contents | Committed? |
|-----------|----------|-----------|
| `dist/main/` | Compiled main process (CommonJS) | No |
| `dist/renderer/` | Bundled interface | No |
| `release/` | Installers | No |

`dist/` and `release/` are deliberately separate. electron-builder's default
output is also `dist`, which would collide with the compiler's — hence the
explicit `directories.output` in `package.json`.

### Cross-platform builds

**Build each platform on that platform.** macOS DMGs cannot be produced on
Windows, and Linux builds made on Windows have permission quirks. The
`package` job in [`.github/workflows/ci.yml`](.github/workflows/ci.yml) already
does all three on every push to `main` and uploads the results as artifacts —
that is the easiest way to get a macOS build if you do not own a Mac.

### Build output size

A packaged build is roughly 80–120 MB, nearly all of it Chromium. That is the
price of Electron and there is no meaningful way to reduce it. The application
code itself is a few hundred kilobytes.

---

## Installer configuration

All of it lives in the `build` block of `package.json`.

```jsonc
{
  "appId": "com.college.sharedclipboard",
  "productName": "Shared Clipboard",
  "artifactName": "${productName}-${version}-${os}-${arch}.${ext}",
  "files": ["dist/**/*", "package.json"],
  "directories": { "buildResources": "build", "output": "release" },
  "win":   { "target": "nsis", "signAndEditExecutable": false },
  "mac":   { "target": "dmg" },
  "linux": { "target": "AppImage" },
  "nsis": {
    "oneClick": false,                        // show a real installer, not a silent one
    "perMachine": false,                      // per-user, so no admin prompt
    "allowElevation": true,
    "allowToChangeInstallationDirectory": true,
    "createDesktopShortcut": true,
    "createStartMenuShortcut": true
  }
}
```

### Icons

Drop these into `build/` and electron-builder picks them up automatically:

| File | Platform | Size |
|------|----------|------|
| `icon.ico` | Windows | 256×256, multi-resolution |
| `icon.icns` | macOS | 512×512 |
| `icon.png` | Linux | 512×512 |

Without them you get the default Electron icon, which looks unfinished. The tray
icon is separate — it is generated inline as an SVG in `main.ts`.

### Bumping the version

`version` in `package.json` drives the artifact filename and the installer's
version metadata. Bump it before tagging a release; nothing does it for you.

---

## Publishing a release

1. Bump `version` in `package.json` and commit.
2. Tag it:
   ```bash
   git tag -a v0.2.0 -m "v0.2.0"
   git push origin v0.2.0
   ```
3. Build each platform, or download the artifacts from the CI run.
4. Draft a release on GitHub, attach the installers, and write notes that say
   what changed **for users** — not a commit log.
5. If the wire protocol changed, say so prominently. `PROTOCOL_VERSION` mismatches
   are ignored by design, so an un-upgraded device will simply stop seeing the
   upgraded one, and people need to know why.

### Release note template

```markdown
## What's new
- …

## Fixes
- …

## ⚠️ Upgrade note
This release changes the network protocol. Devices on older versions will not
see devices on this one — update every machine together.
```

---

## Code signing

The installers are **not signed**, because a certificate costs more than this
project has.

**What users see:** Windows SmartScreen shows "Windows protected your PC", and
they have to click *More info → Run anyway*. macOS refuses to open the app until
the user right-clicks it and chooses *Open*. This is worth saying plainly in the
release notes rather than letting people assume the download is broken.

**If you have certificates**, electron-builder picks them up from the
environment — nothing in the config needs to change:

| Variable | Platform |
|----------|----------|
| `CSC_LINK` | Path or base64 of the `.pfx` / `.p12` |
| `CSC_KEY_PASSWORD` | Its password |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | macOS notarisation |

Store them as repository secrets, never in the repo. Note that
`signAndEditExecutable: false` is currently set for Windows — remove it once you
actually have a certificate.

---

## Build problems

<details>
<summary><strong>"Electron failed to install correctly"</strong></summary>

The binary did not download during `npm install`, which is common behind a proxy.

```bash
node node_modules/electron/install.js
```

Or remove `node_modules` and reinstall. In CI, `ELECTRON_SKIP_BINARY_DOWNLOAD=1`
is set for the typecheck job on purpose — building and typechecking do not need
the binary, and skipping ~100 MB keeps CI fast. The packaging job does not skip it.
</details>

<details>
<summary><strong>The packaged app opens a blank window</strong></summary>

Almost always the renderer not being found. Check that:

- `npm run build` ran before packaging — `dist/renderer/index.html` must exist.
- `files` in the build config still includes `dist/**/*`.
- `base: './'` is still set in `vite.config.ts`. Absolute asset paths break under
  `file://`.

Press `F12` in the packaged app to see the actual error.
</details>

<details>
<summary><strong>electron-builder cannot find the icon</strong></summary>

Icons must be in `build/` (the `buildResources` directory) and named exactly
`icon.ico`, `icon.icns`, `icon.png`. A `.ico` that is only 32×32 is rejected —
it needs a 256×256 entry.
</details>

<details>
<summary><strong>The build succeeds but the app will not start</strong></summary>

Check `main` in `package.json` still points at `dist/main/main.js`. If the
TypeScript `outDir` or `rootDir` changes, that path moves and the mismatch is
silent until runtime.
</details>

<details>
<summary><strong>Windows Defender flags the installer</strong></summary>

Expected for unsigned NSIS installers, especially newly built ones with no
reputation. It is not a false positive you can fix without signing. Submitting
the binary to Microsoft for analysis helps over time.
</details>

---

## Performance notes

Things worth knowing before optimising anything:

| Behaviour | Current | Why |
|-----------|---------|-----|
| Clipboard polling | Every 1000 ms | Electron has no clipboard-change event. 1 s is imperceptible and cheap |
| Presence announcements | Every 3000 ms | Peers expire after 15 s, so three announcements are missed before a device disappears |
| History writes | Debounced 750 ms | The poller would otherwise hit disk every second |
| Persisted images | Skipped above 256 KB | Kept in memory, dropped from disk, so the config file cannot balloon |
| History caps | 100 clipboard / 500 chat **per room** | Per-room, so a busy room cannot evict a quiet one |
| Key derivation | scrypt N=32768, ~100 ms | Deliberately slow. Only runs on create, join and unlock — never per message |

Encryption itself is not a bottleneck: AES-256-GCM on a few kilobytes is
microseconds. If sync feels slow, it is the poll interval or the network, not
the cryptography.

---

## Related

- [QUICKSTART.md](QUICKSTART.md) — using the app, and runtime troubleshooting
- [ARCHITECTURE.md](ARCHITECTURE.md) — how it works internally
- [SECURITY.md](SECURITY.md) — threat model and reporting
- [CONTRIBUTING.md](CONTRIBUTING.md) — setup and project rules
