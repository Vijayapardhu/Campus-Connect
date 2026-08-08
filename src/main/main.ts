import {
  app,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  dialog,
  ipcMain,
  Menu,
  Notification,
  session,
  Tray,
  nativeImage,
  nativeTheme,
  safeStorage,
  shell
} from 'electron';
import log from 'electron-log';
import Store from 'electron-store';
import QRCode from 'qrcode';
import AdmZip from 'adm-zip';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import dgram from 'node:dgram';
import { randomUUID, createHash } from 'node:crypto';
import {
  createImageClipboardPayload,
  createTextClipboardPayload,
  readClipboardImage,
  readClipboardText,
  writeClipboardImage,
  writeClipboardText
} from './clipboardStore';
import { getSystemDeviceName } from './systemInfo';
import { KeyVault } from './keyVault';
import {
  createIdentity,
  digestOf,
  sign as signPayload,
  verify as verifySignature,
  withinSkew,
  type DeviceIdentity,
  type Signable
} from './deviceIdentity';
import { DeviceRegistry, type DeviceKeyRecord } from './deviceRegistry';
import { directRoomId, RoomManager } from './roomManager';
import { HistoryManager } from './historyManager';
import { CallManager } from './callManager';
import { SnippetManager } from './snippetManager';
import { QuickPaste } from './quickPaste';
import { currentWindowState, IS_MAC, SessionWindow } from './sessionWindow';
import { HostIndicator } from './hostIndicator';
import { PhoneServer, PHONE_PORT, type PhoneTls } from './phoneServer';
import { clearPhoneCertificate, ensurePhoneCertificate } from './phoneCert';
import type { PhonePairing } from './phoneSession';
import { RemoteSessionManager } from './remoteSession';
import { FileShareManager } from './fileShare';
import { DirectMessageManager } from './directMessage';
import { createDisplayInjector, getPasteAction, getRemoteCapabilities } from './remoteInput';
import { parseRemoteInput, type Injector } from './remoteControl';
import { migrateUserData } from './migrate';
import { DEEP_LINK_SCHEME, deepLinkFromArgv, parseDeepLink } from '../shared/deepLink';
import { ChunkAssembler, splitIntoChunks } from './transfer';
import { TcpTransport, probeTcp } from './tcp';
import { Updater } from './updater';
import {
  LIMITED_BROADCAST,
  describeInterfaces,
  listBroadcastTargets,
  pickLocalAddress,
  type NetworkInterface
} from './network';
import {
  createProof,
  deriveRoomKey,
  dmAgreedKey,
  generateJoinCode,
  generateSalt,
  normalizeJoinCode,
  openJson,
  sealJson,
  verifyProof
} from './crypto';
import {
  APP_INFO,
  MAX_CALL_PARTICIPANTS,
  MAX_FONT_SCALE,
  MIN_FONT_SCALE,
  PROTOCOL_VERSION,
  type ActionResult,
  type AppSettings,
  type AppState,
  type BlockedDevice,
  type CallMode,
  type CallRinging,
  type CallSignal,
  type CallWindowIntent,
  type ChatMessage,
  type ChatReplyTo,
  type ClipboardHistoryEntry,
  type ClipboardPayload,
  type ConnectivityResult,
  type JoinRequest,
  type PeerInfo,
  type RememberedPeer,
  type RoomInfo,
  type RoomInvite,
  type RemoteCapabilities,
  type RemoteGrant,
  type RemoteRequest,
  type RemoteSignal,
  type RoomRestrictions,
  type RoomType,
  type SearchHit,
  type PhoneAccess,
  type Snippet,
  type RoomUpdate,
  type StorageStats,
  type DeepLink,
  type DirectMessage,
  type DirectMessageSignal,
  type DmThreadSummary,
  type UpdateStatus,
  type WindowState,
  type WireMessage
} from '../shared/types';
import type { CallSignalEvent, CallStartResult, ScreenSource } from '../shared/bridge';
import { isOpenableUrl } from '../shared/contentType';
import { mentionedDeviceIds } from '../shared/mentions';
import { dataUrlBytes } from '../shared/dataUrl';
import { formatTranscript, transcriptFileName, type TranscriptEntry } from '../shared/transcript';

type AppStore = {
  deviceId: string;
  deviceName: string;
  peers: PeerInfo[];
  /** Devices added by IP at some point — reconnected to automatically on every launch. */
  rememberedPeers: RememberedPeer[];
  currentRoomId?: string;
  settings: AppSettings;
  rooms: RoomInfo[];
  /**
   * The old plaintext map of roomId to hex key.
   *
   * Superseded by `roomKeyVault` and emptied on first launch after the
   * upgrade. It stays in the type so the migration has something to read.
   */
  roomKeys: Record<string, string>;
  /** Base64 of the room keys, encrypted by the OS credential store. */
  roomKeyVault?: string;
  /** This device's Ed25519 keypair, in the same encrypted store. */
  identityVault?: string;
  /** Which public key belongs to which device id. Public data, not secret. */
  deviceKeys: Record<string, DeviceKeyRecord>;
  clipboardHistory: ClipboardHistoryEntry[];
  chatHistory: ChatMessage[];
  /** Direct 1:1 messages, device-to-device — not part of any room's history. */
  directMessages: DirectMessage[];
  /** Peer ids whose DM thread is archived — collapsed in the Messages page, not deleted. */
  dmArchivedThreads: string[];
  blocked: BlockedDevice[];
  snippets: Snippet[];
  phonePairings: PhonePairing[];
};

/**
 * The port everything on the network talks over.
 *
 * Overridable, which is not a preference — it is the only way to run a second
 * copy on one machine. Two instances otherwise fight over the same port, and
 * since a peer is addressed by the host it announces, both would claim the same
 * address and neither could reach the other. Set `CAMPUS_CONNECT_PORT` and a
 * development copy stays entirely out of the way of an installed one.
 *
 * Ignored unless it parses to a usable port, so a stray value cannot leave the
 * app listening somewhere nobody will look for it.
 */
function configuredPort(): number {
  const override = Number(process.env.CAMPUS_CONNECT_PORT);
  return Number.isInteger(override) && override > 1024 && override < 65536 ? override : 37777;
}

const BROADCAST_PORT = configuredPort();
const ANNOUNCE_INTERVAL_MS = 3000;
/**
 * Checking the clipboard is now cheap enough to do properly. It used to
 * re-encode any image it found on every tick, which is why it could not run
 * more than once a second; the wait before a copy left the machine was most of
 * what "it takes a while to arrive" meant.
 */
const CLIPBOARD_POLL_MS = 350;
const PEER_TTL_MS = 15000;
/** A UDP datagram tops out at 64KB; anything larger has to be chunked. */
const MAX_DATAGRAM_BYTES = 60000;
/**
 * Characters of the serialised message per chunk.
 *
 * Measured rather than guessed: 40 KB datagrams IP-fragment into ~28 pieces
 * each, so a single lost fragment costs the whole 40 KB. 8 KB keeps that
 * amplification small without turning a multi-megabyte transfer into tens of
 * thousands of packets.
 */
const CHUNK_CHARS = 8000;
/**
 * The socket buffers matter far more than the chunk size. With the OS default
 * a 3 MB transfer lost ~50% of its datagrams to buffer overflow before they
 * ever reached the wire; at 8 MB the same transfer loses none.
 */
const SOCKET_BUFFER_BYTES = 8 * 1024 * 1024;
/**
 * Refuse to even start a transfer beyond this — measured, not chosen.
 *
 * A file is base64-encoded, sealed, base64-encoded again and JSON-stringified,
 * so it becomes roughly 1.78x its own size as a single string. V8 will not
 * create a string past ~512 MB, and JSON.parse gives out well before that: a
 * 150 MB file killed an 8 GB heap outright. 50 MB peaks at ~560 MB RSS, which
 * is the most a background utility has any business using.
 */
const MAX_TRANSFER_BYTES = 128 * 1024 * 1024;
/** How long the sender keeps chunks around to answer retransmit requests. */
const OUTBOUND_TRANSFER_TTL_MS = 20000;
/** Quiet period before the receiver asks for the pieces it is missing. */
const NACK_AFTER_MS = 500;
const TRANSFER_SWEEP_MS = 300;
/** Chunks are paced so the socket buffer is not overwhelmed and dropped. */
const CHUNK_BATCH = 8;
const CHUNK_PACING_MS = 2;
/** Cap on how many gaps one retransmit request advertises. */
const MAX_NACK_INDICES = 512;
/**
 * Files inflate to roughly 1.78x their size by the time they are on the wire,
 * so a 50 MB file is ~89 MB of datagrams and ~11,700 chunks.
 *
 * Anything much larger cannot work through this path at all — see the note on
 * MAX_TRANSFER_BYTES. Streaming the file from disk instead of holding it in
 * memory is what would lift this properly.
 */
const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** The shared "that is too big" answer, so every send path says the same thing. */
function refuseIfTooLarge(bytes: number): ActionResult | null {
  if (bytes <= MAX_FILE_BYTES) {
    return null;
  }
  return fail(
    `Files are limited to ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB — that one is ${(bytes / 1024 / 1024).toFixed(1)} MB.`
  );
}

/**
 * How far ahead of the network a file transfer may queue before it waits.
 *
 * A socket write queues in memory rather than refusing, so without a ceiling a
 * 500 MB file becomes 500 MB of RSS — exactly what streaming it slice by slice
 * was meant to prevent.
 */
const FILE_SHARE_HIGH_WATER_BYTES = 4 * 1024 * 1024;

/** Enough to make common files preview and open correctly on the far side. */
const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
};

/** Notification bodies should be a glance, not a wall of text. */
function truncateForNotice(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > 120 ? `${single.slice(0, 120)}…` : single;
}

function mimeForFile(fileName: string): string {
  return MIME_BY_EXTENSION[path.extname(fileName).toLowerCase()] ?? 'application/octet-stream';
}

const DEFAULT_SETTINGS: AppSettings = {
  online: true,
  syncEnabled: true,
  autoApply: true,
  shareImages: true,
  theme: 'system',
  fontScale: 1,
  fontFamily: '',
  notifications: true,
  notificationSound: true,
  sendReceipts: true,
  ringOnCalls: true,
  startCallsMuted: false,
  quickPasteShortcut: 'Control+Shift+V',
  quickPasteAutoPaste: true,
  hasOnboarded: false,
  launchAtLogin: false,
  launchMinimized: true,
  retainMediaDays: 7,
  maxStorageMb: 100,
  autoUpdate: true
};

/** How often the stored history is swept for attachments to drop. */
const COMPACT_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Directory names this app's data has lived under before now. Electron derives
 * the data directory from the application name, so the rename to Campus Connect
 * moved it; the first run under the new name brings the old one across.
 *
 * This has to happen before the store below is constructed, which is why it is
 * here at module scope rather than in `whenReady`.
 */
const migration = migrateUserData({
  appData: app.getPath('appData'),
  userData: app.getPath('userData'),
  legacyNames: ['shared-clipboard-desktop', 'Shared Clipboard']
});

const store = new Store<AppStore>({
  defaults: {
    deviceId: randomUUID(),
    deviceName: getSystemDeviceName(),
    peers: [],
    rememberedPeers: [],
    currentRoomId: undefined,
    settings: DEFAULT_SETTINGS,
    rooms: [],
    roomKeys: {},
    deviceKeys: {},
    clipboardHistory: [],
    chatHistory: [],
    directMessages: [],
    dmArchivedThreads: [],
    blocked: [],
    snippets: [],
    phonePairings: []
  }
});

/**
 * Everything reads through here rather than touching the store directly.
 *
 * electron-store re-reads and re-parses its entire file on every single `get`,
 * and rewrites the whole thing on every `set`. That file also holds the
 * clipboard and chat history, so it is routinely megabytes of JSON — and the
 * hot paths hit it constantly: the room roster is checked for every message
 * that arrives, and a peer's last-seen time is refreshed for every packet,
 * which during a large image is thousands of them. The app was spending most of
 * a transfer parsing its own settings file.
 *
 * So values are read from disk once and kept in memory afterwards. Writes still
 * go straight through, because they have to survive a crash.
 */
const cache = new Map<keyof AppStore, unknown>();

function read<K extends keyof AppStore>(key: K): AppStore[K] {
  if (!cache.has(key)) {
    cache.set(key, store.get(key));
  }
  return cache.get(key) as AppStore[K];
}

function write<K extends keyof AppStore>(key: K, value: AppStore[K]): void {
  cache.set(key, value);
  save(key, value);
}

/** How long to wait before trying a write that failed again. */
const SAVE_RETRY_MS = 15000;
const retryingSaves = new Set<keyof AppStore>();

/**
 * Writes a value out. Failing to do so must never take the app down.
 *
 * electron-store saves by writing a temporary file and renaming it over the
 * real one, and on Windows that rename fails with EPERM whenever anything else
 * holds the file open for a moment — a virus scanner, a backup agent, a folder
 * being synced, or a second copy of the app. It happened inside a history flush
 * on a timer, where nothing was there to catch it, so a momentary file lock
 * killed the whole app with a stack trace in front of the user.
 *
 * The value is already in memory, so a failed write costs nothing right away.
 * It is tried again shortly, and any later write of the same key covers it.
 *
 * `undefined` is a delete: electron-store throws rather than clearing the key,
 * and clearing the current room is exactly what happens when you leave one.
 */
function save<K extends keyof AppStore>(key: K, value: AppStore[K]): void {
  try {
    if (value === undefined) {
      store.delete(key);
    } else {
      store.set(key, value);
    }
  } catch (error) {
    log.warn(`Could not save ${String(key)}, will try again: ${(error as Error).message}`);
    scheduleSaveRetry(key);
  }
}

function scheduleSaveRetry(key: keyof AppStore): void {
  if (retryingSaves.has(key)) {
    return;
  }

  retryingSaves.add(key);
  const timer = setTimeout(() => {
    retryingSaves.delete(key);
    persist(key);
  }, SAVE_RETRY_MS);
  timer.unref?.();
}

/** Writes out the in-memory copy of a value that is only updated in place. */
function persist<K extends keyof AppStore>(key: K): void {
  if (cache.has(key)) {
    save(key, cache.get(key) as AppStore[K]);
  }
}

/*
 * Derived room keys go through the OS credential store rather than into
 * config.json in the clear. safeStorage is the Electron half of it; the logic
 * lives in keyVault.ts, which imports no Electron so the tests can run it.
 */
const keyVault = new KeyVault(
  {
    readVault: () => read('roomKeyVault'),
    writeVault: (blob) => write('roomKeyVault', blob),
    readLegacy: () => read('roomKeys'),
    clearLegacy: () => {
      if (Object.keys(read('roomKeys')).length > 0) {
        write('roomKeys', {});
      }
    }
  },
  {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plaintext) => safeStorage.encryptString(plaintext),
    decrypt: (payload) => safeStorage.decryptString(payload)
  },
  (message) => log.warn(`[keys] ${message}`)
);

/*
 * This device's signing keypair, in the same OS-encrypted store as the room
 * keys. Generated once, on the first launch that needs it.
 *
 * If the vault cannot be read — a different OS account, a reset keyring — a
 * fresh identity is generated rather than the app refusing to start. The
 * consequence is that other devices see a known id arriving with a new key
 * and refuse it until the room is joined again, which is the correct
 * outcome: from the outside, an unreadable vault and a stolen id look the
 * same, and only rejoining proves the difference.
 */
const identityVault = new KeyVault(
  {
    readVault: () => read('identityVault'),
    writeVault: (blob) => write('identityVault', blob),
    readLegacy: () => ({}),
    clearLegacy: () => {}
  },
  {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plaintext) => safeStorage.encryptString(plaintext),
    decrypt: (payload) => safeStorage.decryptString(payload)
  },
  (message) => log.warn(`[identity] ${message}`)
);

const identity: DeviceIdentity = (() => {
  const stored = identityVault.read();
  const fresh = createIdentity();

  /*
   * The signing pair is kept if it exists, because it *is* this device's
   * identity — other devices have it bound in their rosters, and replacing it
   * would make every one of them refuse us until we rejoined. The agreement
   * pair can be added to an identity that predates it without that cost:
   * nothing has been wrapped to it yet.
   */
  const next: DeviceIdentity = {
    publicKey: stored.publicKey || fresh.publicKey,
    privateKey: stored.privateKey || fresh.privateKey,
    boxPublicKey: stored.boxPublicKey || fresh.boxPublicKey,
    boxPrivateKey: stored.boxPrivateKey || fresh.boxPrivateKey
  };

  const complete =
    stored.publicKey && stored.privateKey && stored.boxPublicKey && stored.boxPrivateKey;

  if (!complete) {
    identityVault.write({ ...next });
    log.info(
      stored.publicKey
        ? '[identity] Added an agreement key to this device.'
        : '[identity] Generated a signing key for this device.'
    );
  }

  return next;
})();

const deviceRegistry = new DeviceRegistry({
  read: () => read('deviceKeys'),
  write: (records) => write('deviceKeys', records)
});

const roomManager = new RoomManager({
  readRooms: () => read('rooms'),
  writeRooms: (rooms) => write('rooms', rooms),
  readKeys: () => keyVault.read(),
  writeKeys: (keys) => keyVault.write(keys)
});

const historyManager = new HistoryManager({
  readClipboard: () => read('clipboardHistory'),
  writeClipboard: (entries) => write('clipboardHistory', entries),
  readChat: () => read('chatHistory'),
  writeChat: (messages) => write('chatHistory', messages)
});

const snippetManager = new SnippetManager({
  read: () => read('snippets'),
  write: (snippets) => write('snippets', snippets)
});

/**
 * Phone access. Off until somebody turns it on, and never restored on startup —
 * a machine that came back up already serving a room to the network is not
 * something anyone intends.
 */
let phoneServer: PhoneServer | null = null;

/** Live calls, in memory only. A call cannot outlive the run it happened in. */
const callManager = new CallManager();

/**
 * Remote desktop sessions. Also memory-only, and emphatically so: a session
 * that survived a restart would mean a machine coming back up already agreeing
 * to be driven by someone, which nobody ever intends.
 */
const remoteSessions = new RemoteSessionManager();

/**
 * Peer-to-peer file transfers. Memory-only like the rest of the sessions: a
 * transfer is a thing that happens now, and nothing about it should survive a
 * restart except the files the receiver chose to keep.
 */
const fileShares = new FileShareManager({
  send: (peerId, signal) => {
    const host = getPeerHost(peerId);
    if (!host) {
      return false;
    }
    const message = baseMessage('file-xfer');
    message.fileXfer = signal;

    /*
     * File slices go over the direct link and nowhere else.
     *
     * The rest of the protocol tolerates a lost datagram — a clipboard item
     * that misses gets shared again. A file does not: there is no retransmit
     * on this path, so one dropped slice loses the whole file, and a ~32 KB
     * datagram IP-fragments into two dozen pieces that only all have to arrive.
     * TCP already orders and retransmits, and every discovered peer is dialled,
     * so refusing here costs nothing and turns silent corruption into a clear
     * "no direct connection" the moment it matters.
     */
    if (signal.kind === 'data') {
      return Boolean(tcp?.isConnected(host)) && tcp!.send(host, JSON.stringify(message));
    }
    return sendUdpMessage(message, host);
  },
  downloadFolder: () => path.join(app.getPath('downloads'), 'Campus Connect'),
  onChanged: sendStateToRenderer,
  awaitReady: async (peerId) => {
    const host = getPeerHost(peerId);
    if (!host) {
      return;
    }
    // Bounded memory rather than bounded speed: the file streams as fast as the
    // link drains, and never queues more than this much ahead of it.
    while (tcp?.isConnected(host) && tcp.pendingBytes(host) > FILE_SHARE_HIGH_WATER_BYTES) {
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
});

/**
 * Direct 1:1 messages. Same reach as file sharing — device-to-device, no room
 * required — and the same wire mechanics, minus the request/accept step: a
 * message has nothing to consent to before it arrives, the same as room chat.
 */
const directMessages = new DirectMessageManager({
  read: () => read('directMessages'),
  write: (messages) => write('directMessages', messages),
  readArchived: () => read('dmArchivedThreads'),
  writeArchived: (peerIds) => write('dmArchivedThreads', peerIds)
});

/**
 * The pairwise AES key this device and `peerId` use to seal a direct message,
 * or `null` if that peer's box public key is not known yet.
 *
 * In practice this is only null for a device that has never sent this one a
 * single authenticated packet — every message carries its sender's box key
 * (`deliver`), so anything already visible in `state.peers` already has one
 * recorded. No exchange round trip is needed: X25519 agreement gives both
 * sides the identical key from nothing but their own private key and the
 * other's public one.
 */
function dmKeyFor(peerId: string): Buffer | null {
  const boxKey = read('peers').find((peer) => peer.id === peerId)?.boxPublicKey;
  return boxKey ? dmAgreedKey(identity.boxPrivateKey, boxKey, deviceId(), peerId) : null;
}

/**
 * Seals a direct-message body under the pairwise key for that peer. Unlike
 * `attachRoomBody`, there is no unencrypted path — a DM has no password to
 * make encryption conditional on, so it is unconditional instead: every
 * direct message is end-to-end encrypted, or it is not sent at all.
 */
function attachDmBody(message: WireMessage, peerId: string, body: Partial<WireMessage>): boolean {
  const key = dmKeyFor(peerId);
  if (!key) {
    return false;
  }
  message.dmSealed = sealJson(key, body);
  return true;
}

/** The other half of `attachDmBody` — `null` if the seal cannot be opened (wrong/unknown key, tampered packet). */
function readDmBody(message: WireMessage): Partial<WireMessage> | null {
  const key = dmKeyFor(message.deviceId);
  return key ? openJson<Partial<WireMessage>>(key, message.dmSealed) : null;
}

function sendDirectMessage(peerId: string, signal: DirectMessageSignal): boolean {
  const host = getPeerHost(peerId);
  if (!host) {
    return false;
  }
  const message = baseMessage('direct-message');
  // Addressed like any other targeted signal, so a stale `peers` entry —
  // the address DHCP has since handed to a different device — cannot
  // deliver this to whoever now answers at that host instead of the one
  // asked for.
  message.targetDeviceId = peerId;
  if (!attachDmBody(message, peerId, { directMessage: signal })) {
    return false; // This device's box key has not been heard yet — nothing to seal to.
  }
  return sendUdpMessage(message, host);
}

let mainWindow: BrowserWindow | null = null;
/**
 * Every window that should hear about `emit()` — the main window, plus a call
 * or remote-session window for as long as one exists. A hardcoded `mainWindow`
 * here is what kept a second window from ever learning a call had started.
 */
const interestedWindows = new Set<BrowserWindow>();
let udpSocket: dgram.Socket | null = null;
let announceTimer: NodeJS.Timeout | null = null;
let clipboardPollTimer: NodeJS.Timeout | null = null;
let transferSweepTimer: NodeJS.Timeout | null = null;
let callSweepTimer: NodeJS.Timeout | null = null;
let compactTimer: NodeJS.Timeout | null = null;
let tcp: TcpTransport | null = null;
let updater: Updater | null = null;

/** Enough to tell a firewall problem from a version problem from a quiet network. */
const diagnostics = {
  packetsSent: 0,
  packetsReceived: 0,
  lastReceivedAt: 0,
  lastError: '',
  otherVersions: [] as number[],
  tcpFramesSent: 0,
  tcpFramesReceived: 0
};
let quickPaste: QuickPaste | null = null;
/** The call window — created the first time a call starts or rings, reused after. */
let callWindow: SessionWindow | null = null;
/** The controller's window onto a remote session — the host stays in the main window. */
let remoteWindow: SessionWindow | null = null;
/** The floating "being controlled" reminder, shown for the duration of a hosted session. */
let hostIndicator: HostIndicator | null = null;
/** What the call window should do the moment it has finished loading. */
let pendingCallIntent: CallWindowIntent | null = null;
let tray: Tray | null = null;
let lastLocalClipboardHash = '';
let lastRemoteClipboardHash = '';
/** The image already accounted for, so the poller never re-encodes it. */
let lastClipboardImageFingerprint = '';
let isQuiting = false;

// --- helpers -----------------------------------------------------------------

/** Flattens Node's interface map into something the network helpers can read. */
function currentInterfaces(): NetworkInterface[] {
  const flat: NetworkInterface[] = [];

  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address) {
        flat.push({
          name,
          address: address.address,
          netmask: address.netmask,
          family: String(address.family),
          internal: address.internal
        });
      }
    }
  }

  return flat;
}

/**
 * The address other devices should reply to. Deliberately not "the first
 * non-internal IPv4" — on a machine with WSL or Hyper-V installed that is
 * usually a virtual adapter, and the address then travels inside every message
 * as somewhere unreachable.
 */
function getLocalIpAddress(): string {
  return pickLocalAddress(currentInterfaces());
}

function getSettings(): AppSettings {
  return { ...DEFAULT_SETTINGS, ...read('settings') };
}

function deviceId(): string {
  return read('deviceId');
}

function deviceName(): string {
  return read('deviceName');
}

function getAppState(): AppState {
  return {
    deviceId: deviceId(),
    deviceName: deviceName(),
    appVersion: app.getVersion(),
    // The port actually bound, not a remembered one. See `baseMessage`.
    listenPort: BROADCAST_PORT,
    localAddress: getLocalIpAddress(),
    peers: read('peers'),
    rememberedPeers: read('rememberedPeers'),
    currentRoomId: read('currentRoomId'),
    rooms: roomManager.getRooms(),
    discovered: roomManager.getDiscoveredRooms(),
    lockedRoomIds: roomManager
      .getRooms()
      .filter((room) => roomManager.isLocked(room.roomId))
      .map((room) => room.roomId),
    invites: listReceivedInvites(),
    invitedDeviceIds: pendingInviteIds(),
    activeCalls: callManager.list(),
    // The oldest unanswered ring, if any — see `CallWindowIntent`'s comment for
    // why the call window needs to be able to read this rather than only wait
    // for the event.
    incomingCall: [...ringing.values()].sort((a, b) => a.at - b.at)[0],
    blocked: [...read('blocked')].sort((a, b) => b.blockedAt - a.blockedAt),
    snippets: snippetManager.list(),
    phone: phoneAccessState(),
    remote: remoteSessions.current ?? undefined,
    fileShare: fileShares.state,
    dmThreads: directMessages.listThreads(),
    remoteCapabilities: getRemoteCapabilities(),
    storage: historyManager.stats(),
    update: updater?.getStatus() ?? { state: 'idle', currentVersion: app.getVersion() },
    diagnostics: {
      protocolVersion: PROTOCOL_VERSION,
      interfaces: describeInterfaces(currentInterfaces()),
      broadcastTargets: listBroadcastTargets(currentInterfaces()),
      packetsSent: diagnostics.packetsSent,
      packetsReceived: diagnostics.packetsReceived,
      lastReceivedAt: diagnostics.lastReceivedAt,
      lastError: diagnostics.lastError,
      otherVersions: [...diagnostics.otherVersions],
      tcpFramesSent: diagnostics.tcpFramesSent,
      tcpFramesReceived: diagnostics.tcpFramesReceived,
      directHosts: tcp?.connectedHosts ?? []
    },
    settings: getSettings()
  };
}

function sendStateToRenderer() {
  emit('app:state-changed', getAppState());
}

/** Tells the renderer to refetch history, so it never has to poll for it. */
/**
 * One event, to every interface that is listening.
 *
 * The window and a paired phone are two views of the same device, so anything
 * worth telling one is worth telling the other. Sending to only the window is
 * how the phone ended up polling for state and still missing everything that
 * expires on its own — a ring, a transfer request, a join asking to be let in.
 */
function emit(channel: string, payload?: unknown): void {
  for (const window of interestedWindows) {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, payload);
    }
  }
  phoneServer?.broadcast(channel, payload);
}

/** Joins the broadcast list, until the window closes on its own. */
function registerWindowForEvents(window: BrowserWindow): void {
  interestedWindows.add(window);
  window.on('closed', () => interestedWindows.delete(window));
}

function notifyHistoryChanged(roomId: string) {
  emit('history:changed', roomId);
}

