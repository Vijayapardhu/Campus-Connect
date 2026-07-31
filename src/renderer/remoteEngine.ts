import type {
  RemoteInputEvent,
  RemoteRole,
  RemoteSignal
} from '../shared/types';
import type { RemoteSignalEvent } from '../shared/bridge';

/**
 * The media and input half of a remote desktop session.
 *
 * Structurally this is a one-to-one call whose camera happens to be a screen,
 * plus a data channel carrying what the mouse and keyboard are doing. It is kept
 * apart from the call engine rather than folded into it because almost every
 * decision differs: one peer instead of a mesh, video in one direction only, a
 * codec profile tuned for text rather than faces, and a permission model where
 * one side is doing something to the other.
 *
 * The data channel matters. Input could in principle go over the app's own UDP
 * protocol, but a mouse being dragged produces events dozens of times a second
 * and every one of them would be JSON, sealed, and put on a broadcast socket.
 * A data channel is point to point, already DTLS-encrypted, and adds no latency
 * worth measuring to a connection that is already open.
 */

export type RemoteConnectionState = 'connecting' | 'connected' | 'interrupted' | 'failed';

export type RemoteEngineHooks = {
  send: (signal: RemoteSignal) => void;
  /** Controller only: the host's screen has arrived. */
  onRemoteStream: (stream: MediaStream | null) => void;
  onConnectionState: (state: RemoteConnectionState) => void;
  /** Host only: an input event arrived and should be applied. */
  onInput: (event: RemoteInputEvent) => void;
  onError: (message: string) => void;
};

/**
 * A shared screen is mostly still text. Resolution is what makes it readable and
 * frame rate is what makes it smooth, and of the two, reading matters more —
 * hence full resolution at a modest frame rate rather than the reverse.
 */
const SCREEN_MAX_WIDTH = 1920;
const SCREEN_MAX_HEIGHT = 1080;
const SCREEN_FRAME_RATE = 20;

type DesktopMediaConstraints = {
  mandatory: {
    chromeMediaSource: 'desktop';
    chromeMediaSourceId: string;
    maxWidth?: number;
    maxHeight?: number;
    maxFrameRate?: number;
  };
};

