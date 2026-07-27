import { randomUUID } from 'node:crypto';
import type { ChatMessage, ClipboardHistoryEntry, StorageStats } from '../shared/types';

const MAX_CLIPBOARD_PER_ROOM = 100;
const MAX_CHAT_PER_ROOM = 500;
/** Images above this size stay in memory but are not written to disk. */
const MAX_PERSISTED_DATA_URL_BYTES = 256 * 1024;
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
      deviceId: input.deviceId,
      deviceName: input.deviceName,
      roomId: input.roomId,
      timestamp: input.timestamp ?? Date.now()
    };

    this.chat.unshift(message);
    this.chat = trimPerRoom(this.chat, MAX_CHAT_PER_ROOM);
    this.scheduleFlush();
    return message;
  }

  /**
   * Records a receipt against one of our own messages. Returns true when
   * something actually changed, so the caller can avoid a needless redraw.
   */
  recordReceipt(messageIds: string[], fromDeviceId: string, receipt: 'delivered' | 'seen'): boolean {
    let changed = false;

    for (const message of this.chat) {
      if (!messageIds.includes(message.id)) {
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
        if ('mediaCleared' in item) {
          (item as ChatMessage).mediaCleared = true;
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
