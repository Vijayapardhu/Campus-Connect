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
- [ ] A small image syncs, and a multi-megabyte one syncs too (chunked transfer)
- [ ] Something past 16 MB produces the warning rather than silence
- [ ] A chat file sends, and saves intact on the far side — checksum it
- [ ] Pinning survives 100+ newer items and a restart; search filters live
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
  "appId": "com.vijayapardhu.sharedclipboard",
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

## Code signing and "Unknown publisher"

The builds are **not code-signed**, so Windows shows:

> Microsoft Defender SmartScreen prevented an unrecognized app from starting.
> **Publisher: Unknown publisher**

### Why, and what does not fix it

Windows reads the publisher name **out of the digital signature**. There is no
manifest entry, registry key, or build setting that populates it. The following
are all already set and none of them change that dialog:

| Set | Where it does show |
|-----|--------------------|
| `CompanyName: Vijaya Pardhu` | Right-click the file → Properties → **Details** |
| `LegalCopyright`, `ProductName`, `LegalTrademarks` | Same place |
| The application icon | Explorer, taskbar, Start menu, installer |

So the file is fully attributed once it is on disk — but the pre-execution
warning needs a certificate. Anyone telling you otherwise is describing a way to
suppress the warning locally, not a way to earn the publisher name.

### What actually fixes it

