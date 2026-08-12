import { randomUUID } from 'node:crypto';
import type {
  ChatMessage,
  ChatReplyTo,
  ClipboardHistoryEntry,
  SearchHit,
  StorageStats
} from '../shared/types';

/*
 * Per-room retention.
 *
 * These were held down by where the history was stored rather than by what a
 * machine could hold: every entry sat in `config.json`, which electron-store
 * rewrites in full on every write, so each extra clip made every unrelated
 * setting change more expensive. History now has its own file, and the cost of
 * keeping more of it is the file itself — a few MB of JSON against caps a
 * laptop would not notice.
 *
 * Chat is allowed an order of magnitude more than clipboard because a message
 * is a line of text while a clip can be an image; the byte ceilings below and
 * `maxStorageMb` are what actually bound the attachments.
 */
export const MAX_CLIPBOARD_PER_ROOM = 500;
export const MAX_CHAT_PER_ROOM = 5000;
/**
 * Images above this size stay in memory but are not written to disk — so a
 * screenshot larger than this pastes fine all session and is gone by the next
 * launch, which reads as the app losing things at random.
 *
 * 256 KB was sized against a history that shared `config.json` with every
 * setting the app owns, where each persisted image was re-serialised on every
 * unrelated write. History has its own file now and the storage ceiling is
 * 1 GB, so the old number had become the binding constraint for no remaining
 * reason: a plain screenshot on an ordinary display clears 256 KB easily and
 * comfortably fits 1 MB.
 *
 * Worst case is bounded by the two limits either side of it —
 * `MAX_CLIPBOARD_PER_ROOM` entries at this size, swept back under
 * `maxStorageMb` by `compact()` — so raising it widens what survives a restart
 * without moving the ceiling on what the app will store.
 */
const MAX_PERSISTED_DATA_URL_BYTES = 1024 * 1024;
const PERSIST_DEBOUNCE_MS = 750;

export interface HistoryPersistence {
  readClipboard(): ClipboardHistoryEntry[];
  writeClipboard(entries: ClipboardHistoryEntry[]): void;
  readChat(): ChatMessage[];
  writeChat(messages: ChatMessage[]): void;
}

export class HistoryManager {
  private clipboard: ClipboardHistoryEntry[];
  private chat: ChatMessage[];
  private flushTimer: NodeJS.Timeout | null = null;
  private clearedAttachments = 0;

  constructor(private readonly persistence: HistoryPersistence) {
    this.clipboard = persistence.readClipboard();
    this.chat = persistence.readChat();
  }

  addClipboardEntry(
    kind: 'text' | 'image',
    text: string,
    deviceId: string,
    deviceName: string,
    roomId: string,
    dataUrl?: string
  ): ClipboardHistoryEntry | undefined {
    // The clipboard is polled on a timer, so the same copy can surface twice.
    const newest = this.clipboard.find((entry) => entry.roomId === roomId);
    if (newest && newest.kind === kind && newest.text === text && newest.dataUrl === dataUrl) {
      return undefined;
    }

    const entry: ClipboardHistoryEntry = {
      id: randomUUID(),
      kind,
      text,
      dataUrl,
      deviceId,
      deviceName,
      roomId,
      timestamp: Date.now()
    };

    this.clipboard.unshift(entry);
    this.trimClipboard();
    this.scheduleFlush();
    return entry;
  }

  /** Returns the new pinned state, or undefined when the entry is gone. */
  togglePin(entryId: string): boolean | undefined {
    const entry = this.clipboard.find((candidate) => candidate.id === entryId);
    if (!entry) {
      return undefined;
    }

    entry.pinned = !entry.pinned;
    // Unpinning can push an old entry back over the cap.
    this.trimClipboard();
    this.scheduleFlush();
    return entry.pinned;
  }

  addChatMessage(input: {
    type: ChatMessage['type'];
    content: string;
    deviceId: string;
    deviceName: string;
    roomId: string;
    dataUrl?: string;
    fileName?: string;
    fileSize?: number;
    replyTo?: ChatReplyTo;
    /** Resolved by the caller against the room roster — see `shared/mentions.ts`. */
    mentions?: string[];
    /** Supplied when relaying a message received from another device. */
    id?: string;
    timestamp?: number;
  }): ChatMessage {
    const message: ChatMessage = {
      id: input.id ?? randomUUID(),
      type: input.type,
      content: input.content,
      dataUrl: input.dataUrl,
      fileName: input.fileName,
      fileSize: input.fileSize,
      replyTo: input.replyTo,
      mentions: input.mentions,
      deviceId: input.deviceId,
      deviceName: input.deviceName,
      roomId: input.roomId,
      timestamp: input.timestamp ?? Date.now()
    };

    this.chat.unshift(message);
    this.trimChat();
    this.scheduleFlush();
    return message;
  }

