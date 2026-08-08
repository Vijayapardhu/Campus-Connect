# Campus Connect — Architecture & Developer Guide

## 1. Overview

**Campus Connect** is a cross-platform desktop application (Electron + TypeScript + React) that
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
| Room admin | Owner can rename, retype, reissue the join code, re-key the room, and restrict a member's chat/files/calls/screen-sharing without a full block |
| Room chat | File sharing, paste-an-image, edit, delete (for me / for everyone), emoji reactions, reply quotes, `@mentions` with an autocomplete, per-device pins, and forwarding to any room or thread |
| Direct messages | 1:1 device-to-device threads, end-to-end encrypted, at chat-parity with rooms — including receipts and typing — plus search, archive, and delete; reachable by name/device-id search or by IP address |
| Keeping a record | Any room's chat or DM thread exported as a plain-text transcript through a native save dialog |
| Calls | Voice, video and screen sharing over WebRTC, full mesh, up to 6 devices; a DM thread can call directly via a hidden 1:1 room |
| Remote desktop | View or drive another member's screen, approved per session on the host, with pointer coordinates corrected for display scaling |
| Privacy | Per-device blocking, applied before anything arriving is acted on; per-room restrictions for a lesser, scoped limit |
| Phone access | One room served to a phone browser on the LAN, PIN-gated and opt-in |
| Productivity | Global quick-paste overlay, command palette, snippets, cross-room search |
| History | Per-room clipboard history and chat, persisted across restarts |
| Discovery | UDP broadcast on the LAN, plus direct TCP connections by address |
| Desktop | System tray, start on login, light/dark theming |

---

## 2. Technology stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | Electron 35 |
| Language | TypeScript 5.8 (strict) |
| UI | React 19 |
| Bundler | Vite 6 (renderer), `tsc` (main process) |
| Transport | Node.js `dgram` (UDP) and `net` (TCP), no external networking library |
| Cryptography | Node.js `crypto` — scrypt + AES-256-GCM, no external crypto library |
| Input injection | `@jitsi/robotjs` — N-API, loaded lazily and optional (see §6.10) |
| Persistence | electron-store |
| Packaging | electron-builder (NSIS / DMG / AppImage) |

---

## 3. Directory structure