| Option | Cost | Effect |
|--------|------|--------|
| **OV certificate** | Paid, annual | Publisher name appears. SmartScreen still warns until the binary builds download reputation |
| **EV certificate** | Paid, annual, higher | Publisher name appears and SmartScreen trusts it immediately |
| **[SignPath Foundation](https://signpath.org/)** | Free for open source | Same effect as OV, but a different integration — see below |
| **[Azure Trusted Signing](https://learn.microsoft.com/azure/trusted-signing/)** | Low monthly | Cheapest paid route, but individuals need verifiable identity history |
| Build from source | Free | No warning, because the user compiled it themselves |

### If you buy a certificate

`.github/workflows/release.yml` already reads these from repository secrets, so
the next release after you add them is signed with no workflow change:

| Secret | Platform |
|--------|----------|
| `CSC_LINK` | Base64 of the `.pfx` / `.p12` |
| `CSC_KEY_PASSWORD` | Its password |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | macOS notarisation |

To produce `CSC_LINK` from a `.pfx`:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("certificate.pfx")) | Set-Clipboard
```

Paste that as the secret value. The workflow prints a warning annotation on
every unsigned release, so an unsigned build is never a silent surprise.

> The signing variables must be **absent** rather than empty when no certificate
> is configured. Declaring `CSC_LINK: ${{ secrets.CSC_LINK }}` when the secret
> does not exist defines it as an empty string, and electron-builder then treats
> it as a path and fails the macOS build with `<workspace> not a file`. The
> workflow exports them from a preceding step only when they hold something.

### An unsigned build must not name a publisher

`build.win` deliberately does **not** set `signtoolOptions.publisherName`, and it
has to stay that way for as long as the installers are unsigned.

electron-builder copies that value into the `app-update.yml` it packages inside
the app. electron-updater reads it back on Windows and, when it is present, runs
`Get-AuthenticodeSignature` over the downloaded installer and rejects anything
whose signature does not match:

> New version 0.3.6 is not signed by the application owner: publisherNames:
> Vijaya Pardhu, raw info: { "SignerCertificate": null, … "Status": 2,
> "StatusMessage": "The file … is not digitally signed." }

So naming a publisher while shipping unsigned installers breaks auto-update
outright — every download is fetched in full and then thrown away. v0.3.6
shipped that way. With the setting absent and no certificate configured,
electron-builder omits `publisherName` from `app-update.yml`, electron-updater
skips the check, and the update installs.

Getting a certificate later needs no change here. electron-builder then derives
the publisher from the certificate's common name, writes that into
`app-update.yml`, and verification turns itself back on — which is the reason to
leave the name out rather than hardcode it. (`verifyUpdateCodeSignature: false`
silences the same error, but it would stay silenced after signing, which is worse
than the problem.)

One consequence worth knowing: the check runs in the **installed** app, against
the `app-update.yml` that shipped with it. An install that already carries the
bad file cannot repair itself and will go on rejecting every download. Those
users have to install one release by hand; auto-update works from there on.

### SignPath Foundation works differently

**SignPath does not give you a certificate file.** There is no `.pfx` to put in
`CSC_LINK`. They hold the key and sign your artifacts through their service, so
the integration is a build step, not an environment variable:

1. Build the installers unsigned and upload them as a workflow artifact.
2. Hand the artifact id to `signpath/github-action-submit-signing-request`.
3. SignPath fetches it, signs it, and returns the signed files.
4. Publish the signed files instead of the originals.

Concretely, in the `build` job, after the existing upload step:

```yaml
- name: Upload unsigned installer
  id: unsigned
  uses: actions/upload-artifact@v4
  with:
    name: installer-${{ matrix.label }}
    path: ${{ matrix.artifacts }}

- name: Sign with SignPath
  uses: signpath/github-action-submit-signing-request@v1
  with:
    api-token: ${{ secrets.SIGNPATH_API_TOKEN }}
    organization-id: ${{ secrets.SIGNPATH_ORGANIZATION_ID }}
    project-slug: clipboard
    signing-policy-slug: release-signing
    github-artifact-id: ${{ steps.unsigned.outputs.artifact-id }}
    wait-for-completion: true
    output-artifact-directory: signed
```

This is deliberately **not** in the workflow yet. It cannot be tested without an
approved SignPath account, and untested signing code in a release pipeline is a
good way to break releases. Apply first; wire it up once you are approved.

### Applying to SignPath Foundation

Their bar is that the project is genuinely open source and genuinely used. Be
aware that **a brand-new repository with no users is usually declined** — they
prioritise established projects. Realistically: publish releases, get the
project used, then apply.

What they will check, and where this project already stands:

| Requirement | Status |
|-------------|--------|
| OSI-approved licence | MIT |
| Public source repository | Yes |
| Built in public CI from public sources | GitHub Actions, `release.yml` |
| Reproducible, auditable build | Yes — no local build steps |
| No bundled proprietary components | Yes — no external crypto or network libraries |
| Identifiable maintainer | Vijaya Pardhu |
| Real usage | **This is the weak point today** |

### A self-signed certificate

Useful when you control the machines — a lab, a demo, your own devices. It
makes the publisher name appear **only on machines that trust your certificate**,
so it is not a distribution solution, but it removes the warning where it
matters to you.

```powershell
# Create it once, on the machine that will do the signing
$cert = New-SelfSignedCertificate -Type CodeSigningCert `
  -Subject "CN=Vijaya Pardhu" -CertStoreLocation Cert:\CurrentUser\My
$pw = ConvertTo-SecureString -String "choose-a-password" -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath signing.pfx -Password $pw

# Build with it
$env:CSC_LINK = "signing.pfx"; $env:CSC_KEY_PASSWORD = "choose-a-password"
npm run package:win
```

Then install `signing.pfx` into **Trusted Root Certification Authorities** on
each machine that should trust it. Do not ship this certificate or commit it.

### Icons

`build/icon.ico` is a 7-resolution icon (16 → 256) and `build/icon.png` is
512×512 for macOS and Linux. Regenerate them from the vector rather than
resizing a PNG by hand — a 16px icon downscaled from 1024 turns to mush.

> `signAndEditExecutable` must stay `true`. Setting it to `false` skips rcedit,
> which is what writes the icon *and* the version resource into the exe — that
> is why earlier builds had neither.

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
| History caps | 100 clipboard / 500 chat **per room** | Per-room, so a busy room cannot evict a quiet one. Pinned items are exempt |
| Key derivation | scrypt N=32768, ~100 ms | Deliberately slow. Only runs on create, join and unlock — never per message |
| Chunk size | 8 KB | 40 KB datagrams IP-fragment into ~28 pieces, so one lost fragment costs the whole 40 KB |
| Socket buffers | 8 MB send and receive | Measured: at the OS default a 3 MB transfer lost ~50% of its datagrams to buffer overflow. At 8 MB it loses none |
| Chunk pacing | 8 per 2 ms | Enough to stay ahead of the buffer without bursting into it |

Encryption itself is not a bottleneck: AES-256-GCM on a few kilobytes is
microseconds. If sync feels slow, it is the poll interval or the network, not
the cryptography.

---

## Related

- [QUICKSTART.md](QUICKSTART.md) — using the app, and runtime troubleshooting
- [ARCHITECTURE.md](ARCHITECTURE.md) — how it works internally
- [SECURITY.md](SECURITY.md) — threat model and reporting
- [CONTRIBUTING.md](CONTRIBUTING.md) — setup and project rules
