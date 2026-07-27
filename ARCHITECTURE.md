# Shared Clipboard — Architecture & Developer Guide

## 1. Overview

**Shared Clipboard** is a cross-platform desktop application (Electron + TypeScript + React) that
synchronises the clipboard and a chat channel between laptops on the same local network. Copy on one
machine, press `Ctrl+V` on another.

Sharing is scoped to **rooms**. A room is the privacy boundary: nothing is shared outside the room
you have selected, and a room protected by a password is encrypted end to end so that devices
without the password cannot read it even though they receive the same broadcast packets.

### Feature summary

| Area | Capability |
|------|-----------|
| Clipboard | Real-time text and image sync, scoped to one room at a time |
| Rooms | Public (open) and private (join code **or** password, plus owner approval) |
| Security | AES-256-GCM per room, key derived from the password with scrypt |
| Membership | Owner-authoritative roster, approval queue, remove member, leave/close room |
| History | Per-room clipboard history and chat, persisted across restarts |
| Discovery | UDP broadcast on the LAN, plus manual connection by IP |
| Desktop | System tray, start on login, light/dark theming |

---

## 2. Technology stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | Electron 35 |
| Language | TypeScript 5.8 (strict) |
| UI | React 19 |
| Bundler | Vite 6 (renderer), `tsc` (main process) |
| Transport | Node.js `dgram` (UDP), no external networking library |
| Cryptography | Node.js `crypto` — scrypt + AES-256-GCM, no external crypto library |
| Persistence | electron-store |
| Packaging | electron-builder (NSIS / DMG / AppImage) |

---

## 3. Directory structure

```
shared-clipboard-desktop/
├── src/
│   ├── main/                     # Electron main process (Node context)
│   │   ├── main.ts               # App lifecycle, UDP protocol, IPC handlers
│   │   ├── preload.ts            # contextBridge — the only renderer↔main channel
│   │   ├── crypto.ts             # scrypt derivation, AES-256-GCM, join codes, proofs
│   │   ├── transfer.ts           # Chunk splitting and reassembly for large payloads
│   │   ├── roomManager.ts        # Rooms, keys, membership, adverts, persistence
│   │   ├── historyManager.ts     # Clipboard/chat history with per-room caps
│   │   ├── clipboardStore.ts     # Electron clipboard read/write
│   │   ├── systemInfo.ts         # Device name from the OS
│   │   └── global.d.ts           # window.sharedClipboard typing
│   ├── renderer/                 # React UI
│   │   ├── main.tsx              # React entry point
│   │   ├── App.tsx               # Root component, state, events, routing
│   │   ├── sidebar.tsx           # Room rail, discovery, device card
│   │   ├── panels.tsx            # Clipboard / Chat / Members panels
│   │   ├── modals.tsx            # Create, Join, Unlock, Settings dialogs
│   │   ├── ui.tsx                # Button, Field, Modal, Switch, Badge, …
│   │   ├── icons.tsx             # Inline SVG icon set
│   │   ├── fonts.ts              # System font discovery for the font picker
│   │   ├── format.ts             # Time, initials, password strength
│   │   ├── styles.css            # Design tokens + all component styles
│   │   └── index.html
│   └── shared/
│       ├── types.ts              # Domain + wire types (shared by both processes)
│       └── bridge.ts             # The IPC API contract
├── test/
│   └── run.js                    # Test suite — plain Node, no framework
├── docs/                         # GitHub Pages site (index.html + screenshots)
├── .github/                      # CI, issue forms, pull request template
├── tsconfig.main.json            # Main process build (CommonJS → dist/main)
├── tsconfig.renderer.json        # Renderer typecheck (Vite does the build)
├── vite.config.ts
└── package.json                  # Scripts + electron-builder config
```

The two `tsconfig` files exist because the processes have different module systems and different
globals. `src/shared` is compiled into both.

---

## 4. Process model

