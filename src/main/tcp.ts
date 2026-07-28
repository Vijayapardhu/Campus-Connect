import net from 'node:net';
import log from 'electron-log';
import { FrameDecoder, encodeFrame } from './framing';

/**
 * A direct TCP transport, running alongside UDP.
 *
 * UDP broadcast is how devices find each other, and on an ordinary network it
 * is all that is needed. Plenty of networks are not ordinary: many campus and
 * corporate deployments filter broadcast, and some filter UDP entirely while
 * leaving TCP alone. In that case the devices can still reach each other
 * perfectly well — the app just had no way to use that fact.
 *
 * So every device also listens on TCP, and a peer added by address gets a real
 * connection. Frames arriving here are handed to exactly the same
 * `handleWireMessage` as UDP datagrams, so membership checks and decryption are
 * unchanged; this is a different pipe, not a different set of rules.
 *
 * It has a second benefit worth noting: TCP already guarantees ordering and
 * delivery, so a large payload does not need chunking or retransmission over
 * this path at all.
 *
 * None of this defeats client isolation. When the access point drops packets
 * between two clients, both transports fail, and nothing in an application can
 * change that.
 */

const RECONNECT_DELAY_MS = 5000;
const MAX_RECONNECT_DELAY_MS = 60000;
const CONNECT_TIMEOUT_MS = 4000;
/** Sockets idle longer than this are closed; the peer will be redialled. */
const IDLE_TIMEOUT_MS = 120000;

type Connection = {
  socket: net.Socket;
  decoder: FrameDecoder;
  host: string;
  /** Set for connections this device opened, and so should re-open. */
  outbound: boolean;
  retryDelay: number;
  retryTimer: NodeJS.Timeout | null;
};

export type TcpTransportOptions = {
  port: number;
  maxFrameBytes: number;
  /** Called with every complete frame, plus the address it arrived from. */
  onMessage: (payload: string, host: string) => void;
  onStatus?: (message: string) => void;
};

export class TcpTransport {
  private server: net.Server | null = null;
  /** Keyed by host, so a peer has at most one connection either way. */
  private connections = new Map<string, Connection>();
  private stopped = false;

  constructor(private readonly options: TcpTransportOptions) {}

  start(): void {
    this.stopped = false;
    this.server = net.createServer((socket) => this.adopt(socket, false));

    this.server.on('error', (error) => {
      log.warn(`TCP listener error: ${error.message}`);
      this.options.onStatus?.(`Direct connections unavailable: ${error.message}`);
    });

    this.server.listen(this.options.port, () => {
      log.info(`Also listening for direct connections on TCP ${this.options.port}`);
    });
  }

  stop(): void {
    this.stopped = true;

    for (const connection of this.connections.values()) {
      if (connection.retryTimer) {
        clearTimeout(connection.retryTimer);
      }
      connection.socket.destroy();
    }
    this.connections.clear();

    this.server?.close();
    this.server = null;
  }

  /** Opens a connection to a peer, or leaves the existing one alone. */
  connect(host: string): void {
    if (this.stopped || this.connections.has(host)) {
      return;
    }
    this.dial(host, RECONNECT_DELAY_MS);
  }

  /** True when a frame can be delivered to this host right now. */
  isConnected(host: string): boolean {
    const connection = this.connections.get(host);
    return Boolean(connection && !connection.socket.destroyed && connection.socket.writable);
  }

  get connectedHosts(): string[] {
    return Array.from(this.connections.keys()).filter((host) => this.isConnected(host));
  }

  /** Sends a frame. Returns false if there was no usable connection. */
  send(host: string, payload: string): boolean {
    const connection = this.connections.get(host);
    if (!connection || connection.socket.destroyed || !connection.socket.writable) {
      return false;
    }

    try {
      connection.socket.write(encodeFrame(payload, this.options.maxFrameBytes));
      return true;
    } catch (error) {
      log.warn(`TCP send to ${host} failed: ${(error as Error).message}`);
      return false;
    }
  }

  private dial(host: string, delay: number): void {
    const socket = new net.Socket();
    const connection: Connection = {
      socket,
      decoder: new FrameDecoder(this.options.maxFrameBytes),
      host,
      outbound: true,
      retryDelay: delay,
      retryTimer: null
    };
    this.connections.set(host, connection);

    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.once('timeout', () => socket.destroy());

    socket.connect(this.options.port, host, () => {
      // Past the handshake the timeout becomes an idle timeout, not a dial one.
      socket.setTimeout(IDLE_TIMEOUT_MS);
      connection.retryDelay = RECONNECT_DELAY_MS;
      log.info(`Direct connection to ${host} established`);
      this.options.onStatus?.(`Connected directly to ${host}`);
    });

    this.wire(connection);
  }

  /** Takes over a socket the server accepted. */
  private adopt(socket: net.Socket, outbound: boolean): void {
    const host = socket.remoteAddress?.replace(/^::ffff:/, '') ?? '';
    if (!host) {
      socket.destroy();
      return;
    }

    // An inbound connection replaces whatever was there: the peer clearly
    // believes this one works, and two sockets to one host help nobody.
    const existing = this.connections.get(host);
    if (existing) {
      if (existing.retryTimer) {
        clearTimeout(existing.retryTimer);
      }
      existing.socket.destroy();
    }

    socket.setTimeout(IDLE_TIMEOUT_MS);
    const connection: Connection = {
      socket,
      decoder: new FrameDecoder(this.options.maxFrameBytes),
      host,
      outbound,
      retryDelay: RECONNECT_DELAY_MS,
      retryTimer: null
    };
    this.connections.set(host, connection);
    this.wire(connection);
    log.info(`Accepted a direct connection from ${host}`);
  }

  private wire(connection: Connection): void {
    const { socket, decoder, host } = connection;

    socket.on('data', (chunk) => {
      for (const payload of decoder.push(chunk)) {
        this.options.onMessage(payload, host);
      }

      if (decoder.isBroken) {
        log.warn(`Closing ${host}: oversized or malformed frame`);
        socket.destroy();
      }
    });

    socket.on('timeout', () => socket.destroy());
    socket.on('error', () => {
      // Errors always arrive with a close; handle it there so it happens once.
    });

    socket.on('close', () => {
      if (this.connections.get(host) !== connection) {
        return; // Already replaced by a newer socket.
      }
      this.connections.delete(host);

      if (this.stopped || !connection.outbound) {
        return;
      }

      // Backs off so an unreachable address is not dialled every five seconds
      // forever, but keeps trying: the peer may simply be closed right now.
      const next = Math.min(connection.retryDelay * 2, MAX_RECONNECT_DELAY_MS);
      const timer = setTimeout(() => this.dial(host, next), connection.retryDelay);
      timer.unref?.();
    });
  }
}

/**
 * Can this address be reached over TCP at all? Used by the connectivity test
 * to tell "the network drops everything between clients" apart from "only
 * broadcast or only UDP is filtered", which look identical from the app.
 */
export function probeTcp(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (reachable: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(reachable);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}
