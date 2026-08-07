import { randomUUID } from 'node:crypto';
import type { DirectMessage, DirectMessageSignal, DmThreadSummary } from '../shared/types';

/**
 * Direct 1:1 messages — device-to-device, the same reach as file sharing and
 * for the same reason: anyone currently visible on the network, no room in
 * common required. Modelled on `HistoryManager`'s in-memory-plus-debounced-
 * flush shape, but keyed by peer device id instead of room id, since a
 * message here never belongs to a room at all.
 */

const PERSIST_DEBOUNCE_MS = 750;
/** Per peer, not overall — a chatty thread should not crowd out a quiet one. */
const MAX_MESSAGES_PER_PEER = 500;

export interface DirectMessagePersistence {
  read(): DirectMessage[];
  write(messages: DirectMessage[]): void;
}

export class DirectMessageManager {
  private messages: DirectMessage[];
  /** Unread counts, in memory only — reset on restart, same as a phone's own notification tray. */
  private unread = new Map<string, number>();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(private readonly persistence: DirectMessagePersistence) {
    this.messages = persistence.read();
  }

  /** This device sending. Returns the stored message for local echo. */
  send(peerId: string, peerName: string, content: string): DirectMessage {
    const message: DirectMessage = {
      id: randomUUID(),
      peerId,
      peerName,
      fromSelf: true,
      content,
      sentAt: Date.now()
    };
    this.store(message);
    return message;
  }

  /**
   * A message that arrived off the wire. Keyed by the sender's own id rather
   * than minting a fresh one, so a retransmitted signal cannot double the
   * message — returns `undefined` for a duplicate, which the caller reads as
   * "nothing new to show."
   *
   * The duplicate check is scoped to this peer's own messages, not the whole
   * store. `id` is chosen by whoever sends it, with nothing here to stop two
   * different devices choosing the same one — scoping only by `id` would let
   * one peer's message get silently swallowed as an apparent "retransmit" of
   * some other peer's.
   */
  receive(peerId: string, peerName: string, signal: DirectMessageSignal): DirectMessage | undefined {
    if (this.messages.some((existing) => existing.peerId === peerId && existing.id === signal.id)) {
      return undefined;
    }

    const message: DirectMessage = {
      id: signal.id,
      peerId,
      peerName,
      fromSelf: false,
      content: signal.content,
      sentAt: signal.sentAt
    };
    this.store(message);
    this.unread.set(peerId, (this.unread.get(peerId) ?? 0) + 1);
    return message;
  }

  markRead(peerId: string): void {
    this.unread.delete(peerId);
  }

  /** One row per peer ever messaged, newest thread first. */
  listThreads(): DmThreadSummary[] {
    const latestByPeer = new Map<string, DirectMessage>();
    for (const message of this.messages) {
      const current = latestByPeer.get(message.peerId);
      if (!current || message.sentAt > current.sentAt) {
        latestByPeer.set(message.peerId, message);
      }
    }

    return [...latestByPeer.values()]
      .map((latest) => ({
        peerId: latest.peerId,
        peerName: latest.peerName,
        lastMessage: latest.content,
        lastAt: latest.sentAt,
        unread: this.unread.get(latest.peerId) ?? 0
      }))
      .sort((a, b) => b.lastAt - a.lastAt);
  }

  /** The full thread with one peer, oldest first — how a chat reads top to bottom. */
  getThread(peerId: string): DirectMessage[] {
    return this.messages
      .filter((message) => message.peerId === peerId)
      .sort((a, b) => a.sentAt - b.sentAt);
  }

  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.persistence.write(this.messages);
  }

  private store(message: DirectMessage): void {
    this.messages.push(message);
    this.trim(message.peerId);
    this.scheduleFlush();
  }

  private trim(peerId: string): void {
    const forPeer = this.messages
      .filter((message) => message.peerId === peerId)
      .sort((a, b) => a.sentAt - b.sentAt);
    if (forPeer.length <= MAX_MESSAGES_PER_PEER) {
      return;
    }

    const drop = new Set(forPeer.slice(0, forPeer.length - MAX_MESSAGES_PER_PEER).map((message) => message.id));
    this.messages = this.messages.filter((message) => !drop.has(message.id));
  }

  /** Writes are batched, the same reason `HistoryManager`'s are. */
  private scheduleFlush(): void {
    if (this.flushTimer) {
      return;
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, PERSIST_DEBOUNCE_MS);
  }
}