```
campus-connect-desktop/
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
│   │   └── global.d.ts           # window.campusConnect typing
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
│       ├── bridge.ts             # The IPC API contract
│       ├── contentType.ts        # What a copied string actually is
│       ├── mentions.ts           # @Name resolution against a roster
│       ├── transcript.ts         # A conversation as an exportable text file
│       ├── dataUrl.ts            # Sizing an already-encoded attachment
│       └── deepLink.ts           # campusconnect:// parsing
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
│   App.tsx ── sidebar / panels / modals ── window.campusConnect       │
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
| Direct (`type: 'direct'`) | — | **Never** advertised or listed | Never joined — both sides create their own identical copy locally | Plain text |

A **direct** room is not something a user creates or sees. It exists only so a call placed from a DM
thread has something to be gated by — every call in this app is authorized by room membership, and a
direct room reuses that machinery rather than adding a second one. `roomManager.ensureDirectRoom`
computes a deterministic id from the two device ids (`` `dm:${[a, b].sort().join(':')}` ``) and an
identical two-member roster **independently on each device**, with no roster-sync message ever sent
for it — there is nothing for the two copies to disagree about, so the ordinary "roster is
owner-authoritative" rule simply does not apply here. It is excluded from `toAdvert`, from the
sidebar's room list, from the command palette, and from every room count shown in the UI.

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

That constant still carries the project's former name. It is deliberately frozen: it is never shown
to anyone, it exists only to keep a proof from being confused with any other sealed value, and
changing it would break every device that has not been updated yet in exchange for nothing.
Binding the proof to the `roomId` stops a proof captured from one room being replayed at another.

**`room:unlock` actually waits for this.** It used to derive a key from whatever was typed and report
success unconditionally, without ever checking it against anything — a mistyped password left the
room reporting as unlocked while nothing in it could actually decrypt, with no way back short of
leaving and rejoining. It now either verifies the candidate key locally against a piece of history
already sealed with the room's real key, or — when there is none yet — sends the proof and waits for
the owner's actual `room-accept`/`room-reject` (bounded by a timeout, for an offline owner) before
caching the key or reporting anything at all. A wrong password now correctly keeps the unlock dialog
open with "Incorrect room password," rather than a room that looks fine and silently isn't.

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
- **Derived keys are cached, encrypted by the OS credential store**, so you do not retype the
  password on every launch — DPAPI, Keychain, or libsecret/kwallet, via Electron's `safeStorage`
  and `keyVault.ts`. The ciphertext is bound to your user account, so a copied profile directory or
  another account cannot read it. It does **not** stop code running as you, which can ask the
  credential store to decrypt just as the app does. Where no credential store is available the keys
  are kept in memory for the session and never written. Delete the room to remove its key.
- **Unencrypted public rooms are plain text** by definition. The UI labels them "Not encrypted".
- **Device identity is a UUID**, not a certificate. A device that has been removed cannot decrypt
  new traffic, but nothing stops it presenting a fresh UUID and asking to join again.

### 5.9 Direct message encryption

A direct message has no room, and so no password to derive a key from the way §5.2 does. It is
end-to-end encrypted anyway, unconditionally — every device already holds a second keypair for
exactly this:

```ts
// deviceIdentity.ts
boxPublicKey: string;   // X25519, SPKI base64 — travels on the wire
boxPrivateKey: string;  // X25519, PKCS#8 base64 — never leaves this device
```

Separate from the Ed25519 pair that signs messages, because signing and key agreement are different
operations and Node does not expose a conversion between the two. This pair existed before DM
encryption did — it backs `wrapKeyFor`/`unwrapKeyFrom` in `crypto.ts`, the mechanism room re-keying
uses to hand a fresh content key to one device at a time — and this reuses the same X25519 agreement
for a second purpose it was already shaped for.

**No exchange round trip.** Every outbound message already carries the sender's box public key
(`WireMessage.boxPubKey`, attached in `deliver()` next to `pubKey`/`sig`), so any device that has
ever received *one* authenticated message from a peer already has what it needs to seal a message
to them — which in practice means every peer visible in `state.peers` at all. `dmAgreedKey` derives
the pairwise AES key from nothing but each side's own private key and the other's public one:

```
dmKey = sha256(X25519(selfPrivate, peerPublic) || "campus-connect:dmkey:" || sort(selfId, peerId))
```

Sorting the two device ids before hashing is what makes both sides compute the identical key
regardless of which one is "self" — X25519 agreement is already symmetric, so this is the only part
that has to be made deliberately so.

**Signed, not just carried.** `boxPubKey` is attached to a message *before* it is signed, not after,
so it is covered by the same signature every other field is. Left unsigned, a device able to tamper
with packets on this LAN — exactly what the signature exists to rule out everywhere else — could
swap in a box key of its own choosing for someone else's device id and quietly sit in the middle of
every future direct message to it. Signed, forging a different one needs the sender's signing
private key, which `deviceRegistry` already binds per device id.

**Sealed unconditionally.** `attachDmBody`/`readDmBody` are the DM equivalent of `attachRoomBody`/
`readRoomBody` (§6.1), with one difference: there is no plaintext path. A room's encryption is
conditional on whether it has a password; a DM's is not conditional on anything — `attachDmBody`
either seals the body under `dmAgreedKey` or refuses to send at all.

**What this does not cover.** The hidden 1:1 room a DM call is placed in (§5.1) is not sealed by this
— its SDP/ICE signaling still travels the way an unencrypted room's does. The call's actual media
is already end-to-end via SRTP regardless, the same as any other call in this app, so what is exposed
is the *setup* metadata, not the conversation. Upgrading that room to use `dmAgreedKey` as its
content key is a natural, cheap follow-on that was left out of this pass to keep it focused.

---

## 6. Network protocol

UDP on port **37777**, broadcast plus unicast to known member hosts (so a network that blocks
broadcast still works). Every datagram is JSON and carries the protocol version.

**Broadcast goes to every interface's own subnet broadcast address**, not just `255.255.255.255`.
The limited broadcast is only emitted on one interface — whichever the routing table picks — and on
a machine with WSL, Hyper-V, VirtualBox or Docker installed that is frequently a virtual adapter
rather than the WiFi one. Discovery then fails completely and silently. `src/main/network.ts`
computes the directed broadcast for each interface, and also picks this device's own address by
preferring a real adapter over a virtual one, since that address travels in every message as the
place to send replies.

**A version mismatch is reported, not ignored.** Two devices running different releases can see
each other's packets perfectly and discard every one; saying nothing is the worst possible
behaviour, so the app now says so explicitly and Settings → Network explains it.

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
| `room-rekey` | owner → members | Credentials changed; drop the key you hold |
| `room-closed` | owner → members | Room deleted |
| `clipboard` | member → room | Clipboard payload |
| `chat` | member → room | Chat message |
| `chunk` | sender → room | One piece of a message too large for a datagram |
| `chunk-nack` | receiver → sender | The pieces that never arrived, please resend |
| `room-invite` | owner → one device | An invitation. Unicast, and carries no credentials |
| `room-invite-accept` | invitee → owner | Accepted; the owner still has to approve |
| `room-invite-decline` | invitee → owner | Declined |
| `chat-receipt` | recipient → sender | Delivered and seen acknowledgements |
| `call` | member → room, or one device | Every call setup step (see §6.7) |
| `remote` | member → one device | Remote desktop setup. Always addressed (see §6.10) |

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

### 6.5 Two transports

UDP broadcast is how devices find each other and is all an ordinary network needs. Plenty of
networks are not ordinary: many campus and corporate deployments filter broadcast, and some filter
UDP entirely while leaving TCP alone. So every device also listens on **TCP 37777**, and a peer
added by address — or discovered — gets a real connection.

```
                       Transport
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
     UDP broadcast + unicast      Direct TCP
     discovery, and any peer      preferred for any peer
     without a direct link        with a live connection
              │                         │
              └────────────┬────────────┘
                           ▼
                   handleWireMessage
              (the same four-way gate for both)