/**
 * A system notification, but only when the window cannot already show it.
 * Nothing is more irritating than being notified about the window you are
 * looking at.
 */
type NotifyOptions = {
  onClick?: () => void;
  /**
   * Something that expires on its own and is gone if it is missed — a ringing
   * call, a transfer waiting on an answer, somebody asking for this screen.
   *
   * Two things change. It is raised even while the window has focus, because
   * "you are looking at the app" is not the same as "you are looking at the
   * dialog that just appeared behind your editor". And it stays on screen
   * rather than sliding away after a few seconds, because the whole point is
   * that it is still true a moment later.
   */
  urgent?: boolean;
};

/**
 * A system notification.
 *
 * Ordinary ones are suppressed while the window is focused — nothing is more
 * irritating than being notified about the thing you are already looking at.
 * Urgent ones are not, because they are the ones with a clock on them.
 */
function notify(title: string, body: string, options: NotifyOptions = {}): void {
  const settings = getSettings();
  if (!settings.notifications || !Notification.isSupported()) {
    return;
  }

  const visible = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible();
  if (visible && mainWindow?.isFocused() && !options.urgent) {
    return;
  }

  const notification = new Notification({
    title,
    body,
    silent: !settings.notificationSound,
    // Windows slides an ordinary toast away after about five seconds; 'never'
    // leaves it in the action centre until it is answered or dismissed.
    timeoutType: options.urgent ? 'never' : 'default',
    urgency: options.urgent ? 'critical' : 'normal'
  });

  notification.on('click', () => {
    showMainWindow();
    options.onClick?.();
  });
  notification.show();
}

type StatusTone = 'info' | 'success' | 'warning' | 'error';

/**
 * A backstop against repeat messages, wherever they come from. Anything the
 * user has just been told is not worth telling them again — and a message that
 * arrives twice a second is worth telling them once.
 */
const STATUS_REPEAT_MS = 4000;
const lastStatusAt = new Map<string, number>();

function sendStatus(message: string, tone: StatusTone = 'info') {
  const now = Date.now();
  const previous = lastStatusAt.get(message) ?? 0;

  if (lastStatusAt.size > 50) {
    for (const [text, at] of lastStatusAt) {
      if (now - at > STATUS_REPEAT_MS) {
        lastStatusAt.delete(text);
      }
    }
  }
  lastStatusAt.set(message, now);

  if (now - previous < STATUS_REPEAT_MS) {
    return;
  }

  log.info(`[${tone}] ${message}`);
  emit('sync:status', { message, tone });
}

