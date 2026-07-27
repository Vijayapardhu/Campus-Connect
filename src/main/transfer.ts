/**
 * Reassembling messages that were too large for a single datagram.
 *
 * UDP gives no ordering and no delivery guarantee, so the assembler has to
 * cope with chunks arriving out of order, duplicated, or not at all. It is
 * also the most obvious place for a hostile device on the network to try to
 * exhaust memory, so every limit here is deliberate: a transfer that never
 * completes is dropped, and one that would push the buffer past its ceiling is
 * refused outright rather than making room by evicting someone else's.
 *
 * No Electron imports — this file is covered by `npm test`.
 */

export type Chunk = {
  transferId: string;
  index: number;
  total: number;
  data: string;
};

export type PendingTransfer = {
  senderId: string;
  transferId: string;
  received: number;
  total: number;
  startedAt: number;
  lastChunkAt: number;
};

export type AssemblerLimits = {
  /** Ceiling on a single reassembled message. */
  maxMessageBytes: number;
  /** Ceiling across every in-flight transfer combined. */
  maxTotalBytes: number;
  maxConcurrentTransfers: number;
  maxChunks: number;
  /** A transfer making no progress for this long is abandoned. */
  ttlMs: number;
};

export const DEFAULT_LIMITS: AssemblerLimits = {
  // Comfortably above the sender's own ceiling, so a legitimate transfer is
  // never refused at the far end for being a few bytes over.
  maxMessageBytes: 20 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxConcurrentTransfers: 24,
  // 16 MB at 8 KB per chunk needs ~2050, so this leaves comfortable headroom.
  maxChunks: 4096,
  ttlMs: 20000
};

type Entry = {
  senderId: string;
  transferId: string;
  parts: Array<string | undefined>;
  received: number;
  total: number;
  bytes: number;
  startedAt: number;
  lastChunkAt: number;
};

/** Splits a string into pieces of at most `size` characters. */
export function splitIntoChunks(text: string, size: number): string[] {
  if (size <= 0) {
    throw new Error('Chunk size must be positive');
  }

  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += size) {
    chunks.push(text.slice(offset, offset + size));
  }
  return chunks.length > 0 ? chunks : [''];
}

export class ChunkAssembler {
  private entries = new Map<string, Entry>();
  /**
   * Transfers already delivered, kept briefly. Chunks go out by broadcast *and*
   * unicast, so a second copy of every chunk is normal — without this the
   * duplicate set would start a fresh transfer and deliver the same message
   * twice.
   */
  private completed = new Map<string, number>();
  private bufferedBytes = 0;

  constructor(private readonly limits: AssemblerLimits = DEFAULT_LIMITS) {}

  /**
   * Takes one chunk. Returns the complete message once the last missing piece
   * arrives, otherwise null. Invalid or over-quota chunks are dropped silently
   * — a hostile sender should not be able to produce log spam either.
   */
  accept(senderId: string, chunk: Chunk, now = Date.now()): string | null {
    if (!isValidChunk(chunk, this.limits.maxChunks)) {
      return null;
    }

    const key = `${senderId}:${chunk.transferId}`;

    if (this.completed.has(key)) {
      return null;
    }

    let entry = this.entries.get(key);

    if (!entry) {
      if (this.entries.size >= this.limits.maxConcurrentTransfers) {
        return null;
      }

      entry = {
        senderId,
        transferId: chunk.transferId,
        parts: new Array<string | undefined>(chunk.total),
        received: 0,
        total: chunk.total,
        bytes: 0,
        startedAt: now,
        lastChunkAt: now
      };
      this.entries.set(key, entry);
    }

    // A sender that changes `total` mid-transfer is malfunctioning or hostile.
    if (entry.total !== chunk.total || chunk.index >= entry.total) {
      this.drop(key);
      return null;
    }

    entry.lastChunkAt = now;

    // Duplicates are expected: chunks are broadcast and unicast, and a NACK
    // can be answered after the original finally arrives.
    if (entry.parts[chunk.index] !== undefined) {
      return null;
    }

    const size = chunk.data.length;
    if (entry.bytes + size > this.limits.maxMessageBytes) {
      this.drop(key);
      return null;
    }
    if (this.bufferedBytes + size > this.limits.maxTotalBytes) {
      this.drop(key);
      return null;
    }

    entry.parts[chunk.index] = chunk.data;
    entry.received += 1;
    entry.bytes += size;
    this.bufferedBytes += size;

    if (entry.received < entry.total) {
      return null;
    }

    this.drop(key);
    this.completed.set(key, now);
    return entry.parts.join('');
  }

  missing(senderId: string, transferId: string): number[] {
    const entry = this.entries.get(`${senderId}:${transferId}`);
    if (!entry) {
      return [];
    }

    const gaps: number[] = [];
    for (let index = 0; index < entry.total; index += 1) {
      if (entry.parts[index] === undefined) {
        gaps.push(index);
      }
    }
    return gaps;
  }

  /** Transfers still waiting on chunks, for the retransmission sweep. */
  pending(): PendingTransfer[] {
    return Array.from(this.entries.values()).map((entry) => ({
      senderId: entry.senderId,
      transferId: entry.transferId,
      received: entry.received,
      total: entry.total,
      startedAt: entry.startedAt,
      lastChunkAt: entry.lastChunkAt
    }));
  }

  /** Abandons transfers that have gone quiet. Returns what was dropped. */
  sweep(now = Date.now()): PendingTransfer[] {
    const expired: PendingTransfer[] = [];

    for (const [key, at] of this.completed) {
      if (now - at > this.limits.ttlMs) {
        this.completed.delete(key);
      }
    }

    for (const [key, entry] of this.entries) {
      if (now - entry.lastChunkAt > this.limits.ttlMs) {
        expired.push({
          senderId: entry.senderId,
          transferId: entry.transferId,
          received: entry.received,
          total: entry.total,
          startedAt: entry.startedAt,
          lastChunkAt: entry.lastChunkAt
        });
        this.drop(key);
      }
    }

    return expired;
  }

  /** Forgets everything from one device — used when it leaves a room. */
  forgetSender(senderId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.senderId === senderId) {
        this.drop(key);
      }
    }

    const prefix = `${senderId}:`;
    for (const key of this.completed.keys()) {
      if (key.startsWith(prefix)) {
        this.completed.delete(key);
      }
    }
  }

  get inFlight(): number {
    return this.entries.size;
  }

  get buffered(): number {
    return this.bufferedBytes;
  }

  private drop(key: string): void {
    const entry = this.entries.get(key);
    if (entry) {
      this.bufferedBytes -= entry.bytes;
      this.entries.delete(key);
    }
  }
}

function isValidChunk(chunk: Chunk, maxChunks: number): boolean {
  return (
    typeof chunk.transferId === 'string' &&
    chunk.transferId.length > 0 &&
    chunk.transferId.length <= 64 &&
    Number.isInteger(chunk.total) &&
    chunk.total > 0 &&
    chunk.total <= maxChunks &&
    Number.isInteger(chunk.index) &&
    chunk.index >= 0 &&
    chunk.index < chunk.total &&
    typeof chunk.data === 'string'
  );
}
