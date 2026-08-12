import type { AppSettings, AppState } from '../shared/types';
import type { CampusConnectApi } from '../shared/bridge';
import { openEventStream } from './eventStream';

/**
 * The same API surface, over HTTP instead of Electron IPC.
 *
 * A phone browser has no preload script and no `window.campusConnect`, so this
 * builds one. Every call becomes an RPC to the desktop, which runs the very same
 * handler the desktop's own interface would have run — which is the point. There
 * is no separate mobile implementation of "send this message" to fall behind the
 * real one.
 *
 * Two things the desktop gets for free have to be built here:
 *
 *  - **Events.** IPC pushes; HTTP does not. State is polled and the difference
 *    is turned back into the same `onStateChanged` and friends the interface
 *    already listens to, so nothing above this layer knows which it is talking
 *    to.
 *  - **Refusal.** Plenty of the API is desktop-only — calls, remote desktop,
 *    native file dialogs, the quick-paste overlay. Those return a clear "not on
 *    this device" rather than hanging or throwing, so the interface can simply
 *    hide them and nothing breaks if it misses one.
 */

/**
 * How often the phone reconciles against the desktop's full state.
 *
 * Was a second and a half, because polling *was* the transport. Now that
 * changes are pushed, this only exists to repair a gap — a stream dropped
 * while the phone slept, an event missed mid-reconnect — so it can be far
 * slower, which a phone's battery notices and nothing else does.
 */
const POLL_MS = 20000;

const TOKEN_KEY = 'campus-connect-token';

type Listener<T> = (value: T) => void;

/**
 * Whether this is a browser rather than the Electron window, decided **once**.
 *
 * Evaluated when the module loads, which on a phone is before anything has had
 * a chance to install the HTTP bridge. Asking the question later returns the
 * wrong answer, because by then `window.campusConnect` exists on both — which
 * is exactly the bug that stopped the phone's home screen from appearing.
 */
const PHONE_CLIENT = typeof window !== 'undefined' && !('campusConnect' in window);

export function isPhoneClient(): boolean {
  return PHONE_CLIENT;
}

/**
 * Whether this device can do the things only a computer can.
 *
 * Calls, remote desktop, peer-to-peer file transfer and every native dialog
 * are refused on a phone. The refusals below were written so the interface
 * could hide those affordances — and then nothing did, so a phone showed a
 * full set of buttons whose only possible outcome was "that is only available
 * on the computer". A button that can never work is worse than no button.
 */
export function hasNativeFeatures(): boolean {
  return !PHONE_CLIENT;
}

/**
 * Whether this page may ask for a microphone and a camera.
 *
 * `isSecureContext` is the browser's own answer to the question that decides
 * whether a call is possible here, so it is asked directly rather than inferred
 * from the URL or from a setting the desktop reports. On the desktop it is
 * always true; on a phone it is true exactly when phone access is being served
 * with a certificate.
 */
export function canUseMedia(): boolean {
  if (!PHONE_CLIENT) {
    return true;
  }
  return typeof window !== 'undefined' && window.isSecureContext === true;
}

export function storedToken(): string {
  try {
    return window.localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function storeToken(token: string): void {
  try {
    // localStorage, not sessionStorage: pairing is meant to survive closing the
    // tab, otherwise the PIN comes back every time and the point is lost.
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Private browsing. The session still works; it just will not be remembered.
  }
}

export function forgetToken(): void {
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Nothing to forget.
  }
}

/** Asks the desktop whether this phone is paired. */
export async function checkPairing(): Promise<boolean> {
  const token = storedToken();
  if (!token) {
    return false;
  }

  try {
    const response = await fetch('/api/session', { headers: { Authorization: `Bearer ${token}` } });
    const body = await response.json();
    return Boolean(body?.paired);
  } catch {
    return false;
  }
}

/**
 * The single-use key carried in a scanned link, if there is one.
 *
 * Taken out of the address bar immediately afterwards. Leaving it there would
 * put a credential in the browser history, in the tab title, and in whatever
 * the phone syncs its open tabs to.
 */
export function scannedKey(): string {
  const key = new URLSearchParams(window.location.search).get('k') ?? '';
  if (key) {
    window.history.replaceState(null, '', window.location.pathname);
  }
  return key;
}

/** Redeems a scanned key for a remembered pairing. Returns an error, or ''. */
export async function pairWithKey(key: string): Promise<string> {
  try {
    const response = await fetch('/api/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, label: navigator.userAgent })
    });

    const body = await response.json();
    if (!response.ok || !body?.token) {
      return String(body?.message ?? 'That link is no longer valid.');
    }

    storeToken(body.token);
    return '';
  } catch {
    return 'Could not reach the computer. Check you are on the same WiFi.';
  }
}

