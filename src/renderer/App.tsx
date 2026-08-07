import React from 'react';
import type {
  ActionResult,
  AppSettings,
  AppState,
  ChatMessage,
  ClipboardHistoryEntry,
  DeepLink,
  DiscoveredRoom,
  RoomInfo,
  RoomInvite,
  RoomType,
  SearchHit
} from '../shared/types';
import { Sidebar } from './sidebar';
import { ChatPanel, ClipboardPanel, MembersPanel } from './panels';
import { CreateRoomModal, EditRoomModal, InviteModal, JoinRoomModal, UnlockRoomModal } from './modals';
import { SettingsPage } from './settings';
import { Badge, Button, ConfirmModal, EmptyState, Toasts, useToasts } from './ui';
import {
  CallInProgressBanner,
  CallStage,
  IncomingCallModal,
  ScreenPickerModal,
  useCall
} from './callui';
import { RemoteHostBar, RemoteRequestModal, useRemote } from './remoteui';
import { FileRequestModal, FilesPanel, useFileShare } from './filesharing';
import { DmPanel, useDirectMessage } from './directMessages';
import { WindowControls, hasWindowControls, useWindowState } from './windowcontrols';
import { Onboarding } from './onboarding';
import { CommandPalette, type Command, type PaletteMode } from './palette';
import { toFontStack } from './fonts';
import {
  AlertIcon,
  ChatIcon,
  ChevronLeftIcon,
  ClipboardIcon,
  GlobeIcon,
  KeyIcon,
  LockIcon,
  MoonIcon,
  BookmarkIcon,
  MonitorIcon,
  PaperclipIcon,
  PhoneIcon,
  PlusIcon,
  PowerIcon,
  ShieldIcon,
  SignalIcon,
  SunIcon,
  UsersIcon,
  VideoIcon,
  XIcon
} from './icons';

import { api } from './api';
import { PhoneHome } from './phonehome';
import { canUseMedia, hasNativeFeatures, isPhoneClient } from './httpApi';
/**
 * The call itself lives inline only on the phone client, which has no second
 * window to hand it to — the desktop app opens a dedicated call window
 * instead (see `callWindowRoot.tsx`) and never puts anything in this tab.
 */
type Tab = 'clipboard' | 'chat' | 'members' | 'call';
/**
 * Files is a peer of Room and Settings rather than a tab inside a room: it is
 * device-to-device, keeps no history and belongs to no room, so gating it
 * behind picking and unlocking one made it unreachable exactly when it was
 * wanted. Messages is the same shape, for the same reason.
 */
type View = 'room' | 'files' | 'messages' | 'settings';

/**
 * Where the two-column layout stops fitting.
 *
 * Not a phone-versus-desktop line: at 768 the rail and the room were both on
 * screen and neither had room, so the room's name truncated to two characters
 * and the peer count collided with the power switch. Below this the two become
 * pages instead of columns. Must match the media queries in the stylesheet.
 */
const NARROW_QUERY = '(max-width: 900px)';

type ModalState =
  | { kind: 'create' }
  | { kind: 'join'; target: DiscoveredRoom | null; code?: string; roomName?: string }
  | { kind: 'unlock'; roomId: string }
  | { kind: 'edit'; room: RoomInfo }
  | { kind: 'invite'; invite: RoomInvite }
  | { kind: 'confirm'; title: string; description: string; confirmLabel: string; action: () => void }
  | null;

/** A typing indicator with no follow-up is dropped after this. */
const TYPING_EXPIRY_MS = 6000;

