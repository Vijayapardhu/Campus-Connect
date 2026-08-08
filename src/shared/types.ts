/**
 * 7 — every message is signed by the sending device.
 *
 * A break, deliberately. Version 6 has no signatures, so a v6 device cannot
 * produce anything a v7 device will act on, and the mismatch is reported
 * rather than silently half-working. Devices have to be updated together.
 */
export const PROTOCOL_VERSION = 7;

/**
 * `'direct'` is a hidden, synthetic 1:1 room used only to carry a call between
 * two DM peers — see `roomManager.ensureDirectRoom`. It is never advertised,
 * never listed in "your rooms," and its roster is always exactly the two
 * participants, computed identically and independently on both devices
 * rather than synced by the usual owner-authoritative roster broadcast.
 */
export type RoomType = 'public' | 'private' | 'direct';
export type MemberStatus = 'pending' | 'accepted';
export type MemberRole = 'owner' | 'member';

export type RoomMember = {
  deviceId: string;
  deviceName: string;
  status: MemberStatus;
  role: MemberRole;
  joinedAt: number;
  /**
   * The device's public key, recorded by the owner when it approved the join
   * — the one moment the device had already proved it knew the password.
   *
   * Optional because rosters written before this existed have none. A member
   * without one is trusted on first use until its key is learned, which is
   * the upgrade path rather than the intended state.
   */
  publicKey?: string;
  /**
   * A lesser tier than a full block: the owner can restrict what this member
   * may do *in this one room* without severing them from the network
   * entirely. Absent or all-false means unrestricted. Lives on the roster
   * rather than as a separate message, so it propagates and is enforced the
   * same way every other membership fact already is — see `broadcastRoster`
   * and `handleRoomRoster`.
   */
  restricted?: RoomRestrictions;
};

export type RoomRestrictions = {
  /** May not send chat messages (text, edits, reactions) in this room. */
  chat?: boolean;
  /** May not send file/image attachments in this room. */
  files?: boolean;
  /** May not start or join a call in this room. */
  calls?: boolean;
  /** May not ask to view or control another member's screen through this room. */
  remote?: boolean;
};

/**
 * The owner-authoritative record of a room. The roster is only ever shared with
 * accepted members (sealed when the room is encrypted), never broadcast openly.
 */
export type RoomInfo = {
  roomId: string;
  name: string;
  type: RoomType;
  ownerId: string;
  ownerName: string;
  /** Random per-room salt for scrypt. Public: useless without the password. */
  keySalt: string;
  /** True when the room has a password, which means all room traffic is sealed. */
  encrypted: boolean;
  members: RoomMember[];
  createdAt: number;
  /** Known to the owner and to accepted members only. Stripped from adverts. */
  joinCode?: string;
};

/**
 * The only room data broadcast to the whole LAN. Deliberately excludes the
 * roster, the join code, and anything derived from the password.
 */
export type RoomAdvert = {
  roomId: string;
  name: string;
  type: RoomType;
  ownerId: string;
  ownerName: string;
  keySalt: string;
  encrypted: boolean;
  memberCount: number;
  createdAt: number;
};

export type DiscoveredRoom = RoomAdvert & {
  host: string;
  lastSeen: number;
};

/** AES-256-GCM ciphertext plus the parameters needed to open it. */
export type Envelope = {
  iv: string;
  tag: string;
  data: string;
};

export type ClipboardHistoryEntry = {
  id: string;
  kind: 'text' | 'image';
  text: string;
  dataUrl?: string;
  deviceId: string;
  deviceName: string;
  roomId: string;
  timestamp: number;
  /** Pinned entries sort to the top and are exempt from the per-room cap. */
  pinned?: boolean;
};

// --- snippets ----------------------------------------------------------------

/**
 * Text worth keeping because you type it again and again.
 *
 * The counterpart to clipboard history: history is what you happened to copy and
 * ages out, a snippet is what you decided to keep and does not. A build command,
 * an API endpoint, a student number, the boilerplate at the top of every file.
 *
 * Deliberately local to this device and never sent anywhere. A snippet is
 * exactly the kind of thing that is convenient *because* it is to hand, and the
 * moment it syncs to a room it becomes something to think about before saving.
 */
export type Snippet = {
  id: string;
  /** What it is called in the list. Falls back to the content when empty. */
  label: string;
  content: string;
  createdAt: number;
  /** Used for ranking, so the ones you reach for surface first. */
  useCount: number;
  lastUsedAt: number;
};

/** Cap on the library, so it stays a list you can look through. */
export const MAX_SNIPPETS = 200;

// --- search ------------------------------------------------------------------

/**
 * One hit from searching everything at once.
 *
 * Clipboard entries and chat messages are different things everywhere else in
 * the app, but when you are trying to find something you copied *or* something
 * somebody said, the distinction is exactly what you do not want to have to
 * make first.
 */
