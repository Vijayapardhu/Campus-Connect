import React from 'react';
import type { ChatMessage, DirectMessage, DmThreadSummary, PeerInfo, RoomInfo } from '../shared/types';
import type { StatusTone } from '../shared/bridge';
import { Badge, Button, ConfirmModal, EmptyState } from './ui';
import { initials, relativeTime, truncate } from './format';
import {
  ArchiveIcon,
  ChatIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  MoreIcon,
  PhoneIcon,
  PlusIcon,
  SearchIcon,
  ShieldIcon,
  TrashIcon,
  UsersIcon
} from './icons';
import { api } from './api';
import { ChatPanel } from './panels';
import { FindUserModal } from './modals';

/**
 * Direct 1:1 messages, in the window.
 *
 * Built on the same `ChatPanel`/`MessageRow` room chat uses — full parity
 * (file share, edit, delete, react, reply, receipts, typing) is "reuse the
 * UI," not "rebuild it." A `DirectMessage` is adapted into the `ChatMessage`
 * shape `ChatPanel` already understands (`toBubble`), and the two-party
 * thread is presented as a stand-in two-member `RoomInfo` (`stubRoom`) so
 * nothing downstream needs to know it isn't a real room.
 */

/** Silence for this long ends a typing indicator on its own — the DM equivalent of App.tsx's room `TYPING_EXPIRY_MS`. */
const DM_TYPING_EXPIRY_MS = 6000;

/**
 * How many devices from "Devices on this network" actually get rendered.
 *
 * Fine at the handful-of-devices scale this page was built for; a campus
 * deployment with hundreds of devices visible at once is a different
 * problem, and search — already the box right above this list — is the
 * actual way to find one at that scale, not scrolling past hundreds of
 * rows. This cap is what keeps that true rather than aspirational.
 */
const MAX_VISIBLE_PEERS = 40;

export type DirectMessageController = {
  threads: DmThreadSummary[];
  /** Empty when no thread is open — the panel then shows the peer list instead. */
  activePeerId: string;
  activePeerName: string;
  thread: DirectMessage[];
  /** The peer's name while they are composing in the open thread, or '' otherwise. */
  peerTyping: string;
  openThread: (peerId: string, peerName: string) => void;
  closeThread: () => void;
  send: (content: string, replyToId?: string) => Promise<void>;
  sendFile: () => Promise<void>;
  /** Sends an image pasted into the composer, skipping the native picker. */
  sendImage: (dataUrl: string, fileName: string) => Promise<void>;
  editMessage: (messageId: string, content: string) => Promise<void>;
  deleteMessage: (messageId: string, forEveryone: boolean) => Promise<void>;
  react: (messageId: string, emoji: string) => Promise<void>;
  saveFile: (messageId: string) => Promise<void>;
  archiveThread: (peerId: string, archived: boolean) => Promise<void>;
  deleteThread: (peerId: string) => Promise<void>;
  /** Saves the thread as a text file through the native dialog. Refused on the phone. */
  exportThread: (peerId: string) => Promise<void>;
  /** Bookmarks a message in the open thread, on this device alone. */
  togglePin: (messageId: string) => Promise<void>;
  /** Copies text to the clipboard and confirms it, the same as room chat's own copy action does. */
  copy: (text: string) => void;
  setTyping: (typing: boolean) => void;
};

