import type { RemoteGrant, RemoteRole, RemoteSessionState } from '../shared/types';

/**
 * The rules about who may drive what, kept in one place and away from Electron.
 *
 * This is the part of remote desktop worth being able to test exhaustively:
 * every question of the form "is this device allowed to do this right now" is
 * answered here, and nowhere else gets to decide. In particular `mayInject` is
 * the single gate between an event arriving off the network and the mouse
 * moving, so it is written to say no by default and yes only for the one
 * combination that is legitimate.
 *
 * Deliberately one session at a time, in either role. Two controllers fighting
 * over the same pointer is not a feature, and being driven by one machine while
 * driving another is a way to lose track of which screen you are typing into.
 */

export type PendingRequest = {
  sessionId: string;
  roomId: string;
  fromDeviceId: string;
  fromDeviceName: string;
  at: number;
};

/** How long an unanswered request stays on offer. */
export const REQUEST_TIMEOUT_MS = 60000;

/** A request this device made and has not been answered on yet. */
export type OutgoingRequest = {
  roomId: string;
  targetDeviceId: string;
  at: number;
};

export class RemoteSessionManager {
  private session: RemoteSessionState | null = null;
  private pending = new Map<string, PendingRequest>();
  /**
   * Requests *this* device made, so an answer can be matched to one.
   *
   * Without this a `grant` is simply believed, and any room member can open a
   * session on a machine that never asked for one — pushing their screen onto
   * somebody's display and occupying the single session slot while they are at
   * it. An answer nobody asked a question for is not an answer.
   */
  private outgoing = new Map<string, OutgoingRequest>();

  constructor(private readonly now: () => number = Date.now) {}

  // --- state ---------------------------------------------------------------

  get current(): RemoteSessionState | null {
    return this.session ? { ...this.session } : null;
  }

  get busy(): boolean {
    return this.session !== null;
  }

  isHosting(): boolean {
    return this.session?.role === 'host';
  }

  // --- requests ------------------------------------------------------------

  /**
   * Records an incoming request. Refused while a session is already running,
   * because approving a second one would mean two people driving at once.
   */
  addRequest(request: PendingRequest): boolean {
    if (this.session || this.pending.has(request.sessionId)) {
      return false;
    }

    this.pending.set(request.sessionId, request);
    return true;
  }

  getRequest(sessionId: string): PendingRequest | undefined {
    return this.pending.get(sessionId);
  }

  takeRequest(sessionId: string): PendingRequest | undefined {
    const request = this.pending.get(sessionId);
    this.pending.delete(sessionId);
    return request;
  }

  listRequests(): PendingRequest[] {
    return Array.from(this.pending.values()).sort((a, b) => a.at - b.at);
  }

  /** Records a request this device just sent, so its answer can be matched. */
  noteOutgoingRequest(sessionId: string, roomId: string, targetDeviceId: string): void {
    this.outgoing.set(sessionId, { roomId, targetDeviceId, at: this.now() });
  }

  /**
   * Claims the request an answer belongs to. Returns undefined when this device
   * never asked — in which case the answer is not ours and must be dropped.
   */
  takeOutgoingRequest(sessionId: string): OutgoingRequest | undefined {
    const request = this.outgoing.get(sessionId);
    this.outgoing.delete(sessionId);
    return request;
  }

  /** Requests nobody answered. Returns the ids dropped, so they can be refused. */
  sweepRequests(): string[] {
    const cutoff = this.now() - REQUEST_TIMEOUT_MS;
    const expired: string[] = [];

    for (const [sessionId, request] of this.pending) {
      if (request.at < cutoff) {
        this.pending.delete(sessionId);
        expired.push(sessionId);
      }
    }

    // Our own unanswered asks lapse on the same clock, so a `grant` that turns
    // up long after the fact is no longer accepted.
    for (const [sessionId, request] of this.outgoing) {
      if (request.at < cutoff) {
        this.outgoing.delete(sessionId);
      }
    }

    return expired;
  }

  // --- sessions ------------------------------------------------------------

  /**
   * Opens a session. Returns false if one is already running — the caller must
   * refuse rather than replace, so an existing session can never be displaced by
   * a message arriving from the network.
   */
  start(options: {
    sessionId: string;
    roomId: string;
    role: RemoteRole;
    peerId: string;
    peerName: string;
    grant: RemoteGrant;
    screenLabel: string;
  }): boolean {
    if (this.session) {
      return false;
    }

    this.session = { ...options, startedAt: this.now() };
    this.pending.delete(options.sessionId);
    return true;
  }

  /**
   * Changes what the controller is allowed to do, mid-session.
   *
   * Only the host decides this. Narrowing it — taking control back — has to work
   * the instant it is asked for, which is why it is a field on the live session
   * rather than something renegotiated.
   */
  setGrant(sessionId: string, grant: RemoteGrant): boolean {
    if (!this.session || this.session.sessionId !== sessionId) {
      return false;
    }

    this.session.grant = grant;
    return true;
  }

  end(sessionId?: string): RemoteSessionState | null {
    if (!this.session || (sessionId && this.session.sessionId !== sessionId)) {
      return null;
    }

    const ended = this.session;
    this.session = null;
    return ended;
  }

  /** Drops everything — for a room going away, or the network being switched off. */
  clear(): RemoteSessionState | null {
    this.pending.clear();
    this.outgoing.clear();
    return this.end();
  }

  /** Drops anything belonging to one room, since the room is the trust boundary. */
  clearRoom(roomId: string): RemoteSessionState | null {
    for (const [sessionId, request] of Array.from(this.pending)) {
      if (request.roomId === roomId) {
        this.pending.delete(sessionId);
      }
    }
    for (const [sessionId, request] of Array.from(this.outgoing)) {
      if (request.roomId === roomId) {
        this.outgoing.delete(sessionId);
      }
    }

    return this.session?.roomId === roomId ? this.end() : null;
  }

  /** Drops anything involving one device — for blocking, or a device leaving. */
  clearDevice(deviceId: string): RemoteSessionState | null {
    for (const [sessionId, request] of Array.from(this.pending)) {
      if (request.fromDeviceId === deviceId) {
        this.pending.delete(sessionId);
      }
    }
    for (const [sessionId, request] of Array.from(this.outgoing)) {
      if (request.targetDeviceId === deviceId) {
        this.outgoing.delete(sessionId);
      }
    }

    return this.session?.peerId === deviceId ? this.end() : null;
  }

  // --- the gate ------------------------------------------------------------

  /**
   * Whether an input event may be applied to this machine right now.
   *
   * Everything has to line up: there is a session, this device is the one being
   * driven rather than the one driving, the session is the one the event claims
   * to belong to, it is with the device that sent it, and control — not merely
   * viewing — has been granted. Any one of those failing means no.
   *
   * Written as a single expression of positives so that adding a condition later
   * cannot accidentally widen it.
   */
  mayInject(sessionId: string, fromDeviceId: string): boolean {
    const session = this.session;

    return (
      session !== null &&
      session.role === 'host' &&
      session.grant === 'control' &&
      session.sessionId === sessionId &&
      session.peerId === fromDeviceId
    );
  }

  /** Whether a signal about a session should be acted on at all. */
  ownsSession(sessionId: string, fromDeviceId: string): boolean {
    return this.session?.sessionId === sessionId && this.session.peerId === fromDeviceId;
  }
}
