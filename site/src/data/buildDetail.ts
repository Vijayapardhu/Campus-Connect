/*
 * The reference half of /build.html — stack, security model, wire protocol,
 * what is stored and what the tests actually assert.
 *
 * Every table here follows ARCHITECTURE.md, which is the document the code
 * was written against: §2 for the stack, §5 for security, §6.1 for the
 * message types, §10 for persistence and §12 for the test areas. Kept apart
 * from build.ts because that file is the *history* — commits, days, things
 * that broke — and this one is the *system as it stands*.
 */

/* ----------------------------------------------------------------- stack -- */

export const STACK: Array<[string, string]> = [
  ['Desktop shell', 'Electron 35'],
  ['Language', 'TypeScript 5.8, strict'],
  ['Interface', 'React 19'],
  ['Bundler', 'Vite 6 for the renderer, tsc for the main process'],
  ['Transport', 'Node dgram (UDP) and net (TCP) — no networking library'],
  ['Cryptography', 'Node crypto — scrypt and AES-256-GCM, no crypto library'],
  ['Input injection', '@jitsi/robotjs, loaded lazily and treated as optional'],
  ['Persistence', 'electron-store'],
  ['Packaging', 'electron-builder — NSIS, DMG, AppImage']
];

/* -------------------------------------------------------------- security -- */

export interface RoomType {
  type: string;
  password: string;
  join: string;
  traffic: string;
}

export const ROOM_TYPES: RoomType[] = [
  {
    type: 'Public, no password',
    password: 'None',
    join: 'One click',
    traffic: 'Plain text — the interface labels it "Not encrypted"'
  },
  {
    type: 'Public, with password',
    password: 'Optional',
    join: 'Password only, never the code',
    traffic: 'AES-256-GCM'
  },
  {
    type: 'Private',
    password: 'Required, four characters minimum',
    join: 'Join code or password, plus owner approval',
    traffic: 'AES-256-GCM'
  }
];

/* The four conditions every inbound room packet has to satisfy, from
   handleRoomPayload in main.ts. Failing any one of them drops the packet. */
export const ADMISSION: string[] = [
  'The room exists on this device.',
  'We are an accepted member of it.',
  'The sender is an accepted member of it, according to our own roster.',
  'For an encrypted room, the body actually opens with our key.'
];

export const NOT_PROTECTED: Array<{ what: string; why: string }> = [
  {
    what: 'Room and owner names are public',
    why: 'Adverts are broadcast in the clear so devices can find rooms at all. The roster, the join code and every piece of content are not.'
  },
  {
    what: 'Traffic analysis',
    why: 'An observer on the network sees that a room is busy, and roughly how large its messages are.'
  },
  {
    what: 'Derived keys are cached on disk',
    why: 'So the password is not retyped on every launch. Anyone with access to your user profile can read them; deleting the room removes its key.'
  },
  {
    what: 'Unencrypted public rooms are plain text',
    why: 'By definition. The interface says so rather than implying otherwise.'
  },
  {
    what: 'Device identity is a UUID, not a certificate',
    why: 'A removed device cannot decrypt new traffic, but nothing stops it presenting a fresh UUID and asking to join again.'
  }
];

/* -------------------------------------------------------------- protocol -- */

export interface WireMessage {
  type: string;
  direction: string;
  purpose: string;
}