function hashText(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

function hashClipboardPayload(payload: ClipboardPayload): string {
  return hashText(`${payload.kind}:${payload.text}:${payload.dataUrl ?? ''}`);
}

function baseMessage(type: WireMessage['type']): WireMessage {
  return {
    v: PROTOCOL_VERSION,
    type,
    deviceId: deviceId(),
    deviceName: deviceName(),
    /*
     * The port we are listening on right now.
     *
     * This was read from stored state that nothing ever wrote, so it could
     * disagree with reality — after a migration from an older install, or any
     * time the port is overridden. Every peer takes this as the address to
     * answer on, so a stale number tells the whole network to reach this device
     * somewhere it is not.
     */
    port: BROADCAST_PORT,
    host: getLocalIpAddress(),
    timestamp: Date.now()
  };
}

// --- transport ---------------------------------------------------------------

const BROADCAST_ADDRESS = LIMITED_BROADCAST;

/** Puts one datagram on the wire per target. Callers keep it under the size limit. */
function sendDatagram(message: WireMessage, targets: string[]): void {
  if (!udpSocket) {
    return;
  }

  const payload = Buffer.from(JSON.stringify(message));
  for (const host of targets) {
    udpSocket.send(payload, BROADCAST_PORT, host, (error) => {
      if (error) {
        diagnostics.lastError = `${error.message} (to ${host})`;
        sendStatus(`Network send failed: ${error.message}`, 'error');
      } else {
        diagnostics.packetsSent += 1;
      }
    });
  }
}

function targetList(hosts: string[], broadcast: boolean): string[] {
  const targets = new Set<string>();

  if (broadcast) {
    /*
     * Every interface's own subnet broadcast, not just 255.255.255.255. The
     * limited broadcast is only sent out one interface — whichever the routing
     * table picks — which on a machine with virtual adapters is frequently not
     * the WiFi one. That is the difference between discovery working and two
     * machines on the same network never seeing each other.
     */
    for (const target of listBroadcastTargets(currentInterfaces())) {
      targets.add(target);
    }
  }

  for (const host of hosts) {
    if (host) {
      targets.add(host);
    }
  }

  return Array.from(targets);
}

/**
 * Delivers a message, splitting it across datagrams when it will not fit in
 * one. Returns false only when the payload is past the transfer ceiling.
 */
/**
 * The fields a signature covers, lifted out of a message.
 *
 * Everything the receiver decides anything on: which handler runs, which
 * room it applies to, who it is aimed at, when it was made, and a digest of
 * the body so the payload cannot be swapped under a valid signature.
 *
 * `pubKey` and `sig` are excluded for the obvious reason, and the transport
 * fields — host, port — are excluded because a relay may legitimately observe
 * them differently from how the sender wrote them.
 */
function signableOf(message: WireMessage): Signable {
  const { v, type, deviceId, timestamp, roomId, targetDeviceId, pubKey, sig, host, port, ...body } =
    message;
  void pubKey;
  void sig;
  void host;
  void port;

  return {
    v,
    type,
    deviceId,
    ts: timestamp,
    roomId,
    targetDeviceId,
    digest: digestOf(body)
  };
}

function deliver(message: WireMessage, targets: string[]): boolean {
  if (!udpSocket || targets.length === 0) {
    return false;
  }

  /*
   * Signed here rather than where the message was built, because this is the
   * one place every outbound message passes through — including the chunks a
   * large payload is split into, which are messages in their own right.
   */
  message.pubKey = identity.publicKey;
  // Set *before* signing, not after — `signableOf`'s digest covers whatever
  // is on the message at this point, and this has to be one of them. Unsigned,
  // an attacker able to tamper with packets on this LAN (exactly what the
  // signature exists to rule out everywhere else) could swap in a box key of
  // their own choosing for someone else's device id and silently place
  // themselves in the middle of every future direct message to it. Signed
  // alongside everything else, forging a different one needs the sender's
  // signing private key — which is the same guarantee `deviceRegistry`
  // already gives every other field on the message.
  message.boxPubKey = identity.boxPublicKey;
  message.sig = signPayload(identity.privateKey, signableOf(message));

  const json = JSON.stringify(message);
  const bytes = Buffer.byteLength(json);

  /*
   * A host with an open direct connection gets the whole message over TCP.
   * That works on networks which filter UDP, and it needs no chunking or
   * retransmission because TCP has already dealt with both.
   */
  const remaining: string[] = [];
  for (const host of targets) {
    if (host !== BROADCAST_ADDRESS && tcp?.isConnected(host) && tcp.send(host, json)) {
      diagnostics.packetsSent += 1;
      diagnostics.tcpFramesSent += 1;
    } else {
      remaining.push(host);
    }
  }

  if (remaining.length === 0) {
    return true;
  }
  targets = remaining;

  if (bytes <= MAX_DATAGRAM_BYTES) {
    sendDatagram(message, targets);
    return true;
  }

  if (bytes > MAX_TRANSFER_BYTES) {
    sendStatus(
      `That item is too large to share (${Math.round(bytes / 1024 / 1024)} MB). It stayed in local history only.`,
      'warning'
    );
    return false;
  }

  startChunkedSend(json, targets);
  return true;
}

/** Send to one specific host. */
function sendUdpMessage(message: WireMessage, host = BROADCAST_ADDRESS): boolean {
  return deliver(message, targetList([host], false));
}

/** Broadcast, plus unicast to known peers so a blocked broadcast is survivable. */
function fanOut(message: WireMessage, hosts: string[] = []): boolean {
  return deliver(message, targetList(hosts, true));
}

// --- chunked transfer --------------------------------------------------------

type OutboundTransfer = {
  parts: string[];
  targets: string[];
  createdAt: number;
};

const outboundTransfers = new Map<string, OutboundTransfer>();
const assembler = new ChunkAssembler();

// --- invitations -------------------------------------------------------------

/**
 * Invitations this device has sent, as roomId -> deviceId -> when.
 *
 * An acceptance is only honoured against a live record here, so nobody can put
 * themselves in an owner's approval queue by claiming to have been invited.
 * Deliberately in memory: an invitation does not need to survive a restart, and
 * the owner can always send another.
 */
const sentInvites = new Map<string, Map<string, number>>();
/** Invitations waiting on this device, keyed by room. */
const receivedInvites = new Map<string, RoomInvite>();
const INVITE_TTL_MS = 30 * 60 * 1000;

function recordSentInvite(roomId: string, deviceId: string): void {
  const forRoom = sentInvites.get(roomId) ?? new Map<string, number>();
  forRoom.set(deviceId, Date.now());
  sentInvites.set(roomId, forRoom);
}

function takeSentInvite(roomId: string, deviceId: string): boolean {
  const forRoom = sentInvites.get(roomId);
  const sentAt = forRoom?.get(deviceId);
  if (!forRoom || sentAt === undefined) {
    return false;
  }

  forRoom.delete(deviceId);
  return Date.now() - sentAt <= INVITE_TTL_MS;
}

function pendingInviteIds(): Record<string, string[]> {
  const now = Date.now();
  const out: Record<string, string[]> = {};

  for (const [roomId, forRoom] of sentInvites) {
    for (const [deviceId, sentAt] of forRoom) {
      if (now - sentAt > INVITE_TTL_MS) {
        forRoom.delete(deviceId);
      }
    }
    if (forRoom.size > 0) {
      out[roomId] = Array.from(forRoom.keys());
    }
  }

  return out;
}

function listReceivedInvites(): RoomInvite[] {
  const now = Date.now();
  for (const [roomId, invite] of receivedInvites) {
    if (now - invite.invitedAt > INVITE_TTL_MS) {
      receivedInvites.delete(roomId);
    }
  }
  return Array.from(receivedInvites.values()).sort((a, b) => b.invitedAt - a.invitedAt);
}

function chunkDatagram(transferId: string, index: number, total: number, data: string): WireMessage {
  const message = baseMessage('chunk');
  message.transferId = transferId;
  message.index = index;
  message.total = total;
  message.data = data;
  return message;
}

function startChunkedSend(json: string, targets: string[]): void {
  const transferId = randomUUID();
  const parts = splitIntoChunks(json, CHUNK_CHARS);

  outboundTransfers.set(transferId, { parts, targets, createdAt: Date.now() });
  log.info(`Sending ${Math.round(json.length / 1024)} KB as ${parts.length} chunks (${transferId})`);

  sendChunks(transferId, parts.map((_, index) => index));
}

/**
 * Chunks go out in small batches rather than all at once. Blasting a few
 * hundred datagrams into the socket at once overflows its buffer and most of
 * them are dropped before they reach the wire.
 */
function sendChunks(transferId: string, indices: number[]): void {
  let cursor = 0;

  const tick = () => {
    const transfer = outboundTransfers.get(transferId);
    if (!transfer) {
      return;
    }

    for (let sent = 0; sent < CHUNK_BATCH && cursor < indices.length; sent += 1, cursor += 1) {
      const index = indices[cursor];
      const data = transfer.parts[index];
      if (data !== undefined) {
        sendDatagram(
          chunkDatagram(transferId, index, transfer.parts.length, data),
          transfer.targets
        );
      }
    }

    if (cursor < indices.length) {
      setTimeout(tick, CHUNK_PACING_MS);
    }
  };

  tick();
}

function handleChunk(message: WireMessage, host: string): void {
  const complete = assembler.accept(message.deviceId, {
    transferId: message.transferId ?? '',
    index: message.index ?? -1,
    total: message.total ?? 0,
    data: message.data ?? ''
  });

  if (complete === null) {
    return;
  }

  let inner: WireMessage;
  try {
    inner = JSON.parse(complete) as WireMessage;
  } catch {
    return;
  }

  // The reassembled message re-enters the normal handler, so membership and
  // decryption are still enforced. A chunk may not carry another chunk, and it
  // may not attribute its payload to some other device.
  if (!inner?.type || inner.type === 'chunk' || inner.type === 'chunk-nack') {
    return;
  }
  if (inner.v !== PROTOCOL_VERSION || inner.deviceId !== message.deviceId) {
    return;
  }

  handleWireMessage(inner, host);
}

function handleChunkNack(message: WireMessage): void {
  if (message.targetDeviceId !== deviceId() || !message.transferId) {
    return;
  }

  const transfer = outboundTransfers.get(message.transferId);
  if (!transfer || !Array.isArray(message.missing)) {
    return;
  }

  const indices = message.missing
    .filter((index) => Number.isInteger(index) && index >= 0 && index < transfer.parts.length)
    .slice(0, MAX_NACK_INDICES);

  if (indices.length > 0) {
    sendChunks(message.transferId, indices);
  }
}

/**
 * Retires finished senders, abandons stalled receives, and asks for the pieces
 * that never turned up. UDP drops packets, so without this a single lost chunk
 * would lose the whole transfer.
 */
function sweepTransfers(): void {
  const now = Date.now();

  for (const [transferId, transfer] of outboundTransfers) {
    if (now - transfer.createdAt > OUTBOUND_TRANSFER_TTL_MS) {
      outboundTransfers.delete(transferId);
    }
  }

  for (const expired of assembler.sweep(now)) {
    log.warn(
      `Abandoned incomplete transfer from ${expired.senderId}: ${expired.received}/${expired.total} chunks`
    );
    sendStatus('An incoming item did not arrive completely and was discarded.', 'warning');
  }

  for (const pending of assembler.pending()) {
    if (now - pending.lastChunkAt < NACK_AFTER_MS) {
      continue;
    }

    const missing = assembler
      .missing(pending.senderId, pending.transferId)
      .slice(0, MAX_NACK_INDICES);

    if (missing.length === 0) {
      continue;
    }

    const nack = baseMessage('chunk-nack');
    nack.transferId = pending.transferId;
    nack.targetDeviceId = pending.senderId;
    nack.missing = missing;

    const host = getPeerHost(pending.senderId);
    sendDatagram(nack, targetList(host ? [host] : [], !host));
  }
}

// --- blocking ----------------------------------------------------------------

/**
 * Devices this one refuses to deal with.
 *
 * Kept as a set beside the stored list because it is consulted for every single
 * packet that arrives — during a large transfer that is thousands of times a
 * second, and a linear scan of an array there would be felt.
 */
let blockedIds = new Set<string>();

function loadBlocked(): void {
  blockedIds = new Set(read('blocked').map((entry) => entry.deviceId));
}

function isBlocked(deviceId: string): boolean {
  return blockedIds.has(deviceId);
}

function getPeerHost(targetDeviceId: string): string | undefined {
  return read('peers').find((peer) => peer.id === targetDeviceId)?.host;
}

/** Hosts of every accepted member of a room that we currently know how to reach. */
/** Peers we can actually talk to — same protocol version. */
function compatiblePeers(): PeerInfo[] {
  return read('peers').filter(
    (peer) => peer.protocolVersion === undefined || peer.protocolVersion === PROTOCOL_VERSION
  );
}

function memberHosts(roomId: string): string[] {
  const hosts: string[] = [];
  for (const member of roomManager.getMembers(roomId, 'accepted')) {
    if (member.deviceId === deviceId()) {
      continue;
    }
    const host = getPeerHost(member.deviceId);
    if (host) {
      hosts.push(host);
    }
  }
  return hosts;
}

/**
 * Where a room's traffic should go, and whether it still needs broadcasting.
 *
 * When every member's address is known, addressing them directly delivers the
 * whole room. Broadcasting as well then sends a second copy of the same
 * payload — unnoticeable for a line of text, but for a screenshot it doubles
 * the work on the sender, the network and every receiver, which is a large part
 * of why images felt slow. If even one member is unaccounted for, the broadcast
 * stays: reaching everyone matters more than the saving.
 */
function deliverToRoom(message: WireMessage, roomId: string): boolean {
  const members = roomManager
    .getMembers(roomId, 'accepted')
    .filter((member) => member.deviceId !== deviceId());

  const hosts = members
    .map((member) => getPeerHost(member.deviceId))
    .filter((host): host is string => Boolean(host));

  const allAddressable = hosts.length === members.length && hosts.length > 0;
  return deliver(message, targetList(hosts, !allAddressable));
}

/**
 * Records that a device is alive and reachable.
 *
 * This runs for every packet that arrives, and a chunked image is thousands of
 * them. Only a change the user could actually see — a new device, a rename, a
 * different address — is worth writing to disk, redialling, or redrawing the
 * window for; the rest just moves a timestamp in memory. `sweepPeers` persists
 * those on a timer and drops the ones that have gone quiet.
 */
function updatePeer(peer: PeerInfo) {
  const peers = read('peers');
  const existing = peers.find((candidate) => candidate.id === peer.id);
  const nextPeer: PeerInfo = { ...peer, lastSeen: Date.now() };

  const isNews =
    !existing ||
    existing.host !== nextPeer.host ||
    existing.name !== nextPeer.name ||
    existing.port !== nextPeer.port ||
    existing.protocolVersion !== nextPeer.protocolVersion ||
    // A device's box key never changes once created, so this only ever fires
    // once per peer — the first message from it that carries one. Without
    // this it would fall into the "not news" branch below and its box key
    // would stay unrecorded until some other field happened to change too,
    // leaving direct messages to it unable to seal in the meantime.
    existing.boxPublicKey !== nextPeer.boxPublicKey;

  if (!isNews) {
    existing.lastSeen = nextPeer.lastSeen;
    return;
  }

  const active = [nextPeer, ...peers.filter((candidate) => candidate.id !== nextPeer.id)]
    .filter((candidate) => Date.now() - candidate.lastSeen <= PEER_TTL_MS)
    .slice(0, 20);
  write('peers', active);

  // Keep a direct link to everyone we know, so room traffic can use it.
  tcp?.connect(nextPeer.host);

  sendStateToRenderer();
}

/**
 * Retires devices that stopped announcing, and keeps the direct connections
 * topped up. Runs on the announce timer, which is also what the peers on the
 * other end are answering.
 */
function sweepPeers(): void {
  const peers = read('peers');
  const active = peers.filter((peer) => Date.now() - peer.lastSeen <= PEER_TTL_MS);

  if (active.length !== peers.length) {
    write('peers', active);
    sendStateToRenderer();
  }

  for (const peer of active) {
    tcp?.connect(peer.host);
  }
}

function touchPeerFromMessage(message: WireMessage, host: string) {
  if (message.deviceId === deviceId()) {
    return;
  }

  updatePeer({
    id: message.deviceId,
    name: message.deviceName,
    host,
    port: message.port,
    lastSeen: Date.now(),
    // Safe to trust: this function only ever runs on a message `authenticate`
    // has already verified, and `boxPubKey` is part of what that signature
    // covers — see the comment where it is attached, in `deliver`.
    boxPublicKey: message.boxPubKey
  });
}

// --- room messaging ----------------------------------------------------------

/**
 * Attaches a body to a message: sealed with the room key when the room is
 * encrypted, plaintext otherwise. Returns false when the room claims to be
 * encrypted but we hold no key — we refuse to fall back to plaintext.
 */
function attachRoomBody(message: WireMessage, room: RoomInfo, body: Partial<WireMessage>): boolean {
  if (!room.encrypted) {
    Object.assign(message, body);
    return true;
  }

  const key = roomManager.getKey(room.roomId);
  if (!key) {
    return false;
  }

  message.sealed = sealJson(key, body);
  return true;
}

function readRoomBody(message: WireMessage, room: RoomInfo): Partial<WireMessage> | null {
  if (!room.encrypted) {
    return message;
  }

  const key = roomManager.getKey(room.roomId);
  if (!key) {
    return null;
  }

  return openJson<Partial<WireMessage>>(key, message.sealed);
}

/**
 * The acceptance a new member receives.
 *
 * Key holders get the full roster, sealed. A device admitted on the join code
 * alone has no key yet, so it also carries a cut-down roster in the clear —
 * the owner plus the joiner, with the join code stripped. That exposes nothing
 * the room advert had not already made public, and the full roster reaches them
 * over `room-roster` once they unlock.
 */
function buildAcceptMessage(room: RoomInfo, targetDeviceId: string): WireMessage {
  const accept = baseMessage('room-accept');
  accept.roomId = room.roomId;
  accept.targetDeviceId = targetDeviceId;

  if (!room.encrypted) {
    accept.room = room;
    return accept;
  }

  const key = roomManager.getKey(room.roomId);
  if (key) {
    accept.sealed = sealJson(key, { room });
  }

  const { joinCode: _withheld, ...publicFields } = room;
  accept.room = {
    ...publicFields,
    members: room.members.filter(
      (member) => member.deviceId === room.ownerId || member.deviceId === targetDeviceId
    )
  };

  return accept;
}

function advertiseOwnedRooms() {
  for (const room of roomManager.getRooms()) {
    // A hidden direct-call room is never discoverable — advertising it would
    // defeat the entire point of it being hidden, and its `ownerId` carries
    // no real ownership, just whichever device id happened to sort first.
    if (room.ownerId !== deviceId() || room.type === 'direct') {
      continue;
    }

    sendUdpMessage({ ...baseMessage('room-advert'), advert: roomManager.toAdvert(room) });
  }
}

/** The owner is authoritative for the roster; members only ever receive it. */
function broadcastRoster(room: RoomInfo) {
  const message = baseMessage('room-roster');
  message.roomId = room.roomId;
  if (!attachRoomBody(message, room, { room })) {
    return;
  }

  fanOut(message, memberHosts(room.roomId));
}

function broadcastPresence() {
  sendUdpMessage(baseMessage('announce'));
}

// --- clipboard ---------------------------------------------------------------

function shareClipboard(payload: ClipboardPayload, roomId: string) {
  const room = roomManager.getRoom(roomId);
  if (!room || !roomManager.isAcceptedMember(roomId, deviceId())) {
    return;
  }

  historyManager.addClipboardEntry(
    payload.kind,
    payload.text,
    payload.sourceId,
    payload.sourceName,
    roomId,
    payload.dataUrl
  );

  const message = baseMessage('clipboard');
  message.roomId = roomId;
  if (!attachRoomBody(message, room, { payload })) {
    sendStatus(`${room.name} is locked on this device — unlock it to share.`, 'warning');
    return;
  }

  if (deliverToRoom(message, roomId)) {
    sendStatus(`Shared to ${room.name}`, 'success');
  }
  notifyHistoryChanged(roomId);
}

function applyRemoteClipboard(payload: ClipboardPayload, sourceName: string) {
  const nextHash = hashClipboardPayload(payload);
  if (nextHash === lastRemoteClipboardHash) {
    return;
  }

  lastRemoteClipboardHash = nextHash;
  lastLocalClipboardHash = nextHash;

  if (payload.kind === 'image' && payload.dataUrl) {
    // Remember the picture as it looks on this clipboard, not as it arrived:
    // re-encoding it here would otherwise look like a fresh copy to the poller,
    // which would send it straight back to the device it came from.
    lastClipboardImageFingerprint = writeClipboardImage(payload.dataUrl) ?? '';
    sendStatus(`Image copied from ${sourceName}`, 'success');
    return;
  }

  writeClipboardText(payload.text);
  sendStatus(`Copied from ${sourceName} — press Ctrl+V`, 'success');
}

function pollLocalClipboard() {
  const settings = getSettings();
  const roomId = read('currentRoomId');
  if (!settings.syncEnabled || !roomId) {
    return;
  }

  const image = settings.shareImages ? readClipboardImage() : null;
  if (image) {
    // Nothing is encoded until the picture is known to be a new one.
    if (image.fingerprint === lastClipboardImageFingerprint) {
      return;
    }
    lastClipboardImageFingerprint = image.fingerprint;

    const payload = createImageClipboardPayload(deviceId(), deviceName(), image.toDataUrl());
    const nextHash = hashClipboardPayload(payload);
    if (nextHash !== lastLocalClipboardHash) {
      lastLocalClipboardHash = nextHash;
      lastRemoteClipboardHash = nextHash;
      shareClipboard(payload, roomId);
    }
    return;
  }

  lastClipboardImageFingerprint = '';
  const text = readClipboardText();
  if (!text) {
    return;
  }

  const payload = createTextClipboardPayload(deviceId(), deviceName(), text);
  const nextHash = hashClipboardPayload(payload);
  if (nextHash === lastLocalClipboardHash) {
    return;
  }

  lastLocalClipboardHash = nextHash;
  lastRemoteClipboardHash = nextHash;
  shareClipboard(payload, roomId);
}

// --- inbound handlers --------------------------------------------------------

/**
 * Resolved by `handleRoomAccept`/`handleRoomReject` once `room:unlock`'s proof
 * round-trip with the owner actually completes, keyed by roomId.
 *
 * `room:unlock` used to derive a key from whatever was typed and report
 * success unconditionally, without ever checking it was right — a wrong
 * password left the room reporting as unlocked while nothing in it could
 * actually decrypt, with no way back in short of leaving and rejoining. This
 * is what makes the IPC call wait for the owner's actual answer before
 * either caching the key for good or telling the user it was wrong.
 */
const pendingUnlocks = new Map<string, (result: ActionResult) => void>();
/** How long to wait for the owner before assuming they are just offline. */
const UNLOCK_CONFIRM_TIMEOUT_MS = 8000;

function handleRoomRequest(message: WireMessage, host: string) {
  const room = message.roomId ? roomManager.getRoom(message.roomId) : undefined;
  if (!room || room.ownerId !== deviceId()) {
    return; // Only the owner admits members.
  }

  /*
   * Replies go to the address the packet actually came from, not the one the
   * sender put in the message. A device behind a virtual adapter can easily
   * report an address nothing can reach.
   */
  const reject = (reason: string) => {
    const rejection = baseMessage('room-reject');
    rejection.roomId = room.roomId;
    rejection.targetDeviceId = message.deviceId;
    rejection.reason = reason;
    fanOut(rejection, [host]);
    log.info(`Rejected ${message.deviceName} for ${room.name}: ${reason}`);
  };

  /*
   * Either credential admits a device. The join code cannot always be passed
   * along — read out over a call, typed on a machine you are not sitting at —
   * so knowing the password is enough on its own, and vice versa.
   *
   * They are not equivalent in what they unlock, though. The password is the
   * room's encryption key, so a device admitted on the join code alone is a
   * member of a room it cannot yet read; the interface shows it as locked
   * until the password is supplied.
   */
  const supplied = normalizeJoinCode(message.joinCode ?? '');
  const codeMatches = supplied.length > 0 && supplied === room.joinCode;

  let passwordMatches = false;
  if (room.encrypted) {
    const key = roomManager.getKey(room.roomId);
    passwordMatches = Boolean(key && verifyProof(key, room.roomId, message.proof));
  }

  if (room.type === 'private' && !codeMatches && !passwordMatches) {
    reject(
      room.encrypted
        ? 'That join code and password did not match this room.'
        : 'That join code is not valid for this room.'
    );
    return;
  }

  /*
   * A public room admits on the password alone, never on the code. Public
   * rooms auto-accept, so the password is the only gate there is; a private
   * room can afford to be looser because the owner still has to approve.
   */
  if (room.type === 'public' && room.encrypted && !passwordMatches) {
    reject('Incorrect room password.');
    return;
  }

  // An existing member re-presenting its credentials is asking for the roster
  // again — which is what a device does after unlocking a room it joined with
  // only the join code, since its first copy was the cut-down one.
  if (roomManager.isAcceptedMember(room.roomId, message.deviceId)) {
    fanOut(buildAcceptMessage(room, message.deviceId), [host]);
    return;
  }

  if (room.type === 'public') {
    const updated = roomManager.addAcceptedMember(room.roomId, message.deviceId, message.deviceName);
    fanOut(buildAcceptMessage(updated ?? room, message.deviceId), [host]);
    broadcastRoster(room);
    sendStateToRenderer();
    sendStatus(`${message.deviceName} joined ${room.name}`, 'success');
    return;
  }

  const updated = roomManager.addPendingMember(
    room.roomId,
    message.deviceId,
    message.deviceName,
    message.pubKey
  );
  if (updated) {
    const request: JoinRequest = {
      roomId: room.roomId,
      roomName: room.name,
      deviceId: message.deviceId,
      deviceName: message.deviceName,
      requestedAt: Date.now()
    };
    emit('room:join-request', request);
    sendStateToRenderer();
    sendStatus(`${message.deviceName} is asking to join ${room.name}`, 'warning');
    notify('Someone wants to join', `${message.deviceName} is asking to join ${room.name}`);
  }
}

function handleRoomAccept(message: WireMessage) {
  if (message.targetDeviceId !== deviceId() || !message.roomId) {
    return;
  }

  // Prefer the sealed roster, but fall back to the plaintext one: a device
  // admitted on the join code alone holds no key yet and cannot open it.
  const key = roomManager.getKey(message.roomId);
  const sealedRoom = key ? openJson<Partial<WireMessage>>(key, message.sealed)?.room : undefined;
  const room = sealedRoom ?? message.room;

  if (!room || room.roomId !== message.roomId) {
    return;
  }

  roomManager.saveRoom(room);
  roomManager.dropAdvert(room.roomId);
  write('currentRoomId', room.roomId);
  sendStateToRenderer();

  // room:unlock is waiting on this exact response — tell it directly rather
  // than the generic join-result/toast pair, which would otherwise double up.
  const pendingUnlock = pendingUnlocks.get(room.roomId);
  if (pendingUnlock) {
    pendingUnlocks.delete(room.roomId);
    pendingUnlock(ok(`${room.name} unlocked.`));
    return;
  }

  emit('room:join-result', {
    roomId: room.roomId,
    ok: true,
    message: `You are in ${room.name}`
  } satisfies JoinResultEvent);
  sendStatus(`Joined ${room.name}`, 'success');
}

function handleRoomReject(message: WireMessage) {
  if (message.targetDeviceId !== deviceId() || !message.roomId) {
    return;
  }

  const name =
    roomManager.getRoom(message.roomId)?.name ?? roomManager.getAdvert(message.roomId)?.name ?? 'that room';
  const reason = message.reason ?? `Your request to join ${name} was declined.`;

  // Clear the provisional key from the failed attempt, but never tear down a
  // room we are already a confirmed member of on the word of one packet.
  if (!roomManager.isAcceptedMember(message.roomId, deviceId())) {
    roomManager.deleteRoom(message.roomId);
  } else {
    // An *accepted* member being rejected here can only mean one thing: this
    // was room:unlock's proof round-trip and the typed password was wrong.
    // The provisional key it set has to go — keeping a wrong key cached as
    // if it were correct is exactly what used to make the room look
    // unlocked while silently decrypting nothing.
    roomManager.dropKey(message.roomId);
  }

  sendStateToRenderer();

  const pendingUnlock = pendingUnlocks.get(message.roomId);
  if (pendingUnlock) {
    pendingUnlocks.delete(message.roomId);
    pendingUnlock(fail(reason));
    return; // room:unlock's own promise already tells the caller — no second toast.
  }

  emit('room:join-result', {
    roomId: message.roomId,
    ok: false,
    message: reason
  } satisfies JoinResultEvent);
  sendStatus(reason, 'error');
}

function handleRoomRoster(message: WireMessage) {
  const room = message.roomId ? roomManager.getRoom(message.roomId) : undefined;
  if (!room || room.ownerId !== message.deviceId || room.ownerId === deviceId()) {
    return; // Rosters are only trusted from the room's owner.
  }

  const body = readRoomBody(message, room);
  const nextRoom = body?.room;
  if (!nextRoom || nextRoom.roomId !== room.roomId) {
    return;
  }

  const stillAMember = nextRoom.members.some(
    (member) => member.deviceId === deviceId() && member.status === 'accepted'
  );

  if (!stillAMember) {
    roomManager.deleteRoom(room.roomId);
    if (read('currentRoomId') === room.roomId) {
      write('currentRoomId', undefined);
    }
    sendStatus(`You were removed from ${room.name}.`, 'warning');
  } else {
    /*
     * Learn the other members' keys from the owner, who bound them at
     * approval. Without this a member would only ever know keys it happened
     * to observe first, and two members could disagree about who a third is.
     */
    deviceRegistry.adopt(nextRoom.members);
    roomManager.saveRoom({ ...nextRoom, joinCode: nextRoom.joinCode ?? room.joinCode });
  }

  sendStateToRenderer();
}

/**
 * Someone leaving a room of ours.
 *
 * `deviceId` on the wire is a claim, not a fact — nothing in the protocol
 * binds a message to the identity it names. This used to remove whoever the
 * message pointed at after checking only that the room existed and that we
 * owned it, which meant any device on the network that knew a room id could
 * evict any member of it, without the password and without ever being in the
 * room. `room-leave` is not behind the decryption gate that clipboard and
 * chat payloads pass through, so there was nothing else in the way.
 *
 * Two checks close it:
 *
 *   - the named device has to actually be in the roster, so a stranger can no
 *     longer name an arbitrary id; and
 *   - for an encrypted room, the message has to carry a proof that opens with
 *     the room key, so only somebody who holds the password can trigger a
 *     removal at all.
 *
 * That is as far as this can go without signed messages: the proof shows the
 * sender knows the room key, not that it is the device it claims to be, so a
 * member can still spoof another member. Fixing *that* needs per-device
 * keypairs, which is a wire-format change and a separate piece of work.
 *
 * An unencrypted room has no key and therefore no proof to demand. Its
 * traffic is plain text by definition, so the roster check is the whole of
 * what is available.
 */
function handleRoomLeave(message: WireMessage) {
  const room = message.roomId ? roomManager.getRoom(message.roomId) : undefined;
  if (!room || room.ownerId !== deviceId()) {
    return;
  }

  const member = room.members.find((candidate) => candidate.deviceId === message.deviceId);
  const key = roomManager.getKey(room.roomId);
  const provedKey = Boolean(key && verifyProof(key, room.roomId, message.proof));

  if (!roomManager.mayLeave(room.roomId, message.deviceId, provedKey)) {
    log.warn(`[rooms] Ignored an unauthenticated leave for ${room.name}.`);
    return;
  }

  roomManager.removeMember(room.roomId, message.deviceId);
  broadcastRoster(room);
  sendStateToRenderer();
  /* The roster's name for them, not the one the message asked to be called. */
  sendStatus(`${member?.deviceName ?? 'A device'} left ${room.name}`, 'info');
}

/**
 * The owner changed the room's credentials.
 *
 * The notice is sealed with the key the room had *before* the change, so only
 * devices that were already in the room can read it — and it deliberately does
 * not carry the new key. Everyone has to enter the new password. That is what
 * makes changing a password a way of shutting someone out rather than a way of
 * renaming the lock while leaving every old copy of the key working.
 */
function handleRoomRekey(message: WireMessage) {
  const room = message.roomId ? roomManager.getRoom(message.roomId) : undefined;
  if (!room || room.ownerId !== message.deviceId || room.ownerId === deviceId()) {
    return;
  }

  let next: RoomInfo | undefined;
  if (room.encrypted) {
    const key = roomManager.getKey(room.roomId);
    if (!key) {
      return; // Already locked here; there is nothing to drop.
    }
    next = openJson<{ room: RoomInfo }>(key, message.sealed)?.room;
  } else {
    next = message.room;
  }

  if (!next || next.roomId !== room.roomId || next.ownerId !== room.ownerId) {
    return;
  }

  roomManager.saveRoom(next);
  roomManager.dropKey(next.roomId);
  endCallsForRoom(next.roomId);

  sendStateToRenderer();

  if (next.encrypted) {
    sendStatus(`${next.name} has a new password — enter it to carry on.`, 'warning');
    notify('Room password changed', `${message.deviceName} changed the password for ${next.name}.`);
  } else {
    sendStatus(`${next.name} no longer has a password.`, 'warning');
  }
}

function handleRoomClosed(message: WireMessage) {
  const room = message.roomId ? roomManager.getRoom(message.roomId) : undefined;
  if (!room || room.ownerId !== message.deviceId || room.ownerId === deviceId()) {
    return;
  }

  endCallsForRoom(room.roomId);
  roomManager.deleteRoom(room.roomId);
  historyManager.clearRoom(room.roomId);
  if (read('currentRoomId') === room.roomId) {
    write('currentRoomId', undefined);
  }
  sendStateToRenderer();
  sendStatus(`${room.name} was closed by its owner.`, 'warning');
}

/** Wire types a `chat` restriction covers — every kind of chat activity, not just new messages. */
const CHAT_WIRE_TYPES = new Set(['chat', 'chat-edit', 'chat-delete', 'chat-reaction', 'chat-typing']);

/**
 * The gate that makes rooms mean something: a packet is only applied when the
 * room exists here, we are an accepted member, the sender is an accepted member,
 * and — for encrypted rooms — the body actually opens with our key.
 */
function handleRoomPayload(message: WireMessage): Partial<WireMessage> | null {
  const roomId = message.roomId;
  if (!roomId) {
    return null;
  }

  const room = roomManager.getRoom(roomId);
  if (!room) {
    return null;
  }

  if (!roomManager.isAcceptedMember(roomId, deviceId())) {
    return null;
  }

  if (!roomManager.isAcceptedMember(roomId, message.deviceId)) {
    log.warn(`Dropped ${message.type} for ${room.name} from non-member ${message.deviceName}`);
    return null;
  }

  /*
   * Enforced here, not just on the sender's own outbound handlers — a
   * restriction is only worth anything if a modified or misbehaving client
   * cannot simply ignore its own copy of it. Every device shares the same
   * roster, so every device reaches the same answer independently, the same
   * way `isBlocked` is one choke point rather than a check repeated (and
   * eventually forgotten) in each handler. The files-specific half of this
   * lives in `handleChatMessage`, since it needs the decrypted body to know
   * a chat message's type.
   */
  const restrictions = roomManager.getRestrictions(roomId, message.deviceId);
  if (restrictions?.chat && CHAT_WIRE_TYPES.has(message.type)) {
    log.warn(`Dropped ${message.type} for ${room.name} from restricted member ${message.deviceName}`);
    return null;
  }
  if (restrictions?.calls && message.type === 'call') {
    log.warn(`Dropped ${message.type} for ${room.name} from restricted member ${message.deviceName}`);
    return null;
  }
  // Screen sharing answers to its own restriction rather than riding on
  // `calls`, so an owner can withdraw the far larger ask — watching or
  // driving a desktop — while still letting the member talk.
  if (restrictions?.remote && message.type === 'remote') {
    log.warn(`Dropped ${message.type} for ${room.name} from restricted member ${message.deviceName}`);
    return null;
  }

  const body = readRoomBody(message, room);
  if (!body) {
    log.warn(`Dropped unreadable ${message.type} for ${room.name}`);
  }
  return body;
}

/**
 * Copies already dealt with, by content.
 *
 * One copy legitimately arrives more than once. It is broadcast *and* addressed
 * to each member, so that a network filtering either one still delivers it, and
 * a device with a direct connection is sent it over that as well. Every arrival
 * used to raise its own notification, so copying a single line could set off
 * three of them on every other machine in the room.
 */
const INBOUND_CLIP_TTL_MS = 15000;
const handledClips = new Map<string, number>();

function isDuplicateClip(key: string): boolean {
  const now = Date.now();

  for (const [seen, at] of handledClips) {
    if (now - at > INBOUND_CLIP_TTL_MS) {
      handledClips.delete(seen);
    }
  }

  if (handledClips.has(key)) {
    return true;
  }

  handledClips.set(key, now);
  return false;
}

function handleClipboardMessage(message: WireMessage) {
  const body = handleRoomPayload(message);
  const payload = body?.payload;
  if (!payload) {
    return;
  }

  if (isDuplicateClip(`${message.roomId}:${hashClipboardPayload(payload)}`)) {
    return;
  }

  /*
   * The clipboard first, everything else after. Storing the item and pushing it
   * to the window means copying a multi-megabyte data URL about, and none of
   * that has to happen before the paste is ready to go.
   */
  const settings = getSettings();
  const applying = settings.autoApply && message.roomId === read('currentRoomId');
  if (applying) {
    applyRemoteClipboard(payload, message.deviceName);
  }

  historyManager.addClipboardEntry(
    payload.kind,
    payload.text,
    payload.sourceId,
    payload.sourceName,
    message.roomId!,
    payload.dataUrl
  );
  notifyHistoryChanged(message.roomId!);

  if (!applying) {
    sendStatus(`New item from ${message.deviceName} in history`, 'info');
  }

  notify(
    `Copied from ${message.deviceName}`,
    payload.kind === 'image' ? 'An image is ready to paste' : truncateForNotice(payload.text)
  );
}

function handleChatMessage(message: WireMessage) {
  const body = handleRoomPayload(message);
  const chat = body?.chatMessage;
  if (!chat || historyManager.hasChatMessage(chat.id)) {
    return;
  }

  // The files-specific half of the restriction check: this needs the
  // decrypted body to know the message is a file/image, so it cannot live in
  // `handleRoomPayload` alongside the broader `chat` check.
  if (chat.type !== 'text' && roomManager.getRestrictions(message.roomId!, message.deviceId)?.files) {
    log.warn(`Dropped a file from restricted member ${message.deviceName} in ${message.roomId}`);
    return;
  }

  const room = roomManager.getRoom(message.roomId!);

  const stored = historyManager.addChatMessage({
    type: chat.type,
    content: chat.content,
    deviceId: chat.deviceId,
    deviceName: chat.deviceName,
    roomId: message.roomId!,
    dataUrl: chat.dataUrl,
    fileName: chat.fileName,
    fileSize: chat.fileSize,
    id: chat.id,
    timestamp: chat.timestamp,
    // Re-resolved against this device's own copy of the roster, never read
    // from the packet — see `mentionsIn`. `chat.mentions` is discarded.
    mentions: room && chat.type === 'text' ? mentionsIn(chat.content, room) : undefined
  });
  emit('chat:message', stored);
  sendReceipt(chat.deviceId, message.roomId!, [stored.id], 'delivered');

  // Being named is a direct address, not ambient room chatter, so it gets the
  // same urgency as a request that expires — see the remote-access notify.
  const mentionsMe = stored.mentions?.includes(deviceId()) ?? false;
  notify(
    mentionsMe
      ? `${stored.deviceName} mentioned you in ${room?.name ?? 'a room'}`
      : `${stored.deviceName} in ${room?.name ?? 'a room'}`,
    stored.type === 'text' ? stored.content : (stored.fileName ?? 'Sent a file'),
    mentionsMe ? { urgent: true } : undefined
  );
}

/** Tells the renderer a room's messages changed, so it refetches them. */
function notifyChatChanged(roomId: string) {
  emit('chat:changed', roomId);
}

/*
 * Amendments to a message that is already sent.
 *
 * Each is checked the same way the message itself was: it has to come from an
 * accepted member of a room this device is also in, and it has to open with the
 * room key. On top of that, the history manager only applies an edit or a
 * withdrawal when the device asking is the one that wrote the message, so
 * nobody can rewrite or retract anyone else's words.
 */
function handleChatEdit(message: WireMessage) {
  const edit = handleRoomPayload(message)?.chatEdit;
  if (!edit?.messageId || typeof edit.content !== 'string') {
    return;
  }

  const room = roomManager.getRoom(message.roomId!);
  const updated = historyManager.editChatMessage(
    edit.messageId,
    edit.content,
    message.deviceId,
    edit.editedAt ?? Date.now(),
    room ? mentionsIn(edit.content, room) : undefined
  );

  if (updated) {
    notifyChatChanged(message.roomId!);
  }
}

function handleChatDelete(message: WireMessage) {
  const messageId = handleRoomPayload(message)?.chatDelete?.messageId;
  if (!messageId) {
    return;
  }

  if (historyManager.markChatMessageDeleted(messageId, message.deviceId)) {
    notifyChatChanged(message.roomId!);
  }
}

function handleChatReaction(message: WireMessage) {
  const reaction = handleRoomPayload(message)?.chatReaction;
  // A reaction is displayed as sent, so cap it at a couple of characters and an
  // emoji's worth of modifiers rather than rendering whatever arrives.
  if (!reaction?.messageId || !reaction.emoji || reaction.emoji.length > 12) {
    return;
  }

  if (historyManager.setChatReaction(reaction.messageId, reaction.emoji, message.deviceId, Boolean(reaction.on))) {
    notifyChatChanged(message.roomId!);
  }
}

/**
 * Someone is composing. Deliberately never stored: it is true for a few seconds
 * and then it is not, and it should not outlive the window being open.
 */
function handleChatTyping(message: WireMessage) {
  const body = handleRoomPayload(message);
  if (typeof body?.typing !== 'boolean') {
    return;
  }

  emit('chat:typing', {
    roomId: message.roomId,
    deviceId: message.deviceId,
    deviceName: message.deviceName,
    typing: body.typing
  });
}

/** An invitation addressed to this device. Carries no credentials. */
function handleRoomInvite(message: WireMessage, host: string) {
  if (message.targetDeviceId !== deviceId() || !message.advert) {
    return;
  }

  const advert = message.advert;
  if (advert.ownerId !== message.deviceId) {
    return; // Only a room's owner may invite to it.
  }
  if (roomManager.isAcceptedMember(advert.roomId, deviceId())) {
    return; // Already in.
  }

  const invite: RoomInvite = {
    roomId: advert.roomId,
    roomName: advert.name,
    ownerId: advert.ownerId,
    ownerName: advert.ownerName,
    type: advert.type,
    encrypted: advert.encrypted,
    invitedAt: Date.now()
  };

  receivedInvites.set(advert.roomId, invite);
  roomManager.recordAdvert(advert, host);
  emit('room:invite', invite);
  sendStateToRenderer();
  sendStatus(`${advert.ownerName} invited you to ${advert.name}`, 'warning');
  notify('Room invitation', `${advert.ownerName} invited you to ${advert.name}`);
}

/**
 * The invited device said yes. It still only becomes *pending* — the owner
 * approves as they would for any other request, which is what the invitation
 * flow is for.
 */
function handleInviteAccept(message: WireMessage) {
  const room = message.roomId ? roomManager.getRoom(message.roomId) : undefined;
  if (!room || room.ownerId !== deviceId()) {
    return;
  }

  if (!takeSentInvite(room.roomId, message.deviceId)) {
    log.warn(`Ignored an invitation acceptance from ${message.deviceName}: no invitation outstanding`);
    return;
  }

  const updated = roomManager.addPendingMember(
    room.roomId,
    message.deviceId,
    message.deviceName,
    message.pubKey
  );
  if (updated) {
    emit('room:join-request', {
      roomId: room.roomId,
      roomName: room.name,
      deviceId: message.deviceId,
      deviceName: message.deviceName,
      requestedAt: Date.now()
    } satisfies JoinRequest);
    sendStatus(`${message.deviceName} accepted your invitation to ${room.name}`, 'warning');
    // The same significance as somebody requesting to join outright — it is
    // still waiting on your approval, and that's easy to miss if the window
    // isn't the thing on screen right now.
    notify('Someone wants to join', `${message.deviceName} accepted your invitation to ${room.name}`);
  }

  sendStateToRenderer();
}

function handleInviteDecline(message: WireMessage) {
  const room = message.roomId ? roomManager.getRoom(message.roomId) : undefined;
  if (!room || room.ownerId !== deviceId()) {
    return;
  }

  if (takeSentInvite(room.roomId, message.deviceId)) {
    sendStatus(`${message.deviceName} declined the invitation to ${room.name}`, 'info');
    sendStateToRenderer();
  }
}

/** Tell a sender their message arrived, or that we have read it. */
function sendReceipt(
  toDeviceId: string,
  roomId: string,
  messageIds: string[],
  receipt: 'delivered' | 'seen'
): void {
  if (!getSettings().sendReceipts || messageIds.length === 0) {
    return;
  }

  const message = baseMessage('chat-receipt');
  message.roomId = roomId;
  message.targetDeviceId = toDeviceId;
  message.messageIds = messageIds;
  message.receipt = receipt;

  const host = getPeerHost(toDeviceId);
  sendUdpMessage(message, host ?? BROADCAST_ADDRESS);
}

function handleChatReceipt(message: WireMessage) {
  if (message.targetDeviceId !== deviceId() || !message.roomId || !message.receipt) {
    return;
  }
  // Receipts are room traffic like anything else: only from a fellow member.
  if (!roomManager.isAcceptedMember(message.roomId, message.deviceId)) {
    return;
  }
  if (!Array.isArray(message.messageIds)) {
    return;
  }

  if (historyManager.recordReceipt(message.messageIds, message.deviceId, message.receipt)) {
    emit('chat:receipts', message.roomId);
  }
}

// --- calls -------------------------------------------------------------------

/**
 * Call setup, relayed rather than interpreted.
 *
 * WebRTC lives in the renderer, because that is where a media engine exists at
 * all; the main process is the postbox. It does three things and no more: it
 * refuses to carry a signal for a room the two devices are not both in, it seals
 * the signal with the room key when the room is encrypted, and it keeps a note
 * of who is in which call so a room can show a call in progress.
 *
 * The media never comes through here. Once the two peers have each other's
 * candidates they talk directly, SRTP-encrypted, over the local network — which
 * is why a call works with the internet unplugged and why a 1080p stream does
 * not go anywhere near the chunked transfer path.
 */

/** How often a participant re-announces itself, and stale ones are swept. */
const CALL_HEARTBEAT_MS = 5000;
/** A ring nobody picks up stops being offered. */
const RING_TIMEOUT_MS = 45000;
/**
 * How long a call is allowed to have nobody but us in it. Long enough for a
 * ring to be answered; short enough that a call whose other end vanished does
 * not sit there looking live.
 */
const CALL_ALONE_GRACE_MS = 60000;

/** Rings offered to this device and not yet answered, keyed by call. */
const ringing = new Map<string, CallRinging>();

/** The call this device is in. Only ever one; a second would fight for the mic. */
let localCall: { callId: string; roomId: string; mode: CallMode } | null = null;
/** Whether anyone else has ever been in it, which is what "nobody answered" means. */
let localCallHadCompany = false;

function ensureCallWindow(): SessionWindow {
  if (!callWindow) {
    callWindow = new SessionWindow(
      {
        kind: 'call',
        title: 'Call — Campus Connect',
        width: 960,
        height: 640,
        minWidth: 480,
        minHeight: 360,
        preloadPath: path.join(__dirname, 'preload.js'),
        devServerUrl: rendererDevServerUrl(),
        onClosedByUser: handleCallWindowClosedByUser
      },
      registerWindowForEvents
    );
  }
  return callWindow;
}

/**
 * Opens the call window, creating it on first use. `intent` is left for the
 * window to pull for itself once it has loaded — pushing it now would race a
 * window that has not finished its first paint yet and simply lose the
 * message, the same problem `pendingDeepLink` exists to avoid.
 */
function openCallWindow(intent: CallWindowIntent | null): void {
  if (intent) {
    pendingCallIntent = intent;
  }
  ensureCallWindow().open();
}

/**
 * Closing the call window is how a call ends here, the same as the hang-up
 * button in TeamViewer or AnyDesk's own call window. A ring nobody answered
 * yet counts as a decline, so the caller is not left listening to nothing.
 */
function handleCallWindowClosedByUser(): void {
  if (localCall) {
    endLocalCall(true);
  }

  for (const [callId, ring] of Array.from(ringing)) {
    sendCallSignal(ring.roomId, { kind: 'decline', callId });
    clearRing(callId);
  }
}

function callSignalTarget(signal: CallSignal): string | undefined {
  return 'to' in signal ? signal.to : undefined;
}

/**
 * Puts a signal on the wire. Addressed signals go to that device alone when we
 * know its address — which for ICE, the chattiest of them, is almost always.
 *
 * Deliberately not gated on the `online` setting. Switching the network off
 * writes that setting first and closes the sockets second, and in between this
 * has to be able to say goodbye — otherwise the far end sits looking at a
 * participant that has already gone until the sweep notices twenty seconds
 * later. `deliver` refuses once the socket is actually closed, which is the
 * honest test; everything that *starts* a call goes through `requireOnline`
 * before it ever reaches here.
 */
function sendCallSignal(roomId: string, signal: CallSignal): boolean {
  const room = roomManager.getRoom(roomId);
  if (!room) {
    return false;
  }

  const message = baseMessage('call');
  message.roomId = roomId;
  if (!attachRoomBody(message, room, { call: signal })) {
    return false;
  }

  const to = callSignalTarget(signal);
  if (to) {
    const host = getPeerHost(to);
    // No known address: fall back to the room, where the body's `to` still
    // means only the intended device acts on it.
    return host ? sendUdpMessage(message, host) : deliverToRoom(message, roomId);
  }

  return deliverToRoom(message, roomId);
}

function forwardCallSignal(message: WireMessage, signal: CallSignal): void {
  emit('call:signal', {
    roomId: message.roomId!,
    fromDeviceId: message.deviceId,
    fromDeviceName: message.deviceName,
    signal
  } satisfies CallSignalEvent);
}

/** Stops offering a ring, and tells the window to take the prompt down. */
function clearRing(callId: string): void {
  if (ringing.delete(callId)) {
    emit('call:ring-cancelled', callId);
  }
  // Nothing left for a window that opened only to show this ring.
  if (!localCall && ringing.size === 0) {
    callWindow?.closeIfOpen();
  }
}

/** Ends this device's participation, locally and to everyone else. */
function endLocalCall(announce: boolean): void {
  const call = localCall;
  if (!call) {
    return;
  }

  localCall = null;
  localCallHadCompany = false;
  if (announce) {
    sendCallSignal(call.roomId, { kind: 'leave', callId: call.callId });
  }
  callManager.leave(call.callId, deviceId());
  emit('call:ended', call.callId);
  sendStateToRenderer();
  // Whatever the window was open to show, it is over.
  if (ringing.size === 0) {
    callWindow?.closeIfOpen();
  }
}

/**
 * Forgets every call in a room, for when the room itself goes — left, closed, or
 * the key withdrawn. Announcing our departure would be pointless: either we no
 * longer have the key to seal it with, or there is nobody left entitled to read
 * it.
 */
function endCallsForRoom(roomId: string): void {

  /*
   * A remote session belongs to a room too, and loses its justification the
   * moment the room does. Announcing would be pointless: either the key needed
   * to seal it is gone, or there is nobody left entitled to read it.
   */
  if (remoteSessions.current?.roomId === roomId) {
    endRemoteSession('The room this remote session belonged to is gone.', false);
  }
  remoteSessions.clearRoom(roomId);

  if (localCall?.roomId === roomId) {
    endLocalCall(false);
  }

  for (const [callId, ring] of Array.from(ringing)) {
    if (ring.roomId === roomId) {
      clearRing(callId);
    }
  }

  callManager.clearRoom(roomId);
}

function handleCallRing(message: WireMessage, room: RoomInfo, signal: CallSignal & { kind: 'ring' }): void {
  // Ringing means the caller is in the call as well as asking for company.
  callManager.join(signal.callId, room.roomId, signal.mode, message.deviceId, message.deviceName);

  if (localCall?.callId === signal.callId) {
    sendStateToRenderer();
    return; // Already in it; the ring is a late arrival.
  }

  /*
   * Already on another call. The caller is told so rather than left listening to
   * a ring nobody will ever answer.
   */
  if (localCall) {
    sendCallSignal(room.roomId, { kind: 'decline', callId: signal.callId });
    sendStateToRenderer();
    return;
  }

  const ring: CallRinging = {
    callId: signal.callId,
    roomId: room.roomId,
    roomName: room.name,
    mode: signal.mode,
    fromDeviceId: message.deviceId,
    fromDeviceName: message.deviceName,
    at: Date.now(),
    // `to` only ever survives on the wire as far as this device — the generic
    // addressing filter in `handleCall` already dropped it for anyone else it
    // was not meant for, so its mere presence here means "just you."
    direct: Boolean(signal.to)
  };

  const wasRinging = ringing.has(signal.callId);
  ringing.set(signal.callId, ring);
  // Opened before the state broadcast below, the same way TeamViewer or
  // AnyDesk raise a window for an incoming call — not left for the person to
  // go find a tab for. Ringing without answering closes it again; see
  // `clearRing`.
  openCallWindow(null);
  sendStateToRenderer();

  if (wasRinging) {
    return; // A repeat of a ring already on screen.
  }

  emit('call:ring', ring);
  const kind = signal.mode === 'video' ? 'video call' : 'voice call';
  sendStatus(`${message.deviceName} is calling ${room.name}`, 'warning');
  // A call is the shortest-lived thing this app raises: unanswered, it is gone
  // in seconds. It interrupts even when the window has focus.
  notify(`Incoming ${kind}`, `${message.deviceName} is calling ${room.name}`, {
    urgent: true,
    onClick: () => callWindow?.open()
  });
}

/**
 * A ring for a hidden direct-call room this device has not seen before, from
 * whichever side of a DM call did not place it — `dm:ensure-call-room` only
 * creates the room on the caller's own device, so the callee has to be able
 * to materialize its own identical copy on demand. Only does so when the id
 * is genuinely the deterministic one for this device and the sender (see
 * `directRoomId`), so an arbitrary `dm:`-prefixed id on the wire cannot be
 * used to plant a room this device never actually agreed to.
 */
function ensureDirectRoomForIncomingCall(message: WireMessage): void {
  const roomId = message.roomId;
  if (!roomId || roomManager.getRoom(roomId) || roomId !== directRoomId(deviceId(), message.deviceId)) {
    return;
  }
  roomManager.ensureDirectRoom(deviceId(), deviceName(), message.deviceId, message.deviceName);
}

function handleCall(message: WireMessage): void {
  ensureDirectRoomForIncomingCall(message);
  const signal = handleRoomPayload(message)?.call;
  if (!signal || typeof signal.kind !== 'string' || typeof signal.callId !== 'string' || !signal.callId) {
    return;
  }

  const roomId = message.roomId!;
  const room = roomManager.getRoom(roomId);
  if (!room) {
    return;
  }

  // An addressed signal is acted on by its target and nobody else.
  const to = callSignalTarget(signal);
  if (to !== undefined && to !== deviceId()) {
    return;
  }

  switch (signal.kind) {
    case 'ring':
      return handleCallRing(message, room, signal);

    case 'join':
    case 'here': {
      const isNews = callManager.join(
        signal.callId,
        roomId,
        signal.mode,
        message.deviceId,
        message.deviceName
      );

      if (localCall?.callId === signal.callId) {
        /*
         * Answer a newcomer so it learns we are here too. Heartbeats from a
         * device we already know about are not answered, or every participant
         * would reply to every other one every few seconds.
         */
        if (signal.kind === 'join' && isNews) {
          sendCallSignal(roomId, {
            kind: 'here',
            callId: signal.callId,
            mode: localCall.mode,
            to: message.deviceId
          });
        }
        forwardCallSignal(message, signal);
      }

      if (isNews) {
        sendStateToRenderer();
      }
      return;
    }

    case 'leave': {
      const changed = callManager.leave(signal.callId, message.deviceId);
      if (!callManager.getCall(signal.callId)) {
        clearRing(signal.callId);
      }
      if (localCall?.callId === signal.callId) {
        forwardCallSignal(message, signal);
      }
      if (changed) {
        sendStateToRenderer();
      }
      return;
    }

    case 'decline':
      if (localCall?.callId === signal.callId) {
        forwardCallSignal(message, signal);
        sendStatus(`${message.deviceName} declined the call`, 'info');
      }
      return;

    case 'sdp':
    case 'ice':
    case 'device':
      if (localCall?.callId !== signal.callId) {
        return; // Not our call; nothing to negotiate.
      }
      callManager.touch(signal.callId, message.deviceId);
      forwardCallSignal(message, signal);
      return;

    default:
      return;
  }
}

// --- remote desktop ----------------------------------------------------------

/**
 * Remote desktop, from the main process's point of view.
 *
 * The screen travels over WebRTC and the input over a data channel, so neither
 * passes through here. What this owns is the part that must not be got wrong:
 * who is allowed to ask, who has to say yes, and the single gate every input
 * event passes through before it reaches the mouse.
 *
 * The rule that shapes the rest is that **approval is per session and given by a
 * human on the machine being shared**. There is no stored consent to leak, no
 * setting that leaves a machine permanently open, and no path by which a message
 * arriving off the network starts a session on its own.
 */

/** Injects into the host's own desktop while a session with control is live. */
let remoteInjector: Injector | null = null;
/** The `desktopCapturer` display id being shared, needed to aim the injector. */
let remoteDisplayId = '';
/** Held down while hosting, so the session can be killed without the window. */
const REMOTE_PANIC_SHORTCUT = 'Control+Alt+Shift+X';

/**
 * The controller's own window onto somebody else's screen. Never used by the
 * host side of a session — that stays in the main window, since there is
 * nothing to view locally beyond the status bar it already shows.
 */
function ensureRemoteWindow(): SessionWindow {
  if (!remoteWindow) {
    remoteWindow = new SessionWindow(
      {
        kind: 'remote',
        title: 'Remote desktop — Campus Connect',
        width: 1280,
        height: 800,
        minWidth: 480,
        minHeight: 360,
        preloadPath: path.join(__dirname, 'preload.js'),
        devServerUrl: rendererDevServerUrl(),
        // Disconnecting is ending the session, the same as closing the window
        // in TeamViewer or AnyDesk.
        onClosedByUser: () => endRemoteSession('You disconnected.', true)
      },
      registerWindowForEvents
    );
  }
  return remoteWindow;
}

/**
 * The floating reminder that this machine is being driven — see
 * `hostIndicator.ts`. Built lazily, the same as the call and remote windows,
 * since most sessions never happen.
 */
function ensureHostIndicator(): HostIndicator {
  if (!hostIndicator) {
    hostIndicator = new HostIndicator(
      {
        preloadPath: path.join(__dirname, 'preload.js'),
        devServerUrl: rendererDevServerUrl()
      },
      registerWindowForEvents
    );
  }
  return hostIndicator;
}

/**
 * The display behind a `desktopCapturer` source id — a fallback only.
 *
 * The id looks like `screen:0:0`, whose middle field is often, but not always,
 * the display id the `screen` module knows it by (the docs call it "a
 * sequential number"). `getSources` reports the real display id directly as
 * `display_id`, which the renderer passes through and is preferred; this parse
 * exists for platforms where that field comes back empty.
 */
function displayIdFor(sourceId: string): string {
  return sourceId.split(':')[1] ?? '';
}

/**
 * Text that arrived from another device and is about to be shown.
 *
 * Screen labels and refusal reasons are written by the far side, and a room
 * member is authenticated rather than well behaved. A few kilobytes of text in
 * a toast or a status bar is a layout problem at best.
 */
const MAX_REMOTE_TEXT = 120;

function shortenForDisplay(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_REMOTE_TEXT ? `${flat.slice(0, MAX_REMOTE_TEXT)}…` : flat;
}

function sendRemoteSignal(roomId: string, signal: RemoteSignal): boolean {
  const room = roomManager.getRoom(roomId);
  if (!room) {
    return false;
  }

  const message = baseMessage('remote');
  message.roomId = roomId;
  if (!attachRoomBody(message, room, { remote: signal })) {
    return false;
  }

  const host = getPeerHost(signal.to);
  return host ? sendUdpMessage(message, host) : deliverToRoom(message, roomId);
}

/**
 * The one place a remote session stops, whatever stopped it.
 *
 * Everything funnels through here so that the two things which must always
 * happen together always do: the keys the controller was holding are released,
 * and the panic shortcut is handed back. A path that ended a session without
 * releasing would leave the host with a stuck modifier and no idea why.
 */
function endRemoteSession(reason: string, announce: boolean): void {
  const session = remoteSessions.end();

  remoteInjector?.releaseAll();
  remoteInjector = null;
  remoteDisplayId = '';
  releasePanicShortcut();

  if (!session) {
    return;
  }

  if (announce) {
    sendRemoteSignal(session.roomId, {
      kind: 'end',
      sessionId: session.sessionId,
      to: session.peerId,
      reason
    });
  }

  emit('remote:ended', { sessionId: session.sessionId, reason });
  sendStateToRenderer();

  if (reason) {
    sendStatus(reason, 'warning');
  }

  // The host stays in the main window and never opened this one.
  if (session.role === 'controller') {
    remoteWindow?.closeIfOpen();
  } else {
    hostIndicator?.hide();
  }
}

/**
 * A way out that does not depend on reaching the window.
 *
 * While someone else is moving the mouse, clicking a button in this app is
 * exactly the thing that might not be possible. A global shortcut is registered
 * for the duration of a hosted session and given back the moment it ends.
 */
function claimPanicShortcut(): void {
  try {
    const registered = globalShortcut.register(REMOTE_PANIC_SHORTCUT, () => {
      endRemoteSession('You ended the remote session from the keyboard.', true);
      showMainWindow();
    });

    if (!registered) {
      log.warn(`Could not register ${REMOTE_PANIC_SHORTCUT}; another application holds it`);
    }
  } catch (error) {
    log.warn(`Could not register the remote panic shortcut: ${(error as Error).message}`);
  }
}

function releasePanicShortcut(): void {
  try {
    globalShortcut.unregister(REMOTE_PANIC_SHORTCUT);
  } catch {
    // Nothing to give back. Not worth reporting.
  }
}

function handleRemote(message: WireMessage): void {
  const signal = handleRoomPayload(message)?.remote;
  if (!signal || typeof signal.kind !== 'string' || typeof signal.sessionId !== 'string' || !signal.sessionId) {
    return;
  }

  // Every remote signal is addressed. One that is not, or is for somebody else,
  // is not ours to act on.
  if (signal.to !== deviceId()) {
    return;
  }

  const roomId = message.roomId!;
  const room = roomManager.getRoom(roomId);
  if (!room) {
    return;
  }

  switch (signal.kind) {
    case 'request': {
      /*
       * Somebody wants to see this screen. Nothing at all happens beyond putting
       * the question on screen — no capture starts, no connection is negotiated,
       * and a refusal is the default if nobody answers.
       */
      if (remoteSessions.busy) {
        sendRemoteSignal(roomId, {
          kind: 'deny',
          sessionId: signal.sessionId,
          to: message.deviceId,
          reason: `${deviceName()} is already in a remote session.`
        });
        return;
      }

      const added = remoteSessions.addRequest({
        sessionId: signal.sessionId,
        roomId,
        fromDeviceId: message.deviceId,
        fromDeviceName: message.deviceName,
        at: Date.now()
      });
      if (!added) {
        return;
      }

      const request: RemoteRequest = {
        sessionId: signal.sessionId,
        roomId,
        roomName: room.name,
        fromDeviceId: message.deviceId,
        fromDeviceName: message.deviceName,
        at: Date.now()
      };

      emit('remote:request', request);
      sendStatus(`${message.deviceName} is asking to see your screen`, 'warning');
      notify(
        'Screen access requested',
        `${message.deviceName} wants to view your screen in ${room.name}. Nothing is shared until you allow it.`,
        // Expires in a minute, and is the most consequential thing anyone can
        // ask this machine for. Missing it by not looking is not acceptable.
        { urgent: true }
      );
      return;
    }

    case 'grant': {
      /*
       * Our own request was allowed — but only if we made one. The session id
       * is chosen by whoever speaks first, so without matching it back to an
       * ask of ours, any room member could hand this device a session it never
       * requested and take over its screen with their own.
       */
      const asked = remoteSessions.takeOutgoingRequest(signal.sessionId);
      if (!asked || asked.targetDeviceId !== message.deviceId || asked.roomId !== roomId) {
        log.warn(`Ignored a remote grant from ${message.deviceName} that answered no request of ours`);
        return;
      }

      // We become the controller.
      const started = remoteSessions.start({
        sessionId: signal.sessionId,
        roomId,
        role: 'controller',
        peerId: message.deviceId,
        peerName: message.deviceName,
        grant: signal.grant === 'control' ? 'control' : 'view',
        screenLabel: shortenForDisplay(String(signal.screenLabel ?? ''))
      });

      if (!started) {
        return;
      }

      // Opened the same way the call window is: before the broadcast, so the
      // window exists to register for it, but not depended on to receive it —
      // the window reads `state.remote` for itself once it has loaded.
      ensureRemoteWindow().open();
      emit('remote:started', remoteSessions.current);
      sendStateToRenderer();
      sendStatus(
        signal.grant === 'control'
          ? `${message.deviceName} gave you control of their screen.`
          : `${message.deviceName} shared their screen with you.`,
        'success'
      );
      return;
    }

    case 'deny': {
      // Same correlation as `grant`: a refusal for something we never asked is
      // just a stranger putting text on our screen.
      const asked = remoteSessions.takeOutgoingRequest(signal.sessionId);
      if (!asked || asked.targetDeviceId !== message.deviceId) {
        return;
      }
      sendStatus(shortenForDisplay(String(signal.reason || `${message.deviceName} declined.`)), 'warning');
      return;
    }

    case 'grant-changed': {
      if (!remoteSessions.ownsSession(signal.sessionId, message.deviceId)) {
        return;
      }

      const grant: RemoteGrant = signal.grant === 'control' ? 'control' : 'view';
      remoteSessions.setGrant(signal.sessionId, grant);
      emit('remote:grant-changed', grant);
      sendStateToRenderer();
      sendStatus(
        grant === 'control'
          ? `${message.deviceName} gave you control.`
          : `${message.deviceName} took back control. You can still watch.`,
        'info'
      );
      return;
    }

    case 'end':
      if (!remoteSessions.ownsSession(signal.sessionId, message.deviceId)) {
        return;
      }
      endRemoteSession(String(signal.reason || `${message.deviceName} ended the remote session.`), false);
      return;

    case 'sdp':
    case 'ice':
      if (!remoteSessions.ownsSession(signal.sessionId, message.deviceId)) {
        return;
      }
      emit('remote:signal', {
        roomId,
        fromDeviceId: message.deviceId,
        fromDeviceName: message.deviceName,
        signal
      });
      return;

    default:
      return;
  }
}

/** Requests nobody answered are refused rather than left hanging. */
function sweepRemoteRequests(): void {
  for (const sessionId of remoteSessions.sweepRequests()) {
    emit('remote:request-expired', sessionId);
  }
}

/**
 * One step of a peer-to-peer file transfer, off the wire.
 *
 * Unlike remote desktop this is not room-scoped — it is device-to-device, and
 * the only gate beyond the transport's own checks is whether the receiver
 * accepted. Every signal is handed to the manager, which decides whether it
 * belongs to a session it owns. Nothing is persisted here, which is the point:
 * a transfer is a thing that happens now.
 */
function handleFileXfer(message: WireMessage): void {
  const signal = message.fileXfer;
  if (!signal || typeof signal.kind !== 'string' || typeof signal.transferId !== 'string') {
    return;
  }

  // The sender is the only one who talks first, and only ever by name — the
  // request carries no files, so agreeing to it cannot hand over anything yet.
  fileShares.handleSignal(message.deviceId, message.deviceName, signal);

  /*
   * A transfer request had been the one thing in the app that asked for an
   * answer without ever saying so out loud: it opens a dialog, times out after
   * a minute, and until now raised nothing at all if the window was behind
   * something else.
   */
  if (signal.kind === 'request' && fileShares.state.incoming?.transferId === signal.transferId) {
    sendStatus(`${message.deviceName} wants to send you files`, 'warning');
    notify('Incoming files', `${message.deviceName} wants to send you files.`, { urgent: true });
  }
}

/**
 * A direct 1:1 signal arriving off the wire — a new message, or an edit,
 * delete or reaction to one already sent. Same trust bar as file sharing: no
 * room in common required, only the universal `isBlocked()` gate already
 * applied to every inbound message before this is ever reached.
 *
 * Every branch below pushes through the same `dm:message` event whether it
 * is a brand new message or an amendment to one — `useDirectMessage` in the
 * renderer tells the two apart by whether the id is already in the thread,
 * so this needs no separate "something changed" channel the way room chat's
 * edits do.
 */
function handleDirectMessage(message: WireMessage): void {
  // Addressed, like any other targeted signal — a message meant for a
  // different device that happens to now answer at the sender's stale
  // record of this one's address is not ours to read.
  if (message.targetDeviceId !== deviceId()) {
    return;
  }

  // Always sealed — see `attachDmBody`. Fails to open when this device does
  // not yet have the sender's box key (should not happen for anyone already
  // in `state.peers`), or the packet was tampered with in flight.
  const signal = readDmBody(message)?.directMessage;
  if (!signal) {
    return;
  }

  // Only the kinds that act on one particular message carry an id — a
  // receipt names a batch and typing names nothing at all, so this is
  // checked per kind below rather than once up front.
  switch (signal.kind) {
    case 'message': {
      if (typeof signal.id !== 'string') {
        return;
      }
      const stored = directMessages.receive(message.deviceId, message.deviceName, signal);
      if (!stored) {
        return; // Already have it — a retransmit, not a new message.
      }
      emit('dm:message', stored);
      sendStateToRenderer();
      sendStatus(`${message.deviceName} sent you a message`, 'info');
      notify(message.deviceName, stored.type === 'text' ? stored.content : (stored.fileName ?? 'Sent a file'));
      sendDmReceipt(message.deviceId, [stored.id], 'delivered');
      return;
    }

    case 'edit': {
      if (typeof signal.id !== 'string' || typeof signal.content !== 'string') {
        return;
      }
      // `fromSelf: false` — this can only be the peer editing a message *they*
      // sent us. A device cannot reach into our own outbox from the wire.
      const updated = directMessages.editMessage(
        message.deviceId,
        signal.id,
        signal.content,
        signal.editedAt ?? Date.now(),
        false
      );
      if (updated) {
        emit('dm:message', updated);
        sendStateToRenderer();
      }
      return;
    }

    case 'delete': {
      if (typeof signal.id !== 'string') {
        return;
      }
      const updated = directMessages.markDeleted(message.deviceId, signal.id, false);
      if (updated) {
        emit('dm:message', updated);
        sendStateToRenderer();
      }
      return;
    }

    case 'reaction': {
      if (typeof signal.id !== 'string' || !signal.emoji || signal.emoji.length > 12) {
        return; // Displayed as sent — capped the same way room chat's is.
      }
      if (directMessages.setReaction(message.deviceId, signal.id, signal.emoji, message.deviceId, Boolean(signal.on))) {
        const updated = directMessages.findMessage(message.deviceId, signal.id);
        if (updated) {
          emit('dm:message', updated);
          sendStateToRenderer();
        }
      }
      return;
    }

    case 'receipt': {
      if (!Array.isArray(signal.messageIds) || (signal.receipt !== 'delivered' && signal.receipt !== 'seen')) {
        return;
      }
      // The receipt names the *sender's own* messages it is acknowledging —
      // `recordReceipt` only ever touches this thread's `fromSelf` rows,
      // which from this device's point of view are exactly the ones the
      // peer sending this receipt could mean.
      for (const updated of directMessages.recordReceipt(message.deviceId, signal.messageIds, signal.receipt)) {
        emit('dm:message', updated);
      }
      return;
    }

    case 'typing': {
      emit('dm:typing', { peerId: message.deviceId, peerName: message.deviceName, typing: Boolean(signal.typing) });
      return;
    }

    default:
      return;
  }
}

/** Tells a DM peer that some of their messages were received or read, the same way `sendReceipt` does for a room. */
function sendDmReceipt(peerId: string, messageIds: string[], receipt: 'delivered' | 'seen'): void {
  if (!getSettings().sendReceipts || messageIds.length === 0) {
    return;
  }
  sendDirectMessage(peerId, { kind: 'receipt', messageIds, receipt });
}

/** Tells a DM peer whether this device is currently composing a reply. */
function sendDmTyping(peerId: string, typing: boolean): void {
  sendDirectMessage(peerId, { kind: 'typing', typing });
}

/**
 * Keeps the picture of who is in a call honest.
 *
 * A device that loses power, or WiFi, mid-call never says goodbye. So each
 * participant re-announces itself on a timer and anyone who stops is dropped —
 * which is what lets a call end when the last person's laptop lid closes rather
 * than staying on screen until the app is restarted.
 */
function sweepCalls(): void {
  if (localCall) {
    callManager.join(
      localCall.callId,
      localCall.roomId,
      localCall.mode,
      deviceId(),
      deviceName()
    );
    sendCallSignal(localCall.roomId, {
      kind: 'join',
      callId: localCall.callId,
      mode: localCall.mode
    });
  }

  sweepRemoteRequests();
  fileShares.sweep();
  if (phoneServer?.sessions.sweep()) {
    sendStateToRenderer();
  }
  let changed = callManager.sweep();

  /*
   * An unanswered ring is cleared purely by its own age, not by whether the
   * caller still counts as a "live participant" in `callManager`. It used to
   * be both: `!callManager.getCall(callId)` also tore the ring down the
   * moment the caller's single participant entry aged out of
   * `PARTICIPANT_TTL_MS` (20s) — a check meant for noticing a participant
   * who vanished mid-*conversation*, not a caller who has not been answered
   * yet. Heartbeats only arrive every `CALL_HEARTBEAT_MS` (5s), so any one
   * delayed or dropped packet near that 20s mark — ordinary jitter on a UDP
   * broadcast, not a real disconnection — closed the ring dialog on its own,
   * often well before a person had a chance to see it, let alone answer.
   * `RING_TIMEOUT_MS` (45s) already exists as the deliberate, documented
   * "nobody answered" window; a caller who actively hangs up while still
   * ringing already clears it explicitly via the `'leave'` signal handler,
   * so nothing here needs a second, shorter, less reliable path to the same
   * effect.
   */
  for (const [callId, ring] of Array.from(ringing)) {
    if (Date.now() - ring.at > RING_TIMEOUT_MS) {
      clearRing(callId);
      changed = true;
    }
  }

  if (localCall) {
    const others = callManager.countParticipants(localCall.callId) - 1;
    if (others > 0) {
      localCallHadCompany = true;
    } else if (Date.now() - (callManager.getCall(localCall.callId)?.startedAt ?? 0) > CALL_ALONE_GRACE_MS) {
      sendStatus(
        localCallHadCompany ? 'Everyone else left the call.' : 'Nobody answered the call.',
        'info'
      );
      endLocalCall(true);
      return;
    }
  }

  if (changed) {
    sendStateToRenderer();
  }
}

function handleWireMessage(message: WireMessage, host: string) {
  if (message.deviceId === deviceId()) {
    return; // Our own broadcast, looped back.
  }

  touchPeerFromMessage(message, host);

  switch (message.type) {
    case 'announce':
      return;
    case 'room-advert':
      if (message.advert) {
        roomManager.recordAdvert(message.advert, host);
        sendStateToRenderer();
      }
      return;
    case 'room-request':
      return handleRoomRequest(message, host);
    case 'room-accept':
      return handleRoomAccept(message);
    case 'room-reject':
      return handleRoomReject(message);
    case 'room-roster':
      return handleRoomRoster(message);
    case 'room-leave':
      return handleRoomLeave(message);
    case 'room-rekey':
      return handleRoomRekey(message);
    case 'room-closed':
      return handleRoomClosed(message);
    case 'clipboard':
      return handleClipboardMessage(message);
    case 'chat':
      return handleChatMessage(message);
    case 'chunk':
      return handleChunk(message, host);
    case 'chunk-nack':
      return handleChunkNack(message);
    case 'room-invite':
      return handleRoomInvite(message, host);
    case 'room-invite-accept':
      return handleInviteAccept(message);
    case 'room-invite-decline':
      return handleInviteDecline(message);
    case 'chat-receipt':
      return handleChatReceipt(message);
    case 'chat-edit':
      return handleChatEdit(message);
    case 'chat-delete':
      return handleChatDelete(message);
    case 'chat-reaction':
      return handleChatReaction(message);
    case 'chat-typing':
      return handleChatTyping(message);
    case 'call':
      return handleCall(message);
    case 'remote':
      return handleRemote(message);
    case 'file-xfer':
      return handleFileXfer(message);
    case 'direct-message':
      return handleDirectMessage(message);
    default:
      return;
  }
}

// --- lifecycle ---------------------------------------------------------------

/**
 * A device that speaks another protocol version. `announce` is still accepted
 * so the device appears at all, labelled with the version it speaks; anything
 * else is refused, because those messages change meaning between versions.
 */
function reportVersionMismatch(message: WireMessage, host: string): void {
  if (message.type === 'announce' && message.deviceName) {
    updatePeer({
      id: message.deviceId,
      name: message.deviceName,
      host,
      port: message.port ?? BROADCAST_PORT,
      lastSeen: Date.now(),
      protocolVersion: message.v
    });
  }

  if (!diagnostics.otherVersions.includes(message.v)) {
    diagnostics.otherVersions.push(message.v);
    log.warn(`${message.deviceName} speaks protocol v${message.v}; this app speaks v${PROTOCOL_VERSION}`);
    sendStatus(
      `${message.deviceName || 'A device'} is running a different version of Campus Connect (protocol v${message.v} against this app's v${PROTOCOL_VERSION}), so the two cannot talk to each other. Install the same version on both.`,
      'error'
    );
    notify(
      'Different version detected',
      `${message.deviceName || 'A device'} is running another version of Campus Connect. Install the same version on both machines.`
    );
  }
  sendStateToRenderer();
}

/** One place where an arriving message is validated, whatever carried it. */
function receiveMessage(raw: string, host: string, viaTcp: boolean): void {
  try {
    const message = JSON.parse(raw) as WireMessage;
    if (!message?.type || !message.deviceId) {
      return;
    }

    /*
     * A blocked device is dealt with here and nowhere else.
     *
     * One check, before anything is counted, stored, shown or answered — which
     * is the only way a block can be relied on. Spreading the decision across
     * the individual handlers is how one of them ends up forgotten, and a block
     * that leaks in one place is not a block.
     */
    if (isBlocked(message.deviceId)) {
      return;
    }

    diagnostics.packetsReceived += 1;
    diagnostics.lastReceivedAt = Date.now();
    if (viaTcp) {
      diagnostics.tcpFramesReceived += 1;
    }

    if (message.v !== PROTOCOL_VERSION) {
      reportVersionMismatch(message, host);
      return;
    }

    if (!authenticate(message)) {
      return;
    }

    handleWireMessage(message, host);
  } catch {
    // Malformed input on a shared port is expected; ignore quietly.
  }
}

/**
 * Whether this message really came from the device it names.
 *
 * Three questions, and all of them have to answer yes before anything
 * downstream sees the message:
 *
 *   1. Is it signed, and does the signature verify against the key it
 *      carries? That covers the contents — nothing in the signed set can be
 *      altered in flight, including the digest of the body.
 *   2. Is it recent? A signature is valid forever, so without a clock a
 *      captured message could be replayed indefinitely.
 *   3. Is that key the one we already associate with this device id? This is
 *      the question that turns a signature into an identity. Step 1 alone
 *      proves only that the sender holds the key they attached, which is no
 *      obstacle at all to somebody who generated it a moment ago.
 *
 * A device id whose key has changed is refused rather than re-learned. It is
 * either an impersonation or a genuine reinstall, and those are
 * indistinguishable from here — the honest one recovers by rejoining the
 * room, which is a deliberate act by somebody who knows the password.
 */
function authenticate(message: WireMessage): boolean {
  if (!message.pubKey || !message.sig) {
    log.warn(`[identity] Dropped an unsigned ${message.type} from ${message.deviceId}.`);
    return false;
  }

  if (!verifySignature(message.pubKey, signableOf(message), message.sig)) {
    log.warn(`[identity] Dropped a badly signed ${message.type} from ${message.deviceId}.`);
    return false;
  }

  if (!withinSkew(message.timestamp)) {
    log.warn(`[identity] Dropped a stale ${message.type} from ${message.deviceId}.`);
    return false;
  }

  if (deviceRegistry.check(message.deviceId, message.pubKey) === 'mismatch') {
    log.warn(
      `[identity] ${message.deviceId} presented a different key than the one on file; dropped.`
    );
    return false;
  }

  return true;
}

function startTcpService() {
  tcp = new TcpTransport({
    port: BROADCAST_PORT,
    maxFrameBytes: MAX_TRANSFER_BYTES,
    onMessage: (payload, host) => receiveMessage(payload, host, true),
    onStatus: (message) => sendStatus(message, 'info'),
    undialable: () => [getLocalIpAddress(), ...listBroadcastTargets(currentInterfaces())]
  });
  tcp.start();

  // Re-dial every peer we know about, so a direct link survives a restart.
  for (const peer of read('peers')) {
    tcp.connect(peer.host);
  }
}

function startUdpService() {
  udpSocket = dgram.createSocket({
    type: 'udp4',
    reuseAddr: true,
    // Without these, a large chunked transfer overflows the default buffers and
    // most of it is dropped before it reaches the network.
    recvBufferSize: SOCKET_BUFFER_BYTES,
    sendBufferSize: SOCKET_BUFFER_BYTES
  });

  udpSocket.on('error', (error) => {
    diagnostics.lastError = error.message;
    sendStatus(`Network error: ${error.message}`, 'error');
  });

  udpSocket.on('message', (buffer, rinfo) => {
    receiveMessage(buffer.toString('utf8'), rinfo.address, false);
  });

  udpSocket.bind(BROADCAST_PORT, () => {
    udpSocket?.setBroadcast(true);
    const targets = listBroadcastTargets(currentInterfaces());
    log.info(`Listening on ${BROADCAST_PORT}. Local address ${getLocalIpAddress()}.`);
    log.info(`Broadcasting to: ${targets.join(', ')}`);
    for (const nic of describeInterfaces(currentInterfaces())) {
      log.info(`  interface ${nic.name} ${nic.address} -> ${nic.broadcast ?? 'no broadcast'}${nic.virtual ? ' (virtual)' : ''}${nic.chosen ? ' [chosen]' : ''}`);
    }
    sendStatus(`Listening on port ${BROADCAST_PORT}`, 'success');
    broadcastPresence();
    advertiseOwnedRooms();

    announceTimer = setInterval(() => {
      broadcastPresence();
      advertiseOwnedRooms();
      sweepPeers();
    }, ANNOUNCE_INTERVAL_MS);
    clipboardPollTimer = setInterval(pollLocalClipboard, CLIPBOARD_POLL_MS);
    transferSweepTimer = setInterval(sweepTransfers, TRANSFER_SWEEP_MS);
    callSweepTimer = setInterval(sweepCalls, CALL_HEARTBEAT_MS);
    compactTimer = setInterval(() => {
      if (compactStorage() > 0) {
        sendStateToRenderer();
      }
    }, COMPACT_INTERVAL_MS);
  });
}

/** Applies the retention window and the size ceiling to stored history. */
function compactStorage(): number {
  const settings = getSettings();
  const cleared = historyManager.compact(settings.retainMediaDays, settings.maxStorageMb);
  if (cleared > 0) {
    log.info(`Storage cleanup dropped ${cleared} attachment(s)`);
  }
  return cleared;
}

/**
 * Brings the whole network up or down behind the header switch.
 *
 * Off is genuinely off — the sockets are closed, so there is nothing listening,
 * nothing announcing, and no clipboard being watched. Rooms, keys and history
 * are untouched and come straight back when it is switched on again.
 */
function setNetworkEnabled(next: boolean): void {
  if (next === Boolean(udpSocket)) {
    return;
  }

  if (next) {
    startUdpService();
    startTcpService();
    reconnectRememberedPeers();
    updater?.start(getSettings().autoUpdate);
    sendStatus('Campus Connect is on.', 'success');
    return;
  }

  /*
   * A call cannot survive the network going away, and the far side has to be
   * told before the socket closes under it — so this happens first.
   */
  phoneServer?.stop();
  endRemoteSession('Campus Connect was switched off, so the remote session ended.', true);
  remoteSessions.clear();
  endLocalCall(true);
  callManager.clear();
  for (const callId of Array.from(ringing.keys())) {
    clearRing(callId);
  }

  stopUdpService();
  write('peers', []);
  roomManager.clearAdverts();
  sendStatus('Campus Connect is off. Nothing is shared or received.', 'warning');
  sendStateToRenderer();
}

/** Rejects anything that needs the network while the switch is off. */
function requireOnline(): ActionResult | null {
  return getSettings().online
    ? null
    : fail('Campus Connect is off. Turn it on from the header to use this.');
}

function stopUdpService() {
  if (announceTimer) {
    clearInterval(announceTimer);
    announceTimer = null;
  }
  if (clipboardPollTimer) {
    clearInterval(clipboardPollTimer);
    clipboardPollTimer = null;
  }
  if (transferSweepTimer) {
    clearInterval(transferSweepTimer);
    transferSweepTimer = null;
  }
  if (callSweepTimer) {
    clearInterval(callSweepTimer);
    callSweepTimer = null;
  }
  if (compactTimer) {
    clearInterval(compactTimer);
    compactTimer = null;
  }
  outboundTransfers.clear();
  updater?.stop();
  tcp?.stop();
  tcp = null;
  udpSocket?.close();
  udpSocket = null;
}

/**
 * The tray mark, matching the app icon but simplified.
 *
 * At 16px the gradient, the corner radius and the stand under the screen all
 * turn to mush, so only the two arcs and the screen survive — and they are drawn
 * heavier than in the full icon, because a hairline disappears entirely once
 * Windows has scaled it.
 */
function createTrayIcon() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
<rect width="64" height="64" rx="15" fill="#4f46e5"/>
<rect x="18" y="35" width="28" height="19" rx="4" fill="#ffffff"/>
<g fill="none" stroke="#ffffff" stroke-linecap="round" stroke-width="5">
  <path d="M23 27a13 13 0 0 1 18 0"/>
  <path d="M16 20a23 23 0 0 1 32 0"/>
</g>
</svg>`;

  const icon = nativeImage.createFromDataURL(
    'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')
  );
  return icon.resize({ width: 16, height: 16 });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow();
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

function setupTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip('Campus Connect');
  refreshTrayMenu();
  tray.on('click', () => showMainWindow());
}

function refreshTrayMenu() {
  const settings = getSettings();
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Campus Connect', click: () => showMainWindow() },
      {
        label: 'Campus Connect on',
        type: 'checkbox',
        checked: settings.online,
        click: (item) => updateSettings({ online: item.checked })
      },
      {
        label: 'Share my clipboard',
        type: 'checkbox',
        enabled: settings.online,
        checked: settings.syncEnabled,
        click: (item) => updateSettings({ syncEnabled: item.checked })
      },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() }
    ])
  );
}

/** Where the interface is loaded from: the dev server, or the packaged files. */
function rendererDevServerUrl(): string | undefined {
  return process.env.VITE_DEV_SERVER_URL ?? (app.isPackaged ? undefined : 'http://localhost:5173');
}

/**
 * Brings up the quick-paste overlay and its global hotkey.
 *
 * Deliberately independent of the main window: the whole point is that it works
 * while the main window is closed, which — for an app that lives in the tray —
 * is most of the time.
 */
function setupQuickPaste(): void {
  quickPaste = new QuickPaste({
    preloadPath: path.join(__dirname, 'preload.js'),
    devServerUrl: rendererDevServerUrl(),
    paste: getPasteAction(),
    isQuitting: () => isQuiting,
    onOpened: () => quickPaste?.send('quick-paste:opened', quickPasteItems())
  });

  quickPaste.warmUp();

  const problem = quickPaste.setShortcut(getSettings().quickPasteShortcut);
  if (problem) {
    sendStatus(problem, 'warning');
  }
}

/**
 * What the overlay shows: this device's clipboard history across every room,
 * plus the snippet library.
 *
 * Across every room on purpose. The overlay is opened from inside another
 * application, where the question is "what did I copy", not "which room was I
 * in when I copied it" — the room is shown on each entry, but it does not
 * filter.
 */
function quickPasteItems(): { clips: ClipboardHistoryEntry[]; snippets: Snippet[]; roomNames: Record<string, string> } {
  const roomNames: Record<string, string> = {};
  for (const room of roomManager.getRooms()) {
    roomNames[room.roomId] = room.name;
  }

  return {
    clips: historyManager.getClipboardHistory().slice(0, 60),
    snippets: snippetManager.list(),
    roomNames
  };
}

// --- launching with the machine ----------------------------------------------

/**
 * The flag a login-item launch carries.
 *
 * `openAsHidden` is a macOS-only concept; on Windows and Linux the registered
 * command is just a command, so the only way to know it came from the system
 * rather than from a person double-clicking is to have put something in it.
 */
const HIDDEN_LAUNCH_FLAG = '--hidden';

/**
 * Adopts whatever the system already says, once.
 *
 * Every previous version added itself to startup unconditionally, with no way
 * to say otherwise. Now that it is a setting, defaulting it to off would mean
 * upgrading quietly took the app *out* of startup for everyone who had grown
 * used to it being there — a change nobody asked for, made invisibly.
 *
 * So on the first run that has the setting at all, the answer comes from the
 * operating system rather than from the default. A fresh install has no entry
 * and lands on off; an upgrade keeps what it had.
 */
function seedLaunchSettingFromSystem(): void {
  const stored = read('settings') as Partial<AppSettings> | undefined;
  if (stored && stored.launchAtLogin !== undefined) {
    return;
  }

  let openAtLogin = false;
  try {
    openAtLogin = app.getLoginItemSettings().openAtLogin;
  } catch {
    // Unsupported platform, or no permission to look. Off is the safe answer.
  }

  write('settings', { ...getSettings(), launchAtLogin: openAtLogin });
  log.info(`Adopted the existing startup setting: ${openAtLogin ? 'on' : 'off'}`);
}

/** True when this run began at login and should stay in the tray. */
function startedHidden(): boolean {
  if (process.argv.includes(HIDDEN_LAUNCH_FLAG)) {
    return true;
  }
  // macOS answers this properly, and never sees the flag above.
  return IS_MAC && app.getLoginItemSettings().wasOpenedAsHidden;
}

/**
 * Puts the stored preference into effect.
 *
 * Called at startup as well as on change, because the login item lives in the
 * operating system rather than in this app's own storage — a reinstall, a
 * profile move or somebody clearing their startup list all leave the two
 * disagreeing, and the app's own setting is the one that should win.
 */
function applyLaunchSettings(): void {
  /*
   * Only the installed copy gets to touch this.
   *
   * Electron keys the startup entry by application name, so a checkout running
   * unpackaged shares the registry value with the installed app — and since
   * this runs at every startup, a `npm run dev` would repoint the real app's
   * autostart at a development tree, or with the setting off, delete it.
   */
  if (!app.isPackaged) {
    return;
  }

  const settings = getSettings();

  try {
    app.setLoginItemSettings({
      openAtLogin: settings.launchAtLogin,
      // macOS reads this; the others read the argument.
      openAsHidden: settings.launchMinimized,
      args: settings.launchMinimized ? [HIDDEN_LAUNCH_FLAG] : []
    });
  } catch (error) {
    log.warn(`Could not update the startup setting: ${(error as Error).message}`);
  }
}

// --- deep links --------------------------------------------------------------

/**
 * Links that open this app.
 *
 * The scheme was already being minted — every room QR code encodes
 * `campusconnect://join?code=…` — but nothing had ever registered to receive
 * it, so scanning one offered no application to open. Registering it is what
 * makes that code path mean something.
 */
/** Links that arrived before there was a window to hand them to. */
let pendingDeepLink: DeepLink | null = null;

function registerProtocolClient(): void {
  try {
    if (app.isPackaged) {
      app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
      return;
    }

    /*
     * Unpackaged, the executable is Electron itself, so the registration has to
     * carry the script path too or the system launches a bare Electron with no
     * application in it.
     */
    const entry = process.argv[1] ? [path.resolve(process.argv[1])] : [];
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, entry);
  } catch (error) {
    log.warn(`Could not register the ${DEEP_LINK_SCHEME}: scheme: ${(error as Error).message}`);
  }
}

