import fs from 'node:fs/promises';
import path from 'node:path';
import log from 'electron-log';
import type {
  ActionResult,
  FileShareFileState,
  FileShareState,
  FileShareTransfer,
  FileXferSignal
} from '../shared/types';

/**
 * Peer-to-peer file sharing, one device sending to one other.
 *
 * The shape of the protocol is settled here and nowhere else: the sender asks,
 * the receiver accepts, and then files stream slice by slice from one to the
 * other over whatever transport the caller provides — a direct TCP link when
 * one exists, UDP datagrams otherwise. Slices are small enough to travel alone,
 * and the receiver places them by index, so ordering problems on UDP cannot
 * corrupt anything.
 *
 * Everything here is deliberately transient. Nothing is persisted, transfers
 * exist only for the lifetime of the app, and the one thing that survives is
 * the file the receiver saved to disk. A transfer that dies mid-way leaves
 * nothing but a partial file the next sweep removes.
 *
 * Like the remote-session manager, this is one session at a time in either
 * role: two senders pouring files into the same folder, or one device
 * uploading to two machines at once, are both confusion no one asked for.
 */

/** How long an unanswered request stays on offer. */
export const REQUEST_TIMEOUT_MS = 60000;

/** Largest single file this will move. Streaming keeps memory low either way. */
export const MAX_FILE_SHARE_BYTES = 512 * 1024 * 1024;

/**
 * Raw bytes per slice. Small enough that a slice plus its envelope fits one
 * UDP datagram, so `deliver` never has to chunk it — every slice is its own
 * message, ordered by index rather than by arrival.
 */
export const SLICE_BYTES = 24 * 1024;

/** Out-of-order slices buffered before the receiver gives up. */
const MAX_BUFFERED_SLICES = 256;

/**
 * How long the sender waits for the receiver to confirm a file is whole.
 *
 * The last slice being written is not the same as the file being on disk, and
 * the next file must not start until it is — so this is a real wait, generous
 * enough to survive a slow disk and short enough that a peer which has gone
 * away does not hold the transfer open indefinitely.
 */
const FILE_ACK_TIMEOUT_MS = 30000;

/**
 * How long a transfer that has started moving files may go without moving any
 * more. Only ever applied once files exist: before that the sender is sitting
 * in a file picker, and a person choosing files is not a stalled transfer.
 */
const STALL_TIMEOUT_MS = 30000;

/** Progress events are throttled; a slice a dozen times a second would flood. */
const EMIT_INTERVAL_MS = 120;

export type FileShareManagerOptions = {
  now?: () => number;
  /** Sends one signal to a peer. Returns false when the peer is unreachable. */
  send: (peerId: string, signal: FileXferSignal) => boolean;
  /** Where received files land. Called fresh each time the folder may exist. */
  downloadFolder: () => string;
  /** Fired when the renderer should be told the state changed. */
  onChanged: () => void;
  /**
   * Resolves once the transport is ready for more. Without it a fast disk
   * fills the socket's queue with the entire file — the memory the slice-wise
   * design exists to avoid — because a socket write queues rather than refuses.
   */
  awaitReady?: (peerId: string) => Promise<void>;
};

type StreamedFile = {
  path: string;
  name: string;
  size: number;
};

export class FileShareManager {
  private readonly now: () => number;
  private incoming: FileShareState['incoming'];
  /** Newest first. Completed transfers stay visible until dismissed. */
  private transfers: FileShareTransfer[] = [];
  private activeId: string | null = null;
  private lastEmit = 0;
  /** Receiver bookkeeping: temp handles and out-of-order slices per file. */
  private receiving = new Map<
    string,
    {
      handle: fs.FileHandle;
      nextIndex: number;
      written: number;
      buffered: Map<number, Buffer>;
    }
  >();
  /**
   * Senders parked on `waitForFile`, keyed by file. Resolved by the receiver's
   * `file-done`, rejected when the transfer ends underneath them — otherwise a
   * cancelled transfer would leave `sendFiles` awaiting forever.
   */
  private acks = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  /** When each transfer last actually moved bytes, for the stall sweep. */
  private lastMoved = new Map<string, number>();
  /**
   * Everything the receiver does, in arrival order and one at a time.
   *
   * Signals arrive as independent events, so without this the handlers
   * interleave at their awaits and quietly corrupt each other: slices that
   * turned up while the file was still being opened were dropped outright, and
   * two slices could both match `nextIndex` before either had incremented it
   * and so both get written. Neither failure is visible until the file on the
   * other end is the wrong size.
   */
  private inbound: Promise<void> = Promise.resolve();