export type SearchHit = {
  kind: 'clipboard' | 'chat' | 'dm';
  id: string;
  /** Set for `clipboard`/`chat` — where the hit lives. */
  roomId?: string;
  /** Resolved for display, since a room id means nothing to a reader. */
  roomName?: string;
  /** Set for `dm` — who the thread the hit lives in is with. */
  peerId?: string;
  peerName?: string;
  deviceName: string;
  timestamp: number;
  /** The line the match is on, trimmed around the match itself. */
  excerpt: string;
  /** Offsets of the match within `excerpt`, for highlighting. */
  matchStart: number;
  matchLength: number;
  /** Set for images and files, so a hit can show what it actually is. */
  fileName?: string;
  hasMedia: boolean;
};

/** What a message is answering, kept with the reply so it survives on its own. */
export type ChatReplyTo = {
  messageId: string;
  deviceName: string;
  /** A short excerpt, so a reply still reads correctly if the original goes. */
  preview: string;
};

/** Emoji offered in the reaction bar. Anything already on a message also shows. */
export const REACTION_CHOICES = ['👍', '❤️', '😂', '🎉', '👀', '😢'] as const;

export type ChatMessage = {
  id: string;
  type: 'text' | 'file' | 'image';
  content: string;
  dataUrl?: string;
  fileName?: string;
  /** Original size in bytes, for files and images. */
  fileSize?: number;
  deviceId: string;
  deviceName: string;
  roomId: string;
  timestamp: number;
  /**
   * Receipts. Sender-local bookkeeping, stripped before the message goes on the
   * wire — a recipient has no business being told who else has read it.
   */
  deliveredTo?: string[];
  seenBy?: string[];
  /** True once the attachment has been cleaned up but the message is kept. */
  mediaCleared?: boolean;

  /** The message this one is answering, if any. */
  replyTo?: ChatReplyTo;
  /** When the author last changed the text. */
  editedAt?: number;
  /**
   * The author withdrew this for everyone. The message stays in place as a
   * marker rather than vanishing, so a conversation that referred to it still
   * makes sense; the text and any attachment are gone.
   */
  deleted?: boolean;
  /** Emoji to the devices that reacted with it. */
  reactions?: Record<string, string[]>;
  /**
   * Bookmarked on **this device only**, exactly like a pinned clipboard entry —
   * a note to yourself about where something useful is, not a claim about the
   * conversation everyone else has to agree with. Never sent, and exempt from
   * the per-room cap, since being evicted is what pinning prevents.
   */
  pinned?: boolean;
  /**
   * Device ids named with `@` in `content`. Always re-resolved against the room
   * roster by whichever device stores the message — never taken from the
   * sender — so a modified client cannot make this device believe it was
   * mentioned, and so a mention still resolves after a member is renamed out
   * from under it. See `shared/mentions.ts`.
   */
  mentions?: string[];
};

/** What the sender shows against its own message. */
export type MessageStatus = 'sent' | 'delivered' | 'seen' | 'undelivered';

// --- calls -------------------------------------------------------------------

/**
 * Voice and video calls between members of a room.
 *
 * The media itself never touches this protocol: WebRTC carries it directly
 * between the two machines, encrypted by SRTP, and on a LAN that means the
 * packets go over the switch and nothing else. What travels here is only the
 * setup — who is calling, and the SDP and ICE candidates the two peers need to
 * find each other — and in an encrypted room even that is sealed with the room
 * key like every other body.
 *
 * There is no STUN or TURN server, and none is needed: both machines are on the
 * same network, so their own host candidates reach each other. That is also why
 * calls work with the internet unplugged.
 */
export type CallMode = 'audio' | 'video';

/**
 * Ceiling on a call. Every participant holds a connection to every other one,
 * so the cost of a call grows with the square of the people in it; past roughly
 * this many the encoders, not the network, are what gives out.
 */
export const MAX_CALL_PARTICIPANTS = 6;

/** A session description as it travels. Mirrors RTCSessionDescriptionInit. */
export type CallDescription = {
  type: 'offer' | 'answer';
  sdp: string;
};

/** An ICE candidate as it travels. Mirrors the fields RTCIceCandidateInit needs. */
export type CallCandidate = {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment?: string | null;
};

/** What a participant is currently sending, so the grid can label them. */
export type CallDeviceState = {
  micOn: boolean;
  cameraOn: boolean;
  sharing: boolean;
};

/**
 * Call setup. Every one of these is addressed to a room and only ever honoured
 * from an accepted member of it; `to` narrows it further to a single device.
 * The sender is always taken from the enclosing message, never from the body,
 * so none of this can be sent on someone else's behalf.
 */
export type CallSignal =
  /**
   * Ringing the room, or — with `to` set — ringing one specific member of it
   * directly. Nobody is in the call yet — this only makes it ring. A direct
   * ring still carries `callId`/`roomId` for the same reason every other call
   * does: authorization and cleanup stay room-scoped even when only one
   * other member ever hears about it.
   */
  | { kind: 'ring'; callId: string; mode: CallMode; to?: string }
  /**
   * I am in. Broadcast room-wide, not `to`-addressed even for a direct call —
   * that's what keeps every member's `ActiveCall`/`CallInProgressBanner`
   * accurate; a direct call is visible and joinable the same as any other
   * once it exists. Only *ringing* is ever narrowed, not participation.
   */
  | { kind: 'join'; callId: string; mode: CallMode }
  | { kind: 'here'; callId: string; mode: CallMode; to: string }
  | { kind: 'leave'; callId: string }
  | { kind: 'decline'; callId: string }
  | { kind: 'sdp'; callId: string; to: string; description: CallDescription }
  | { kind: 'ice'; callId: string; to: string; candidate: CallCandidate }
  | { kind: 'device'; callId: string; state: CallDeviceState };