```
┌──────────────────────── Main process (Node) ─────────────────────────┐
│                                                                      │
│  clipboardStore ──poll 1s──▶ main.ts ──seal──▶ dgram socket :37777  │
│                                  │                     ▲             │
│  roomManager  ◀──────────────────┤                     │             │
│  historyManager ◀────────────────┤              inbound datagrams    │
│  crypto ◀────────────────────────┘                                   │
│                                  │                                   │
│                            ipcMain.handle                            │
└──────────────────────────────────┼───────────────────────────────────┘
                                   │  contextBridge (preload.ts)
┌──────────────────────────────────┼───────────────────────────────────┐
│                      Renderer process (Chromium)                     │
│   App.tsx ── sidebar / panels / modals ── window.sharedClipboard     │
└──────────────────────────────────────────────────────────────────────┘
```

`contextIsolation: true` and `nodeIntegration: false`. The renderer has no Node access; every
privileged operation goes through a named IPC channel declared in `src/shared/bridge.ts`.

---

## 5. Security design

This is the part of the system worth understanding first, because the room model only means
something if these four rules hold.

### 5.1 Room types

| Type | Password | Discoverable | To join | Traffic |
|------|----------|--------------|---------|---------|
| Public, no password | — | Yes | One click | Plain text |
| Public, with password | Optional | Yes | **Password only** | AES-256-GCM |
| Private | **Required** (≥ 4 chars) | Yes (name only) | Join code **or** password, plus **owner approval** | AES-256-GCM |

**Either credential admits you to a private room.** The join code cannot always
be passed along — read out over a call, or typed on a machine you are not
sitting at — so knowing the password is sufficient on its own, and vice versa.

They are not equivalent in what they unlock. The password *is* the room key, so
a device admitted on the join code alone is a member of a room it cannot yet
read; `isLocked` is true and the interface shows the unlock screen until the
password is supplied. The join dialog says so before you submit.

A **public** encrypted room admits on the password alone and never on the code:
public rooms auto-accept, so the password is the only gate there is. A private
room can afford to be looser because owner approval is still in the way.

Private rooms require a password by design: "approval required" is meaningless if anyone who
receives the broadcast can decrypt it anyway.

### 5.2 Key derivation

```
roomKey = scrypt(password, keySalt, 32 bytes, N=32768, r=8, p=1)
```

`keySalt` is 16 random bytes generated when the room is created. It is public — it travels in the
room advert — and is useless without the password. The scrypt cost is deliberately high enough
(~100 ms) that brute-forcing captured traffic is expensive, while a human joining a room does not
notice it.

**The password is never transmitted.** It exists only as an input to scrypt on each device.

### 5.3 Message sealing

Every body belonging to an encrypted room travels as an `Envelope`:

```ts
type Envelope = { iv: string; tag: string; data: string };
```

- `iv` — 12 random bytes, fresh per message (never reused; verified by test).
- `data` — AES-256-GCM ciphertext of the JSON body.
- `tag` — GCM authentication tag, so tampering is detected, not just decryption failure.

A wrong key, a corrupted packet, or a modified one all decrypt to `null` and the packet is dropped.

### 5.4 Proving password knowledge without sending it

When a device asks to join an encrypted room it derives the key and seals a known constant:

```
proof = AES-256-GCM(roomKey, "shared-clipboard:proof:<roomId>")
```

The owner opens it with its own key and compares against the expected plaintext using
`timingSafeEqual`. Only a device holding the right key can produce an envelope the owner can open,
so the owner learns "this device knows the password" without the password ever crossing the wire.
Binding the proof to the `roomId` stops a proof captured from one room being replayed at another.

### 5.5 The admission gate

Before any inbound clipboard or chat packet is applied, `handleRoomPayload` in `main.ts` requires
**all four** of:

1. The room exists on this device.
2. **We** are an `accepted` member of it.
3. The **sender** is an `accepted` member of it, according to our own roster.
4. For an encrypted room, the body actually opens with our key.

