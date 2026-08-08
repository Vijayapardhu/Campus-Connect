import { randomUUID } from 'node:crypto';
import type { ChatReplyTo, DirectMessage, DirectMessageSignal, DmThreadSummary, SearchHit } from '../shared/types';
import { findExcerpt } from './historyManager';

/**
 * Direct 1:1 messages — device-to-device, the same reach as file sharing and
 * for the same reason: anyone currently visible on the network, no room in
 * common required. Modelled on `HistoryManager`'s in-memory-plus-debounced-
 * flush shape, but keyed by peer device id instead of room id, since a
 * message here never belongs to a room at all.
 *
 * Edit/delete/react follow the exact rules `HistoryManager`'s equivalents do
 * for room chat: author-only, and a delete-for-everyone leaves a tombstone
 * rather than removing the row outright, so a reply still resolves. The one
 * thing there is no `deviceId` to check ownership against here — a thread
 * only ever has two sides — so ownership is `fromSelf` instead: the caller
 * states which side the edit/delete must belong to, `true` for one this
 * device is applying to its own sent message, `false` for one arriving from
 * the peer about a message *they* sent.
 */

const PERSIST_DEBOUNCE_MS = 750;
/** Per peer, not overall — a chatty thread should not crowd out a quiet one. */
const MAX_MESSAGES_PER_PEER = 500;

export interface DirectMessagePersistence {
  read(): DirectMessage[];
  write(messages: DirectMessage[]): void;
  /** Peer ids whose thread is archived — collapsed in the UI, not deleted. */
  readArchived(): string[];
  writeArchived(peerIds: string[]): void;
}

export class DirectMessageManager {
  private messages: DirectMessage[];
  /** Unread counts, in memory only — reset on restart, same as a phone's own notification tray. */
  private unread = new Map<string, number>();
  private archived: Set<string>;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(private readonly persistence: DirectMessagePersistence) {
    this.messages = persistence.read();
    this.archived = new Set(persistence.readArchived());
  }

  /** This device sending. Returns the stored message for local echo. */
  send(
    peerId: string,
    peerName: string,
    input: {
      type: DirectMessage['type'];
      content: string;
      dataUrl?: string;
      fileName?: string;
      fileSize?: number;
      replyTo?: ChatReplyTo;
    }
  ): DirectMessage {
    const message: DirectMessage = {
      id: randomUUID(),
      peerId,
      peerName,
      fromSelf: true,
      type: input.type,
      content: input.content,
      dataUrl: input.dataUrl,
      fileName: input.fileName,
      fileSize: input.fileSize,
      replyTo: input.replyTo,
      sentAt: Date.now()
    };
    this.store(message);
    // Sending into a thread is as good a signal as reading it that this
    // device is paying attention to it again — an archived thread you just
    // wrote into staying tucked away would be surprising.
    this.archived.delete(peerId);
    this.persistArchived();
    return message;
  }

  /**
   * A new message that arrived off the wire. Keyed by the sender's own id
   * rather than minting a fresh one, so a retransmitted signal cannot double
   * the message — returns `undefined` for a duplicate, which the caller reads
   * as "nothing new to show."
   *
   * The duplicate check is scoped to this peer's own messages, not the whole
   * store. `id` is chosen by whoever sends it, with nothing here to stop two
   * different devices choosing the same one — scoping only by `id` would let
   * one peer's message get silently swallowed as an apparent "retransmit" of
   * some other peer's.
   */
  receive(peerId: string, peerName: string, signal: DirectMessageSignal & { kind: 'message' }): DirectMessage | undefined {
    if (this.messages.some((existing) => existing.peerId === peerId && existing.id === signal.id)) {
      return undefined;
    }

    const message: DirectMessage = {
      id: signal.id,
      peerId,
      peerName,
      fromSelf: false,
      type: signal.type,
      content: signal.content,
      dataUrl: signal.dataUrl,
      fileName: signal.fileName,
      fileSize: signal.fileSize,
      replyTo: signal.replyTo,
      sentAt: signal.sentAt
    };
    this.store(message);
    this.unread.set(peerId, (this.unread.get(peerId) ?? 0) + 1);
    return message;
  }

