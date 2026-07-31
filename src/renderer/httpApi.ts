import type { AppSettings, AppState } from '../shared/types';
import type { CampusConnectApi } from '../shared/bridge';

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

/** How often the phone asks what changed. Fast enough to feel live, cheap on a LAN. */
const POLL_MS = 1500;

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
const VIEW_KEYS = ['theme', 'fontScale', 'fontFamily'] as const;
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

function notHere(): Promise<never> {
  return Promise.reject(new Error(UNAVAILABLE));
}

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
   * Polling, turned back into the events the interface already expects.
   *
   * Only the listeners that matter on a phone are ever fired. The rest exist so
   * that the interface's `useEffect` blocks can subscribe without special-casing
   * anything, and simply never hear from them.
   */
  const stateListeners = new Set<Listener<AppState>>();
  const historyListeners = new Set<Listener<string>>();
  const chatChangedListeners = new Set<Listener<string>>();

  let lastState = '';
  let lastRoom = '';
  let lastClipCount = -1;
  let lastChatCount = -1;
  let polling = false;

  async function poll() {
    if (polling || stateListeners.size === 0) {
      return;
    }
    polling = true;

    try {
      const state = await localState();
      const serialised = JSON.stringify(state);
      if (serialised !== lastState) {
        lastState = serialised;
        stateListeners.forEach((listener) => listener(state));
      }

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
          historyListeners.forEach((listener) => listener(roomId));
        }
        if (roomId !== lastRoom || chat.length !== lastChatCount) {
          lastChatCount = chat.length;
          chatChangedListeners.forEach((listener) => listener(roomId));
        }
        lastRoom = roomId;
      }
    } catch {
      // A dropped poll is not worth reporting; the next one will say the same.
    } finally {
      polling = false;
    }
  }

  window.setInterval(poll, POLL_MS);
  // A phone spends most of its life with the screen off; catching up on return
  // matters more than the steady tick does.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      void poll();
    }
  });

  function subscribe<T>(set: Set<Listener<T>>, handler: Listener<T>): () => void {
    set.add(handler);
    void poll();
    return () => set.delete(handler);
  }

  /** A subscription to something that never happens here. Unsubscribing is a no-op. */
  const none =
    () =>
    () =>
    () => {
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
    roomApproveMember: (roomId, memberId) => rpc('room:approve-member', roomId, memberId),
    roomRejectMember: (roomId, memberId) => rpc('room:reject-member', roomId, memberId),
    roomRemoveMember: (roomId, memberId) => rpc('room:remove-member', roomId, memberId),
    roomQrCode: (roomId) => rpc('room:qr-code', roomId),
    roomInvite: (roomId, targetDeviceId) => rpc('room:invite', roomId, targetDeviceId),
    roomRespondInvite: (roomId, accept) => rpc('room:respond-invite', roomId, accept),

    historyGetClipboard: (roomId) => rpc('history:get-clipboard', roomId),
    historyGetChat: (roomId) => rpc('history:get-chat', roomId),
    historyDeleteEntry: (entryId) => rpc('history:delete-entry', entryId),
    historyTogglePin: (entryId) => rpc('history:toggle-pin', entryId),
    historyClearRoom: (roomId) => rpc('history:clear-room', roomId),

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

    callStart: () => refuse(),
    callJoin: () => refuse(),
    callLeave: () => refuse(),
    callDecline: () => refuse(),
    callSignal: () => Promise.resolve(false),
    callScreenSources: () => Promise.resolve([]),

    remoteRequest: () => refuse(),
    remoteRespond: () => refuse(),
    remoteSetGrant: () => refuse(),
    remoteEnd: () => refuse(),
    remoteSignal: () => Promise.resolve(false),
    remoteInput: () => Promise.resolve(false),
    remoteScreens: () => Promise.resolve([]),
    remoteCapabilities: () => Promise.resolve({ canControl: false, reason: UNAVAILABLE }),

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

    onStateChanged: (handler) => subscribe(stateListeners, handler),
    onHistoryChanged: (handler) => subscribe(historyListeners, handler),
    onChatChanged: (handler) => subscribe(chatChangedListeners, handler),

    // Nothing on a phone raises these, and nothing needs them to.
    onStatus: none(),
    onChatMessage: none(),
    onReceipts: none(),
    onTyping: none(),
    onCallRing: none(),
    onCallRingCancelled: none(),
    onCallSignal: none(),
    onCallEnded: none(),
    onRemoteRequest: none(),
    onRemoteRequestExpired: none(),
    onRemoteStarted: none(),
    onRemoteSignal: none(),
    onRemoteGrantChanged: none(),
    onRemoteEnded: none(),
    onQuickPasteOpened: none(),
    onUpdateStatus: none(),
    onJoinRequest: none(),
    onInvite: none(),
    onJoinResult: none()
  };
}
