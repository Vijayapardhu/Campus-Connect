import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  session,
  Tray,
  nativeImage,
  nativeTheme,
  shell
} from 'electron';
import log from 'electron-log';
import Store from 'electron-store';
import QRCode from 'qrcode';
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
import { RoomManager } from './roomManager';
import { HistoryManager } from './historyManager';
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
  normalizeJoinCode,
  openJson,
  sealJson,
  verifyProof
} from './crypto';
import {
  APP_INFO,
  MAX_FONT_SCALE,
  MIN_FONT_SCALE,
  PROTOCOL_VERSION,
  type ActionResult,
  type AppSettings,
  type AppState,
  type ChatMessage,
  type ChatReplyTo,
  type ClipboardHistoryEntry,
  type ClipboardPayload,
  type ConnectivityResult,
  type JoinRequest,
  type PeerInfo,
  type RoomInfo,
  type RoomInvite,
  type RoomType,
  type StorageStats,
  type UpdateStatus,
  type WireMessage
} from '../shared/types';

type AppStore = {
  deviceId: string;
  deviceName: string;
  listenPort: number;
  peers: PeerInfo[];
  currentRoomId?: string;
  settings: AppSettings;
  rooms: RoomInfo[];
  roomKeys: Record<string, string>;
  clipboardHistory: ClipboardHistoryEntry[];
  chatHistory: ChatMessage[];
};

const BROADCAST_PORT = 37777;
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
  sendReceipts: true,
  retainMediaDays: 7,
  maxStorageMb: 100,
  autoUpdate: true
};

/** How often the stored history is swept for attachments to drop. */
const COMPACT_INTERVAL_MS = 60 * 60 * 1000;

