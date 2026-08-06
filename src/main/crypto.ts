import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  randomBytes,
  scryptSync,
  timingSafeEqual
} from 'node:crypto';
import type { Envelope } from '../shared/types';

const KEY_BYTES = 32;
const IV_BYTES = 12;
const SALT_BYTES = 16;

/**
 * scrypt cost. N=2^15 keeps derivation around 100ms on a laptop, which is
 * negligible for a human joining a room but expensive for anyone brute-forcing
 * captured traffic.
 */
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };

/** No 0/O/1/I/L — join codes get read aloud and typed by hand. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

export function generateSalt(): string {
  return randomBytes(SALT_BYTES).toString('hex');
}

/**
 * Rejection sampling rather than `% alphabet.length`, so every character is
 * equally likely. 31^6 ≈ 887 million codes.
 */
export function generateJoinCode(): string {
  const limit = 256 - (256 % CODE_ALPHABET.length);
  let code = '';
  while (code.length < CODE_LENGTH) {
    for (const byte of randomBytes(CODE_LENGTH)) {
      if (byte < limit) {
        code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
        if (code.length === CODE_LENGTH) {
          break;
        }
      }
    }
  }
  return code;
}

export function normalizeJoinCode(code: string): string {
  return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * The room password never leaves the device. It is stretched into the AES key
 * that protects everything the room sends.
 */
export function deriveRoomKey(password: string, keySalt: string): Buffer {
  return scryptSync(
    password.normalize('NFKC'),
    Buffer.from(keySalt, 'hex'),
    KEY_BYTES,
    SCRYPT_OPTIONS
  );
}

export function seal(key: Buffer, plaintext: string): Envelope {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    data: data.toString('base64')
  };
}

/** Returns null for a wrong key, a corrupted packet, or a tampered one. */
export function open(key: Buffer, envelope: Envelope | undefined): string | null {
  if (!envelope?.iv || !envelope.tag || typeof envelope.data !== 'string') {
    return null;
  }

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, 'base64')),
      decipher.final()
    ]);
    return plaintext.toString('utf8');
  } catch {
    return null;
  }
}

export function sealJson(key: Buffer, value: unknown): Envelope {
  return seal(key, JSON.stringify(value));
}

export function openJson<T>(key: Buffer, envelope: Envelope | undefined): T | null {
  const plaintext = open(key, envelope);
  if (plaintext === null) {
    return null;
  }

  try {
    return JSON.parse(plaintext) as T;
  } catch {
    return null;
  }
}

/**
 * The label that domain-separates a join proof from any other sealed value.
 *
 * Frozen at the app's old name on purpose. It is not shown to anyone — it exists
 * only so that a proof cannot be confused for a different kind of message — and
 * changing it would break every device that has not been updated yet, for
 * exactly no benefit.
 */
function proofPlaintext(roomId: string): string {
  return `shared-clipboard:proof:${roomId}`;
}

/**
 * A join request carries this instead of the password. Only someone holding the
 * right key can produce a sealed value the owner is able to open.
 */
export function createProof(key: Buffer, roomId: string): Envelope {
  return seal(key, proofPlaintext(roomId));
}

/* --------------------------------------------------------- content keys -- */

/**
 * A room's content key: random, and not derived from anything.
 *
 * The password used to *be* the key, which made removing somebody a polite
 * request — they still knew the password, so they still held the key. Content
 * is encrypted under this instead, and the password's only job is to prove
 * you may be let in. A key nobody can recompute is a key the owner can
 * replace, and replacing it is what makes a removal mean something.
 */
export function generateContentKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/**
 * Wrap a key so that exactly one device can unwrap it.
 *
 * X25519 between the sender's private key and the recipient's public key
 * gives a secret only those two can compute; that secret is hashed into an
 * AES key and used to seal the content key. Anyone else on the network — and
 * anyone who merely knows the room password — sees an envelope they have no
 * way into.
 *
 * The shared secret is hashed rather than used directly because raw X25519
 * output is not uniformly distributed, and AES expects a key that is. The
 * room id goes into the hash as well, so the same pair of devices derive a
 * different wrapping key per room and an envelope from one room is useless in
 * another.
 */
export function wrapKeyFor(
  contentKey: Buffer,
  senderPrivateKey: string,
  recipientPublicKey: string,
  roomId: string
): Envelope {
  return seal(agreedKey(senderPrivateKey, recipientPublicKey, roomId), contentKey.toString('hex'));
}

/** Returns null when the envelope was not addressed to this device. */
export function unwrapKeyFrom(
  envelope: Envelope | undefined,
  recipientPrivateKey: string,
  senderPublicKey: string,
  roomId: string
): Buffer | null {
  let hex: string | null;
  try {
    hex = open(agreedKey(recipientPrivateKey, senderPublicKey, roomId), envelope);
  } catch {
    return null;
  }

  if (!hex || !/^[0-9a-f]+$/i.test(hex)) {
    return null;
  }

  const key = Buffer.from(hex, 'hex');
  return key.length === KEY_BYTES ? key : null;
}

function agreedKey(privateKeyB64: string, publicKeyB64: string, roomId: string): Buffer {
  const shared = diffieHellman({
    privateKey: createPrivateKey({
      key: Buffer.from(privateKeyB64, 'base64'),
      format: 'der',
      type: 'pkcs8'
    }),
    publicKey: createPublicKey({
      key: Buffer.from(publicKeyB64, 'base64'),
      format: 'der',
      type: 'spki'
    })
  });

  return createHash('sha256')
    .update(shared)
    .update('campus-connect:roomkey:', 'utf8')
    .update(roomId, 'utf8')
    .digest();
}

export function verifyProof(key: Buffer, roomId: string, proof: Envelope | undefined): boolean {
  const opened = open(key, proof);
  if (opened === null) {
    return false;
  }

  const expected = Buffer.from(proofPlaintext(roomId), 'utf8');
  const actual = Buffer.from(opened, 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