/**
 * Hands a link to the interface, opening the window if it is not already there.
 *
 * A link is always a deliberate act by the person at the keyboard, so unlike a
 * message arriving from the network it is allowed to take the screen.
 */
function deliverDeepLink(link: DeepLink | null): void {
  if (!link) {
    return;
  }

  showMainWindow();

  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send('app:deep-link', link);
    pendingDeepLink = null;
    return;
  }

  // The window is still starting; it asks for this once it is ready.
  pendingDeepLink = link;
}

function createWindow({ show = true }: { show?: boolean } = {}): BrowserWindow {
  const window = new BrowserWindow({
    show,
    /*
     * Sized for the screens this actually runs on. The old 1180x780 left the
     * content column half empty on a 1080p laptop while still being tight
     * enough that the members list wrapped; this fills the space it is given
     * without ever exceeding a 1366x768 display.
     */
    width: 1320,
    height: 880,
    minWidth: 1040,
    minHeight: 680,
    title: 'Campus Connect',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1115' : '#ffffff',
    /*
     * The window draws its own top edge.
     *
     * On macOS the traffic lights stay native and are simply inset into the
     * rail — they are muscle memory there, and an app that redraws them is the
     * first thing a Mac user notices and dislikes. Everywhere else the frame
     * goes entirely and the controls are ours, because the alternative is a
     * grey OS strip sitting above a dark application.
     */
    frame: IS_MAC,
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
    trafficLightPosition: IS_MAC ? { x: 18, y: 18 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  window.on('close', (event) => {
    if (!isQuiting) {
      event.preventDefault();
      window.hide();
    }
  });

  /*
   * The controls are drawn by the renderer, so it has to be told what the
   * window is doing — including when that changes without it, as it does on a
   * double-click of the drag region or a keyboard maximise.
   */
  const reportWindowState = () => {
    if (!window.isDestroyed()) {
      window.webContents.send('window:state', currentWindowState(window));
    }
  };

  window.on('maximize', reportWindowState);
  window.on('unmaximize', reportWindowState);
  window.on('enter-full-screen', reportWindowState);
  window.on('leave-full-screen', reportWindowState);
  window.webContents.on('did-finish-load', reportWindowState);

  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // The default menu bar is gone, so keep the devtools reachable by key.
  window.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') {
      return;
    }
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
      window.webContents.toggleDevTools();
    }
  });

  const devServerUrl = rendererDevServerUrl();

  if (devServerUrl) {
    window.loadURL(devServerUrl);
  } else {
    window.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  registerWindowForEvents(window);

  return window;
}