/**
 * A direct call, outside the typed bridge.
 *
 * Used by the phone-only actions, which have no desktop equivalent and so have
 * no business widening the shared API surface that every other module sees.
 */
export async function rawRpc<T>(method: string, ...args: unknown[]): Promise<T> {
  const response = await fetch('/api/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${storedToken()}` },
    body: JSON.stringify({ method, args })
  });

  const body = await response.json();
  if (!response.ok || !body?.ok) {
    throw new Error(String(body?.message ?? 'That did not work.'));
  }
  return body.result as T;
}

/**
 * Preferences that belong to the device looking, not to the machine.
 *
 * A phone in a dark room and a laptop under a desk lamp want different themes,
 * and somebody reading chat on their phone should not drag the laptop's open
 * room along with them. These are kept on the phone and merged over whatever the
 * laptop reports, so each device decides its own view while everything that is
 * genuinely about the machine — sharing, notifications, retention — stays shared.
 */
const VIEW_KEYS = ['theme', 'fontScale', 'fontFamily', 'hasOnboarded'] as const;
const LOCAL_KEY = 'campus-connect-view';

type LocalView = {
  settings: Partial<AppSettings>;
  currentRoomId?: string;
};

function readLocalView(): LocalView {
  try {
    const stored = JSON.parse(window.localStorage.getItem(LOCAL_KEY) ?? '{}') as Partial<LocalView>;
    return { ...stored, settings: stored.settings ?? {} };
  } catch {
    return { settings: {} };
  }
}

function writeLocalView(view: LocalView): void {
  try {
    window.localStorage.setItem(LOCAL_KEY, JSON.stringify(view));
  } catch {
    // Private browsing. The choice still applies for this session.
  }
}

/** Refused, in the shape each caller expects. */
const UNAVAILABLE = 'That is only available on the computer.';


function refuse() {
  return Promise.resolve({ ok: false, message: UNAVAILABLE });
}