Anything else is dropped and logged. This is what makes a private room private — without step 3 a
non-member's packet would be applied simply because it arrived.

### 5.6 Roster authority

The room **owner** is the single source of truth for who is in the room. Members never edit their
own copy of the roster; they replace it wholesale from a `room-roster` message, and only when that
message came from the owner's device id. If a roster arrives that no longer contains this device as
accepted, the room and its key are deleted locally.

### 5.7 Join codes

Six characters from a 31-symbol alphabet with `0/O/1/I/L` removed, drawn from
`crypto.randomBytes` using **rejection sampling** so every character is equally likely
(≈ 887 million codes). The previous implementation used `Math.random().toString(36)`, which is
neither cryptographically random nor uniform.

### 5.8 What is *not* protected

State these honestly rather than overclaiming:

- **Room names and owner names are public.** Adverts are broadcast in the clear so devices can
  discover rooms. The roster, the join code, and all content are not.
- **Traffic analysis.** An observer sees that a room is busy and how large its messages are.
- **Derived keys are cached on disk** in electron-store so you do not retype the password on every
  launch. Anyone with access to your user profile can read them. Delete the room to remove its key.
- **Unencrypted public rooms are plain text** by definition. The UI labels them "Not encrypted".
- **Device identity is a UUID**, not a certificate. A device that has been removed cannot decrypt
  new traffic, but nothing stops it presenting a fresh UUID and asking to join again.

---

## 6. Network protocol

UDP on port **37777**, broadcast plus unicast to known member hosts (so a network that blocks
broadcast still works). Every datagram is JSON and carries `v: 2`; mismatched versions are ignored.

### 6.1 Message types

| Type | Direction | Purpose |
|------|-----------|---------|
| `announce` | broadcast, every 3 s | Presence, so peers learn each other's host/port |
| `room-advert` | owner → broadcast, every 3 s | Public room metadata for discovery |
| `room-request` | joiner → owner | Ask to join; carries join code and/or proof |
| `room-accept` | owner → joiner | Admitted; carries the full roster |
| `room-reject` | owner → joiner | Refused; carries a human-readable reason |
| `room-roster` | owner → members | Authoritative roster after any change |
| `room-leave` | member → owner | Voluntary departure |
| `room-closed` | owner → members | Room deleted |
| `clipboard` | member → room | Clipboard payload |
| `chat` | member → room | Chat message |
| `chunk` | sender → room | One piece of a message too large for a datagram |
| `chunk-nack` | receiver → sender | The pieces that never arrived, please resend |
| `room-invite` | owner → one device | An invitation. Unicast, and carries no credentials |
| `room-invite-accept` | invitee → owner | Accepted; the owner still has to approve |
| `room-invite-decline` | invitee → owner | Declined |

### 6.2 The advert is deliberately thin

```ts
type RoomAdvert = {
  roomId; name; type; ownerId; ownerName;
  keySalt;        // public, useless without the password
  encrypted;      // whether a password is set
  memberCount;    // accepted members only
  createdAt;
};
```

It contains **no roster and no join code**. `RoomManager.toAdvert()` builds it, and a test asserts
the join code cannot appear anywhere in the serialised advert.

### 6.3 Private room join flow

```
Device B                                   Device A (owner)
   │                                              │
   │  sees room-advert (name, keySalt, encrypted) │
   │                                              │
   │  user enters the join code, the password,    │
   │  or both                                     │
   │  key = scrypt(password, keySalt)             │
   │  proof = seal(key, "proof:<roomId>")         │
   │                                              │
   ├──── room-request { joinCode?, proof? } ─────▶│
   │                                              │  joinCode matches OR proof opens?
   │                                              │      neither ────────▶ room-reject
   │                                              │  yes → add member as 'pending'
   │                                              │        notify the UI
   │                                              │
   │                                              │  owner clicks Approve
   │◀──── room-accept { sealed(roster) } ─────────┤
   │                                              │
   │  saves room + roster, marks itself accepted  ├──── room-roster ────▶ other members
   │                                              │
   │◀════ sealed clipboard / chat ═══════════════▶│
```

