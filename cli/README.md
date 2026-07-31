# campus-connect

Installs [Campus Connect](https://github.com/Vijayapardhu/Clipboard) on your machine.

```bash
npx campus-connect
```

```
  Campus Connect

✔ This machine: win32 x64 — Windows installer
✔ Release v0.4.0  2026-07-31

  CampusConnect-0.4.0-win-x64.exe
  ██████████████████████████ 100%  83.4/83.4 MB
✔ Verified against the release checksum (sha512)
✔ Launching the installer
```

## What this package is

A few kilobytes that download the right installer and check it. **The app itself
is not in this package** — it is an 85MB Electron desktop app, and a registry is
the wrong place to keep four platform builds of it when any given machine wants
one.

So this reads the GitHub release, picks the build matching your platform and
architecture, downloads it, verifies it against the `sha512` the release
publishes, and hands it to your installer. Node's standard library only — no
dependencies.

## What Campus Connect is

A desktop app for the things two of your own devices need to do together, none
of which should require the internet:

- **Clipboard and files** — copy on one machine, paste on another
- **Rooms and chat**, encrypted with a password only members know
- **Voice and video calls** over WebRTC, peer to peer, no signalling server
- **Remote desktop** — see and control another machine, once it says yes
- **Your phone**, paired by scanning once, with the whole app in its browser

It works on a network with the internet unplugged.

## Options

| | |
|---|---|
| `--tag <tag>` | Install a specific release instead of the latest |
| `--dir <path>` | Where to put the download (default: a temporary folder) |
| `--save-only` | Download and verify, then stop without running it |
| `--help` | Usage |
| `--version` | Version of this installer |

## Platforms

| Platform | Build |
|---|---|
| Windows x64 | `.exe` installer |
| macOS Intel and Apple silicon | universal `.dmg` |
| Linux x64 | `.AppImage` |

Windows on ARM has no build. Rather than hand it the x64 one and let it fail
later, this says so and points you at [running from
source](https://github.com/Vijayapardhu/Clipboard#from-source).

## A note on the warning you will see

The installers are not code-signed, so Windows SmartScreen says "unknown
publisher" and macOS asks you to confirm. That is the absence of a certificate,
not a finding about the file — which is why this tool verifies the download
against the release checksum, and why the whole thing is open source.

MIT licensed. Built by [Vijaya Pardhu](https://github.com/Vijayapardhu).
