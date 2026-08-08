import http from 'node:http';
import https from 'node:https';
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
 * One fact shapes the security here: **a browser cannot hold the room key**.
 * Room traffic between desktops is AES-256-GCM sealed, but what a phone is
 * served has already been opened — so the phone sees plaintext at the
 * application layer, and no amount of transport security changes that.
 *
 * This once argued that the transport had to stay plain too, on the grounds
 * that a self-signed certificate teaches people to click through warnings.
 * That was the wrong trade, and it is no longer what happens. Left plain, the
 * phone's own access token and every message it read crossed shared WiFi
 * readable by anyone on it — a far worse habit to have shipped than one
 * warning at pairing time. It is also the only way a browser will hand the
 * page a microphone, which is what lets a phone join a call at all.
 *
 * So the transport is TLS by default (see `phoneCert`), and the exposure that
 * remains is bounded:
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

/** The certificate to serve with, when phone access is running secured. */
export type PhoneTls = { key: string; cert: string };

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
 * works. What is left out is left out for one of three reasons, and none of
 * them is "we did not get round to it":
 *
 *  - **It cannot work.** Remote desktop injects input using screen coordinates
 *    and a native module; calls need the phone to be its own WebRTC peer, which
 *    it is not — it is acting as the laptop. Offering either would be offering
 *    a button that does nothing.
 *  - **It would be a surprise.** Granting somebody control of the laptop, or
 *    restarting it into an update, are not things to be able to do by accident
 *    from a pocket.
 *  - **It opens a native dialog on the laptop.** This is the one that is easy
 *    to reintroduce, so it is worth stating as a rule rather than a list: a
 *    request from a phone must never make a file picker or a save dialog appear
 *    on the desktop. The phone is often in another room, and a modal nobody is
 *    standing in front of blocks the window it is attached to until somebody
 *    walks over and dismisses it. Every `dialog.show*` call in `main.ts` is
 *    therefore behind an entry here — `files:pick`, `dm:send-file`,
 *    `dm:save-file` and both exports by prefix, `chat:send-file` and
 *    `chat:save-file` by name, since `chat:` as a whole must stay reachable.
 *
 * Everything else — every room, chat, members, blocking, settings, snippets,
 * search — is reachable.
 *
 * `httpApi.ts` refuses most of these client-side too, but **that refusal is
 * cosmetic**: a request straight to `/api/rpc` never runs the phone's own
 * client code. This list is the actual gate, and the tests in `test/run.js`
 * under "what a paired phone may ask for" are what keep the two in step.
 *  - Files: a phone browser page has no native file picker and no direct TCP
 *    socket to stream slices over — it genuinely cannot work.
 *  - Direct messages: technically could — it is the same transport room chat
 *    already uses from a phone — but a phone has no place of its own to keep
 *    a thread outside a room's chat, so it stays out until it does.
 *  - Sending and saving a chat file: the room's chat is otherwise fully
 *    reachable, but these two are the picker and the save dialog, so they are
 *    named individually. A phone can still *read* a file somebody sent — it is
 *    in the message like any other content — it simply cannot drive the
 *    laptop's file dialogs to add one or write one out.
 */
export const PHONE_DENIED = [
  'remote:',
  'quick-paste:',
  'update:install',
  'files:',
  'dm:',
  'history:export',
  'chat:send-file',
  'chat:save-file'
];

/**
 * Calls, which are only refused when they could not possibly work.
 *
 * Calls used to be refused over plain HTTP — a browser will not give a page a
 * microphone unless it arrived over a secure origin, so every one of them
 * would have ended in a permission failure the person could do nothing
 * about. The phone bridge is HTTPS now, always, so there is nothing left to
 * refuse on that account.
 */

/** Never available, whatever the transport — a phone has no desktop to capture. */
const PHONE_DENIED_ALWAYS = ['call:screen-sources'];