A public encrypted room is the same flow minus the join code and minus the approval step — the
owner accepts immediately once the proof verifies.

### 6.4 Invitations

An owner can invite a device it can see on the network rather than passing on a
code. The invitation carries the room advert and nothing else — **no join code,
no password** — so it grants nothing by itself, and it is unicast rather than
broadcast so the network is not told who was invited to what.

```
Owner                                            Invited device
  │  sees the device in `peers`
  ├──── room-invite { advert, targetDeviceId } ────▶│
  │                                                 │  user accepts or declines
  │◀─── room-invite-accept ─────────────────────────┤
  │  invitation outstanding?  ── no ──▶ ignored
  │  yes → member added as 'pending'
  │
  │  owner approves, exactly as for any other request
  ├──── room-accept ───────────────────────────────▶│
```

An acceptance is only honoured against a live record of an invitation the owner
actually sent, so nobody can put themselves in an approval queue by claiming to
have been invited. Those records are in memory with a 30-minute expiry: an
invitation does not need to survive a restart, and the owner can always send
another.

Accepting is not joining. The device becomes *pending* and the owner approves it
like any other request — which is the point, since the acceptance arrives over
the same network as everything else. And for an encrypted room the invitee still
needs the password before it can read anything.

### 6.5 Chunked transfer

A UDP datagram tops out at 64 KB, so anything larger is serialised, split into 8 KB pieces, and sent
as individual `chunk` messages. `ChunkAssembler` (`src/main/transfer.ts`) rebuilds the original JSON
and feeds it back through `handleWireMessage`, so **a reassembled message goes through exactly the
same membership and decryption checks as a single-datagram one**. Reassembly happens before
decryption, so the GCM auth tag still covers the whole payload.

Beyond 16 MB the transfer is refused outright and reported to the user.

**Reliability.** UDP guarantees neither ordering nor delivery. The receiver runs a 300 ms sweep; a
transfer that has been quiet for 500 ms triggers a `chunk-nack` listing the missing indices, and the
sender re-sends just those. A transfer making no progress for 20 seconds is abandoned and the user
is told.

**Why 8 KB, and why the socket buffers.** Both numbers were measured, not guessed. With the OS
default socket buffers a 3 MB transfer lost roughly **half** its datagrams to buffer overflow before
they ever reached the wire; raising `recvBufferSize`/`sendBufferSize` to 8 MB took that to zero.
Chunk size then barely affected loss, but 40 KB datagrams IP-fragment into ~28 pieces each, so one
lost fragment costs the whole 40 KB — 8 KB keeps that amplification small. Measured end to end, an
8.9 MB encrypted payload now arrives in 1.8 s with no retransmissions at all, against 5.9 s and 228
resent chunks before tuning.

**Memory safety.** A hostile device could otherwise use chunking to exhaust memory, so the assembler
caps single messages (20 MB), total buffered bytes across all transfers (64 MB), concurrent
transfers (24), and chunk count (4096). A transfer that would breach a limit is dropped rather than
evicting someone else's. Completed transfer ids are remembered briefly, because chunks are broadcast
*and* unicast — without that, the duplicate set would reassemble and deliver the same message twice.

---

## 7. Core modules

### `crypto.ts`
Pure functions, no Electron imports, fully unit-testable.

| Function | Purpose |
|----------|---------|
| `generateSalt()` | 16 random bytes, hex |
| `generateJoinCode()` | 6 chars, unbiased rejection sampling |
| `normalizeJoinCode(code)` | Upper-cases and strips separators from user input |
| `deriveRoomKey(password, salt)` | scrypt → 32-byte key |
| `seal(key, text)` / `open(key, env)` | AES-256-GCM; `open` returns `null` on any failure |
| `sealJson` / `openJson` | JSON convenience wrappers |
| `createProof` / `verifyProof` | Password-knowledge proof bound to a `roomId` |

