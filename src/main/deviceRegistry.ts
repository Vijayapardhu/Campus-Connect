/**
 * Which public key belongs to which device id.
 *
 * A signature on its own proves only that whoever sent a message holds the
 * key they attached to it — which is no use at all if they also chose the
 * device id. Anyone can generate a keypair and claim to be your laptop. What
 * turns a signature into an identity is remembering, so that the second
 * message claiming an id has to come from the same key as the first.
 *
 * Two strengths of binding live here, and the difference matters:
 *
 *   seen    — recorded the first time an id was observed. Trust on first
 *             use, as SSH does it: it cannot tell you the first message was
 *             genuine, only that everything after it came from the same
 *             place.
 *   bound   — recorded by a room owner at the moment it approved a join, when
 *             the device had just proved it knew the room password. That is
 *             an identity established against a secret, not against luck, and
 *             it is the one the roster carries to every other member.
 *
 * A bound key is never replaced by a seen one, so a device that has properly
 * joined a room cannot be talked over by whoever announces loudest afterwards.
 *
 * No Electron here either: the store is injected, and the tests drive it
 * directly.
 */

export interface DeviceKeyRecord {
  publicKey: string;
  /** True once an owner has bound this key to the id at approval time. */
  bound: boolean;
  firstSeen: number;
  lastSeen: number;
}

export interface RegistryStorage {
  read(): Record<string, DeviceKeyRecord>;
  write(records: Record<string, DeviceKeyRecord>): void;
}

export type Judgement =
  /** No key on file. It has now been recorded, weakly. */
  | 'first-seen'
  /** Matches what we already had. */
  | 'known'
  /** We have a different key for this id. The message is a forgery, or the
   *  device was reinstalled — either way it is not the device we knew. */
  | 'mismatch';

/** How long an ordinary `lastSeen` bump waits before it is written to disk. */
const LAST_SEEN_FLUSH_MS = 30000;

export class DeviceRegistry {
  private records: Record<string, DeviceKeyRecord>;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly storage: RegistryStorage,
    private readonly now: () => number = Date.now
  ) {
    this.records = storage.read();
  }

  get(deviceId: string): DeviceKeyRecord | undefined {
    return this.records[deviceId];
  }

  /**
   * Check a claimed id against what we know, recording it if it is new.
   *
   * Returning 'mismatch' rather than quietly replacing the key is the whole
   * point: a device id whose key has changed is either an impersonation
   * attempt or a genuine reinstall, and the two are indistinguishable from
   * here. Refusing is the safe reading, and a genuine reinstall recovers by
   * rejoining the room — which is a deliberate act by somebody who knows the
   * password, and which rebinds the key properly.
   */
  check(deviceId: string, publicKey: string): Judgement {
    if (!deviceId || !publicKey) {
      return 'mismatch';
    }

    const known = this.records[deviceId];
    if (!known) {
      const stamp = this.now();
      this.records[deviceId] = { publicKey, bound: false, firstSeen: stamp, lastSeen: stamp };
      this.persist();
      return 'first-seen';
    }

    if (known.publicKey !== publicKey) {
      return 'mismatch';
    }

    known.lastSeen = this.now();
    // Debounced rather than immediate — this runs on every authenticated
    // packet from every already-known device, which on a busy room is
    // thousands a minute, and a write on each one would be needless disk
    // I/O for a timestamp nothing currently reads. Debounced still beats
    // never: left off entirely, `lastSeen` only ever reflected the moment a
    // device was first seen or last bound/adopted, silently going stale on
    // disk the instant the process restarted, however recently that device
    // had actually been talking to it.
    this.scheduleFlush();
    return 'known';
  }

  /**
   * Record a key as established, not merely observed.
   *
   * Called by a room owner when it approves a join. This overwrites a
   * first-seen key, because a device that has just proved it knows the room
   * password is better evidence than a device that merely spoke first.
   */
  bind(deviceId: string, publicKey: string): void {
    if (!deviceId || !publicKey) {
      return;
    }

    const stamp = this.now();
    const known = this.records[deviceId];
    this.records[deviceId] = {
      publicKey,
      bound: true,
      firstSeen: known?.firstSeen ?? stamp,
      lastSeen: stamp
    };
    this.persist();
  }

  /**
   * Adopt the keys carried by an owner's roster.
   *
   * Members learn each other's keys this way rather than by watching the
   * network, so everyone in a room agrees on who is who — and agrees with the
   * owner, which is already the authority on membership.
   *
   * An entry that would downgrade a bound key to a different value is
   * ignored. The roster is authoritative about *membership*, and a roster
   * that disagreed with a key we bound ourselves would be the one case where
   * believing it costs more than refusing.
   */
  adopt(entries: Array<{ deviceId: string; publicKey?: string }>): void {
    let changed = false;

    for (const entry of entries) {
      if (!entry.deviceId || !entry.publicKey) {
        continue;
      }

      const known = this.records[entry.deviceId];
      if (known?.bound && known.publicKey !== entry.publicKey) {
        continue;
      }
      if (known?.publicKey === entry.publicKey && known.bound) {
        continue;
      }

      const stamp = this.now();
      this.records[entry.deviceId] = {
        publicKey: entry.publicKey,
        bound: true,
        firstSeen: known?.firstSeen ?? stamp,
        lastSeen: stamp
      };
      changed = true;
    }

    if (changed) {
      this.persist();
    }
  }

  forget(deviceId: string): void {
    if (this.records[deviceId]) {
      delete this.records[deviceId];
      this.persist();
    }
  }

  private persist(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.storage.write(this.records);
  }

  private scheduleFlush(): void {
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.persist();
    }, LAST_SEEN_FLUSH_MS);
    this.flushTimer.unref?.();
  }
}