  /**
   * Bookmarks a message, or takes the bookmark back. Returns the new state, or
   * undefined when the message is gone.
   *
   * **Local to this device.** A pin is a note to yourself about where something
   * useful is, the same as pinning a clipboard entry — not a claim about the
   * conversation that everyone else has to agree with. Nothing is sent, and
   * nobody else's copy changes.
   */
  toggleChatPin(id: string): boolean | undefined {
    const message = this.findChatMessage(id);
    if (!message) {
      return undefined;
    }

    message.pinned = !message.pinned;
    // Unpinning can push an old message back over the cap.
    this.trimChat();
    this.scheduleFlush();
    return message.pinned;
  }

  findChatMessage(id: string): ChatMessage | undefined {
    return this.chat.find((message) => message.id === id);
  }

  /**
   * Rewrites a message's text. Only the author may, which is checked here as
   * well as at the wire, because this is also reached from the local UI.
   */
  editChatMessage(
    id: string,
    content: string,
    authorId: string,
    editedAt: number,
    /** Re-resolved from the new text — an edit can add or remove an `@Name`. */
    mentions?: string[]
  ): ChatMessage | undefined {
    const message = this.findChatMessage(id);
    if (!message || message.deviceId !== authorId || message.deleted || message.type !== 'text') {
      return undefined;
    }

    message.content = content;
    message.editedAt = editedAt;
    message.mentions = mentions;
    this.scheduleFlush();
    return message;
  }