export function createHttpApi(onUnpaired: () => void): CampusConnectApi {
  const token = () => storedToken();
  let view = readLocalView();

  /** The laptop's state, with this device's own view laid over the top. */
  async function localState(): Promise<AppState> {
    const state = await rpc<AppState>('app:get-state');
    const room = view.currentRoomId;

    return {
      ...state,
      settings: { ...state.settings, ...view.settings },
      // Only honour a remembered room that still exists.
      currentRoomId: room && state.rooms.some((r) => r.roomId === room) ? room : state.currentRoomId
    };
  }

  async function rpc<T>(method: string, ...args: unknown[]): Promise<T> {
    const response = await fetch('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
      body: JSON.stringify({ method, args })
    });

    if (response.status === 401) {
      // The desktop switched phone access off, or unpaired this phone.
      forgetToken();
      onUnpaired();
      throw new Error('This phone is no longer paired.');
    }

    const body = await response.json();
    if (!response.ok || !body?.ok) {
      throw new Error(String(body?.message ?? 'That did not work.'));
    }
    return body.result as T;
  }

  /*
   * Events, pushed rather than polled for.
   *
   * One set of listeners per IPC channel, keyed by the same channel name the
   * desktop uses — so an event the window would have received is delivered to
   * exactly the listener the window would have delivered it to, and nothing
   * above this layer knows which transport it came over.
   *
   * Polling stays, slowed right down, as reconciliation. A stream that drops
   * while the phone is asleep can miss whatever happened in the gap; a periodic
   * full state read means the interface is never wrong for longer than that,
   * even if it is briefly late.
   */
  const channels = new Map<string, Set<Listener<never>>>();

  function listeners<T>(channel: string): Set<Listener<T>> {
    let set = channels.get(channel);
    if (!set) {
      set = new Set();
      channels.set(channel, set);
    }
    return set as unknown as Set<Listener<T>>;
  }

  function on<T>(channel: string, handler: Listener<T>): () => void {
    const set = listeners<T>(channel);
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  function fire<T>(channel: string, value: T): void {
    listeners<T>(channel).forEach((handler) => handler(value));
  }

  let lastState = '';
  let lastRoom = '';
  let lastClipCount = -1;
  let lastChatCount = -1;
  let polling = false;

  /**
   * Reads the whole state, fires the change only if it actually changed, and
   * hands the state back so a caller that needs it does not fetch it again.
   */
  async function refreshState(): Promise<AppState> {
    const state = await localState();
    const serialised = JSON.stringify(state);
    if (serialised !== lastState) {
      lastState = serialised;
      fire('app:state-changed', state);
    }
    return state;
  }

  async function poll() {
    if (polling || listeners('app:state-changed').size === 0) {
      return;
    }
    polling = true;

    try {
      const state = await refreshState();
      const roomId = state.currentRoomId ?? '';
      if (roomId) {
        // Counts rather than contents: cheap to compare, and enough to know
        // that something arrived and the panels should refetch.
        const [clips, chat] = await Promise.all([
          rpc<unknown[]>('history:get-clipboard', roomId),
          rpc<unknown[]>('history:get-chat', roomId)
        ]);

        if (roomId !== lastRoom || clips.length !== lastClipCount) {
          lastClipCount = clips.length;
          fire('history:changed', roomId);
        }
        if (roomId !== lastRoom || chat.length !== lastChatCount) {
          lastChatCount = chat.length;
          fire('chat:changed', roomId);
        }
        lastRoom = roomId;
      }
    } catch {
      // A dropped poll is not worth reporting; the next one will say the same.
    } finally {
      polling = false;
    }
  }

  /*
   * Only once there is a token to present. Opened unconditionally, an unpaired
   * phone spent the whole pairing screen in a 401 reconnect loop — and its
   * first successful read would have tripped the unpaired handler.
   */
  let stopStream: (() => void) | null = null;

  function ensureStream(): void {
    if (stopStream || !token()) {
      return;
    }
    stopStream = openEventStream(
      () => token(),
      (event) => {
        /*
         * The desktop's state, with this device's own view laid over the top —
         * the theme and the open room are local. Taking the pushed payload
         * as-is would drag the laptop's room onto the phone every time
         * anything changed, so the push is a prompt to re-read, not the answer.
         */
        if (event.channel === 'app:state-changed') {
          void refreshState();
          return;
        }
        fire(event.channel, event.payload as never);
      },
      () => void refreshState()
    );
  }

  ensureStream();

  window.setInterval(() => {
    // Pairing happens on this page, so the stream starts the moment it can.
    ensureStream();
    void poll();
  }, POLL_MS);
  // A phone spends most of its life with the screen off; catching up on return
  // matters more than the steady tick does.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      void poll();
    }
  });

  /** Subscribing also kicks a poll, so a fresh listener is not left waiting. */
  function subscribe<T>(channel: string, handler: Listener<T>): () => void {
    const off = on<T>(channel, handler);
    void poll();
    return off;
  }

  /**
   * A subscription to something that genuinely cannot happen here.
   *
   * Only for the desktop's own chrome — the window's controls and the links the
   * operating system hands it. Everything else now arrives over the stream, so
   * this list being short is the point.
   */
  const none =
    () =>
    () =>
    () => {
      /* nothing to unsubscribe from */
    };

  /** Unsubscribing from something that was never subscribed to. */
  const noop = () => {
    /* nothing to unsubscribe from */
  };

  return {
    getState: () => localState(),
    updateDeviceName: (name) => rpc('app:update-device-name', name),
    updateSettings: async (patch) => {
      /*
       * Split in two: how it looks stays here, what the machine does goes there.
       * Sending the theme to the laptop would repaint the laptop, which is
       * exactly what somebody changing it on their phone does not want.
       */
      const local: Partial<AppSettings> = {};
      const shared: Partial<AppSettings> = {};

      for (const [key, value] of Object.entries(patch)) {
        if ((VIEW_KEYS as readonly string[]).includes(key)) {
          (local as Record<string, unknown>)[key] = value;
        } else {
          (shared as Record<string, unknown>)[key] = value;
        }
      }

      if (Object.keys(local).length > 0) {
        view = { ...view, settings: { ...view.settings, ...local } };
        writeLocalView(view);
      }
      if (Object.keys(shared).length > 0) {
        await rpc('app:update-settings', shared);
      }

      return await localState();
    },
    connectPeer: (host, port, name) => rpc('app:connect-peer', host, port, name),
    forgetPeer: (host, port) => rpc('app:forget-peer', host, port),
    openExternal: (url) => rpc('app:open-external', url),
    openLink: (url) => rpc('app:open-link', url),

    roomCreate: (name, type, password) => rpc('room:create', name, type, password),
    roomRequestJoin: (roomId, password, joinCode) =>
      rpc('room:request-join', roomId, password, joinCode),
    roomJoinByCode: (joinCode, password) => rpc('room:join-by-code', joinCode, password),
    roomUnlock: (roomId, password) => rpc('room:unlock', roomId, password),
    roomUpdate: (roomId, patch) => rpc('room:update', roomId, patch),
    roomSwitch: async (roomId) => {
      // Remembered here only. Switching the laptop as well would move the room
      // out from under whoever is sitting at it.
      view = { ...view, currentRoomId: roomId };
      writeLocalView(view);
      return { ok: true, message: '' };
    },
    roomLeave: (roomId) => rpc('room:leave', roomId),
    networkReset: () => rpc('network:reset'),
    roomApproveMember: (roomId, memberId) => rpc('room:approve-member', roomId, memberId),
    roomRejectMember: (roomId, memberId) => rpc('room:reject-member', roomId, memberId),
    roomRemoveMember: (roomId, memberId) => rpc('room:remove-member', roomId, memberId),
    roomSetRestrictions: (roomId, memberId, restrictions) =>
      rpc('room:set-restrictions', roomId, memberId, restrictions),
    roomQrCode: (roomId) => rpc('room:qr-code', roomId),
    roomInvite: (roomId, targetDeviceId) => rpc('room:invite', roomId, targetDeviceId),
    roomRespondInvite: (roomId, accept) => rpc('room:respond-invite', roomId, accept),

    historyGetClipboard: (roomId) => rpc('history:get-clipboard', roomId),
    historyGetChat: (roomId) => rpc('history:get-chat', roomId),
    historyDeleteEntry: (entryId) => rpc('history:delete-entry', entryId),
    historyTogglePin: (entryId) => rpc('history:toggle-pin', entryId),
    historyClearRoom: (roomId) => rpc('history:clear-room', roomId),
    // The save dialog, and the file it writes, belong to the desktop.
    historyExport: () => refuse(),
    // A pin is per-device state, and the desktop is the device that holds it.
    chatTogglePin: (messageId) => rpc('chat:toggle-pin', messageId),
    dmTogglePin: () => refuse(),

    chatSend: (type, content, roomId, dataUrl, fileName, replyToId) =>
      rpc('chat:send', type, content, roomId, dataUrl, fileName, replyToId),
    chatEdit: (messageId, content) => rpc('chat:edit', messageId, content),
    chatDelete: (messageId, forEveryone) => rpc('chat:delete', messageId, forEveryone),
    chatReact: (messageId, emoji) => rpc('chat:react', messageId, emoji),
    chatTyping: async (roomId, typing) => {
      await rpc('chat:typing', roomId, typing).catch(() => undefined);
    },
    // Native pickers belong to the machine with the files on it.
    chatSendFile: () => refuse(),
    chatSaveFile: () => refuse(),
    chatMarkSeen: (roomId) => rpc('chat:mark-seen', roomId),

    /*
     * Real calls, once the page is a secure origin. The desktop runs the same
     * handlers it runs for its own window; the phone is simply another peer in
     * the mesh, negotiating over the event stream like everybody else.
     */
    callStart: (roomId, mode) =>
      canUseMedia() ? rpc('call:start', roomId, mode) : refuse(),
    callJoin: (callId) => (canUseMedia() ? rpc('call:join', callId) : refuse()),
    callLeave: () => (canUseMedia() ? rpc('call:leave') : refuse()),
    callDecline: (callId) => (canUseMedia() ? rpc('call:decline', callId) : refuse()),
    callSignal: (signal) =>
      canUseMedia() ? rpc('call:signal', signal) : Promise.resolve(false),
    // A phone has no desktop to capture, on any transport.
    callScreenSources: () => Promise.resolve([]),
    // A phone has no second window to open one in — it never calls these;
    // present only to satisfy the shared type.
    callWindowOpen: () => Promise.resolve(),
    callWindowTakeIntent: () => Promise.resolve(null),

    remoteRequest: () => refuse(),
    remoteRespond: () => refuse(),
    remoteSetGrant: () => refuse(),
    remoteEnd: () => refuse(),
    remoteSignal: () => Promise.resolve(false),
    remoteInput: () => Promise.resolve(false),
    remoteScreens: () => Promise.resolve([]),
    remoteCapabilities: () => Promise.resolve({ canControl: false, reason: UNAVAILABLE }),
    // A phone has no floating indicator window to hide — remote desktop is
    // refused outright there already.
    remoteHideIndicator: () => Promise.resolve(),

    // A phone reaches the app through its own paired URL, not a desktop scheme.
    takeDeepLink: () => Promise.resolve(null),

    // A browser tab has no window to drive; the controls are never drawn.
    windowState: () => Promise.resolve(null),
    windowMinimize: () => Promise.resolve(),
    windowToggleMaximize: () => Promise.resolve(),
    windowClose: () => Promise.resolve(),

    // File sharing moves files between two machines' disks. A phone has neither
    // end of that, so it is refused outright rather than half-supported.
    fileShareRequest: () => refuse(),
    fileShareRespond: () => refuse(),
    fileSharePick: () => refuse(),
    fileShareCancel: () => refuse(),
    fileShareDismiss: () => Promise.resolve(),
    fileShareOpenFolder: () => Promise.resolve(),

    // Native-only, the same as file sharing and remote desktop — a phone has
    // no place of its own to keep a message thread outside of a room's chat.
    dmSend: () => refuse(),
    dmSendFile: () => refuse(),
    dmEdit: () => refuse(),
    dmDelete: () => refuse(),
    dmReact: () => refuse(),
    dmSaveFile: () => refuse(),
    dmGetThread: () => Promise.resolve([]),
    dmMarkRead: () => Promise.resolve(),
    dmArchiveThread: () => Promise.resolve(),
    dmDeleteThread: () => Promise.resolve(),
    dmExport: () => refuse(),
    // A phone never reaches this — DMs are refused outright above, so there is
    // never a thread to place a call from — but the type needs a body.
    dmEnsureCallRoom: () => Promise.reject(new Error(UNAVAILABLE)),
    dmTyping: () => Promise.resolve(),

    quickPasteItems: () => Promise.resolve({ clips: [], snippets: [], roomNames: {} }),
    quickPastePick: () => refuse(),
    quickPasteClose: () => Promise.resolve(),

    snippetSave: (input) => rpc('snippet:save', input),
    snippetDelete: (id) => rpc('snippet:delete', id),
    snippetCopy: (id) => rpc('snippet:copy', id),

    searchAll: (query) => rpc('search:all', query),

    phoneStart: () => rpc('phone:start'),
    phoneStop: () => rpc('phone:stop'),
    phoneRevoke: (pairedAt) => rpc('phone:revoke', pairedAt),
    phoneQrCode: () => rpc('phone:qr-code'),

    blockDevice: (deviceId, deviceName) => rpc('privacy:block', deviceId, deviceName),
    unblockDevice: (deviceId) => rpc('privacy:unblock', deviceId),

    storageStats: () => rpc('storage:stats'),
    storageCompact: () => rpc('storage:compact'),
    networkTest: (host) => rpc('network:test', host),

    updateCheck: () => rpc('update:check'),
    updateDownload: () => rpc('update:download'),
    // Restarting the laptop into an update is not something to do by accident
    // from a pocket.
    updateInstall: () => refuse(),

    readClipboard: () => rpc('clipboard:read'),
    clipboardApply: (entryId) => rpc('clipboard:apply', entryId),
    clipboardShareNow: () => rpc('clipboard:share-now'),


    onStatus: (handler) => subscribe('sync:status', handler),
    onChatMessage: (handler) => subscribe('chat:message', handler),
    onReceipts: (handler) => subscribe('chat:receipts', handler),
    onTyping: (handler) => subscribe('chat:typing', handler),
    onCallRing: (handler) => (canUseMedia() ? subscribe('call:ring', handler) : noop),
    onCallRingCancelled: (handler) => (canUseMedia() ? subscribe('call:ring-cancelled', handler) : noop),
    onCallSignal: (handler) => (canUseMedia() ? subscribe('call:signal', handler) : noop),
    onCallEnded: (handler) => (canUseMedia() ? subscribe('call:ended', handler) : noop),
    onStateChanged: (handler) => subscribe('app:state-changed', handler),
    onHistoryChanged: (handler) => subscribe('history:changed', handler),
    onChatChanged: (handler) => subscribe('chat:changed', handler),

    /*
     * Events this device could hear but could do nothing about.
     *
     * The stream carries everything the desktop emits, so subscribing is a
     * choice rather than a limitation — and a ring that cannot be answered is
     * an unanswerable dialog. Calls subscribe only when the page is a secure
     * origin, because that is exactly when they can be answered.
     *
     * Remote desktop never can: it injects input by screen coordinate through a
     * native module. The rest is the desktop's own window chrome and the links
     * the operating system hands it, which a browser tab does not have.
     */
    onDeepLink: none(),
    onWindowState: none(),
    onRemoteRequest: none(),
    onRemoteRequestExpired: none(),
    onRemoteStarted: none(),
    onRemoteSignal: none(),
    onRemoteGrantChanged: none(),
    onRemoteEnded: none(),
    onDmMessage: none(),
    onDmTyping: none(),
    onQuickPasteOpened: none(),
    onUpdateStatus: (handler) => subscribe('update:status', handler),
    onJoinRequest: (handler) => subscribe('room:join-request', handler),
    onInvite: (handler) => subscribe('room:invite', handler),
    onJoinResult: (handler) => subscribe('room:join-result', handler)
  };
}