### `roomManager.ts`
Owns rooms, derived keys, and discovered adverts. Persists through a `RoomPersistence` interface so
it has no dependency on electron-store (which is what makes it testable).

Key methods: `createRoom`, `saveRoom`, `deleteRoom`, `getKey`/`setKey`, `isLocked`,
`isAcceptedMember`, `isOwner`, `addPendingMember`, `addAcceptedMember`, `approveMember`,
`removeMember`, `toAdvert`, `recordAdvert`, `getDiscoveredRooms`.

Invariants worth knowing:
- `removeMember` refuses to remove the owner.
- `addPendingMember` returns `undefined` for an existing accepted member, so a re-request can never
  downgrade someone to pending or duplicate them.
- `isLocked(roomId)` is true when a room is encrypted but this device holds no key — the UI uses
  this to show the unlock screen.

### `historyManager.ts`
Per-room caps (100 clipboard entries, 500 chat messages) enforced **independently per room**, so a
busy room cannot evict a quiet one. Writes are debounced by 750 ms because the clipboard poller
would otherwise hit disk every second. Images larger than 256 KB stay in memory but are not written
to disk. Consecutive identical clipboard entries are suppressed, which is what stops the polled
clipboard producing duplicates.

---

## 8. IPC API

Declared once in `src/shared/bridge.ts` as `SharedClipboardApi`, implemented in `preload.ts`, and
used by the renderer as `window.sharedClipboard`. One contract, three consumers, no drift.

**State** — `getState`, `updateDeviceName`, `updateSettings`, `connectPeer`

**Rooms** — `roomCreate`, `roomRequestJoin`, `roomJoinByCode`, `roomUnlock`, `roomSwitch`,
`roomLeave`, `roomApproveMember`, `roomRejectMember`, `roomRemoveMember`

**History** — `historyGetClipboard`, `historyGetChat`, `historyDeleteEntry`, `historyClearRoom`

**Content** — `chatSend`, `readClipboard`, `clipboardApply`, `clipboardShareNow`

**Events** — `onStateChanged`, `onStatus`, `onChatMessage`, `onHistoryChanged`, `onJoinRequest`,
`onJoinResult`

Mutating calls return `ActionResult { ok, message }` rather than throwing, so the UI always has a
sentence to show the user. Each `on*` subscriber returns its own unsubscribe function.

---

## 9. User interface

### Layout

```
┌──────────┬────────────────────────────────────────────┐
│ Rooms    │ Room name  [Private] [Encrypted] [3]   ☀   │
│  rail    ├────────────────────────────────────────────┤
│          │ Clipboard │ Chat │ Members                  │
│ Discovery├────────────────────────────────────────────┤
│          │                                            │
│ + New    │            active panel                    │
│ ⚷ Join   │                                            │
├──────────┤                                            │
│ Device ⚙ │                                            │
└──────────┴────────────────────────────────────────────┘
```

The room rail is always visible, so the privacy boundary you are sharing into is never off-screen.

### Design system

`styles.css` opens with a token layer — spacing, radii, a type scale, and a palette — and every
component is built from those tokens. Light and dark are the same layout with a different palette,
declared three ways so the manual toggle always wins:

```css
:root                              { /* light */ }
@media (prefers-color-scheme: dark){ :root { /* dark */ } }
:root[data-theme='light']          { /* manual light */ }
:root[data-theme='dark']           { /* manual dark */ }
```

`App.tsx` sets `data-theme` on `<html>` from the persisted setting, or removes it for "System".

Conventions: one accent colour, 1px hairline borders, elevation via shadow rather than gradients,
visible `:focus-visible` rings, and `prefers-reduced-motion` honoured.

### Typography controls