export function useDirectMessage({
  dmThreads,
  push
}: {
  dmThreads: DmThreadSummary[];
  push: (message: string, tone?: StatusTone) => void;
}): DirectMessageController {
  const [activePeerId, setActivePeerId] = React.useState('');
  const [activePeerName, setActivePeerName] = React.useState('');
  const [thread, setThread] = React.useState<DirectMessage[]>([]);
  const [peerTypingAt, setPeerTypingAt] = React.useState<{ name: string; at: number } | null>(null);
  const pushRef = React.useRef(push);
  pushRef.current = push;
  // Read inside the event subscription below, which is only ever registered
  // once — a plain closure over `activePeerId` would go stale the first time
  // a different thread was opened.
  const activePeerIdRef = React.useRef(activePeerId);
  activePeerIdRef.current = activePeerId;
  // Bumped on every call to `openThread`, including a repeat for the same
  // peer — a stale in-flight fetch checks this, not just the peer id, before
  // applying its result.
  const fetchTokenRef = React.useRef(0);

  const openThread = React.useCallback((peerId: string, peerName: string) => {
    setActivePeerId(peerId);
    activePeerIdRef.current = peerId; // Read by the fetch below before React commits the state update.
    setActivePeerName(peerName);
    setThread([]);
    setPeerTypingAt(null);
    // Newest-first, to match `.chat__scroll`'s column-reverse layout — the
    // same order room chat's own message list is already kept in.
    //
    // Checked again on arrival, not just before asking — opening a second
    // thread before this fetch resolves must not let the first thread's
    // slower response land under the second thread's header. The token check
    // covers the same race for two calls naming the *same* peer — a double
    // click issues two `dmGetThread` requests, and without it whichever
    // round trip happened to resolve last would win even if it was issued
    // first and answered before a message that arrived in between.
    const token = ++fetchTokenRef.current;
    void api.dmGetThread(peerId).then((messages) => {
      if (activePeerIdRef.current === peerId && fetchTokenRef.current === token) {
        setThread([...messages].reverse());
      }
    });
    void api.dmMarkRead(peerId);
  }, []);

  const closeThread = React.useCallback(() => {
    setActivePeerId('');
    setActivePeerName('');
    setThread([]);
    setPeerTypingAt(null);
  }, []);

  React.useEffect(() => {
    return api.onDmTyping(({ peerId, peerName, typing }) => {
      if (peerId !== activePeerIdRef.current) {
        return; // Some other thread — nothing currently on screen cares.
      }
      setPeerTypingAt(typing ? { name: peerName, at: Date.now() } : null);
    });
  }, []);

  // An indicator that never hears "stopped" — a closed app, a dropped
  // connection — is also allowed to time out rather than trusting the
  // negative edge to always arrive, the same reasoning room chat's own
  // typing sweep in App.tsx follows.
  React.useEffect(() => {
    if (!peerTypingAt) {
      return;
    }
    const timer = window.setInterval(() => {
      setPeerTypingAt((current) =>
        current && Date.now() - current.at >= DM_TYPING_EXPIRY_MS ? null : current
      );
    }, 1500);
    return () => window.clearInterval(timer);
  }, [peerTypingAt]);

  const setTyping = React.useCallback((typing: boolean) => {
    if (!activePeerIdRef.current) {
      return;
    }
    void api.dmTyping(activePeerIdRef.current, typing);
  }, []);

  React.useEffect(() => {
    return api.onDmMessage((message) => {
      if (message.peerId !== activePeerIdRef.current) {
        return; // Some other thread's message — it still updated `dmThreads`.
      }
      // A brand new message is prepended (the list is newest-first); an
      // amendment to one already here — an edit, a delete, a reaction —
      // replaces it in place instead, the same id arriving with new content
      // rather than a second row.
      setThread((current) => {
        const index = current.findIndex((existing) => existing.id === message.id);
        if (index === -1) {
          return [message, ...current];
        }
        const next = [...current];
        next[index] = message;
        return next;
      });
      if (!message.fromSelf) {
        void api.dmMarkRead(message.peerId);
      }
    });
  }, []);

  const send = React.useCallback(
    async (content: string, replyToId?: string) => {
      if (!activePeerId) {
        return;
      }
      const result = await api.dmSend(activePeerId, activePeerName, 'text', content, undefined, undefined, replyToId);
      if (!result.ok) {
        pushRef.current(result.message, 'error');
      }
    },
    [activePeerId, activePeerName]
  );

  const sendFile = React.useCallback(async () => {
    if (!activePeerId) {
      return;
    }
    const result = await api.dmSendFile(activePeerId, activePeerName);
    pushRef.current(result.message, result.ok ? 'success' : 'error');
  }, [activePeerId, activePeerName]);

  /** An image pasted into the composer — already decoded, so no picker is involved. */
  const sendImage = React.useCallback(
    async (dataUrl: string, fileName: string) => {
      if (!activePeerId) {
        return;
      }
      const result = await api.dmSend(activePeerId, activePeerName, 'image', fileName, dataUrl, fileName);
      if (!result.ok) {
        pushRef.current(result.message, 'error');
      }
    },
    [activePeerId, activePeerName]
  );

  const editMessage = React.useCallback(
    async (messageId: string, content: string) => {
      if (!activePeerId) {
        return;
      }
      const result = await api.dmEdit(activePeerId, messageId, content);
      if (!result.ok) {
        pushRef.current(result.message, 'error');
      }
    },
    [activePeerId]
  );

  const deleteMessage = React.useCallback(
    async (messageId: string, forEveryone: boolean) => {
      if (!activePeerId) {
        return;
      }
      const result = await api.dmDelete(activePeerId, messageId, forEveryone);
      pushRef.current(result.message, result.ok ? 'success' : 'error');
    },
    [activePeerId]
  );

  const react = React.useCallback(
    async (messageId: string, emoji: string) => {
      if (!activePeerId) {
        return;
      }
      const result = await api.dmReact(activePeerId, messageId, emoji);
      if (!result.ok) {
        pushRef.current(result.message, 'error');
      }
    },
    [activePeerId]
  );

  const saveFile = React.useCallback(
    async (messageId: string) => {
      if (!activePeerId) {
        return;
      }
      const result = await api.dmSaveFile(activePeerId, messageId);
      pushRef.current(result.message, result.ok ? 'success' : 'error');
    },
    [activePeerId]
  );

  const archiveThread = React.useCallback(async (peerId: string, archived: boolean) => {
    await api.dmArchiveThread(peerId, archived);
  }, []);

  const deleteThread = React.useCallback(async (peerId: string) => {
    await api.dmDeleteThread(peerId);
    if (activePeerIdRef.current === peerId) {
      closeThread();
    }
  }, [closeThread]);

  const copy = React.useCallback((text: string) => {
    navigator.clipboard.writeText(text);
    pushRef.current('Copied to your clipboard.', 'success');
  }, []);

  const togglePin = React.useCallback(async (messageId: string) => {
    if (!activePeerIdRef.current) {
      return;
    }
    const result = await api.dmTogglePin(activePeerIdRef.current, messageId);
    if (!result.ok) {
      pushRef.current(result.message, 'error');
    }
  }, []);

  const exportThread = React.useCallback(async (peerId: string) => {
    const result = await api.dmExport(peerId);
    pushRef.current(result.message, result.ok ? 'success' : 'error');
  }, []);

  return {
    threads: dmThreads,
    activePeerId,
    activePeerName,
    thread,
    peerTyping: peerTypingAt?.name ?? '',
    openThread,
    closeThread,
    send,
    sendFile,
    sendImage,
    editMessage,
    deleteMessage,
    react,
    saveFile,
    archiveThread,
    deleteThread,
    exportThread,
    togglePin,
    copy,
    setTyping
  };
}