/*
 * An app that lives in the tray should not disappear because something
 * transient went wrong.
 *
 * Electron's default for an uncaught exception in the main process is a dialog
 * with a stack trace and then nothing — the window stops responding and the
 * user is left with an app that is neither running nor closed. Almost every
 * candidate here is a passing failure of the outside world: a locked file, a
 * socket closing at the wrong moment. Logging it and carrying on is far closer
 * to what the user wants than the app vanishing.
 */
process.on('uncaughtException', (error) => {
  log.error(`Uncaught exception in the main process: ${error?.stack ?? String(error)}`);
});

process.on('unhandledRejection', (reason) => {
  log.error(`Unhandled promise rejection: ${(reason as Error)?.stack ?? String(reason)}`);
});

/*
 * Let WebRTC see the machine's real address on this network.
 *
 * Chromium hides local IPs behind generated `*.local` mDNS hostnames in ICE
 * candidates, which is the right default for a browser: it stops a web page
 * learning your internal addresses. Here it is the one thing that must not
 * happen. Every call in this app is between two machines on the same LAN, and
 * their host candidates *are* the connection — there is no STUN or TURN server
 * to fall back on. Leaving the obfuscation in place makes a call depend on mDNS
 * resolution succeeding on both ends, which on a campus network is exactly the
 * kind of multicast traffic that gets filtered.
 *
 * Nothing is exposed by this that the app does not already broadcast: it
 * announces its own address on the LAN every three seconds by design.
 */
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');

/*
 * One copy of the app per machine.
 *
 * It starts with the system and then lives in the tray, so opening it from the
 * shortcut while it is already running is the normal thing to do — and that
 * used to start a second copy. Two copies share the port, both answer the same
 * room, and both raise a notification for everything that arrives, which looks
 * exactly like the network sending everything twice.
 */
if (!app.requestSingleInstanceLock()) {
  log.info('Another copy of Campus Connect is already running; handing over to it');
  app.quit();
}

/*
 * The second copy is how a link arrives on Windows and Linux.
 *
 * Clicking a `campusconnect://` link launches the registered command with the
 * URL appended, which the single-instance lock turns into this event rather
 * than a new process — so the URL is in *its* command line, not ours.
 */
app.on('second-instance', (_event, argv) => {
  const link = deepLinkFromArgv(argv);
  if (link) {
    deliverDeepLink(link);
    return;
  }
  showMainWindow();
});

/*
 * macOS never puts the URL on a command line; it delivers it as an event, and
 * routinely does so before the app is ready. `deliverDeepLink` parks anything
 * that arrives too early until there is a window to give it to.
 */
app.on('open-url', (event, url) => {
  event.preventDefault();
  deliverDeepLink(parseDeepLink(url));
});

app.whenReady().then(() => {
  // A second copy is on its way out; it must not open a window or take a port.
  if (!app.hasSingleInstanceLock()) {
    return;
  }

  // No File/Edit/View/Window/Help ribbon — the app has its own chrome.
  Menu.setApplicationMenu(null);
  seedLaunchSettingFromSystem();
  applyLaunchSettings();
  registerProtocolClient();

  /*
   * What the window is allowed to ask the system for. Everything unrecognised is
   * denied rather than allowed by default.
   *
   *  - 'local-fonts' lets the font picker read the installed list.
   *  - 'media' is the microphone and the camera, for calls. There is no browsing
   *    here and no remote content: the only page ever loaded is this app's own,
   *    so a grant cannot reach anything but the call UI.
   *  - 'display-capture' is screen sharing, which additionally goes through the
   *    picker below — a grant here does not by itself hand over a screen.
   */
  const GRANTED_PERMISSIONS = new Set(['local-fonts', 'media', 'display-capture']);
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(GRANTED_PERMISSIONS.has(String(permission)));
  });
  session.defaultSession.setPermissionCheckHandler((_contents, permission) =>
    GRANTED_PERMISSIONS.has(String(permission))
  );

  loadBlocked();

  // Drop a stale current room left over from a previous run.
  const currentRoomId = read('currentRoomId');
  if (currentRoomId && !roomManager.getRoom(currentRoomId)) {
    write('currentRoomId', undefined);
  }

  /*
   * Windows attributes notifications by app id; without this they show as coming
   * from "electron.app.Electron".
   *
   * Still the old id, on purpose, and it has to stay that way. It is the same
   * string as `build.appId`, which is what the installer registers the app under
   * — so changing it would make the next release install alongside the previous
   * one instead of upgrading it, and leave everyone running two copies fighting
   * over the port. The id is internal; the name people see comes from
   * productName.
   */
  app.setAppUserModelId('com.vijayapardhu.sharedclipboard');

  if (migration.migrated) {
    log.info(`Brought forward the previous install's data from ${migration.from}`);
  } else if (migration.error) {
    log.warn(`Could not bring forward data from ${migration.from}: ${migration.error}`);
  }

  compactStorage();

  /*
   * A login-item launch stays in the tray.
   *
   * The window is still built — the clipboard poller, the quick-paste overlay
   * and everything the renderer drives all live in it — it simply never shows
   * itself. What people ask for when they ask for "start with Windows" is the
   * app running, not the app in their face at every boot.
   */
  const hiddenStart = startedHidden() && getSettings().launchMinimized;
  mainWindow = createWindow({ show: !hiddenStart });
  setupTray();
  setupQuickPaste();

  if (hiddenStart) {
    log.info('Started at login; staying in the tray');
  }

  // A link that launched the app arrives on this process's own command line.
  pendingDeepLink = pendingDeepLink ?? deepLinkFromArgv(process.argv);

  // Left off last time means still off now; the switch survives a restart.
  if (getSettings().online) {
    startUdpService();
    startTcpService();
    reconnectRememberedPeers();
  } else {
    log.info('Starting with Campus Connect switched off');
  }

  updater = new Updater({
    onStatus: (status) => {
      emit('update:status', status);
      sendStateToRenderer();

      if (status.state === 'ready' && status.availableVersion) {
        notify(
          `Version ${status.availableVersion} is ready`,
          'Restart Campus Connect to finish updating. Both machines need the same version to talk to each other.'
        );
      }
    }
  });
  updater.start(getSettings().autoUpdate);

  nativeTheme.on('updated', () => sendStateToRenderer());

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
    }
  });
});

app.on('before-quit', () => {
  isQuiting = true;
  // Say goodbye while the socket is still open, or the room is left staring at
  // a participant that is never coming back.
  phoneServer?.stop();
  endRemoteSession('', true);
  endLocalCall(true);
  historyManager.flush();
  directMessages.flush();
  persist('peers');
  stopUdpService();
  quickPaste?.destroy();
  quickPaste = null;
  callWindow?.destroy();
  callWindow = null;
  remoteWindow?.destroy();
  remoteWindow = null;
  hostIndicator?.destroy();
  hostIndicator = null;
  tray?.destroy();
  tray = null;
  log.info('Shutting down Campus Connect');
});

app.on('window-all-closed', () => {
  // Intentionally empty: the app lives in the tray.
});

// --- IPC ---------------------------------------------------------------------

type JoinResultEvent = { roomId: string; ok: boolean; message: string };

function updateSettings(patch: Partial<AppSettings>): AppState {
  const next = { ...getSettings(), ...patch };
  // Clamp rather than reject, so a bad value can never make the UI unreadable.
  next.fontScale = Math.min(MAX_FONT_SCALE, Math.max(MIN_FONT_SCALE, Number(next.fontScale) || 1));
  write('settings', next);

  if (patch.autoUpdate !== undefined) {
    updater?.setEnabled(patch.autoUpdate);
  }
  if (patch.online !== undefined) {
    setNetworkEnabled(patch.online);
  }
  if (patch.launchAtLogin !== undefined || patch.launchMinimized !== undefined) {
    applyLaunchSettings();
  }
  if (patch.quickPasteShortcut !== undefined) {
    const problem = quickPaste?.setShortcut(next.quickPasteShortcut) ?? '';
    sendStatus(
      problem || (next.quickPasteShortcut ? `Quick paste is on ${next.quickPasteShortcut}.` : 'Quick paste shortcut removed.'),
      problem ? 'error' : 'success'
    );
  }
  refreshTrayMenu();
  sendStateToRenderer();
  return getAppState();
}

function ok(message: string): ActionResult {
  return { ok: true, message };
}

function fail(message: string): ActionResult {
  return { ok: false, message };
}

/**
 * Registers a request handler once, reachable two ways.
 *
 * The desktop calls these over Electron IPC; a paired phone calls them over
 * HTTP. Registering both from one place is what keeps them honest — there is a
 * single implementation of "approve this member" or "send this message", with a
 * single set of checks, and no second code path for phones to drift away from.
 *
 * The phone route is additionally gated by an allowlist (`PHONE_METHODS`), so
 * being reachable here does not make something reachable from a phone.
 */
const rpcHandlers = new Map<string, (event: unknown, ...args: any[]) => unknown>();

function handle(channel: string, listener: (event: any, ...args: any[]) => unknown): void {
  rpcHandlers.set(channel, listener);
  ipcMain.handle(channel, listener as never);
}

handle('app:get-state', () => getAppState());

handle('app:update-device-name', (_event, name: string) => {
  write('deviceName', name.trim() || getSystemDeviceName());
  sendStateToRenderer();
  broadcastPresence();
  return getAppState();
});

handle('app:update-settings', (_event, patch: Partial<AppSettings>) => updateSettings(patch));

/**
 * Opens one of the project's own links in the system browser. Restricted to an
 * allowlist so the renderer can never hand the OS an arbitrary URL.
 */
const EXTERNAL_LINKS: readonly string[] = [
  APP_INFO.authorUrl,
  APP_INFO.repositoryUrl,
  APP_INFO.websiteUrl,
  `${APP_INFO.repositoryUrl}/issues`
];

handle('app:open-external', (_event, url: string): ActionResult => {
  if (!EXTERNAL_LINKS.includes(url)) {
    log.warn(`Refused to open an unrecognised URL: ${url}`);
    return fail('That link could not be opened.');
  }

  shell.openExternal(url);
  return ok('Opened in your browser.');
});

/**
 * Opens a link that came out of the clipboard.
 *
 * Separate from the allowlisted handler above, because the set of links here is
 * by definition unknowable — and correspondingly stricter about *scheme*. A
 * clipboard can hold `file://`, `javascript:`, or any custom scheme some other
 * installed application has registered, and "open the thing the user copied"
 * must never become "launch whatever this string happens to name". Only http
 * and https ever leave this function.
 */
handle('app:open-link', (_event, url: string): ActionResult => {
  const value = String(url ?? '').trim();

  if (!isOpenableUrl(value)) {
    log.warn(`Refused to open a link that is not http(s): ${value.slice(0, 120)}`);
    return fail('Only http and https links can be opened.');
  }

  shell.openExternal(value);
  return ok('Opened in your browser.');
});

/**
 * Remembers a device reached by IP, so its address only has to be typed once
 * — reconnected to automatically on every future launch. Deduped by
 * host:port; a repeat add just refreshes the name and the "added" stamp
 * rather than creating a second entry.
 */
function rememberPeer(host: string, port: number, name: string): void {
  const remembered = read('rememberedPeers');
  const next: RememberedPeer = { host, port, name: name.trim() || host, addedAt: Date.now() };
  write('rememberedPeers', [next, ...remembered.filter((p) => !(p.host === host && p.port === port))]);
}

/** Reaches out to every device this one has ever been told the address of, so it does not have to be told again. */
function reconnectRememberedPeers(): void {
  for (const remembered of read('rememberedPeers')) {
    tcp?.connect(remembered.host);
    sendUdpMessage(baseMessage('announce'), remembered.host);
  }
}

handle('app:connect-peer', (_event, host: string, port: number, name: string) => {
  if (!getSettings().online) {
    sendStatus('Campus Connect is off. Turn it on from the header first.', 'warning');
    return getAppState();
  }

  const peer: PeerInfo = {
    id: `${host}:${port}`,
    name: name.trim() || host,
    host,
    port,
    lastSeen: Date.now()
  };
  updatePeer(peer);
  rememberPeer(host, port, peer.name);
  // Both transports: TCP for networks that filter UDP, UDP for the rest.
  tcp?.connect(host);
  sendUdpMessage(baseMessage('announce'), host);
  sendStatus(`Reaching out to ${peer.name}`, 'info');
  return getAppState();
});

/** Stops reconnecting to a remembered device. Whatever live connection exists is untouched — this only forgets the address for next time. */
handle('app:forget-peer', (_event, host: string, port: number): AppState => {
  write('rememberedPeers', read('rememberedPeers').filter((p) => !(p.host === host && p.port === port)));
  sendStateToRenderer();
  return getAppState();
});

handle(
  'room:create',
  (_event, name: string, type: RoomType, password: string): ActionResult => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      return fail('Give the room a name.');
    }

    // Private means "approval required", which is only meaningful with a secret.
    if (type === 'private' && password.length < 4) {
      return fail('Private rooms need a password of at least 4 characters.');
    }

    const room = roomManager.createRoom({
      name: trimmedName,
      type,
      password,
      ownerId: deviceId(),
      ownerName: deviceName()
    });

    write('currentRoomId', room.roomId);
    sendUdpMessage({ ...baseMessage('room-advert'), advert: roomManager.toAdvert(room) });
    sendStateToRenderer();
    return ok(
      room.encrypted
        ? `${room.name} created and encrypted. Share the code ${room.joinCode}.`
        : `${room.name} created. Anyone on this network can join.`
    );
  }
);

/**
 * Ask a room's owner to let this device in. Nothing is trusted locally: the
 * device only becomes a member when the owner sends back a signed-off roster.
 */