const store = new Store<AppStore>({
  defaults: {
    deviceId: randomUUID(),
    deviceName: getSystemDeviceName(),
    listenPort: BROADCAST_PORT,
    peers: [],
    currentRoomId: undefined,
    settings: DEFAULT_SETTINGS,
    rooms: [],
    roomKeys: {},
    clipboardHistory: [],
    chatHistory: []
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

const roomManager = new RoomManager({
  readRooms: () => read('rooms'),
  writeRooms: (rooms) => write('rooms', rooms),
  readKeys: () => read('roomKeys'),
  writeKeys: (keys) => write('roomKeys', keys)
});

const historyManager = new HistoryManager({
  readClipboard: () => read('clipboardHistory'),
  writeClipboard: (entries) => write('clipboardHistory', entries),
  readChat: () => read('chatHistory'),
  writeChat: (messages) => write('chatHistory', messages)
});

let mainWindow: BrowserWindow | null = null;
let udpSocket: dgram.Socket | null = null;
let announceTimer: NodeJS.Timeout | null = null;
let clipboardPollTimer: NodeJS.Timeout | null = null;
let transferSweepTimer: NodeJS.Timeout | null = null;
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
    listenPort: read('listenPort'),
    localAddress: getLocalIpAddress(),
    peers: read('peers'),
    currentRoomId: read('currentRoomId'),
    rooms: roomManager.getRooms(),
    discovered: roomManager.getDiscoveredRooms(),
    lockedRoomIds: roomManager
      .getRooms()
      .filter((room) => roomManager.isLocked(room.roomId))
      .map((room) => room.roomId),
    invites: listReceivedInvites(),
    invitedDeviceIds: pendingInviteIds(),
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
  mainWindow?.webContents.send('app:state-changed', getAppState());
}

/** Tells the renderer to refetch history, so it never has to poll for it. */
function notifyHistoryChanged(roomId: string) {
  mainWindow?.webContents.send('history:changed', roomId);
}

/**
 * A system notification, but only when the window cannot already show it.
 * Nothing is more irritating than being notified about the window you are
 * looking at.
 */
function notify(title: string, body: string, onClick?: () => void): void {
  if (!getSettings().notifications || !Notification.isSupported()) {
    return;
  }

  const visible = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible();
  if (visible && mainWindow?.isFocused()) {
    return;
  }

  const notification = new Notification({ title, body, silent: false });
  notification.on('click', () => {
    showMainWindow();
    onClick?.();
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
  mainWindow?.webContents.send('sync:status', { message, tone });
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
    port: read('listenPort'),
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
function deliver(message: WireMessage, targets: string[]): boolean {
  if (!udpSocket || targets.length === 0) {
    return false;
  }

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
    existing.protocolVersion !== nextPeer.protocolVersion;

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
    lastSeen: Date.now()
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
    if (room.ownerId !== deviceId()) {
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

  const updated = roomManager.addPendingMember(room.roomId, message.deviceId, message.deviceName);
  if (updated) {
    const request: JoinRequest = {
      roomId: room.roomId,
      roomName: room.name,
      deviceId: message.deviceId,
      deviceName: message.deviceName,
      requestedAt: Date.now()
    };
    mainWindow?.webContents.send('room:join-request', request);
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
  mainWindow?.webContents.send('room:join-result', {
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

  // Clear the provisional key from the failed attempt, but never tear down a
  // room we are already a confirmed member of on the word of one packet.
  if (!roomManager.isAcceptedMember(message.roomId, deviceId())) {
    roomManager.deleteRoom(message.roomId);
  }

  sendStateToRenderer();
  mainWindow?.webContents.send('room:join-result', {
    roomId: message.roomId,
    ok: false,
    message: message.reason ?? `Your request to join ${name} was declined.`
  } satisfies JoinResultEvent);
  sendStatus(message.reason ?? `Request to join ${name} was declined.`, 'error');
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
    roomManager.saveRoom({ ...nextRoom, joinCode: nextRoom.joinCode ?? room.joinCode });
  }

  sendStateToRenderer();
}

function handleRoomLeave(message: WireMessage) {
  const room = message.roomId ? roomManager.getRoom(message.roomId) : undefined;
  if (!room || room.ownerId !== deviceId()) {
    return;
  }

  roomManager.removeMember(room.roomId, message.deviceId);
  broadcastRoster(room);
  sendStateToRenderer();
  sendStatus(`${message.deviceName} left ${room.name}`, 'info');
}

function handleRoomClosed(message: WireMessage) {
  const room = message.roomId ? roomManager.getRoom(message.roomId) : undefined;
  if (!room || room.ownerId !== message.deviceId || room.ownerId === deviceId()) {
    return;
  }

  roomManager.deleteRoom(room.roomId);
  historyManager.clearRoom(room.roomId);
  if (read('currentRoomId') === room.roomId) {
    write('currentRoomId', undefined);
  }
  sendStateToRenderer();
  sendStatus(`${room.name} was closed by its owner.`, 'warning');
}

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
    timestamp: chat.timestamp
  });
  mainWindow?.webContents.send('chat:message', stored);
  sendReceipt(chat.deviceId, message.roomId!, [stored.id], 'delivered');

  const room = roomManager.getRoom(message.roomId!);
  notify(
    `${stored.deviceName} in ${room?.name ?? 'a room'}`,
    stored.type === 'text' ? stored.content : (stored.fileName ?? 'Sent a file')
  );
}

/** Tells the renderer a room's messages changed, so it refetches them. */
function notifyChatChanged(roomId: string) {
  mainWindow?.webContents.send('chat:changed', roomId);
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

  const updated = historyManager.editChatMessage(
    edit.messageId,
    edit.content,
    message.deviceId,
    edit.editedAt ?? Date.now()
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

  mainWindow?.webContents.send('chat:typing', {
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
  mainWindow?.webContents.send('room:invite', invite);
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

  const updated = roomManager.addPendingMember(room.roomId, message.deviceId, message.deviceName);
  if (updated) {
    mainWindow?.webContents.send('room:join-request', {
      roomId: room.roomId,
      roomName: room.name,
      deviceId: message.deviceId,
      deviceName: message.deviceName,
      requestedAt: Date.now()
    } satisfies JoinRequest);
    sendStatus(`${message.deviceName} accepted your invitation to ${room.name}`, 'warning');
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
    mainWindow?.webContents.send('chat:receipts', message.roomId);
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
      `${message.deviceName || 'A device'} is running a different version of Shared Clipboard (protocol v${message.v} against this app's v${PROTOCOL_VERSION}), so the two cannot talk to each other. Install the same version on both.`,
      'error'
    );
    notify(
      'Different version detected',
      `${message.deviceName || 'A device'} is running another version of Shared Clipboard. Install the same version on both machines.`
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

    diagnostics.packetsReceived += 1;
    diagnostics.lastReceivedAt = Date.now();
    if (viaTcp) {
      diagnostics.tcpFramesReceived += 1;
    }

    if (message.v !== PROTOCOL_VERSION) {
      reportVersionMismatch(message, host);
      return;
    }

    handleWireMessage(message, host);
  } catch {
    // Malformed input on a shared port is expected; ignore quietly.
  }
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
    updater?.start(getSettings().autoUpdate);
    sendStatus('Shared clipboard is on.', 'success');
    return;
  }

  stopUdpService();
  write('peers', []);
  roomManager.clearAdverts();
  sendStatus('Shared clipboard is off. Nothing is shared or received.', 'warning');
  sendStateToRenderer();
}

/** Rejects anything that needs the network while the switch is off. */
function requireOnline(): ActionResult | null {
  return getSettings().online
    ? null
    : fail('Shared clipboard is off. Turn it on from the header to use this.');
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
 * The tray mark, matching the app icon but simplified: at 16px the content
 * lines and the drop shadow turn to mush, so only the clipboard silhouette and
 * the tick survive.
 */
function createTrayIcon() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
<rect width="64" height="64" rx="15" fill="#4f46e5"/>
<rect x="19" y="18" width="26" height="31" rx="5" fill="#ffffff"/>
<rect x="26" y="14" width="12" height="8" rx="4" fill="#ffffff"/>
<path d="M25 34.5 30 39.5 41 28" fill="none" stroke="#4f46e5" stroke-width="5"
  stroke-linecap="round" stroke-linejoin="round"/>
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
  tray.setToolTip('Shared Clipboard');
  refreshTrayMenu();
  tray.on('click', () => showMainWindow());
}

function refreshTrayMenu() {
  const settings = getSettings();
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Shared Clipboard', click: () => showMainWindow() },
      {
        label: 'Shared clipboard on',
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

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 940,
    minHeight: 620,
    title: 'Shared Clipboard',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1115' : '#ffffff',
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

  const devServerUrl =
    process.env.VITE_DEV_SERVER_URL ?? (app.isPackaged ? undefined : 'http://localhost:5173');

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
 * One copy of the app per machine.
 *
 * It starts with the system and then lives in the tray, so opening it from the
 * shortcut while it is already running is the normal thing to do — and that
 * used to start a second copy. Two copies share the port, both answer the same
 * room, and both raise a notification for everything that arrives, which looks
 * exactly like the network sending everything twice.
 */
if (!app.requestSingleInstanceLock()) {
  log.info('Another copy of Shared Clipboard is already running; handing over to it');
  app.quit();
}

app.on('second-instance', () => showMainWindow());

app.whenReady().then(() => {
  // A second copy is on its way out; it must not open a window or take a port.
  if (!app.hasSingleInstanceLock()) {
    return;
  }

  // No File/Edit/View/Window/Help ribbon — the app has its own chrome.
  Menu.setApplicationMenu(null);
  app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });

  // The font picker reads the list of installed fonts. Nothing else is granted;
  // everything unrecognised is denied rather than allowed by default.
  // 'local-fonts' is not in Electron's permission union yet, so compare as text.
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(String(permission) === 'local-fonts');
  });

  // Drop a stale current room left over from a previous run.
  const currentRoomId = read('currentRoomId');
  if (currentRoomId && !roomManager.getRoom(currentRoomId)) {
    write('currentRoomId', undefined);
  }

  // Windows attributes notifications by app id; without this they show as
  // coming from "electron.app.Electron".
  app.setAppUserModelId('com.vijayapardhu.sharedclipboard');

  compactStorage();

  mainWindow = createWindow();
  setupTray();

  // Left off last time means still off now; the switch survives a restart.
  if (getSettings().online) {
    startUdpService();
    startTcpService();
  } else {
    log.info('Starting with the shared clipboard switched off');
  }

  updater = new Updater({
    onStatus: (status) => {
      mainWindow?.webContents.send('update:status', status);
      sendStateToRenderer();

      if (status.state === 'ready' && status.availableVersion) {
        notify(
          `Version ${status.availableVersion} is ready`,
          'Restart Shared Clipboard to finish updating. Both machines need the same version to talk to each other.'
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
  historyManager.flush();
  persist('peers');
  stopUdpService();
  tray?.destroy();
  tray = null;
  log.info('Shutting down Shared Clipboard');
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

ipcMain.handle('app:get-state', () => getAppState());

ipcMain.handle('app:update-device-name', (_event, name: string) => {
  write('deviceName', name.trim() || getSystemDeviceName());
  sendStateToRenderer();
  broadcastPresence();
  return getAppState();
});

ipcMain.handle('app:update-settings', (_event, patch: Partial<AppSettings>) => updateSettings(patch));

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

ipcMain.handle('app:open-external', (_event, url: string): ActionResult => {
  if (!EXTERNAL_LINKS.includes(url)) {
    log.warn(`Refused to open an unrecognised URL: ${url}`);
    return fail('That link could not be opened.');
  }

  shell.openExternal(url);
  return ok('Opened in your browser.');
});

ipcMain.handle('app:connect-peer', (_event, host: string, port: number, name: string) => {
  if (!getSettings().online) {
    sendStatus('Shared clipboard is off. Turn it on from the header first.', 'warning');
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
  // Both transports: TCP for networks that filter UDP, UDP for the rest.
  tcp?.connect(host);
  sendUdpMessage(baseMessage('announce'), host);
  sendStatus(`Reaching out to ${peer.name}`, 'info');
  return getAppState();
});

ipcMain.handle(
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
ipcMain.handle(
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
ipcMain.handle(
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

/** Supply the password for an encrypted room we are already a member of. */
ipcMain.handle('room:unlock', (_event, roomId: string, password: string): ActionResult => {
  const room = roomManager.getRoom(roomId);
  if (!room) {
    return fail('Room not found.');
  }
  if (!room.encrypted) {
    return ok('This room is not encrypted.');
  }

  const key = deriveRoomKey(password, room.keySalt);
  roomManager.setKey(roomId, key);

  // Ask the owner for the full roster. A device that joined on the join code
  // alone only holds the cut-down one it could read at the time.
  if (room.ownerId !== deviceId()) {
    const request = baseMessage('room-request');
    request.roomId = roomId;
    request.proof = createProof(key, roomId);
    const host = getPeerHost(room.ownerId);
    fanOut(request, host ? [host] : []);
  }

  sendStateToRenderer();
  return ok(`${room.name} unlocked.`);
});

/**
 * A scannable version of the join code. Rendered dark-on-white regardless of
 * theme, because that is what scanners expect. The password is deliberately
 * not included — a QR code is something you hold up in a room full of people.
 */
ipcMain.handle('room:qr-code', async (_event, roomId: string): Promise<string | null> => {
  const room = roomManager.getRoom(roomId);
  if (!room?.joinCode) {
    return null;
  }

  const uri = `sharedclipboard://join?code=${room.joinCode}&room=${encodeURIComponent(room.name)}`;

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
ipcMain.handle('room:invite', (_event, roomId: string, targetDeviceId: string): ActionResult => {
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
ipcMain.handle('room:respond-invite', (_event, roomId: string, accept: boolean): ActionResult => {
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

ipcMain.handle('room:switch', (_event, roomId: string): ActionResult => {
  const room = roomManager.getRoom(roomId);
  if (!room) {
    return fail('Room not found.');
  }

  write('currentRoomId', roomId);
  sendStateToRenderer();
  return ok(`Now sharing to ${room.name}`);
});

ipcMain.handle('room:approve-member', (_event, roomId: string, memberId: string): ActionResult => {
  if (!roomManager.isOwner(roomId, deviceId())) {
    return fail('Only the room owner can approve members.');
  }

  const room = roomManager.approveMember(roomId, memberId);
  if (!room) {
    return fail('That request is no longer pending.');
  }

  const member = room.members.find((candidate) => candidate.deviceId === memberId);
  fanOut(buildAcceptMessage(room, memberId), memberHosts(roomId));
  broadcastRoster(room);
  sendStateToRenderer();
  return ok(`${member?.deviceName ?? 'Device'} can now use ${room.name}.`);
});

ipcMain.handle('room:reject-member', (_event, roomId: string, memberId: string): ActionResult => {
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

ipcMain.handle('room:remove-member', (_event, roomId: string, memberId: string): ActionResult => {
  if (!roomManager.isOwner(roomId, deviceId())) {
    return fail('Only the room owner can remove members.');
  }

  const member = roomManager.getMembers(roomId).find((m) => m.deviceId === memberId);
  const room = roomManager.removeMember(roomId, memberId);
  if (!room) {
    return fail('That member could not be removed.');
  }

  broadcastRoster(room);
  sendStateToRenderer();
  return ok(`${member?.deviceName ?? 'Device'} was removed from ${room.name}.`);
});

ipcMain.handle('room:leave', (_event, roomId: string): ActionResult => {
  const room = roomManager.getRoom(roomId);
  if (!room) {
    return fail('Room not found.');
  }

  const isOwner = room.ownerId === deviceId();
  const message = baseMessage(isOwner ? 'room-closed' : 'room-leave');
  message.roomId = roomId;
  fanOut(message, memberHosts(roomId));

  roomManager.deleteRoom(roomId);
  historyManager.clearRoom(roomId);
  if (read('currentRoomId') === roomId) {
    write('currentRoomId', undefined);
  }

  sendStateToRenderer();
  return ok(isOwner ? `${room.name} was closed.` : `You left ${room.name}.`);
});

ipcMain.handle('history:get-clipboard', (_event, roomId?: string) =>
  historyManager.getClipboardHistory(roomId)
);

ipcMain.handle('history:get-chat', (_event, roomId?: string) => historyManager.getChatHistory(roomId));

ipcMain.handle('history:delete-entry', (_event, entryId: string) => {
  const entry = historyManager.getClipboardHistory().find((candidate) => candidate.id === entryId);
  historyManager.deleteClipboardEntry(entryId);
  if (entry) {
    notifyHistoryChanged(entry.roomId);
  }
  return ok('Removed from history.');
});

ipcMain.handle('history:toggle-pin', (_event, entryId: string): ActionResult => {
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

ipcMain.handle('history:clear-room', (_event, roomId: string) => {
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
  const chatMessage = historyManager.addChatMessage({
    ...input,
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

  mainWindow?.webContents.send('chat:message', chatMessage);
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
  return room;
}

function isActionResult<T extends object>(value: T | ActionResult): value is ActionResult {
  return 'ok' in value;
}

ipcMain.handle(
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

ipcMain.handle('chat:edit', (_event, messageId: string, content: string): ActionResult => {
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
  if (!historyManager.editChatMessage(messageId, text, deviceId(), editedAt)) {
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
ipcMain.handle('chat:delete', (_event, messageId: string, forEveryone: boolean): ActionResult => {
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
ipcMain.handle('chat:react', (_event, messageId: string, emoji: string): ActionResult => {
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
ipcMain.handle('chat:typing', (_event, roomId: string, typing: boolean): void => {
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
ipcMain.handle('chat:send-file', async (_event, roomId: string): Promise<ActionResult> => {
  const room = requireWritableRoom(roomId);
  if (isActionResult(room)) {
    return room;
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
  if (stats.size > MAX_FILE_BYTES) {
    return fail(
      `Files are limited to ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB — that one is ${(stats.size / 1024 / 1024).toFixed(1)} MB.`
    );
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
ipcMain.handle('chat:save-file', async (_event, messageId: string): Promise<ActionResult> => {
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

/** The chat for this room is on screen, so acknowledge everything in it. */
ipcMain.handle('chat:mark-seen', (_event, roomId: string): ActionResult => {
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

/**
 * Tests a specific address and reports which transports survive the network.
 *
 * The three failure modes look identical from inside the app — nothing arrives
 * — but they need completely different answers, so this separates them:
 * broadcast filtered but direct traffic fine, UDP filtered but TCP fine, or
 * client isolation, where nothing gets through and no application can help.
 */
ipcMain.handle('network:test', async (_event, host: string): Promise<ConnectivityResult> => {
  const target = host.trim();

  if (!getSettings().online) {
    return {
      host: target,
      tcpReachable: false,
      udpReplied: false,
      verdict: 'unreachable',
      detail: 'The shared clipboard is switched off on this device, so nothing can be tested. Turn it on from the header and run this again.'
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

ipcMain.handle('update:check', async (): Promise<UpdateStatus> => {
  const status = (await updater?.check(true)) ?? { state: 'idle' as const, currentVersion: app.getVersion() };
  sendStateToRenderer();
  return status;
});

ipcMain.handle('update:download', async (): Promise<UpdateStatus> => {
  const status = (await updater?.download()) ?? { state: 'idle' as const, currentVersion: app.getVersion() };
  sendStateToRenderer();
  return status;
});

ipcMain.handle('update:install', (): ActionResult => {
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
  persist('peers');

  if (!updater?.installNow()) {
    isQuiting = false;
    return fail('The update could not be started. Download it again, or install it by hand.');
  }

  return ok('Restarting to finish the update…');
});

ipcMain.handle('storage:stats', (): StorageStats => historyManager.stats());

ipcMain.handle('storage:compact', (): ActionResult => {
  const settings = getSettings();
  const cleared = compactStorage();
  sendStateToRenderer();

  return ok(
    cleared === 0
      ? 'Nothing to clean up — storage is already tidy.'
      : `Cleared ${cleared} attachment${cleared === 1 ? '' : 's'}. Messages and text were kept.`
  );
});

ipcMain.handle('clipboard:read', () => readClipboardText());

/** Copy a history entry back onto this machine's clipboard. */
ipcMain.handle('clipboard:apply', (_event, entryId: string): ActionResult => {
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
ipcMain.handle('clipboard:share-now', (): ActionResult => {
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