// ------------------------------------------------------------------ mapping

/** A `DirectMessage`, reshaped into the `ChatMessage` `ChatPanel`/`MessageRow` already know how to render. */
function toBubble(message: DirectMessage, selfId: string, selfName: string): ChatMessage {
  return {
    id: message.id,
    type: message.type,
    content: message.content,
    dataUrl: message.dataUrl,
    fileName: message.fileName,
    fileSize: message.fileSize,
    deviceId: message.fromSelf ? selfId : message.peerId,
    deviceName: message.fromSelf ? selfName : message.peerName,
    roomId: '',
    timestamp: message.sentAt,
    replyTo: message.replyTo,
    editedAt: message.editedAt,
    deleted: message.deleted,
    reactions: message.reactions,
    deliveredTo: message.deliveredTo,
    seenBy: message.seenBy,
    pinned: message.pinned
  };
}

/**
 * A stand-in two-member room so `ChatPanel` can render a DM thread as the
 * thing it already knows how to render, rather than a fork of it. Never
 * persisted, never sent anywhere — a plain local value built fresh on every
 * render.
 */
function stubRoom(selfId: string, selfName: string, peerId: string, peerName: string): RoomInfo {
  const now = Date.now();
  return {
    roomId: `dm:${peerId}`,
    name: peerName,
    type: 'direct',
    ownerId: selfId,
    ownerName: selfName,
    keySalt: '',
    encrypted: false,
    createdAt: now,
    members: [
      { deviceId: selfId, deviceName: selfName, status: 'accepted', role: 'owner', joinedAt: now },
      { deviceId: peerId, deviceName: peerName, status: 'accepted', role: 'member', joinedAt: now }
    ]
  };
}