// --- remote desktop ----------------------------------------------------------

/**
 * Viewing, and optionally driving, another device's screen.
 *
 * This is the most dangerous thing the app can do, so the rules are deliberately
 * narrow and none of them are configurable:
 *
 *  - Only between accepted members of the same room, like everything else.
 *  - Every session is approved by hand, on the machine being shared, naming the
 *    device asking. There is no "always allow" and no way to make one.
 *  - Approval is for *viewing* or for *control*, chosen at the time. Control can
 *    be taken back mid-session without ending it.
 *  - The host can end it instantly, including from a global shortcut that works
 *    when the app is not focused — which is the situation that matters, because
 *    someone else is driving the mouse.
 *
 * The screen travels over WebRTC like a call. Input travels over a WebRTC data
 * channel rather than this protocol: a mouse moving generates events far too
 * fast for a broadcast datagram path, and the data channel is already
 * DTLS-encrypted and point to point.
 */
export type RemoteRole = 'host' | 'controller';

/** What the host has agreed to. Never widened without the host acting. */
export type RemoteGrant = 'view' | 'control';

/** Session setup. Always addressed: a remote session is strictly one to one. */
export type RemoteSignal =
  /** The controller asks. Nothing happens until a human on the host says yes. */
  | { kind: 'request'; sessionId: string; to: string }
  | { kind: 'grant'; sessionId: string; to: string; grant: RemoteGrant; screenLabel: string }
  | { kind: 'deny'; sessionId: string; to: string; reason: string }
  /** The host changed its mind about control, without ending the session. */
  | { kind: 'grant-changed'; sessionId: string; to: string; grant: RemoteGrant }
  | { kind: 'end'; sessionId: string; to: string; reason: string }
  | { kind: 'sdp'; sessionId: string; to: string; description: CallDescription }
  | { kind: 'ice'; sessionId: string; to: string; candidate: CallCandidate };

/** A request waiting on this device's answer. */
export type RemoteRequest = {
  sessionId: string;
  roomId: string;
  roomName: string;
  fromDeviceId: string;
  fromDeviceName: string;
  at: number;
};

/** The remote session this device is in, from its own point of view. */
export type RemoteSessionState = {
  sessionId: string;
  roomId: string;
  role: RemoteRole;
  peerId: string;
  peerName: string;
  grant: RemoteGrant;
  /** Which screen is being shared, for the host's indicator. */
  screenLabel: string;
  startedAt: number;
};

/**
 * Whether this machine can be driven at all.
 *
 * Input injection needs a native module and an operating system willing to
 * accept synthetic events. Neither is guaranteed — Wayland refuses outright, and
 * macOS requires the user to grant Accessibility first — so the host offers only
 * what it can actually deliver rather than promising control and then silently
 * doing nothing.
 */
export type RemoteCapabilities = {
  canControl: boolean;
  /** Why not, in words meant for the person reading them. */
  reason: string;
};

/**
 * One input event, as it crosses the data channel.
 *
 * Field names are single characters because these are sent continuously — a
 * mouse being dragged is dozens a second — and the shape is flat so that
 * validating one costs nothing.
 *
 * Pointer coordinates are fractions of the shared screen (0..1), never pixels.
 * The controller has no idea what resolution the host is running, the host may
 * change it mid-session, and the viewer is almost certainly scaled to fit a
 * window; normalising is what makes all three stop mattering.
 */
export type RemoteInputEvent =
  | { t: 'move'; x: number; y: number }
  | { t: 'down'; x: number; y: number; b: RemoteMouseButton }
  | { t: 'up'; x: number; y: number; b: RemoteMouseButton }
  | { t: 'scroll'; dx: number; dy: number }
  | { t: 'key'; k: string; down: boolean }
  /** Text typed or pasted, sent whole. Layout-independent, unlike key codes. */
  | { t: 'text'; s: string };

export type RemoteMouseButton = 'left' | 'right' | 'middle';

// --- phone access ------------------------------------------------------------

/**
 * Letting a phone drive this computer over the LAN, through a browser.
 *
 * Deliberately not a peer. A phone browser cannot hold a room key, so what it
 * receives has already been decrypted here — which is why this is off unless
 * switched on, and why pairing is by scanning a code rather than by knowing an
 * address that anyone on the network can guess.
 *
 * A paired phone reaches everything the desktop does. It is the same person
 * holding both, so the scan is the boundary and unpairing is the revocation.
 */
