import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import log from 'electron-log';
import { PhoneSessions, type PairingStore } from './phoneSession';

/**
 * The little web server a phone talks to.
 *
 * The phone runs **the same interface as the desktop**, not a cut-down one. It
 * is served the same built bundle, and its API calls come back here as RPC and
 * land on the same handlers Electron IPC uses — so there is one implementation
 * of every action, with one set of checks, rather than a second mobile code path
 * free to drift away from it.
 *
 * Everything about the security here is shaped by one uncomfortable fact: **the
 * phone gets plaintext**. Room traffic between desktops is AES-256-GCM sealed,
 * but a browser cannot hold the room key, so what it receives has already been
 * opened. There is no honest way around that without shipping a certificate
 * people would have to click through a warning to accept, which teaches exactly
 * the wrong habit.
 *
 * So instead of pretending, the exposure is bounded:
 *
 *  - It is **off** unless somebody turns it on.
 *  - Pairing is by **scanning a QR code** carrying a single-use 256-bit key.
 *    Typing the address gets you nothing: the address is guessable, the key is
 *    not, and each code admits exactly one device before rotating.
 *  - The token travels in an `Authorization` header rather than a cookie, so a
 *    page on another site cannot make the browser send it — there is no CSRF
 *    surface at all.
 *  - Only allowlisted methods are reachable, and the desktop can unpair any
 *    phone at any moment.
 */

/** One above the main port, so a single firewall rule covers both. */
export const PHONE_PORT = 37778;

/** A phone paste has to be bounded; generous for text, far short of a file. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export type PhoneServerHooks = {
  /** Runs one permitted method, exactly as the desktop would. */
  call: (method: string, args: unknown[]) => Promise<unknown>;
  /** Where the built interface lives, so the phone is served the same one. */
  rendererRoot: () => string;
  onClientsChanged: () => void;
};

/**
 * What a paired phone may *not* ask for.
 *
 * A deny list rather than an allow list, because a paired phone is the same
 * person holding the same laptop and the useful default is that everything
 * works. What is left out is left out for one of two reasons, and neither is
 * "we did not get round to it":
 *
 *  - **It cannot work.** Remote desktop injects input using screen coordinates
 *    and a native module; calls need the phone to be its own WebRTC peer, which
 *    it is not — it is acting as the laptop. Offering either would be offering
 *    a button that does nothing.
 *  - **It would be a surprise.** Granting somebody control of the laptop, or
 *    restarting it into an update, are not things to be able to do by accident
 *    from a pocket.
 *
 * Everything else — every room, chat, members, blocking, settings, snippets,
 * search — is reachable.
 */
export const PHONE_DENIED = [
  'remote:',
  'call:',
  'quick-paste:',
  'update:install'
];

export function isPhoneMethodAllowed(method: string): boolean {
  return !PHONE_DENIED.some((prefix) => method === prefix || method.startsWith(prefix));
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon'
};

export class PhoneServer {
  private server: http.Server | null = null;
  readonly sessions: PhoneSessions;

  constructor(private readonly hooks: PhoneServerHooks, pairings: PairingStore) {
    this.sessions = new PhoneSessions(pairings);
  }

  get running(): boolean {
    return this.server !== null;
  }

  /** Starts listening. Returns an error message, or an empty string. */
  start(): string {
    if (this.server) {
      return '';
    }

    try {
      const server = http.createServer((request, response) => {
        this.handle(request, response).catch((error) => {
          log.warn(`Phone server: ${(error as Error).message}`);
          json(response, 500, { ok: false, message: 'Something went wrong.' });
        });
      });

      server.on('error', (error) => {
        log.warn(`Phone server error: ${error.message}`);
        this.stop();
      });

      server.listen(PHONE_PORT, '0.0.0.0');
      this.server = server;
      log.info(`Phone access listening on ${PHONE_PORT}`);
      return '';
    } catch (error) {
      return `Phone access could not start: ${(error as Error).message}`;
    }
  }

  stop(): void {
    this.sessions.close();
    this.server?.close();
    this.server = null;
    log.info('Phone access stopped');
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://localhost:${PHONE_PORT}`);
    const route = url.pathname;

    // No referrer carrying this server's address wherever the phone browses next.
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');

    if (request.method === 'POST' && route === '/api/pair') {
      return this.pair(request, response);
    }

    if (request.method === 'GET' && route === '/api/session') {
      // Lets the page discover whether it is already paired without having to
      // make a real call and interpret the failure.
      json(response, 200, { paired: this.sessions.verify(bearer(request)) });
      return;
    }

    if (request.method === 'POST' && route === '/api/rpc') {
      return this.rpc(request, response);
    }

    if (request.method === 'GET') {
      this.serveAsset(route, response);
      return;
    }

    json(response, 404, { ok: false, message: 'Not found.' });
  }