export const MESSAGES: WireMessage[] = [
  { type: 'announce', direction: 'broadcast, every 3s', purpose: 'Presence, so peers learn each other’s host and port' },
  { type: 'room-advert', direction: 'owner → broadcast', purpose: 'Public room metadata, for discovery' },
  { type: 'room-request', direction: 'joiner → owner', purpose: 'Ask to join; carries a join code and/or a proof' },
  { type: 'room-accept', direction: 'owner → joiner', purpose: 'Admitted; carries the full roster' },
  { type: 'room-reject', direction: 'owner → joiner', purpose: 'Refused, with a reason a person can read' },
  { type: 'room-roster', direction: 'owner → members', purpose: 'The authoritative roster after any change' },
  { type: 'room-leave', direction: 'member → owner', purpose: 'Voluntary departure' },
  { type: 'room-rekey', direction: 'owner → members', purpose: 'Credentials changed; drop the key you hold' },
  { type: 'room-closed', direction: 'owner → members', purpose: 'The room was deleted' },
  { type: 'clipboard', direction: 'member → room', purpose: 'A clipboard payload' },
  { type: 'chat', direction: 'member → room', purpose: 'A chat message' },
  { type: 'chunk', direction: 'sender → room', purpose: 'One piece of a message too large for a datagram' },
  { type: 'chunk-nack', direction: 'receiver → sender', purpose: 'The pieces that never arrived — please resend' },
  { type: 'room-invite', direction: 'owner → one device', purpose: 'An invitation. Unicast, and carries no credentials' },
  { type: 'room-invite-accept', direction: 'invitee → owner', purpose: 'Accepted; the owner still has to approve' },
  { type: 'room-invite-decline', direction: 'invitee → owner', purpose: 'Declined' },
  { type: 'chat-receipt', direction: 'recipient → sender', purpose: 'Delivered and seen acknowledgements' },
  { type: 'call', direction: 'member → room, or one device', purpose: 'Every call setup step' },
  { type: 'remote', direction: 'member → one device', purpose: 'Remote desktop setup. Always addressed, never broadcast' },
  { type: 'file-xfer', direction: 'sender ↔ receiver', purpose: 'Direct transfer: request, accept, offer, data, finish' }
];

/* --------------------------------------------------------------- testing -- */

export const TEST_AREAS: Array<{ area: string; asserts: string }> = [
  {
    area: 'Crypto',
    asserts:
      'Derivation is deterministic per password and salt, and diverges when either changes. Seal and open round-trip. A wrong key returns null. Flipping a byte of ciphertext, or of the authentication tag, is rejected. IVs never repeat. A proof verifies only with the right password and only for its own room. Join codes are uniformly distributed across the alphabet.'
  },
  {
    area: 'Rooms',
    asserts:
      'A private room is encrypted, coded and owned. Adverts leak neither the roster nor the join code, and count only accepted members. Pending is not accepted. A re-request cannot downgrade or duplicate a member. The owner cannot be removed. A removed member loses access. Rooms and keys survive a restart. A room whose key is absent reports as locked. A room you are already in never appears as discoverable.'
  },
  {
    area: 'History',
    asserts:
      'History is scoped per room. Repeated polls do not duplicate. Per-room caps are independent, so a busy room cannot evict a quiet one. Clearing one room leaves the others intact. Chat messages dedupe by id on rebroadcast. Pinned items survive the cap, do not consume it, sort to the top, persist across a restart, and become evictable again when unpinned.'
  },
  {
    area: 'Chunking',
    asserts:
      'Split and join is lossless. Chunks reassemble in any order. Duplicates never double-deliver. Gaps are reported accurately and complete after retransmission. Two senders reusing a transfer id do not collide. A sender changing the total mid-transfer is abandoned. Malformed chunks allocate nothing. The message, total-buffer, concurrency and chunk-count ceilings all hold. Stalled transfers are swept and their memory released.'
  },
  {
    area: 'File sharing',
    asserts:
      'One transfer at a time in either role. A declined request releases both sides. A request nobody answers is withdrawn by the sweep. The receiver cancelling mid-transfer releases the sender. A transfer that stops moving is ended rather than held open. Going offline mid-receive closes handles and sweeps the partials. A file past the ceiling is refused before anything is read.'
  }
];

/* ----------------------------------------------------------- persistence -- */

export const STORED: Array<[string, string]> = [
  ['deviceId, deviceName', 'A UUID, and the name the operating system reports'],
  ['rooms', 'Room records, including their rosters'],
  ['roomKeys', 'Derived 32-byte keys, so the password is not retyped every launch'],
  ['clipboardHistory', 'Capped at 100 entries per room, independently'],
  ['chatHistory', 'Capped at 500 messages per room, independently'],
  ['peers', 'Recently seen devices, with a 15-second time to live'],
  ['settings', 'Online, sync, auto-apply, image sharing, theme, font scale and family']
];