export type PhoneClientInfo = {
  label: string;
  address: string;
  /** Paired once and remembered; the PIN is never asked for again. */
  pairedAt: number;
  lastSeenAt: number;
};

export type PhoneAccess = {
  active: boolean;
  /** The plain address, for display. Not enough on its own to get in. */
  url: string;
  /**
   * The address plus a single-use pairing key, encoded into the QR code.
   *
   * Never displayed as text and never meant to be typed: the whole point is that
   * scanning is the only way in, so that knowing the machine's IP — which anyone
   * on the network does — is not enough.
   */
  pairUrl: string;
  clients: PhoneClientInfo[];
  /** Non-zero while locked out after too many wrong PINs. */
  lockedUntil: number;
};

/** An unanswered call this device has been rung for. */
export type CallRinging = {
  callId: string;
  roomId: string;
  roomName: string;
  mode: CallMode;
  fromDeviceId: string;
  fromDeviceName: string;
  at: number;
  /** Rung directly rather than as part of a room-wide ring — changes only the wording shown. */
  direct?: boolean;
};

/**
 * Tells the call window what to do the moment it opens: place a fresh call, or
 * join one already under way. Pulled once by the window itself rather than
 * pushed, so it is never missed by a window still finishing its first load.
 */
export type CallWindowIntent =
  | { kind: 'start'; roomId: string; mode: CallMode; targetDeviceId?: string }
  | { kind: 'join'; callId: string };

/**
 * A call known to be live in a room. Tracked so a room can show that a call is
 * happening — and be joined late — without anyone having to ring again.
 */
export type ActiveCall = {
  callId: string;
  roomId: string;
  mode: CallMode;
  startedAt: number;
  participants: { deviceId: string; deviceName: string }[];
};

export type ClipboardPayload = {
  kind: 'text' | 'image';
  text: string;
  sourceId: string;
  sourceName: string;
  timestamp: number;
  dataUrl?: string;
};

export type PeerInfo = {
  id: string;
  name: string;
  host: string;
  port: number;
  lastSeen: number;
  /**
   * The protocol this device speaks. Present and different from ours means it
   * is reachable but running another version, so nothing will work with it
   * until one of the two is updated.
   */
  protocolVersion?: number;
  /**
   * This device's X25519 public key, SPKI as base64 — carried on every
   * message it sends (`WireMessage.boxPubKey`) and recorded here the moment
   * any of them arrives. What lets a direct message to this peer be sealed
   * end to end the instant it appears on the network, with no key-exchange
   * round trip of its own: see `dmAgreedKey` in main/crypto.ts.
   */
  boxPublicKey?: string;
};

/**
 * A device reached once by typing its address in — remembered so the address
 * only has to be typed once per device, not once per session. `peers` itself
 * is not durable enough for this: it is a sighting list, pruned the moment a
 * device stops announcing, which is exactly what a device on another subnet
 * (the only reason to add one by IP in the first place) always looks like
 * between launches.
 */
export type RememberedPeer = {
  host: string;
  port: number;
  /** Last name it answered under — a label to show before it does again. */
  name: string;
  addedAt: number;
};

/**
 * An invitation this device has received. Carries only what a room advert
 * already makes public — never the join code and never the password.
 */
export type RoomInvite = {
  roomId: string;
  roomName: string;
  ownerId: string;
  ownerName: string;
  type: RoomType;
  encrypted: boolean;
  invitedAt: number;
};

/**
 * A device this one refuses to deal with.
 *
 * Blocking is total and local: nothing from a blocked device is read, stored,
 * shown or answered, in any room. The name is kept alongside the id purely so
 * the list is readable later — an id on its own is impossible to recognise, and
 * a block you cannot identify is a block you can never undo with confidence.
 */
export type BlockedDevice = {
  deviceId: string;
  deviceName: string;
  blockedAt: number;
  /** The address it was last seen at, so unblocking can undo the TCP-level forget by the same key. */
  lastHost?: string;
};

/**
 * What a room's owner is allowed to change about it after it exists.
 *
 * `password` distinguishes three cases that a plain string cannot: absent means
 * leave the credentials alone, `null` means take the password off and open the
 * room up, and a string means set or replace it. Only the last two re-key the
 * room, and re-keying is the disruptive one — every other member has to enter
 * the new password before they can read anything again, which is exactly what
 * makes changing it worth doing when a password has got out.
 */
export type RoomUpdate = {
  name?: string;
  type?: RoomType;
  password?: string | null;
  /** Issues a new join code and retires the old one. */
  regenerateJoinCode?: boolean;
};

export type JoinRequest = {
  roomId: string;
  roomName: string;
  deviceId: string;
  deviceName: string;
  requestedAt: number;
};

