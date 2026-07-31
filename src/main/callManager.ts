import type { ActiveCall, CallMode } from '../shared/types';

/**
 * Who is in which call, as far as this device can tell.
 *
 * This is bookkeeping, not authority. The media and the negotiation belong to
 * the renderer, where WebRTC lives; all this does is keep enough of a picture to
 * answer two questions the UI needs: is a call happening in this room, and who
 * is in it. Nothing here is persisted — a call does not survive a restart, and
 * a stale one would be worse than none.
 *
 * Deliberately free of Electron imports so it can be tested in plain Node.
 */

/** A participant that stops being mentioned is dropped after this. */
export const PARTICIPANT_TTL_MS = 20000;
/** A ring nobody answered stops being offered after this. */
export const RING_TTL_MS = 45000;

type Participant = {
  deviceId: string;
  deviceName: string;
  lastSeen: number;
};

type Call = {
  callId: string;
  roomId: string;
  mode: CallMode;
  startedAt: number;
  participants: Map<string, Participant>;
};

export class CallManager {
  private calls = new Map<string, Call>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Records that a device is in a call, creating the call if this is the first
   * we have heard of it. Returns true when that was news, which is what decides
   * whether the window needs redrawing.
   */
  join(callId: string, roomId: string, mode: CallMode, deviceId: string, deviceName: string): boolean {
    const at = this.now();
    let call = this.calls.get(callId);

    if (!call) {
      call = { callId, roomId, mode, startedAt: at, participants: new Map() };
      this.calls.set(callId, call);
    }

    /*
     * A call that starts as audio becomes a video call the moment anyone brings
     * a camera to it, and never goes back. The mode is only a label for the UI,
     * so widening it is safe; narrowing it would make the label flicker as
     * participants come and go.
     */
    if (mode === 'video') {
      call.mode = 'video';
    }

    const existing = call.participants.get(deviceId);
    call.participants.set(deviceId, { deviceId, deviceName, lastSeen: at });
    return !existing || existing.deviceName !== deviceName;
  }

  /** Keeps a participant from being swept, without treating it as news. */
  touch(callId: string, deviceId: string): void {
    const participant = this.calls.get(callId)?.participants.get(deviceId);
    if (participant) {
      participant.lastSeen = this.now();
    }
  }

  /**
   * Takes a device out of a call, and the call itself once it is empty. Returns
   * true when something changed.
   */
  leave(callId: string, deviceId: string): boolean {
    const call = this.calls.get(callId);
    if (!call?.participants.delete(deviceId)) {
      return false;
    }

    if (call.participants.size === 0) {
      this.calls.delete(callId);
    }
    return true;
  }

  /** Takes a device out of every call it is in — for when it goes quiet entirely. */
  leaveAll(deviceId: string): boolean {
    let changed = false;
    for (const call of Array.from(this.calls.values())) {
      changed = this.leave(call.callId, deviceId) || changed;
    }
    return changed;
  }

  /** Forgets every call in a room, for when the room itself goes away. */
  clearRoom(roomId: string): boolean {
    let changed = false;
    for (const [callId, call] of Array.from(this.calls.entries())) {
      if (call.roomId === roomId) {
        this.calls.delete(callId);
        changed = true;
      }
    }
    return changed;
  }

  clear(): void {
    this.calls.clear();
  }

  /**
   * Drops participants that have gone quiet, and calls left with nobody in
   * them. A device that loses power mid-call never says goodbye, so a call has
   * to be able to end without being told.
   */
  sweep(): boolean {
    const cutoff = this.now() - PARTICIPANT_TTL_MS;
    let changed = false;

    for (const [callId, call] of Array.from(this.calls.entries())) {
      for (const [deviceId, participant] of Array.from(call.participants.entries())) {
        if (participant.lastSeen < cutoff) {
          call.participants.delete(deviceId);
          changed = true;
        }
      }

      if (call.participants.size === 0) {
        this.calls.delete(callId);
        changed = true;
      }
    }

    return changed;
  }

  getCall(callId: string): ActiveCall | undefined {
    const call = this.calls.get(callId);
    return call ? toActiveCall(call) : undefined;
  }

  /** The live call in a room, if there is one. Oldest wins if two overlap. */
  getRoomCall(roomId: string): ActiveCall | undefined {
    let oldest: Call | undefined;
    for (const call of this.calls.values()) {
      if (call.roomId === roomId && (!oldest || call.startedAt < oldest.startedAt)) {
        oldest = call;
      }
    }
    return oldest ? toActiveCall(oldest) : undefined;
  }

  list(): ActiveCall[] {
    return Array.from(this.calls.values())
      .sort((a, b) => a.startedAt - b.startedAt)
      .map(toActiveCall);
  }

  isParticipant(callId: string, deviceId: string): boolean {
    return this.calls.get(callId)?.participants.has(deviceId) ?? false;
  }

  countParticipants(callId: string): number {
    return this.calls.get(callId)?.participants.size ?? 0;
  }
}

function toActiveCall(call: Call): ActiveCall {
  return {
    callId: call.callId,
    roomId: call.roomId,
    mode: call.mode,
    startedAt: call.startedAt,
    participants: Array.from(call.participants.values())
      .sort((a, b) => a.deviceName.localeCompare(b.deviceName))
      .map(({ deviceId, deviceName }) => ({ deviceId, deviceName }))
  };
}
