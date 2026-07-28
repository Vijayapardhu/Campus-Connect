/**
 * Length-prefixed framing for the TCP transport.
 *
 * UDP hands over whole datagrams, so message boundaries come for free. TCP is a
 * byte stream: two messages can arrive in one read, one message can arrive
 * split across five, and neither is unusual. Every frame is therefore a 4-byte
 * big-endian length followed by that many bytes of JSON.
 *
 * The length is also the only thing standing between this and a hostile peer
 * announcing a 4 GB frame, so it is checked before a single byte is buffered.
 *
 * No Electron imports — this file is covered by `npm test`.
 */

export const HEADER_BYTES = 4;

export function encodeFrame(payload: string, maxFrameBytes: number): Buffer {
  const body = Buffer.from(payload, 'utf8');
  if (body.byteLength > maxFrameBytes) {
    throw new Error(`Frame of ${body.byteLength} bytes exceeds the ${maxFrameBytes} byte limit`);
  }

  const header = Buffer.allocUnsafe(HEADER_BYTES);
  header.writeUInt32BE(body.byteLength, 0);
  return Buffer.concat([header, body]);
}

/**
 * Accumulates bytes from a socket and emits complete frames.
 *
 * One instance per connection. `push` returns whatever became complete with
 * this chunk, which is nothing most of the time and occasionally several.
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  private failed = false;

  constructor(private readonly maxFrameBytes: number) {}

  /** True once the stream has been abandoned; the caller should close it. */
  get isBroken(): boolean {
    return this.failed;
  }

  /** Bytes held while waiting for the rest of a frame. */
  get buffered(): number {
    return this.buffer.byteLength;
  }

  push(chunk: Buffer): string[] {
    if (this.failed) {
      return [];
    }

    this.buffer = this.buffer.byteLength === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: string[] = [];

    for (;;) {
      if (this.buffer.byteLength < HEADER_BYTES) {
        return frames;
      }

      const length = this.buffer.readUInt32BE(0);

      // Refuse before allocating anything: this is the memory-exhaustion guard.
      if (length === 0 || length > this.maxFrameBytes) {
        this.failed = true;
        this.buffer = Buffer.alloc(0);
        return frames;
      }

      if (this.buffer.byteLength < HEADER_BYTES + length) {
        return frames;
      }

      frames.push(this.buffer.toString('utf8', HEADER_BYTES, HEADER_BYTES + length));
      this.buffer = this.buffer.subarray(HEADER_BYTES + length);
    }
  }

  reset(): void {
    this.buffer = Buffer.alloc(0);
    this.failed = false;
  }
}