  constructor(private readonly options: FileShareManagerOptions) {
    this.now = options.now ?? Date.now;
  }

  get state(): FileShareState {
    return {
      incoming: this.incoming ? { ...this.incoming } : undefined,
      transfers: this.transfers.map((transfer) => ({ ...transfer, files: transfer.files.map((file) => ({ ...file })) })),
      downloadFolder: this.options.downloadFolder()
    };
  }

  busy(): boolean {
    return this.activeId !== null || this.incoming !== undefined;
  }

  // --- sender -------------------------------------------------------------

  /**
   * The sender asks a peer for permission to send. Nothing is picked yet —
   * the files are chosen only after the peer has said yes, so a connection is
   * never opened for a transfer nobody wants.
   */
  request(peerId: string, peerName: string): ActionResult {
    if (this.busy()) {
      return { ok: false, message: 'Another file transfer is already in progress.' };
    }

    const transferId = randomTransferId();
    const transfer: FileShareTransfer = {
      transferId,
      role: 'sender',
      peerId,
      peerName,
      status: 'requested',
      files: [],
      bytesDone: 0,
      bytesTotal: 0,
      startedAt: this.now()
    };

    if (!this.options.send(peerId, { kind: 'request', transferId })) {
      return { ok: false, message: `${peerName} could not be reached.` };
    }

    this.transfers.unshift(transfer);
    this.activeId = transferId;
    this.emit(true);
    return { ok: true, message: `Waiting for ${peerName} to accept…` };
  }

  /** The sender streams the files it picked after the peer accepted. */
  async sendFiles(transferId: string, files: StreamedFile[]): Promise<ActionResult> {
    const transfer = this.lookup(transferId);
    if (!transfer || transfer.role !== 'sender' || transfer.status !== 'active') {
      return { ok: false, message: 'That transfer is no longer waiting for files.' };
    }
    if (files.length === 0) {
      return { ok: false, message: 'Nothing was picked.' };
    }

    for (const file of files) {
      if (file.size > MAX_FILE_SHARE_BYTES) {
        return {
          ok: false,
          message: `${file.name} is over the ${Math.round(MAX_FILE_SHARE_BYTES / 1024 / 1024)} MB limit.`
        };
      }
    }

    transfer.files = files.map((file) => ({
      fileId: randomTransferId(),
      name: file.name,
      size: file.size,
      moved: 0,
      status: 'queued' as const
    }));
    transfer.bytesTotal = files.reduce((total, file) => total + file.size, 0);
    this.emit(true);

    for (const [index, streamed] of files.entries()) {
      const file = transfer.files[index];
      file.status = 'active';
      this.emit(true);
      this.options.send(transfer.peerId, {
        kind: 'offer',
        transferId,
        fileId: file.fileId,
        name: file.name,
        size: file.size
      });

      try {
        await this.stream(transfer, streamed, file);
        /*
         * The next file waits until this one is confirmed whole. Pushing the
         * last slice is not the same event as the receiver having the file on
         * disk, and starting the next offer before that confirmation is what
         * used to abandon every transfer after its first file.
         */
        await this.waitForFile(transfer, file);
      } catch (error) {
        return this.fail(transfer, (error as Error).message);
      }

      if (this.lookup(transferId)?.status !== 'active') {
        return { ok: false, message: 'The transfer was stopped before it finished.' };
      }
    }

    if (this.lookup(transferId)?.status === 'active') {
      this.options.send(transfer.peerId, { kind: 'finish', transferId, ok: true });
      // The sender ends its own half here. The receiver ends on the `finish`
      // it was just sent, so neither side is left holding an open transfer.
      this.endTransfer(transfer, 'done');
    }
    return {
      ok: true,
      message: files.length === 1 ? `Sent ${files[0].name}.` : `Sent ${files.length} files.`
    };
  }

  /**
   * Waits for the receiver's `file-done`. Rejects if the transfer ends first,
   * or if the confirmation simply never arrives.
   */
  private waitForFile(transfer: FileShareTransfer, file: FileShareFileState): Promise<void> {
    if (file.status === 'done') {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.acks.delete(file.fileId);
        reject(new Error(`${transfer.peerName} never confirmed ${file.name}.`));
      }, FILE_ACK_TIMEOUT_MS);

