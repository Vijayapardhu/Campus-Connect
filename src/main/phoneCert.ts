import fs from 'node:fs';
import path from 'node:path';
import log from 'electron-log';
import selfsigned from 'selfsigned';

/**
 * The certificate that lets a phone use its microphone and camera.
 *
 * Browsers refuse `getUserMedia` outside a secure context, and a LAN address
 * over plain HTTP is not one. No flag, no exception — which is why calls could
 * not work on the phone at all, however much of the signalling was built.
 *
 * The certificate is self-signed, so the phone shows a warning the first time
 * and the person has to agree to continue. That is a real cost, and it buys
 * more than calls: until now every message, every clipboard item and the phone's
 * own bearer token crossed the WiFi in clear text, readable by anything else on
 * the network. The warning is the price of that stopping.
 *
 * Two things matter for it to be a *first-time* warning rather than a
 * permanent one:
 *
 *  - **It is kept.** Regenerating on every launch would mean a new warning
 *    every launch, and would teach people to click through warnings.
 *  - **It names the address.** Browsers check the subject alternative names,
 *    not the common name. A certificate that does not list the IP the phone
 *    actually dialled is rejected outright rather than merely warned about.
 */

export type PhoneCertificate = {
  key: string;
  cert: string;
  /** Shown in settings so it can be compared against what the phone reports. */
  fingerprint: string;
  /** Addresses this certificate is valid for. */
  hosts: string[];
};

type StoredCertificate = PhoneCertificate & { expiresAt: number };

/** Long enough not to be a chore, short of the 825-day cap browsers enforce. */
const VALID_DAYS = 800;

/** Renew before it actually lapses, so it never expires mid-use. */
const RENEW_WITHIN_MS = 30 * 24 * 60 * 60 * 1000;

const FILE = 'phone-certificate.json';

function read(dir: string): StoredCertificate | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8')) as StoredCertificate;
    // `expiresAt` in particular: `usable()` below computes
    // `stored.expiresAt - RENEW_WITHIN_MS < now`, and a missing or
    // non-numeric value there is `NaN`, which is never `< now` — the
    // renewal check would have silently never triggered for a hand-edited
    // or otherwise malformed record, treating an unknown expiry as a
    // permanently valid one instead of the unusable record it is.
    if (!parsed?.key || !parsed?.cert || !Array.isArray(parsed.hosts) || !Number.isFinite(parsed.expiresAt)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function write(dir: string, value: StoredCertificate): void {
  try {
    const file = path.join(dir, FILE);
    fs.writeFileSync(file, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
    // The private key is the whole point; nobody else on a shared machine gets it.
    fs.chmodSync(file, 0o600);
  } catch (error) {
    log.warn(`Could not store the phone certificate: ${(error as Error).message}`);
  }
}

/** Whether a stored certificate still covers everything it needs to. */
function usable(stored: StoredCertificate | null, hosts: string[], now: number): boolean {
  if (!stored) {
    return false;
  }
  if (stored.expiresAt - RENEW_WITHIN_MS < now) {
    return false;
  }
  // An address the certificate does not name is one the browser will reject.
  return hosts.every((host) => stored.hosts.includes(host));
}

/**
 * Returns the certificate for these addresses, making one only when the stored
 * one cannot serve them. Generation costs a second or so, which is why it is
 * avoided rather than done at every startup.
 */
export async function ensurePhoneCertificate(
  dir: string,
  hosts: string[],
  now: number = Date.now()
): Promise<PhoneCertificate> {
  const wanted = Array.from(new Set(['localhost', '127.0.0.1', ...hosts.filter(Boolean)]));
  const stored = read(dir);

  if (usable(stored, wanted, now)) {
    return { key: stored!.key, cert: stored!.cert, fingerprint: stored!.fingerprint, hosts: stored!.hosts };
  }

  const isIp = (value: string) => /^[0-9.]+$/.test(value) || value.includes(':');
  const generated = await selfsigned.generate(
    [{ name: 'commonName', value: 'Campus Connect' }],
    {
      notBeforeDate: new Date(now),
      notAfterDate: new Date(now + VALID_DAYS * 24 * 60 * 60 * 1000),
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [
        { name: 'basicConstraints', cA: false },
        {
          name: 'subjectAltName',
          altNames: wanted.map((host) =>
            isIp(host) ? { type: 7 as const, ip: host } : { type: 2 as const, value: host }
          )
        }
      ]
    }
  );

  const certificate: StoredCertificate = {
    key: generated.private,
    cert: generated.cert,
    fingerprint: String(generated.fingerprint ?? ''),
    hosts: wanted,
    expiresAt: now + VALID_DAYS * 24 * 60 * 60 * 1000
  };

  write(dir, certificate);
  log.info(`Issued a phone certificate for ${wanted.join(', ')}`);
  return certificate;
}

/** Forgets the stored certificate, so the next start issues a fresh one. */
export function clearPhoneCertificate(dir: string): void {
  try {
    fs.rmSync(path.join(dir, FILE), { force: true });
  } catch {
    // Nothing stored, which is the state we wanted anyway.
  }
}
