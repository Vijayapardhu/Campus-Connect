import type {
  ActionResult,
  AppSettings,
  AppState,
  ChatMessage,
  ClipboardHistoryEntry,
  JoinRequest,
  RoomType
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

  roomCreate: (name: string, type: RoomType, password: string) => Promise<ActionResult>;
  roomRequestJoin: (roomId: string, password: string, joinCode: string) => Promise<ActionResult>;
  roomJoinByCode: (joinCode: string, password: string) => Promise<ActionResult>;
  roomUnlock: (roomId: string, password: string) => Promise<ActionResult>;
  roomSwitch: (roomId: string) => Promise<ActionResult>;
  roomLeave: (roomId: string) => Promise<ActionResult>;
  roomApproveMember: (roomId: string, memberId: string) => Promise<ActionResult>;
  roomRejectMember: (roomId: string, memberId: string) => Promise<ActionResult>;
  roomRemoveMember: (roomId: string, memberId: string) => Promise<ActionResult>;

  historyGetClipboard: (roomId?: string) => Promise<ClipboardHistoryEntry[]>;
  historyGetChat: (roomId?: string) => Promise<ChatMessage[]>;
  historyDeleteEntry: (entryId: string) => Promise<ActionResult>;
  historyClearRoom: (roomId: string) => Promise<ActionResult>;

  chatSend: (
    type: ChatMessage['type'],
    content: string,
    roomId: string,
    dataUrl?: string,
    fileName?: string
  ) => Promise<ActionResult>;

  readClipboard: () => Promise<string>;
  clipboardApply: (entryId: string) => Promise<ActionResult>;
  clipboardShareNow: () => Promise<ActionResult>;

  onStateChanged: (handler: (state: AppState) => void) => () => void;
  onStatus: (handler: (status: StatusEvent) => void) => () => void;
  onChatMessage: (handler: (message: ChatMessage) => void) => () => void;
  onHistoryChanged: (handler: (roomId: string) => void) => () => void;
  onJoinRequest: (handler: (request: JoinRequest) => void) => () => void;
  onJoinResult: (handler: (result: JoinResultEvent) => void) => () => void;
};