      const settle = (finish: () => void) => () => {
        clearTimeout(timer);
        this.acks.delete(file.fileId);
        finish();
      };

      this.acks.set(file.fileId, {
        resolve: settle(resolve),
        reject: (error: Error) => settle(() => reject(error))()
      });
    });
  }

  private async stream(
    transfer: FileShareTransfer,
    streamed: StreamedFile,
    file: FileShareFileState
  ): Promise<void> {
    const handle = await fs.open(streamed.path, 'r');
    try {
      const buffer = Buffer.alloc(SLICE_BYTES);
      let offset = 0;
      let index = 0;
      const total = Math.ceil(streamed.size / SLICE_BYTES);

      while (offset < streamed.size) {
        if (this.lookup(transfer.transferId)?.status !== 'active') {
          return; // Cancelled or errored; the file is left as it stands.
        }

        // Reading from a warm page cache is far faster than a network drains,
        // so the transport gets to set the pace rather than the disk.
        await this.options.awaitReady?.(transfer.peerId);
        if (this.lookup(transfer.transferId)?.status !== 'active') {
          return;
        }

        const { bytesRead } = await handle.read(buffer, 0, SLICE_BYTES, offset);
        if (bytesRead === 0) {
          break;
        }

        const sent = this.options.send(transfer.peerId, {
          kind: 'data',
          transferId: transfer.transferId,
          fileId: file.fileId,
          index,
          total,
          data: buffer.subarray(0, bytesRead).toString('base64')
        });
        if (!sent) {
          throw new Error(`The connection to ${transfer.peerName} was lost.`);
        }

        offset += bytesRead;
        index += 1;
        file.moved = offset;
        this.recount(transfer);
        this.touch(transfer);
        this.emit(false);
      }
    } finally {
      await handle.close();
    }
  }

  // --- receiver -----------------------------------------------------------

  /**
   * An incoming request. Refused when this device is busy, because a file dump
   * arriving on top of another transfer is exactly the kind of confusion an
   * accept dialog exists to prevent.
   */
  handleIncomingRequest(fromDeviceId: string, fromDeviceName: string, signal: FileXferSignal & { kind: 'request' }): void {
    if (this.busy()) {
      this.options.send(fromDeviceId, {
        kind: 'decline',
        transferId: signal.transferId,
        reason: 'busy'
      });
      return;
    }

    this.incoming = {
      transferId: signal.transferId,
      fromDeviceId,
      fromDeviceName,
      at: this.now()
    };
    this.emit(true);
  }

  /** The receiver's answer to the dialog. */
  async respond(transferId: string, accept: boolean): Promise<ActionResult> {
    const pending = this.incoming;
    if (!pending || pending.transferId !== transferId) {
      return { ok: false, message: 'That request is no longer waiting.' };
    }
    this.incoming = undefined;

    if (!accept) {
      this.options.send(pending.fromDeviceId, {
        kind: 'decline',
        transferId,
        reason: 'declined'
      });
      this.emit(true);
      return { ok: true, message: 'Declined.' };
    }

    const transfer: FileShareTransfer = {
      transferId,
      role: 'receiver',
      peerId: pending.fromDeviceId,
      peerName: pending.fromDeviceName,
      status: 'active',
      files: [],
      bytesDone: 0,
      bytesTotal: 0,
      startedAt: this.now()
    };
    this.transfers.unshift(transfer);
    this.activeId = transferId;
    this.options.send(pending.fromDeviceId, { kind: 'accept', transferId });
    this.emit(true);
    return { ok: true, message: `Receiving files from ${pending.fromDeviceName}…` };
  }

  // --- both sides ---------------------------------------------------------

  /** User-initiated stop, from either role. */
  cancel(transferId: string): ActionResult {
    const transfer = this.lookup(transferId);
    if (!transfer) {
      return { ok: false, message: 'That transfer is not running.' };
    }

    this.endTransfer(transfer, 'cancelled', undefined, 'cancelled');
    return { ok: true, message: 'Cancelled.' };
  }

  /** Removes a finished transfer from the list. The saved files stay. */
  dismiss(transferId: string): void {
    this.transfers = this.transfers.filter((transfer) => transfer.transferId !== transferId);
    this.emit(true);
  }

  /** Drops everything — network off, or the app shutting down. */
  clear(): void {
    // Through `endTransfer` rather than around it: it is what closes the open
    // file handles and sweeps the partials, and skipping it leaked both.
    for (const transfer of this.transfers) {
      this.endTransfer(transfer, 'cancelled', undefined, 'app-quit');
    }
    this.transfers = [];
    this.incoming = undefined;
    this.activeId = null;
    this.emit(true);
  }

  /** Requests nobody answered are dropped here, like every other sweep. */
  sweep(): void {
    const cutoff = this.now() - REQUEST_TIMEOUT_MS;

    if (this.incoming && this.incoming.at < cutoff) {
      this.options.send(this.incoming.fromDeviceId, {
        kind: 'decline',
        transferId: this.incoming.transferId,
        reason: 'timeout'
      });
      this.incoming = undefined;
      this.emit(true);
    }

    const transfer = this.activeId ? this.lookup(this.activeId) : null;
    if (!transfer) {
      return;
    }

    if (transfer.status === 'requested' && transfer.startedAt < cutoff) {
      // Says why. Ending it silently left "Stopped" on screen, which reads as
      // something this device did rather than a minute of no answer.
      this.endTransfer(transfer, 'cancelled', `${transfer.peerName} did not answer.`);
      return;
    }

    /*
     * A transfer that was moving and then stopped. Only checked once files
     * exist: before that the sender is still in a file picker, and somebody
     * browsing their disk is not a stall.
     */
    if (transfer.status === 'active' && transfer.files.length > 0) {
      const since = this.lastMoved.get(transfer.transferId) ?? transfer.startedAt;
      const finished = transfer.files.every((file) => file.status === 'done');
      if (!finished && since < this.now() - STALL_TIMEOUT_MS) {
        this.endTransfer(
          transfer,
          'error',
          `${transfer.peerName} stopped responding.`,
          'stalled'
        );
      }
    }
  }

  /**
   * Every signal from the wire, in one place. The sender's half of the
   * conversation is handled here too — `file-done` and `cancel` arriving from
   * the receiver.
   */
  handleSignal(fromDeviceId: string, fromDeviceName: string, signal: FileXferSignal): void {
    if (signal.kind === 'request') {
      this.handleIncomingRequest(fromDeviceId, fromDeviceName, signal);
      return;
    }

    const transfer = this.lookup(signal.transferId);
    if (!transfer || transfer.peerId !== fromDeviceId) {
      return; // Not ours, or not with this peer.
    }

    switch (signal.kind) {
      case 'accept':
        if (transfer.role === 'sender' && transfer.status === 'requested') {
          transfer.status = 'active';
          this.emit(true);
        }
        return;

      case 'decline':
        if (transfer.role === 'sender' && transfer.status === 'requested') {
          this.endTransfer(transfer, 'cancelled');
        }
        return;

      case 'offer':
        if (transfer.role === 'receiver' && transfer.status === 'active') {
          this.enqueue(() => this.beginReceiving(transfer, signal));
        }
        return;

      case 'data':
        if (transfer.role === 'receiver' && transfer.status === 'active') {
          this.enqueue(() => this.acceptSlice(transfer, signal));
        }
        return;

      case 'file-done':
        if (transfer.role === 'sender') {
          const file = transfer.files.find((candidate) => candidate.fileId === signal.fileId);
          if (file) {
            file.status = 'done';
            file.moved = file.size;
            this.recount(transfer);
            // Releases the `waitForFile` this file's sender is parked on.
            this.acks.get(file.fileId)?.resolve();
            this.emit(true);
          }
        }
        return;

      case 'finish':
        if (transfer.role === 'sender') {
          this.endTransfer(transfer, signal.ok ? 'done' : 'error', signal.ok ? undefined : signal.error);
        } else if (transfer.role === 'receiver') {
          // Behind the queue, so the batch is never declared over while the
          // last slice of the last file is still being written.
          this.enqueue(() => this.finishReceiving(transfer, signal.ok, signal.error));
        }
        return;

      case 'cancel':
        this.endTransfer(transfer, 'cancelled', `${transfer.peerName} stopped the transfer.`);
        return;
    }
  }

  // --- receiver internals --------------------------------------------------

  private async beginReceiving(
    transfer: FileShareTransfer,
    signal: FileXferSignal & { kind: 'offer' }
  ): Promise<void> {
    if (signal.size > MAX_FILE_SHARE_BYTES) {
      this.endTransfer(transfer, 'error', `${signal.name} is over the size limit.`);
      return;
    }

    const file: FileShareFileState = {
      fileId: signal.fileId,
      name: signal.name,
      size: signal.size,
      moved: 0,
      status: 'active'
    };
    transfer.files.push(file);
    transfer.bytesTotal += signal.size;
    transfer.bytesDone = transfer.files.reduce((total, candidate) => total + candidate.moved, 0);

    const folder = this.options.downloadFolder();
    await fs.mkdir(path.join(folder, '.partials'), { recursive: true });
    const tempPath = path.join(folder, '.partials', `${signal.fileId}.part`);
    const handle = await fs.open(tempPath, 'w');

    /*
     * The transfer can end while this file is being opened.
     *
     * `endTransfer` runs synchronously — from a cancel off the wire, the stall
     * sweep, or going offline — while this is still suspended on `mkdir` and
     * `open`. It closes every handle it can find in `receiving`, and this one
     * is not in there yet, so nothing else will ever close it: the handle is
     * leaked until the garbage collector complains and takes the process with
     * it. Whatever was opened has to be given back here.
     */
    if (transfer.status !== 'active') {
      await handle.close().catch(() => undefined);
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      return;
    }

    const entry = {
      handle,
      nextIndex: 0,
      written: 0,
      buffered: new Map<number, Buffer>()
    };
    this.receiving.set(file.fileId, entry);
    this.touch(transfer);
    this.emit(true);

    /*
     * An empty file is whole the moment it is offered — no slice will ever
     * arrive for it, and completion is otherwise only ever reached by way of
     * one. Without this an empty file stalls the whole transfer behind it.
     */
    if (signal.size === 0) {
      await this.completeFile(transfer, file, entry);
    }
  }

  private async acceptSlice(
    transfer: FileShareTransfer,
    signal: FileXferSignal & { kind: 'data' }
  ): Promise<void> {
    const file = transfer.files.find((candidate) => candidate.fileId === signal.fileId);
    const entry = file ? this.receiving.get(file.fileId) : undefined;
    if (!file || !entry) {
      return;
    }

    const slice = Buffer.from(signal.data, 'base64');
    if (signal.index === entry.nextIndex) {
      try {
        await entry.handle.write(slice);
        entry.nextIndex += 1;
        entry.written += slice.length;
        await this.flushBuffered(transfer, file, entry);
      } catch (error) {
        this.endTransfer(transfer, 'error', (error as Error).message);
        return;
      }
    } else if (signal.index > entry.nextIndex && signal.index < signal.total) {
      if (entry.buffered.size >= MAX_BUFFERED_SLICES) {
        this.endTransfer(transfer, 'error', 'Too many slices arrived out of order.');
        return;
      }
      entry.buffered.set(signal.index, slice);
    }

    /*
     * Progress is what is actually on disk, recounted from the files rather
     * than added up as slices arrive. A duplicate slice — which UDP will
     * happily deliver — used to inflate the total past what was written.
     */
    file.moved = entry.written;
    this.recount(transfer);
    this.touch(transfer);
    this.emit(false);

    if (file.moved >= file.size) {
      await this.completeFile(transfer, file, entry);
    }
  }

  private async flushBuffered(
    transfer: FileShareTransfer,
    file: FileShareFileState,
    entry: { handle: fs.FileHandle; nextIndex: number; written: number; buffered: Map<number, Buffer> }
  ): Promise<void> {
    while (entry.buffered.has(entry.nextIndex)) {
      const slice = entry.buffered.get(entry.nextIndex)!;
      entry.buffered.delete(entry.nextIndex);
      await entry.handle.write(slice);
      entry.nextIndex += 1;
      entry.written += slice.length;
      file.moved = entry.written;
    }
  }

  private async completeFile(
    transfer: FileShareTransfer,
    file: FileShareFileState,
    entry: { handle: fs.FileHandle; nextIndex: number; written: number; buffered: Map<number, Buffer> }
  ): Promise<void> {
    await entry.handle.close();
    this.receiving.delete(file.fileId);

    const folder = this.options.downloadFolder();
    const finalPath = await uniquePath(path.join(folder, file.name));
    try {
      await fs.rename(path.join(folder, '.partials', `${file.fileId}.part`), finalPath);
    } catch {
      await fs.copyFile(path.join(folder, '.partials', `${file.fileId}.part`), finalPath);
    }

    file.status = 'done';
    file.savedPath = finalPath;
    this.options.send(transfer.peerId, {
      kind: 'file-done',
      transferId: transfer.transferId,
      fileId: file.fileId,
      savedPath: finalPath
    });
    this.emit(true);
  }

  private async finishReceiving(transfer: FileShareTransfer, ok: boolean, error?: string): Promise<void> {
    this.endTransfer(transfer, ok ? 'done' : 'error', error);
  }

  // --- shared internals ----------------------------------------------------

  /**
   * The single exit for a transfer, in either role.
   *
   * Idempotent by design: the receiver's `cancel` and the sender's own failure
   * routinely race, and a transfer that ended twice would send two cancels and
   * overwrite the first, truthful error with a second, vaguer one.
   */
  private endTransfer(
    transfer: FileShareTransfer,
    status: FileShareTransfer['status'],
    error?: string,
    /** When set, the peer is told before this side closes down. */
    notifyPeer?: string
  ): void {
    if (transfer.status === 'done' || transfer.status === 'cancelled' || transfer.status === 'error') {
      return;
    }

    if (notifyPeer) {
      this.options.send(transfer.peerId, {
        kind: 'cancel',
        transferId: transfer.transferId,
        reason: notifyPeer
      });
    }

    transfer.status = status;
    transfer.error = error;
    transfer.finishedAt = this.now();

    for (const file of transfer.files) {
      // Anything not confirmed whole by now never will be.
      if (file.status !== 'done') {
        file.status = 'error';
      }

      // Whoever was waiting on this file is waiting on something that is not
      // going to happen; releasing them is what stops `sendFiles` hanging.
      this.acks.get(file.fileId)?.reject(new Error(error ?? 'The transfer stopped.'));

      const entry = this.receiving.get(file.fileId);
      if (entry) {
        void entry.handle.close().catch(() => undefined);
        this.receiving.delete(file.fileId);
        void fs
          .rm(path.join(this.options.downloadFolder(), '.partials', `${file.fileId}.part`), { force: true })
          .catch(() => undefined);
      }
    }

    this.lastMoved.delete(transfer.transferId);
    if (this.activeId === transfer.transferId) {
      this.activeId = null;
    }
    this.emit(true);
  }

  private fail(transfer: FileShareTransfer, message: string): ActionResult {
    this.endTransfer(transfer, 'error', message, message);
    return { ok: false, message };
  }

  /** Total progress, derived from the files rather than accumulated. */
  private recount(transfer: FileShareTransfer): void {
    transfer.bytesDone = Math.min(
      transfer.bytesTotal,
      transfer.files.reduce((total, file) => total + file.moved, 0)
    );
  }

  /** Marks a transfer as having moved just now, for the stall sweep. */
  private touch(transfer: FileShareTransfer): void {
    this.lastMoved.set(transfer.transferId, this.now());
  }

  /** Runs receiver work strictly after whatever is already queued. */
  private enqueue(work: () => Promise<void>): void {
    this.inbound = this.inbound.then(work).catch((error: Error) => {
      log.warn(`File transfer step failed: ${error.message}`);
    });
  }

  private lookup(transferId: string): FileShareTransfer | undefined {
    return this.transfers.find((transfer) => transfer.transferId === transferId);
  }

  /** Progress is only worth the renderer's time so often. */
  private emit(force: boolean): void {
    const now = this.now();
    if (force || now - this.lastEmit >= EMIT_INTERVAL_MS) {
      this.lastEmit = now;
      this.options.onChanged();
    }
  }

  /** Cleans partials from a previous run — nothing there is worth keeping. */
  async cleanPartials(): Promise<void> {
    const folder = this.options.downloadFolder();
    try {
      await fs.rm(path.join(folder, '.partials'), { recursive: true, force: true });
    } catch (error) {
      log.warn(`Could not clean partial file transfers: ${(error as Error).message}`);
    }
  }
}

function randomTransferId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** A path that does not exist yet: `name`, then `name (1)`, `name (2)`… */
async function uniquePath(candidate: string): Promise<string> {
  const { dir, name, ext } = path.parse(candidate);
  let attempt = candidate;
  for (let suffix = 1; ; suffix += 1) {
    try {
      await fs.access(attempt);
    } catch {
      return attempt;
    }
    attempt = path.join(dir, `${name} (${suffix})${ext}`);
  }
}
