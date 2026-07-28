import { contextBridge, ipcRenderer } from 'electron';
import type { SharedClipboardApi } from '../shared/bridge';

/** Wraps an ipcRenderer channel as a subscribe function that returns its own unsubscribe. */
function subscribe<T>(channel: string, handler: (value: T) => void): () => void {
  const listener = (_event: unknown, value: T) => handler(value);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const api: SharedClipboardApi = {
  getState: () => ipcRenderer.invoke('app:get-state'),
  updateDeviceName: (deviceName) => ipcRenderer.invoke('app:update-device-name', deviceName),
  updateSettings: (patch) => ipcRenderer.invoke('app:update-settings', patch),
  connectPeer: (host, port, name) => ipcRenderer.invoke('app:connect-peer', host, port, name),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),

  roomCreate: (name, type, password) => ipcRenderer.invoke('room:create', name, type, password),
  roomRequestJoin: (roomId, password, joinCode) =>
    ipcRenderer.invoke('room:request-join', roomId, password, joinCode),
  roomJoinByCode: (joinCode, password) => ipcRenderer.invoke('room:join-by-code', joinCode, password),
  roomUnlock: (roomId, password) => ipcRenderer.invoke('room:unlock', roomId, password),
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

  chatSend: (type, content, roomId, dataUrl, fileName) =>
    ipcRenderer.invoke('chat:send', type, content, roomId, dataUrl, fileName),
  chatSendFile: (roomId) => ipcRenderer.invoke('chat:send-file', roomId),
  chatSaveFile: (messageId) => ipcRenderer.invoke('chat:save-file', messageId),
  chatMarkSeen: (roomId) => ipcRenderer.invoke('chat:mark-seen', roomId),

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
  onUpdateStatus: (handler) => subscribe('update:status', handler),
  onJoinRequest: (handler) => subscribe('room:join-request', handler),
  onInvite: (handler) => subscribe('room:invite', handler),
  onJoinResult: (handler) => subscribe('room:join-result', handler)
};

contextBridge.exposeInMainWorld('sharedClipboard', api);
