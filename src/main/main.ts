import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  session,
  Tray,
  nativeImage,
  nativeTheme,
  shell
} from 'electron';
import log from 'electron-log';
import Store from 'electron-store';
import path from 'node:path';
import os from 'node:os';
import dgram from 'node:dgram';
import { randomUUID, createHash } from 'node:crypto';
import {
  createImageClipboardPayload,
  createTextClipboardPayload,
  readClipboardImageDataUrl,
  readClipboardText,
  writeClipboardImage,
  writeClipboardText
} from './clipboardStore';
import { getSystemDeviceName } from './systemInfo';
import { RoomManager } from './roomManager';
import { HistoryManager } from './historyManager';
import {
  createProof,
  deriveRoomKey,
  normalizeJoinCode,
  openJson,
  sealJson,
  verifyProof
} from './crypto';
import {
  MAX_FONT_SCALE,
  MIN_FONT_SCALE,
  PROTOCOL_VERSION,
  type ActionResult,
  type AppSettings,
  type AppState,
  type ChatMessage,
  type ClipboardHistoryEntry,
  type ClipboardPayload,
  type JoinRequest,
  type PeerInfo,
  type RoomInfo,
  type RoomType,
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
const CLIPBOARD_POLL_MS = 1000;
const PEER_TTL_MS = 15000;
/**
 * A UDP datagram tops out at 64KB. Anything larger is dropped with a visible
 * message rather than failing silently halfway through a demo.
 */
const MAX_DATAGRAM_BYTES = 60000;

const DEFAULT_SETTINGS: AppSettings = {
  syncEnabled: true,
  autoApply: true,
  shareImages: true,
  theme: 'system',
  fontScale: 1,
  fontFamily: ''
};

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

const roomManager = new RoomManager({
  readRooms: () => store.get('rooms'),
  writeRooms: (rooms) => store.set('rooms', rooms),
  readKeys: () => store.get('roomKeys'),
  writeKeys: (keys) => store.set('roomKeys', keys)
});

const historyManager = new HistoryManager({
  readClipboard: () => store.get('clipboardHistory'),
  writeClipboard: (entries) => store.set('clipboardHistory', entries),
  readChat: () => store.get('chatHistory'),
  writeChat: (messages) => store.set('chatHistory', messages)
});

let mainWindow: BrowserWindow | null = null;
let udpSocket: dgram.Socket | null = null;
let announceTimer: NodeJS.Timeout | null = null;
let clipboardPollTimer: NodeJS.Timeout | null = null;
let tray: Tray | null = null;
let lastLocalClipboardHash = '';
let lastRemoteClipboardHash = '';
let isQuiting = false;

// --- helpers -----------------------------------------------------------------

function getLocalIpAddress(): string {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address && address.family === 'IPv4' && !address.internal) {
        return address.address;
      }
    }
  }
  return '127.0.0.1';
}

function getSettings(): AppSettings {
  return { ...DEFAULT_SETTINGS, ...store.get('settings') };
}

function deviceId(): string {
  return store.get('deviceId');
}

function deviceName(): string {
  return store.get('deviceName');
}

