# Quick Start

Two paths: **using** the app, and **developing** it. Pick whichever you came for.

---

## Using it (5 minutes)

### 1. Install

Download the build for your platform from the
[Releases page](https://github.com/Vijayapardhu/Clipboard/releases), or build it
from source (see below).

Do this on **both** machines you want to sync.

> On Windows, SmartScreen will warn you because the installer is not
> code-signed. Choose **More info → Run anyway**, or build from source if you
> would rather not.

### 2. Create a room on the first machine

Rooms are the privacy boundary — nothing is shared outside the room you have
selected.

1. Click **New room**.
2. Give it a name.
3. Choose the access type:

   | Type | Who can join | Encrypted |
   |------|-------------|-----------|
   | **Public**, no password | Anyone on the network, instantly | ❌ Plain text |
   | **Public**, with password | Anyone with the password | ✅ AES-256-GCM |
   | **Private** | Join code **+** password **+** your approval | ✅ AES-256-GCM |

4. For a private room, set a password (at least 4 characters). This becomes the
   encryption key, so pick something you would not mind typing on the other
   machine.
5. Click **Create room**.

Open the **Members** tab to see the six-character **join code**.

### 3. Join from the second machine

The room appears in the left rail under **On this network**. Click it, enter the
join code and the password, and press **Request access**.

Back on the first machine, the **Members** tab shows the request. Click
**Approve**.

> Not seeing the room? Use **Join with a code** instead, or see
> [Troubleshooting](#troubleshooting).

### 4. Copy and paste

That is it. Copy something on one machine and press `Ctrl+V` on the other.

Everything shared collects in the room's **Clipboard** tab, so you can go back
and re-copy something from an hour ago.

---

## Day-to-day tips

| I want to… | Do this |
|-----------|---------|
| Stop sharing for a moment (about to copy a password) | Tray icon → uncheck **Share my clipboard**, or Settings |
| Collect items without them overwriting my clipboard | Settings → turn off **Paste automatically** |
| Re-copy something from earlier | Clipboard tab → hover an item → copy button |
| Remove someone from a room | Members tab → **Remove** |
| Leave, or shut a room down | Members tab → **Leave room** / **Close this room** |
| Make the text bigger, or change the font | Settings → **Text size** and **Font** |
| Quit properly | Right-click the tray icon → **Quit** (closing the window only hides it) |

---

## Developing it

### Prerequisites

- [Node.js 20 or newer](https://nodejs.org)
- Git
- Ideally two machines on the same network — clipboard sync is hard to test
  properly with one

### Set up

```bash
git clone https://github.com/Vijayapardhu/Clipboard.git
cd Clipboard
npm install
npm run dev
```

`npm run dev` starts three processes together: `tsc --watch` for the main
process, the Vite dev server for the interface, and Electron itself. Editing
anything under `src/renderer` hot-reloads. Editing `src/main` recompiles, but
Electron has to be restarted to pick it up.

### Commands

| Command | What it does |
|---------|--------------|
| `npm run dev` | Run with hot reload |
| `npm run typecheck` | Typecheck both the main and renderer projects |
| `npm test` | Run the suite over crypto, rooms and history |
| `npm run build` | Compile to `dist/` |
| `npm run build:exe` | Windows installer into `release/` |
| `npm run package:mac` | macOS DMG |
| `npm run package:linux` | Linux AppImage |

### Where to look first

| I want to change… | Start in |
|-------------------|----------|
| How the interface looks | `src/renderer/styles.css` — everything is driven by the tokens at the top |
| A screen or panel | `src/renderer/panels.tsx` |
| A dialog | `src/renderer/modals.tsx` |
| Encryption or key handling | `src/main/crypto.ts` |
| Rooms, membership, approval | `src/main/roomManager.ts` |
| The network protocol | `src/main/main.ts` — `handleWireMessage` and below |
| The renderer↔main API | `src/shared/bridge.ts` first, then `preload.ts`, then `main.ts` |

Read [ARCHITECTURE.md](ARCHITECTURE.md) before changing anything in `src/main`.
Section 5 covers the security model the rest of the code relies on.

### The manual test that catches most regressions

1. Create a private room on device A with a password. Note the join code.
2. On device B, enter the code with the **wrong** password. It must be rejected.
3. Enter the correct password. A shows a pending request; approve it.
4. Copy text on A, paste on B. Copy an image on B, paste on A.
5. Remove B from the room on A. Copy again on A — B must not receive it.

---

## Troubleshooting

<details>
<summary><strong>The other device never appears</strong></summary>

Almost always the network blocking UDP broadcast. University and corporate WiFi
often have "client isolation" or "AP isolation" turned on, which stops devices
talking to each other at all.

- **Settings → Add a device by IP** connects directly. Find the other machine's
  address at the bottom of its own Settings dialog.
- A phone hotspot works well for testing.
- Check both machines are actually on the same network — not one on a guest SSID.
- Allow the app through the firewall on both machines. On Windows the prompt
  appears on first run and is easy to dismiss by accident.
</details>

<details>
<summary><strong>Joining fails with "Incorrect room password"</strong></summary>

That message means what it says: the proof your device built did not open on the
owner's side. Passwords are case-sensitive. Re-check it on the machine that
created the room — the owner can always see the join code in the Members tab,
but the password is not recoverable, so if it is lost the room has to be
recreated.
</details>

<details>
<summary><strong>A room says "Locked — password needed"</strong></summary>

The room is encrypted and this device does not hold its key — usually after
reinstalling, or setting up on a new machine. Select the room and enter the
password to unlock it. If you no longer have it, leave the room and rejoin.
</details>

<details>
<summary><strong>Clipboard is not syncing even though both devices are in the room</strong></summary>

Work through these in order:

1. Is **Share my clipboard** on? Check the tray icon and Settings.
2. Is the same room selected on the sending device? Sharing goes to the selected
   room only.
3. Is the receiving device an **accepted** member, not still pending? Check the
   Members tab on the owner's machine.
4. Is **Paste automatically** off on the receiving device? Items will be
   collecting in the Clipboard tab instead.
5. Is the item too large? Anything above roughly 60 KB will not fit in a UDP
   datagram; the app shows a warning when this happens.
</details>

<details>
<summary><strong>Large screenshots do not arrive</strong></summary>

A UDP datagram maxes out at 64 KB. Larger items stay in local history but are
not transmitted, and the app tells you so. Chunked transfer is on the roadmap
and would be a good first contribution.
</details>

<details>
<summary><strong><code>npm run dev</code> opens a blank window</strong></summary>

Vite has probably not finished starting. `dev:electron` waits for both
`dist/main/main.js` and `http://localhost:5173`, so give it a few seconds on a
cold start. If the window stays blank, press `F12` and check the console.
</details>

<details>
<summary><strong>"Electron failed to install correctly"</strong></summary>

The Electron binary did not download during `npm install` — common behind a
proxy or on a slow connection.

```bash
node node_modules/electron/install.js
```

Or delete `node_modules` and run `npm install` again.
</details>

---

## Next steps

- [README](README.md) — what the project is and who it is for
- [ARCHITECTURE](ARCHITECTURE.md) — how it works internally
- [API_REFERENCE](API_REFERENCE.md) — IPC calls and the wire protocol
- [CONTRIBUTING](CONTRIBUTING.md) — setup, rules, and good first tasks
- [SECURITY](SECURITY.md) — the threat model, and what is deliberately not covered
