export const PROTOCOL_VERSION = 2;

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
};

export type ChatMessage = {
  id: string;
  type: 'text' | 'file' | 'image';
  content: string;
  dataUrl?: string;
  fileName?: string;
  deviceId: string;
  deviceName: string;
  roomId: string;
  timestamp: number;
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
  | 'chat';

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
  listenPort: number;
  localAddress: string;
  peers: PeerInfo[];
  currentRoomId?: string;
  rooms: RoomInfo[];
  discovered: DiscoveredRoom[];
  /** Encrypted rooms this device holds no key for — readable only after unlock. */
  lockedRoomIds: string[];
  settings: AppSettings;
};

export type ActionResult = {
  ok: boolean;
  message: string;
};