handle(
  'room:request-join',
  (_event, roomId: string, password: string, joinCode: string): ActionResult => {
    const offline = requireOnline();
    if (offline) {
      return offline;
    }

    const existing = roomManager.getRoom(roomId);
    if (existing && roomManager.isAcceptedMember(roomId, deviceId())) {
      write('currentRoomId', roomId);
      sendStateToRenderer();
      return ok(`Switched to ${existing.name}`);
    }

    const advert = roomManager.getAdvert(roomId);
    const target = advert ?? (existing ? roomManager.toAdvert(existing) : undefined);
    if (!target) {
      return fail('That room is no longer on this network.');
    }

    const code = normalizeJoinCode(joinCode);

    // Either credential is enough. Only an open room needs neither.
    if (target.encrypted && !password && !code) {
      return fail('Enter the room password, or its join code.');
    }
    if (target.type === 'private' && !password && !code) {
      return fail('Enter the join code, or the room password.');
    }

    const message = baseMessage('room-request');
    message.roomId = roomId;

    if (target.encrypted && password) {
      const key = deriveRoomKey(password, target.keySalt);
      // Held provisionally so we can open the owner's reply; cleared on rejection.
      roomManager.setKey(roomId, key);
      message.proof = createProof(key, roomId);
    }

    if (code) {
      message.joinCode = code;
    }

    const host = advert?.host ?? getPeerHost(target.ownerId);
    fanOut(message, host ? [host] : []);

    return ok(
      target.type === 'private'
        ? `Request sent to ${target.ownerName}. Waiting for approval.`
        : `Joining ${target.name}...`
    );
  }
);

/** Join a private room by code alone, without seeing it in the discovered list. */
handle(
  'room:join-by-code',
  (_event, joinCode: string, password: string): ActionResult => {
    const offline = requireOnline();
    if (offline) {
      return offline;
    }

    const code = normalizeJoinCode(joinCode);
    if (!code && !password) {
      return fail('Enter a join code, a room password, or both.');
    }

    if (code) {
      const owned = roomManager.findRoomByCode(code);
      if (owned) {
        write('currentRoomId', owned.roomId);
        sendStateToRenderer();
        return ok(`Switched to ${owned.name}`);
      }
    }

    const discovered = roomManager.getDiscoveredRooms();
    if (discovered.length === 0) {
      return fail('No rooms found on this network yet. Check that both devices are on the same WiFi.');
    }

    /*
     * Only a room's owner can check its credentials, so the request goes to
     * every advertised room and the ones it does not belong to reject it. This
     * is what lets someone join on the password alone: they do not need to know
     * which room it belongs to, only that it is on this network.
     */
    for (const advert of discovered) {
      const message = baseMessage('room-request');
      message.roomId = advert.roomId;

      if (code) {
        message.joinCode = code;
      }

      if (advert.encrypted && password) {
        const key = deriveRoomKey(password, advert.keySalt);
        roomManager.setKey(advert.roomId, key);
        message.proof = createProof(key, advert.roomId);
      }

      sendUdpMessage(message, advert.host);
    }

    return ok('Request sent. Waiting for the room owner.');
  }
);

/**
 * Supply the password for an encrypted room we are already a member of.
 *
 * The derived key is never trusted just because it was typed: a password
 * never leaves a device without going through this app, so the only way to
 * know it is right is to have someone who already holds the correct key say
 * so. That someone is the room's owner, so this waits for their actual
 * `room-accept`/`room-reject` before reporting success — see
 * `handleRoomAccept`/`handleRoomReject` for the other half of this, and
 * `pendingUnlocks`'s comment for what used to go wrong without it.
 */
handle('room:unlock', (_event, roomId: string, password: string): Promise<ActionResult> => {
  const room = roomManager.getRoom(roomId);
  if (!room) {
    return Promise.resolve(fail('Room not found.'));
  }
  if (!room.encrypted) {
    return Promise.resolve(ok('This room is not encrypted.'));
  }

  const key = deriveRoomKey(password, room.keySalt);

  // The owner already holds the room's real key by definition — there is
  // nobody else to ask, and nothing to verify against.
  if (room.ownerId === deviceId()) {
    roomManager.setKey(roomId, key);
    sendStateToRenderer();
    return Promise.resolve(ok(`${room.name} unlocked.`));
  }

  /*
   * Held provisionally: needed right now to build the proof below and, if
   * accepted, to open the owner's sealed roster reply. Not yet trusted as
   * correct — `handleRoomReject` drops it again if the owner says it did
   * not match, and until one or the other arrives this promise stays open.
   */
  roomManager.setKey(roomId, key);

  const request = baseMessage('room-request');
  request.roomId = roomId;
  request.proof = createProof(key, roomId);
  const host = getPeerHost(room.ownerId);
  fanOut(request, host ? [host] : []);

  return new Promise<ActionResult>((resolve) => {
    const timer = setTimeout(() => {
      pendingUnlocks.delete(roomId);
      /*
       * Neither confirmed nor refused — most likely the owner is simply
       * offline right now. The key is not dropped on a timeout alone: doing
       * that would re-lock a room over a *correct* password just because
       * nobody was around to confirm it. The room stays usable and the
       * roster catches up normally once the owner is next reachable.
       */
      resolve(ok(`${room.name} unlocked. Waiting to confirm with ${room.ownerName} once they're back online.`));
    }, UNLOCK_CONFIRM_TIMEOUT_MS);
    timer.unref?.();

    pendingUnlocks.set(roomId, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
});

/**
 * A scannable version of the join code. Rendered dark-on-white regardless of
 * theme, because that is what scanners expect. The password is deliberately
 * not included — a QR code is something you hold up in a room full of people.
 */
handle('room:qr-code', async (_event, roomId: string): Promise<string | null> => {
  const room = roomManager.getRoom(roomId);
  if (!room?.joinCode) {
    return null;
  }

  const uri = `campusconnect://join?code=${room.joinCode}&room=${encodeURIComponent(room.name)}`;

  try {
    return await QRCode.toDataURL(uri, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 320,
      color: { dark: '#18181b', light: '#ffffff' }
    });
  } catch (error) {
    log.warn(`Could not render a QR code: ${(error as Error).message}`);
    return null;
  }
});

/**
 * Invite a device seen on the network. The invitation carries only what the
 * room advert already publishes — never the join code, never the password —
 * so it is safe even though it travels the same broadcast as everything else.
 */
handle('room:invite', (_event, roomId: string, targetDeviceId: string): ActionResult => {
  const offline = requireOnline();
  if (offline) {
    return offline;
  }

  const room = roomManager.getRoom(roomId);
  if (!room) {
    return fail('Room not found.');
  }
  if (room.ownerId !== deviceId()) {
    return fail('Only the room owner can invite devices.');
  }
  if (roomManager.isAcceptedMember(roomId, targetDeviceId)) {
    return fail('That device is already in this room.');
  }

  const peer = read('peers').find((candidate) => candidate.id === targetDeviceId);
  if (!peer) {
    return fail('That device is no longer on the network.');
  }

  const message = baseMessage('room-invite');
  message.roomId = roomId;
  message.targetDeviceId = targetDeviceId;
  message.advert = roomManager.toAdvert(room);

  // Unicast, not broadcast: the room advert is public anyway, but there is no
  // reason to tell the whole network who is being invited to what.
  recordSentInvite(roomId, targetDeviceId);
  sendUdpMessage(message, peer.host);
  sendStateToRenderer();

  return ok(`Invited ${peer.name} to ${room.name}.`);
});

/** Answer an invitation. Accepting only puts you in the owner's queue. */
handle('room:respond-invite', (_event, roomId: string, accept: boolean): ActionResult => {
  const offline = requireOnline();
  if (offline) {
    return offline;
  }

  const invite = receivedInvites.get(roomId);
  if (!invite) {
    return fail('That invitation has expired.');
  }

  receivedInvites.delete(roomId);

  const message = baseMessage(accept ? 'room-invite-accept' : 'room-invite-decline');
  message.roomId = roomId;
  const host = getPeerHost(invite.ownerId);
  fanOut(message, host ? [host] : []);

  sendStateToRenderer();

  if (!accept) {
    return ok(`Declined the invitation to ${invite.roomName}.`);
  }

  return ok(
    invite.encrypted
      ? `Accepted. ${invite.ownerName} still has to approve you, and you will need the room password to read it.`
      : `Accepted. Waiting for ${invite.ownerName} to approve you.`
  );
});

handle('room:switch', (_event, roomId: string): ActionResult => {
  const room = roomManager.getRoom(roomId);
  if (!room) {
    return fail('Room not found.');
  }

  write('currentRoomId', roomId);
  sendStateToRenderer();
  return ok(`Now sharing to ${room.name}`);
});

/*
 * Every roster edit below is blocked while offline.
 *
 * The edit itself is local and would succeed, but the half that makes it mean
 * anything — the accept/reject packet to the device concerned, and the roster
 * broadcast that carries the change to everyone else — is fire-and-forget over
 * a socket that is not open. The owner would see a member approved, and the
 * member would see nothing at all, with no retry to close the gap. Refusing
 * outright is the honest answer: it keeps the owner's copy of the roster and
 * everyone else's from silently disagreeing.
 */
handle('room:approve-member', (_event, roomId: string, memberId: string): ActionResult => {
  const offline = requireOnline();
  if (offline) {
    return offline;
  }
  if (!roomManager.isOwner(roomId, deviceId())) {
    return fail('Only the room owner can approve members.');
  }

  const room = roomManager.approveMember(roomId, memberId);
  if (!room) {
    return fail('That request is no longer pending.');
  }

  const member = room.members.find((candidate) => candidate.deviceId === memberId);

  /*
   * Bind the key here, and only here.
   *
   * This is the moment the device has just proved it knows the room password
   * — the strongest evidence about who it is that this protocol ever has.
   * Everything the device sends afterwards is checked against the key
   * recorded now, and the roster carries it to the other members so they
   * agree with the owner rather than with whoever spoke first.
   */
  if (member?.publicKey) {
    deviceRegistry.bind(memberId, member.publicKey);
  }

  fanOut(buildAcceptMessage(room, memberId), memberHosts(roomId));
  broadcastRoster(room);
  sendStateToRenderer();
  return ok(`${member?.deviceName ?? 'Device'} can now use ${room.name}.`);
});

handle('room:reject-member', (_event, roomId: string, memberId: string): ActionResult => {
  const offline = requireOnline();
  if (offline) {
    return offline;
  }
  if (!roomManager.isOwner(roomId, deviceId())) {
    return fail('Only the room owner can decline requests.');
  }

  const room = roomManager.getRoom(roomId);
  const member = room?.members.find((candidate) => candidate.deviceId === memberId);
  roomManager.removeMember(roomId, memberId);

  const rejection = baseMessage('room-reject');
  rejection.roomId = roomId;
  rejection.targetDeviceId = memberId;
  rejection.reason = 'The room owner declined your request.';
  const host = getPeerHost(memberId);
  fanOut(rejection, host ? [host] : []);

  sendStateToRenderer();
  return ok(`Declined ${member?.deviceName ?? 'the request'}.`);
});

handle('room:remove-member', (_event, roomId: string, memberId: string): ActionResult => {
  const offline = requireOnline();
  if (offline) {
    return offline;
  }
  if (!roomManager.isOwner(roomId, deviceId())) {
    return fail('Only the room owner can remove members.');
  }

  const member = roomManager.getMembers(roomId).find((m) => m.deviceId === memberId);
  const room = roomManager.removeMember(roomId, memberId);
  if (!room) {
    return fail('That member could not be removed.');
  }

  /*
   * Removing someone who is driving this screen has to stop them driving it.
   * Membership is checked when a session starts and never again, so without
   * this the removed device keeps its session — and its control — indefinitely.
   * Blocking already did this; being removed from the room did not.
   */
  const session = remoteSessions.current;
  if (session?.peerId === memberId && session.roomId === roomId) {
    endRemoteSession(
      `${member?.deviceName ?? 'That device'} was removed from ${room.name}, so the remote session ended.`,
      true
    );
  }
  remoteSessions.clearDevice(memberId);

  broadcastRoster(room);
  sendStateToRenderer();
  return ok(`${member?.deviceName ?? 'Device'} was removed from ${room.name}.`);
});

/**
 * A lesser tier than a full block — narrows what one member may do in this
 * one room without severing the device network-wide. See `RoomRestrictions`
 * for what each flag covers and `roomManager.setMemberRestrictions` for why
 * this needs no wire message of its own: it rides the existing roster.
 */
handle(
  'room:set-restrictions',
  (_event, roomId: string, memberId: string, restrictions: RoomRestrictions): ActionResult => {
    const offline = requireOnline();
    if (offline) {
      return offline;
    }
    if (!roomManager.isOwner(roomId, deviceId())) {
      return fail('Only the room owner can restrict members.');
    }

    const room = roomManager.setMemberRestrictions(roomId, memberId, restrictions);
    if (!room) {
      return fail('That member could not be restricted.');
    }

    const member = room.members.find((candidate) => candidate.deviceId === memberId);
    broadcastRoster(room);
    sendStateToRenderer();

    const restricted = member?.restricted;
    if (!restricted) {
      return ok(`${member?.deviceName ?? 'Device'} is no longer restricted in ${room.name}.`);
    }
    const what = [
      restricted.chat && 'messages',
      restricted.files && 'files',
      restricted.calls && 'calls',
      restricted.remote && 'screen sharing'
    ].filter(Boolean);
    return ok(`${member?.deviceName ?? 'Device'} is restricted from ${what.join(', ')} in ${room.name}.`);
  }
);

/** Longest a room name may be. Enough to be descriptive, short enough to fit. */
const MAX_ROOM_NAME = 48;

/**
 * Changing a room after it exists — the owner's job, and only the owner's.
 *
 * Name, type and join code are ordinary edits: they go out with the roster,
 * which for an encrypted room is already sealed with the room key, so only
 * members ever see them.
 *
 * The password is different. Setting, changing or clearing it re-keys the room,
 * and every other member is locked out until they enter the new one. That is
 * disruptive by design: a password change that left existing devices reading
 * would be no use for the one thing it is for, which is shutting out a device
 * that should not have been given the old password.
 */
handle('room:update', (_event, roomId: string, patch: RoomUpdate): ActionResult => {
  const offline = requireOnline();
  if (offline) {
    return offline;
  }

  const room = roomManager.getRoom(roomId);
  if (!room) {
    return fail('Room not found.');
  }
  if (room.ownerId !== deviceId()) {
    return fail('Only the room owner can change a room.');
  }
  // Re-keying has to be sealed with the key the room has now, so a room this
  // device cannot read is a room it cannot re-key either.
  if (room.encrypted && !roomManager.getKey(roomId)) {
    return fail(`${room.name} is locked on this device — unlock it before changing it.`);
  }

  const name = patch.name?.trim();
  if (patch.name !== undefined) {
    if (!name) {
      return fail('A room needs a name.');
    }
    if (name.length > MAX_ROOM_NAME) {
      return fail(`Room names are limited to ${MAX_ROOM_NAME} characters.`);
    }
  }

  const changingPassword = patch.password !== undefined;
  const password = typeof patch.password === 'string' ? patch.password : '';
  if (changingPassword && patch.password !== null && !password) {
    return fail('Enter a password, or choose to remove it instead.');
  }

  const previousKey = roomManager.getKey(roomId);
  const wasEncrypted = room.encrypted;

  const next: RoomInfo = {
    ...room,
    name: name ?? room.name,
    type: patch.type ?? room.type,
    joinCode: patch.regenerateJoinCode ? generateJoinCode() : room.joinCode
  };

  if (changingPassword) {
    next.encrypted = password.length > 0;
    // A new salt with every new password, so the same password twice over never
    // produces the same key twice over.
    next.keySalt = next.encrypted ? generateSalt() : room.keySalt;
  }

  roomManager.saveRoom(next);

  if (changingPassword) {
    if (next.encrypted) {
      roomManager.setKey(roomId, deriveRoomKey(password, next.keySalt));
    } else {
      roomManager.dropKey(roomId);
    }

    /*
     * Told under the old key, not the new one. Members learn that the room
     * changed and that their key is stale; they do not learn the new key,
     * because the point is that they have to be given the new password.
     */
    const notice = baseMessage('room-rekey');
    notice.roomId = roomId;
    if (wasEncrypted && previousKey) {
      notice.sealed = sealJson(previousKey, { room: next });
    } else {
      notice.room = next;
    }
    fanOut(notice, memberHosts(roomId));

    // A call cannot survive the room changing its key underneath it.
    endCallsForRoom(roomId);
  } else {
    broadcastRoster(next);
  }

  advertiseOwnedRooms();
  sendStateToRenderer();

  if (changingPassword) {
    return ok(
      next.encrypted
        ? `${next.name} has a new password. Everyone else has to enter it before they can read the room again.`
        : `${next.name} no longer has a password. Anything sent there is now readable by anyone who joins.`
    );
  }

  return ok(patch.regenerateJoinCode ? `${next.name} has a new join code.` : `${next.name} updated.`);
});

handle('room:leave', (_event, roomId: string): ActionResult => {
  const room = roomManager.getRoom(roomId);
  if (!room) {
    return fail('Room not found.');
  }

  const isOwner = room.ownerId === deviceId();
  // Leave the call before leaving the room, while we still hold the key needed
  // to tell anyone.
  if (localCall?.roomId === roomId) {
    endLocalCall(true);
  }

  const message = baseMessage(isOwner ? 'room-closed' : 'room-leave');
  message.roomId = roomId;

  /*
   * The owner will not act on a leave it cannot attribute to somebody holding
   * the room key — see handleRoomLeave. Without this the departure is ignored
   * and the roster keeps a member who has gone.
   */
  if (!isOwner && room.encrypted) {
    const key = roomManager.getKey(roomId);
    if (key) {
      message.proof = createProof(key, roomId);
    }
  }

  fanOut(message, memberHosts(roomId));

  endCallsForRoom(roomId);
  roomManager.deleteRoom(roomId);
  historyManager.clearRoom(roomId);
  if (read('currentRoomId') === roomId) {
    write('currentRoomId', undefined);
  }

  sendStateToRenderer();
  return ok(isOwner ? `${room.name} was closed.` : `You left ${room.name}.`);
});

handle('history:get-clipboard', (_event, roomId?: string) =>
  historyManager.getClipboardHistory(roomId)
);

handle('history:get-chat', (_event, roomId?: string) => historyManager.getChatHistory(roomId));

handle('history:delete-entry', (_event, entryId: string) => {
  const entry = historyManager.getClipboardHistory().find((candidate) => candidate.id === entryId);
  historyManager.deleteClipboardEntry(entryId);
  if (entry) {
    notifyHistoryChanged(entry.roomId);
  }
  return ok('Removed from history.');
});

handle('history:toggle-pin', (_event, entryId: string): ActionResult => {
  const entry = historyManager.getClipboardHistory().find((candidate) => candidate.id === entryId);
  const pinned = historyManager.togglePin(entryId);
  if (pinned === undefined) {
    return fail('That item is no longer in history.');
  }

  if (entry) {
    notifyHistoryChanged(entry.roomId);
  }
  return ok(pinned ? 'Pinned — it will not be cleared out.' : 'Unpinned.');
});

/**
 * Bookmarks a chat message on this device.
 *
 * Nothing crosses the wire, deliberately: a pin is a note to yourself about
 * where something useful is — the same thing pinning a clipboard entry means —
 * not a claim about the conversation the whole room has to agree with. That is
 * also why there is no ownership check: any message you can see, you can
 * bookmark.
 */
handle('chat:toggle-pin', (_event, messageId: string): ActionResult => {
  const message = historyManager.findChatMessage(messageId);
  const pinned = historyManager.toggleChatPin(messageId);
  if (pinned === undefined) {
    return fail('That message is no longer in history.');
  }

  if (message) {
    notifyChatChanged(message.roomId);
  }
  return ok(pinned ? 'Pinned — it will not be cleared out.' : 'Unpinned.');
});

handle('dm:toggle-pin', (_event, peerId: string, messageId: string): ActionResult => {
  const updated = directMessages.togglePin(peerId, messageId);
  if (!updated) {
    return fail('That message is no longer in this thread.');
  }

  emit('dm:message', updated);
  return ok(updated.pinned ? 'Pinned — it will not be cleared out.' : 'Unpinned.');
});

handle('history:clear-room', (_event, roomId: string) => {
  historyManager.clearRoom(roomId);
  notifyHistoryChanged(roomId);
  return ok('History cleared for this room.');
});

/**
 * What a reply quotes, built here rather than taken from the renderer so it
 * always matches a message that genuinely exists in this room.
 */
function buildReplyTo(messageId: string | undefined, roomId: string): ChatReplyTo | undefined {
  if (!messageId) {
    return undefined;
  }

  const target = historyManager.findChatMessage(messageId);
  if (!target || target.roomId !== roomId || target.deleted) {
    return undefined;
  }

  const preview =
    target.type === 'text' ? target.content : (target.fileName ?? 'Attachment');

  return {
    messageId: target.id,
    deviceName: target.deviceName,
    preview: truncateForNotice(preview)
  };
}

/**
 * Who a message names with `@`, resolved against a room's accepted roster.
 *
 * Never trusted from the wire. A sender's own list of ids would let a modified
 * client light up anyone's mention badge at will, and would go stale the moment
 * a member was renamed; re-resolving costs a string scan and cannot lie.
 */
function mentionsIn(content: string, room: RoomInfo): string[] | undefined {
  if (!content.includes('@')) {
    return undefined;
  }
  const ids = mentionedDeviceIds(content, roomManager.getMembers(room.roomId, 'accepted'));
  return ids.length > 0 ? ids : undefined;
}

/** Shared by text messages and file sends. */
function postChatMessage(
  room: RoomInfo,
  input: {
    type: ChatMessage['type'];
    content: string;
    dataUrl?: string;
    fileName?: string;
    fileSize?: number;
    replyTo?: ChatReplyTo;
  }
): ActionResult {
  // An attachment that arrived already encoded — forwarded, or pasted — never
  // passed the `stat` check `chat:send-file` does, so it is measured here.
  if (input.dataUrl) {
    const bytes = input.fileSize ?? dataUrlBytes(input.dataUrl);
    const tooLarge = refuseIfTooLarge(bytes);
    if (tooLarge) {
      return tooLarge;
    }
    input = { ...input, fileSize: bytes };
  }

  const chatMessage = historyManager.addChatMessage({
    ...input,
    // Resolved here from the room's own roster rather than taken from the
    // composer, so what is stored is what the text actually says about the
    // people actually in the room.
    mentions: mentionsIn(input.type === 'text' ? input.content : '', room),
    deviceId: deviceId(),
    deviceName: deviceName(),
    roomId: room.roomId
  });

  // Receipts are the sender's own bookkeeping; recipients have no business
  // being told who else has received or read a message.
  const { deliveredTo: _d, seenBy: _s, mediaCleared: _m, ...onTheWire } = chatMessage;

  const message = baseMessage('chat');
  message.roomId = room.roomId;
  if (!attachRoomBody(message, room, { chatMessage: onTheWire })) {
    return fail(`${room.name} is locked on this device — unlock it first.`);
  }

  if (!deliverToRoom(message, room.roomId)) {
    return fail('That was too large to send.');
  }

  emit('chat:message', chatMessage);
  return ok('Sent');
}

/** Shared guard for anything that writes into a room. */
function requireWritableRoom(roomId: string): RoomInfo | ActionResult {
  const offline = requireOnline();
  if (offline) {
    return offline;
  }

  const room = roomManager.getRoom(roomId);
  if (!room) {
    return fail('Join a room before sending messages.');
  }
  if (!roomManager.isAcceptedMember(roomId, deviceId())) {
    return fail('You are not an approved member of this room yet.');
  }
  if (roomManager.isLocked(roomId)) {
    return fail(`${room.name} is locked on this device — unlock it first.`);
  }
  /*
   * Checked here rather than only on the inbound side, so a restricted
   * member is told clearly why nothing happened instead of typing into a
   * composer that quietly does nothing — the same reasoning `isBlocked`'s
   * single choke point follows, just for a narrower, per-room restriction.
   */
  if (roomManager.getRestrictions(roomId, deviceId())?.chat) {
    return fail(`You've been restricted from sending messages in ${room.name}.`);
  }
  return room;
}

/** The files-specific half of the same restriction — checked separately, since a member can be restricted from files without being restricted from text. */
function requireUnrestrictedFiles(roomId: string, roomName: string): ActionResult | null {
  if (roomManager.getRestrictions(roomId, deviceId())?.files) {
    return fail(`You've been restricted from sending files in ${roomName}.`);
  }
  return null;
}

/** The calls-specific half of the same restriction. */
function requireUnrestrictedCalls(roomId: string, roomName: string): ActionResult | null {
  if (roomManager.getRestrictions(roomId, deviceId())?.calls) {
    return fail(`You've been restricted from calls in ${roomName}.`);
  }
  return null;
}

/**
 * The screen-sharing half. Separate from `calls` on purpose: watching and
 * driving somebody's desktop is a strictly larger ask than talking to them,
 * so a room owner needs to be able to withdraw it without also ending calls.
 */
function requireUnrestrictedRemote(roomId: string, roomName: string): ActionResult | null {
  if (roomManager.getRestrictions(roomId, deviceId())?.remote) {
    return fail(`You've been restricted from screen sharing in ${roomName}.`);
  }
  return null;
}

function isActionResult<T extends object>(value: T | ActionResult): value is ActionResult {
  return 'ok' in value;
}

handle(
  'chat:send',
  (
    _event,
    type: ChatMessage['type'],
    content: string,
    roomId: string,
    dataUrl?: string,
    fileName?: string,
    replyToId?: string
  ): ActionResult => {
    const room = requireWritableRoom(roomId);
    if (isActionResult(room)) {
      return room;
    }
    if (type !== 'text') {
      const restricted = requireUnrestrictedFiles(roomId, room.name);
      if (restricted) {
        return restricted;
      }
    }

    return postChatMessage(room, {
      type,
      content,
      dataUrl,
      fileName,
      replyTo: buildReplyTo(replyToId, roomId)
    });
  }
);

/** Sends an amendment — an edit, a withdrawal, a reaction — to a room. */
function sendChatChange(room: RoomInfo, type: WireMessage['type'], body: Partial<WireMessage>): void {
  const message = baseMessage(type);
  message.roomId = room.roomId;
  if (attachRoomBody(message, room, body)) {
    deliverToRoom(message, room.roomId);
  }
}

/** The room a message belongs to, if it can still be written to. */
function roomForMessage(messageId: string): { message: ChatMessage; room: RoomInfo } | ActionResult {
  const message = historyManager.findChatMessage(messageId);
  if (!message) {
    return fail('That message is no longer in history.');
  }

  const room = requireWritableRoom(message.roomId);
  return isActionResult(room) ? room : { message, room };
}

handle('chat:edit', (_event, messageId: string, content: string): ActionResult => {
  const text = content.trim();
  if (!text) {
    return fail('An edited message cannot be empty — delete it instead.');
  }

  const found = roomForMessage(messageId);
  if (isActionResult(found)) {
    return found;
  }
  if (found.message.deviceId !== deviceId()) {
    return fail('You can only edit your own messages.');
  }

  const editedAt = Date.now();
  if (!historyManager.editChatMessage(messageId, text, deviceId(), editedAt, mentionsIn(text, found.room))) {
    return fail('That message cannot be edited.');
  }

  sendChatChange(found.room, 'chat-edit', { chatEdit: { messageId, content: text, editedAt } });
  notifyChatChanged(found.room.roomId);
  return ok('Message edited.');
});

/**
 * Deleting for everyone withdraws the message from the room; deleting without
 * it only clears this device, which stays available even when the app is
 * switched off, because it touches nothing but local history.
 */
handle('chat:delete', (_event, messageId: string, forEveryone: boolean): ActionResult => {
  const existing = historyManager.findChatMessage(messageId);
  if (!existing) {
    return fail('That message is no longer in history.');
  }

  if (!forEveryone) {
    historyManager.deleteChatMessage(messageId);
    notifyChatChanged(existing.roomId);
    return ok('Deleted from this device.');
  }

  if (existing.deviceId !== deviceId()) {
    return fail('You can only delete your own messages for everyone.');
  }

  const found = roomForMessage(messageId);
  if (isActionResult(found)) {
    return found;
  }

  historyManager.markChatMessageDeleted(messageId, deviceId());
  sendChatChange(found.room, 'chat-delete', { chatDelete: { messageId } });
  notifyChatChanged(found.room.roomId);
  return ok('Deleted for everyone.');
});

/** Toggles this device's reaction to a message. */
handle('chat:react', (_event, messageId: string, emoji: string): ActionResult => {
  const found = roomForMessage(messageId);
  if (isActionResult(found)) {
    return found;
  }

  const on = !found.message.reactions?.[emoji]?.includes(deviceId());
  if (!historyManager.setChatReaction(messageId, emoji, deviceId(), on)) {
    return fail('That reaction could not be applied.');
  }

  sendChatChange(found.room, 'chat-reaction', { chatReaction: { messageId, emoji, on } });
  notifyChatChanged(found.room.roomId);
  return ok(on ? 'Reacted.' : 'Reaction removed.');
});

/**
 * Says whether this device is composing. Sent rather than stored, and quietly
 * dropped when there is no room to send it to — a typing indicator is never
 * worth an error message.
 */
handle('chat:typing', (_event, roomId: string, typing: boolean): void => {
  const room = roomManager.getRoom(roomId);
  if (!room || !getSettings().online || roomManager.isLocked(roomId)) {
    return;
  }
  if (!roomManager.isAcceptedMember(roomId, deviceId())) {
    return;
  }

  sendChatChange(room, 'chat-typing', { typing });
});

/** Pick a file with the native dialog and send it into the room. */
handle('chat:send-file', async (_event, roomId: string): Promise<ActionResult> => {
  const room = requireWritableRoom(roomId);
  if (isActionResult(room)) {
    return room;
  }
  const restricted = requireUnrestrictedFiles(roomId, room.name);
  if (restricted) {
    return restricted;
  }
  if (!mainWindow) {
    return fail('No window available.');
  }

  const picked = await dialog.showOpenDialog(mainWindow, {
    title: `Send a file to ${room.name}`,
    buttonLabel: 'Send',
    properties: ['openFile']
  });

  if (picked.canceled || picked.filePaths.length === 0) {
    return ok('Cancelled.');
  }

  const filePath = picked.filePaths[0];

  let stats;
  try {
    stats = await fs.stat(filePath);
  } catch {
    return fail('That file could not be read.');
  }

  if (!stats.isFile()) {
    return fail('That is not a file.');
  }
  const tooLarge = refuseIfTooLarge(stats.size);
  if (tooLarge) {
    return tooLarge;
  }

  let buffer: Buffer;
  try {
    buffer = await fs.readFile(filePath);
  } catch {
    return fail('That file could not be read.');
  }

  const fileName = path.basename(filePath);
  const mime = mimeForFile(fileName);
  const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;

  return postChatMessage(room, {
    // Images go as 'image' so the far side can preview them inline.
    type: mime.startsWith('image/') ? 'image' : 'file',
    content: fileName,
    dataUrl,
    fileName,
    fileSize: stats.size
  });
});

/**
 * Write a received file wherever the user chooses. Deliberately never opens it
 * — running something that arrived over the network is the user's decision.
 */
handle('chat:save-file', async (_event, messageId: string): Promise<ActionResult> => {
  const message = historyManager.getChatHistory().find((candidate) => candidate.id === messageId);
  if (!message) {
    return fail('That message is no longer in history.');
  }
  if (!message.dataUrl) {
    return fail('That file was not kept after the app restarted. Ask for it again.');
  }
  if (!mainWindow) {
    return fail('No window available.');
  }

  const picked = await dialog.showSaveDialog(mainWindow, {
    title: 'Save file',
    defaultPath: message.fileName || 'shared-file'
  });

  if (picked.canceled || !picked.filePath) {
    return ok('Cancelled.');
  }

  const base64 = message.dataUrl.slice(message.dataUrl.indexOf(',') + 1);
  try {
    await fs.writeFile(picked.filePath, Buffer.from(base64, 'base64'));
  } catch (error) {
    return fail(`Could not save: ${(error as Error).message}`);
  }

  return ok(`Saved as ${path.basename(picked.filePath)}.`);
});

/**
 * Writes a conversation out as a text file.
 *
 * Deliberately not a backup: attachments are named, not written, and nothing
 * here reads back into the app. What this is for is keeping a record — pasting
 * a decision into a ticket, or holding on to what was agreed after leaving a
 * room. Shared with the DM export below, which differs only in where it reads
 * the messages from and what it calls the conversation.
 */
async function exportTranscript(title: string, entries: TranscriptEntry[]): Promise<ActionResult> {
  if (!mainWindow) {
    return fail('No window available.');
  }
  if (entries.length === 0) {
    return fail('There is nothing to export yet.');
  }

  const exportedAt = Date.now();
  const picked = await dialog.showSaveDialog(mainWindow, {
    title: `Export ${title}`,
    defaultPath: transcriptFileName(title, exportedAt),
    filters: [{ name: 'Text file', extensions: ['txt'] }]
  });

  if (picked.canceled || !picked.filePath) {
    return ok('Cancelled.');
  }

  try {
    await fs.writeFile(picked.filePath, formatTranscript(entries, { title, exportedAt }), 'utf8');
  } catch (error) {
    return fail(`Could not save: ${(error as Error).message}`);
  }

  return ok(`Exported ${entries.length} messages to ${path.basename(picked.filePath)}.`);
}

handle('history:export', async (_event, roomId: string): Promise<ActionResult> => {
  const room = roomManager.getRoom(roomId);
  if (!room) {
    return fail('Room not found.');
  }
  if (roomManager.isLocked(roomId)) {
    return fail(`${room.name} is locked on this device — unlock it first.`);
  }

  return exportTranscript(
    room.name,
    historyManager.getChatHistory(roomId).map((message) => ({
      timestamp: message.timestamp,
      // The name stored on the message, not the roster's current one: a
      // transcript should say who sent it, not who they are called today.
      author: message.deviceId === deviceId() ? `${message.deviceName} (you)` : message.deviceName,
      type: message.type,
      content: message.content,
      fileName: message.fileName,
      deleted: message.deleted,
      editedAt: message.editedAt
    }))
  );
});

handle('dm:export', async (_event, peerId: string): Promise<ActionResult> => {
  const thread = directMessages.getThread(peerId);
  const peerName = thread.find((message) => !message.fromSelf)?.peerName ?? peerId;

  return exportTranscript(
    peerName,
    thread.map((message) => ({
      timestamp: message.sentAt,
      author: message.fromSelf ? `${deviceName()} (you)` : message.peerName,
      type: message.type,
      content: message.content,
      fileName: message.fileName,
      deleted: message.deleted,
      editedAt: message.editedAt
    }))
  );
});

/** The chat for this room is on screen, so acknowledge everything in it. */
handle('chat:mark-seen', (_event, roomId: string): ActionResult => {
  const room = roomManager.getRoom(roomId);
  if (!room) {
    return fail('Room not found.');
  }

  const bySender = new Map<string, string[]>();
  for (const chatMessage of historyManager.getChatHistory(roomId)) {
    if (chatMessage.deviceId === deviceId()) {
      continue;
    }
    bySender.set(chatMessage.deviceId, [...(bySender.get(chatMessage.deviceId) ?? []), chatMessage.id]);
  }

  for (const [senderId, ids] of bySender) {
    sendReceipt(senderId, roomId, ids, 'seen');
  }

  return ok('Marked as seen.');
});

// --- phone access ------------------------------------------------------------

/**
 * Serving one room to a phone browser on the same network.
 *
 * The honest framing: a phone cannot hold the room key, so everything it is
 * shown has already been decrypted here. That is why this is opt-in, one room at
 * a time, PIN-gated, and never on by default — and why the interface says so
 * rather than leaving it to be discovered.
 */
function phoneAccessState(): PhoneAccess {
  const sessions = phoneServer?.sessions;
  const active = Boolean(phoneServer?.running && sessions?.isOpen);

  return {
    active,
    url: active ? `https://${getLocalIpAddress()}:${PHONE_PORT}` : '',
    /*
     * The pairing key is deliberately not exposed as text anywhere. It only ever
     * leaves this process inside the QR image below, which is what makes
     * "scanning is the only way in" true rather than merely encouraged.
     */
    pairUrl: active
      ? `https://${getLocalIpAddress()}:${PHONE_PORT}/?k=${sessions?.currentKey ?? ''}`
      : '',
    clients: sessions?.list() ?? [],
    lockedUntil: sessions?.lockedOutUntil ?? 0
  };
}

/** Formats an entry for the phone, which wants text and not much else. */
function toPhoneItem(item: {
  text: string;
  deviceId: string;
  deviceName: string;
  timestamp: number;
  kind?: string;
}) {
  return {
    text: item.text,
    who: item.deviceId === deviceId() ? 'You' : item.deviceName,
    when: new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    kind: item.kind ?? '',
    mine: item.deviceId === deviceId()
  };
}

async function startPhoneAccess(): Promise<ActionResult> {
  const offline = requireOnline();
  if (offline) {
    return offline;
  }

  if (!phoneServer) {
    phoneServer = new PhoneServer(
      {
        /*
         * One method, run exactly as the desktop would run it. The deny list in
         * phoneServer decides what may get here; there is nothing else in the
         * way, because a paired phone is the same person at the same laptop.
         */
        call: async (method: string, args: unknown[]) => {
          const listener = rpcHandlers.get(method);
          if (!listener) {
            throw new Error(`No handler for ${method}`);
          }
          return await listener(null, ...args);
        },

        rendererRoot: () => path.join(__dirname, '../renderer'),
        onClientsChanged: () => sendStateToRenderer()
      },
      {
        read: () => read('phonePairings'),
        write: (pairings) => write('phonePairings', pairings)
      }
    );
  }

  /*
   * A certificate turns the phone into a secure origin, which is the only way a
   * browser will hand it a microphone — and it stops the phone's token and every
   * message it reads crossing the WiFi in clear text. Issued for the addresses
   * this machine actually answers on, since a browser checks those and rejects
   * anything else outright. Always done now — there is no plain-HTTP path left
   * to fall back to.
   */
  let tls: PhoneTls;
  try {
    /*
     * Every address this machine answers on, not just the preferred one.
     * A laptop on WiFi and Ethernet at once has two, and a phone that
     * reaches it by the other gets a certificate that does not name the
     * address it dialled — which browsers reject outright.
     */
    const addresses = currentInterfaces()
      .map((entry) => entry.address)
      .filter((address) => address && !address.includes(':'));
    const certificate = await ensurePhoneCertificate(app.getPath('userData'), [
      getLocalIpAddress(),
      ...addresses
    ]);
    tls = { key: certificate.key, cert: certificate.cert };
  } catch (error) {
    log.warn(`Could not prepare the phone certificate: ${(error as Error).message}`);
    return fail('A certificate for phone access could not be created, so it was not started.');
  }

  phoneServer.start(tls);
  phoneServer.sessions.open();
  sendStateToRenderer();

  return ok('Phone access is on. Scan the code, then accept the certificate warning once.');
}

handle('phone:start', (): Promise<ActionResult> => startPhoneAccess());

/**
 * The phone's own clipboard, straight to and from this machine.
 *
 * Deliberately **not** through the room. Copying a password or a one-time code
 * between your own two devices is the commonest thing anyone wants this app for,
 * and routing it through a room would broadcast it to everybody else in that
 * room. These two go nowhere but here.
 */
handle('phone:pull-clipboard', (): { text: string } => ({ text: readClipboardText() }));

handle('phone:push-clipboard', (_event, text: string): ActionResult => {
  const value = String(text ?? '');
  if (!value.trim()) {
    return fail('Nothing to send.');
  }

  lastClipboardImageFingerprint = '';
  writeClipboardText(value);

  /*
   * The poller must not see this as a fresh local copy and share it with the
   * room — which would undo the whole point of a private channel.
   */
  const hash = hashClipboardPayload({
    kind: 'text',
    text: value,
    sourceId: deviceId(),
    sourceName: deviceName(),
    timestamp: Date.now()
  });
  lastLocalClipboardHash = hash;
  lastRemoteClipboardHash = hash;

  return ok('Sent to this computer. Press Ctrl+V there.');
});

handle('phone:stop', (): ActionResult => {
  if (!phoneServer?.running) {
    return ok('Phone access is already off.');
  }

  phoneServer.stop();
  sendStateToRenderer();
  return ok('Phone access is off. Any connected phone has been cut off.');
});

handle('phone:revoke', (_event, pairedAt: number): ActionResult => {
  if (!phoneServer?.sessions.unpair(pairedAt)) {
    return fail('That phone is not paired.');
  }

  sendStateToRenderer();
  return ok('That phone is unpaired. It has to enter the PIN again to come back.');
});

/** A scannable version of the address, so nobody has to type an IP on a phone. */
handle('phone:qr-code', async (): Promise<string | null> => {
  const state = phoneAccessState();
  if (!state.active) {
    return null;
  }

  try {
    return await QRCode.toDataURL(state.pairUrl, { errorCorrectionLevel: 'M', margin: 1, width: 320 });
  } catch (error) {
    log.warn(`Could not build the phone QR code: ${(error as Error).message}`);
    return null;
  }
});

// --- productivity IPC --------------------------------------------------------

/**
 * The overlay asking for what to show. Also called when it is already open and
 * something changed underneath it.
 */
handle('quick-paste:items', () => quickPasteItems());

/**
 * Something was picked from the overlay.
 *
 * The clipboard write happens here, synchronously, before the window is hidden —
 * so by the time focus has gone back to the other application the content is
 * already there waiting for the paste keystroke.
 */
handle('quick-paste:pick', (_event, kind: 'clip' | 'snippet', id: string): ActionResult => {
  let text = '';
  let isImage = false;

  if (kind === 'snippet') {
    const snippet = snippetManager.markUsed(id);
    if (!snippet) {
      return fail('That snippet is gone.');
    }
    text = snippet.content;
  } else {
    const entry = historyManager.getClipboardHistory().find((candidate) => candidate.id === id);
    if (!entry) {
      return fail('That item is no longer in history.');
    }

    if (entry.kind === 'image' && entry.dataUrl) {
      lastClipboardImageFingerprint = writeClipboardImage(entry.dataUrl) ?? '';
      isImage = true;
    } else {
      text = entry.text;
    }
  }

  if (!isImage) {
    lastClipboardImageFingerprint = '';
    writeClipboardText(text);
  }

  /*
   * The poller must not treat this as a fresh copy and re-share it. Without
   * this, using the overlay would rebroadcast an old item to the room every
   * time — which is both noise and, for something copied in a different room,
   * a leak.
   */
  const hash = hashClipboardPayload({
    kind: isImage ? 'image' : 'text',
    text,
    sourceId: deviceId(),
    sourceName: deviceName(),
    timestamp: Date.now()
  });
  lastLocalClipboardHash = hash;
  lastRemoteClipboardHash = hash;

  if (getSettings().quickPasteAutoPaste) {
    quickPaste?.pasteAndHide();
  } else {
    quickPaste?.hide();
  }

  sendStateToRenderer();
  return ok('Copied.');
});

handle('quick-paste:close', () => quickPaste?.hide());

handle('snippet:save', (_event, input: { id?: string; label: string; content: string }): ActionResult => {
  const snippet = snippetManager.save(input);
  if (!snippet) {
    return fail('A snippet needs some content.');
  }

  sendStateToRenderer();
  quickPaste?.send('quick-paste:opened', quickPasteItems());
  return ok(input.id ? 'Snippet updated.' : `Saved "${snippetLabel(snippet)}".`);
});

handle('snippet:delete', (_event, id: string): ActionResult => {
  if (!snippetManager.remove(id)) {
    return fail('That snippet is already gone.');
  }

  sendStateToRenderer();
  quickPaste?.send('quick-paste:opened', quickPasteItems());
  return ok('Snippet deleted.');
});

/** Puts a snippet on this machine's clipboard without going through the overlay. */
handle('snippet:copy', (_event, id: string): ActionResult => {
  const snippet = snippetManager.markUsed(id);
  if (!snippet) {
    return fail('That snippet is gone.');
  }

  lastClipboardImageFingerprint = '';
  writeClipboardText(snippet.content);

  const hash = hashText(`text:${snippet.content}:`);
  lastLocalClipboardHash = hash;
  lastRemoteClipboardHash = hash;

  sendStateToRenderer();
  return ok('Copied — press Ctrl+V to paste.');
});

function snippetLabel(snippet: Snippet): string {
  return snippet.label || truncateForNotice(snippet.content);
}

/**
 * Searching clipboard history and chat across every room at once.
 *
 * Room names are resolved here rather than in the renderer because the room may
 * have been left since the message arrived, and "a room you have left" is a far
 * more useful answer than a bare id.
 */
handle('search:all', (_event, query: string): SearchHit[] => {
  const roomNames = new Map(roomManager.getRooms().map((room) => [room.roomId, room.name]));
  return [...historyManager.search(query, roomNames), ...directMessages.search(query, deviceName())].sort(
    (a, b) => b.timestamp - a.timestamp
  );
});

// --- remote desktop IPC ------------------------------------------------------

/** Asks another device for its screen. Nothing happens until a human agrees. */
handle('remote:request', (_event, roomId: string, targetDeviceId: string): ActionResult => {
  const room = requireWritableRoom(roomId);
  if (isActionResult(room)) {
    return room;
  }

  const restricted = requireUnrestrictedRemote(roomId, room.name);
  if (restricted) {
    return restricted;
  }

  if (remoteSessions.busy) {
    return fail('You are already in a remote session. End it before starting another.');
  }
  if (targetDeviceId === deviceId()) {
    return fail('That is this device.');
  }
  if (!roomManager.isAcceptedMember(roomId, targetDeviceId)) {
    return fail('That device is not a member of this room.');
  }

  const target = roomManager
    .getMembers(roomId, 'accepted')
    .find((member) => member.deviceId === targetDeviceId);

  const sessionId = randomUUID();
  if (!sendRemoteSignal(roomId, { kind: 'request', sessionId, to: targetDeviceId })) {
    return fail('The request could not be sent — that device could not be reached.');
  }

  // Remembered so the answer can be matched back to this ask, and to this
  // device. Anything else claiming to answer it is discarded.
  remoteSessions.noteOutgoingRequest(sessionId, roomId, targetDeviceId);

  return ok(
    `Asked ${target?.deviceName ?? 'that device'} for access. They have to allow it before anything is shared.`
  );
});

/**
 * The host's answer.
 *
 * This is the only path by which a screen starts being shared, and it can only
 * be reached by someone clicking a button on the machine in question. `grant`
 * says whether the far side may only watch or may also drive; `screenId` is the
 * display they chose, because sharing all of them by default is not a decision
 * this app should make on anyone's behalf.
 */
handle(
  'remote:respond',
  (
    _event,
    sessionId: string,
    allow: boolean,
    grant: RemoteGrant,
    screenId: string,
    screenLabel: string,
    displayId?: string
  ): ActionResult => {
    const request = remoteSessions.takeRequest(sessionId);
    if (!request) {
      return fail('That request is no longer waiting.');
    }

    if (!allow) {
      sendRemoteSignal(request.roomId, {
        kind: 'deny',
        sessionId,
        to: request.fromDeviceId,
        reason: `${deviceName()} declined.`
      });
      sendStateToRenderer();
      return ok('Declined.');
    }

    const room = requireWritableRoom(request.roomId);
    if (isActionResult(room)) {
      return room;
    }
    // The asker must still be a member. Between asking and being answered they
    // may have been removed, or blocked.
    if (!roomManager.isAcceptedMember(request.roomId, request.fromDeviceId)) {
      return fail('That device is no longer a member of this room.');
    }

    /*
     * Control is only ever granted when this machine can actually deliver it.
     * Promising control and then silently dropping every event — which is what
     * Wayland and an unticked macOS Accessibility box both do — is worse than
     * saying up front that only viewing is available.
     */
    let effectiveGrant: RemoteGrant = grant === 'control' ? 'control' : 'view';
    let note = '';
    if (effectiveGrant === 'control') {
      const capabilities = getRemoteCapabilities(true);
      if (!capabilities.canControl) {
        effectiveGrant = 'view';
        note = ` ${capabilities.reason}`;
      }
    }

    const started = remoteSessions.start({
      sessionId,
      roomId: request.roomId,
      role: 'host',
      peerId: request.fromDeviceId,
      peerName: request.fromDeviceName,
      grant: effectiveGrant,
      screenLabel: screenLabel || 'your screen'
    });
    if (!started) {
      return fail('A remote session is already running.');
    }

    remoteDisplayId = displayId || displayIdFor(screenId);
    if (effectiveGrant === 'control') {
      remoteInjector = createDisplayInjector(remoteDisplayId);
      if (!remoteInjector) {
        remoteSessions.setGrant(sessionId, 'view');
        effectiveGrant = 'view';
        note = ' Control could not be started on this machine, so it is view only.';
      }
    }

    claimPanicShortcut();

    sendRemoteSignal(request.roomId, {
      kind: 'grant',
      sessionId,
      to: request.fromDeviceId,
      grant: effectiveGrant,
      screenLabel: screenLabel || 'a screen'
    });

    emit('remote:started', remoteSessions.current);
    sendStateToRenderer();
    ensureHostIndicator().show();

    return ok(
      `${request.fromDeviceName} can now ${effectiveGrant === 'control' ? 'see and control' : 'see'} ${screenLabel || 'your screen'}.${note}`
    );
  }
);

/** The host taking control back, or handing it over, without ending the session. */
handle('remote:set-grant', (_event, grant: RemoteGrant): ActionResult => {
  const session = remoteSessions.current;
  if (!session || session.role !== 'host') {
    return fail('You are not sharing your screen.');
  }

  const next: RemoteGrant = grant === 'control' ? 'control' : 'view';
  if (next === 'control' && !getRemoteCapabilities(true).canControl) {
    return fail(getRemoteCapabilities().reason);
  }

  remoteSessions.setGrant(session.sessionId, next);

  if (next === 'control') {
    remoteInjector = remoteInjector ?? createDisplayInjector(remoteDisplayId);
  } else {
    // Let go of anything the controller was holding at the moment it lost
    // control, rather than leaving a key down on a machine it can no longer
    // release it from.
    remoteInjector?.releaseAll();
  }

  sendRemoteSignal(session.roomId, {
    kind: 'grant-changed',
    sessionId: session.sessionId,
    to: session.peerId,
    grant: next
  });

  sendStateToRenderer();
  return ok(next === 'control' ? `${session.peerName} now has control.` : 'Control taken back. They can still watch.');
});

handle('remote:end', (): ActionResult => {
  if (!remoteSessions.current) {
    return ok('No remote session is running.');
  }

  endRemoteSession('', true);
  return ok('Remote session ended.');
});

handle('remote:signal', (_event, signal: RemoteSignal): boolean => {
  const session = remoteSessions.current;
  if (!session || !signal?.sessionId || signal.sessionId !== session.sessionId) {
    return false;
  }

  return sendRemoteSignal(session.roomId, { ...signal, to: session.peerId });
});

/**
 * The gate.
 *
 * Every input event from another machine arrives here, and this is the only
 * place that decides whether it happens. `mayInject` requires all of: a live
 * session, this device being the host rather than the controller, the session
 * matching, the sender matching, and control — not merely viewing — being
 * granted. The event is then validated on its own terms before anything moves.
 */
handle('remote:input', (_event, sessionId: string, fromDeviceId: string, raw: unknown): boolean => {
  if (!remoteSessions.mayInject(sessionId, fromDeviceId)) {
    return false;
  }

  const event = parseRemoteInput(raw);
  if (!event || !remoteInjector) {
    return false;
  }

  try {
    return remoteInjector.apply(event);
  } catch (error) {
    log.warn(`Remote input could not be applied: ${(error as Error).message}`);
    return false;
  }
});

/**
 * The screens this machine can offer.
 *
 * Only whole displays, never individual windows. A window can be moved, resized
 * or hidden behind another at any moment, so there is no honest way to map a
 * click on a picture of it back to a point on the desktop — offering it would
 * mean the pointer landing somewhere other than where the controller aimed.
 * Windows remain shareable in a call, where nobody is clicking on them.
 */
handle('remote:screens', async (): Promise<ScreenSource[]> => {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 320, height: 200 },
    fetchWindowIcons: false
  });

  return sources.map((source) => ({
    id: source.id,
    name: source.name,
    kind: 'screen' as const,
    thumbnail: source.thumbnail.toDataURL(),
    displayId: source.display_id
  }));
});