Settings can change the text size and the font, and both work because every
component styles itself from the tokens rather than from literal values:

- **Text size.** Each type token is `calc(<base>px * var(--text-scale))`.
  `App.tsx` writes `--text-scale` onto `<html>`, so one value moves the entire
  scale together instead of leaving some labels behind. The main process clamps
  it to 0.9–1.3, so a bad stored value can never make the app unreadable.

- **Font.** Picking a family overrides `--font-sans` inline on `<html>`.
  `--font-mono` is deliberately left alone: clipboard contents and join codes
  stay monospaced whatever the interface font is.

`src/renderer/fonts.ts` discovers what is actually installed, in two ways:

1. **`queryLocalFonts()`** — Chromium's Local Font Access API returns the real
   list. It needs the `local-fonts` permission, granted in `main.ts` by a
   permission handler that denies everything else.
2. **Width measurement** — a fallback for when that API is unavailable or the
   permission is refused. A string rendered in `"Candidate", monospace` measures
   identically to plain `monospace` unless the candidate is genuinely installed.
   Comparing against all three generic families avoids false negatives.

The API call is raced against a 1.5 second timeout. Without a user gesture the
permission prompt can sit unanswered rather than rejecting, and a settings
dialog stuck on "Reading fonts…" is worse than a shorter list that appears
immediately.

### Screens

| Screen | Behaviour |
|--------|-----------|
| Clipboard | Newest first with pinned items on top, live search, copy-back, pin and delete per item |
| Chat | Own messages right-aligned; `column-reverse` keeps new messages at the bottom. Files and images render inline with a Save action |
| Members | Approval queue (owner), roster with Remove (owner), security summary, join code, leave/close |
| Locked room | Shown instead of the tabs when the key is missing — unlock, or leave |
| No room | Guides toward creating or joining a room |
| Modals | Create, Join, Unlock, Settings, and a confirm dialog for destructive actions |

Status messages arrive as toasts tinted by tone (`info` / `success` / `warning` / `error`).
Destructive actions — removing a member, closing or leaving a room, clearing history — go through a
confirm dialog.

**Keyboard.** `Ctrl+1` … `Ctrl+9` select a room; `Ctrl+F` focuses the history search. Both are
suppressed while a dialog is open or the caret is in a text field, so they can never fire in the
middle of typing a password.

**Files.** Picking and saving both go through the main process (`dialog.showOpenDialog` /
`showSaveDialog`), so a filesystem path never crosses the IPC boundary as untrusted renderer data.
Received files are never opened automatically — saving them is the user's decision.

The default Electron menu bar is removed (`Menu.setApplicationMenu(null)`); DevTools remain on
`F12` / `Ctrl+Shift+I`.

---

## 10. Data persistence

electron-store, at `%APPDATA%/shared-clipboard-desktop/config.json` on Windows:

```jsonc
{
  "deviceId": "uuid",
  "deviceName": "PARDHU-LAPTOP",
  "listenPort": 37777,
  "peers": [ /* recently seen, TTL 15 s */ ],
  "currentRoomId": "uuid",
  "settings": {
    "syncEnabled": true, "autoApply": true, "shareImages": true,
    "theme": "system", "fontScale": 1, "fontFamily": ""
  },
  "rooms": [ /* RoomInfo, including rosters */ ],
  "roomKeys": { "<roomId>": "<32-byte key as hex>" },
  "clipboardHistory": [ /* capped per room */ ],
  "chatHistory": [ /* capped per room */ ]
}
```

Rooms, keys, and history all survive a restart. On boot, a `currentRoomId` pointing at a room that
no longer exists is cleared.

---

## 11. Build & run

```bash
npm install
npm run dev           # tsc --watch + Vite + Electron
npm run typecheck     # both tsconfig projects
npm test              # the suite in test/run.js
npm run build         # dist/main + dist/renderer
npm run build:exe     # Windows NSIS installer
npm run package:mac   # DMG
npm run package:linux # AppImage
```

