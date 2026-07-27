import React from 'react';
import type {
  ActionResult,
  AppSettings,
  AppState,
  ChatMessage,
  ClipboardHistoryEntry,
  DiscoveredRoom,
  RoomInvite,
  RoomType
} from '../shared/types';
import type { StatusTone } from '../shared/bridge';
import { Sidebar } from './sidebar';
import { ChatPanel, ClipboardPanel, MembersPanel } from './panels';
import { CreateRoomModal, InviteModal, JoinRoomModal, UnlockRoomModal } from './modals';
import { SettingsPage } from './settings';
import { Badge, Button, ConfirmModal, EmptyState } from './ui';
import { toFontStack } from './fonts';
import {
  AlertIcon,
  ChatIcon,
  CheckCircleIcon,
  ClipboardIcon,
  GlobeIcon,
  InfoIcon,
  KeyIcon,
  LockIcon,
  MoonIcon,
  PlusIcon,
  ShieldIcon,
  SignalIcon,
  SunIcon,
  UsersIcon,
  XCircleIcon,
  XIcon
} from './icons';

const api = window.sharedClipboard;

type Tab = 'clipboard' | 'chat' | 'members';
type View = 'room' | 'settings';

type Toast = { id: number; message: string; tone: StatusTone };

type ModalState =
  | { kind: 'create' }
  | { kind: 'join'; target: DiscoveredRoom | null }
  | { kind: 'unlock'; roomId: string }
  | { kind: 'invite'; invite: RoomInvite }
  | { kind: 'confirm'; title: string; description: string; confirmLabel: string; action: () => void }
  | null;

const TOAST_MS = 4200;

function useToasts() {
  const [toasts, setToasts] = React.useState<Toast[]>([]);
  const nextId = React.useRef(0);

  const push = React.useCallback((message: string, tone: StatusTone = 'info') => {
    const id = nextId.current++;
    setToasts((current) => [...current, { id, message, tone }].slice(-4));
    setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), TOAST_MS);
  }, []);

  const dismiss = React.useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  return { toasts, push, dismiss };
}

function ToastIcon({ tone }: { tone: StatusTone }) {
  if (tone === 'success') return <CheckCircleIcon size={16} />;
  if (tone === 'warning') return <AlertIcon size={16} />;
  if (tone === 'error') return <XCircleIcon size={16} />;
  return <InfoIcon size={16} />;
}