  /**
   * Withdraws a message for everyone. The entry stays as a marker — a reply
   * pointing at it still makes sense — but nothing of its content survives,
   * including any attachment.
   */
  markChatMessageDeleted(id: string, authorId: string): ChatMessage | undefined {
    const message = this.findChatMessage(id);
    if (!message || message.deviceId !== authorId) {
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

  /** Removes a message from this device alone. */
  deleteChatMessage(id: string): ChatMessage | undefined {
    const message = this.findChatMessage(id);
    if (!message) {
      return undefined;
    }

    this.chat = this.chat.filter((candidate) => candidate.id !== id);
    this.scheduleFlush();
    return message;
  }

  /** Adds or removes one device's reaction. Returns true when it changed. */
  setChatReaction(id: string, emoji: string, deviceId: string, on: boolean): boolean {
    const message = this.findChatMessage(id);
    if (!message || message.deleted) {
      return false;
    }

    const reactions = { ...(message.reactions ?? {}) };
    const current = reactions[emoji] ?? [];
    const has = current.includes(deviceId);

    if (on === has) {
      return false;
    }

    const next = on ? [...current, deviceId] : current.filter((candidate) => candidate !== deviceId);
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
   * Records a receipt against one of our own messages. Returns true when
   * something actually changed, so the caller can avoid a needless redraw.
   *
   * Scoped to `roomId` as well as the message ids, not just the ids alone —
   * the caller only ever checks that `fromDeviceId` is an accepted member of
   * `roomId`, which says nothing about whether the ids it also sent actually
   * belong to that room. Without this, a device that is a member of one room
   * and merely holds local history for another (from having been a member of
   * it before, or simply because this device is in both) could claim a
   * receipt against messages entirely outside the room its membership was
   * actually checked against, forging delivery/seen state other members
   * later see attached to their own messages in a room the sender never
   * proved anything about.
   */
  recordReceipt(messageIds: string[], fromDeviceId: string, receipt: 'delivered' | 'seen', roomId: string): boolean {
    let changed = false;

    for (const message of this.chat) {
      if (message.roomId !== roomId || !messageIds.includes(message.id)) {
        continue;
      }

      // 'seen' implies delivered — a receipt can arrive without its predecessor.
      const lists: Array<'deliveredTo' | 'seenBy'> =
        receipt === 'seen' ? ['deliveredTo', 'seenBy'] : ['deliveredTo'];

      for (const field of lists) {
        const current = message[field] ?? [];
        if (!current.includes(fromDeviceId)) {
          message[field] = [...current, fromDeviceId];
          changed = true;
        }
      }
    }

    if (changed) {
      this.scheduleFlush();
    }
    return changed;
  }

  /** Ids of messages in a room that came from someone else. */
  incomingMessageIds(roomId: string, selfDeviceId: string): string[] {
    return this.chat
      .filter((message) => message.roomId === roomId && message.deviceId !== selfDeviceId)
      .map((message) => message.id);
  }

  hasChatMessage(id: string): boolean {
    return this.chat.some((message) => message.id === id);
  }

  /** Newest first, with pinned entries lifted to the top of each room. */
  getClipboardHistory(roomId?: string): ClipboardHistoryEntry[] {
    const entries = roomId
      ? this.clipboard.filter((entry) => entry.roomId === roomId)
      : this.clipboard;

    // Array#sort is stable, so recency order survives within each group.
    return [...entries].sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false));
  }

  getChatHistory(roomId?: string): ChatMessage[] {
    return roomId ? this.chat.filter((message) => message.roomId === roomId) : this.chat;
  }

  /**
   * Searching everything at once.
   *
   * Clipboard entries and chat messages are kept apart everywhere else, and when
   * you are trying to find something that distinction is precisely what you do
   * not want to have to make before you can start looking. So this searches both
   * across every room and returns one list, newest first.
   *
   * Case-insensitive substring rather than anything cleverer: the things people
   * look for here are URLs, commands and error messages, where a literal match
   * is what is wanted and fuzzy matching mostly produces noise.
   */
  search(query: string, roomNames: Map<string, string>, limit = 200): SearchHit[] {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) {
      return [];
    }

    const hits: SearchHit[] = [];

    for (const entry of this.clipboard) {
      const found = findExcerpt(entry.text, needle);
      if (!found) {
        continue;
      }

      hits.push({
        kind: 'clipboard',
        id: entry.id,
        roomId: entry.roomId,
        roomName: roomNames.get(entry.roomId) ?? 'A room you have left',
        deviceName: entry.deviceName,
        timestamp: entry.timestamp,
        ...found,
        hasMedia: Boolean(entry.dataUrl)
      });
    }

    for (const message of this.chat) {
      // A withdrawn message has no content to find, and surfacing it in a search
      // would undo the withdrawal.
      if (message.deleted) {
        continue;
      }

      const found = findExcerpt(`${message.content} ${message.fileName ?? ''}`, needle);
      if (!found) {
        continue;
      }

      hits.push({
        kind: 'chat',
        id: message.id,
        roomId: message.roomId,
        roomName: roomNames.get(message.roomId) ?? 'A room you have left',
        deviceName: message.deviceName,
        timestamp: message.timestamp,
        ...found,
        fileName: message.fileName,
        hasMedia: Boolean(message.dataUrl)
      });
    }

    return hits.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  }

  deleteClipboardEntry(entryId: string): void {
    this.clipboard = this.clipboard.filter((entry) => entry.id !== entryId);
    this.scheduleFlush();
  }

  clearRoom(roomId: string): void {
    this.clipboard = this.clipboard.filter((entry) => entry.roomId !== roomId);
    this.chat = this.chat.filter((message) => message.roomId !== roomId);
    this.scheduleFlush();
  }

  /**
   * Drops attachments that are past the retention window, then keeps dropping
   * the oldest remaining ones until the stored history fits the size ceiling.
   * The message and its filename always survive — only the payload goes, which
   * is what keeps a chat readable without keeping gigabytes of it.
   */
  compact(retainMediaDays: number, maxStorageMb: number): number {
    const cutoff = retainMediaDays > 0 ? Date.now() - retainMediaDays * 24 * 60 * 60 * 1000 : Infinity;
    let cleared = 0;

    const strip = <T extends { dataUrl?: string; timestamp: number }>(item: T): void => {
      if (item.dataUrl && item.timestamp < cutoff) {
        item.dataUrl = undefined;
        cleared += 1;
      }
    };

    for (const entry of this.clipboard) {
      strip(entry);
    }
    for (const message of this.chat) {
      if (message.dataUrl && message.timestamp < cutoff) {
        message.dataUrl = undefined;
        message.mediaCleared = true;
        cleared += 1;
      }
    }

    // Still too big: drop the oldest attachments that are left, newest last.
    const ceiling = maxStorageMb * 1024 * 1024;
    if (this.estimateBytes() > ceiling) {
      const withMedia = [...this.clipboard, ...this.chat]
        .filter((item) => Boolean(item.dataUrl))
        .sort((a, b) => a.timestamp - b.timestamp);

      for (const item of withMedia) {
        if (this.estimateBytes() <= ceiling) {
          break;
        }
        item.dataUrl = undefined;
        // `mediaCleared` is optional and, for a chat message reaching this
        // branch, has by definition never been set yet — `'mediaCleared' in
        // item` was therefore always false here, for both a clipboard entry
        // (which has no such field at all) and a chat message (which does,
        // but only after being assigned once). Discriminated on `content`
        // instead, the field only `ChatMessage` actually carries.
        if ('content' in item) {
          item.mediaCleared = true;
        }
        cleared += 1;
      }
    }

    this.clearedAttachments += cleared;
    if (cleared > 0) {
      this.flush();
    }
    return cleared;
  }