```

Frames arriving over TCP go to exactly the same `handleWireMessage` as datagrams, so membership
checks and decryption are unchanged. **This is a different pipe, not a different set of rules.**

TCP is a byte stream, so each message is framed as a 4-byte big-endian length followed by that many
bytes of JSON (`src/main/framing.ts`). The length is checked *before* anything is buffered, which is
what stops a hostile peer announcing a 4 GB frame.

Two consequences worth knowing:

- **No chunking is needed over TCP.** Ordering and delivery are already guaranteed, so a large
  payload goes as one frame. Measured on loopback, 8 MB arrives in 0.3 s against 1.8 s for the same
  payload chunked over UDP.
- **Client isolation defeats both.** When the access point drops packets between two of its own
  clients, TCP fails exactly as UDP does. No transport, port, or protocol changes that — it is
  enforced upstream of the application. Settings → Network says so rather than pretending otherwise.

### 6.6 Chunked transfer

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

### 6.7 Calls

Calls are the one feature where this protocol carries only the *setup*. The media travels over
WebRTC, directly between the two machines.

```
Device A                                            Device B
   │  user clicks call
   │  main assigns a callId, records itself a participant
   ├──── call { kind: 'ring', callId, mode } ──────────▶│   rings
   │                                                    │
   │                        ◀──── call { kind: 'join' } ┤   answered
   │                                                    │
   │  both create an RTCPeerConnection with two         │
   │  transceivers (audio + video), then negotiate:     │
   │                                                    │
   ├──── call { kind: 'sdp', to, offer } ──────────────▶│
   │◀─── call { kind: 'sdp', to, answer } ──────────────┤
   │◀─── call { kind: 'ice', to, candidate } ──────────▶│
   │                                                    │
   ╞════════ SRTP audio / video, peer to peer ══════════╡
