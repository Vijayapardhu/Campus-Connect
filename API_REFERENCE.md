# API Reference

The two interfaces a contributor works against: the **IPC API** between the
renderer and the main process, and the **wire protocol** between devices.

1. [IPC API](#ipc-api)
2. [Events](#events)
3. [Wire protocol](#wire-protocol)
4. [Type definitions](#type-definitions)
5. [Error handling](#error-handling)

---

## IPC API

Everything the renderer can do is declared once in
[`src/shared/bridge.ts`](src/shared/bridge.ts) as `SharedClipboardApi`,
implemented in [`src/main/preload.ts`](src/main/preload.ts), and reached as
`window.sharedClipboard`.

> **Adding a call?** Declare it in `bridge.ts` first, then `preload.ts`, then
> `main.ts`. One contract, three consumers, no drift.

Mutating calls return `ActionResult` rather than throwing, so the interface
always has a sentence to show:

```ts
type ActionResult = { ok: boolean; message: string };
```

### State

| Call | Returns | Notes |
|------|---------|-------|
| `getState()` | `AppState` | Everything the interface needs to render |
| `updateDeviceName(name)` | `AppState` | Empty name falls back to the OS hostname |
| `updateSettings(patch)` | `AppState` | Partial. `fontScale` is clamped to 0.9–1.3 |
| `connectPeer(host, port, name)` | `AppState` | Direct connection for networks that block broadcast |

### Rooms

| Call | Returns | Notes |
|------|---------|-------|
| `roomCreate(name, type, password)` | `ActionResult` | `type` is `'public' \| 'private'`. Private rooms **require** a password of 4+ characters |
| `roomRequestJoin(roomId, password, joinCode)` | `ActionResult` | Either credential is enough; pass `''` for the one you do not have. Success means *sent*, not *joined* — the outcome arrives via `onJoinResult` |
| `roomJoinByCode(joinCode, password)` | `ActionResult` | Join with a code, a password, or both. Asks every advertised room's owner; the wrong ones reject it. This is what lets someone join on the password alone without knowing which room it belongs to |
| `roomUnlock(roomId, password)` | `ActionResult` | Re-derives the key for an encrypted room this device has no key for |
| `roomSwitch(roomId)` | `ActionResult` | Changes which room this device shares into |
| `roomLeave(roomId)` | `ActionResult` | The owner closing a room removes it for everyone |
| `roomApproveMember(roomId, memberId)` | `ActionResult` | Owner only |
| `roomRejectMember(roomId, memberId)` | `ActionResult` | Owner only |
| `roomRemoveMember(roomId, memberId)` | `ActionResult` | Owner only. Cannot remove the owner |
| `roomQrCode(roomId)` | `string \| null` | PNG data URL of the join code. Contains the code only, never the password |
| `roomInvite(roomId, targetDeviceId)` | `ActionResult` | Owner only. Invites a device from `peers`. Sends no credentials, and unicasts |
| `roomRespondInvite(roomId, accept)` | `ActionResult` | Answer an invitation. Accepting only puts you in the owner's approval queue |

**Joining is asynchronous.** `roomRequestJoin` resolving with `ok: true` means
the request left this device. Whether it was accepted arrives later on
`onJoinResult`, because only the room's owner can decide.

### History

| Call | Returns |
|------|---------|
| `historyGetClipboard(roomId?)` | `ClipboardHistoryEntry[]`, newest first |
| `historyGetChat(roomId?)` | `ChatMessage[]`, newest first |
| `historyDeleteEntry(entryId)` | `ActionResult` |
| `historyTogglePin(entryId)` | `ActionResult` |
| `historyClearRoom(roomId)` | `ActionResult` |

Omitting `roomId` returns every room's history. Results come back newest-first with pinned entries
lifted to the top.

### Content

| Call | Returns | Notes |
|------|---------|-------|
| `chatSend(type, content, roomId, dataUrl?, fileName?)` | `ActionResult` | Fails if you are not an accepted member |
| `chatSendFile(roomId)` | `ActionResult` | Opens a native picker. 50 MB cap. Images are sent as `image` so they preview inline |
| `chatSaveFile(messageId)` | `ActionResult` | Opens a native save dialog. Never opens the file |
| `chatMarkSeen(roomId)` | `ActionResult` | Acknowledge a room's messages as read |
| `storageStats()` | `StorageStats` | What the stored history occupies |
| `storageCompact()` | `ActionResult` | Apply the retention window and size ceiling now |
| `readClipboard()` | `string` | This machine's clipboard text |
| `clipboardApply(entryId)` | `ActionResult` | Puts a history entry back on this machine's clipboard |
| `clipboardShareNow()` | `ActionResult` | Shares the clipboard immediately instead of waiting for the poller |

---

## Events

Each subscriber returns its own unsubscribe function:

```ts
React.useEffect(() => {
  const off = window.sharedClipboard.onStateChanged(setState);
  return off;
}, []);
```

| Event | Payload | Fires when |
|-------|---------|-----------|
| `onStateChanged` | `AppState` | Rooms, peers, membership or settings change |
| `onStatus` | `{ message, tone }` | Anything worth telling the user. `tone` is `info \| success \| warning \| error` |
| `onChatMessage` | `ChatMessage` | A message arrives or is sent |
| `onHistoryChanged` | `roomId: string` | Clipboard history changed — refetch rather than poll |
| `onJoinRequest` | `JoinRequest` | Someone asks to join a room you own, or accepts your invitation |
| `onInvite` | `RoomInvite` | Someone invited this device to a room |
| `onJoinResult` | `{ roomId, ok, message }` | Your own join request was accepted or refused |

---

## Wire protocol

UDP on port **37777**. Broadcast, plus unicast to known member hosts so a
network that blocks broadcast still works. Every datagram is JSON carrying
`v: 3` — mismatched versions are ignored, which stops a half-upgraded pair of
machines corrupting each other.

### Message types

| Type | Direction | Purpose |
|------|-----------|---------|
| `announce` | broadcast, every 3s | Presence, so peers learn each other's host and port |
| `room-advert` | owner → broadcast, every 3s | Public room metadata for discovery |
| `room-request` | joiner → owner | Ask to join; carries the join code and/or proof |
| `room-accept` | owner → joiner | Admitted. Carries the roster sealed, plus a cut-down plaintext copy so a device admitted on the join code alone can read it |
| `room-reject` | owner → joiner | Refused; carries a human-readable reason |
| `room-roster` | owner → members | Authoritative roster after any change |
| `room-leave` | member → owner | Voluntary departure |
| `room-closed` | owner → members | Room deleted |
| `clipboard` | member → room | Clipboard payload |
| `chat` | member → room | Chat message |
| `chunk` | sender → room | One piece of an oversized message |
| `chunk-nack` | receiver → sender | Indices that never arrived; please resend |

### Sealed vs plaintext bodies

For an **encrypted** room the body is JSON-encoded, sealed, and placed in
`sealed`. For an **unencrypted** room it travels in the plaintext `payload`,
`chatMessage` or `room` fields. `attachRoomBody` and `readRoomBody` in `main.ts`
are the only two places that make this decision — do not inline it elsewhere.

If a room claims to be encrypted and this device holds no key, `attachRoomBody`
returns `false` and the message is **not sent**. It never silently falls back to
plaintext.

### What an advert may contain

```ts
type RoomAdvert = {
  roomId; name; type; ownerId; ownerName;
  keySalt;      // public — useless without the password
  encrypted;    // whether a password is set
  memberCount;  // accepted members only
  createdAt;
};
```

**No roster. No join code. Nothing derived from the password.** Adverts go to
every device on the network. A test in `test/run.js` asserts the join code
cannot appear anywhere in a serialised advert; keep it that way.

### Joining a private room

```
Device B                                   Device A (owner)
   │  sees room-advert (name, keySalt, encrypted)
   │  user enters the join code, the password, or both
   │  key = scrypt(password, keySalt)
   │  proof = seal(key, "shared-clipboard:proof:<roomId>")
   │
   ├──── room-request { joinCode?, proof? } ─────▶│
   │                                              │  joinCode matches OR proof opens?
   │                                              │      neither ──────────────▶ room-reject
   │                                              │  yes → member added as 'pending'
   │                                              │
   │                                              │  owner clicks Approve
   │◀──── room-accept { sealed(roster) } ─────────┤
   │                                              ├──── room-roster ────▶ other members
   │◀════ sealed clipboard / chat ═══════════════▶│
```

A public encrypted room is the same minus the join code and minus approval — the
owner accepts as soon as the proof verifies.

### The admission gate

`handleRoomPayload` in `main.ts` is the single place inbound room data is
accepted. All four must hold:

1. The room exists on this device.
2. **We** are an accepted member.
3. The **sender** is an accepted member, per our own roster.
4. For an encrypted room, the body opens with our key.

Anything else is dropped and logged. **Do not add a second path that applies
data from the network.**

### Size limits and chunking

Anything above 60 KB (a UDP datagram caps at 64 KB) is serialised, split into
8 KB `chunk` messages, and rebuilt by `ChunkAssembler`. The reassembled JSON
re-enters `handleWireMessage`, so **chunked messages are subject to exactly the
same admission gate** — there is no shortcut around it. Reassembly happens
before decryption so the GCM auth tag still covers the whole payload.

| Limit | Value |
|-------|-------|
| Single datagram | 60 KB |
| Chunk payload | 8 KB |
| One transfer | 128 MB (sender) / 160 MB (receiver) |
| All in-flight transfers | 320 MB, 8 concurrent |
| Chat file | 50 MB |

Lost chunks are requested again with `chunk-nack` after 500 ms of silence; a
transfer with no progress for 20 s is abandoned and the user is told.

A `chunk` may not carry another `chunk`, and its inner `deviceId` must match the
sender — otherwise a device could attribute a payload to someone else.

---

## Type definitions

The full set lives in [`src/shared/types.ts`](src/shared/types.ts). The ones you
will touch most:

```ts
type RoomInfo = {
  roomId: string;
  name: string;
  type: 'public' | 'private';
  ownerId: string;
  ownerName: string;
  keySalt: string;      // random per room, public
  encrypted: boolean;   // true when the room has a password
  members: RoomMember[];
  createdAt: number;
  joinCode?: string;    // owner and accepted members only — stripped from adverts
};

type RoomMember = {
  deviceId: string;
  deviceName: string;
  status: 'pending' | 'accepted';
  role: 'owner' | 'member';
  joinedAt: number;
};

type Envelope = {
  iv: string;    // 12 random bytes, hex — never reused
  tag: string;   // GCM authentication tag, hex
  data: string;  // ciphertext, base64
};

type AppSettings = {
  syncEnabled: boolean;   // master switch for sharing
  autoApply: boolean;     // write incoming items straight to the clipboard
  shareImages: boolean;
  theme: 'system' | 'light' | 'dark';
  fontScale: number;      // 0.9 – 1.3, multiplies the whole type scale
  fontFamily: string;     // an installed font, or '' for the system default
};

type AppState = {
  deviceId: string;
  deviceName: string;
  listenPort: number;
  localAddress: string;
  peers: PeerInfo[];
  currentRoomId?: string;
  rooms: RoomInfo[];
  discovered: DiscoveredRoom[];
  lockedRoomIds: string[];  // encrypted rooms with no key on this device
  settings: AppSettings;
};
```

---

## Error handling

### In the renderer

Mutating calls resolve with `ActionResult` instead of rejecting, so the usual
shape is:

```ts
async function run(action: Promise<ActionResult>) {
  const result = await action;
  toast(result.message, result.ok ? 'success' : 'error');
  return result.ok;
}
```

### In the main process

- **Malformed datagrams** are ignored silently. Port 37777 is shared, and
  logging every stray packet would be noise.
- **Failed decryption** returns `null` from `open()` — a wrong key, a corrupt
  packet and a tampered one are indistinguishable by design, and all three are
  dropped with a warning.
- **Oversized payloads** produce a `warning` status rather than a silent failure.
- **Refused joins** carry a reason so the joiner learns *why*: "Incorrect room
  password", "That join code is not valid for this room", or "The room owner
  declined your request".

### Crypto functions never throw

`open`, `openJson` and `verifyProof` return `null` or `false` instead of
throwing. That keeps every call site a plain conditional and makes it impossible
to accidentally treat a decryption failure as success.
