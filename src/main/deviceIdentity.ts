import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as signBuffer,
  verify as verifyBuffer
} from 'node:crypto';

/**
 * What makes a device id mean something.
 *
 * A device id used to be a bare UUID: a value the sender chose and nothing
 * checked. Every rule keyed on it — the roster, blocking, "is this the
 * owner" — was therefore only as strong as the sender's honesty, and a device
 * on the network could name any id it liked. That is how an outsider could
 * evict members of a room it had never been in.
 *
 * Each device now holds an Ed25519 keypair and signs what it sends. The id
 * stays the UUID it always was, because rosters, blocklists and histories all
 * reference it and changing it would orphan every existing room. The keypair
 * is bound to that id instead: the owner records a member's public key at the
 * moment it is approved — the one moment the device has already proved it
 * knows the room password — and from then on a message claiming that id is
 * only believed if it verifies against that key.
 *
 * Ed25519 rather than RSA because the signatures are 64 bytes and the keys
 * are 32, which matters when the transport is a UDP datagram with a size
 * ceiling. It is in Node's crypto module, so nothing is added to the
 * dependency list.
 *
 * No Electron in this file, so the test suite can run it directly — the same
 * arrangement crypto.ts, roomManager.ts and keyVault.ts already use.
 */

export interface DeviceIdentity {
  /** SPKI, base64. Travels on the wire and is stored in rosters. */
  publicKey: string;
  /** PKCS#8, base64. Never leaves this device; kept in the encrypted vault. */
  privateKey: string;
  /**
   * A second, X25519 keypair, used only to receive keys addressed to this
   * device.
   *
   * Separate from the signing pair because Ed25519 signs and X25519 agrees,
   * and while one can be converted to the other, Node does not expose the
   * conversion — carrying both is a few more bytes in an advert and none of
   * the subtlety. Signing keys sign; agreement keys wrap. Nothing does both.
   */
  boxPublicKey: string;
  boxPrivateKey: string;
}

/**
 * A message reduced to the fields that are signed.
 *
 * Everything the receiver will act on has to be in here, or it is not
 * covered: the type decides which handler runs, the room and target decide
 * who it applies to, and the body digest ties the payload to the signature.
 */
export interface Signable {
  v: number;
  type: string;
  deviceId: string;
  ts: number;
  roomId?: string;
  targetDeviceId?: string;
  /** sha256 of the canonical body, so a payload cannot be swapped. */
  digest: string;
}

/**
 * How far out of step two clocks may be before a message is refused.
 *
 * Wide enough that an unsynchronised laptop still works, narrow enough that a
 * captured message is not replayable for the rest of the afternoon. Devices on
 * a shared network are usually within seconds of each other.
 */
export const CLOCK_SKEW_MS = 120_000;

export function createIdentity(): DeviceIdentity {
  const signing = generateKeyPairSync('ed25519');
  const agreement = generateKeyPairSync('x25519');

  return {
    publicKey: signing.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: signing.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    boxPublicKey: agreement.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    boxPrivateKey: agreement.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
  };
}

/**
 * A short, stable name for a public key.
 *
 * Shown to people when a key changes, and used to compare two keys without
 * putting either on screen in full. Not the device id — see the note at the
 * top of the file.
 */
export function fingerprint(publicKey: string): string {
  const digest = createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex');
  return (digest.match(/.{4}/g) ?? []).slice(0, 4).join('-').toUpperCase();
}

/**
 * Deterministic serialisation.
 *
 * Both ends have to produce byte-identical input or every signature fails, so
 * the field order is fixed here rather than left to whatever order the object
 * happened to be built in. `undefined` is dropped rather than serialised, so
 * an absent field and a field that was never set sign the same.
 */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
}

export function digestOf(body: unknown): string {
  return createHash('sha256').update(canonical(body), 'utf8').digest('base64');
}

export function sign(privateKey: string, payload: Signable): string {
  const key = createPrivateKey({
    key: Buffer.from(privateKey, 'base64'),
    format: 'der',
    type: 'pkcs8'
  });
  return signBuffer(null, Buffer.from(canonical(payload), 'utf8'), key).toString('base64');
}

/**
 * Whether this payload was signed by the holder of this public key.
 *
 * Returns false rather than throwing on malformed input, because everything
 * here arrives off a network and a bad signature is an ordinary event, not an
 * exceptional one.
 */
export function verify(publicKey: string, payload: Signable, signature: string): boolean {
  if (!publicKey || !signature) {
    return false;
  }

  try {
    const key = createPublicKey({
      key: Buffer.from(publicKey, 'base64'),
      format: 'der',
      type: 'spki'
    });
    return verifyBuffer(
      null,
      Buffer.from(canonical(payload), 'utf8'),
      key,
      Buffer.from(signature, 'base64')
    );
  } catch {
    return false;
  }
}

/** Whether a signed message is recent enough to act on. */
export function withinSkew(ts: number, now: number = Date.now()): boolean {
  return Number.isFinite(ts) && Math.abs(now - ts) <= CLOCK_SKEW_MS;
}