```

Every signal is a `call` wire message carrying one `CallSignal`, and travels through exactly the
same gate as a chat message: `handleRoomPayload` refuses it unless both devices are accepted members
of the room, and in an encrypted room the body is sealed with the room key like everything else. A
signal with a `to` field is unicast to that device when its address is known, which for ICE — much
the chattiest of them — it almost always is.

The sender's identity always comes from the enclosing wire message, never from the signal body, so
no signal can be sent on another device's behalf.

**Signal kinds**

| Kind | Meaning |
|------|---------|
| `ring` | The sender is in the call and wants the room to ring |
| `join` | The sender is in the call. Also the heartbeat, re-sent every 5 s |
| `here` | Sent back to a newcomer by everyone already in, so it learns the roster |
| `leave` | The sender is out |
| `decline` | The ring was refused |
| `sdp` | An offer or an answer, addressed to one device |
| `ice` | One ICE candidate, addressed to one device |
| `device` | What the sender is currently sending: mic, camera, screen |

**No ICE servers.** `iceServers` is deliberately empty. STUN exists to discover your address as seen
from outside a NAT and TURN exists to relay when no direct path can be found; on the same network
neither problem exists, so connections are made from host candidates alone. That is what lets a call
work with the internet unplugged.

For the same reason the app starts Chromium with `--disable-features=WebRtcHideLocalIpsWithMdns`.
Chromium otherwise replaces local IPs in ICE candidates with generated `*.local` mDNS hostnames —
correct for a browser, fatal here, because it would make every call depend on mDNS resolution
working on both ends, and multicast is exactly what a campus network filters. Nothing is exposed by
this that the app does not already broadcast every three seconds by design.

**Both transceivers up front.** Each connection is created with an audio *and* a video transceiver,
even for a voice call. An empty video transceiver costs nothing while no track is attached, and
having it there means turning the camera on, or starting a screen share, is a `replaceTrack` on a
sender that already exists — no new m-line, no renegotiation, and no chance of the two ends
disagreeing about the shape of the session mid-call.

**Glare** is handled with the standard *perfect negotiation* pattern. Politeness is decided by
comparing the two device ids, so both ends reach the same answer without exchanging a word about it,
and two people joining at the same moment — the normal way a collision happens — resolves itself.

**Liveness.** A laptop whose lid closes mid-call never says goodbye. Each participant re-announces
itself every 5 seconds and anyone who stops is dropped after 20; a call left with nobody in it ends
by itself. `CallManager` (main process, Electron-free, unit-tested) holds that picture and nothing
else — it never touches media.

**A DM call is an ordinary room call.** Calling is gated by room membership everywhere in this app,
and a direct message has no room — `roomManager.ensureDirectRoom` resolves (creating on first use) the
hidden 1:1 room described in §5.1, and `call:start` proceeds exactly as it would for a real room. The
renderer never manages the synthetic room id itself: `dm:ensure-call-room` resolves it, and the result
is handed to the same call window the ordinary "call this room" path already opens.

### 6.8 Blocking

Blocking is enforced in exactly one place: `receiveMessage`, before the packet is counted, stored,
shown or answered.

```ts
if (isBlocked(message.deviceId)) {
  return;
}
```

One check rather than a condition in each handler, because spreading the decision across twenty
handlers is how one of them ends up forgotten — and a block that leaks in one place is not a block.

Blocking also removes the device from every room **this** device owns, since refusing to listen
while the blocked party carries on reading your messages would be worth very little. Rooms owned by
someone else are outside this device's authority, and the UI says so rather than implying a
guarantee that does not exist.

**Restrictions are a lesser, per-room tier**, for when a full network-wide block is more than the
situation calls for — muting one member's chat, files, calls, or screen sharing in one room without
severing the device everywhere. The four flags are independent: screen sharing has its own rather
than riding on `calls`, because watching or driving a desktop is a strictly larger ask than talking,
and an owner needs to be able to withdraw it while still letting the member call. Unlike a block,
restrictions live **on the roster** (`RoomMember.restricted`), so
they piggyback on the existing owner-authoritative `room-roster` broadcast with no new wire message
type — every device already reaches the same roster, so every device enforces the same restriction
independently, the same reasoning that makes `isBlocked` a single choke point rather than a check
repeated in every handler. Enforced on both sides of a restricted message: inbound, in
`handleRoomPayload`, so a modified client cannot simply ignore its own copy of the rule; outbound, in
the sending IPC handler itself, so the restricted device is told plainly why nothing happened rather
than typing into a composer that quietly does nothing. Only the room's owner can set a restriction,
and the owner can never restrict themselves.

Every roster edit — approve, decline, remove, restrict — is gated on `requireOnline()`. The local
edit would succeed while offline, but the half that makes it mean anything (the accept/reject packet
to the device concerned, and the roster broadcast to everyone else) is fire-and-forget over a socket
that is not open, with no retry behind it. Refusing outright keeps the owner's roster and everyone
else's from silently disagreeing.

### 6.9 Re-keying a room

`room-rekey` exists because the roster cannot say the one thing that matters when a password
changes: *the key you are holding is no longer the room's key*.

The notice is sealed with the key the room had **before** the change, so only devices already in the
room can read it — and it deliberately does not carry the new key. Every member has to be given the
new password. That is what makes changing a password a way of shutting someone out, rather than a
way of renaming the lock while every old copy of the key keeps working.

On receipt a member keeps the room and its history, drops its key, and the room reports as locked
until the new password is entered.

### 6.10 Remote desktop

Structurally a one-to-one call whose camera is a screen, plus a data channel carrying input. It is
kept separate from the call engine because almost every decision differs: one peer instead of a
mesh, video in one direction, a codec profile tuned for text rather than faces, and a permission
model where one side is doing something to the other.

```
Controller                                        Host
   │  clicks "Screen" next to a member
   ├──── remote { kind: 'request', sessionId } ──────▶│
   │                                                  │  dialog: who is asking,
   │                                                  │  which screen, view or control
   │                                                  │  ── a person answers ──
   │◀─── remote { kind: 'grant', grant, screen } ─────┤
   │                                                  │  captures the chosen screen
   │◀─── remote { kind: 'sdp', offer } ───────────────┤
   ├──── remote { kind: 'sdp', answer } ─────────────▶│
   │◀─── remote { kind: 'ice' } ─────────────────────▶│
   │                                                  │
   │◀════════ screen video (SRTP) ════════════════════╡
   ╞════════ input (DTLS data channel) ══════════════▶│
                                                      │
                                          main process gate → robotjs
