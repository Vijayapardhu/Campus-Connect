<div align="center">

# Campus Connect

**Your campus network, without the internet.**

Encrypted rooms for clipboard sync, chat, file transfer, calls and remote
desktop between devices on the same WiFi.
No cloud, no account, no data leaving your network.

[![CI](https://github.com/Vijayapardhu/Campus-Connect/actions/workflows/ci.yml/badge.svg)](https://github.com/Vijayapardhu/Campus-Connect/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](#installing)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

[**Website**](https://vijayaapardhu.dev/Clipboard/) ·
[**Architecture**](ARCHITECTURE.md) ·
[**Contributing**](CONTRIBUTING.md) ·
[**Security**](SECURITY.md)

<img src="docs/screenshots/clipboard-light.png" alt="Campus Connect showing a room's clipboard history" width="820">

</div>

---

## The problem

You are on a lab machine and you need a link from your own laptop. So you email
it to yourself. Or you message it to yourself on WhatsApp. Or you type out a
forty-character URL by hand and get one character wrong.

Everyone does this several times a day, and every workaround sends your
clipboard to a server that has no business seeing it.

**Campus Connect** removes the round trip. Copy on one machine, press `Ctrl+V`
on the other. Call the person two desks away and the audio takes one hop through
the switch. Nothing leaves the network you are already on — and none of it needs
the internet to work at all.

---

## What it does

- **Quick paste** — a system-wide hotkey opens your clipboard history over
  whatever app you are in, and pastes what you pick. Works with the window closed
- **Command palette** (`Ctrl+K`) — switch room, send a file, start a call, share
  a screen, without hunting through tabs
- **Snippets** — text you retype constantly, kept permanently and always one
  hotkey away
- **Search everything** (`Ctrl+Shift+F`) — clipboard history and chat, every room
  at once
- **Real-time clipboard sync** — text and images, across Windows, macOS and Linux
- **Rooms** decide who sees what. You are only ever sharing into one room at a time
- **End-to-end encryption** with AES-256-GCM, keyed by a password you choose
- **Approval-based private rooms** — the owner decides who gets in
- **Invite devices directly** — see who is on the network and invite them, instead
  of reading a code out loud
- **Built-in chat**, per room, with **file transfer** up to 50 MB and
  **delivered / seen** markers
- **Voice and video calls** over the LAN, up to six devices in a mesh — no STUN,
  no TURN, no server, and no internet connection
- **Screen and window sharing** into a call, picked from a thumbnail list
- **Remote desktop** — watch another machine's screen, or drive its mouse and
  keyboard, with per-session approval on the machine being shared
- **Block a device** and nothing it sends is read, stored, shown or answered again
- **Edit a room** after making it — rename it, change its type, reissue the join
  code, or change the password to lock out a device that should not have it
- **Notifications** with the popup and its sound on separate switches
- **Stays small on disk** — attachments are cleaned up on a schedule, the text is kept
- **Large transfers** — multi-megabyte images are chunked and reassembled, with
  automatic retransmission of anything the network drops
- **Clipboard history** that survives restarts, with search, pinning, and one-click copy back
- **QR codes** for join codes, so a phone can scan instead of typing
- **Two transports** — UDP for discovery, direct TCP for networks that filter it
- **No account, no server, no internet connection required**
- **Adjustable text size and font**, light and dark themes, keyboard shortcuts

---

## Who it is for

<table>
<tr>
<td width="50%" valign="top">

### Students

You have a laptop, the lab has a desktop, and your project needs both. Move
error messages, Stack Overflow links, API keys and code snippets between them
without emailing yourself.

Working in a group? Make a room for the team. Everyone's clipboard becomes a
shared scratchpad for the afternoon — and when the session ends, close the room
and it is gone.

</td>
<td width="50%" valign="top">

### Office and remote teams

Pair programming, shared debugging, moving a config value from a laptop to a
test machine. A private room with a password keeps it inside the room even
though everyone is on the same office WiFi.

For anyone handling things that should not touch a third-party server —
credentials, internal URLs, customer data — the fact that nothing leaves the
local network is the entire point.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### Anyone with more than one machine

Desktop and laptop. Work machine and personal machine. A Windows box and a Linux
box under the same desk. One public room, no password, and your clipboard
follows you between them.

</td>
<td width="50%" valign="top">

### Classrooms and workshops

An instructor can put a command or a link into a public room and thirty people
have it instantly, without reading it out character by character while everyone
mistypes it.

</td>
</tr>
</table>

---

## Screenshots

<table>
<tr>
<td width="50%"><img src="docs/screenshots/clipboard-dark.png" alt="Clipboard history in dark mode"><br><em>Clipboard history, dark mode</em></td>
<td width="50%"><img src="docs/screenshots/chat-files.png" alt="Room chat with a shared file"><br><em>Per-room chat with file transfer</em></td>
</tr>
<tr>
<td><img src="docs/screenshots/qr-code.png" alt="QR code for a room join code"><br><em>Scannable join codes</em></td>
<td><img src="docs/screenshots/clipboard-light.png" alt="Searching clipboard history with a pinned item"><br><em>Search and pinned items</em></td>
</tr>
<tr>
<td><img src="docs/screenshots/members-light.png" alt="Members panel with an approval queue"><br><em>Approval queue and member management</em></td>
<td><img src="docs/screenshots/create-room.png" alt="Create room dialog"><br><em>Creating a private, encrypted room</em></td>
</tr>
<tr>
<td><img src="docs/screenshots/locked-room.png" alt="A locked encrypted room"><br><em>An encrypted room this device has no key for</em></td>
<td><img src="docs/screenshots/settings.png" alt="Settings including text size and font"><br><em>Theme, text size and system font picker</em></td>
</tr>
</table>

---

## Installing

### One command

If you have Node installed:

```bash
npx campus-connect
```

That works out which of the four builds belongs on your machine, downloads it,
checks it against the `sha512` published with the release, and runs it. The
package is a few kilobytes — [`cli/`](cli) — and contains no application code;
the app itself stays in GitHub releases where it belongs.

### From an installer

Grab the latest build for your platform from the
[Releases page](https://github.com/Vijayapardhu/Campus-Connect/releases).

| Platform | File |
|----------|------|
| Windows 10/11 | `CampusConnect-x.y.z-win-x64.exe` |
| macOS (Intel and Apple silicon) | `CampusConnect-x.y.z-mac-universal.dmg` |
| Ubuntu / Linux | `CampusConnect-x.y.z-linux-x86_64.AppImage` |

### "Unknown publisher" — is it safe?

Windows will show **"Microsoft Defender SmartScreen prevented an unrecognized
app from starting — Publisher: Unknown publisher"**, and macOS will refuse the
first launch. This is expected and it is not a claim that anything is wrong with
the file.

Windows reads the publisher name out of a **code-signing certificate**. This
project does not have one yet, so the field is blank — that is all the warning
means. The file itself is fully attributed: right-click it, choose
**Properties → Details**, and it says `Vijaya Pardhu`.

To run it anyway:

| Platform | What to do |
|----------|-----------|
| Windows | **More info → Run anyway** |
| macOS | Right-click the app → **Open** → **Open** |
| Ubuntu | `chmod +x CampusConnect-*.AppImage` then run it |

If you would rather not take that on trust, **[build it from
source](#from-source)** — it takes a minute, and then the binary is one you
compiled yourself. That is the honest answer, and it is why the whole thing is
readable in an afternoon.

Signing is already wired into the release workflow, so this goes away as soon as
a certificate is in place.

### From source

Requires [Node.js 20+](https://nodejs.org).

```bash
git clone https://github.com/Vijayapardhu/Campus-Connect.git
cd Clipboard
npm install
npm run dev            # run it
npm run build:exe      # or build a Windows installer into release/
```

---

## Using it

### 1. Make a room

Rooms are the privacy boundary. Nothing is shared outside the room you have
selected.

| Room type | Who can join | Encrypted |
|-----------|-------------|-----------|
| **Public**, no password | Anyone on the network, instantly | No — plain text |
| **Public**, with password | Anyone who knows the password | AES-256-GCM |
| **Private** | Join code **or** password, then owner approval | AES-256-GCM |

You do not need both credentials for a private room — whichever one you were
given works. That matters when the code is awkward to pass on.

One caveat worth knowing: the password is what decrypts the room. Joining with
only the join code gets you in, but the room shows as **Locked** until you enter
the password. The app tells you this before you submit.

For anything you would not shout across the room, use a private room.

### 2. Bring in the other device

Open the app on the second machine. Rooms on the network appear under **On this
network**. Click one, enter the join code and password, and wait to be approved.
If it does not appear, use **Join with a code**.

### 3. Copy and paste

That is it. Copy on one machine, `Ctrl+V` on the other. Copied items build up in
the room's history, so you can go back and re-copy something from an hour ago.

### 4. Call someone in the room

The phone and camera buttons at the top of a room ring everyone in it. Whoever
answers first joins; anyone else can join afterwards from the banner that
appears, so a call does not have to be started twice.

In a call you can mute, turn the camera on and off, and share a screen or a
single window. Up to six devices at once.

### Handy details

- **Pause sharing** from the tray icon or Settings when you are about to copy a
  password.
- **Turn off automatic pasting** if you would rather items only collect in
  history until you pick one.
- **Remove someone** from a room at any time in the **Members** tab. They stop
  being able to read new messages immediately.
- **Block a device** from the same tab if removing it from one room is not
  enough — see [Blocking](#blocking) below.
- **Edit a room** from the **Members** tab if you own it: rename it, switch it
  between public and private, issue a new join code, or change the password.
- **Leave or close a room** from the same tab. Closing it removes it for everyone.
- **Silence notifications** without losing them: the popup and its sound have
  separate switches in Settings → Notifications, as does the ring for calls.

---

## The parts you use every day

Three features do most of the work. All of them are keyboard-first.

### Quick paste — `Ctrl+Shift+V`

The one that changes how the app feels. A small window appears over whatever you
are working in, listing what you have copied recently and your saved snippets.
Type to filter, <kbd>Enter</kbd> to take it — and it is pasted into the app you
were already in.

```
BEFORE                          AFTER

Alt-tab to Campus Connect       Ctrl+Shift+V
find the room             →     ┌──────────────────────┐
scroll the history              │ ⌕ deploy             │
click copy                      ├──────────────────────┤
alt-tab back                    │ 1 https://github.co… │
paste                           │ 2 npm run deploy     │
                                │ 3 [image] 340 KB     │
6 steps                         └──────────────────────┘
                                1 keystroke
```

It works **with the main window closed**, which for an app that lives in the
tray is most of the time. The shortcut is configurable in Settings → Snippets,
and auto-paste can be switched off if you would rather it only copied.

### Command palette — `Ctrl+K`

Everything the app can do right now, in one list. Switch room, share the
clipboard, send a file, start a voice or video call, share a screen, ask someone
for theirs, copy a snippet, change theme. Fuzzy matched, so `crm` finds
"Create room".

The list is built from the current state, so it only ever offers what is
actually possible — there is no entry that fails when you pick it.

### Search everything — `Ctrl+Shift+F`

One search across clipboard history **and** chat in **every** room, with the
match highlighted and the room named. <kbd>Enter</kbd> jumps to it. (Plain
`Ctrl+F` still filters just the room you are looking at.)

Type `>` in the command palette to get the same thing without a second shortcut.

### Snippets

The counterpart to history: history is what you happened to copy and ages out,
a snippet is what you decided to keep and does not. A build command, an API
endpoint, your student number.

Save one from any text item in the Clipboard tab, or write it in Settings →
Snippets. They are ranked by what you actually reach for, so the ones you use
surface first. **Local to your device and never sent anywhere.**

---

## Smarter clipboard

Copied text is shown as the thing it actually is, rather than as one grey
paragraph:

| What you copied | What you get |
|-----------------|--------------|
| `https://…` | A link, with an **Open** button |
| `#4f46e5` or `rgb(…)` | The colour, as a swatch |
| `npm run dev`, a function, a diff | A monospace block that keeps its whitespace |
| `{"a": 1, "b": 2}` | Labelled `JSON · 2 fields` |
| `someone@example.ac.uk` | Marked as an email address |

Detection is deliberately conservative — a wrong guess is worse than no guess,
so a sentence that merely *contains* a link is still a sentence. Only `http` and
`https` links can ever be opened; a clipboard can hold `file://` or
`javascript:`, and "open what the user copied" must not become "launch whatever
this string names".

---

## Calls

Two machines on the same network can already reach each other, so a call needs
nothing else. Campus Connect uses **WebRTC** with an empty ICE server list: the
peers exchange their own local addresses through the room's existing encrypted
channel and connect directly.

```
  Laptop A (192.168.1.10)                Laptop B (192.168.1.20)
        │                                          │
        │  call setup, sealed with the room key    │
        ├──────────── via the LAN ─────────────────┤
        │                                          │
        │  audio + video, SRTP, peer to peer       │
        ╞══════════════════════════════════════════╡
                          │
                  campus switch / AP
                   (no internet)
```

| | |
|---|---|
| **Transport** | WebRTC, direct peer-to-peer, SRTP-encrypted by the protocol itself |
| **Signalling** | The app's own UDP/TCP channel, sealed with the room key in an encrypted room |
| **ICE servers** | None. Host candidates only — which is why it works offline |
| **Audio** | Opus, with echo cancellation, noise suppression and gain control |
| **Video** | Whatever the two ends negotiate (VP8/VP9/H.264), 720p30 from a camera |
| **Screen share** | 1080p at 15fps — resolution matters for text, frame rate does not |
| **Participants** | Up to 6, full mesh |
| **Latency** | Single-digit to low tens of milliseconds on a LAN |

**Why six?** Every participant holds a connection to every other one, so the cost
grows with the square of the people in it. Past roughly six it is the video
encoders that give out, not the network. A mesh needs no server, which is the
whole point; a bigger call would need one.

**If a call will not connect** but chat works, the network is almost certainly
isolating its clients — access points on public and campus WiFi commonly refuse
to pass traffic between two devices connected to them. Settings → Network has a
test that tells you this in a few seconds. No application can work around it; a
phone hotspot will confirm it immediately.

---

## Remote desktop

The screen path is the same WebRTC connection a call uses. What is different is
everything around it, because letting another machine drive yours deserves more
than a share button.

### Asking, and being asked

Anyone in a room can ask a member for their screen — **Members** tab, the
**Screen** button next to a device. Asking shares nothing. On the other machine a
dialog names who is asking and offers three answers:

| Answer | What it does |
|--------|--------------|
| **Decline** | Nothing is shared |
| **Allow viewing** | They see the screen you picked, and nothing else happens |
| **Allow control** | They also move your mouse and type on your keyboard |

You choose **which screen** at the same time. There is no "share everything" and
no "always allow" — approval is per session, given by a person, and there is no
setting that can change that.

### Getting out

Three ways, all instant:

- **Take back control** in the bar at the top of the window — the session stays,
  they can still watch, they just stop being able to click.
- **Stop sharing** in the same bar.
- <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>X</kbd> — a global
  shortcut registered only while you are hosting. This is the one that matters:
  when someone else is moving your mouse, clicking a button in this app may be
  exactly what you cannot do.

While a session is live a bar sits at the top of the window and cannot be
dismissed. It is amber for viewing and red for control, because the difference
between being watched and being driven is the one thing you should never have to
wonder about.

Anything that ends the relationship ends the session too: blocking the device,
leaving the room, the owner closing it, the password being changed, switching
Campus Connect off, or quitting.

### What travels where

| | |
|---|---|
| **Screen** | WebRTC video, peer to peer, SRTP-encrypted — 1080p at 20fps |
| **Input** | A WebRTC **data channel**, DTLS-encrypted, ordered and reliable |
| **Setup** | The app's own protocol, sealed with the room key |

Input goes over a data channel rather than the app's UDP protocol because a mouse
being dragged produces events dozens of times a second, and putting all of those
through JSON, encryption and a broadcast socket would be absurd. Ordered and
reliable matters: an out-of-order mouse-up is a stuck button, and a dropped
key-up is a stuck key.

Coordinates cross as **fractions of the screen**, never pixels. Neither side has
to know the other's resolution, the viewer can be scaled to any size, and it
keeps working if the host changes resolution mid-session. On the host they are
clamped into the shared display's bounds, so a bad value cannot fling the pointer
onto another monitor.

### Platform support

Control needs a native module (`@jitsi/robotjs`) and an operating system willing
to accept synthetic input. Neither is guaranteed, so the app checks and offers
only what it can actually deliver — **viewing always works**, everywhere.

| Platform | Control |
|----------|---------|
| Windows | Yes. Windows will not let a normal app drive an elevated window, so a UAC prompt or an admin app cannot be clicked |
| macOS | After granting **Accessibility** under System Settings → Privacy & Security. Checked before control is offered |
| Linux (X11) | Yes |
| Linux (Wayland) | **No.** Wayland does not let applications send input events. There is no workaround; view-only is offered instead |

Whole screens only, never single windows. A window can be moved or covered at any
moment, so there is no honest way to map a click on a picture of it back to a
point on the desktop. Windows are still shareable **in a call**, where nobody is
clicking on them.

---

## Your phone

A phone cannot be a peer — a browser cannot hold the room key, and there is no
app to install. So instead your laptop serves **one room** as a small web page
on the same WiFi.

**Settings → Phone**, pick a room, switch it on. Scan the QR with the phone's
camera, enter the six-digit PIN once, and you get:

- The room's clipboard history — tap any item to copy it to the phone
- A box to send text or a link straight to the laptop's clipboard
- The room's chat, readable and writable

It works on any phone, needs no install, and needs no internet.

### Be clear about what this is

This is the one part of Campus Connect that is **not** end-to-end encrypted, and
the interface says so before you switch it on.

Traffic between two computers running Campus Connect is sealed with AES-256-GCM
and unreadable to anyone on the network. A phone browser has no room key, so the
laptop **decrypts the room and serves it as ordinary text over HTTP**. Anyone who
can watch traffic on that WiFi could read what the phone reads.

There is no honest way around that without a certificate you would have to click
through a browser warning to accept, which teaches exactly the wrong habit. So
the exposure is bounded instead:

| | |
|---|---|
| **Off by default** | Nothing is served until you switch it on, for one room you pick |
| **PIN** | Six digits, new every time you switch it on, asked once per phone |
| **Rate limited** | 5 wrong guesses locks it for 5 minutes — without this a 6-digit PIN falls in seconds |
| **Expires** | 30 minutes idle, 8 hours maximum, whatever happens |
| **Revocable** | Disconnect any phone from the desktop, or switch the whole thing off |
| **Scoped** | One room. Not your other rooms, not your snippets, not your other devices |

Switch it off when you are done, and do not leave it on for a room you would
mind the network seeing.

---

## Blocking

Blocking is about a device, not a room. Once blocked:

- Nothing it sends is read, stored, shown or answered — in any room, including
  rooms you are both in
- It is removed from every room **you own**
- It disappears from the device list and cannot ring you

The one thing it cannot do is police a room somebody else owns. There, blocking
means you stop seeing anything that device sends; only that room's owner can
remove it. It also cannot hide that your device exists — discovery is a
broadcast, and anything on the network can hear it. Settings → Privacy says all
of this on the page, and is where you unblock.

---

## How the security actually works

This is worth understanding, because "encrypted" gets claimed a lot.

```
  Your password  ──scrypt(N=32768)──▶  32-byte room key
       │                                      │
       │  never leaves this device            │
       ▼                                      ▼
  never transmitted            AES-256-GCM(key, payload)
                                              │
                                              ▼
                              { iv, ciphertext, auth tag }  ──▶ network
```

**The password is never sent.** It only ever feeds `scrypt` locally. When you
ask to join a room, your device seals a known phrase with the derived key and
sends *that*. The owner opens it with their own key: only someone who knows the
password could have produced something the owner can open. The proof is tied to
the room's id, so a proof captured from one room cannot be replayed at another.

**Four checks before anything is applied.** An incoming packet is only acted on
when the room exists here, *you* are an accepted member, the *sender* is an
accepted member, and the payload actually decrypts. Anything else is dropped.

**Tampering is detected, not just decryption failure.** GCM's authentication tag
means a modified packet is rejected outright rather than quietly producing
garbage.

**The owner is the source of truth** for who is in a room. Remove someone and
every device updates; they cannot read anything sent afterwards.

Everything the project deliberately does **not** protect against — public room
names, traffic analysis, code running as your own user — is written down honestly in
[SECURITY.md](SECURITY.md). Section 5 of [ARCHITECTURE.md](ARCHITECTURE.md) has
the full design.

---

## Built with

| Layer | Choice | Why |
|-------|--------|-----|
| Shell | [Electron](https://electronjs.org) 35 | One codebase, three desktop platforms, real clipboard access |
| Language | [TypeScript](https://typescriptlang.org) 5.8, strict | The wire protocol is easy to get wrong; types catch a lot of it |
| Interface | [React](https://react.dev) 19 | Familiar, and the whole UI is state-driven |
| Bundler | [Vite](https://vitejs.dev) 6 | Fast dev server, small production build |
| Transport | Node `dgram` (UDP) | No broker, no server — just broadcast on the LAN |
| Crypto | Node `crypto` — scrypt + AES-256-GCM | Standard library only. No crypto dependency to audit or trust |
| Storage | `electron-store` | Rooms, keys and history as plain JSON |
| Packaging | `electron-builder` | NSIS, DMG and AppImage from one config |

**No external networking or cryptography libraries.** Everything security-related
uses the Node standard library, which makes it possible to actually read and
verify all of it in an afternoon.

---

## Project layout

```
src/
├── main/            Electron main process — network, crypto, storage
│   ├── main.ts          Lifecycle, UDP protocol, IPC handlers
│   ├── crypto.ts        scrypt, AES-256-GCM, join codes, proofs
│   ├── roomManager.ts   Rooms, keys, membership, discovery
│   ├── callManager.ts   Who is in which call
│   ├── snippetManager.ts Saved text, ranked by what you reach for
│   ├── quickPaste.ts    The global overlay window and its hotkey
│   ├── remoteSession.ts Remote desktop rules — the gate on every input event
│   ├── remoteControl.ts Key/coordinate mapping and the injector (no native deps)
│   ├── remoteInput.ts   The native module, loaded lazily and optionally
│   ├── migrate.ts       Carries an older install across the rename
│   └── historyManager.ts
├── renderer/        React interface
│   ├── App.tsx          Root component and state
│   ├── panels.tsx       Clipboard / Chat / Members
│   ├── modals.tsx       Create, Edit, Join, Unlock
│   ├── callEngine.ts    WebRTC mesh — peers, tracks, negotiation
│   ├── callui.tsx       Call stage, ring dialog, screen picker
│   ├── remoteEngine.ts  Remote desktop peer + input data channel
│   ├── remoteui.tsx     Viewer, approval dialog, host indicator
│   ├── quickpaste.tsx   The overlay's interface
│   ├── palette.tsx      Command palette and universal search
│   └── styles.css       Design tokens and every component style
└── shared/          Types, the IPC contract, and content detection
test/                Test suite (plain Node, no framework)
docs/                The GitHub Pages site
```

---

## Development

```bash
npm run dev          # TypeScript watch + Vite + Electron
npm run typecheck    # Both projects
npm test             # 361 assertions over crypto, rooms, chat and file sharing
npm run build        # Compile to dist/
npm run build:exe    # Windows installer into release/
```

The security-critical modules import nothing from Electron, so they run in plain
Node:

```
$ npm test

-- crypto --
  PASS  wrong key cannot open the envelope
  PASS  tampered ciphertext is rejected by the auth tag
  PASS  nonce is unique across seals (no IV reuse)
  PASS  proof verifies only with the correct password
  PASS  a proof for one room does not verify for another
  PASS  join code alphabet is uniformly distributed (no modulo bias)
  ...
-- rooms --
  PASS  the advert leaks neither the roster nor the join code
  PASS  the owner cannot be removed from their own room
  PASS  a removed member loses access
  ...

361 passed, 0 failed
```

---

## Roadmap

Shipped:

- [x] **Chunked transfer** so large screenshots sync, with NACK-based retransmission
- [x] **File transfer** in chat, up to 50 MB
- [x] **QR codes** for join codes so phones can scan them
- [x] **Pinned clipboard items** that survive the history cap — and pinned chat messages too
- [x] **Search** across clipboard history, room chat and direct messages
- [x] **Keyboard shortcuts** — `Ctrl+1..9` for rooms, `Ctrl+F` for search
- [x] **End-to-end encrypted direct messages**, with delivered/seen receipts and typing
- [x] **`@mentions`** in room chat, with an autocomplete and a stronger notification
- [x] **Message forwarding** to any room or thread, and **paste an image** into the composer
- [x] **Export a conversation** to a plain-text file
- [x] **TCP fallback** for networks that block UDP broadcast, preferred automatically for large payloads

Open, and every one of these is yours if you want it:

- [ ] **Translations** — [#7](https://github.com/Vijayapardhu/Campus-Connect/issues/7)
- [ ] **A mobile companion** — the protocol is documented and simple enough — [#8](https://github.com/Vijayapardhu/Campus-Connect/issues/8)

---

## Contributing

**This project is looking for collaborators.** It works, it is documented, and
there is a lot of obvious room to grow — which is a good place to join.

You do not need to be an expert. If you know some TypeScript, or React, or you
just want to fix a wording mistake, there is something here for you.

- [**CONTRIBUTING.md**](CONTRIBUTING.md) — setup, project rules, and a list
  of good first tasks with difficulty ratings
- [**Open an issue**](https://github.com/Vijayapardhu/Campus-Connect/issues/new/choose)
  — bugs and ideas both welcome
- [**Discussions**](https://github.com/Vijayapardhu/Campus-Connect/discussions) —
  ask anything, including "how does this bit work?"
- **Star the repo** if you would use this. It genuinely helps other people
  find it.

Areas where help would make the most difference right now:

| Area | What is needed |
|------|---------------|
| **macOS & Linux** | Development has been on Windows. Real testing on other platforms would be valuable |
| **Security review** | The model is documented in SECURITY.md. Try to break it |
| **Design & accessibility** | Screen reader support, keyboard navigation, colour contrast |
| **Translations** | Every user-facing string lives in `panels.tsx` and `modals.tsx` |
| **Mobile** | The protocol is documented — an Android or iOS client is wide open |
| **Documentation** | Tutorials, videos, or just fixing something that confused you |

---

## FAQ

<details>
<summary><strong>Does this need an internet connection?</strong></summary>

No. Everything happens over your local network. It works on WiFi with no
internet at all, which is exactly the situation in a lot of computer labs.
</details>

<details>
<summary><strong>Can other people on the WiFi see my clipboard?</strong></summary>

Only if you are in a public room with no password. Add a password and everything
is encrypted with a key derived from it — other devices receive the packets but
cannot read them. In a private room they additionally have to be approved by
you.
</details>

<details>
<summary><strong>Is my clipboard stored anywhere online?</strong></summary>

No. There is no server. History is stored as a JSON file on your own machine and
you can clear it from the app at any time.
</details>

<details>
<summary><strong>Why does it not find the other laptop?</strong></summary>

Open **Settings → Network** — it diagnoses this rather than leaving you to
guess, showing packets in and out, the adapters being used, and what is
actually wrong.

The two usual causes are a **version mismatch** (both machines must run the same
release, since the protocol changes between versions) and **client isolation**
on the network, which university and public WiFi commonly enable to stop devices
seeing each other at all. A phone hotspot confirms which it is in a minute.

**Settings → Network → Add a device by IP** connects directly when broadcast is
filtered.
</details>

<details>
<summary><strong>Does it sync when the window is closed?</strong></summary>

Yes. Closing the window hides it to the system tray and it keeps running. Quit
properly from the tray icon.
</details>

<details>
<summary><strong>How big can a shared item be?</strong></summary>

**50 MB for chat files, 128 MB for clipboard items.** A UDP datagram only holds
64 KB, so anything larger is split into 8 KB chunks and reassembled on the far
side, with anything the network drops requested again automatically. A 50 MB
file is about 11,700 chunks and takes roughly 18 seconds on a quiet network.

Beyond the limit the item stays in local history and the app says so rather than
failing silently.

Those numbers are measured, not chosen. A file is base64-encoded, encrypted,
base64-encoded again and JSON-stringified, so it becomes about 1.78x its own
size as a single string in memory. V8 refuses to build a string past ~512 MB,
and it gives out well before that — a 150 MB file exhausts an 8 GB heap. A
50 MB transfer peaks at around 560 MB of memory, which is already as much as a
background utility should be asking for.

Lifting this much higher means streaming the file from disk and encrypting it
chunk by chunk, rather than holding the whole thing in memory. That is
[a tracked issue](https://github.com/Vijayapardhu/Campus-Connect/issues), not a
setting.
</details>

<details>
<summary><strong>Can I use this at work?</strong></summary>

It is MIT licensed, so yes. Check your organisation's policy on installing
unsigned software first, and prefer building from source if they would rather
audit it.
</details>

---

## License

[MIT](LICENSE) — use it, fork it, ship it. Attribution appreciated but not required.

---

<div align="center">

### Built by [Vijaya Pardhu](https://github.com/Vijayapardhu)

Designed, architected and built as an MVP — the protocol, the cryptography, the
interface and the documentation.

[![GitHub](https://img.shields.io/badge/GitHub-Vijayapardhu-181717?logo=github)](https://github.com/Vijayapardhu)

**[Star this repo](https://github.com/Vijayapardhu/Campus-Connect)** ·
**[Contribute](CONTRIBUTING.md)** ·
**[Website](https://vijayaapardhu.dev/Clipboard/)**

</div>