// -------------------------------------------------------------------- panel

export function DmPanel({
  controller,
  peers,
  deviceId,
  deviceName,
  blockedIds,
  canSendFiles,
  onCallRequest,
  onForward,
  listenPort,
  onConnectByIp
}: {
  controller: DirectMessageController;
  peers: PeerInfo[];
  deviceId: string;
  deviceName: string;
  blockedIds: Set<string>;
  /** False on a phone — DMs are native-only there already, but `ChatPanel` still wants the flag. */
  canSendFiles: boolean;
  onCallRequest: (peerId: string, peerName: string, mode: 'audio' | 'video') => void;
  /**
   * Opens the destination picker. Owned by `App` rather than here because a
   * forward out of a thread can land in a room, which this component knows
   * nothing about.
   */
  onForward?: (message: ChatMessage) => void;
  /** The port this device listens on — offered as the default in the by-IP search field. */
  listenPort: number;
  onConnectByIp: (host: string, port: number) => Promise<void>;
}) {
  const {
    threads,
    activePeerId,
    activePeerName,
    thread,
    openThread,
    closeThread,
    send,
    sendFile,
    sendImage,
    editMessage,
    deleteMessage,
    react,
    saveFile,
    archiveThread,
    deleteThread,
    exportThread,
    togglePin,
    copy,
    peerTyping,
    setTyping
  } = controller;

  const [query, setQuery] = React.useState('');
  const [menuFor, setMenuFor] = React.useState('');
  const [showArchived, setShowArchived] = React.useState(false);
  const [confirmingDelete, setConfirmingDelete] = React.useState<DmThreadSummary | null>(null);
  const [findUserOpen, setFindUserOpen] = React.useState(false);

  // A popover that only ever closes by picking an item, or by opening a
  // different row's, would stay open the moment someone clicks anywhere else
  // on the page — the same "click outside to dismiss" every other menu here
  // already gets for free by virtue of being a `Modal`.
  React.useEffect(() => {
    if (!menuFor) {
      return;
    }
    const dismiss = () => setMenuFor('');
    document.addEventListener('click', dismiss);
    return () => document.removeEventListener('click', dismiss);
  }, [menuFor]);

  if (activePeerId) {
    return (
      <ChatPanel
        room={stubRoom(deviceId, deviceName, activePeerId, activePeerName)}
        messages={thread.map((message) => toBubble(message, deviceId, deviceName))}
        deviceId={deviceId}
        typingNames={peerTyping ? [peerTyping] : []}
        showReceipts
        emptyText={`Nothing sent between this device and ${activePeerName} yet.`}
        onSend={(text, replyToId) => void send(text, replyToId)}
        onSendFile={() => void sendFile()}
        onSendImage={(dataUrl, fileName) => void sendImage(dataUrl, fileName)}
        canSendFiles={canSendFiles}
        onSaveFile={(messageId) => void saveFile(messageId)}
        onEdit={(messageId, content) => void editMessage(messageId, content)}
        onDelete={(messageId, forEveryone) => void deleteMessage(messageId, forEveryone)}
        onReact={(messageId, emoji) => void react(messageId, emoji)}
        onCopy={copy}
        onForward={onForward}
        onTogglePin={(messageId) => void togglePin(messageId)}
        // Same reasoning as room chat's: the save dialog is native.
        onExport={canSendFiles ? () => void exportThread(activePeerId) : undefined}
        onTyping={setTyping}
        headerExtra={
          <>
            <Button size="sm" variant="ghost" icon onClick={closeThread} aria-label="Back to messages">
              <ChevronLeftIcon size={15} />
            </Button>
            <span className="card__title">{activePeerName}</span>
            <span
              className="text-tertiary text-sm"
              title="Sealed with a key only this device and theirs can compute — nothing else on the network can read it."
            >
              <ShieldIcon size={13} />
            </span>
            <Button
              size="sm"
              onClick={() => onCallRequest(activePeerId, activePeerName, 'audio')}
              title={`Call ${activePeerName}`}
            >
              <PhoneIcon size={14} />
              Call
            </Button>
            <span className="spacer" />
          </>
        }
      />
    );
  }

  // Not this machine, not blocked — same filter `FilesPanel` uses for the
  // same reason: a device that could not actually be reached is not worth
  // offering.
  const reachable = peers.filter((peer) => peer.id !== deviceId && !blockedIds.has(peer.id));
  const reachableIds = new Set(reachable.map((peer) => peer.id));
  // A thread with a peer no longer on the network stays visible — going
  // offline should not make the conversation disappear, only pause it.
  const offlineThreads = threads.filter((thread) => !reachableIds.has(thread.peerId));

  const needle = query.trim().toLowerCase();
  const matchesThread = (summary: DmThreadSummary) =>
    !needle ||
    summary.peerName.toLowerCase().includes(needle) ||
    summary.lastMessage.toLowerCase().includes(needle);

  const activeThreads = threads.filter((summary) => !summary.archived && matchesThread(summary));
  const archivedThreads = threads.filter((summary) => summary.archived && matchesThread(summary));
  // A search that only matches something archived should not also require
  // digging it out of a collapsed section — the query already did the work
  // of finding it.
  const archivedExpanded = showArchived || Boolean(needle);
  // Nobody is listed until something is typed — a name or device id you
  // already know is a faster, more deliberate way to reach one specific
  // person than scrolling everyone currently visible on the network.
  const matchingPeers = needle
    ? reachable.filter((peer) => peer.name.toLowerCase().includes(needle) || peer.id.toLowerCase().includes(needle))
    : [];
  const visiblePeers = matchingPeers.slice(0, MAX_VISIBLE_PEERS);
  const hiddenPeerCount = matchingPeers.length - visiblePeers.length;

  function openRow(summary: DmThreadSummary) {
    setMenuFor('');
    openThread(summary.peerId, summary.peerName);
  }

  function renderThreadRow(summary: DmThreadSummary) {
    return (
      <div
        key={summary.peerId}
        className="member dm-thread"
        role="button"
        tabIndex={0}
        onClick={() => openRow(summary)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openRow(summary);
          }
        }}
      >
        <span className="member__avatar">{initials(summary.peerName)}</span>
        <div className="member__body">
          <div className="member__name">
            {summary.peerName}
            {offlineThreads.includes(summary) ? <span className="text-secondary text-sm"> · offline</span> : null}
          </div>
          <div className="member__meta">
            {truncate(summary.lastMessage, 60)} · {relativeTime(summary.lastAt)}
          </div>
        </div>
        {summary.unread > 0 ? <Badge tone="accent">{summary.unread}</Badge> : null}
        <div className="dm-thread__menu">
          <Button
            size="sm"
            variant="ghost"
            icon
            aria-label={`More actions for ${summary.peerName}`}
            onClick={(event) => {
              event.stopPropagation();
              setMenuFor((current) => (current === summary.peerId ? '' : summary.peerId));
            }}
          >
            <MoreIcon size={14} />
          </Button>
          {menuFor === summary.peerId ? (
            <div className="dm-thread__popover" onClick={(event) => event.stopPropagation()}>
              <button
                type="button"
                className="dm-thread__popover-item"
                onClick={() => {
                  void archiveThread(summary.peerId, !summary.archived);
                  setMenuFor('');
                }}
              >
                <ArchiveIcon size={13} />
                {summary.archived ? 'Unarchive' : 'Archive'}
              </button>
              <button
                type="button"
                className="dm-thread__popover-item is-danger"
                onClick={() => {
                  setConfirmingDelete(summary);
                  setMenuFor('');
                }}
              >
                <TrashIcon size={13} />
                Delete
              </button>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="search">
        <SearchIcon size={14} />
        <input
          className="search__input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find a conversation, or a name or device id here"
          aria-label="Search messages and devices"
          spellCheck={false}
        />
      </div>

      {activeThreads.length > 0 && (
        <section className="card">
          <div className="card__header">
            <div style={{ flex: 1 }}>
              <h3 className="card__title">Recent</h3>
            </div>
          </div>
          {activeThreads.map(renderThreadRow)}
        </section>
      )}

      {archivedThreads.length > 0 && (
        <section className="card">
          <div
            className="card__header dm-archived-toggle"
            role="button"
            tabIndex={0}
            onClick={() => setShowArchived((open) => !open)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                setShowArchived((open) => !open);
              }
            }}
          >
            <div style={{ flex: 1 }}>
              <h3 className="card__title">Archived</h3>
            </div>
            <Badge>{archivedThreads.length}</Badge>
            <ChevronDownIcon size={15} className={archivedExpanded ? 'dm-archived-chevron is-open' : 'dm-archived-chevron'} />
          </div>
          {archivedExpanded ? archivedThreads.map(renderThreadRow) : null}
        </section>
      )}

      <section className="card">
        <div className="card__header">
          <div style={{ flex: 1 }}>
            <h3 className="card__title">Devices on this network</h3>
            <p className="card__desc">
              Message another machine directly — no room, no history shared with anyone else, and
              end-to-end encrypted the moment it appears on the network.
            </p>
          </div>
          <Badge>{matchingPeers.length}</Badge>
        </div>

        {!needle ? (
          <p className="text-sm text-tertiary" style={{ paddingTop: 'var(--space-2)' }}>
            {reachable.length > 0
              ? `${reachable.length} ${reachable.length === 1 ? 'device is' : 'devices are'} reachable right now — type a name or id above to find one.`
              : 'Devices appear here once Campus Connect is running on them and they are on the same network.'}
          </p>
        ) : visiblePeers.length === 0 ? (
          <EmptyState
            icon={<UsersIcon size={22} />}
            title="No matches"
            text={`Nothing on this network matches “${query.trim()}”.`}
          />
        ) : (
          visiblePeers.map((peer) => (
            <div key={peer.id} className="member">
              <span className="member__avatar">{initials(peer.name)}</span>
              <div className="member__body">
                <div className="member__name">{peer.name}</div>
                <div className="member__meta">{peer.host}</div>
              </div>
              <div className="member__actions">
                <Button size="sm" onClick={() => openThread(peer.id, peer.name)}>
                  <ChatIcon size={14} />
                  Message
                </Button>
              </div>
            </div>
          ))
        )}
        {hiddenPeerCount > 0 && (
          <p className="field__hint">{hiddenPeerCount} more — keep typing to narrow it down.</p>
        )}
      </section>

      <Button
        className="fab"
        variant="primary"
        icon
        onClick={() => setFindUserOpen(true)}
        aria-label="Start a new chat"
        title="Start a new chat"
      >
        <PlusIcon size={20} />
      </Button>

      {confirmingDelete ? (
        <ConfirmModal
          title="Delete this conversation?"
          description={`This removes your copy of the conversation with ${confirmingDelete.peerName}. It stays on their device.`}
          confirmLabel="Delete"
          onConfirm={() => {
            void deleteThread(confirmingDelete.peerId);
            setConfirmingDelete(null);
          }}
          onClose={() => setConfirmingDelete(null)}
        />
      ) : null}

      {findUserOpen ? (
        <FindUserModal
          peers={peers}
          selfDeviceId={deviceId}
          blockedIds={blockedIds}
          defaultPort={listenPort}
          onConnectByIp={onConnectByIp}
          onOpenThread={(peerId, peerName) => openThread(peerId, peerName)}
          onClose={() => setFindUserOpen(false)}
        />
      ) : null}
    </div>
  );
}