export type WireMessageType =
  | 'announce'
  | 'room-advert'
  | 'room-request'
  | 'room-accept'
  | 'room-reject'
  | 'room-roster'
  | 'room-leave'
  | 'room-closed'
  /**
   * The owner changed the room's credentials. Distinct from `room-roster`
   * because it means something the roster cannot say: the key you hold is no
   * longer the room's key, so drop it.
   */
  | 'room-rekey'
  | 'clipboard'
  | 'chat'
  | 'chunk'
  | 'chunk-nack'
  | 'room-invite'
  | 'room-invite-accept'
  | 'room-invite-decline'
  | 'chat-receipt'
  /*
   * Changes to a message that has already been sent. These are additive: a
   * device on an older build ignores a type it does not recognise, so it simply
   * keeps showing the message as it was rather than refusing to talk at all.
   * That is why the protocol version does not move for them.
   */
  | 'chat-edit'
  | 'chat-delete'
  | 'chat-reaction'
  | 'chat-typing'
  /**
   * Call setup, all of it. One type rather than a dozen, because the main
   * process only relays these: what a signal means is the renderer's business,
   * and there is nothing to be gained from teaching the transport each variant.
   */
  | 'call'
  /**
   * Remote desktop setup. Like `call`, one type carrying a union: the main
   * process routes these and enforces who may ask, but what a step means is
   * settled between the two peers.
   */
  | 'remote'
  /**
   * Peer-to-peer file sharing. One type carrying a union, like `remote` and
   * `call`: the sender asks, the receiver accepts, and then file slices stream
   * from one to the other over whatever transport is available — a direct TCP
   * link when one exists, UDP chunks otherwise.
   */
  | 'file-xfer'
  /**
   * A single direct 1:1 message. Device-to-device like `file-xfer`, and for
   * the same reason: reachable by anyone currently visible on the network,
   * not gated on sharing a room.
   */
  | 'direct-message';

/**
 * Every datagram on the wire. Bodies that belong to an encrypted room travel in
 * `sealed`; only unencrypted rooms use the plaintext `payload` / `chatMessage` /
 * `room` fields.
 */
export type WireMessage = {
  v: number;
  type: WireMessageType;
  deviceId: string;
  deviceName: string;
  port: number;
  host: string;
  timestamp: number;

  /**
   * The sender's Ed25519 public key, SPKI as base64.
   *
   * A device id is a value the sender chose, so on its own it proves nothing.
   * This is what the receiver checks the signature against — and, because the
   * pairing of id to key is remembered, what stops a second device claiming
   * an id that is already spoken for.
   */
  pubKey?: string;
  /**
   * A signature over the message's identifying fields and a digest of its
   * body. Everything the receiver will act on is covered; see `Signable` in
   * main/deviceIdentity.ts for exactly what.
   */
  sig?: string;
  /**
   * The sender's X25519 public key, SPKI as base64 — attached to every
   * outbound message the same way `pubKey` is, so any device that has ever
   * received anything from a peer already has what it needs to seal a direct
   * message to them. See `PeerInfo.boxPublicKey` and `dmAgreedKey`.
   */
  boxPubKey?: string;

  advert?: RoomAdvert;
  roomId?: string;
  joinCode?: string;
  /** Sealed `proof:<roomId>` — proves password knowledge without sending it. */
  proof?: Envelope;
  targetDeviceId?: string;
  reason?: string;

  room?: RoomInfo;
  payload?: ClipboardPayload;
  chatMessage?: ChatMessage;
  sealed?: Envelope;
  /**
   * On `direct-message`: the body, sealed under the pairwise key `dmAgreedKey`
   * derives for the sender and `targetDeviceId`. A DM has no room and so no
   * password to derive a key from the way `sealed` does — this is what makes
   * it end-to-end encrypted anyway, unconditionally, the same way `sealed`
   * makes an encrypted room's traffic unreadable to anyone without its key.
   */
  dmSealed?: Envelope;

  /*
   * Chunking. A message too large for one datagram is serialised and split;
   * each piece travels as its own `chunk`. The receiver reassembles the
   * original JSON and feeds it back through the normal handler, so nothing
   * bypasses the membership and decryption checks.
   */
  transferId?: string;
  index?: number;
  total?: number;
  data?: string;
  /** On `chunk-nack`: the indices the receiver is still missing. */
  missing?: number[];

  /** On `chat-receipt`: which messages, and how far they got. */
  messageIds?: string[];
  receipt?: 'delivered' | 'seen';

  /*
   * Amendments to an existing message, all of them sealed with the room body
   * like anything else. Each carries the id of the message it acts on, and is
   * only honoured when the device sending it is entitled to: the author for an
   * edit or a withdrawal, any member for a reaction.
   */
  chatEdit?: { messageId: string; content: string; editedAt: number };
  chatDelete?: { messageId: string };
  chatReaction?: { messageId: string; emoji: string; on: boolean };
  /** On `chat-typing`: true while composing, false when they stop. */
  typing?: boolean;

  /** On `call`: the setup step. Sealed with the room body like anything else. */
  call?: CallSignal;
  /** On `remote`: one step of setting up or ending a remote desktop session. */
  remote?: RemoteSignal;
  /** On `file-xfer`: one step of a peer-to-peer file transfer. */
  fileXfer?: FileXferSignal;
  /** On `direct-message`: one 1:1 message, device-to-device, no room involved. */
  directMessage?: DirectMessageSignal;
};