handle('remote:capabilities', (): RemoteCapabilities => getRemoteCapabilities());

/**
 * Tucks the floating "you are being driven" reminder out of the way without
 * ending the session — the host still has `RemoteHostBar` inside the main
 * window for the same information and the same Stop button, so hiding this
 * second, always-on-top copy of it loses nothing.
 */
handle('remote:hide-indicator', (): void => {
  hostIndicator?.hide();
});

/**
 * Claims whatever link brought the app here, if any.
 *
 * Pulled by the renderer once it can act rather than pushed at it the moment it
 * arrives: a link that launched the app is ready long before anything exists to
 * open a dialog. Single-use, so a reload cannot reopen a dialog already dealt
 * with.
 */
handle('app:take-deep-link', (): DeepLink | null => {
  const link = pendingDeepLink;
  pendingDeepLink = null;
  return link;
});

// --- window controls IPC -----------------------------------------------------

/**
 * The buttons in the corner.
 *
 * Close deliberately goes through the window's own `close`, not `destroy`, so
 * it means exactly what the system's close button meant before this replaced
 * it — which for this app is "hide to the tray", not "quit".
 */
handle('window:state', (event): WindowState | null => {
  const window = BrowserWindow.fromWebContents(event.sender);
  return window ? currentWindowState(window) : null;
});

handle('window:minimize', (event): void => {
  BrowserWindow.fromWebContents(event.sender)?.minimize();
});

handle('window:toggle-maximize', (event): void => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) {
    return;
  }
  if (window.isMaximized()) {
    window.unmaximize();
  } else {
    window.maximize();
  }
});

handle('window:close', (event): void => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});

// --- file sharing IPC ------------------------------------------------------------

/**
 * The sender asks a discovered peer whether it will receive files. Nothing is
 * picked yet — the peer accepts the *idea* of a transfer, and only then is a
 * connection opened for files that are actually chosen.
 */
handle('files:request', (_event, peerId: string, peerName: string): ActionResult => {
  const offline = requireOnline();
  if (offline) {
    return offline;
  }
  if (peerId === deviceId()) {
    return fail('You cannot send files to this device.');
  }

  /*
   * Checked here rather than discovered halfway through a file. The link is
   * dialled automatically for every peer we can see, so this normally passes —
   * and when it does not, it is a firewall worth naming up front.
   */
  const host = getPeerHost(peerId);
  if (!host || !tcp?.isConnected(host)) {
    return fail(
      `No direct connection to ${peerName} yet. File transfers need one — check that port ${BROADCAST_PORT} is allowed through the firewall on both machines, then try again in a moment.`
    );
  }

  return fileShares.request(peerId, peerName);
});

/** The receiver's answer to a request. */
handle('files:respond', async (_event, transferId: string, accept: boolean): Promise<ActionResult> => {
  return fileShares.respond(transferId, accept);
});

/**
 * The sender chooses what to send, once the peer has said yes. The dialog is
 * the only place the filesystem is touched on this side; everything after that
 * streams through the manager.
 */
handle('files:pick', async (_event, transferId: string): Promise<ActionResult> => {
  if (!mainWindow) {
    return fail('No window available.');
  }

  const picked = await dialog.showOpenDialog(mainWindow, {
    title: 'Send files',
    buttonLabel: 'Send',
    properties: ['openFile', 'multiSelections']
  });
  if (picked.canceled || picked.filePaths.length === 0) {
    return ok('Cancelled.');
  }

  const files: { path: string; name: string; size: number }[] = [];
  for (const filePath of picked.filePaths) {
    let stats;
    try {
      stats = await fs.stat(filePath);
    } catch {
      return fail('One of the files could not be read.');
    }
    if (!stats.isFile()) {
      continue;
    }
    files.push({ path: filePath, name: path.basename(filePath), size: stats.size });
  }

  if (files.length === 0) {
    return fail('Nothing to send was selected.');
  }
  return fileShares.sendFiles(transferId, files);
});

