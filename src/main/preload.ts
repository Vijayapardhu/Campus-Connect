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
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  openLink: (url) => ipcRenderer.invoke('app:open-link', url),

  roomCreate: (name, type, password) => ipcRenderer.invoke('room:create', name, type, password),
  roomRequestJoin: (roomId, password, joinCode) =>
    ipcRenderer.invoke('room:request-join', roomId, password, joinCode),
  roomJoinByCode: (joinCode, password) => ipcRenderer.invoke('room:join-by-code', joinCode, password),
  roomUnlock: (roomId, password) => ipcRenderer.invoke('room:unlock', roomId, password),
  roomUpdate: (roomId, patch) => ipcRenderer.invoke('room:update', roomId, patch),
  roomSwitch: (roomId) => ipcRenderer.invoke('room:switch', roomId),
  roomLeave: (roomId) => ipcRenderer.invoke('room:leave', roomId),
  roomApproveMember: (roomId, memberId) => ipcRenderer.invoke('room:approve-member', roomId, memberId),
  roomRejectMember: (roomId, memberId) => ipcRenderer.invoke('room:reject-member', roomId, memberId),
  roomRemoveMember: (roomId, memberId) => ipcRenderer.invoke('room:remove-member', roomId, memberId),
  roomQrCode: (roomId) => ipcRenderer.invoke('room:qr-code', roomId),
  roomInvite: (roomId, targetDeviceId) => ipcRenderer.invoke('room:invite', roomId, targetDeviceId),
  roomRespondInvite: (roomId, accept) => ipcRenderer.invoke('room:respond-invite', roomId, accept),

  historyGetClipboard: (roomId) => ipcRenderer.invoke('history:get-clipboard', roomId),
  historyGetChat: (roomId) => ipcRenderer.invoke('history:get-chat', roomId),
  historyDeleteEntry: (entryId) => ipcRenderer.invoke('history:delete-entry', entryId),
  historyTogglePin: (entryId) => ipcRenderer.invoke('history:toggle-pin', entryId),
  historyClearRoom: (roomId) => ipcRenderer.invoke('history:clear-room', roomId),

  chatSend: (type, content, roomId, dataUrl, fileName, replyToId) =>
    ipcRenderer.invoke('chat:send', type, content, roomId, dataUrl, fileName, replyToId),
  chatEdit: (messageId, content) => ipcRenderer.invoke('chat:edit', messageId, content),
  chatDelete: (messageId, forEveryone) => ipcRenderer.invoke('chat:delete', messageId, forEveryone),
  chatReact: (messageId, emoji) => ipcRenderer.invoke('chat:react', messageId, emoji),
  chatTyping: (roomId, typing) => ipcRenderer.invoke('chat:typing', roomId, typing),
  chatSendFile: (roomId) => ipcRenderer.invoke('chat:send-file', roomId),
  chatSaveFile: (messageId) => ipcRenderer.invoke('chat:save-file', messageId),
  chatMarkSeen: (roomId) => ipcRenderer.invoke('chat:mark-seen', roomId),

  callStart: (roomId, mode) => ipcRenderer.invoke('call:start', roomId, mode),
  callJoin: (callId) => ipcRenderer.invoke('call:join', callId),
  callLeave: () => ipcRenderer.invoke('call:leave'),
  callDecline: (callId) => ipcRenderer.invoke('call:decline', callId),
  callSignal: (signal) => ipcRenderer.invoke('call:signal', signal),
  callScreenSources: () => ipcRenderer.invoke('call:screen-sources'),

  remoteRequest: (roomId, targetDeviceId) => ipcRenderer.invoke('remote:request', roomId, targetDeviceId),
  remoteRespond: (sessionId, allow, grant, screenId, screenLabel) =>
    ipcRenderer.invoke('remote:respond', sessionId, allow, grant, screenId, screenLabel),
  remoteSetGrant: (grant) => ipcRenderer.invoke('remote:set-grant', grant),
  remoteEnd: () => ipcRenderer.invoke('remote:end'),
  remoteSignal: (signal) => ipcRenderer.invoke('remote:signal', signal),
  remoteInput: (sessionId, fromDeviceId, event) =>
    ipcRenderer.invoke('remote:input', sessionId, fromDeviceId, event),
  remoteScreens: () => ipcRenderer.invoke('remote:screens'),
  remoteCapabilities: () => ipcRenderer.invoke('remote:capabilities'),

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
  onQuickPasteOpened: (handler) => subscribe('quick-paste:opened', handler),

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