export type AppSettings = {
  /**
   * The master switch, on the header rather than buried in settings.
   *
   * Off means off: no announcing, no discovery, no direct connections, nothing
   * sent and nothing received. The app keeps its rooms and its history and does
   * nothing else until it is switched back on.
   */
  online: boolean;
  /** Share this device's clipboard. Incoming items still arrive. */
  syncEnabled: boolean;
  /** Write incoming clipboard content straight to the local clipboard. */
  autoApply: boolean;
  /** Include images, not just text, when sharing. */
  shareImages: boolean;
  theme: 'system' | 'light' | 'dark';
  /** Multiplier applied to every type token. 1 is the default size. */
  fontScale: number;
  /** A font installed on this machine, or '' to use the system UI font. */
  fontFamily: string;

  /**
   * Show a system notification when the window is hidden or unfocused.
   *
   * Separate from `notificationSound` on purpose. The two are different
   * complaints: a popup that steals focus mid-lecture, and a chime in a silent
   * reading room. Tying them together means the only way to stop one is to lose
   * the other, so either can be switched off on its own.
   */
  notifications: boolean;
  /** Play the system's notification sound with the popup. */
  notificationSound: boolean;
  /** Tell other devices when their messages arrive and when you read them. */
  sendReceipts: boolean;

  /**
   * Ring out loud for an incoming call. A call is over in seconds if nobody
   * picks it up, so unlike a message it genuinely needs to interrupt — but a
   * shared room in a quiet lab is exactly where that is unwelcome, hence the
   * switch.
   */
  ringOnCalls: boolean;
  /**
   * Join every call with the microphone already muted. Worth having on for a
   * shared machine, where the first thing the room hears is otherwise whatever
   * happens to be going on around it.
   */
  startCallsMuted: boolean;

  /**
   * Whether this device has been shown the tour.
   *
   * Per device rather than per account, like the theme: a laptop being set up
   * by somebody who has used the app on their phone is still a laptop nobody
   * has explained the tray to.
   */
  hasOnboarded: boolean;

  /**
   * Start with the machine.
   *
   * Off by default and asked for rather than assumed: an app that quietly adds
   * itself to startup the first time it runs is the thing people go hunting
   * through Task Manager to undo.
   */
  launchAtLogin: boolean;
  /**
   * When starting with the machine, go straight to the tray.
   *
   * The reason most people want it on at all: the clipboard, the quick-paste
   * hotkey and file transfers all work with no window open, so the window
   * appearing on every boot is the only unwelcome part of it.
   */
  launchMinimized: boolean;

  /**
   * Days to keep images and file attachments. Text is always kept.
   * 0 means clean them up as soon as the next sweep runs.
   */
  retainMediaDays: number;
  /** Ceiling on the stored history, in megabytes. */
  maxStorageMb: number;

  /**
   * The system-wide hotkey that opens the quick-paste overlay, in Electron's
   * accelerator syntax. Empty disables it entirely.
   *
   * Registered globally, which means it is taken from every other application on
   * the machine — so it has to be something nothing else wants, and it has to be
   * changeable when something does.
   */
  quickPasteShortcut: string;
  /**
   * After picking an item, put it on the clipboard *and* paste it into whatever
   * had focus. Off means it is only copied, and you paste it yourself.
   */
  quickPasteAutoPaste: boolean;

  /**
   * Check for new versions in the background. Worth leaving on: two devices on
   * different versions cannot talk to each other at all.
   */
  autoUpdate: boolean;
};

export const RETENTION_CHOICES = [
  { value: 1, label: '1 day' },
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
  { value: 0, label: 'Never keep' }
] as const;

export const STORAGE_CHOICES = [
  { value: 25, label: '25 MB' },
  { value: 100, label: '100 MB' },
  { value: 250, label: '250 MB' },
  { value: 1000, label: '1 GB' }
] as const;

export type InterfaceReport = {
  name: string;
  address: string;
  broadcast: string | null;
  virtual: boolean;
  chosen: boolean;
};

/** What the network panel needs to tell one failure mode from another. */
export type NetworkDiagnostics = {
  protocolVersion: number;
  interfaces: InterfaceReport[];
  broadcastTargets: string[];
  packetsSent: number;
  packetsReceived: number;
  lastReceivedAt: number;
  lastError: string;
  /** Protocol versions seen from other devices that this app cannot talk to. */
  otherVersions: number[];
  /** Frames carried over the direct TCP transport rather than UDP. */
  tcpFramesSent: number;
  tcpFramesReceived: number;
  /** Hosts with a live direct connection right now. */
  directHosts: string[];
};

export type UpdateState =
  | 'idle'
  | 'checking'
  | 'current'
  | 'available'
  | 'downloading'
  /** A download died mid-transfer and is being resumed. */
  | 'retrying'
  | 'ready'
  /** Platform cannot install by itself — download it manually. */
  | 'manual'
  /** Running from source, so there is nothing to update against. */
  | 'unsupported'
  | 'error';