export class RemoteEngine {
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private screenTrack: MediaStreamTrack | null = null;
  private remoteStream: MediaStream | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];

  private sessionId = '';
  private role: RemoteRole = 'controller';
  private stopped = false;

  constructor(private readonly hooks: RemoteEngineHooks) {}

  // --- lifecycle -----------------------------------------------------------

  /**
   * The host end. Captures the chosen screen and offers it.
   *
   * The host always makes the offer, because the host is the only side with
   * anything to send — settling that by role rather than by negotiation means
   * there is no glare to resolve and no politeness to agree on.
   */
  async startAsHost(sessionId: string, screenSourceId: string): Promise<void> {
    this.sessionId = sessionId;
    this.role = 'host';
    this.stopped = false;

    const constraints: DesktopMediaConstraints = {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: screenSourceId,
        maxWidth: SCREEN_MAX_WIDTH,
        maxHeight: SCREEN_MAX_HEIGHT,
        maxFrameRate: SCREEN_FRAME_RATE
      }
    };

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: constraints as unknown as MediaTrackConstraints
    });

    const track = stream.getVideoTracks()[0];
    if (!track) {
      throw new Error('That screen produced no video.');
    }
    if (this.stopped) {
      track.stop();
      return;
    }

    this.screenTrack = track;
    // The screen going away — unplugged, or the session ended from the OS — has
    // to end the session rather than leave the far end on a frozen frame.
    track.addEventListener('ended', () => this.hooks.onError('The shared screen is no longer available.'));

    const pc = this.createConnection();

    /*
     * Created by the host so there is exactly one channel with one owner. The
     * controller picks it up through `ondatachannel`; if both ends opened one we
     * would have two, and half the input would go down the wrong one.
     *
     * Ordered and reliable: an out-of-order mouse-up after a mouse-down is a
     * stuck button, and a dropped key-up is a stuck key.
     */
    this.attachChannel(pc.createDataChannel('remote-input', { ordered: true }));

    pc.addTrack(track, stream);
    await this.offer();
  }

  /** The controller end. Receives a screen and sends input back. */
  startAsController(sessionId: string): void {
    this.sessionId = sessionId;
    this.role = 'controller';
    this.stopped = false;
    this.createConnection();
  }

  stop(): void {
    this.stopped = true;

    this.channel?.close();
    this.channel = null;

    this.screenTrack?.stop();
    this.screenTrack = null;

    if (this.pc) {
      this.pc.onicecandidate = null;
      this.pc.ontrack = null;
      this.pc.ondatachannel = null;
      this.pc.onconnectionstatechange = null;
      this.pc.close();
      this.pc = null;
    }

    this.remoteStream = null;
    this.pendingCandidates = [];
    this.hooks.onRemoteStream(null);
  }

  // --- input ---------------------------------------------------------------

  /**
   * Controller only. Sends one event to the host.
   *
   * Silently does nothing when the channel is not open — which happens for the
   * first fraction of a second of every session, and for the whole of one where
   * only viewing was granted. Neither is worth an error: the pointer simply has
   * no effect, which is exactly what "view only" should feel like.
   */
  sendInput(event: RemoteInputEvent): void {
    if (this.role !== 'controller' || this.channel?.readyState !== 'open') {
      return;
    }

    try {
      this.channel.send(JSON.stringify(event));
    } catch {
      // A channel closing mid-send is ordinary. The session state will say so.
    }
  }

  get inputReady(): boolean {
    return this.channel?.readyState === 'open';
  }

  // --- signalling ----------------------------------------------------------

  async handleSignal(event: RemoteSignalEvent): Promise<void> {
    const { signal } = event;
    if (this.stopped || signal.sessionId !== this.sessionId) {
      return;
    }

    if (signal.kind === 'sdp') {
      return this.handleDescription(signal.description);
    }
    if (signal.kind === 'ice') {
      return this.handleCandidate(signal.candidate);
    }
  }

  // --- internals -----------------------------------------------------------

  private createConnection(): RTCPeerConnection {
    const pc = new RTCPeerConnection({
      // Empty for the same reason calls are: both machines are on this network,
      // so their own host candidates reach each other and no server is involved.
      iceServers: [],
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
    });

    pc.onicecandidate = ({ candidate }) => {
      if (!candidate?.candidate) {
        return;
      }

      this.hooks.send({
        kind: 'ice',
        sessionId: this.sessionId,
        to: '',
        candidate: {
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid,
          sdpMLineIndex: candidate.sdpMLineIndex,
          usernameFragment: candidate.usernameFragment
        }
      });
    };

    pc.ontrack = ({ track }) => {
      const stream = this.remoteStream ?? new MediaStream();
      stream.addTrack(track);
      this.remoteStream = stream;
      this.hooks.onRemoteStream(stream);
    };

    pc.ondatachannel = ({ channel }) => this.attachChannel(channel);

    pc.onconnectionstatechange = () => {
      switch (pc.connectionState) {
        case 'connected':
          this.hooks.onConnectionState('connected');
          break;
        case 'disconnected':
          this.hooks.onConnectionState('interrupted');
          break;
        case 'failed':
          this.hooks.onConnectionState('failed');
          this.hooks.onError(
            'The direct connection failed. This network may be blocking traffic between devices, which stops remote desktop even though messages still work.'
          );
          break;
        default:
          this.hooks.onConnectionState('connecting');
          break;
      }
    };

    this.pc = pc;
    return pc;
  }

  private attachChannel(channel: RTCDataChannel): void {
    this.channel = channel;

    channel.onmessage = ({ data }) => {
      if (this.role !== 'host' || typeof data !== 'string') {
        return;
      }

      try {
        /*
         * Parsed but not trusted. Whatever comes out of here is checked properly
         * in the main process before anything is allowed to move — this side
         * only has to avoid throwing on malformed JSON.
         */
        this.hooks.onInput(JSON.parse(data) as RemoteInputEvent);
      } catch {
        // Not something this session sent. Ignore it.
      }
    };
  }

  private async offer(): Promise<void> {
    const pc = this.pc;
    if (!pc) {
      return;
    }

    try {
      await pc.setLocalDescription();
      this.sendDescription();
    } catch (error) {
      this.hooks.onError(`The remote session could not be set up: ${asMessage(error)}`);
    }
  }

  private sendDescription(): void {
    const description = this.pc?.localDescription;
    if (!description || (description.type !== 'offer' && description.type !== 'answer')) {
      return;
    }

    this.hooks.send({
      kind: 'sdp',
      sessionId: this.sessionId,
      to: '',
      description: { type: description.type, sdp: description.sdp }
    });
  }

  private async handleDescription(description: { type: 'offer' | 'answer'; sdp: string }): Promise<void> {
    const pc = this.pc;
    if (!pc || !description?.sdp) {
      return;
    }

    try {
      await pc.setRemoteDescription(description);
      await this.flushCandidates();

      if (description.type === 'offer') {
        await pc.setLocalDescription();
        this.sendDescription();
      }
    } catch (error) {
      this.hooks.onError(`The remote session could not be agreed: ${asMessage(error)}`);
    }
  }

  private async handleCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    const pc = this.pc;
    if (!pc || !candidate?.candidate) {
      return;
    }

    // Candidates routinely beat the description they belong to on a fast
    // network, and there is nothing to attach them to until it arrives.
    if (!pc.remoteDescription) {
      this.pendingCandidates.push(candidate);
      return;
    }

    try {
      await pc.addIceCandidate(candidate);
    } catch (error) {
      console.warn('Ignored an unusable ICE candidate', error);
    }
  }

  private async flushCandidates(): Promise<void> {
    const queued = this.pendingCandidates;
    this.pendingCandidates = [];

    for (const candidate of queued) {
      try {
        await this.pc?.addIceCandidate(candidate);
      } catch (error) {
        console.warn('Ignored an unusable queued ICE candidate', error);
      }
    }
  }
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// --------------------------------------------------------------- input capture