  /** One message, from either side of the thread. */
  findMessage(peerId: string, id: string): DirectMessage | undefined {
    return this.messages.find((message) => message.peerId === peerId && message.id === id);
  }

  /**
   * Edits a message's text. `fromSelf` is what the message's own flag must
   * already equal — the caller decides which side is allowed to be editing
   * right now, this only checks the message actually belongs to that side.
   */
  editMessage(peerId: string, id: string, content: string, editedAt: number, fromSelf: boolean): DirectMessage | undefined {
    const message = this.findMessage(peerId, id);
    if (!message || message.fromSelf !== fromSelf || message.deleted || message.type !== 'text') {
      return undefined;
    }

    message.content = content;
    message.editedAt = editedAt;
    this.scheduleFlush();
    return message;
  }

  /**
   * Withdraws a message for both sides of the thread. The entry stays as a
   * tombstone — a reply pointing at it still makes sense — but nothing of its
   * content survives, including any attachment.
   */
  markDeleted(peerId: string, id: string, fromSelf: boolean): DirectMessage | undefined {
    const message = this.findMessage(peerId, id);
    if (!message || message.fromSelf !== fromSelf) {
      return undefined;
    }
    if (message.deleted) {
      return message; // Already gone; repeat arrivals are not a problem.
    }

    message.deleted = true;
    message.content = '';
    message.dataUrl = undefined;
    message.fileName = undefined;
    message.fileSize = undefined;
    message.reactions = undefined;
    message.editedAt = undefined;
    this.scheduleFlush();
    return message;
  }

  /**
   * Bookmarks a message in a thread, or takes the bookmark back. Returns the
   * updated message, or undefined when it is gone.
   *
   * Local to this device, exactly like `HistoryManager.toggleChatPin` — nothing
   * is sent, and the peer's copy is untouched.
   */
  togglePin(peerId: string, id: string): DirectMessage | undefined {
    const message = this.findMessage(peerId, id);
    if (!message) {
      return undefined;
    }

    message.pinned = !message.pinned;
    // Unpinning can push an old message back over the cap.
    this.trim(peerId);
    this.scheduleFlush();
    return message;
  }

  /** Removes a message from this device alone — no ownership check, since deleting your own copy needs none. */
  deleteMessageLocal(peerId: string, id: string): boolean {
    const before = this.messages.length;
    this.messages = this.messages.filter((message) => !(message.peerId === peerId && message.id === id));
    if (this.messages.length === before) {
      return false;
    }
    this.scheduleFlush();
    return true;
  }

  /** Toggles one device's reaction to a message. `actorId` is whichever device is reacting — this device's own id for a local reaction, the peer's for one arriving off the wire. */
  setReaction(peerId: string, id: string, emoji: string, actorId: string, on: boolean): boolean {
    const message = this.findMessage(peerId, id);
    if (!message || message.deleted) {
      return false;
    }

    const reactions = { ...(message.reactions ?? {}) };
    const current = reactions[emoji] ?? [];
    const has = current.includes(actorId);

    if (on === has) {
      return false;
    }

    const next = on ? [...current, actorId] : current.filter((candidate) => candidate !== actorId);
    if (next.length > 0) {
      reactions[emoji] = next;
    } else {
      delete reactions[emoji];
    }

    message.reactions = Object.keys(reactions).length > 0 ? reactions : undefined;
    this.scheduleFlush();
    return true;
  }