  private async pair(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const body = await readJson(request);
    const token = this.sessions.pair(
      String(body?.key ?? ''),
      clientAddress(request),
      deviceLabel(String(body?.label ?? ''))
    );

    if (!token) {
      /*
       * A pause on every failure, on top of the lockout. Cheap here, and it
       * takes an automated guesser from thousands a second to a crawl.
       */
      await sleep(400);
      json(response, 401, {
        ok: false,
        message: this.sessions.lockedOutUntil
          ? 'Too many failed attempts. Try again in a few minutes.'
          : 'That link is no longer valid. Scan the code on the computer again.'
      });
      return;
    }

    this.hooks.onClientsChanged();
    json(response, 200, { ok: true, token });
  }

  private async rpc(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (!this.sessions.verify(bearer(request))) {
      json(response, 401, { ok: false, message: 'This phone is not paired.' });
      return;
    }

    const body = await readJson(request);
    const method = String(body?.method ?? '');
    const args = Array.isArray(body?.args) ? (body.args as unknown[]) : [];

    if (!isPhoneMethodAllowed(method)) {
      log.warn(`Phone asked for a method it cannot have: ${method}`);
      json(response, 403, { ok: false, message: 'That one only works on the computer.' });
      return;
    }

    try {
      const result = await this.hooks.call(method, args);
      json(response, 200, { ok: true, result: result ?? null });
    } catch (error) {
      log.warn(`Phone RPC ${method} failed: ${(error as Error).message}`);
      json(response, 500, { ok: false, message: 'That did not work.' });
    }
  }

  /**
   * Serves the built interface.
   *
   * Only files that really exist under the renderer's own output directory,
   * resolved and then checked to still be inside it — so a path full of `..`
   * cannot walk out and start serving the rest of the disk.
   */
  private serveAsset(route: string, response: http.ServerResponse): void {
    const root = path.resolve(this.hooks.rendererRoot());
    const fallback = path.join(root, 'index.html');

    let file = fallback;
    if (route !== '/') {
      const requested = path.resolve(root, decodeURIComponent(route).replace(/^\/+/, ''));
      const inside = requested === root || requested.startsWith(root + path.sep);
      if (inside && fs.existsSync(requested) && fs.statSync(requested).isFile()) {
        file = requested;
      }
    }

    if (!fs.existsSync(file)) {
      json(response, 404, { ok: false, message: 'The interface has not been built.' });
      return;
    }

    const body = fs.readFileSync(file);
    response.writeHead(200, {
      'Content-Type': CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': body.length,
      // Asset filenames are content-hashed and can be cached hard. The page
      // itself never is, so a rebuilt app is picked up on the next reload.
      'Cache-Control': file === fallback ? 'no-store' : 'public, max-age=86400'
    });
    response.end(body);
  }
}

function json(response: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload)
  });
  response.end(payload);
}

function bearer(request: http.IncomingMessage): string {
  const header = request.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

function clientAddress(request: http.IncomingMessage): string {
  // Deliberately the socket's own address. `X-Forwarded-For` is trivially forged
  // and there is no proxy in front of this.
  return request.socket.remoteAddress?.replace(/^::ffff:/, '') ?? 'unknown';
}

/** Turns a user agent into something a person can recognise in a list. */
function deviceLabel(userAgent: string): string {
  if (/iPhone/i.test(userAgent)) return 'iPhone';
  if (/iPad/i.test(userAgent)) return 'iPad';
  if (/Android/i.test(userAgent)) return 'Android phone';
  if (/Macintosh/i.test(userAgent)) return 'Mac';
  if (/Windows/i.test(userAgent)) return 'Windows device';
  if (/Linux/i.test(userAgent)) return 'Linux device';
  return 'A phone';
}

/** Reads a JSON body, refusing anything oversized before it is buffered whole. */
async function readJson(request: http.IncomingMessage): Promise<Record<string, unknown> | null> {
  if (Number(request.headers['content-length'] ?? 0) > MAX_BODY_BYTES) {
    request.destroy();
    return null;
  }

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;

    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      // A missing or lying Content-Length must not become an unbounded buffer.
      if (size > MAX_BODY_BYTES) {
        request.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });

    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
      } catch {
        resolve(null);
      }
    });

    request.on('error', () => resolve(null));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