export default function App() {
  const [state, setState] = React.useState<AppState | null>(null);
  const [clips, setClips] = React.useState<ClipboardHistoryEntry[]>([]);
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [tab, setTab] = React.useState<Tab>('clipboard');
  const [view, setView] = React.useState<View>('room');
  const [modal, setModal] = React.useState<ModalState>(null);
  const [typing, setTyping] = React.useState<Record<string, { name: string; at: number }>>({});
  const [screenPicker, setScreenPicker] = React.useState(false);
  const [palette, setPalette] = React.useState<PaletteMode | null>(null);
  /**
   * Narrow screens cannot show the rail and the room at once, so they show one
   * at a time and navigate between them. Anything wide enough ignores this
   * entirely and keeps both on screen.
   */
  const [narrow, setNarrow] = React.useState(
    () => typeof window !== 'undefined' && window.matchMedia(NARROW_QUERY).matches
  );
  const [showRooms, setShowRooms] = React.useState(true);

  React.useEffect(() => {
    const query = window.matchMedia(NARROW_QUERY);
    const update = () => setNarrow(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  const { toasts, push, dismiss } = useToasts();

  /*
   * The call itself lives in a window of its own on the desktop (see
   * `callWindowRoot.tsx`) — this instance stays inert there (`active: false`)
   * so it never runs a second engine fighting the same microphone, and only
   * does anything on the phone client, which has no second window to hand it
   * to.
   */
  const call = useCall({
    deviceId: state?.deviceId ?? '',
    startCallsMuted: state?.settings.startCallsMuted ?? false,
    push,
    active: isPhoneClient()
  });

  const remote = useRemote({ push, allow: 'host' });

  const fileShare = state?.fileShare;
  const files = useFileShare({ fileShare, push });
  const dm = useDirectMessage({ dmThreads: state?.dmThreads ?? [], push });

  const windowState = useWindowState();

  /*
   * The platform reaches the stylesheet, so macOS can leave room for its
   * traffic lights and nothing else has to pay for that gap.
   */
  const platform = windowState?.platform;
  const topInset = windowState?.topInset ?? 0;
  const ownControls = hasWindowControls(windowState);
  React.useEffect(() => {
    if (platform) {
      document.documentElement.dataset.platform = platform;
    }
    // Tells the top bar to give up its right inset, so the controls reach the
    // corner without having to know what that inset currently is.
    document.documentElement.dataset.windowControls = String(ownControls);
    // Maximised on Windows, the window reaches above the screen; this is how
    // much of the top edge would otherwise be cut off.
    document.documentElement.style.setProperty('--window-top-inset', `${topInset}px`);
  }, [platform, topInset, ownControls]);

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
          // Checked again on arrival, not just before asking — the room on
          // screen can change while this was in flight, and a slow fetch for
          // the room just left has no business overwriting the one now shown.
          api.historyGetClipboard(roomId).then((entries) => {
            if (roomId === currentRoomIdRef.current) {
              setClips(entries);
            }
          });
        }
      }),
      api.onUpdateStatus((status) => {
        if (status.state === 'ready') {
          push(`Version ${status.availableVersion} is ready — restart to finish updating.`, 'success');
        }
      }),
      api.onReceipts((roomId) => {
        if (roomId === currentRoomIdRef.current) {
          api.historyGetChat(roomId).then((history) => {
            if (roomId === currentRoomIdRef.current) {
              setMessages(history);
            }
          });
        }
      }),
      // An edit, a withdrawal or a reaction rewrites a message in place, so the
      // room's messages are refetched rather than patched here.
      api.onChatChanged((roomId) => {
        if (roomId === currentRoomIdRef.current) {
          api.historyGetChat(roomId).then((history) => {
            if (roomId === currentRoomIdRef.current) {
              setMessages(history);
            }
          });
        }
      }),
      api.onTyping(({ roomId, deviceId, deviceName, typing }) => {
        if (roomId !== currentRoomIdRef.current) {
          return;
        }

        setTyping((current) => {
          const next = { ...current };
          if (typing) {
            next[deviceId] = { name: deviceName, at: Date.now() };
          } else {
            delete next[deviceId];
          }
          return next;
        });
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

  /*
   * `campusconnect://join?code=…` — the links room QR codes have always encoded.
   *
   * Two arrival routes: one that launched the app, claimed once the interface
   * exists, and any that turn up while it is already running. Both open the
   * join dialog with the code filled in rather than joining outright — a link
   * from outside should say what it is about to do and wait to be agreed with.
   */
  React.useEffect(() => {
    const open = (link: DeepLink) => {
      setView('room');
      setShowRooms(false);

      // Only interrupt if nothing else is open — the same rule `onInvite`
      // follows below, and for the same reason: a link arriving mid-form
      // (typing a new room's password, mid re-key, anything) should not
      // silently throw that input away. The link itself has nowhere to wait,
      // so it is dropped rather than queued; the toast only fires when it
      // actually got to open something.
      let opened = false;
      setModal((current) => {
        if (current) {
          return current;
        }
        opened = true;
        return { kind: 'join', target: null, code: link.code, roomName: link.roomName };
      });

      if (opened && link.roomName) {
        push(`Opening an invitation to ${link.roomName}.`, 'info');
      } else if (!opened) {
        push('A room invitation arrived — finish what you have open, then use the link again.', 'info');
      }
    };

    api.takeDeepLink().then((link) => link && open(link));
    return api.onDeepLink(open);
  }, [push]);

  /*
   * Load the selected room's history whenever the selection changes.
   *
   * Switching rooms twice in quick succession fires two fetches with no
   * ordering guarantee on which finishes first — without this guard, room
   * A's slower fetch could resolve after room B's and leave room B's screen
   * showing room A's messages.
   */
  const roomId = state?.currentRoomId;
  React.useEffect(() => {
    if (!roomId) {
      setClips([]);
      setMessages([]);
      return;
    }

    let cancelled = false;
    api.historyGetClipboard(roomId).then((entries) => {
      if (!cancelled) {
        setClips(entries);
      }
    });
    api.historyGetChat(roomId).then((history) => {
      if (!cancelled) {
        setMessages(history);
      }
    });
    setTyping({});

    return () => {
      cancelled = true;
    };
  }, [roomId]);

  // "Stopped typing" travels over the same lossy network as everything else, so
  // an indicator is also allowed to time out rather than trusting it to arrive.
  React.useEffect(() => {
    if (Object.keys(typing).length === 0) {
      return;
    }

    const timer = window.setInterval(() => {
      setTyping((current) => {
        const fresh = Object.fromEntries(
          Object.entries(current).filter(([, who]) => Date.now() - who.at < TYPING_EXPIRY_MS)
        );
        return Object.keys(fresh).length === Object.keys(current).length ? current : fresh;
      });
    }, 1500);

    return () => window.clearInterval(timer);
  }, [typing]);

  /*
   * A call takes the screen when it starts and gives it back when it ends —
   * on the phone, the only place `call.session` is ever anything but null,
   * since the desktop's own instance stays inert and the call window is where
   * this actually matters there instead.
   */
  const callId = call.session?.callId;
  React.useEffect(() => {
    if (callId) {
      setView('room');
      setTab('call');
    } else {
      setTab((current) => (current === 'call' ? 'chat' : current));
    }
  }, [callId]);

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
  const modalOpen = modal !== null || palette !== null;
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

      /*
       * Ctrl+K is the way in to everything. It works from a text field too —
       * unlike the shortcuts below — because the whole point is that it is
       * always available, including mid-sentence in the composer.
       */
      if (event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPalette('commands');
        return;
      }

      // Ctrl+Shift+F searches every room; plain Ctrl+F filters the room you are
      // looking at, which is the older and narrower behaviour.
      if (event.key.toLowerCase() === 'f' && event.shiftKey) {
        event.preventDefault();
        setPalette('search');
        return;
      }

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
        {/* The window still has to be movable and closable while it starts —
            a frameless window with nothing drawn yet is otherwise stuck. */}
        <div className="splash__bar">
          <WindowControls state={windowState} />
        </div>
        <div className="splash__body">
          <span className="splash__dot" />
          <span>Starting Campus Connect…</span>
        </div>
      </div>
    );
  }

  const online = state.settings.online !== false;
  const lockedRoomIds = new Set(state.lockedRoomIds);
  const room = state.rooms.find((candidate) => candidate.roomId === state.currentRoomId);
  const isLocked = room ? lockedRoomIds.has(room.roomId) : false;
  const isOwner = room?.ownerId === state.deviceId;
  const pendingCount = isOwner
    ? (room?.members.filter((member) => member.status === 'pending').length ?? 0)
    : 0;
  const memberCount = room?.members.filter((member) => member.status === 'accepted').length ?? 0;
  const runningTransfers =
    fileShare?.transfers.filter(
      (transfer) => transfer.status === 'requested' || transfer.status === 'active'
    ).length ?? 0;
  const unreadMessages = state.dmThreads.reduce((total, thread) => total + thread.unread, 0);

  /**
   * Places or joins a call. On the phone client, which has no second window,
   * straight through this window's own `call` controller — everywhere else,
   * a request to the main process to open the dedicated call window instead.
   */
  function startCall(roomId: string, mode: 'audio' | 'video', targetDeviceId?: string) {
    if (isPhoneClient()) {
      void call.start(roomId, mode, targetDeviceId);
    } else {
      void api.callWindowOpen({ kind: 'start', roomId, mode, targetDeviceId });
    }
  }

  function joinCall(callId: string) {
    if (isPhoneClient()) {
      void call.join(callId);
    } else {
      void api.callWindowOpen({ kind: 'join', callId });
    }
  }

  /**
   * Everything the palette can do.
   *
   * Built from the current state rather than a static list, so it only ever
   * offers what is actually possible right now — no entry that fails when you
   * pick it, which is the thing that makes a palette stop being trusted.
   */
  function buildCommands(): Command[] {
    const list: Command[] = [];
    const room = state!.rooms.find((candidate) => candidate.roomId === state!.currentRoomId);
    const unlocked = room && !lockedRoomIds.has(room.roomId);
    const online = state!.settings.online !== false;

    for (const candidate of state!.rooms) {
      if (candidate.roomId === state!.currentRoomId) {
        continue;
      }
      list.push({
        id: `room:${candidate.roomId}`,
        label: `Switch to ${candidate.name}`,
        hint: candidate.encrypted ? 'Encrypted room' : 'Room',
        keywords: 'go open room switch',
        icon: candidate.type === 'private' ? <LockIcon size={14} /> : <GlobeIcon size={14} />,
        group: 'Rooms',
        run: () => {
          setView('room');
          api.roomSwitch(candidate.roomId).then(() => setTab('clipboard'));
        }
      });
    }

    list.push(
      {
        id: 'room:new',
        label: 'Create a room',
        keywords: 'new add make',
        icon: <PlusIcon size={14} />,
        group: 'Rooms',
        run: () => setModal({ kind: 'create' })
      },
      {
        id: 'room:join',
        label: 'Join a room with a code',
        keywords: 'enter password invite',
        icon: <KeyIcon size={14} />,
        group: 'Rooms',
        run: () => setModal({ kind: 'join', target: null })
      }
    );

    if (room && unlocked && online) {
      list.push(
        {
          id: 'clip:share',
          label: 'Share my clipboard now',
          hint: `To ${room.name}`,
          keywords: 'send paste copy push',
          icon: <ClipboardIcon size={14} />,
          group: 'Clipboard',
          run: () => run(api.clipboardShareNow())
        },
        ...(hasNativeFeatures()
          ? [{
          id: 'chat:file',
          label: 'Send a file',
          hint: `To ${room.name}`,
          keywords: 'attach upload document image',
          icon: <ChatIcon size={14} />,
          group: 'Chat',
          run: () => run(api.chatSendFile(room.roomId))
        } as Command]
          : [])
      );

      if (memberCount > 1 && !ownCall && canUseMedia()) {
        if (roomCall) {
          // Somebody else already started one — offering to "start" a second
          // would mint an independent call rather than join theirs, splitting
          // the room across two calls nobody meant to have.
          list.push({
            id: 'call:join-room',
            label: 'Join the call in progress',
            hint: room.name,
            keywords: 'answer ring phone video talk',
            icon: roomCall.mode === 'video' ? <VideoIcon size={14} /> : <PhoneIcon size={14} />,
            group: 'Calls',
            run: () => joinCall(roomCall.callId)
          });
        } else {
          list.push(
            {
              id: 'call:audio',
              label: 'Start a voice call',
              hint: room.name,
              keywords: 'ring phone audio talk',
              icon: <PhoneIcon size={14} />,
              group: 'Calls',
              run: () => startCall(room.roomId, 'audio')
            },
            {
              id: 'call:video',
              label: 'Start a video call',
              hint: room.name,
              keywords: 'ring camera face',
              icon: <VideoIcon size={14} />,
              group: 'Calls',
              run: () => startCall(room.roomId, 'video')
            }
          );
        }
      }

      // Sharing and leaving stay in the palette only where they mean
      // something: the phone, whose call is this window's own `call.session`
      // rather than a separate window's.
      if (call.session) {
        list.push(
          {
            id: 'call:share',
            label: call.session.local.sharing ? 'Stop sharing your screen' : 'Share your screen',
            keywords: 'present monitor display',
            icon: <MonitorIcon size={14} />,
            group: 'Calls',
            run: () => (call.session!.local.sharing ? call.stopSharing() : setScreenPicker(true))
          },
          {
            id: 'call:leave',
            label: 'Leave the call',
            keywords: 'hang up end',
            icon: <PhoneIcon size={14} />,
            group: 'Calls',
            run: () => call.leave()
          }
        );
      }

      for (const member of room.members) {
        if (member.status !== 'accepted' || member.deviceId === state!.deviceId || !hasNativeFeatures()) {
          continue;
        }
        list.push({
          id: `remote:${member.deviceId}`,
          label: `Ask ${member.deviceName} for their screen`,
          hint: 'They have to allow it',
          keywords: 'remote desktop control view',
          icon: <MonitorIcon size={14} />,
          group: 'Remote desktop',
          run: () => remote.ask(room.roomId, member.deviceId)
        });
      }
    }

    if (remote.session) {
      list.push({
        id: 'remote:end',
        label: 'End the remote session',
        keywords: 'stop disconnect screen',
        icon: <XIcon size={14} />,
        group: 'Remote desktop',
        run: () => remote.end()
      });
    }

    for (const snippet of state!.snippets.slice(0, 12)) {
      list.push({
        id: `snippet:${snippet.id}`,
        label: `Copy “${snippet.label || snippet.content.slice(0, 40)}”`,
        hint: 'Snippet',
        keywords: `snippet ${snippet.content}`,
        icon: <BookmarkIcon size={14} />,
        group: 'Snippets',
        run: () => run(api.snippetCopy(snippet.id))
      });
    }

    list.push(
      {
        id: 'app:online',
        label: online ? 'Switch Campus Connect off' : 'Switch Campus Connect on',
        hint: online ? 'Stops all sharing and discovery' : 'Start sharing and discovery',
        keywords: 'network toggle power offline',
        icon: <PowerIcon size={14} />,
        group: 'App',
        run: () => api.updateSettings({ online: !online }).then(setState)
      },
      {
        id: 'app:theme',
        label: 'Change the theme',
        hint: `Currently ${theme}`,
        keywords: 'dark light appearance',
        icon: theme === 'dark' ? <MoonIcon size={14} /> : <SunIcon size={14} />,
        group: 'App',
        run: toggleTheme
      },
      ...(native ? [{
        id: 'app:files',
        label: 'Send files to a nearby device',
        hint: 'Straight to one machine — nothing is kept',
        keywords: 'file transfer send share drop device',
        icon: <PaperclipIcon size={14} />,
        group: 'App',
        run: () => setView('files')
      } as Command] : []),
      {
        id: 'app:settings',
        label: 'Open settings',
        keywords: 'preferences options config',
        icon: <ShieldIcon size={14} />,
        group: 'App',
        run: () => setView('settings')
      }
    );

    return list;
  }

  /** Takes a search hit back to where it came from. */
  function openHit(hit: SearchHit) {
    setView('room');
    api.roomSwitch(hit.roomId).then(() => setTab(hit.kind === 'chat' ? 'chat' : 'clipboard'));
  }

  /** Phone only — the desktop's own instance of `useCall` stays inert. */
  const session = call.session;
  const callRoom = session ? state.rooms.find((r) => r.roomId === session.roomId) : undefined;
  /** The call this device is already in, if any. */
  const ownCall = state.activeCalls.find((active) =>
    active.participants.some((participant) => participant.deviceId === state.deviceId)
  );
  /** A call under way in the room on screen that this device has not joined. */
  const roomCall = room
    ? state.activeCalls.find((active) => active.roomId === room.roomId && active.callId !== ownCall?.callId)
    : undefined;
  /*
   * Everything a phone cannot do is decided in one place. The HTTP bridge
   * refuses all of it already; this is what stops the phone offering it in the
   * first place, which is the difference between a limitation and a dead end.
   */
  const native = hasNativeFeatures();
  /*
   * Calls need a microphone, not a desktop. A phone served over a certificate
   * can hold one; the same phone over plain HTTP cannot, and the browser is the
   * one that decides — so `canUseMedia` asks it rather than guessing.
   */
  const canCall = online && room && !isLocked && memberCount > 1 && canUseMedia();

  function toggleTheme() {
    const next: AppSettings['theme'] =
      theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark';
    api.updateSettings({ theme: next }).then(setState);
  }

  return (
    <div
      className={['app', narrow ? 'is-narrow' : '', narrow && !showRooms ? 'is-room-open' : '']
        .filter(Boolean)
        .join(' ')}
    >
      {/* On a phone the rail is the home screen, so the two things you actually
          picked up the phone to do lead it. */}
      <Sidebar
        header={isPhoneClient() ? <PhoneHome push={push} /> : undefined}
        state={state}
        lockedRoomIds={lockedRoomIds}
        onSelectRoom={(id) => {
          setView('room');
          setShowRooms(false);
          api.roomSwitch(id).then(() => setTab('clipboard'));
        }}
        onCreateRoom={() => setModal({ kind: 'create' })}
        onJoinByCode={() => setModal({ kind: 'join', target: null })}
        onJoinDiscovered={(target) => setModal({ kind: 'join', target })}
        onOpenInvite={(invite) => setModal({ kind: 'invite', invite })}
        showFiles={native}
        onOpenFiles={() => {
          setShowRooms(false);
          setView((current) => (current === 'files' ? 'room' : 'files'));
        }}
        filesOpen={view === 'files'}
        runningTransfers={runningTransfers}
        showMessages={native}
        onOpenMessages={() => {
          setShowRooms(false);
          setView((current) => (current === 'messages' ? 'room' : 'messages'));
        }}
        messagesOpen={view === 'messages'}
        unreadMessages={unreadMessages}
        onOpenSettings={() => {
          setShowRooms(false);
          setView((current) => (current === 'settings' ? 'room' : 'settings'));
        }}
        settingsOpen={view === 'settings'}
      />

      <main className="main">
        <header className="topbar">
          {view === 'settings' || view === 'files' || view === 'messages' ? (
            <>
              <div className="topbar__title">
                <span className="topbar__name">
                  {view === 'files' ? 'Files' : view === 'messages' ? 'Messages' : 'Settings'}
                </span>
              </div>
              {view === 'files' && runningTransfers > 0 ? (
                <Badge tone="accent">
                  {runningTransfers} {runningTransfers === 1 ? 'transfer' : 'transfers'}
                </Badge>
              ) : null}
              {view === 'messages' && unreadMessages > 0 ? (
                <Badge tone="accent">
                  {unreadMessages} unread
                </Badge>
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setView('room');
                  dm.closeThread();
                  if (narrow && !room) {
                    setShowRooms(true);
                  }
                }}
              >
                <XIcon size={14} />
                {/* Icon alone on a phone: the word was the last thing standing
                    between the title and enough room to be read. */}
                {narrow ? null : 'Close'}
              </Button>
            </>
          ) : room ? (
            <>
              {narrow ? (
                <Button
                  variant="ghost"
                  icon
                  onClick={() => setShowRooms(true)}
                  aria-label="Back to rooms"
                  title="Back to rooms"
                >
                  <ChevronLeftIcon size={17} />
                </Button>
              ) : null}
              <div className="topbar__title">
                <span className="topbar__name">{room.name}</span>
              </div>
              {/* One cluster, not four peers. What these say about the room
                  belongs together and belongs to the name beside it. */}
              <div className="topbar__meta">
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
              </div>
            </>
          ) : (
            <div className="topbar__title">
              <span className="topbar__name">Campus Connect</span>
            </div>
          )}

          <span className="topbar__spacer" />

          <div className="topbar__actions">
            {/* Placing a call is a room action, so it lives beside the room's
                name rather than in a menu. It is hidden rather than disabled
                when there is nobody to call — a button that never works is
                worse than one that is not there. */}
            {view === 'room' && canCall && !ownCall ? (
              <>
                <Button
                  variant="ghost"
                  icon
                  onClick={() => startCall(room!.roomId, 'audio')}
                  aria-label={`Start a voice call in ${room!.name}`}
                  title="Start a voice call"
                >
                  <PhoneIcon size={15} />
                </Button>
                <Button
                  variant="ghost"
                  icon
                  onClick={() => startCall(room!.roomId, 'video')}
                  aria-label={`Start a video call in ${room!.name}`}
                  title="Start a video call"
                >
                  <VideoIcon size={15} />
                </Button>
              </>
            ) : null}

            {online ? (
              <span
                className="topbar__peers text-sm text-tertiary row"
                title={`${state.peers.length} device(s) seen on ${state.localAddress}`}
              >
                <SignalIcon size={14} />
                {state.peers.length}
              </span>
            ) : null}

            {/* The master switch. Off means the app shares and receives nothing
                at all, so it says which of the two it is rather than making you
                work it out from an icon. */}
            <button
              className={online ? 'power-toggle is-on' : 'power-toggle'}
              onClick={() => api.updateSettings({ online: !online }).then(setState)}
              role="switch"
              aria-checked={online}
              title={
                online
                  ? 'Shared clipboard is on. Click to switch it off.'
                  : 'Shared clipboard is off. Click to switch it on.'
              }
            >
              <PowerIcon size={14} />
              {online ? 'On' : 'Off'}
            </button>

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

          <WindowControls state={windowState} />
        </header>

        {view === 'room' && online && room && !isLocked && (
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
            {session ? (
              <button
                className={tab === 'call' ? 'tabbar__tab is-active' : 'tabbar__tab'}
                onClick={() => setTab('call')}
              >
                <PhoneIcon size={14} />
                Call
                <span className="tabbar__live" aria-label="on a call" />
              </button>
            ) : null}
          </nav>
        )}

        {/* While this machine is being shared the bar is on screen whatever
            else is, and cannot be dismissed — the one thing worse than not
            knowing you are being watched is thinking you have stopped. */}
        {remote.session?.role === 'host' ? (
          <RemoteHostBar
            session={remote.session}
            onSetGrant={(grant) => remote.setGrant(grant)}
            onEnd={() => remote.end()}
          />
        ) : null}

        {view === 'room' && online && room && !isLocked && roomCall && !ownCall ? (
          <CallInProgressBanner call={roomCall} onJoin={() => joinCall(roomCall.callId)} />
        ) : null}

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
              onUnblockDevice={(id) => run(api.unblockDevice(id))}
              onSaveSnippet={(input) => run(api.snippetSave(input))}
              onDeleteSnippet={(id) => run(api.snippetDelete(id))}
              onCopySnippet={(id) => run(api.snippetCopy(id))}
              onStartPhone={() => run(api.phoneStart())}
              onStopPhone={() => run(api.phoneStop())}
              onRevokePhone={(connectedAt) => run(api.phoneRevoke(connectedAt))}
              onPhoneQr={() => api.phoneQrCode()}
              onBlockDevice={(id, name) =>
                setModal({
                  kind: 'confirm',
                  title: `Block ${name}?`,
                  description: `Nothing from ${name} will be read, stored, shown or answered on this device again, and it will be removed from every room you own. You can unblock it here at any time.`,
                  confirmLabel: 'Block device',
                  action: () => run(api.blockDevice(id, name))
                })
              }
              onTestConnection={(host) => api.networkTest(host)}
              onCheckUpdate={() => {
                api.updateCheck().then((status) => {
                  if (status.state === 'current') push('You are on the latest version.', 'success');
                  if (status.state === 'available') push(`Version ${status.availableVersion} is available.`, 'info');
                  if (status.state === 'error') push(status.error ?? 'Could not check for updates.', 'error');
                });
              }}
              onDownloadUpdate={() => api.updateDownload()}
              onInstallUpdate={() => run(api.updateInstall())}
            />
          </div>
        ) : !online ? (
          <div className="panel">
            <EmptyState
              icon={<PowerIcon size={22} />}
              title="Shared clipboard is off"
              text="Nothing is being shared, received or announced, and no device on this network can see this one. Your rooms and history are kept exactly as they are."
              actions={
                <Button variant="primary" onClick={() => api.updateSettings({ online: true }).then(setState)}>
                  <PowerIcon size={15} />
                  Turn it on
                </Button>
              }
            />
          </div>
        ) : view === 'files' ? (
          // After the offline check and before the room checks: file sharing
          // needs the network, but deliberately not a room.
          <div className="panel">
            <FilesPanel
              peers={state.peers}
              deviceId={state.deviceId}
              blockedIds={new Set(state.blocked.map((device) => device.deviceId))}
              protocolVersion={state.diagnostics.protocolVersion}
              // An older desktop may not report file sharing at all; the panel
              // then simply has nothing running in it rather than breaking.
              fileShare={fileShare ?? { transfers: [], downloadFolder: '' }}
              onSend={(peerId, peerName) => files.request(peerId, peerName)}
              onCancel={(transferId) => files.cancel(transferId)}
              onDismiss={(transferId) => files.dismiss(transferId)}
              onOpenFolder={files.openFolder}
            />
          </div>
        ) : view === 'messages' ? (
          // Same reasoning as Files: needs the network, deliberately not a room.
          // Flush only once a thread is open — the chat layout fills the panel
          // edge to edge, but the peer list wants the ordinary card padding.
          <div className={dm.activePeerId ? 'panel panel--flush' : 'panel'}>
            <DmPanel
              controller={dm}
              peers={state.peers}
              deviceId={state.deviceId}
              blockedIds={new Set(state.blocked.map((device) => device.deviceId))}
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
        ) : tab === 'call' && session ? (
          <div className="panel panel--flush">
            <CallStage
              session={session}
              room={callRoom}
              deviceName={state.deviceName}
              onToggleMic={call.toggleMic}
              onToggleCamera={call.toggleCamera}
              onShare={() => setScreenPicker(true)}
              onStopSharing={() => call.stopSharing()}
              onLeave={() => call.leave()}
            />
          </div>
        ) : tab === 'chat' ? (
          <div className="panel panel--flush">
            <ChatPanel
              room={room}
              messages={messages}
              deviceId={state.deviceId}
              typingNames={Object.values(typing).map((who) => who.name)}
              onSend={(text, replyToId) => {
                api
                  .chatSend('text', text, room.roomId, undefined, undefined, replyToId)
                  .then((result) => {
                    if (!result.ok) {
                      push(result.message, 'error');
                    }
                  });
              }}
              canSendFiles={native}
              onSendFile={() => run(api.chatSendFile(room.roomId))}
              onSaveFile={(messageId) => run(api.chatSaveFile(messageId))}
              onEdit={(messageId, content) => {
                api.chatEdit(messageId, content).then((result) => {
                  if (!result.ok) {
                    push(result.message, 'error');
                  }
                });
              }}
              onDelete={(messageId, forEveryone) => run(api.chatDelete(messageId, forEveryone))}
              // Reacting is a small, visible thing already; announcing each one
              // with a toast would be noise.
              onReact={(messageId, emoji) => {
                api.chatReact(messageId, emoji).then((result) => {
                  if (!result.ok) {
                    push(result.message, 'error');
                  }
                });
              }}
              onCopy={(text) => {
                navigator.clipboard.writeText(text);
                push('Copied to your clipboard.', 'success');
              }}
              onTyping={(isTyping) => api.chatTyping(room.roomId, isTyping)}
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
                onSaveSnippet={(text) => run(api.snippetSave({ label: '', content: text }))}
                quickPasteShortcut={state.settings.quickPasteShortcut}
                onOpenUrl={(url) => {
                  api.openLink(url).then((result) => {
                    if (!result.ok) {
                      push(result.message, 'error');
                    }
                  });
                }}
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
                canRemote={native}
                onCallRequest={(memberId) => startCall(room.roomId, 'audio', memberId)}
                canCall={canUseMedia()}
                onMessageRequest={(memberId, memberName) => {
                  dm.openThread(memberId, memberName);
                  setView('messages');
                }}
                onRemoteRequest={(memberId) => remote.ask(room.roomId, memberId)}
                onEdit={() => setModal({ kind: 'edit', room })}
                onBlock={(memberId, memberName) =>
                  setModal({
                    kind: 'confirm',
                    title: `Block ${memberName}?`,
                    description: `Nothing from ${memberName} will be read, stored, shown or answered on this device again — in this room or any other — and it will be removed from every room you own. You can unblock it from Settings → Privacy.`,
                    confirmLabel: 'Block device',
                    action: () => run(api.blockDevice(memberId, memberName))
                  })
                }
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
          // Forces a remount, not just a prop update, whenever a *different*
          // ask arrives while the dialog is already open (a second deep link,
          // a second discovered-room click) — otherwise the form's own state
          // (the code/password already typed) survives from the first ask
          // while the title above it updates to the second, an out-of-sync
          // dialog no amount of prop-passing fixes on its own.
          key={modal.target?.roomId ?? modal.code ?? 'code'}
          // Re-resolved against live discovery on every render, not just the
          // snapshot taken when the dialog was opened — an owner can change a
          // room's type or password while this is still on screen, and the
          // dialog should join what it currently says rather than what it
          // said a moment ago. Falls back to the snapshot if the room has
          // since dropped out of range entirely.
          target={
            modal.target
              ? (state.discovered.find((candidate) => candidate.roomId === modal.target!.roomId) ??
                modal.target)
              : null
          }
          initialCode={modal.code}
          onClose={() => setModal(null)}
          onJoinDiscovered={(id, password, code) => run(api.roomRequestJoin(id, password, code))}
          onJoinByCode={(code, password) => run(api.roomJoinByCode(code, password))}
        />
      )}

      {modal?.kind === 'edit' && (
        <EditRoomModal
          key={modal.room.roomId}
          room={modal.room}
          onClose={() => setModal(null)}
          onSave={(patch) => run(api.roomUpdate(modal.room.roomId, patch))}
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

      {palette && (
        <CommandPalette
          commands={buildCommands()}
          initialMode={palette}
          onClose={() => setPalette(null)}
          onOpenHit={openHit}
        />
      )}

      {/* Someone asking for this screen outranks everything else on screen.
          It is the one prompt where not noticing has real consequences. */}
      {remote.request && (
        <RemoteRequestModal
          request={remote.request}
          capabilities={state.remoteCapabilities}
          onRespond={(allow, grant, screen) => remote.respond(allow, grant, screen)}
          onDismiss={() => remote.dismissRequest()}
        />
      )}

      {/* Ahead of every other overlay: this is somebody's first minute with the
          app, and a dialog about a room they have not made yet is noise. */}
      {!state.settings.hasOnboarded && (
        <Onboarding
          quickPasteShortcut={state.settings.quickPasteShortcut}
          onFinish={() => api.updateSettings({ hasOnboarded: true }).then(setState)}
        />
      )}

      {/* Files arriving needs answering while the sender is still waiting, and
          the request expires on its own — so it interrupts too. */}
      {fileShare?.incoming && (
        <FileRequestModal
          request={fileShare.incoming}
          downloadFolder={fileShare.downloadFolder}
          onRespond={(accept) => {
            const transferId = fileShare.incoming!.transferId;
            if (accept) {
              // Somebody who just said yes wants to watch it arrive.
              setShowRooms(false);
              setView('files');
            }
            void files.respond(transferId, accept);
          }}
        />
      )}

      {/* A ring interrupts whatever else is open. Unlike an invitation it is
          over in seconds, so it cannot wait its turn behind a dialog. Phone
          only — the desktop's own ring is the call window's to show. */}
      {call.ringing && (
        <IncomingCallModal
          ring={call.ringing}
          ringtone={state.settings.ringOnCalls}
          onAnswer={() => call.answer(call.ringing!)}
          onDecline={() => call.decline(call.ringing!.callId)}
        />
      )}

      {screenPicker && (
        <ScreenPickerModal
          onClose={() => setScreenPicker(false)}
          onPick={(sourceId) => {
            setScreenPicker(false);
            call.shareScreen(sourceId);
          }}
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

      <Toasts toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