Compiled app code goes to `dist/`; electron-builder writes installers to
`release/`. They are deliberately separate — electron-builder's default output
is also `dist`, which would collide with the compiler's.

In development the main process loads `http://localhost:5173`; when packaged it loads
`dist/renderer/index.html`. This is decided by `app.isPackaged`, with `VITE_DEV_SERVER_URL` as an
override.

---

## 12. Testing

```bash
npm test
```

`crypto.ts`, `roomManager.ts`, and `historyManager.ts` are free of Electron imports, so `test/run.js`
requires them straight out of `dist/main` and runs in plain Node — no framework, no dependencies.
The behaviours it asserts:

**Crypto** — derivation is deterministic per (password, salt) and diverges when either changes;
seal/open round-trips; a wrong key returns `null`; flipping a byte of ciphertext or of the auth tag
is rejected; IVs never repeat; a proof verifies only with the right password and only for its own
room; join codes are uniformly distributed across the alphabet.

**Rooms** — a private room is encrypted, coded and owned; adverts leak neither roster nor join code
and count only accepted members; pending ≠ accepted; a re-request cannot downgrade or duplicate a
member; the owner cannot be removed; a removed member loses access; rooms and keys survive a
restart; a room whose key is absent reports as locked; a room you are in never appears as
discoverable.

**History** — history is scoped per room; repeated polls do not duplicate; per-room caps are
independent; clearing one room leaves others intact; chat messages dedupe by id on rebroadcast;
pinned items survive the cap, do not consume it, sort to the top, persist across restart, and become
evictable again when unpinned.

**Chunking** — split/join is lossless; chunks reassemble in any order; duplicates never
double-deliver; gaps are reported accurately and complete after retransmission; two senders reusing
a transfer id do not collide; a sender changing `total` mid-transfer is abandoned; malformed chunks
allocate nothing; the message, total-buffer, concurrency and chunk-count ceilings all hold; stalled
transfers are swept and their memory released; progress resets the deadline.

### Manual two-device test

1. Run the app on two laptops on the same WiFi.
2. On A, create a private room with a password. Note the join code (Members tab).
3. On B, the room appears under "On this network". Click it, enter the code and password.
4. **Enter the wrong password first** — B is rejected with "Incorrect room password." This is the
   demonstration that the password is enforced rather than decorative.
5. Enter the correct password. A shows the request in Members; approve it.
6. Copy text on A → paste on B. Copy an image on B → paste on A.
7. On A, remove B from the room. Copy on A again; B receives the packet but drops it, because B is
   no longer in the roster and no longer holds a valid membership.

---

## 13. Known limitations & next steps

| Limitation | Note / next step |
|-----------|------------------|
| Payloads over ~60 KB are not transmitted | Chunk large images across datagrams and reassemble |
| Chat file transfer | The type exists; the picker and transfer are not implemented |
| Derived keys cached on disk | Optionally hold keys in memory only, prompting per session |
| Room names are public | Advertise a hash instead, discoverable only by those who know the name |
| No forward secrecy | Rotating the password re-keys the room; consider per-session keys |
| Device identity is a UUID | Certificate pinning would stop a removed device rejoining anonymously |
| UDP only | A TCP fallback would work across subnets |

---

## 14. Contributing

1. TypeScript strict mode; avoid `any`.
2. Keep `main`, `renderer`, and `shared` separate. Anything crossing the boundary belongs in
   `src/shared`.
3. New IPC calls go in `src/shared/bridge.ts` **first**, then `preload.ts`, then `main.ts`.
4. New wire messages go in `WireMessageType` and must be handled in `handleWireMessage`.
5. Anything that touches a room's contents must pass through `handleRoomPayload`. Do not add a
   second path that applies remote data.
6. Style with existing tokens from `styles.css` rather than literal colours or pixel values.
7. `npm run typecheck` must pass, and two-device testing is expected before merging.
