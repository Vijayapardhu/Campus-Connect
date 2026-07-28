export const PROTOCOL_VERSION = 5;

export type RoomType = 'public' | 'private';
export type MemberStatus = 'pending' | 'accepted';
export type MemberRole = 'owner' | 'member';

export type RoomMember = {
  deviceId: string;
  deviceName: string;
  status: MemberStatus;
  role: MemberRole;
  joinedAt: number;
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
};

/** What the sender shows against its own message. */
export type MessageStatus = 'sent' | 'delivered' | 'seen' | 'undelivered';

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
  | 'clipboard'
  | 'chat'
  | 'chunk'
  | 'chunk-nack'
  | 'room-invite'
  | 'room-invite-accept'
  | 'room-invite-decline'
  | 'chat-receipt';

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
};

export type AppSettings = {
  /** Master switch for sharing this device's clipboard. */
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

  /** Show a system notification when the window is hidden or unfocused. */
  notifications: boolean;
  /** Tell other devices when their messages arrive and when you read them. */
  sendReceipts: boolean;

  /**
   * Days to keep images and file attachments. Text is always kept.
   * 0 means clean them up as soon as the next sweep runs.
   */
  retainMediaDays: number;
  /** Ceiling on the stored history, in megabytes. */
  maxStorageMb: number;
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

export type AppState = {
  deviceId: string;
  deviceName: string;
  appVersion: string;
  listenPort: number;
  localAddress: string;
  peers: PeerInfo[];
  currentRoomId?: string;
  rooms: RoomInfo[];
  discovered: DiscoveredRoom[];
  /** Encrypted rooms this device holds no key for — readable only after unlock. */
  lockedRoomIds: string[];
  /** Invitations waiting on this device. */
  invites: RoomInvite[];
  /** roomId -> device ids this device has invited and not yet heard back from. */
  invitedDeviceIds: Record<string, string[]>;
  storage: StorageStats;
  diagnostics: NetworkDiagnostics;
  settings: AppSettings;
};

export type ActionResult = {
  ok: boolean;
  message: string;
};

/** Shown in Settings → About. Single source of truth for credit and links. */
export const APP_INFO = {
  name: 'Shared Clipboard',
  author: 'Vijaya Pardhu',
  authorUrl: 'https://github.com/Vijayapardhu',
  repositoryUrl: 'https://github.com/Vijayapardhu/Clipboard',
  websiteUrl: 'https://vijayapardhu.github.io/Clipboard/',
  license: 'MIT'
} as const;