export default function App() {
  const [state, setState] = React.useState<AppState | null>(null);
  const [clips, setClips] = React.useState<ClipboardHistoryEntry[]>([]);
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [tab, setTab] = React.useState<Tab>('clipboard');
  const [view, setView] = React.useState<View>('room');
  const [modal, setModal] = React.useState<ModalState>(null);
  const { toasts, push, dismiss } = useToasts();

  // Keep the room id in a ref so event handlers registered once still know
  // which room is on screen.
  const currentRoomIdRef = React.useRef<string | undefined>(undefined);
  currentRoomIdRef.current = state?.currentRoomId;

  const searchRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    api.getState().then(setState);

    const unsubscribers = [
      api.onStateChanged(setState),
      api.onStatus(({ message, tone }) => push(message, tone)),
      api.onChatMessage((message) => {
        if (message.roomId === currentRoomIdRef.current) {
          setMessages((current) =>
            current.some((existing) => existing.id === message.id) ? current : [message, ...current]
          );
        }
      }),
      api.onHistoryChanged((roomId) => {
        if (roomId === currentRoomIdRef.current) {
          api.historyGetClipboard(roomId).then(setClips);
        }
      }),
      api.onReceipts((roomId) => {
        if (roomId === currentRoomIdRef.current) {
          api.historyGetChat(roomId).then(setMessages);
        }
      }),
      api.onJoinRequest((request) => {
        push(`${request.deviceName} wants to join ${request.roomName}`, 'warning');
      }),
      api.onInvite((invite) => {
        // Only interrupt if nothing else is open; otherwise it waits in the rail.
        setModal((current) => current ?? { kind: 'invite', invite });
      }),
      api.onJoinResult((result) => {
        push(result.message, result.ok ? 'success' : 'error');
      })
    ];

    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [push]);

  // Load the selected room's history whenever the selection changes.
  const roomId = state?.currentRoomId;
  React.useEffect(() => {
    if (!roomId) {
      setClips([]);
      setMessages([]);
      return;
    }

    api.historyGetClipboard(roomId).then(setClips);
    api.historyGetChat(roomId).then(setMessages);
  }, [roomId]);

  // Acknowledge a room's messages while its chat is actually on screen.
  const chatVisible = view === 'room' && tab === 'chat' && Boolean(roomId);
  React.useEffect(() => {
    if (!chatVisible || !roomId) {
      return;
    }

    const acknowledge = () => {
      if (document.hasFocus()) {
        api.chatMarkSeen(roomId);
      }
    };

    acknowledge();
    window.addEventListener('focus', acknowledge);
    return () => window.removeEventListener('focus', acknowledge);
  }, [chatVisible, roomId, messages.length]);

  // Apply the chosen theme; 'system' means letting the OS preference win.
  const theme = state?.settings.theme ?? 'system';
  React.useEffect(() => {
    if (theme === 'system') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', theme);
    }
  }, [theme]);

  // Typography: the whole type scale multiplies by --text-scale, and picking a
  // font overrides --font-sans, so both apply everywhere at once.
  const fontScale = state?.settings.fontScale ?? 1;
  const fontFamily = state?.settings.fontFamily ?? '';
  React.useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--text-scale', String(fontScale));

    const stack = toFontStack(fontFamily);
    if (stack) {
      root.style.setProperty('--font-sans', stack);
    } else {
      root.style.removeProperty('--font-sans');
    }
  }, [fontScale, fontFamily]);

  // Ctrl+1..9 switches rooms, Ctrl+F focuses the history search. Both are
  // suppressed while a dialog is open or the caret is in a field, so they can
  // never fire mid-password.
  const roomIds = state?.rooms.map((candidate) => candidate.roomId).join(',') ?? '';
  const modalOpen = modal !== null;
  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!event.ctrlKey && !event.metaKey) {
        return;
      }
      if (modalOpen) {
        return;
      }

      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable === true;

      if (event.key.toLowerCase() === 'f') {
        event.preventDefault();
        setTab('clipboard');
        // Wait for the panel to mount if the tab just changed.
        requestAnimationFrame(() => searchRef.current?.focus());
        return;
      }

      if (typing) {
        return;
      }

      if (event.key === 'Enter') {
        event.preventDefault();
        api.clipboardShareNow().then((result) => push(result.message, result.ok ? 'success' : 'error'));
        return;
      }

      const digit = Number(event.key);
      if (!Number.isInteger(digit) || digit < 1 || digit > 9) {
        return;
      }

      const ids = roomIds ? roomIds.split(',') : [];
      const targetRoomId = ids[digit - 1];
      if (!targetRoomId) {
        return;
      }

      event.preventDefault();
      setView('room');
      api.roomSwitch(targetRoomId).then(() => setTab('clipboard'));
    }

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [roomIds, modalOpen]);

  async function run(action: Promise<ActionResult>): Promise<boolean> {
    const result = await action;
    push(result.message, result.ok ? 'success' : 'error');
    return result.ok;
  }

  if (!state) {
    return (
      <div className="splash">
        <span className="splash__dot" />
        <span>Starting Shared Clipboard…</span>
      </div>
    );
  }

  const lockedRoomIds = new Set(state.lockedRoomIds);
  const room = state.rooms.find((candidate) => candidate.roomId === state.currentRoomId);
  const isLocked = room ? lockedRoomIds.has(room.roomId) : false;
  const isOwner = room?.ownerId === state.deviceId;
  const pendingCount = isOwner
    ? (room?.members.filter((member) => member.status === 'pending').length ?? 0)
    : 0;
  const memberCount = room?.members.filter((member) => member.status === 'accepted').length ?? 0;

  function toggleTheme() {
    const next: AppSettings['theme'] =
      theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark';
    api.updateSettings({ theme: next }).then(setState);
  }

  return (
    <div className="app">
      <Sidebar
        state={state}
        lockedRoomIds={lockedRoomIds}
        onSelectRoom={(id) => {
          setView('room');
          api.roomSwitch(id).then(() => setTab('clipboard'));
        }}
        onCreateRoom={() => setModal({ kind: 'create' })}
        onJoinByCode={() => setModal({ kind: 'join', target: null })}
        onJoinDiscovered={(target) => setModal({ kind: 'join', target })}
        onOpenInvite={(invite) => setModal({ kind: 'invite', invite })}
        onOpenSettings={() => setView((current) => (current === 'settings' ? 'room' : 'settings'))}
        settingsOpen={view === 'settings'}
      />

      <main className="main">
        <header className="topbar">
          {view === 'settings' ? (
            <>
              <div className="topbar__title">
                <span className="topbar__name">Settings</span>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setView('room')}>
                <XIcon size={14} />
                Close
              </Button>
            </>
          ) : room ? (
            <>
              <div className="topbar__title">
                <span className="topbar__name">{room.name}</span>
              </div>
              <Badge tone={room.type === 'private' ? 'accent' : 'neutral'}>
                {room.type === 'private' ? <LockIcon size={11} /> : <GlobeIcon size={11} />}
                {room.type === 'private' ? 'Private' : 'Public'}
              </Badge>
              {room.encrypted ? (
                <Badge tone="success">
                  <ShieldIcon size={11} />
                  Encrypted
                </Badge>
              ) : (
                <Badge tone="warning">
                  <AlertIcon size={11} />
                  Not encrypted
                </Badge>
              )}
              <Badge>
                <UsersIcon size={11} />
                {memberCount}
              </Badge>
            </>
          ) : (
            <div className="topbar__title">
              <span className="topbar__name">Shared Clipboard</span>
            </div>
          )}

          <span className="topbar__spacer" />

          <div className="topbar__actions">
            <span
              className="text-sm text-tertiary row"
              title={`${state.peers.length} device(s) seen on ${state.localAddress}`}
            >
              <SignalIcon size={14} />
              {state.peers.length}
            </span>
            <Button
              variant="ghost"
              icon
              onClick={toggleTheme}
              aria-label={`Theme: ${theme}. Click to change.`}
              title={`Theme: ${theme}`}
            >
              {theme === 'dark' ? <MoonIcon size={15} /> : <SunIcon size={15} />}
            </Button>
          </div>
        </header>

        {view === 'room' && room && !isLocked && (
          <nav className="tabbar">
            <button
              className={tab === 'clipboard' ? 'tabbar__tab is-active' : 'tabbar__tab'}
              onClick={() => setTab('clipboard')}
            >
              <ClipboardIcon size={14} />
              Clipboard
              {clips.length > 0 ? <span className="tabbar__count">{clips.length}</span> : null}
            </button>
            <button
              className={tab === 'chat' ? 'tabbar__tab is-active' : 'tabbar__tab'}
              onClick={() => setTab('chat')}
            >
              <ChatIcon size={14} />
              Chat
              {messages.length > 0 ? <span className="tabbar__count">{messages.length}</span> : null}
            </button>
            <button
              className={tab === 'members' ? 'tabbar__tab is-active' : 'tabbar__tab'}
              onClick={() => setTab('members')}
            >
              <UsersIcon size={14} />
              Members
              {pendingCount > 0 ? (
                <span className="tabbar__count is-alert">{pendingCount}</span>
              ) : null}
            </button>
          </nav>
        )}

        {view === 'settings' ? (
          <div className="panel">
            <SettingsPage
              state={state}
              onRename={(name) => api.updateDeviceName(name).then(setState)}
              onUpdateSettings={(patch) => api.updateSettings(patch).then(setState)}
              onConnectPeer={(host) => api.connectPeer(host, state.listenPort, '').then(setState)}
              onOpenExternal={(url) => {
                api.openExternal(url).then((result) => {
                  if (!result.ok) {
                    push(result.message, 'error');
                  }
                });
              }}
              onCompactStorage={() => run(api.storageCompact())}
            />
          </div>
        ) : !room ? (
          <div className="panel">
            <EmptyState
              icon={<ClipboardIcon size={22} />}
              title={state.rooms.length === 0 ? 'Create your first room' : 'Pick a room'}
              text={
                state.rooms.length === 0
                  ? 'Rooms decide who can see what you copy. Make a private one for yourself, or a public one to share with everyone on this WiFi.'
                  : 'Choose a room from the left to start sharing your clipboard with it.'
              }
              actions={
                state.rooms.length === 0 ? (
                  <>
                    <Button variant="primary" onClick={() => setModal({ kind: 'create' })}>
                      <PlusIcon size={15} />
                      New room
                    </Button>
                    <Button onClick={() => setModal({ kind: 'join', target: null })}>
                      <KeyIcon size={15} />
                      Join a room
                    </Button>
                  </>
                ) : undefined
              }
            />
          </div>
        ) : isLocked ? (
          <div className="panel">
            <EmptyState
              icon={<LockIcon size={22} />}
              title={`${room.name} is locked`}
              text="This room is encrypted and this device does not hold its key yet. Enter the room password to read and share here."
              actions={
                <>
                  <Button variant="primary" onClick={() => setModal({ kind: 'unlock', roomId: room.roomId })}>
                    <KeyIcon size={15} />
                    Enter password
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() =>
                      setModal({
                        kind: 'confirm',
                        title: `Leave ${room.name}?`,
                        description: `You will stop receiving anything shared in ${room.name}, and its history on this device is deleted. You can rejoin with the code and password.`,
                        confirmLabel: 'Leave room',
                        action: () => run(api.roomLeave(room.roomId))
                      })
                    }
                  >
                    Leave room
                  </Button>
                </>
              }
            />
          </div>
        ) : tab === 'chat' ? (
          <div className="panel panel--flush">
            <ChatPanel
              room={room}
              messages={messages}
              deviceId={state.deviceId}
              onSend={(text) => {
                api.chatSend('text', text, room.roomId).then((result) => {
                  if (!result.ok) {
                    push(result.message, 'error');
                  }
                });
              }}
              onSendFile={() => run(api.chatSendFile(room.roomId))}
              onSaveFile={(messageId) => run(api.chatSaveFile(messageId))}
            />
          </div>
        ) : (
          <div className="panel">
            {tab === 'clipboard' ? (
              <ClipboardPanel
                room={room}
                entries={clips}
                deviceId={state.deviceId}
                searchRef={searchRef}
                onCopy={(entryId) => run(api.clipboardApply(entryId))}
                onDelete={(entryId) => run(api.historyDeleteEntry(entryId))}
                onTogglePin={(entryId) => run(api.historyTogglePin(entryId))}
                onShareNow={() => run(api.clipboardShareNow())}
                onClear={() =>
                  setModal({
                    kind: 'confirm',
                    title: `Clear history for ${room.name}?`,
                    description:
                      'Every clipboard item and message in this room is deleted from this device, including pinned items. Other devices keep their own copies.',
                    confirmLabel: 'Clear history',
                    action: () => run(api.historyClearRoom(room.roomId))
                  })
                }
              />
            ) : (
              <MembersPanel
                room={room}
                deviceId={state.deviceId}
                onApprove={(memberId) => run(api.roomApproveMember(room.roomId, memberId))}
                onReject={(memberId) => run(api.roomRejectMember(room.roomId, memberId))}
                onRemove={(memberId) => {
                  const name =
                    room.members.find((member) => member.deviceId === memberId)?.deviceName ?? 'This device';
                  setModal({
                    kind: 'confirm',
                    title: `Remove ${name}?`,
                    description: `${name} will lose access to ${room.name} immediately and will not be able to read anything shared from now on. They can request to join again.`,
                    confirmLabel: 'Remove',
                    action: () => run(api.roomRemoveMember(room.roomId, memberId))
                  });
                }}
                onLeave={() =>
                  setModal({
                    kind: 'confirm',
                    title: isOwner ? `Close ${room.name}?` : `Leave ${room.name}?`,
                    description: isOwner
                      ? `Closing removes ${room.name} for everyone in it, along with its history on this device. This cannot be undone.`
                      : `You will stop receiving anything shared in ${room.name}, and its history on this device is deleted. You can rejoin with the code and password.`,
                    confirmLabel: isOwner ? 'Close room' : 'Leave room',
                    action: () => run(api.roomLeave(room.roomId))
                  })
                }
                onCopyCode={(code) => {
                  navigator.clipboard.writeText(code);
                  push('Join code copied.', 'success');
                }}
                onRequestQr={(id) => api.roomQrCode(id)}
                peers={state.peers}
                invitedIds={state.invitedDeviceIds[room.roomId] ?? []}
                onInvite={(targetDeviceId) => run(api.roomInvite(room.roomId, targetDeviceId))}
              />
            )}
          </div>
        )}
      </main>

      {modal?.kind === 'create' && (
        <CreateRoomModal
          onClose={() => setModal(null)}
          onCreate={(name, type: RoomType, password) => run(api.roomCreate(name, type, password))}
        />
      )}

      {modal?.kind === 'join' && (
        <JoinRoomModal
          target={modal.target}
          onClose={() => setModal(null)}
          onJoinDiscovered={(id, password, code) => run(api.roomRequestJoin(id, password, code))}
          onJoinByCode={(code, password) => run(api.roomJoinByCode(code, password))}
        />
      )}

      {modal?.kind === 'unlock' && room && (
        <UnlockRoomModal
          room={room}
          onClose={() => setModal(null)}
          onUnlock={(id, password) => run(api.roomUnlock(id, password))}
        />
      )}

      {modal?.kind === 'invite' && (
        <InviteModal
          invite={modal.invite}
          onClose={() => setModal(null)}
          onRespond={(roomId, accept) => run(api.roomRespondInvite(roomId, accept))}
        />
      )}

      {modal?.kind === 'confirm' && (
        <ConfirmModal
          title={modal.title}
          description={modal.description}
          confirmLabel={modal.confirmLabel}
          onConfirm={modal.action}
          onClose={() => setModal(null)}
        />
      )}

      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast--${toast.tone}`} onClick={() => dismiss(toast.id)}>
            <span className="toast__icon">
              <ToastIcon tone={toast.tone} />
            </span>
            <span className="toast__message">{toast.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