  /**
   * Records that the peer on the other end of this thread has received or
   * read some of this device's own messages. The same shape
   * `HistoryManager.recordReceipt` uses for a room, narrowed to the one peer
   * a DM thread ever has: `deliveredTo`/`seenBy` end up holding at most that
   * one id, which is what lets the shared `statusOf`/`Receipt` rendering
   * treat a DM exactly like a two-member room.
   */
  recordReceipt(peerId: string, messageIds: string[], receipt: 'delivered' | 'seen'): DirectMessage[] {
    const changed: DirectMessage[] = [];

    for (const message of this.messages) {
      if (message.peerId !== peerId || !message.fromSelf || !messageIds.includes(message.id)) {
        continue;
      }

      // 'seen' implies delivered — a receipt can arrive without its predecessor.
      const fields: Array<'deliveredTo' | 'seenBy'> = receipt === 'seen' ? ['deliveredTo', 'seenBy'] : ['deliveredTo'];
      let touched = false;

      for (const field of fields) {
        const current = message[field] ?? [];
        if (!current.includes(peerId)) {
          message[field] = [...current, peerId];
          touched = true;
        }
      }

      if (touched) {
        changed.push(message);
      }
    }

    if (changed.length > 0) {
      this.scheduleFlush();
    }
    return changed;
  }

  markRead(peerId: string): void {
    this.unread.delete(peerId);
  }

  /** Collapsed into the "Archived" section of the Messages page rather than the main thread list — not deleted. */
  setArchived(peerId: string, archived: boolean): void {
    if (archived) {
      this.archived.add(peerId);
    } else {
      this.archived.delete(peerId);
    }
    this.persistArchived();
  }

  /** Removes an entire thread's history from this device. Local only, the same as any other "delete for me." */
  deleteThread(peerId: string): void {
    this.messages = this.messages.filter((message) => message.peerId !== peerId);
    this.unread.delete(peerId);
    this.archived.delete(peerId);
    this.scheduleFlush();
    this.persistArchived();
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
        lastMessage: summarize(latest),
        lastAt: latest.sentAt,
        unread: this.unread.get(latest.peerId) ?? 0,
        archived: this.archived.has(latest.peerId)
      }))
      .sort((a, b) => b.lastAt - a.lastAt);
  }

  /** The full thread with one peer, oldest first — how a chat reads top to bottom. */
  getThread(peerId: string): DirectMessage[] {
    return this.messages
      .filter((message) => message.peerId === peerId)
      .sort((a, b) => a.sentAt - b.sentAt);
  }

  /**
   * The DM half of universal search — same shape `HistoryManager.search`
   * returns, `kind: 'dm'` so the renderer knows to open a thread rather than
   * switch rooms. `selfName` labels a self-sent hit the way the room chat
   * search already does with "You" elsewhere, kept as the real device name
   * here since that is what `DirectMessage` itself never actually stores.
   */
  search(query: string, selfName: string, limit = 200): SearchHit[] {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) {
      return [];
    }

    const hits: SearchHit[] = [];

    for (const message of this.messages) {
      // A withdrawn message has no content to find, and surfacing it would
      // undo the withdrawal — the same rule room chat's own search follows.
      if (message.deleted) {
        continue;
      }

      const found = findExcerpt(`${message.content} ${message.fileName ?? ''}`, needle);
      if (!found) {
        continue;
      }

      hits.push({
        kind: 'dm',
        id: message.id,
        peerId: message.peerId,
        peerName: message.peerName,
        deviceName: message.fromSelf ? selfName : message.peerName,
        timestamp: message.sentAt,
        ...found,
        fileName: message.fileName,
        hasMedia: Boolean(message.dataUrl)
      });
    }

    return hits.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  }

  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.persistence.write(this.messages);
  }

  private persistArchived(): void {
    this.persistence.writeArchived([...this.archived]);
  }

  private store(message: DirectMessage): void {
    this.messages.push(message);
    this.trim(message.peerId);
    this.scheduleFlush();
  }

  private trim(peerId: string): void {
    const forPeer = this.messages
      // Pinned messages neither count toward the cap nor are evicted by it —
      // the same bargain `HistoryManager` makes, since being evicted is the
      // one thing pinning exists to prevent.
      .filter((message) => message.peerId === peerId && !message.pinned)
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

/** What shows in the thread list for a message that might be a file, an image, or withdrawn. */
function summarize(message: DirectMessage): string {
  if (message.deleted) {
    return message.fromSelf ? 'You deleted a message' : 'This message was deleted';
  }
  if (message.type === 'text') {
    return message.content;
  }
  return message.fileName ?? (message.type === 'image' ? 'Photo' : 'File');
}
