import { contextBridge, ipcRenderer } from 'electron';
import type { CampusConnectApi } from '../shared/bridge';

/** Wraps an ipcRenderer channel as a subscribe function that returns its own unsubscribe. */
function subscribe<T>(channel: string, handler: (value: T) => void): () => void {
  const listener = (_event: unknown, value: T) => handler(value);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const api: CampusConnectApi = {
  getState: () => ipcRenderer.invoke('app:get-state'),
  updateDeviceName: (deviceName) => ipcRenderer.invoke('app:update-device-name', deviceName),
  updateSettings: (patch) => ipcRenderer.invoke('app:update-settings', patch),
  connectPeer: (host, port, name) => ipcRenderer.invoke('app:connect-peer', host, port, name),
  forgetPeer: (host, port) => ipcRenderer.invoke('app:forget-peer', host, port),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  openLink: (url) => ipcRenderer.invoke('app:open-link', url),

  roomCreate: (name, type, password, requireApproval) =>
    ipcRenderer.invoke('room:create', name, type, password, requireApproval),
  roomRequestJoin: (roomId, password, joinCode) =>
    ipcRenderer.invoke('room:request-join', roomId, password, joinCode),
  roomJoinByCode: (joinCode, password) => ipcRenderer.invoke('room:join-by-code', joinCode, password),
  roomUnlock: (roomId, password) => ipcRenderer.invoke('room:unlock', roomId, password),
  roomUpdate: (roomId, patch) => ipcRenderer.invoke('room:update', roomId, patch),
  roomSwitch: (roomId) => ipcRenderer.invoke('room:switch', roomId),
  roomLeave: (roomId) => ipcRenderer.invoke('room:leave', roomId),
  networkReset: () => ipcRenderer.invoke('network:reset'),
  roomApproveMember: (roomId, memberId) => ipcRenderer.invoke('room:approve-member', roomId, memberId),
  roomRejectMember: (roomId, memberId) => ipcRenderer.invoke('room:reject-member', roomId, memberId),
  roomRemoveMember: (roomId, memberId) => ipcRenderer.invoke('room:remove-member', roomId, memberId),
  roomSetRestrictions: (roomId, memberId, restrictions) =>
    ipcRenderer.invoke('room:set-restrictions', roomId, memberId, restrictions),
  roomQrCode: (roomId) => ipcRenderer.invoke('room:qr-code', roomId),
  roomInvite: (roomId, targetDeviceId) => ipcRenderer.invoke('room:invite', roomId, targetDeviceId),
  roomRespondInvite: (roomId, accept) => ipcRenderer.invoke('room:respond-invite', roomId, accept),

  historyGetClipboard: (roomId) => ipcRenderer.invoke('history:get-clipboard', roomId),
  historyGetChat: (roomId) => ipcRenderer.invoke('history:get-chat', roomId),
  historyDeleteEntry: (entryId) => ipcRenderer.invoke('history:delete-entry', entryId),
  historyTogglePin: (entryId) => ipcRenderer.invoke('history:toggle-pin', entryId),
  historyClearRoom: (roomId) => ipcRenderer.invoke('history:clear-room', roomId),
  historyExport: (roomId) => ipcRenderer.invoke('history:export', roomId),
  chatTogglePin: (messageId) => ipcRenderer.invoke('chat:toggle-pin', messageId),
  dmTogglePin: (peerId, messageId) => ipcRenderer.invoke('dm:toggle-pin', peerId, messageId),

  chatSend: (type, content, roomId, dataUrl, fileName, replyToId) =>
    ipcRenderer.invoke('chat:send', type, content, roomId, dataUrl, fileName, replyToId),
  chatEdit: (messageId, content) => ipcRenderer.invoke('chat:edit', messageId, content),
  chatDelete: (messageId, forEveryone) => ipcRenderer.invoke('chat:delete', messageId, forEveryone),
  chatReact: (messageId, emoji) => ipcRenderer.invoke('chat:react', messageId, emoji),
  chatTyping: (roomId, typing) => ipcRenderer.invoke('chat:typing', roomId, typing),
  chatSendFile: (roomId) => ipcRenderer.invoke('chat:send-file', roomId),
  chatSaveFile: (messageId) => ipcRenderer.invoke('chat:save-file', messageId),
  chatMarkSeen: (roomId) => ipcRenderer.invoke('chat:mark-seen', roomId),

  callStart: (roomId, mode, targetDeviceId) =>
    ipcRenderer.invoke('call:start', roomId, mode, targetDeviceId),
  callJoin: (callId) => ipcRenderer.invoke('call:join', callId),
  callLeave: () => ipcRenderer.invoke('call:leave'),
  callDecline: (callId) => ipcRenderer.invoke('call:decline', callId),
  callSignal: (signal) => ipcRenderer.invoke('call:signal', signal),
  callScreenSources: () => ipcRenderer.invoke('call:screen-sources'),
  callWindowOpen: (intent) => ipcRenderer.invoke('call-window:open', intent),
  callWindowTakeIntent: () => ipcRenderer.invoke('call-window:take-intent'),

  remoteRequest: (roomId, targetDeviceId) => ipcRenderer.invoke('remote:request', roomId, targetDeviceId),
  remoteRespond: (sessionId, allow, grant, screenId, screenLabel, displayId) =>
    ipcRenderer.invoke('remote:respond', sessionId, allow, grant, screenId, screenLabel, displayId),
  remoteSetGrant: (grant) => ipcRenderer.invoke('remote:set-grant', grant),
  remoteEnd: () => ipcRenderer.invoke('remote:end'),
  remoteSignal: (signal) => ipcRenderer.invoke('remote:signal', signal),
  remoteInput: (sessionId, fromDeviceId, event) =>
    ipcRenderer.invoke('remote:input', sessionId, fromDeviceId, event),
  remoteScreens: () => ipcRenderer.invoke('remote:screens'),
  remoteCapabilities: () => ipcRenderer.invoke('remote:capabilities'),
  remoteHideIndicator: () => ipcRenderer.invoke('remote:hide-indicator'),

  takeDeepLink: () => ipcRenderer.invoke('app:take-deep-link'),

  windowState: () => ipcRenderer.invoke('window:state'),
  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowToggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
  windowClose: () => ipcRenderer.invoke('window:close'),

  fileShareRequest: (peerId, peerName) => ipcRenderer.invoke('files:request', peerId, peerName),
  fileShareRespond: (transferId, accept) => ipcRenderer.invoke('files:respond', transferId, accept),
  fileSharePick: (transferId) => ipcRenderer.invoke('files:pick', transferId),
  fileShareCancel: (transferId) => ipcRenderer.invoke('files:cancel', transferId),
  fileShareDismiss: (transferId) => ipcRenderer.invoke('files:dismiss', transferId),
  fileShareOpenFolder: () => ipcRenderer.invoke('files:open-folder'),

  dmSend: (peerId, peerName, type, content, dataUrl, fileName, replyToId) =>
    ipcRenderer.invoke('dm:send', peerId, peerName, type, content, dataUrl, fileName, replyToId),
  dmSendFile: (peerId, peerName) => ipcRenderer.invoke('dm:send-file', peerId, peerName),
  dmEdit: (peerId, messageId, content) => ipcRenderer.invoke('dm:edit', peerId, messageId, content),
  dmDelete: (peerId, messageId, forEveryone) =>
    ipcRenderer.invoke('dm:delete', peerId, messageId, forEveryone),
  dmReact: (peerId, messageId, emoji) => ipcRenderer.invoke('dm:react', peerId, messageId, emoji),
  dmSaveFile: (peerId, messageId) => ipcRenderer.invoke('dm:save-file', peerId, messageId),
  dmGetThread: (peerId) => ipcRenderer.invoke('dm:get-thread', peerId),
  dmMarkRead: (peerId) => ipcRenderer.invoke('dm:mark-read', peerId),
  dmArchiveThread: (peerId, archived) => ipcRenderer.invoke('dm:archive-thread', peerId, archived),
  dmDeleteThread: (peerId) => ipcRenderer.invoke('dm:delete-thread', peerId),
  dmExport: (peerId) => ipcRenderer.invoke('dm:export', peerId),
  dmEnsureCallRoom: (peerId, peerName) => ipcRenderer.invoke('dm:ensure-call-room', peerId, peerName),
  dmTyping: (peerId, typing) => ipcRenderer.invoke('dm:typing', peerId, typing),

  blockDevice: (deviceId, deviceName) => ipcRenderer.invoke('privacy:block', deviceId, deviceName),
  unblockDevice: (deviceId) => ipcRenderer.invoke('privacy:unblock', deviceId),

  quickPasteItems: () => ipcRenderer.invoke('quick-paste:items'),
  quickPastePick: (kind, id) => ipcRenderer.invoke('quick-paste:pick', kind, id),
  quickPasteClose: () => ipcRenderer.invoke('quick-paste:close'),

  snippetSave: (input) => ipcRenderer.invoke('snippet:save', input),
  snippetDelete: (id) => ipcRenderer.invoke('snippet:delete', id),
  snippetCopy: (id) => ipcRenderer.invoke('snippet:copy', id),

  searchAll: (query) => ipcRenderer.invoke('search:all', query),

  phoneStart: () => ipcRenderer.invoke('phone:start'),
  phoneStop: () => ipcRenderer.invoke('phone:stop'),
  phoneRevoke: (connectedAt) => ipcRenderer.invoke('phone:revoke', connectedAt),
  phoneQrCode: () => ipcRenderer.invoke('phone:qr-code'),

  storageStats: () => ipcRenderer.invoke('storage:stats'),
  storageCompact: () => ipcRenderer.invoke('storage:compact'),
  networkTest: (host) => ipcRenderer.invoke('network:test', host),

  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateDownload: () => ipcRenderer.invoke('update:download'),
  updateInstall: () => ipcRenderer.invoke('update:install'),

  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  clipboardApply: (entryId) => ipcRenderer.invoke('clipboard:apply', entryId),
  clipboardShareNow: () => ipcRenderer.invoke('clipboard:share-now'),

  onStateChanged: (handler) => subscribe('app:state-changed', handler),
  onStatus: (handler) => subscribe('sync:status', handler),
  onChatMessage: (handler) => subscribe('chat:message', handler),
  onHistoryChanged: (handler) => subscribe('history:changed', handler),
  onReceipts: (handler) => subscribe('chat:receipts', handler),
  onChatChanged: (handler) => subscribe('chat:changed', handler),
  onTyping: (handler) => subscribe('chat:typing', handler),
  onCallRing: (handler) => subscribe('call:ring', handler),
  onCallRingCancelled: (handler) => subscribe('call:ring-cancelled', handler),
  onCallSignal: (handler) => subscribe('call:signal', handler),
  onCallEnded: (handler) => subscribe('call:ended', handler),
  onDmMessage: (handler) => subscribe('dm:message', handler),
  onDmTyping: (handler) => subscribe('dm:typing', handler),
  onQuickPasteOpened: (handler) => subscribe('quick-paste:opened', handler),

  onDeepLink: (handler) => subscribe('app:deep-link', handler),
  onWindowState: (handler) => subscribe('window:state', handler),

  onRemoteRequest: (handler) => subscribe('remote:request', handler),
  onRemoteRequestExpired: (handler) => subscribe('remote:request-expired', handler),
  onRemoteStarted: (handler) => subscribe('remote:started', handler),
  onRemoteSignal: (handler) => subscribe('remote:signal', handler),
  onRemoteGrantChanged: (handler) => subscribe('remote:grant-changed', handler),
  onRemoteEnded: (handler) => subscribe('remote:ended', handler),
  onUpdateStatus: (handler) => subscribe('update:status', handler),
  onJoinRequest: (handler) => subscribe('room:join-request', handler),
  onInvite: (handler) => subscribe('room:invite', handler),
  onJoinResult: (handler) => subscribe('room:join-result', handler)
};

contextBridge.exposeInMainWorld('campusConnect', api);
