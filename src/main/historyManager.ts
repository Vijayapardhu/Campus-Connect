import { randomUUID } from 'node:crypto';
import type { ChatMessage, ClipboardHistoryEntry } from '../shared/types';

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
    this.clipboard = trimPerRoom(this.clipboard, MAX_CLIPBOARD_PER_ROOM);
    this.scheduleFlush();
    return entry;
  }

  addChatMessage(
    type: ChatMessage['type'],
    content: string,
    deviceId: string,
    deviceName: string,
    roomId: string,
    dataUrl?: string,
    fileName?: string,
    id: string = randomUUID(),
    timestamp: number = Date.now()
  ): ChatMessage {
    const message: ChatMessage = {
      id,
      type,
      content,
      dataUrl,
      fileName,
      deviceId,
      deviceName,
      roomId,
      timestamp
    };

    this.chat.unshift(message);
    this.chat = trimPerRoom(this.chat, MAX_CHAT_PER_ROOM);
    this.scheduleFlush();
    return message;
  }

  hasChatMessage(id: string): boolean {
    return this.chat.some((message) => message.id === id);
  }

  getClipboardHistory(roomId?: string): ClipboardHistoryEntry[] {
    return roomId ? this.clipboard.filter((entry) => entry.roomId === roomId) : this.clipboard;
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

  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    this.persistence.writeClipboard(this.clipboard.map(stripHeavyDataUrl));
    this.persistence.writeChat(this.chat.map(stripHeavyDataUrl));
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

function trimPerRoom<T extends { roomId: string }>(items: T[], limit: number): T[] {
  const counts = new Map<string, number>();
  return items.filter((item) => {
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
