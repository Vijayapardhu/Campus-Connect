import type {
  ActionResult,
  AppSettings,
  AppState,
  CallMode,
  CallRinging,
  CallSignal,
  CallWindowIntent,
  ChatMessage,
  ClipboardHistoryEntry,
  ConnectivityResult,
  DeepLink,
  DirectMessage,
  JoinRequest,
  RemoteCapabilities,
  RemoteGrant,
  RemoteInputEvent,
  RemoteRequest,
  RemoteSessionState,
  RemoteSignal,
  RoomInvite,
  SearchHit,
  Snippet,
  RoomType,
  RoomUpdate,
  StorageStats,
  UpdateStatus,
  WindowState
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

/**
 * A call setup step that arrived for us, with the sender attached.
 *
 * The identity comes from the enclosing wire message, which the main process
 * has already checked against the room's roster — so the renderer can trust
 * `fromDeviceId` and does not have to take the body's word for anything.
 */
export type CallSignalEvent = {
  roomId: string;
  fromDeviceId: string;
  fromDeviceName: string;
  signal: CallSignal;
};

/**
 * Starting or joining a call hands back everything the renderer needs to
 * negotiate under it — including for a call it is joining late, where the room
 * and the mode were decided by whoever started it.
 */
export type CallStartResult = ActionResult & {
  callId?: string;
  roomId?: string;
  mode?: CallMode;
};

/** A screen or window offered up for sharing. The thumbnail is a PNG data URL. */
export type ScreenSource = {
  id: string;
  name: string;
  kind: 'screen' | 'window';
  thumbnail: string;
  /**
   * The display id the `screen` module knows this source by, straight from
   * desktopCapturer. The `id` field's `screen:ZZ:0` middle segment is a
   * sequential number, not a display id, so this is the only reliable link
   * between a captured screen and the rectangle the pointer must be mapped
   * into. Empty when the platform does not report it.
   */
  displayId: string;
};

/** One step of remote desktop setup that arrived for us, with the sender attached. */
export type RemoteSignalEvent = {
  roomId: string;
  fromDeviceId: string;
  fromDeviceName: string;
  signal: RemoteSignal;
};

/** What the quick-paste overlay renders. Sent whole, so it needs no follow-ups. */
export type QuickPasteItems = {
  clips: ClipboardHistoryEntry[];
  snippets: Snippet[];
  /** roomId -> name, so an entry can say where it came from. */
  roomNames: Record<string, string>;
};

/** The complete surface exposed to the renderer as `window.campusConnect`. */
export type CampusConnectApi = {
  getState: () => Promise<AppState>;
  updateDeviceName: (deviceName: string) => Promise<AppState>;
  updateSettings: (patch: Partial<AppSettings>) => Promise<AppState>;
  connectPeer: (host: string, port: number, name: string) => Promise<AppState>;
  /** Opens one of the project's own links in the system browser. Allowlisted. */
  openExternal: (url: string) => Promise<ActionResult>;
  /**
   * Opens a link that came out of the clipboard. Unknowable by definition, so
   * strictly http/https only — never `file://`, `javascript:` or a scheme some
   * other installed application registered.
   */
  openLink: (url: string) => Promise<ActionResult>;

  roomCreate: (name: string, type: RoomType, password: string) => Promise<ActionResult>;
  roomRequestJoin: (roomId: string, password: string, joinCode: string) => Promise<ActionResult>;
  roomJoinByCode: (joinCode: string, password: string) => Promise<ActionResult>;
  roomUnlock: (roomId: string, password: string) => Promise<ActionResult>;
  /**
   * Owner only. Renames a room, changes its type, reissues its join code, or
   * re-keys it. Re-keying locks every other member out until they enter the new
   * password.
   */
  roomUpdate: (roomId: string, patch: RoomUpdate) => Promise<ActionResult>;
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

  /**
   * Calls. The main process only ever relays setup and tracks who is in what;
   * the microphone, the camera and the peer connections all live in the renderer.
   */
  /** Rings the whole room, or — with `targetDeviceId` — just that one member directly. */
  callStart: (roomId: string, mode: CallMode, targetDeviceId?: string) => Promise<CallStartResult>;
  /** Answers a ring, or joins a call already under way in a room. */
  callJoin: (callId: string) => Promise<CallStartResult>;
  callLeave: () => Promise<ActionResult>;
  callDecline: (callId: string) => Promise<ActionResult>;
  /** Carries one negotiation step to the room. Refused for a call you are not in. */
  callSignal: (signal: CallSignal) => Promise<boolean>;
  /** The screens and windows on offer. Listing them captures nothing. */
  callScreenSources: () => Promise<ScreenSource[]>;
  /**
   * Opens the call window — creating it if this is the first call — and tells
   * it what to do once it is ready. Ringing opens the window on its own; this
   * is for the button that places or joins one from the main window.
   */
  callWindowOpen: (intent: CallWindowIntent) => Promise<void>;
  /** The call window's one-time pull of what it was opened to do. */
  callWindowTakeIntent: () => Promise<CallWindowIntent | null>;

  /**
   * Remote desktop. The screen travels over WebRTC and input over its data
   * channel; none of it passes through the main process except the setup and
   * the one gate that decides whether an input event may be applied.
   */
  remoteRequest: (roomId: string, targetDeviceId: string) => Promise<ActionResult>;
  /**
   * The host's answer, and the only way a screen ever starts being shared.
   * `grant` chooses viewing or control; `screenId` is the display picked and
   * `displayId` is the screen-module id for it that the pointer maps into.
   */
  remoteRespond: (
    sessionId: string,
    allow: boolean,
    grant: RemoteGrant,
    screenId: string,
    screenLabel: string,
    displayId?: string
  ) => Promise<ActionResult>;
  /** Host only. Hands control over, or takes it back, without ending the session. */
  remoteSetGrant: (grant: RemoteGrant) => Promise<ActionResult>;
  remoteEnd: () => Promise<ActionResult>;
  remoteSignal: (signal: RemoteSignal) => Promise<boolean>;
  /**
   * Applies one input event to this machine. Refused unless there is a live
   * session, this device is the host, and control has been granted.
   */
  remoteInput: (sessionId: string, fromDeviceId: string, event: RemoteInputEvent) => Promise<boolean>;
  /** Whole displays only — a window cannot be clicked on reliably. */
  remoteScreens: () => Promise<ScreenSource[]>;
  remoteCapabilities: () => Promise<RemoteCapabilities>;

  /**
   * Claims the `campusconnect://` link that brought the app here, if any.
   * Single-use: a reload cannot reopen a dialog already dealt with.
   */
  takeDeepLink: () => Promise<DeepLink | null>;
  /** Links that arrive while the app is already running. */
  onDeepLink: (handler: (link: DeepLink) => void) => () => void;

  /**
   * The window's own controls. `windowClose` means whatever the system's close
   * button meant — for this app, hide to the tray rather than quit.
   */
  windowState: () => Promise<WindowState | null>;
  windowMinimize: () => Promise<void>;
  windowToggleMaximize: () => Promise<void>;
  windowClose: () => Promise<void>;
  onWindowState: (handler: (state: WindowState) => void) => () => void;

  /**
   * Peer-to-peer file sharing.
   *
   * The order matters and is the whole safety story: the sender asks by name
   * only, the receiver answers, and only then does a picker open. Nothing is
   * read off disk, and no files are named, until somebody has said yes.
   */
  fileShareRequest: (peerId: string, peerName: string) => Promise<ActionResult>;
  fileShareRespond: (transferId: string, accept: boolean) => Promise<ActionResult>;
  /** Sender only, after acceptance. Opens the native picker and streams. */
  fileSharePick: (transferId: string) => Promise<ActionResult>;
  fileShareCancel: (transferId: string) => Promise<ActionResult>;
  /** Drops a finished transfer from the list. Saved files are untouched. */
  fileShareDismiss: (transferId: string) => Promise<void>;
  fileShareOpenFolder: () => Promise<void>;

  /**
   * Direct 1:1 messages. Same reach as file sharing — any device currently
   * visible on the network, no room in common required.
   */
  dmSend: (peerId: string, peerName: string, content: string) => Promise<ActionResult>;
  dmGetThread: (peerId: string) => Promise<DirectMessage[]>;
  dmMarkRead: (peerId: string) => Promise<void>;
  /** A message arrived, either direction — the renderer already knows which. */
  onDmMessage: (handler: (message: DirectMessage) => void) => () => void;

  /**
   * Blocking. Total and local: nothing from a blocked device is read, stored,
   * shown or answered. Blocking also removes that device from every room this
   * one owns — rooms owned by others cannot be policed from here.
   */
  blockDevice: (deviceId: string, deviceName: string) => Promise<ActionResult>;
  unblockDevice: (deviceId: string) => Promise<ActionResult>;

  /**
   * The quick-paste overlay. A second, frameless window on a global hotkey —
   * these are called from it, not from the main window.
   */
  quickPasteItems: () => Promise<QuickPasteItems>;
  /** Copies the pick, then pastes it into whatever had focus. */
  quickPastePick: (kind: 'clip' | 'snippet', id: string) => Promise<ActionResult>;
  quickPasteClose: () => Promise<void>;

  /** Saved text, local to this device and never sent anywhere. */
  snippetSave: (input: { id?: string; label: string; content: string }) => Promise<ActionResult>;
  snippetDelete: (id: string) => Promise<ActionResult>;
  snippetCopy: (id: string) => Promise<ActionResult>;

  /** Clipboard history and chat, every room at once. */
  searchAll: (query: string) => Promise<SearchHit[]>;

  /**
   * Phone access. Serves one room to a browser on the same network, behind a
   * rate-limited PIN. Off unless started, and never restored on startup.
   */
  phoneStart: () => Promise<ActionResult>;
  phoneStop: () => Promise<ActionResult>;
  /** Cuts one connected phone off; it has to enter the PIN again. */
  phoneRevoke: (connectedAt: number) => Promise<ActionResult>;
  /** PNG data URL of the address, so nobody types an IP on a phone. */
  phoneQrCode: () => Promise<string | null>;

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
  /** Someone is calling a room this device is in. */
  onCallRing: (handler: (ring: CallRinging) => void) => () => void;
  /** A ring stopped being offered — answered elsewhere, withdrawn, or timed out. */
  onCallRingCancelled: (handler: (callId: string) => void) => () => void;
  /** A negotiation step for the call this device is in. */
  onCallSignal: (handler: (event: CallSignalEvent) => void) => () => void;
  /** The call this device was in is over, whoever ended it. */
  onCallEnded: (handler: (callId: string) => void) => () => void;

  /** Overlay only: it was opened, here is what to show. */
  onQuickPasteOpened: (handler: (items: QuickPasteItems) => void) => () => void;

  /** Someone is asking to see this screen. Nothing is shared until you allow it. */
  onRemoteRequest: (handler: (request: RemoteRequest) => void) => () => void;
  /** A request nobody answered stopped being offered. */
  onRemoteRequestExpired: (handler: (sessionId: string) => void) => () => void;
  onRemoteStarted: (handler: (session: RemoteSessionState) => void) => () => void;
  onRemoteSignal: (handler: (event: RemoteSignalEvent) => void) => () => void;
  /** The host handed control over, or took it back, mid-session. */
  onRemoteGrantChanged: (handler: (grant: RemoteGrant) => void) => () => void;
  onRemoteEnded: (handler: (event: { sessionId: string; reason: string }) => void) => () => void;

  onUpdateStatus: (handler: (status: UpdateStatus) => void) => () => void;
  onJoinRequest: (handler: (request: JoinRequest) => void) => () => void;
  onInvite: (handler: (invite: RoomInvite) => void) => () => void;
  onJoinResult: (handler: (result: JoinResultEvent) => void) => () => void;
};
