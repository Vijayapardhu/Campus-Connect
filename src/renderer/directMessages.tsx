import React from 'react';
import type { DirectMessage, DmThreadSummary, PeerInfo } from '../shared/types';
import type { StatusTone } from '../shared/bridge';
import { Badge, Button, EmptyState } from './ui';
import { clockTime, initials, relativeTime, truncate } from './format';
import { ChatIcon, ChevronLeftIcon, SendIcon, UsersIcon } from './icons';
import { api } from './api';

/**
 * Direct 1:1 messages, in the window.
 *
 * Deliberately not built on `ChatPanel`: that requires a `RoomInfo` and a
 * full `ChatMessage` with a required `roomId`, and this has neither — a
 * direct message belongs to no room, and carries none of edit, delete,
 * reactions or a reply quote. What it does share with room chat is the
 * bubble list and composer look, via the same `.msg`/`.chat`/`.composer`
 * classes — the two should read as the same kind of thing, not a different
 * feature that happens to also send text.
 */

export type DirectMessageController = {
  threads: DmThreadSummary[];
  /** Empty when no thread is open — the panel then shows the peer list instead. */
  activePeerId: string;
  activePeerName: string;
  thread: DirectMessage[];
  openThread: (peerId: string, peerName: string) => void;
  closeThread: () => void;
  send: (content: string) => Promise<void>;
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
  const pushRef = React.useRef(push);
  pushRef.current = push;
  // Read inside the event subscription below, which is only ever registered
  // once — a plain closure over `activePeerId` would go stale the first time
  // a different thread was opened.
  const activePeerIdRef = React.useRef(activePeerId);
  activePeerIdRef.current = activePeerId;

  const openThread = React.useCallback((peerId: string, peerName: string) => {
    setActivePeerId(peerId);
    activePeerIdRef.current = peerId; // Read by the fetch below before React commits the state update.
    setActivePeerName(peerName);
    setThread([]);
    // Newest-first, to match `.chat__scroll`'s column-reverse layout — the
    // same order room chat's own message list is already kept in.
    //
    // Checked again on arrival, not just before asking — opening a second
    // thread before this fetch resolves must not let the first thread's
    // slower response land under the second thread's header.
    void api.dmGetThread(peerId).then((messages) => {
      if (activePeerIdRef.current === peerId) {
        setThread([...messages].reverse());
      }
    });
    void api.dmMarkRead(peerId);
  }, []);

  const closeThread = React.useCallback(() => {
    setActivePeerId('');
    setActivePeerName('');
    setThread([]);
  }, []);

  React.useEffect(() => {
    return api.onDmMessage((message) => {
      if (message.peerId !== activePeerIdRef.current) {
        return; // Some other thread's message — it still updated `dmThreads`.
      }
      setThread((current) =>
        current.some((existing) => existing.id === message.id) ? current : [message, ...current]
      );
      if (!message.fromSelf) {
        void api.dmMarkRead(message.peerId);
      }
    });
  }, []);

  const send = React.useCallback(
    async (content: string) => {
      if (!activePeerId) {
        return;
      }
      const result = await api.dmSend(activePeerId, activePeerName, content);
      if (!result.ok) {
        pushRef.current(result.message, 'error');
      }
    },
    [activePeerId, activePeerName]
  );

  return { threads: dmThreads, activePeerId, activePeerName, thread, openThread, closeThread, send };
}

// -------------------------------------------------------------------- panel

export function DmPanel({
  controller,
  peers,
  deviceId,
  blockedIds
}: {
  controller: DirectMessageController;
  peers: PeerInfo[];
  deviceId: string;
  blockedIds: Set<string>;
}) {
  const { threads, activePeerId, activePeerName, thread, openThread, closeThread, send } = controller;
  const [draft, setDraft] = React.useState('');

  if (activePeerId) {
    const submit = () => {
      const content = draft.trim();
      if (!content) {
        return;
      }
      setDraft('');
      void send(content);
    };

    return (
      <div className="chat">
        <div className="chat__bar">
          <Button size="sm" variant="ghost" icon onClick={closeThread} aria-label="Back to messages">
            <ChevronLeftIcon size={15} />
          </Button>
          <span className="card__title">{activePeerName}</span>
        </div>

        <div className="chat__scroll">
          {thread.length === 0 ? (
            <EmptyState
              icon={<ChatIcon size={22} />}
              title="No messages yet"
              text={`Nothing sent between this device and ${activePeerName} yet.`}
            />
          ) : (
            thread.map((message) => (
              <div key={message.id} className={message.fromSelf ? 'msg is-mine' : 'msg'}>
                <div className="msg__head">
                  <span className="msg__author">{message.fromSelf ? 'You' : activePeerName}</span>
                  <span className="msg__time">{clockTime(message.sentAt)}</span>
                </div>
                <div className="msg__body">{message.content}</div>
              </div>
            ))
          )}
        </div>

        <div className="composer">
          <textarea
            className="input composer__input"
            value={draft}
            placeholder={`Message ${activePeerName}`}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <Button variant="primary" icon disabled={!draft.trim()} onClick={submit} aria-label="Send">
            <SendIcon size={16} />
          </Button>
        </div>
      </div>
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

  return (
    <div className="stack">
      {threads.length > 0 && (
        <section className="card">
          <div className="card__header">
            <div style={{ flex: 1 }}>
              <h3 className="card__title">Recent</h3>
            </div>
          </div>
          {threads.map((summary) => (
            <button
              key={summary.peerId}
              className="member dm-thread"
              onClick={() => openThread(summary.peerId, summary.peerName)}
            >
              <span className="member__avatar">{initials(summary.peerName)}</span>
              <div className="member__body">
                <div className="member__name">
                  {summary.peerName}
                  {offlineThreads.includes(summary) ? (
                    <span className="text-secondary text-sm"> · offline</span>
                  ) : null}
                </div>
                <div className="member__meta">
                  {truncate(summary.lastMessage, 60)} · {relativeTime(summary.lastAt)}
                </div>
              </div>
              {summary.unread > 0 ? <Badge tone="accent">{summary.unread}</Badge> : null}
            </button>
          ))}
        </section>
      )}

      <section className="card">
        <div className="card__header">
          <div style={{ flex: 1 }}>
            <h3 className="card__title">Devices on this network</h3>
            <p className="card__desc">
              Message another machine directly — no room, no history shared with anyone else.
            </p>
          </div>
          <Badge>{reachable.length}</Badge>
        </div>

        {reachable.length === 0 ? (
          <EmptyState
            icon={<UsersIcon size={22} />}
            title="No devices in range"
            text="Devices appear here once Campus Connect is running on them and they are on the same network."
          />
        ) : (
          reachable.map((peer) => (
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
      </section>
    </div>
  );
}