/**
 * Turns what happens over the viewer into events the host can apply.
 *
 * Two things matter here. Coordinates are converted to fractions of the shared
 * screen, so neither side has to know the other's resolution and the viewer can
 * be scaled to any size. And moves are coalesced to one per animation frame: a
 * mouse produces events far faster than a screen redraws, and sending all of
 * them would flood the channel to no visible benefit.
 */
export function createInputCapture(send: (event: RemoteInputEvent) => void) {
  let pending: { x: number; y: number } | null = null;
  let frame = 0;

  /** Where the pointer is within the video's picture, as a 0..1 fraction. */
  function locate(event: { clientX: number; clientY: number }, video: HTMLVideoElement) {
    const box = video.getBoundingClientRect();

    /*
     * `object-fit: contain` letterboxes the picture inside the element, so the
     * element's box is not the picture's box. Working from the video's own
     * aspect ratio finds the real one — without this, every click is offset by
     * the size of the black bars.
     */
    const sourceRatio = (video.videoWidth || 16) / (video.videoHeight || 9);
    const boxRatio = box.width / box.height;

    const width = boxRatio > sourceRatio ? box.height * sourceRatio : box.width;
    const height = boxRatio > sourceRatio ? box.height : box.width / sourceRatio;
    const left = box.left + (box.width - width) / 2;
    const top = box.top + (box.height - height) / 2;

    return {
      x: Math.min(1, Math.max(0, (event.clientX - left) / width)),
      y: Math.min(1, Math.max(0, (event.clientY - top) / height))
    };
  }

  function flush() {
    frame = 0;
    if (pending) {
      send({ t: 'move', x: pending.x, y: pending.y });
      pending = null;
    }
  }

  return {
    move(event: MouseEvent, video: HTMLVideoElement) {
      pending = locate(event, video);
      if (!frame) {
        frame = requestAnimationFrame(flush);
      }
    },

    button(event: MouseEvent, video: HTMLVideoElement, down: boolean) {
      const point = locate(event, video);
      const button = event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left';
      send({ t: down ? 'down' : 'up', x: point.x, y: point.y, b: button });
    },

    scroll(event: WheelEvent) {
      // Wheel deltas are wildly different between platforms and devices, so they
      // are reduced to a small number of notches rather than passed through.
      const step = (value: number) => Math.max(-10, Math.min(10, Math.round(-value / 100))) || (value ? -Math.sign(value) : 0);
      send({ t: 'scroll', dx: step(event.deltaX), dy: step(event.deltaY) });
    },

    key(event: KeyboardEvent, down: boolean) {
      send({ t: 'key', k: event.key, down });
    },

    text(value: string) {
      if (value) {
        send({ t: 'text', s: value });
      }
    },

    /** Stops a queued move from firing after the session has gone. */
    dispose() {
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      pending = null;
    }
  };
}