export function isPhoneMethodAllowed(method: string): boolean {
  const denied = [...PHONE_DENIED, ...PHONE_DENIED_ALWAYS];
  return !denied.some((prefix) => method === prefix || method.startsWith(prefix));
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

/** How often an idle stream sends a comment, so nothing decides it has died. */
const HEARTBEAT_MS = 20000;

export class PhoneServer {
  private server: https.Server | null = null;
  /**
   * Streams currently open to paired phones.
   *
   * The desktop pushes; HTTP does not, which is why the phone used to poll
   * every 1.5 seconds and still felt a beat behind — and why anything that
   * expires on its own, like a ring or a transfer request, could not reach it
   * at all. One long-lived response per phone turns every event the window
   * receives into one the phone receives too.
   */
  private streams = new Set<http.ServerResponse>();
  private heartbeat: NodeJS.Timeout | null = null;
  readonly sessions: PhoneSessions;

  constructor(private readonly hooks: PhoneServerHooks, pairings: PairingStore) {
    this.sessions = new PhoneSessions(pairings);
  }

  get running(): boolean {
    return this.server !== null;
  }

  /**
   * Brings the server up over TLS, always.
   *
   * Plain HTTP used to be offered too, behind a setting most people never
   * had a reason to turn off — everything a phone reads, including its own
   * access token, crossed the WiFi in the clear whenever it was, and a
   * browser will not hand out a microphone to a page it did not receive over
   * a secure origin either way. There is no longer a plaintext path to
   * accidentally leave open.
   */
  start(tls: PhoneTls): void {
    if (this.server) {
      return;
    }

    const handler = (request: http.IncomingMessage, response: http.ServerResponse) => {
      void this.handle(request, response).catch((error: Error) => {
        log.warn(`Phone request failed: ${error.message}`);
        try {
          json(response, 500, { ok: false, message: 'Something went wrong.' });
        } catch {
          // The socket went away mid-answer. Nothing left to tell.
        }
      });
    };

    const server = https.createServer({ key: tls.key, cert: tls.cert }, handler);

    server.on('error', (error) => {
      log.warn(`Phone server error: ${error.message}`);
    });

    server.listen(PHONE_PORT, () => {
      log.info(`Phone access listening on https://0.0.0.0:${PHONE_PORT}`);
    });

    this.server = server;
  }

  /** Always true now — kept so callers that ask don't need to change. */
  get isSecure(): boolean {
    return true;
  }

  stop(): void {
    this.sessions.close();
    this.closeStreams();
    this.server?.close();
    this.server = null;
    log.info('Phone access stopped');
  }

  /**
   * Pushes one event to every paired phone.
   *
   * Named for the IPC channel it mirrors, so the phone's bridge can hand it to
   * exactly the listener the desktop would have. Nothing here decides what a
   * phone should care about — a listener nobody registered simply goes nowhere,
   * which is the same thing that happens in the window.
   */
  broadcast(channel: string, payload: unknown): void {
    if (this.streams.size === 0) {
      return;
    }

    // Serialised once for all of them; this runs on every message in a busy room.
    let frame: string;
    try {
      frame = `event: ${channel}\ndata: ${JSON.stringify(payload ?? null)}\n\n`;
    } catch {
      return; // Not serialisable, so not something a phone can be told about.
    }

    for (const stream of Array.from(this.streams)) {
      try {
        stream.write(frame);
      } catch {
        this.dropStream(stream);
      }
    }
  }

  get connectedStreams(): number {
    return this.streams.size;
  }

  /**
   * One long-lived response per phone.
   *
   * Deliberately behind the same bearer check as everything else: a stream of
   * every message in every room is not less sensitive than the calls that
   * fetch them, and an unauthenticated one would be the most useful thing on
   * the network to anybody watching.
   */
  private events(request: http.IncomingMessage, response: http.ServerResponse): void {
    if (!this.sessions.verify(bearer(request))) {
      json(response, 401, { ok: false, message: 'This phone is not paired.' });
      return;
    }

    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Nothing should sit between these two machines, but a proxy that does
      // would otherwise buffer the stream into uselessness.
      'X-Accel-Buffering': 'no'
    });
    response.write('retry: 2000\n\n');

    this.streams.add(response);
    request.on('close', () => this.dropStream(response));
    response.on('error', () => this.dropStream(response));

    if (!this.heartbeat) {
      /*
       * A comment line every so often. A phone that sleeps and wakes, or a
       * network that quietly drops an idle connection, otherwise leaves both
       * ends believing in a stream that is no longer there.
       */
      this.heartbeat = setInterval(() => {
        for (const stream of Array.from(this.streams)) {
          try {
            stream.write(': ping\n\n');
          } catch {
            this.dropStream(stream);
          }
        }
      }, HEARTBEAT_MS);
      this.heartbeat.unref?.();
    }

    this.hooks.onClientsChanged();
  }

  private dropStream(stream: http.ServerResponse): void {
    if (!this.streams.delete(stream)) {
      return;
    }
    try {
      stream.end();
    } catch {
      // Already gone, which is the point.
    }
    if (this.streams.size === 0 && this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    this.hooks.onClientsChanged();
  }

  private closeStreams(): void {
    for (const stream of Array.from(this.streams)) {
      this.dropStream(stream);
    }
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

    if (request.method === 'GET' && route === '/api/events') {
      return this.events(request, response);
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
