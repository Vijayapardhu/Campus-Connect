import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Which phones are allowed to reach this machine, and for how long.
 *
 * This is the whole security boundary of phone access, so it lives on its own,
 * free of both Electron and the HTTP server, and is tested directly.
 *
 * **Pairing is by scan, once.** The desktop shows a QR code carrying a
 * single-use key; the phone that scans it is paired and remembered from then on.
 * Typing the address by hand gets you nothing at all, which is the point — the
 * address is guessable (it is just an IP on the local subnet) and the key is not.
 *
 * A paired phone reaches **everything the desktop can**, because it is the same
 * person holding both. That makes the scan the whole boundary, and makes the
 * unpair button on the desktop the thing that matters when a phone is lost.
 *
 * A 256-bit key rather than a six-digit PIN, and single-use rather than standing.
 * Both follow from the same reasoning: a PIN short enough to type is short enough
 * to guess, and one that stays valid lets anybody who ever glanced at the screen
 * come back later. A key nobody types can be as long as we like, and consuming it
 * on use means each QR admits exactly one device.
 */

/** Wrong keys before the door shuts. Guessing one is hopeless anyway; this is belt and braces. */
export const MAX_PIN_ATTEMPTS = 5;

/** How long it stays shut. Long enough to make a million guesses hopeless. */
export const LOCKOUT_MS = 5 * 60 * 1000;

/**
 * How long a pairing lasts without being used.
 *
 * Generous, because the point is not to ask again. A phone that has not appeared
 * for a month has probably moved on, and re-pairing it is six digits.
 */
export const PAIRING_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** A paired phone as it is stored. The token itself is never kept in the clear. */
export type PhonePairing = {
  /** SHA-256 of the token. A leaked store must not hand over working tokens. */
  tokenHash: string;
  label: string;
  address: string;
  pairedAt: number;
  lastSeenAt: number;
};

export interface PairingStore {
  read(): PhonePairing[];
  write(pairings: PhonePairing[]): void;
}

/** A paired phone, as the desktop shows it. Tokens never appear here. */
export type PhoneClientInfo = {
  label: string;
  address: string;
  pairedAt: number;
  lastSeenAt: number;
};

export class PhoneSessions {
  private key = '';
  private open_ = false;
  private failures = 0;
  private lockedUntil = 0;
  private pairings: PhonePairing[];

  constructor(
    private readonly store: PairingStore,
    private readonly now: () => number = Date.now
  ) {
    this.pairings = [...store.read()];
  }

  get isOpen(): boolean {
    return this.open_;
  }

  /** The key currently encoded in the QR code. Never shown as text. */
  get currentKey(): string {
    return this.key;
  }

  get lockedOutUntil(): number {
    return this.lockedUntil > this.now() ? this.lockedUntil : 0;
  }

  /**
   * Opens access and mints a fresh pairing key.
   *
   * Phones already paired stay paired — that is the whole point, and re-scanning
   * every time the laptop is reopened is exactly the friction this removes.
   * Unpair from the desktop when you want a phone gone.
   */
  open(): string {
    this.open_ = true;
    this.key = generateKey();
    this.failures = 0;
    this.lockedUntil = 0;
    return this.key;
  }

  close(): void {
    this.open_ = false;
    this.key = '';
    this.failures = 0;
    this.lockedUntil = 0;
  }

  /**
   * Exchanges a scanned key for a token, and remembers the phone.
   *
   * The key is **consumed**: a fresh one is minted immediately, so the QR that
   * was on screen admits exactly one device and the next one to scan gets a
   * different code. Somebody who photographed the screen earlier cannot come
   * back with it.
   *
   * Returns null for a wrong key, a closed door, or a lockout — deliberately the
   * same answer for all three.
   */
  pair(candidate: string, address: string, label: string): string | null {
    if (!this.isOpen || this.lockedOutUntil > 0) {
      return null;
    }

    if (!matches(candidate, this.key)) {
      this.failures += 1;
      if (this.failures >= MAX_PIN_ATTEMPTS) {
        this.lockedUntil = this.now() + LOCKOUT_MS;
        this.failures = 0;
      }
      return null;
    }

    this.failures = 0;
    // Consumed. The next device to scan needs the next code.
    this.key = generateKey();

    const token = randomBytes(32).toString('hex');

    this.pairings.unshift({
      tokenHash: hash(token),
      label: label.slice(0, 60) || 'A phone',
      address,
      pairedAt: this.now(),
      lastSeenAt: this.now()
    });
    this.persist();

    return token;
  }

  /** Shared by `verify` and `identify` — the token's pairing, or null if it does not currently admit anyone. */
  private findValid(token: string): PhonePairing | null {
    if (!token || !this.isOpen) {
      return null;
    }

    const digest = hash(token);
    const pairing = this.pairings.find((candidate) => candidate.tokenHash === digest);
    if (!pairing) {
      return null;
    }

    if (this.now() - pairing.lastSeenAt > PAIRING_TTL_MS) {
      this.pairings = this.pairings.filter((candidate) => candidate !== pairing);
      this.persist();
      return null;
    }

    return pairing;
  }

  /**
   * Checks a token. True when the phone holding it is paired and access is on.
   *
   * Compared by hash, because that is all that is stored — a copy of the
   * settings file must not hand anybody a working token.
   */
  verify(token: string): boolean {
    const pairing = this.findValid(token);
    if (!pairing) {
      return false;
    }

    pairing.lastSeenAt = this.now();
    return true;
  }

  /**
   * Which pairing a token belongs to, identified by `pairedAt` — without
   * touching `lastSeenAt` the way `verify` does. Exists so a long-lived
   * connection opened with this token (the event stream) can be tied back to
   * the pairing that authorized it, and closed the moment that pairing is
   * revoked rather than only refusing the *next* request.
   */
  identify(token: string): number | null {
    return this.findValid(token)?.pairedAt ?? null;
  }

  /** Forgets one phone. It has to type the PIN again to come back. */
  unpair(pairedAt: number): boolean {
    const before = this.pairings.length;
    this.pairings = this.pairings.filter((pairing) => pairing.pairedAt !== pairedAt);

    if (this.pairings.length === before) {
      return false;
    }

    this.persist();
    return true;
  }

  /** Forgets every phone at once. */
  unpairAll(): void {
    this.pairings = [];
    this.persist();
  }

  /** Drops pairings nothing has used for a long time. */
  sweep(): boolean {
    const cutoff = this.now() - PAIRING_TTL_MS;
    const before = this.pairings.length;
    this.pairings = this.pairings.filter((pairing) => pairing.lastSeenAt >= cutoff);

    if (this.pairings.length === before) {
      return false;
    }

    this.persist();
    return true;
  }

  /** The paired phones, newest first, without their tokens. */
  list(): PhoneClientInfo[] {
    return [...this.pairings]
      .sort((a, b) => b.pairedAt - a.pairedAt)
      .map(({ tokenHash: _hash, ...rest }) => rest);
  }

  private persist(): void {
    this.store.write(this.pairings);
  }
}

/**
 * A pairing key.
 *
 * 256 bits, because nobody types it — it travels inside a QR code. There is no
 * length at which a hand-typed code is both convenient and unguessable, so this
 * simply does not ask anyone to type one.
 */
export function generateKey(): string {
  return randomBytes(32).toString('hex');
}

/** Constant-time, so the comparison itself leaks nothing about the key. */
function matches(candidate: string, key: string): boolean {
  if (typeof candidate !== 'string' || !key) {
    return false;
  }

  const a = Buffer.from(candidate.trim(), 'utf8');
  const b = Buffer.from(key, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Tokens are stored hashed, never in the clear. */
function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
