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
  StorageStats
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
    fileName?: string
  ) => Promise<ActionResult>;
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

  readClipboard: () => Promise<string>;
  clipboardApply: (entryId: string) => Promise<ActionResult>;
  clipboardShareNow: () => Promise<ActionResult>;

  onStateChanged: (handler: (state: AppState) => void) => () => void;
  onStatus: (handler: (status: StatusEvent) => void) => () => void;
  onChatMessage: (handler: (message: ChatMessage) => void) => () => void;
  onHistoryChanged: (handler: (roomId: string) => void) => () => void;
  /** Receipts changed for a room; refetch its chat. */
  onReceipts: (handler: (roomId: string) => void) => () => void;
  onJoinRequest: (handler: (request: JoinRequest) => void) => () => void;
  onInvite: (handler: (invite: RoomInvite) => void) => () => void;
  onJoinResult: (handler: (result: JoinResultEvent) => void) => () => void;
};