export type UpdateStatus = {
  state: UpdateState;
  currentVersion: string;
  availableVersion?: string;
  releaseNotes?: string;
  percent?: number;
  error?: string;
  /** Which retry is in flight, when state is 'retrying'. */
  attempt?: number;
};

export type ConnectivityResult = {
  host: string;
  tcpReachable: boolean;
  udpReplied: boolean;
  verdict: 'direct' | 'udp-only' | 'tcp-only' | 'unreachable';
  detail: string;
};

export type StorageStats = {
  /** Bytes the stored history occupies on disk. */
  totalBytes: number;
  /** Of that, how much is images and attachments. */
  mediaBytes: number;
  clipboardEntries: number;
  chatMessages: number;
  /** Attachments dropped by cleanup so far. */
  clearedAttachments: number;
};

export const FONT_SCALES = [
  { value: 0.9, label: 'Small' },
  { value: 1, label: 'Default' },
  { value: 1.15, label: 'Large' },
  { value: 1.3, label: 'Larger' }
] as const;

export const MIN_FONT_SCALE = 0.9;
export const MAX_FONT_SCALE = 1.3;

/**
 * What the window is doing, for the controls the application draws itself.
 *
 * `platform` is reported by the main process rather than sniffed in the
 * renderer: it decides whether this window has its own controls to draw or
 * whether the system is still drawing them, and getting that wrong means
 * either two sets of buttons or none.
 */
/**
 * A `campusconnect://` link, once it has been understood.
 *
 * Room QR codes have always encoded one of these; registering the scheme is
 * what finally gives scanning one somewhere to go.
 */
export type DeepLink = {
  kind: 'join';
  /** The room's join code, as carried in the link. */
  code: string;
  /** The room's name, for the dialog. Cosmetic — never trusted for access. */
  roomName: string;
};

export type WindowState = {
  maximized: boolean;
  fullScreen: boolean;
  platform: 'darwin' | 'win32' | 'linux';
  /**
   * Pixels the window currently extends above the usable screen, which a
   * maximised frameless window on Windows does. The interface pads itself by
   * this much so its top edge is not quietly cut off.
   */
  topInset: number;
};

export type AppState = {
  deviceId: string;
  deviceName: string;
  appVersion: string;
  listenPort: number;
  localAddress: string;
  peers: PeerInfo[];
  /** Devices added by IP at some point — reconnected to automatically on every launch. */
  rememberedPeers: RememberedPeer[];
  currentRoomId?: string;
  rooms: RoomInfo[];
  discovered: DiscoveredRoom[];
  /** Encrypted rooms this device holds no key for — readable only after unlock. */
  lockedRoomIds: string[];
  /** Invitations waiting on this device. */
  invites: RoomInvite[];
  /** roomId -> device ids this device has invited and not yet heard back from. */
  invitedDeviceIds: Record<string, string[]>;
  /** Calls believed to be live right now, in any room this device is in. */
  activeCalls: ActiveCall[];
  /**
   * A ring this device has not yet answered, if any. Read once by the call
   * window on mount, so it learns about a ring that started before the window
   * had finished loading — a push event alone would arrive too early to hear.
   */
  incomingCall?: CallRinging;
  /** Devices this one refuses to hear from, newest first. */
  blocked: BlockedDevice[];
  /** Saved text, ranked by what you actually reach for. */
  snippets: Snippet[];
  /** Whether a phone can currently reach a room, and which. */
  phone: PhoneAccess;
  /** The remote desktop session this device is in, either role, if any. */
  remote?: RemoteSessionState;
  /** Peer-to-peer file transfers, either role, if any. */
  fileShare?: FileShareState;
  /** Direct 1:1 message threads — summaries only; a thread's messages are fetched on demand. */
  dmThreads: DmThreadSummary[];
  /** Whether this machine can accept being driven, and why not if it cannot. */
  remoteCapabilities: RemoteCapabilities;
  storage: StorageStats;
  diagnostics: NetworkDiagnostics;
  update: UpdateStatus;
  settings: AppSettings;
};

export type ActionResult = {
  ok: boolean;
  message: string;
};

// --- peer-to-peer file sharing ------------------------------------------------

/**
 * One step of a peer-to-peer file transfer.
 *
 * Like `remote` and `call`, a single wire type carries a union. The sender asks
 * (`request`), the receiver answers (`accept`/`decline`), and then the sender
 * describes each file (`offer`) and streams it in base64 slices (`data`) until
 * the receiver confirms it is whole (`file-done`). `finish` ends the batch and
 * `cancel` aborts it at any point, from either side.
 *
 * Slices are deliberately small (well under one datagram) so every slice travels
 * alone: over TCP it is one ordered frame, over UDP one datagram that the
 * receiver places by index. Nothing here is persisted — transfers exist only
 * for the lifetime of the app, and the receiver keeps whichever files it saved.
 */