/** Either side stops a transfer. */
handle('files:cancel', (_event, transferId: string): ActionResult => {
  return fileShares.cancel(transferId);
});

/** Removes a finished transfer from the list. The saved files stay. */
handle('files:dismiss', (_event, transferId: string): void => {
  fileShares.dismiss(transferId);
});

/** Opens the folder received files land in. */
handle('files:open-folder', (): void => {
  const folder = path.join(app.getPath('downloads'), 'Campus Connect');
  void fs.mkdir(folder, { recursive: true }).then(() => {
    void shell.openPath(folder);
  });
});

// --- direct message IPC -------------------------------------------------------

/**
 * Shared guard for anything that writes into a DM thread. Same reach as file
 * sharing: any device currently visible on the network, no room in common
 * required — the trust bar is the one every inbound message already crosses
 * (not blocked, signature verifies).
 */
function requireReachablePeer(peerId: string, peerName: string): ActionResult | null {
  const offline = requireOnline();
  if (offline) {
    return offline;
  }
  if (peerId === deviceId()) {
    return fail('That is this device.');
  }
  /*
   * An explicit gate here, not just the inbound one every received message
   * already crosses. Today a blocked device is also purged from `peers`, so
   * `getPeerHost` below would fail this on its own — but that is a side
   * effect of `privacy:block`'s cleanup, not a guard this handler owns, and
   * nothing should have to remember that connection exists to stay safe.
   */
  if (isBlocked(peerId)) {
    return fail(`${peerName} is blocked.`);
  }
  // Checked before storing, not after — a message nothing could be reached to
  // deliver should not sit in the thread looking sent.
  if (!getPeerHost(peerId)) {
    return fail(`${peerName} is not currently visible on the network.`);
  }
  // Should not happen for anyone already visible in `state.peers` — every
  // message carries a box key — but a clear error here beats a seal that
  // silently fails partway through `postDirectMessage`.
  if (!dmKeyFor(peerId)) {
    return fail(`Still learning ${peerName}'s encryption key — try again in a moment.`);
  }
  return null;
}

/** A reply quote into a direct thread — same shape and reasoning as room chat's `buildReplyTo`. */
function buildDmReplyTo(messageId: string | undefined, peerId: string): ChatReplyTo | undefined {
  if (!messageId) {
    return undefined;
  }

  const target = directMessages.findMessage(peerId, messageId);
  if (!target || target.deleted) {
    return undefined;
  }

  const preview = target.type === 'text' ? target.content : (target.fileName ?? 'Attachment');

  return {
    messageId: target.id,
    deviceName: target.fromSelf ? deviceName() : target.peerName,
    preview: truncateForNotice(preview)
  };
}

/** Shared by text messages and file sends into a direct thread. */
function postDirectMessage(
  peerId: string,
  peerName: string,
  input: {
    type: DirectMessage['type'];
    content: string;
    dataUrl?: string;
    fileName?: string;
    fileSize?: number;
    replyTo?: ChatReplyTo;
  }
): ActionResult {
  // Same reasoning as `postChatMessage` — an already-encoded attachment never
  // passed the `stat` check that `dm:send-file` does.
  if (input.dataUrl) {
    const bytes = input.fileSize ?? dataUrlBytes(input.dataUrl);
    const tooLarge = refuseIfTooLarge(bytes);
    if (tooLarge) {
      return tooLarge;
    }
    input = { ...input, fileSize: bytes };
  }

  const stored = directMessages.send(peerId, peerName, input);
  sendDirectMessage(peerId, {
    kind: 'message',
    id: stored.id,
    type: stored.type,
    content: stored.content,
    dataUrl: stored.dataUrl,
    fileName: stored.fileName,
    fileSize: stored.fileSize,
    replyTo: stored.replyTo,
    sentAt: stored.sentAt
  });
  // Pushed back to this device's own window the same way a received message
  // is — the open thread, if this is the peer it belongs to, updates itself
  // rather than the renderer needing a separate local-echo path.
  emit('dm:message', stored);
  sendStateToRenderer();
  return ok('Sent.');
}

handle(
  'dm:send',
  (
    _event,
    peerId: string,
    peerName: string,
    type: DirectMessage['type'],
    content: string,
    dataUrl?: string,
    fileName?: string,
    replyToId?: string
  ): ActionResult => {
    const blocked = requireReachablePeer(peerId, peerName);
    if (blocked) {
      return blocked;
    }
    const text = type === 'text' ? content.trim() : content;
    if (type === 'text' && !text) {
      return fail('There is nothing to send.');
    }

    return postDirectMessage(peerId, peerName, {
      type,
      content: text,
      dataUrl,
      fileName,
      replyTo: buildDmReplyTo(replyToId, peerId)
    });
  }
);

/** Pick a file with the native dialog and send it into a direct thread. */
handle('dm:send-file', async (_event, peerId: string, peerName: string): Promise<ActionResult> => {
  const blocked = requireReachablePeer(peerId, peerName);
  if (blocked) {
    return blocked;
  }
  if (!mainWindow) {
    return fail('No window available.');
  }

  const picked = await dialog.showOpenDialog(mainWindow, {
    title: `Send a file to ${peerName}`,
    buttonLabel: 'Send',
    properties: ['openFile']
  });

  if (picked.canceled || picked.filePaths.length === 0) {
    return ok('Cancelled.');
  }

  const filePath = picked.filePaths[0];

  let stats;
  try {
    stats = await fs.stat(filePath);
  } catch {
    return fail('That file could not be read.');
  }

  if (!stats.isFile()) {
    return fail('That is not a file.');
  }
  const tooLarge = refuseIfTooLarge(stats.size);
  if (tooLarge) {
    return tooLarge;
  }

  let buffer: Buffer;
  try {
    buffer = await fs.readFile(filePath);
  } catch {
    return fail('That file could not be read.');
  }

  const fileName = path.basename(filePath);
  const mime = mimeForFile(fileName);
  const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;

  return postDirectMessage(peerId, peerName, {
    // Images go as 'image' so the far side can preview them inline.
    type: mime.startsWith('image/') ? 'image' : 'file',
    content: fileName,
    dataUrl,
    fileName,
    fileSize: stats.size
  });
});

handle('dm:edit', (_event, peerId: string, messageId: string, content: string): ActionResult => {
  const text = content.trim();
  if (!text) {
    return fail('An edited message cannot be empty — delete it instead.');
  }

  const existing = directMessages.findMessage(peerId, messageId);
  if (!existing) {
    return fail('That message is no longer in the thread.');
  }
  if (!existing.fromSelf) {
    return fail('You can only edit your own messages.');
  }

  const editedAt = Date.now();
  const updated = directMessages.editMessage(peerId, messageId, text, editedAt, true);
  if (!updated) {
    return fail('That message cannot be edited.');
  }

  sendDirectMessage(peerId, { kind: 'edit', id: messageId, content: text, editedAt });
  emit('dm:message', updated);
  sendStateToRenderer();
  return ok('Message edited.');
});

/**
 * Deleting for everyone withdraws the message from the thread; deleting
 * without it only clears this device, which stays available even when the
 * peer is offline, because it touches nothing but local history.
 */
handle('dm:delete', (_event, peerId: string, messageId: string, forEveryone: boolean): ActionResult => {
  const existing = directMessages.findMessage(peerId, messageId);
  if (!existing) {
    return fail('That message is no longer in the thread.');
  }

  if (!forEveryone) {
    directMessages.deleteMessageLocal(peerId, messageId);
    sendStateToRenderer();
    return ok('Deleted from this device.');
  }

  if (!existing.fromSelf) {
    return fail('You can only delete your own messages for everyone.');
  }

  const updated = directMessages.markDeleted(peerId, messageId, true);
  if (!updated) {
    return fail('That message could not be withdrawn.');
  }

  sendDirectMessage(peerId, { kind: 'delete', id: messageId });
  emit('dm:message', updated);
  sendStateToRenderer();
  return ok('Deleted for everyone.');
});

/** Toggles this device's reaction to a message in a direct thread. */
handle('dm:react', (_event, peerId: string, messageId: string, emoji: string): ActionResult => {
  const existing = directMessages.findMessage(peerId, messageId);
  if (!existing) {
    return fail('That message is no longer in the thread.');
  }

  const on = !existing.reactions?.[emoji]?.includes(deviceId());
  if (!directMessages.setReaction(peerId, messageId, emoji, deviceId(), on)) {
    return fail('That reaction could not be applied.');
  }

  sendDirectMessage(peerId, { kind: 'reaction', id: messageId, emoji, on });
  const updated = directMessages.findMessage(peerId, messageId);
  if (updated) {
    emit('dm:message', updated);
  }
  sendStateToRenderer();
  return ok(on ? 'Reacted.' : 'Reaction removed.');
});

/**
 * Write a received DM attachment wherever the user chooses. Deliberately
 * never opens it — running something that arrived over the network is the
 * user's decision, the same rule `chat:save-file` follows.
 */
handle('dm:save-file', async (_event, peerId: string, messageId: string): Promise<ActionResult> => {
  const message = directMessages.findMessage(peerId, messageId);
  if (!message) {
    return fail('That message is no longer in the thread.');
  }
  if (!message.dataUrl) {
    return fail('That file was not kept after the app restarted. Ask for it again.');
  }
  if (!mainWindow) {
    return fail('No window available.');
  }

  const picked = await dialog.showSaveDialog(mainWindow, {
    title: 'Save file',
    defaultPath: message.fileName || 'shared-file'
  });

  if (picked.canceled || !picked.filePath) {
    return ok('Cancelled.');
  }

  const base64 = message.dataUrl.slice(message.dataUrl.indexOf(',') + 1);
  try {
    await fs.writeFile(picked.filePath, Buffer.from(base64, 'base64'));
  } catch (error) {
    return fail(`Could not save: ${(error as Error).message}`);
  }

  return ok(`Saved as ${path.basename(picked.filePath)}.`);
});

handle('dm:get-thread', (_event, peerId: string): DirectMessage[] => {
  return directMessages.getThread(peerId);
});

handle('dm:mark-read', (_event, peerId: string): void => {
  directMessages.markRead(peerId);
  // Opening a thread is the DM equivalent of `chat:mark-seen` — the peer's
  // messages are visibly on screen, so they are told so in the same breath
  // the local unread badge clears, rather than needing a second call.
  const theirs = directMessages.getThread(peerId).filter((message) => !message.fromSelf);
  sendDmReceipt(peerId, theirs.map((message) => message.id), 'seen');
  sendStateToRenderer();
});

/** Tells a DM peer whether this device is currently composing a reply — never stored, and quietly dropped if there is nowhere to send it. */
handle('dm:typing', (_event, peerId: string, typing: boolean): void => {
  if (!getSettings().online || isBlocked(peerId)) {
    return;
  }
  sendDmTyping(peerId, typing);
});

/** Collapses a thread into the "Archived" section of the Messages page — never a delete. */
handle('dm:archive-thread', (_event, peerId: string, archived: boolean): void => {
  directMessages.setArchived(peerId, archived);
  sendStateToRenderer();
});

/** Removes a thread's history from this device alone — the same "for me" scope any local delete has here. */
handle('dm:delete-thread', (_event, peerId: string): void => {
  directMessages.deleteThread(peerId);
  sendStateToRenderer();
});

/**
 * Resolves (creating if needed) the hidden 1:1 room a call with this DM peer
 * belongs in, and returns its id. Split out from actually placing the call so
 * the renderer can open the ordinary call window with the ordinary
 * `{kind: 'start', roomId, ...}` intent it already knows how to handle —
 * nothing about how a call window starts a call needs to change for a DM one.
 */
handle('dm:ensure-call-room', (_event, peerId: string, peerName: string): string => {
  return roomManager.ensureDirectRoom(deviceId(), deviceName(), peerId, peerName).roomId;
});

// --- blocking IPC ------------------------------------------------------------

/**
 * Blocking a device.
 *
 * Refusing to listen is only half of it. If the device is in a room this one
 * owns, it can still read everything sent there, and a block that leaves the
 * blocked party reading your messages is not worth having — so blocking also
 * removes them from every room this device owns.
 *
 * Rooms owned by somebody else are not ours to police: we stop reading anything
 * that device sends, but we cannot throw it out of someone else's room. The UI
 * says so rather than implying a guarantee that is not there.
 */
handle('privacy:block', (_event, targetDeviceId: string, name: string): ActionResult => {
  if (!targetDeviceId) {
    return fail('No device was given.');
  }
  if (targetDeviceId === deviceId()) {
    return fail('You cannot block this device from itself.');
  }
  if (isBlocked(targetDeviceId)) {
    return ok('That device is already blocked.');
  }

  const known = read('peers').find((peer) => peer.id === targetDeviceId);
  const deviceName = (name || known?.name || 'Unknown device').trim();

  write('blocked', [
    { deviceId: targetDeviceId, deviceName, blockedAt: Date.now(), lastHost: known?.host },
    ...read('blocked').filter((entry) => entry.deviceId !== targetDeviceId)
  ]);
  loadBlocked();

  // Out of every room we own, and out of anything currently in flight.
  let removedFrom = 0;
  for (const room of roomManager.getRooms()) {
    if (room.ownerId !== deviceId()) {
      continue;
    }
    const updated = roomManager.removeMember(room.roomId, targetDeviceId);
    if (updated) {
      broadcastRoster(updated);
      removedFrom += 1;
    }
  }

  callManager.leaveAll(targetDeviceId);
  // A remote session with the device being blocked ends at once — a block that
  // left someone still driving the mouse would be worth nothing at all.
  if (remoteSessions.current?.peerId === targetDeviceId) {
    endRemoteSession(`${deviceName} was blocked, so the remote session ended.`, true);
  }
  remoteSessions.clearDevice(targetDeviceId);

  // Invitations are held by room, so the ones to drop are those whose owner is
  // the device being blocked.
  for (const [roomId, invite] of Array.from(receivedInvites)) {
    if (invite.ownerId === targetDeviceId) {
      receivedInvites.delete(roomId);
    }
  }
  for (const invites of sentInvites.values()) {
    invites.delete(targetDeviceId);
  }
  write(
    'peers',
    read('peers').filter((peer) => peer.id !== targetDeviceId)
  );
  roomManager.clearAdverts();
  // A block that left an existing direct link open would still be leaking
  // keepalive traffic to a device this is meant to stop dealing with entirely.
  if (known?.host) {
    tcp?.forget(known.host);
  }

  sendStateToRenderer();
  return ok(
    removedFrom > 0
      ? `${deviceName} is blocked, and was removed from ${removedFrom} of your ${removedFrom === 1 ? 'room' : 'rooms'}.`
      : `${deviceName} is blocked. Nothing from that device will reach this one.`
  );
});

handle('privacy:unblock', (_event, targetDeviceId: string): ActionResult => {
  const entry = read('blocked').find((candidate) => candidate.deviceId === targetDeviceId);
  if (!entry) {
    return fail('That device is not blocked.');
  }

  write(
    'blocked',
    read('blocked').filter((candidate) => candidate.deviceId !== targetDeviceId)
  );
  loadBlocked();
  // Read from the blocked entry, not `peers` — blocking already removed it
  // from there. The address may be stale by now (DHCP), but a device at a
  // genuinely new one was never forgotten in the first place; this only
  // undoes the forget that was actually done.
  if (entry.lastHost) {
    tcp?.allow(entry.lastHost);
  }
  sendStateToRenderer();

  return ok(
    `${entry.deviceName} is unblocked. It will reappear on the network, but it is not back in any room — invite it again if you want it there.`
  );
});

// --- call IPC ----------------------------------------------------------------

/**
 * Everything below decides *whether* a call may happen and who is told about it.
 * None of it touches media: the renderer holds the peer connections, and the only
 * thing it can ask for here is that a signal be carried to a room it is already
 * an approved member of.
 */

/**
 * The part of placing a call that is the same whether the room is an
 * ordinary one or the hidden 1:1 room `ensureDirectRoom` maintains for a DM
 * call — by the time this runs, `room` already exists either way, so nothing
 * here needs to know which kind it is.
 */
function startCallInRoom(room: RoomInfo, mode: CallMode, targetDeviceId?: string): CallStartResult {
  if (localCall) {
    return fail('You are already on a call. Leave it before starting another.');
  }

  /*
   * A call already live in this room is joined, not duplicated — otherwise
   * the room ends up split across two independent calls, each unaware the
   * other exists. The command palette already steers around this in the
   * renderer; this is the same rule enforced at the one place a call can
   * actually be minted, so nothing upstream of it has to get it right too.
   * Applies just the same to a direct call — once placed it is an ordinary
   * room call, so it is bound by the same one-call-per-room rule.
   */
  const roomCall = callManager.getRoomCall(room.roomId);
  if (roomCall) {
    return fail(`${room.name} already has a call going — join it instead of starting another.`);
  }

  if (targetDeviceId) {
    if (targetDeviceId === deviceId()) {
      return fail('That is this device.');
    }
    if (!roomManager.isAcceptedMember(room.roomId, targetDeviceId)) {
      return fail('That device is not a member of this room.');
    }
  } else {
    const others = roomManager.getMembers(room.roomId, 'accepted').filter((m) => m.deviceId !== deviceId());
    if (others.length === 0) {
      return fail(`Nobody else is in ${room.name} yet, so there is no one to call.`);
    }
  }

  const callId = randomUUID();
  localCall = { callId, roomId: room.roomId, mode };
  localCallHadCompany = false;
  callManager.join(callId, room.roomId, mode, deviceId(), deviceName());

  const ringSignal: CallSignal = targetDeviceId
    ? { kind: 'ring', callId, mode, to: targetDeviceId }
    : { kind: 'ring', callId, mode };

  if (!sendCallSignal(room.roomId, ringSignal)) {
    localCall = null;
    callManager.leave(callId, deviceId());
    return fail('The call could not be placed — nothing on this network could be reached.');
  }

  sendStateToRenderer();
  return { ok: true, message: `Calling ${room.name}…`, callId, roomId: room.roomId, mode };
}

handle(
  'call:start',
  (_event, roomId: string, mode: CallMode, targetDeviceId?: string): CallStartResult => {
    const room = requireWritableRoom(roomId);
    if (isActionResult(room)) {
      return room;
    }
    const restricted = requireUnrestrictedCalls(roomId, room.name);
    if (restricted) {
      return restricted;
    }

    return startCallInRoom(room, mode, targetDeviceId);
  }
);

/** Answers a ring, or joins a call already under way in a room. */
handle('call:join', (_event, callId: string): CallStartResult => {
  const existing = callManager.getCall(callId);
  const ring = ringing.get(callId);
  const roomId = existing?.roomId ?? ring?.roomId;
  if (!roomId) {
    return fail('That call has already ended.');
  }

  const room = requireWritableRoom(roomId);
  if (isActionResult(room)) {
    return room;
  }
  const restricted = requireUnrestrictedCalls(roomId, room.name);
  if (restricted) {
    return restricted;
  }

  if (localCall?.callId === callId) {
    return { ok: true, message: 'Already in this call.', callId, roomId, mode: localCall.mode };
  }
  if (localCall) {
    return fail('You are already on a call. Leave it before joining another.');
  }
  if (callManager.countParticipants(callId) >= MAX_CALL_PARTICIPANTS) {
    return fail(
      `This call is full — ${MAX_CALL_PARTICIPANTS} devices is as many as one call can carry.`
    );
  }

  const mode = existing?.mode ?? ring?.mode ?? 'audio';
  clearRing(callId);
  localCall = { callId, roomId, mode };
  localCallHadCompany = callManager.countParticipants(callId) > 0;
  callManager.join(callId, roomId, mode, deviceId(), deviceName());
  sendCallSignal(roomId, { kind: 'join', callId, mode });

  sendStateToRenderer();
  return { ok: true, message: `Joined the call in ${room.name}.`, callId, roomId, mode };
});

handle('call:leave', (): ActionResult => {
  if (!localCall) {
    return ok('You are not on a call.');
  }

  endLocalCall(true);
  return ok('You left the call.');
});

handle('call:decline', (_event, callId: string): ActionResult => {
  const ring = ringing.get(callId);
  clearRing(callId);

  if (ring) {
    sendCallSignal(ring.roomId, { kind: 'decline', callId });
  }

  sendStateToRenderer();
  return ok('Declined.');
});

/**
 * Carries one negotiation step out to the room.
 *
 * The call id is checked against the call this device is actually in, so the
 * renderer cannot be talked into signalling on behalf of a call it never joined.
 */
handle('call:signal', (_event, signal: CallSignal): boolean => {
  if (!localCall || !signal?.callId || signal.callId !== localCall.callId) {
    return false;
  }

  return sendCallSignal(localCall.roomId, signal);
});

/**
 * The screens and windows available to share.
 *
 * Deliberately a list handed to the UI rather than a stream: nothing is captured
 * by asking, and the user picks the one window they mean instead of the whole
 * desktop being taken by default.
 */
handle('call:screen-sources', async (): Promise<ScreenSource[]> => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 200 },
    fetchWindowIcons: false
  });

  return sources
    .filter((source) => !source.thumbnail.isEmpty())
    .map((source) => ({
      id: source.id,
      name: source.name,
      kind: source.id.startsWith('screen:') ? ('screen' as const) : ('window' as const),
      thumbnail: source.thumbnail.toDataURL(),
      displayId: source.id.startsWith('screen:') ? source.display_id : ''
    }));
});

/**
 * Opens the call window for a call this device is placing or joining by hand
 * — ringing already opens it on its own, in `handleCallRing`.
 */
handle('call-window:open', (_event, intent: CallWindowIntent): void => {
  openCallWindow(intent);
});

/** The call window's one-time pull of what it was opened to do. */
handle('call-window:take-intent', (): CallWindowIntent | null => {
  const intent = pendingCallIntent;
  pendingCallIntent = null;
  return intent;
});

/**
 * Tests a specific address and reports which transports survive the network.
 *
 * The three failure modes look identical from inside the app — nothing arrives
 * — but they need completely different answers, so this separates them:
 * broadcast filtered but direct traffic fine, UDP filtered but TCP fine, or
 * client isolation, where nothing gets through and no application can help.
 */
handle('network:test', async (_event, host: string): Promise<ConnectivityResult> => {
  const target = host.trim();

  if (!getSettings().online) {
    return {
      host: target,
      tcpReachable: false,
      udpReplied: false,
      verdict: 'unreachable',
      detail: 'Campus Connect is switched off on this device, so nothing can be tested. Turn it on from the header and run this again.'
    };
  }

  if (!target) {
    return {
      host: target,
      tcpReachable: false,
      udpReplied: false,
      verdict: 'unreachable',
      detail: 'Enter the address shown on the other machine, in its Network settings.'
    };
  }

  const tcpReachable = await probeTcp(target, BROADCAST_PORT);

  // A UDP probe: announce directly, then see whether that device says anything
  // back within a couple of announce intervals.
  const before = diagnostics.packetsReceived;
  const knownPeer = read('peers').find((peer) => peer.host === target);
  sendUdpMessage(baseMessage('announce'), target);
  await new Promise((resolve) => setTimeout(resolve, 3500));
  const udpReplied =
    diagnostics.packetsReceived > before ||
    Boolean(
      knownPeer && read('peers').some((peer) => peer.host === target && peer.lastSeen > Date.now() - 5000)
    );

  if (tcpReachable && udpReplied) {
    return {
      host: target,
      tcpReachable,
      udpReplied,
      verdict: 'direct',
      detail: 'Both transports reach that device. If rooms still do not work, the problem is the join credentials or an unapproved request, not the network.'
    };
  }

  if (tcpReachable) {
    return {
      host: target,
      tcpReachable,
      udpReplied,
      verdict: 'tcp-only',
      detail: 'The device is reachable, but UDP is being filtered. Adding it by address is exactly the right move — everything will run over the direct connection instead.'
    };
  }

  if (udpReplied) {
    return {
      host: target,
      tcpReachable,
      udpReplied,
      verdict: 'udp-only',
      detail: 'UDP gets through but TCP does not. Discovery and sync will work; only the direct-connection fallback is unavailable.'
    };
  }

  return {
    host: target,
    tcpReachable,
    udpReplied,
    verdict: 'unreachable',
    detail: 'Nothing reached that device on either transport. Either the app is not running there, its firewall is blocking it, or the network separates its clients — which university and public WiFi commonly do, and which no application can work around. A phone hotspot will tell you which within a minute.'
  };
});

handle('update:check', async (): Promise<UpdateStatus> => {
  const status = (await updater?.check(true)) ?? { state: 'idle' as const, currentVersion: app.getVersion() };
  sendStateToRenderer();
  return status;
});

handle('update:download', async (): Promise<UpdateStatus> => {
  const status = (await updater?.download()) ?? { state: 'idle' as const, currentVersion: app.getVersion() };
  sendStateToRenderer();
  return status;
});

handle('update:install', (): ActionResult => {
  if (!Updater.canSelfInstall) {
    shell.openExternal(`${APP_INFO.repositoryUrl}/releases/latest`);
    return ok('Opened the download page — macOS needs the update installed by hand.');
  }

  const status = updater?.getStatus();
  if (status?.state !== 'ready') {
    // Saying "restarting" and then doing nothing is indistinguishable from the
    // app having frozen, which is how it was read.
    return fail(
      status?.state === 'downloading'
        ? `The update is still downloading (${status.percent ?? 0}%). This becomes available the moment it finishes.`
        : 'No update has been downloaded yet. Check for updates, then download it first.'
    );
  }

  /*
   * The window's close handler keeps the app alive in the tray, so the quit the
   * installer is about to ask for has to be marked as a real one first. History
   * is written out here too: its flush is on a debounce, and the app is about
   * to go away.
   */
  isQuiting = true;
  historyManager.flush();
  directMessages.flush();
  persist('peers');

  if (!updater?.installNow()) {
    isQuiting = false;
    return fail('The update could not be started. Download it again, or install it by hand.');
  }

  return ok('Restarting to finish the update…');
});

handle('storage:stats', (): StorageStats => historyManager.stats());

handle('storage:compact', (): ActionResult => {
  const settings = getSettings();
  const cleared = compactStorage();
  sendStateToRenderer();

  return ok(
    cleared === 0
      ? 'Nothing to clean up — storage is already tidy.'
      : `Cleared ${cleared} attachment${cleared === 1 ? '' : 's'}. Messages and text were kept.`
  );
});

handle('clipboard:read', () => readClipboardText());

/** Copy a history entry back onto this machine's clipboard. */
handle('clipboard:apply', (_event, entryId: string): ActionResult => {
  const entry = historyManager.getClipboardHistory().find((candidate) => candidate.id === entryId);
  if (!entry) {
    return fail('That item is no longer in history.');
  }

  if (entry.kind === 'image' && entry.dataUrl) {
    lastClipboardImageFingerprint = writeClipboardImage(entry.dataUrl) ?? '';
  } else {
    lastClipboardImageFingerprint = '';
    writeClipboardText(entry.text);
  }

  const hash = hashClipboardPayload({
    kind: entry.kind,
    text: entry.text,
    dataUrl: entry.dataUrl,
    sourceId: entry.deviceId,
    sourceName: entry.deviceName,
    timestamp: entry.timestamp
  });
  lastLocalClipboardHash = hash;
  lastRemoteClipboardHash = hash;

  return ok('Copied — press Ctrl+V to paste.');
});

/** Share whatever is on the clipboard right now, without waiting for the poller. */
handle('clipboard:share-now', (): ActionResult => {
  const offline = requireOnline();
  if (offline) {
    return offline;
  }

  const roomId = read('currentRoomId');
  if (!roomId) {
    return fail('Select a room first.');
  }

  const image = getSettings().shareImages ? readClipboardImage() : null;
  const payload = image
    ? createImageClipboardPayload(deviceId(), deviceName(), image.toDataUrl())
    : createTextClipboardPayload(deviceId(), deviceName(), readClipboardText());

  if (payload.kind === 'text' && !payload.text) {
    return fail('Your clipboard is empty.');
  }

  lastClipboardImageFingerprint = image?.fingerprint ?? '';

  const hash = hashClipboardPayload(payload);
  lastLocalClipboardHash = hash;
  lastRemoteClipboardHash = hash;
  shareClipboard(payload, roomId);
  return ok('Shared with the room.');
});