  stats(): StorageStats {
    let mediaBytes = 0;
    for (const item of [...this.clipboard, ...this.chat]) {
      mediaBytes += item.dataUrl?.length ?? 0;
    }

    return {
      totalBytes: this.estimateBytes(),
      mediaBytes,
      clipboardEntries: this.clipboard.length,
      chatMessages: this.chat.length,
      clearedAttachments: this.clearedAttachments
    };
  }

  /** Close enough: the store is JSON, so character count tracks file size. */
  private estimateBytes(): number {
    let total = 0;
    for (const item of [...this.clipboard, ...this.chat]) {
      total += (item.dataUrl?.length ?? 0) + 200;
      total += 'text' in item ? item.text.length : item.content.length;
    }
    return total;
  }

  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    this.persistence.writeClipboard(this.clipboard.map(stripHeavyDataUrl));
    this.persistence.writeChat(this.chat.map(stripHeavyDataUrl));
  }

  private trimChat(): void {
    // Same bargain pinning makes for the clipboard: a pinned message is exempt
    // from the cap, because being evicted is exactly what pinning prevents.
    this.chat = trimPerRoom(this.chat, MAX_CHAT_PER_ROOM, (message) => message.pinned === true);
  }

  private trimClipboard(): void {
    // Pinned entries are the point of pinning: they never count toward the cap
    // and are never evicted by it.
    this.clipboard = trimPerRoom(
      this.clipboard,
      MAX_CLIPBOARD_PER_ROOM,
      (entry) => entry.pinned === true
    );
  }

  /** Writes are batched: the clipboard poller would otherwise hit disk every second. */
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

function trimPerRoom<T extends { roomId: string }>(
  items: T[],
  limit: number,
  exempt?: (item: T) => boolean
): T[] {
  const counts = new Map<string, number>();
  return items.filter((item) => {
    if (exempt?.(item)) {
      return true;
    }
    const next = (counts.get(item.roomId) ?? 0) + 1;
    counts.set(item.roomId, next);
    return next <= limit;
  });
}

function stripHeavyDataUrl<T extends { dataUrl?: string }>(item: T): T {
  if (item.dataUrl && item.dataUrl.length > MAX_PERSISTED_DATA_URL_BYTES) {
    return { ...item, dataUrl: undefined };
  }
  return item;
}

/** How much of the surrounding line a hit carries, so a result reads in context. */
const EXCERPT_BEFORE = 40;
const EXCERPT_AFTER = 120;

/**
 * Finds a match and trims the value down to the part it is actually in.
 *
 * A clipboard entry can be a whole file, and showing its first line when the
 * match is two thousand characters further down tells the reader nothing.
 * Whitespace is flattened before searching rather than after, so the offsets
 * come back correct for the string that is actually displayed — the match can
 * then be highlighted rather than merely being somewhere in the excerpt.
 */
export function findExcerpt(
  text: string,
  needle: string
): { excerpt: string; matchStart: number; matchLength: number } | null {
  const flattened = text.replace(/\s+/g, ' ').trim();
  const at = flattened.toLowerCase().indexOf(needle);
  if (at === -1) {
    return null;
  }

  const start = Math.max(0, at - EXCERPT_BEFORE);
  const end = Math.min(flattened.length, at + needle.length + EXCERPT_AFTER);

  const head = start > 0 ? '…' : '';
  const tail = end < flattened.length ? '…' : '';

  return {
    excerpt: `${head}${flattened.slice(start, end)}${tail}`,
    matchStart: head.length + (at - start),
    matchLength: needle.length
  };
}
