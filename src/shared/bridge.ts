import type {
  ActionResult,
  AppSettings,
  AppState,
  ChatMessage,
  ClipboardHistoryEntry,
  ConnectivityResult,
  JoinRequest,
  RoomInvite,
  RoomType,
  StorageStats,
  UpdateStatus
} from './types';

export type StatusTone = 'info' | 'success' | 'warning' | 'error';

export type StatusEvent = {
  message: string;
  tone: StatusTone;
};

export type JoinResultEvent = {
  roomId: string;
  ok: boolean;
  message: string;
};

export type TypingEvent = {
  roomId: string;
  deviceId: string;
  deviceName: string;
  typing: boolean;
};

/** The complete surface exposed to the renderer as `window.sharedClipboard`. */
export type SharedClipboardApi = {
  getState: () => Promise<AppState>;
  updateDeviceName: (deviceName: string) => Promise<AppState>;
  updateSettings: (patch: Partial<AppSettings>) => Promise<AppState>;
  connectPeer: (host: string, port: number, name: string) => Promise<AppState>;
  /** Opens one of the project's own links in the system browser. Allowlisted. */
  openExternal: (url: string) => Promise<ActionResult>;

  roomCreate: (name: string, type: RoomType, password: string) => Promise<ActionResult>;
  roomRequestJoin: (roomId: string, password: string, joinCode: string) => Promise<ActionResult>;
  roomJoinByCode: (joinCode: string, password: string) => Promise<ActionResult>;
  roomUnlock: (roomId: string, password: string) => Promise<ActionResult>;
  roomSwitch: (roomId: string) => Promise<ActionResult>;
  roomLeave: (roomId: string) => Promise<ActionResult>;
  roomApproveMember: (roomId: string, memberId: string) => Promise<ActionResult>;
  roomRejectMember: (roomId: string, memberId: string) => Promise<ActionResult>;
  roomRemoveMember: (roomId: string, memberId: string) => Promise<ActionResult>;
  /** PNG data URL of the room's join code, or null if it has none. */
  roomQrCode: (roomId: string) => Promise<string | null>;
  /** Owner only. Invites a device seen on the network; sends no credentials. */
  roomInvite: (roomId: string, targetDeviceId: string) => Promise<ActionResult>;
  /** Answer an invitation. Accepting only joins the owner's approval queue. */
  roomRespondInvite: (roomId: string, accept: boolean) => Promise<ActionResult>;

  historyGetClipboard: (roomId?: string) => Promise<ClipboardHistoryEntry[]>;
  historyGetChat: (roomId?: string) => Promise<ChatMessage[]>;
  historyDeleteEntry: (entryId: string) => Promise<ActionResult>;
  historyTogglePin: (entryId: string) => Promise<ActionResult>;
  historyClearRoom: (roomId: string) => Promise<ActionResult>;

  chatSend: (
    type: ChatMessage['type'],
    content: string,
    roomId: string,
    dataUrl?: string,
    fileName?: string,
    /** Id of the message being answered; the quote is built from history. */
    replyToId?: string
  ) => Promise<ActionResult>;
  /** Rewrites your own message, everywhere. */
  chatEdit: (messageId: string, content: string) => Promise<ActionResult>;
  /**
   * Removes a message. `forEveryone` withdraws it from the room and is only
   * allowed on your own; without it, only this device forgets it.
   */
  chatDelete: (messageId: string, forEveryone: boolean) => Promise<ActionResult>;
  /** Adds this device's reaction, or takes it back if it is already there. */
  chatReact: (messageId: string, emoji: string) => Promise<ActionResult>;
  /** Tells the room whether this device is composing. Never stored. */
  chatTyping: (roomId: string, typing: boolean) => Promise<void>;
  /** Opens a native picker, then sends the chosen file into the room. */
  chatSendFile: (roomId: string) => Promise<ActionResult>;
  /** Opens a native save dialog for a received file. Never opens the file. */
  chatSaveFile: (messageId: string) => Promise<ActionResult>;
  /** Acknowledge every message in a room as read. */
  chatMarkSeen: (roomId: string) => Promise<ActionResult>;

  storageStats: () => Promise<StorageStats>;
  /** Apply the retention window and size ceiling now. */
  storageCompact: () => Promise<ActionResult>;

  /** Tests which transports reach a specific address. */
  networkTest: (host: string) => Promise<ConnectivityResult>;

  updateCheck: () => Promise<UpdateStatus>;
  updateDownload: () => Promise<UpdateStatus>;
  /** Restarts into the new version, or opens the download page on macOS. */
  updateInstall: () => Promise<ActionResult>;

  readClipboard: () => Promise<string>;
  clipboardApply: (entryId: string) => Promise<ActionResult>;
  clipboardShareNow: () => Promise<ActionResult>;

  onStateChanged: (handler: (state: AppState) => void) => () => void;
  onStatus: (handler: (status: StatusEvent) => void) => () => void;
  onChatMessage: (handler: (message: ChatMessage) => void) => () => void;
  onHistoryChanged: (handler: (roomId: string) => void) => () => void;
  /** Receipts changed for a room; refetch its chat. */
  onReceipts: (handler: (roomId: string) => void) => () => void;
  /** A message in this room was edited, withdrawn or reacted to; refetch. */
  onChatChanged: (handler: (roomId: string) => void) => () => void;
  /** Someone started or stopped composing. */
  onTyping: (handler: (event: TypingEvent) => void) => () => void;
  onUpdateStatus: (handler: (status: UpdateStatus) => void) => () => void;
  onJoinRequest: (handler: (request: JoinRequest) => void) => () => void;
  onInvite: (handler: (invite: RoomInvite) => void) => () => void;
  onJoinResult: (handler: (result: JoinResultEvent) => void) => () => void;
};