function getAppState(): AppState {
  return {
    deviceId: deviceId(),
    deviceName: deviceName(),
    listenPort: store.get('listenPort'),
    localAddress: getLocalIpAddress(),
    peers: store.get('peers'),
    currentRoomId: store.get('currentRoomId'),
    rooms: roomManager.getRooms(),
    discovered: roomManager.getDiscoveredRooms(),
    lockedRoomIds: roomManager
      .getRooms()
      .filter((room) => roomManager.isLocked(room.roomId))
      .map((room) => room.roomId),
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

type StatusTone = 'info' | 'success' | 'warning' | 'error';

function sendStatus(message: string, tone: StatusTone = 'info') {
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
    port: store.get('listenPort'),
    host: getLocalIpAddress(),
    timestamp: Date.now()
  };
}

// --- transport ---------------------------------------------------------------

function sendUdpMessage(message: WireMessage, host = '255.255.255.255'): boolean {
  if (!udpSocket) {
    return false;
  }

  const payload = Buffer.from(JSON.stringify(message));
  if (payload.byteLength > MAX_DATAGRAM_BYTES) {
    sendStatus(
      `Item is too large to send over the network (${Math.round(payload.byteLength / 1024)} KB). It was kept in local history only.`,
      'warning'
    );
    return false;
  }

  udpSocket.send(payload, BROADCAST_PORT, host, (error) => {
    if (error) {
      sendStatus(`Network send failed: ${error.message}`, 'error');
    }
  });
  return true;
}

/** Broadcast, then unicast to known peers so a blocked broadcast is survivable. */
function fanOut(message: WireMessage, hosts: string[] = []): boolean {
  const sent = sendUdpMessage(message);
  if (!sent) {
    return false;
  }

  const seen = new Set<string>();
  for (const host of hosts) {
    if (host && !seen.has(host)) {
      seen.add(host);
      sendUdpMessage(message, host);
    }
  }
  return true;
}

function getPeerHost(targetDeviceId: string): string | undefined {
  return store.get('peers').find((peer) => peer.id === targetDeviceId)?.host;
}

/** Hosts of every accepted member of a room that we currently know how to reach. */
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

function updatePeer(peer: PeerInfo) {
  const peers = store.get('peers');
  const nextPeer: PeerInfo = { ...peer, lastSeen: Date.now() };
  const filtered = peers.filter((existing) => existing.id !== nextPeer.id);
  filtered.unshift(nextPeer);
  const active = filtered
    .filter((existing) => Date.now() - existing.lastSeen <= PEER_TTL_MS)
    .slice(0, 20);
  store.set('peers', active);
  sendStateToRenderer();
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

  if (fanOut(message, memberHosts(roomId))) {
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
    writeClipboardImage(payload.dataUrl);
    sendStatus(`Image copied from ${sourceName}`, 'success');
    return;
  }

  writeClipboardText(payload.text);
  sendStatus(`Copied from ${sourceName} — press Ctrl+V`, 'success');
}

function pollLocalClipboard() {
  const settings = getSettings();
  const roomId = store.get('currentRoomId');
  if (!settings.syncEnabled || !roomId) {
    return;
  }

  const imageDataUrl = settings.shareImages ? readClipboardImageDataUrl() : null;
  if (imageDataUrl) {
    const payload = createImageClipboardPayload(deviceId(), deviceName(), imageDataUrl);
    const nextHash = hashClipboardPayload(payload);
    if (nextHash !== lastLocalClipboardHash) {
      lastLocalClipboardHash = nextHash;
      lastRemoteClipboardHash = nextHash;
      shareClipboard(payload, roomId);
    }
    return;
  }

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

function handleRoomRequest(message: WireMessage) {
  const room = message.roomId ? roomManager.getRoom(message.roomId) : undefined;
  if (!room || room.ownerId !== deviceId()) {
    return; // Only the owner admits members.
  }

  const reject = (reason: string) => {
    const rejection = baseMessage('room-reject');
    rejection.roomId = room.roomId;
    rejection.targetDeviceId = message.deviceId;
    rejection.reason = reason;
    fanOut(rejection, [message.host]);
    log.info(`Rejected ${message.deviceName} for ${room.name}: ${reason}`);
  };

  if (room.type === 'private' && normalizeJoinCode(message.joinCode ?? '') !== room.joinCode) {
    reject('That join code is not valid for this room.');
    return;
  }

  if (room.encrypted) {
    const key = roomManager.getKey(room.roomId);
    if (!key || !verifyProof(key, room.roomId, message.proof)) {
      reject('Incorrect room password.');
      return;
    }
  }

  if (room.type === 'public') {
    roomManager.addAcceptedMember(room.roomId, message.deviceId, message.deviceName);
    const accept = baseMessage('room-accept');
    accept.roomId = room.roomId;
    accept.targetDeviceId = message.deviceId;
    if (attachRoomBody(accept, room, { room })) {
      fanOut(accept, [message.host]);
    }
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
  }
}

function handleRoomAccept(message: WireMessage) {
  if (message.targetDeviceId !== deviceId() || !message.roomId) {
    return;
  }

  // We may only have the advert at this point, so decrypt against the pending key.
  const known = roomManager.getRoom(message.roomId);
  const body = known
    ? readRoomBody(message, known)
    : (() => {
        const key = roomManager.getKey(message.roomId!);
        return key ? openJson<Partial<WireMessage>>(key, message.sealed) ?? message : message;
      })();

  const room = body?.room;
  if (!room || room.roomId !== message.roomId) {
    return;
  }

  roomManager.saveRoom(room);
  roomManager.dropAdvert(room.roomId);
  store.set('currentRoomId', room.roomId);
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
    if (store.get('currentRoomId') === room.roomId) {
      store.set('currentRoomId', undefined);
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
  if (store.get('currentRoomId') === room.roomId) {
    store.set('currentRoomId', undefined);
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

function handleClipboardMessage(message: WireMessage) {
  const body = handleRoomPayload(message);
  const payload = body?.payload;
  if (!payload) {
    return;
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

  const settings = getSettings();
  if (settings.autoApply && message.roomId === store.get('currentRoomId')) {
    applyRemoteClipboard(payload, message.deviceName);
  } else {
    sendStatus(`New item from ${message.deviceName} in history`, 'info');
  }
}

function handleChatMessage(message: WireMessage) {
  const body = handleRoomPayload(message);
  const chat = body?.chatMessage;
  if (!chat || historyManager.hasChatMessage(chat.id)) {
    return;
  }

  const stored = historyManager.addChatMessage(
    chat.type,
    chat.content,
    chat.deviceId,
    chat.deviceName,
    message.roomId!,
    chat.dataUrl,
    chat.fileName,
    chat.id,
    chat.timestamp
  );
  mainWindow?.webContents.send('chat:message', stored);
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
      return handleRoomRequest(message);
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
    default:
      return;
  }
}

// --- lifecycle ---------------------------------------------------------------

function startUdpService() {
  udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  udpSocket.on('error', (error) => {
    sendStatus(`Network error: ${error.message}`, 'error');
  });

  udpSocket.on('message', (buffer, rinfo) => {
    try {
      const message = JSON.parse(buffer.toString('utf8')) as WireMessage;
      if (!message?.type || !message.deviceId || message.v !== PROTOCOL_VERSION) {
        return;
      }
      handleWireMessage(message, rinfo.address);
    } catch {
      // Malformed packets on a shared port are expected; ignore quietly.
    }
  });

  udpSocket.bind(BROADCAST_PORT, () => {
    udpSocket?.setBroadcast(true);
    sendStatus(`Listening on port ${BROADCAST_PORT}`, 'success');
    broadcastPresence();
    advertiseOwnedRooms();

    announceTimer = setInterval(() => {
      broadcastPresence();
      advertiseOwnedRooms();
    }, ANNOUNCE_INTERVAL_MS);
    clipboardPollTimer = setInterval(pollLocalClipboard, CLIPBOARD_POLL_MS);
  });
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
  udpSocket?.close();
  udpSocket = null;
}

function createTrayIcon() {
  const icon = nativeImage.createFromDataURL(
    'data:image/svg+xml;base64,' +
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#111827"/><path d="M20 18h24a4 4 0 0 1 4 4v10H16V22a4 4 0 0 1 4-4Zm-4 18h32v8a4 4 0 0 1-4 4H20a4 4 0 0 1-4-4v-8Zm8-8h16v4H24v-4Z" fill="#818cf8"/></svg>`
      ).toString('base64')
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
        label: 'Share my clipboard',
        type: 'checkbox',
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

app.whenReady().then(() => {
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
  const currentRoomId = store.get('currentRoomId');
  if (currentRoomId && !roomManager.getRoom(currentRoomId)) {
    store.set('currentRoomId', undefined);
  }

  mainWindow = createWindow();
  setupTray();
  startUdpService();

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
  store.set('settings', next);
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
  store.set('deviceName', name.trim() || getSystemDeviceName());
  sendStateToRenderer();
  broadcastPresence();
  return getAppState();
});

ipcMain.handle('app:update-settings', (_event, patch: Partial<AppSettings>) => updateSettings(patch));

ipcMain.handle('app:connect-peer', (_event, host: string, port: number, name: string) => {
  const peer: PeerInfo = {
    id: `${host}:${port}`,
    name: name.trim() || host,
    host,
    port,
    lastSeen: Date.now()
  };
  updatePeer(peer);
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

    store.set('currentRoomId', room.roomId);
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
    const existing = roomManager.getRoom(roomId);
    if (existing && roomManager.isAcceptedMember(roomId, deviceId())) {
      store.set('currentRoomId', roomId);
      sendStateToRenderer();
      return ok(`Switched to ${existing.name}`);
    }

    const advert = roomManager.getAdvert(roomId);
    const target = advert ?? (existing ? roomManager.toAdvert(existing) : undefined);
    if (!target) {
      return fail('That room is no longer on this network.');
    }

    if (target.encrypted && !password) {
      return fail('This room is password protected.');
    }

    const message = baseMessage('room-request');
    message.roomId = roomId;

    if (target.encrypted) {
      const key = deriveRoomKey(password, target.keySalt);
      // Held provisionally so we can open the owner's reply; cleared on rejection.
      roomManager.setKey(roomId, key);
      message.proof = createProof(key, roomId);
    }

    if (target.type === 'private') {
      const code = normalizeJoinCode(joinCode);
      if (!code) {
        return fail('Private rooms need a join code.');
      }
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
    const code = normalizeJoinCode(joinCode);
    if (!code) {
      return fail('Enter the 6-character join code.');
    }

    const owned = roomManager.findRoomByCode(code);
    if (owned) {
      store.set('currentRoomId', owned.roomId);
      sendStateToRenderer();
      return ok(`Switched to ${owned.name}`);
    }

    const discovered = roomManager.getDiscoveredRooms();
    if (discovered.length === 0) {
      return fail('No rooms found on this network yet. Check that both devices are on the same WiFi.');
    }

    // Only the owner can check a code, so the request goes to every advertised
    // room; the ones it does not belong to simply reject it.
    let asked = 0;
    for (const advert of discovered) {
      const message = baseMessage('room-request');
      message.roomId = advert.roomId;
      message.joinCode = code;

      if (advert.encrypted) {
        if (!password) {
          continue;
        }
        const key = deriveRoomKey(password, advert.keySalt);
        roomManager.setKey(advert.roomId, key);
        message.proof = createProof(key, advert.roomId);
      }

      sendUdpMessage(message, advert.host);
      asked += 1;
    }

    if (asked === 0) {
      return fail('The rooms on this network are password protected. Enter the password too.');
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
  sendStateToRenderer();
  return ok(`${room.name} unlocked.`);
});

ipcMain.handle('room:switch', (_event, roomId: string): ActionResult => {
  const room = roomManager.getRoom(roomId);
  if (!room) {
    return fail('Room not found.');
  }

  store.set('currentRoomId', roomId);
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
  const accept = baseMessage('room-accept');
  accept.roomId = roomId;
  accept.targetDeviceId = memberId;
  if (attachRoomBody(accept, room, { room })) {
    fanOut(accept, memberHosts(roomId));
  }

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
  if (store.get('currentRoomId') === roomId) {
    store.set('currentRoomId', undefined);
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

ipcMain.handle('history:clear-room', (_event, roomId: string) => {
  historyManager.clearRoom(roomId);
  notifyHistoryChanged(roomId);
  return ok('History cleared for this room.');
});

ipcMain.handle(
  'chat:send',
  (_event, type: ChatMessage['type'], content: string, roomId: string, dataUrl?: string, fileName?: string): ActionResult => {
    const room = roomManager.getRoom(roomId);
    if (!room) {
      return fail('Join a room before sending messages.');
    }
    if (!roomManager.isAcceptedMember(roomId, deviceId())) {
      return fail('You are not an approved member of this room yet.');
    }

    const chatMessage = historyManager.addChatMessage(
      type,
      content,
      deviceId(),
      deviceName(),
      roomId,
      dataUrl,
      fileName
    );

    const message = baseMessage('chat');
    message.roomId = roomId;
    if (!attachRoomBody(message, room, { chatMessage })) {
      return fail(`${room.name} is locked on this device — unlock it first.`);
    }

    fanOut(message, memberHosts(roomId));
    mainWindow?.webContents.send('chat:message', chatMessage);
    return ok('Sent');
  }
);

ipcMain.handle('clipboard:read', () => readClipboardText());

/** Copy a history entry back onto this machine's clipboard. */
ipcMain.handle('clipboard:apply', (_event, entryId: string): ActionResult => {
  const entry = historyManager.getClipboardHistory().find((candidate) => candidate.id === entryId);
  if (!entry) {
    return fail('That item is no longer in history.');
  }

  if (entry.kind === 'image' && entry.dataUrl) {
    writeClipboardImage(entry.dataUrl);
  } else {
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
  const roomId = store.get('currentRoomId');
  if (!roomId) {
    return fail('Select a room first.');
  }

  const imageDataUrl = getSettings().shareImages ? readClipboardImageDataUrl() : null;
  const payload = imageDataUrl
    ? createImageClipboardPayload(deviceId(), deviceName(), imageDataUrl)
    : createTextClipboardPayload(deviceId(), deviceName(), readClipboardText());

  if (payload.kind === 'text' && !payload.text) {
    return fail('Your clipboard is empty.');
  }

  const hash = hashClipboardPayload(payload);
  lastLocalClipboardHash = hash;
  lastRemoteClipboardHash = hash;
  shareClipboard(payload, roomId);
  return ok('Shared with the room.');
});