```

**Approval is per session and given by a person.** There is no stored consent, no setting that
leaves a machine open, and — deliberately — no code path from a message arriving on the network to
screen capture starting. `remote:respond` is reachable only from the dialog.

**One gate.** `RemoteSessionManager.mayInject` is the single decision between an event arriving and
the mouse moving. It requires all of: a live session, this device being the *host* rather than the
controller, the session id matching, the sender matching, and `grant === 'control'`. It is written
as one expression of positives so that a later condition cannot accidentally widen it, and it is the
most heavily tested function in the codebase.

**Normalised coordinates.** Pointer positions cross as fractions of the shared screen, never pixels.
The controller does not know the host's resolution, the host may change it mid-session, and the
viewer is almost certainly scaled to fit a window. On arrival they are clamped into the shared
display's bounds — a hostile or simply buggy controller must not be able to fling the pointer onto
another monitor.

**Scaled to physical pixels.** Electron's `display.bounds` is in logical/DIP pixels, but the native
cursor APIs `@jitsi/robotjs` calls expect physical ones — on any display that is not at 100% Windows
scaling (or a Retina Mac), the two differ by `display.scaleFactor`, and the drift grows with distance
from the display's origin. `boundsForDisplay` (`remoteInput.ts`) scales the bounds before they ever
reach `toScreenPoint`, via the pure, unit-tested `scaleBounds` in `remoteControl.ts`. A secondary
display at a *different* scale factor than the primary is not fully solved by this — Windows' virtual
desktop coordinate math for mixed-DPI multi-monitor setups is a harder problem than a per-display
scale multiply — stated here rather than left implicit.

**Bitrate is capped, not left to chance.** The screen track's `contentHint` is set to `'detail'`
(spatial clarity over frame-rate, the right tradeoff for text and UI rather than a face), and
`RTCRtpSender.setParameters` caps `maxBitrate`/`maxFramerate` right after the track is added, so a
burst of on-screen motion cannot push the encoder into congestion-driven queueing lag on a link that
has headroom for a mostly-static desktop but not for an unbounded one. No codec preference, no
simulcast, no adaptive resolution — for a single-peer, LAN-only, non-SFU session those are real
complexity for a marginal gain once the bitrate ceiling is in place.

**Held keys are tracked and released.** A session ending while Ctrl is down — the controller's window
losing focus mid Ctrl+C is enough — would otherwise leave the host with a permanently held modifier
and no idea why the keyboard had stopped working. Every session end funnels through one function
that releases before anything else.

**Getting out.** A global shortcut (`Ctrl+Alt+Shift+X`) is registered for the duration of a hosted
session and given back when it ends. This is the case that matters: while someone else is moving the
mouse, clicking a button in this app may be exactly what cannot be done.

**Whole screens only.** A window can be moved or covered at any moment, so a click on a picture of
one cannot honestly be mapped back to a point on the desktop. Windows stay shareable in a call,
where nobody is clicking on them.

**The native module.** Input injection is the one thing Electron does not provide. `@jitsi/robotjs`
is N-API, which is ABI-stable across Node *and* Electron, and ships prebuilt binaries via
`prebuildify` — so there is no `electron-rebuild` step and no node-gyp toolchain in CI. It is
`require`d lazily inside a `try`, the first time control is wanted rather than at startup, and a
failure degrades to view-only rather than breaking anything. Wayland (which refuses synthetic input
outright) and macOS without Accessibility are both detected and reported in words, not swallowed.

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
| `wrapKeyFor` / `unwrapKeyFrom` | X25519-agreed AES key wraps a room content key to one device (§6.9's re-key) |
| `dmAgreedKey(selfPriv, peerPub, selfId, peerId)` | The same X25519 agreement, generalized to a device-id pair — what makes a direct message end to end encrypted (§5.9) |

### `roomManager.ts`
Owns rooms, derived keys, and discovered adverts. Persists through a `RoomPersistence` interface so
it has no dependency on electron-store (which is what makes it testable).

Key methods: `createRoom`, `saveRoom`, `deleteRoom`, `getKey`/`setKey`, `isLocked`,
`isAcceptedMember`, `isOwner`, `addPendingMember`, `addAcceptedMember`, `approveMember`,
`removeMember`, `toAdvert`, `recordAdvert`, `getDiscoveredRooms`, `ensureDirectRoom` (the hidden
1:1 call room, §5.1), `setMemberRestrictions`/`getRestrictions` (the per-room
chat/files/calls/screen-sharing limit, §6.8).

Invariants worth knowing:
- `removeMember` refuses to remove the owner.
- `addPendingMember` returns `undefined` for an existing accepted member, so a re-request can never
  downgrade someone to pending or duplicate them.
- `isLocked(roomId)` is true when a room is encrypted but this device holds no key — the UI uses
  this to show the unlock screen.
- `setMemberRestrictions` refuses to restrict the owner — there is nobody else in the room to enforce
  it against them. It also normalises every flag and clears the record entirely when all four are
  false, so an all-false object never reads as "restricted" to anything downstream.

### `directMessage.ts`
`DirectMessageManager` — the DM equivalent of `historyManager.ts`, keyed by peer device id instead of
room id, since a direct message belongs to no room at all. Same shape: in-memory plus a 750 ms
debounced flush, a 500-message-per-peer cap enforced independently per thread, author-only edit,
tombstone-style delete-for-everyone (the row survives so a reply into it still resolves), and a
reaction toggle keyed by whichever device reacted. `archived`/`deleteThread` are thread-level, not
message-level: an archived thread collapses into the Messages page's own section rather than being
removed, and a deleted thread is a local-only "for me" — DM history is already a local, per-device
copy, so there is nothing else it could mean.

`recordReceipt` deliberately reuses room chat's `deliveredTo`/`seenBy: string[]` shape rather than a
DM-specific flag, which is what lets `panels.tsx`'s existing `statusOf`/`Receipt` rendering treat a
DM exactly like a two-member room. A thread only ever has one other party, so each array holds at
most one id. It only ever touches `fromSelf` rows of the named thread — the peer acknowledging a
message can only mean one this device sent them — and `seen` implies `delivered`, so a receipt whose
predecessor was lost still lands both.

### `shared/transcript.ts`
`formatTranscript` / `transcriptFileName` — a room's chat or a DM thread written
out as plain text through a native save dialog (`history:export`, `dm:export`).
Text rather than JSON, because an exported conversation is nearly always read by a
person — pasted into a ticket, kept as a record of what was agreed — and a format
needing a tool to read defeats that. It is an **export, not a backup**: attachments
are named, not written, and nothing reads back into the app.

Both exports are in `PHONE_DENIED`, under the rule described in `phoneServer.ts`:
**no request from a phone may open a native dialog on the laptop.** The client-side
refusal in `httpApi.ts` is cosmetic on its own — a request straight to `/api/rpc`
never runs it — so the deny list is the real gate.

Room chat and DM share the formatter because they are the same artefact to the
reader; each manager maps its own shape into `TranscriptEntry` first. Entries are
sorted oldest-first here rather than at the call site, since both managers store
newest-first. `formatTime` is injected so the default locale-dependent rendering
can be pinned in tests. A withdrawn message exports as `(message deleted)` and
never leaks its filename; a multi-line message is indented under its own header so
a stray newline cannot read as a second message.

### `shared/dataUrl.ts`
`dataUrlBytes` — the decoded size of a `data:` URL, computed from the encoded
length rather than by decoding it. A file picked off disk is measured by `stat`
before it is ever read; an attachment that arrives already encoded (a forward, an
image pasted into the composer) has no such handle, and decoding 50 MB of base64
purely to find out how big it is defeats the point of having a ceiling. It sits in
`shared` because it is what stands between `MAX_FILE_BYTES` and an oversized
attachment on every path that skips the file picker, and that arithmetic is worth
testing in plain Node. `postChatMessage` and `postDirectMessage` both call it, then
stamp the result onto `fileSize` so a forwarded attachment still shows its size.

**Pasting an image into the composer** needs no new IPC either, for the same
reason: `chatSend`/`dmSend` already take a `dataUrl`, and the bytes are already in
hand from the clipboard, so it skips the native picker and goes straight to the
ordinary send. `ChatPanel`'s `onPaste` only claims the event once it has confirmed
there is an image on the clipboard — calling `preventDefault` any earlier would
swallow an ordinary text paste. The renderer pre-checks the size purely to avoid
building 50 MB of base64 that the main process would reject anyway; the real
ceiling is still `MAX_FILE_BYTES`, enforced in `postChatMessage` via
`dataUrlBytes`. It works on the phone client too, unlike `chatSendFile` — a paste
needs no native dialog.

**Forwarding** needs no wire protocol of its own: it is `chatSend`/`dmSend` called
again with the original's `content`/`type`/`dataUrl`/`fileName`, which makes the
copy a message in its own right — the destination can edit, react to and delete it
without any of that reaching back to the original. The destination picker lists
rooms and DM threads together (`ForwardMessageModal`), because "where do I send
this" is one question rather than two, and it lives in `App` rather than in either
panel because a forward out of a DM thread can land in a room.

### `shared/mentions.ts`
`@Name` resolution, in `shared` because both processes need the same answer and it
is testable in plain Node. A device name is whatever its owner typed — "Lab PC 3",
"Vijaya's Laptop" — so there is no character that reliably ends a mention and
`@(\w+)` would clip half the roster. It therefore matches against the roster it is
given, **longest name first**, so `@Lab PC 3` beats a member called `Lab`; a name
matching nobody stays ordinary text, and an `@` preceded by a word character is an
email address rather than a mention.

`mentions` is **always re-resolved from the text**, never read off the wire — by
`postChatMessage` on the way out, by `handleChatMessage` on the way in, and by
`editChatMessage` when the text changes. A sender-supplied list of ids would let a
modified client light up anybody's mention badge at will, and would go stale the
moment a member was renamed. Being named raises the notification to `urgent`, the
same tier as an expiring remote-access request, because it is a direct address
rather than ambient room chatter.

### `historyManager.ts`
Per-room caps (100 clipboard entries, 500 chat messages) enforced **independently per room**, so a
busy room cannot evict a quiet one. `toggleChatPin` gives a chat message the same bargain a pinned
clipboard entry already had: exempt from the cap and never evicted by it, since being evicted is the
one thing pinning exists to prevent. A pin is **local to the device that made it** — nothing is sent,
no ownership is checked (any message you can see, you can bookmark), and nobody else's copy changes.
`DirectMessageManager.togglePin` is the same thing for a thread. Writes are debounced by 750 ms because the clipboard poller
would otherwise hit disk every second. Images larger than 256 KB stay in memory but are not written
to disk. Consecutive identical clipboard entries are suppressed, which is what stops the polled
clipboard producing duplicates.

### `callManager.ts`
Who is in which call — and nothing else. No media, no Electron imports, no persistence: a call
cannot survive a restart, and a stale one would be worse than none. Participants that stop
announcing themselves are swept after 20 s, and a call left empty ends itself. Unit-tested against
an injected clock.

### `migrate.ts`
Electron names the per-user data directory after the application, so renaming the app to Campus
Connect moved it. On first run under the new name this copies the previous directory across —
device identity, rooms, derived keys and history — so the rename does not read as a fresh install.
It only ever runs when the new directory has no settings file of its own, it leaves the old
directory in place so the previous build still works, and a failure is logged rather than fatal.

### `remoteSession.ts`
Who may drive what. One session at a time in either role, the per-session approval queue, and
`mayInject` — the single gate every input event passes. No Electron, no native module, exhaustively
tested.

### `remoteControl.ts`
Key translation, coordinate mapping, event validation, and the injector itself. The injector is
built by dependency injection — `createInjector(robot, getBounds)` — so the whole path can be tested
against a fake that records what it was asked to do. Given this is the code that lets another
machine type on your keyboard, being able to test it exhaustively is worth the indirection.

### `remoteInput.ts`
The only place the native module is touched. Lazy `require`, capability detection (Wayland, macOS
Accessibility, load failure), and display bounds read fresh on every event so a screen being resized
or unplugged mid-session cannot leave the pointer mapped into a rectangle that no longer exists.

### `phoneSession.ts`
The whole security boundary of phone access: PIN generation, constant-time
comparison, brute-force lockout, token issue and expiry, per-room scoping. The
rate limit is the load-bearing part — a six-digit PIN is a million possibilities,
which an unthrottled attacker on the same WiFi exhausts in seconds, so the PIN is
only meaningful because guessing is made slow. Electron-free and heavily tested.

### `phoneServer.ts`
A small HTTP server on port 37778, off unless switched on. Serves one
self-contained page and four JSON endpoints. The token travels in an
`Authorization` header rather than a cookie, so there is no CSRF surface at all;
bodies are bounded before they are buffered; failures pause before answering.

**This is the one place the app hands out plaintext.** A browser cannot hold the
room key, so the desktop decrypts and serves. That is documented in the interface
rather than hidden, and the exposure is bounded by being opt-in, single-room,
PIN-gated, expiring and revocable.

`PHONE_DENIED` is a **deny** list, not an allow list, because a paired phone is the
same person holding the same laptop and the useful default is that everything
works. The cost of that choice is that a new IPC handler is reachable from a phone
the moment it exists, so anything that should not be has to be denied deliberately.
Three rules decide it: *it cannot work* (remote desktop, screen capture), *it would
be a surprise* (installing an update), and **it opens a native dialog on the
laptop**. The third is the one that is easy to reintroduce — a phone is often in
another room, and a modal nobody is standing in front of blocks the window it is
attached to until somebody walks over and dismisses it. Every `dialog.show*` call
in `main.ts` is behind an entry in the list: `files:`, `dm:` and `history:export`
by prefix, `chat:send-file` and `chat:save-file` by name, since `chat:` as a whole
must stay reachable. A test counts the call sites in `main.ts` against that list,
so adding a dialog without denying it fails the suite rather than shipping.

### `snippetManager.ts`
The snippet library and, more to the point, its ranking: recently used first, then
most used, then newest. A library that always shows the same alphabetical list is
one you stop opening. Electron-free and tested against an injected clock.

### `quickPaste.ts`
The overlay window and its global hotkey. A second `BrowserWindow` rather than a
panel in the first, because the requirement that shapes everything else is that
it works while the main window is closed. Built hidden at startup — creating it
lazily would put the cost of starting a renderer between the keypress and the
first frame, which for a feature whose whole value is being instant is the wrong
trade.

### `contentType.ts` (shared)
Works out what a copied string actually is — link, colour, code, JSON, email,
number — so it can be rendered and acted on accordingly. Deliberately
conservative: every pattern is anchored to the whole string, because a wrong
guess puts an "Open" button on a sentence. `isOpenableUrl` is the gate on the
link action and permits `http` and `https` only.

### `callEngine.ts` (renderer)
The media half of a call: `RTCPeerConnection` per participant, perfect negotiation, mic and camera
capture, mute and camera toggles, screen share by `replaceTrack`, and cleanup that actually releases
the camera. Lives in the renderer because that is the only process with a media engine.

---

## 8. IPC API

Declared once in `src/shared/bridge.ts` as `CampusConnectApi`, implemented in `preload.ts`, and
used by the renderer as `window.campusConnect`. One contract, three consumers, no drift.

**State** — `getState`, `updateDeviceName`, `updateSettings`, `connectPeer`, `forgetPeer`

**Rooms** — `roomCreate`, `roomRequestJoin`, `roomJoinByCode`, `roomUnlock`, `roomSwitch`,
`roomLeave`, `roomApproveMember`, `roomRejectMember`, `roomRemoveMember`, `roomSetRestrictions`

**History** — `historyGetClipboard`, `historyGetChat`, `historyDeleteEntry`, `historyTogglePin`,
`historyClearRoom`, `historyExport`

**Content** — `chatSend`, `chatEdit`, `chatDelete`, `chatReact`, `chatTogglePin`, `chatSendFile`,
`chatSaveFile`, `chatTyping`, `chatMarkSeen`, `readClipboard`, `clipboardApply`, `clipboardShareNow`

**Direct messages** — `dmSend`, `dmSendFile`, `dmEdit`, `dmDelete`, `dmReact`, `dmTogglePin`,
`dmSaveFile`, `dmGetThread`, `dmMarkRead`, `dmTyping`, `dmArchiveThread`, `dmDeleteThread`,
`dmExport`, `dmEnsureCallRoom`

**Search** — `searchAll` (spans clipboard, room chat and DM threads)

**Events** — `onStateChanged`, `onStatus`, `onChatMessage`, `onHistoryChanged`, `onTyping`,
`onReceipts`, `onDmMessage`, `onDmTyping`, `onJoinRequest`, `onJoinResult`

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

electron-store, at `%APPDATA%/campus-connect-desktop/config.json` on Windows:

```jsonc
{
  "deviceId": "uuid",
  "deviceName": "PARDHU-LAPTOP",
  "listenPort": 37777,
  "peers": [ /* recently seen, TTL 15 s */ ],
  "currentRoomId": "uuid",
  "settings": {
    "online": true, "syncEnabled": true, "autoApply": true, "shareImages": true,
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

**Direct-call rooms** — `directRoomId` is deterministic and order-independent; `ensureDirectRoom`
computes an identical room id and roster from either side; a direct room is never locked and never
advertised; creating it twice is idempotent and keeps the peer's display name current.

**Direct messages** — a sent message round-trips through the thread and the thread-summary list; a
retransmitted receive is deduplicated by id while a genuinely new one still lands; only the message's
own side may edit or delete it; a local-only delete needs no ownership check; a reaction toggles on
and off, keyed by whichever device reacted; archiving is undone by sending into the thread again;
deleting a thread clears its messages, unread count, and archived flag together.

**Remote desktop input mapping** — `scaleBounds` converts logical display bounds to physical pixels
correctly for a scaled display, a secondary display at a different origin, 100% scaling as a no-op,
and a missing/invalid scale factor falling back to 1 rather than producing `NaN`/`Infinity`.

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
| A DM call leaves no call history entry | Room chat records one; DM now has receipts and a typing indicator, but a placed or missed DM call is still not written into the thread |
| The hidden 1:1 room a DM call is placed in is not end-to-end encrypted | Only its SDP/ICE setup metadata — the call's actual media is already SRTP end-to-end regardless; upgrading it to use the same `dmAgreedKey` as its content key (§5.9) is a natural follow-on |
| Keys readable by code running as you | A passphrase the user types and the app never stores |
| Room names are public | Advertise a hash instead, discoverable only by those who know the name |
| No forward secrecy | Rotating the password re-keys the room; consider per-session keys |
| Device identity is a UUID | Certificate pinning would stop a removed device rejoining anonymously |
| No cross-subnet discovery | Discovery is LAN broadcast only; a device on a different subnet has to be added by IP (already supported) rather than found automatically |
| Mixed-DPI multi-monitor remote desktop | Per-display `scaleFactor` correction (§6.10) does not fully solve a secondary display at a *different* scale than the primary |
| An exported transcript names attachments rather than writing them | It is an export, not a backup — the text of a conversation, not its bytes. Writing files alongside it would need a folder rather than a file, and a different dialog |
| A pinned message is pinned only on the device that pinned it | Deliberate, and the same as a pinned clipboard entry: a pin is a bookmark, not a claim about the conversation everyone must agree with. Syncing it would need a wire message and a rule for who may unpin |
| A forwarded message carries no "forwarded from" marker | It arrives as an ordinary message. Adding provenance means a new optional field and deciding whether it can be trusted, since the forwarder controls it |
| Roster edits need the owner to be online | Approve, decline, remove and restrict are refused while the master switch is off, rather than applying locally and silently losing the packet that tells the other devices. Correct, but it does mean an owner cannot queue a decision to take effect later |

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