export type FileXferSignal =
  | { kind: 'request'; transferId: string }
  | { kind: 'accept'; transferId: string }
  | { kind: 'decline'; transferId: string; reason: string }
  | { kind: 'offer'; transferId: string; fileId: string; name: string; size: number }
  | { kind: 'data'; transferId: string; fileId: string; index: number; total: number; data: string }
  | {
      kind: 'file-done';
      transferId: string;
      fileId: string;
      /** Receiver only: where the file was written. */
      savedPath?: string;
    }
  | { kind: 'finish'; transferId: string; ok: boolean; error?: string }
  | { kind: 'cancel'; transferId: string; reason?: string };

/** One file inside a transfer, and how far it has got. */
export type FileShareFileState = {
  fileId: string;
  name: string;
  size: number;
  /** Bytes moved so far — sent by the sender, received by the receiver. */
  moved: number;
  status: 'queued' | 'active' | 'done' | 'error';
  /** Where the receiver wrote it, once done. */
  savedPath?: string;
};

export type FileShareTransfer = {
  transferId: string;
  role: 'sender' | 'receiver';
  peerId: string;
  peerName: string;
  status: 'requested' | 'active' | 'done' | 'cancelled' | 'error';
  files: FileShareFileState[];
  bytesDone: number;
  bytesTotal: number;
  error?: string;
  startedAt: number;
  finishedAt?: number;
};

/**
 * The whole file-sharing surface for the renderer. Mirrors `remote`: transient
 * (never persisted), one session at a time, with anything pending surfaced as
 * `incoming` for the accept/decline dialog.
 */
export type FileShareState = {
  /** A request waiting on this device, unanswered. */
  incoming?: {
    transferId: string;
    fromDeviceId: string;
    fromDeviceName: string;
    at: number;
  };
  transfers: FileShareTransfer[];
  /** Where received files land. Kept so the UI can offer to open it. */
  downloadFolder: string;
};

/**
 * Direct 1:1 messages. Device-to-device, the same as file sharing — reachable
 * by anyone currently visible on the network, with no room in common
 * required. Unlike a file transfer there is nothing to consent to before a
 * message arrives.
 *
 * Amendments (`edit`/`delete`/`reaction`/`receipt`/`typing`) mirror the ones
 * room chat already carries on `WireMessage` (`chatEdit`/`chatDelete`/
 * `chatReaction`/`chat-receipt`/`chat-typing`) — same shape, same reasoning,
 * just addressed peer-to-peer instead of sealed into a room. Every kind here
 * travels sealed under `WireMessage.dmSealed` — see `dmAgreedKey` — so a DM
 * is end-to-end encrypted regardless of which of these it is.
 */
export type DirectMessageSignal =
  | {
      kind: 'message';
      id: string;
      type: 'text' | 'file' | 'image';
      content: string;
      dataUrl?: string;
      fileName?: string;
      fileSize?: number;
      replyTo?: ChatReplyTo;
      sentAt: number;
    }
  | { kind: 'edit'; id: string; content: string; editedAt: number }
  | { kind: 'delete'; id: string }
  | { kind: 'reaction'; id: string; emoji: string; on: boolean }
  | { kind: 'receipt'; messageIds: string[]; receipt: 'delivered' | 'seen' }
  | { kind: 'typing'; typing: boolean };

/**
 * One message in a direct thread. `peerId`/`peerName` always name "the other
 * device," whichever way the message went — simpler for the renderer than
 * tracking from/to separately for a conversation that only ever has two
 * sides.
 *
 * The same shape room chat's `ChatMessage` carries for type/attachment/
 * edit/delete/reaction/receipts — deliberately, so the renderer's message-row
 * UI can be shared between the two rather than forked. `deleted` follows the
 * same tombstone convention: the row stays (so a reply into it still
 * resolves) with its content scrubbed, rather than disappearing outright.
 * `deliveredTo`/`seenBy` follow the same array-of-device-ids shape room chat
 * uses too, even though a DM thread only ever has one other party to put in
 * them — what lets both reuse the exact same `statusOf`/`Receipt` rendering.
 */
export type DirectMessage = {
  id: string;
  peerId: string;
  peerName: string;
  fromSelf: boolean;
  type: 'text' | 'file' | 'image';
  content: string;
  dataUrl?: string;
  fileName?: string;
  fileSize?: number;
  sentAt: number;
  replyTo?: ChatReplyTo;
  editedAt?: number;
  deleted?: boolean;
  reactions?: Record<string, string[]>;
  deliveredTo?: string[];
  seenBy?: string[];
  /** Bookmarked on this device only — see `ChatMessage.pinned`. */
  pinned?: boolean;
};

/** One thread's summary, for the list of who you have messaged. */
export type DmThreadSummary = {
  peerId: string;
  peerName: string;
  lastMessage: string;
  lastAt: number;
  unread: number;
  /** Collapsed into a separate section in the Messages page, not deleted. */
  archived: boolean;
};

/** Shown in Settings → About. Single source of truth for credit and links. */
export const APP_INFO = {
  name: 'Campus Connect',
  author: 'Vijaya Pardhu',
  authorUrl: 'https://github.com/Vijayapardhu',
  repositoryUrl: 'https://github.com/Vijayapardhu/Clipboard',
  websiteUrl: 'https://vijayaapardhu.dev/Clipboard/',
  license: 'MIT'
} as const;
