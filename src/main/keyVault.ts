/**
 * Where derived room keys live between runs.
 *
 * They used to sit in `config.json` as a plain map of roomId to hex, which
 * meant anyone who could read the user profile — another account on a shared
 * machine, a copied folder, a backup, a stolen laptop — held every room key
 * this device had ever derived, and could decrypt anything captured off the
 * network. The keys now go through the operating system's own credential
 * store: DPAPI on Windows, the Keychain on macOS, libsecret or kwallet on
 * Linux, all behind Electron's `safeStorage`.
 *
 * What that does and does not buy is worth being exact about. The ciphertext
 * is bound to the OS user account, so it is useless in a copied profile
 * directory or on another account. It is **not** protection against code
 * running as you — malware in your session can ask `safeStorage` to decrypt
 * exactly as this app does. Defending against that needs a passphrase the
 * user types and the app never stores, which is a different feature.
 *
 * Electron is not imported here. The encryptor is injected, which is what
 * keeps this file runnable under plain Node in the test suite — the same
 * reason crypto.ts, roomManager.ts and phoneSession.ts have no Electron in
 * them either.
 */

/** The platform credential store, as much of it as this module needs. */
export interface Encryptor {
  /** False when no OS keyring is available — common on bare Linux installs. */
  available(): boolean;
  encrypt(plaintext: string): Buffer;
  decrypt(payload: Buffer): string;
}

/** The slots in electron-store this vault owns. */
export interface VaultStorage {
  /** Base64 of the encrypted blob, or undefined before anything is written. */
  readVault(): string | undefined;
  writeVault(blob: string | undefined): void;
  /** The old plaintext `roomKeys` map. Read once, then emptied. */
  readLegacy(): Record<string, string>;
  clearLegacy(): void;
}

export type KeyMap = Record<string, string>;

function isKeyMap(value: unknown): value is KeyMap {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}

export class KeyVault {
  /**
   * True when what is on disk is actually encrypted.
   *
   * False means this run is keeping keys in memory only, because the platform
   * offered nowhere safe to put them. Callers surface this rather than
   * pretending the keys were saved.
   */
  readonly sealed: boolean;

  private cache: KeyMap;

  constructor(
    private readonly storage: VaultStorage,
    private readonly encryptor: Encryptor,
    private readonly onWarn: (message: string) => void = () => {}
  ) {
    this.sealed = encryptor.available();
    this.cache = this.load();

    /*
     * Migration runs on construction rather than lazily, so a device that is
     * opened once and never touched again still stops holding plaintext.
     */
    if (this.sealed && Object.keys(this.storage.readLegacy()).length > 0) {
      this.persist();
      this.storage.clearLegacy();
      this.onWarn('Room keys moved into the OS credential store.');
    }
  }

  read(): KeyMap {
    return { ...this.cache };
  }

  write(keys: KeyMap): void {
    this.cache = { ...keys };
    this.persist();
  }

  // --- internals -----------------------------------------------------------

  /**
   * The vault first, then the old plaintext map.
   *
   * Both are consulted on the way in so an upgrade does not lock anybody out
   * of a room they were already in — the keys are read from wherever they
   * happen to be, and the next write puts them somewhere better.
   */
  private load(): KeyMap {
    const blob = this.storage.readVault();

    if (blob && this.sealed) {
      try {
        const parsed: unknown = JSON.parse(this.encryptor.decrypt(Buffer.from(blob, 'base64')));
        if (isKeyMap(parsed)) {
          return parsed;
        }
        this.onWarn('The key vault did not contain a key map; ignoring it.');
      } catch {
        /*
         * Decryption fails when the vault was written by a different OS user,
         * or the keyring has been reset. Neither is recoverable and neither is
         * fatal: the rooms are still here, they simply report as locked until
         * their passwords are entered again.
         */
        this.onWarn('Saved room keys could not be decrypted. Rooms will ask for their passwords again.');
      }
      return {};
    }

    if (blob && !this.sealed) {
      this.onWarn('Room keys are stored encrypted but this system offers no way to decrypt them.');
      return {};
    }

    return { ...this.storage.readLegacy() };
  }

  /**
   * Writes the vault — or, where there is nowhere safe to write, deliberately
   * writes nothing at all.
   *
   * The alternative was falling back to the plaintext map, which would mean
   * the fix quietly not applying on exactly the systems that have no keyring.
   * Keys stay in memory for the rest of the session and the rooms ask for
   * their passwords on the next launch. Losing a saved password is a smaller
   * harm than writing it somewhere readable, and the warning says so.
   */
  private persist(): void {
    if (!this.sealed) {
      this.storage.writeVault(undefined);
      this.storage.clearLegacy();
      this.onWarn(
        'No OS credential store is available, so room keys are being kept for this session only.'
      );
      return;
    }

    if (Object.keys(this.cache).length === 0) {
      this.storage.writeVault(undefined);
      this.storage.clearLegacy();
      return;
    }

    this.storage.writeVault(this.encryptor.encrypt(JSON.stringify(this.cache)).toString('base64'));
    this.storage.clearLegacy();
  }
}
