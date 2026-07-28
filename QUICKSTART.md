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
   | **Private** | Join code **or** password, then your approval | ✅ AES-256-GCM |

4. For a private room, set a password (at least 4 characters). This becomes the
   encryption key, so pick something you would not mind typing on the other
   machine.
5. Click **Create room**.

Open the **Members** tab to see the six-character **join code**.

### 3. Join from the second machine

The room appears in the left rail under **On this network**. Click it, then give
**either** the join code **or** the room password — whichever you were sent —
and press **Request access**.

If you supply only the join code, you will be admitted but the room stays
**Locked** until you enter the password, because the password is what decrypts
it. The dialog warns you before you submit.

Back on the first machine, the **Members** tab shows the request. Click
**Approve**.

> Not seeing the room? Use **Join a room** instead, or see
> [Troubleshooting](#troubleshooting).

**Or skip the credentials entirely.** On the first machine, open the **Members**
tab and look under **Devices on this network** — anything running the app nearby
is listed. Press **Invite**, and the other machine gets a prompt. Accepting puts
them in your approval queue, and you approve as usual.

An invitation carries no join code and no password, so it grants nothing on its
own. For an encrypted room they will still need the password to read anything.

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
| Find something in a long history | `Ctrl+F`, or the search box in the Clipboard tab |
| Keep an item forever | Hover it → pin. Pinned items are never cleared out by newer ones |
| Switch rooms without the mouse | `Ctrl+1` … `Ctrl+9` |
| Send a file | Chat tab → paperclip. Up to 50 MB |
| Let someone scan the join code | Members tab → **QR code** |
| Invite someone without sharing a code | Members tab → **Devices on this network** → **Invite** |
| Remove someone from a room | Members tab → **Remove** |
| Leave, or shut a room down | Members tab → **Leave room** / **Close this room** |
| Make the text bigger, or change the font | Settings → **Appearance** |
| Copy an item | Click it — the whole card copies |
| Send a file fast | Drag it onto the chat |
| Share the clipboard right now | `Ctrl + Enter` |
| Turn notifications off | Settings → **Notifications** |
| See how much disk it is using | Settings → **Storage** |
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
2. On device B, enter a **wrong code and a wrong password**. It must be rejected.
3. Enter **only the correct password**, leaving the code blank. A shows a pending
   request; approve it. B can read the room.
4. Copy text on A, paste on B. Copy an image on B, paste on A.
5. From another device, join with **only the correct join code**. It is admitted,
   but the room shows as **Locked** until the password is entered — the code
   grants membership, the password grants readability.
6. Remove a device from the room on A. Copy again on A — it must not receive it.

---

## Troubleshooting

<details>
<summary><strong>The other device never appears</strong></summary>

**Open Settings → Network first.** It tells you which of these it is instead of
leaving you guessing — it shows packets sent, packets received, the adapters
being broadcast to, and a plain sentence about what is wrong.

| What Network says | What it means |
|-------------------|---------------|
| "Another device is running a different version" | The two apps speak different protocol versions and ignore each other. **Install the same version on both.** |
| "Sending, but nothing is coming back" | Packets leave but none arrive: a firewall, or the network blocks device-to-device traffic |
| "Waiting for other devices" | Nothing has been heard yet — check the app is actually running on the other machine |
| "N devices reachable" | Discovery works; the problem is the join code, the password, or an unapproved request |

**Version mismatch is the most common cause** if you installed at different
times. Both machines must run the same release.

**Client isolation** is the next most common. University, hotel and public WiFi
frequently stop devices from talking to each other at all, by design. No
LAN application can work through it. To confirm, connect both machines to a
phone hotspot — if it works there, the network was the problem.

Also worth checking:

- **Firewall.** On Windows the prompt appears on first run and is easy to
  dismiss by accident. Allow the app on both machines, for private networks.
- **Same network, really.** Not one on a guest SSID and one on the main one,
  and not one on 5 GHz with band isolation.
- **Settings → Network → Test a connection.** Enter the other machine's address
  and it reports which transports survive your network:

  | Result | What it means |
  |--------|---------------|
  | Both transports reach it | The network is fine — the problem is the credentials or an unapproved request |
  | Reachable, but UDP is filtered | Add it by address; everything runs over the direct connection |
  | UDP works, direct connections do not | Discovery and sync work normally |
  | Nothing reaches that device | The app is not running there, a firewall is blocking it, or the network separates its clients |

- **Add a device by IP** opens a direct TCP connection as well as UDP, so it
  works even where UDP is filtered entirely. Each machine shows its own address
  in that same panel.
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

Items up to 16 MB are split into chunks and reassembled automatically, and
anything the network drops is requested again — so this normally just works.

If a big item still does not arrive, it is usually a very lossy network. Check
the log for "Abandoned incomplete transfer". Moving closer to the access point,
or adding the other device by IP so chunks are unicast rather than broadcast,
both help. Past 16 MB the item is refused outright and the app says so.
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
