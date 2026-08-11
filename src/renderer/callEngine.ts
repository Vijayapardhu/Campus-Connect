import type {
  CallDeviceState,
  CallMode,
  CallSignal
} from '../shared/types';
import type { CallSignalEvent } from '../shared/bridge';

/**
 * The media half of a call: microphones, cameras, screens and the peer
 * connections that carry them.
 *
 * This is a full mesh. Every participant holds one connection to every other,
 * with no server in the middle and no mixing anywhere — which is the whole point
 * on a LAN. There is nothing to run, nothing to configure, and the audio takes
 * one hop through the switch instead of a round trip to a datacentre. It is also
 * why calls are capped at a handful of people: the cost is quadratic, and it is
 * the video encoders that give out first, not the network.
 *
 * Two decisions are worth knowing about before reading further.
 *
 * There are no ICE servers. STUN exists to discover your address as seen from
 * outside, and TURN exists to relay when a direct path cannot be found; on the
 * same network neither problem exists, so the list is deliberately empty and
 * every connection is made from host candidates. That is what lets a call work
 * with the internet unplugged.
 *
 * Both an audio and a video transceiver are created up front, even for a voice
 * call. An empty video transceiver costs nothing while no track is attached to
 * it, and having it there means turning the camera on, or starting a screen
 * share, is a `replaceTrack` on a sender that already exists — no new m-line, no
 * renegotiation, no chance of the two ends disagreeing about the shape of the
 * session halfway through a call.
 */

export type PeerConnectionState = 'connecting' | 'connected' | 'interrupted' | 'failed';

export type CallPeer = {
  deviceId: string;
  deviceName: string;
  /** Their media, or null until the first track arrives. */
  stream: MediaStream | null;
  state: PeerConnectionState;
  /** What they say they are sending. Not enforceable, only reported. */
  micOn: boolean;
  cameraOn: boolean;
  sharing: boolean;
};

export type CallEngineHooks = {
  /** Puts a setup step on the wire. The main process seals and routes it. */
  send: (signal: CallSignal) => void;
  onPeersChanged: (peers: CallPeer[]) => void;
  /**
   * The stream for this device's own tile. Video only — putting the microphone
   * in it would play the room its own voice back at itself.
   *
   * The same object throughout a call, with its video track swapped in place as
   * the camera goes on and off or a screen share starts. A `<video>` element
   * pointed at it follows those swaps on its own, with no re-render needed.
   */
  onLocalPreview: (stream: MediaStream) => void;
  onLocalStateChanged: (state: CallDeviceState) => void;
  /** Something went wrong that the user has to be told about. */
  onError: (message: string) => void;
};

type Peer = {
  deviceId: string;
  deviceName: string;
  pc: RTCPeerConnection;
  /**
   * Who yields when both ends offer at once. Decided from the device ids, so the
   * two sides always agree without having to negotiate the negotiation.
   */
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  stream: MediaStream;
  audioSender: RTCRtpSender;
  videoSender: RTCRtpSender;
  /** Candidates that arrived before there was a description to attach them to. */
  pendingCandidates: RTCIceCandidateInit[];
  state: PeerConnectionState;
  micOn: boolean;
  cameraOn: boolean;
  sharing: boolean;
};

/**
 * 720p at 30fps is what a laptop camera gives and what a LAN carries without
 * noticing. Asking for more costs encoder time for detail a call does not need.
 */
const CAMERA_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 30, max: 30 }
};

/**
 * A shared screen is mostly text, so resolution matters and frame rate does not.
 * 1080p at 15fps keeps code and slides legible; 30fps of a still window would
 * spend the bitrate on nothing.
 */
const SCREEN_MAX_WIDTH = 1920;
const SCREEN_MAX_HEIGHT = 1080;
const SCREEN_FRAME_RATE = 15;

/** Desktop capture is requested through constraints Electron adds, not the DOM's. */
type DesktopMediaConstraints = {
  mandatory: {
    chromeMediaSource: 'desktop';
    chromeMediaSourceId: string;
    maxWidth?: number;
    maxHeight?: number;
    maxFrameRate?: number;
  };
};

export class CallEngine {
  private peers = new Map<string, Peer>();
  /**
   * `'device'` state that arrived for a peer this device has not created yet.
   *
   * Signalling travels over UDP broadcast/unicast, which does not guarantee
   * order — a peer's own `publishLocalState()` broadcast and the `'here'`/
   * `'sdp'` traffic that causes this device to `ensurePeer()` them are two
   * separate packets, and the state one can arrive first. It used to be
   * discarded outright when that happened (a plain `Map.get`, never
   * `ensurePeer`), so if that peer never touched a mic/camera/share toggle
   * for the rest of the call, its tile stayed on `ensurePeer`'s hardcoded
   * defaults — indefinitely. Buffered here and applied the moment the peer
   * is actually created, the same way `pendingCandidates` holds ICE
   * candidates that arrive before there is a description to attach them to.
   */
  private pendingDeviceState = new Map<string, { micOn: boolean; cameraOn: boolean; sharing: boolean }>();
  private micTrack: MediaStreamTrack | null = null;
  private cameraTrack: MediaStreamTrack | null = null;
  private screenTrack: MediaStreamTrack | null = null;
  /** This device's own tile. One video track at a time, never any audio. */
  private preview = new MediaStream();

  private callId = '';
  private selfId = '';
  private mode: CallMode = 'audio';
  private stopped = false;

  private micOn = true;
  private cameraOn = false;

  constructor(private readonly hooks: CallEngineHooks) {}

  // --- lifecycle -----------------------------------------------------------

  /**
   * Opens the microphone — and the camera for a video call — before anyone is
   * connected. Doing it first means a failure here is a call that never starts
   * rather than one that connects and then turns out to be silent.
   */
  async start(options: {
    callId: string;
    selfId: string;
    mode: CallMode;
    startMuted: boolean;
  }): Promise<void> {
    this.callId = options.callId;
    this.selfId = options.selfId;
    this.mode = options.mode;
    this.stopped = false;
    this.micOn = !options.startMuted;
    this.cameraOn = options.mode === 'video';

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: options.mode === 'video' ? CAMERA_CONSTRAINTS : false
    });

    if (this.stopped) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
      return;
    }

    this.micTrack = stream.getAudioTracks()[0] ?? null;
    this.cameraTrack = stream.getVideoTracks()[0] ?? null;

    if (this.micTrack) {
      this.micTrack.enabled = this.micOn;
    }
    if (this.cameraTrack) {
      this.cameraTrack.enabled = this.cameraOn;
    }

    this.refreshPreview();
    this.hooks.onLocalPreview(this.preview);
    this.publishLocalState();
  }

  /** Tears everything down. Safe to call more than once. */
  stop(): void {
    this.stopped = true;

    for (const peer of this.peers.values()) {
      peer.pc.onicecandidate = null;
      peer.pc.ontrack = null;
      peer.pc.onnegotiationneeded = null;
      peer.pc.onconnectionstatechange = null;
      peer.pc.close();
    }
    this.peers.clear();

    for (const track of [this.micTrack, this.cameraTrack, this.screenTrack]) {
      track?.stop();
    }
    for (const track of this.preview.getTracks()) {
      this.preview.removeTrack(track);
    }

    this.micTrack = null;
    this.cameraTrack = null;
    this.screenTrack = null;

    this.hooks.onPeersChanged([]);
  }

  /** Points the preview at whatever this device is currently sending as video. */
  private refreshPreview(): void {
    const next = this.getLocalVideoTrack();

    for (const track of this.preview.getVideoTracks()) {
      if (track !== next) {
        this.preview.removeTrack(track);
      }
    }
    if (next && !this.preview.getVideoTracks().includes(next)) {
      this.preview.addTrack(next);
    }
  }

  // --- controls ------------------------------------------------------------

  setMicOn(on: boolean): void {
    this.micOn = on;
    if (this.micTrack) {
      this.micTrack.enabled = on;
    }
    this.publishLocalState();
  }

  /**
   * Turns the camera on and off, acquiring it the first time if this started as
   * a voice call. The video transceiver is already there, so the track slots
   * straight into it and nothing has to be renegotiated.
   */
  async setCameraOn(on: boolean): Promise<void> {
    if (on && !this.cameraTrack) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: CAMERA_CONSTRAINTS });
        const track = stream.getVideoTracks()[0];
        if (!track) {
          throw new Error('No camera track was produced.');
        }
        if (this.stopped) {
          track.stop();
          return;
        }

        this.cameraTrack = track;
      } catch (error) {
        this.hooks.onError(describeMediaError(error, 'camera'));
        return;
      }
    }

    this.cameraOn = on;
    if (this.cameraTrack) {
      this.cameraTrack.enabled = on;
    }

    // A screen share owns the video sender while it lasts; the camera goes back
    // to it when the share stops.
    if (!this.screenTrack) {
      await this.sendVideoTrack(on ? this.cameraTrack : null);
    }

    this.publishLocalState();
  }

  /**
   * Starts sharing a screen or window. The id comes from the picker in the main
   * process, so nothing is captured until the user has chosen what.
   */
  async startScreenShare(sourceId: string): Promise<boolean> {
    try {
      const constraints: DesktopMediaConstraints = {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
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
        throw new Error('No screen track was produced.');
      }
      if (this.stopped) {
        track.stop();
        return false;
      }

      this.screenTrack?.stop();
      this.screenTrack = track;

      /*
       * Stopping the share from the operating system's own bar ends the track
       * without going through the UI, so the call has to notice that itself or
       * everyone keeps looking at a frozen last frame.
       */
      track.addEventListener('ended', () => {
        if (this.screenTrack === track) {
          void this.stopScreenShare();
        }
      });

      await this.sendVideoTrack(track);
      this.publishLocalState();
      return true;
    } catch (error) {
      this.hooks.onError(describeMediaError(error, 'screen'));
      return false;
    }
  }

  async stopScreenShare(): Promise<void> {
    if (!this.screenTrack) {
      return;
    }

    this.screenTrack.stop();
    this.screenTrack = null;
    await this.sendVideoTrack(this.cameraOn ? this.cameraTrack : null);
    this.publishLocalState();
  }

  getLocalState(): CallDeviceState {
    return {
      micOn: this.micOn && Boolean(this.micTrack),
      cameraOn: this.cameraOn && Boolean(this.cameraTrack),
      sharing: Boolean(this.screenTrack)
    };
  }

  /** The track shown in the local preview: the shared screen wins over the camera. */
  getLocalVideoTrack(): MediaStreamTrack | null {
    return this.screenTrack ?? (this.cameraOn ? this.cameraTrack : null);
  }

  // --- signalling ----------------------------------------------------------

  /**
   * One arriving setup step. The sender has already been checked against the
   * room's roster by the main process, so identity here can be taken at face
   * value.
   */
  async handleSignal(event: CallSignalEvent): Promise<void> {
    if (this.stopped || event.signal.callId !== this.callId) {
      return;
    }

    const { signal } = event;

    switch (signal.kind) {
      case 'join':
      case 'here': {
        const peer = this.ensurePeer(event.fromDeviceId, event.fromDeviceName);
        // Tell a newcomer what we are sending; they have no way of knowing yet.
        if (peer) {
          this.publishLocalState();
        }
        return;
      }

      case 'leave':
        this.dropPeer(event.fromDeviceId);
        return;

      case 'sdp':
        return this.handleDescription(event.fromDeviceId, event.fromDeviceName, signal.description);

      case 'ice':
        return this.handleCandidate(event.fromDeviceId, event.fromDeviceName, signal.candidate);

      case 'device': {
        const state = {
          micOn: Boolean(signal.state?.micOn),
          cameraOn: Boolean(signal.state?.cameraOn),
          sharing: Boolean(signal.state?.sharing)
        };
        const peer = this.peers.get(event.fromDeviceId);
        if (peer) {
          peer.micOn = state.micOn;
          peer.cameraOn = state.cameraOn;
          peer.sharing = state.sharing;
          this.publishPeers();
        } else {
          // Not created yet — buffered rather than dropped. See
          // `pendingDeviceState`'s own comment for why this happens.
          this.pendingDeviceState.set(event.fromDeviceId, state);
        }
        return;
      }

      default:
        return;
    }
  }

  // --- internals -----------------------------------------------------------

  private publishLocalState(): void {
    this.refreshPreview();
    const state = this.getLocalState();
    this.hooks.onLocalStateChanged(state);
    this.hooks.send({ kind: 'device', callId: this.callId, state });
  }

  private publishPeers(): void {
    const peers: CallPeer[] = Array.from(this.peers.values())
      .map((peer) => ({
        deviceId: peer.deviceId,
        deviceName: peer.deviceName,
        stream: peer.stream.getTracks().length > 0 ? peer.stream : null,
        state: peer.state,
        micOn: peer.micOn,
        cameraOn: peer.cameraOn,
        sharing: peer.sharing
      }))
      .sort((a, b) => a.deviceName.localeCompare(b.deviceName));

    this.hooks.onPeersChanged(peers);
  }

  /** Swaps what the video sender is sending, on every connection at once. */
  private async sendVideoTrack(track: MediaStreamTrack | null): Promise<void> {
    await Promise.all(
      Array.from(this.peers.values()).map(async (peer) => {
        try {
          await peer.videoSender.replaceTrack(track);
        } catch {
          // A connection that has already gone is not worth reporting; the
          // connection state change has said so already.
        }
      })
    );
  }

  /**
   * The connection to one other participant, created once and reused. Signals
   * can arrive in any order, so anything that mentions a device we have not met
   * brings the connection into being rather than being dropped.
   */
  private ensurePeer(deviceId: string, deviceName: string): Peer | null {
    if (this.stopped || deviceId === this.selfId) {
      return null;
    }

    const existing = this.peers.get(deviceId);
    if (existing) {
      if (deviceName && existing.deviceName !== deviceName) {
        existing.deviceName = deviceName;
        this.publishPeers();
      }
      return existing;
    }

    const pc = new RTCPeerConnection({
      // Empty on purpose — see the note at the top of this file.
      iceServers: [],
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
    });

    const audioSender = pc.addTransceiver(this.micTrack ?? 'audio', { direction: 'sendrecv' }).sender;
    const videoSender = pc.addTransceiver(this.getLocalVideoTrack() ?? 'video', {
      direction: 'sendrecv'
    }).sender;

    const peer: Peer = {
      deviceId,
      deviceName,
      pc,
      /*
       * Ties are broken by comparing ids: the larger one gives way. Both ends
       * run the same comparison on the same two strings, so exactly one of them
       * is polite without a word being exchanged about it.
       */
      polite: this.selfId > deviceId,
      makingOffer: false,
      ignoreOffer: false,
      stream: new MediaStream(),
      audioSender,
      videoSender,
      pendingCandidates: [],
      state: 'connecting',
      micOn: true,
      cameraOn: false,
      sharing: false
    };

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        this.sendDescription(peer);
      } catch (error) {
        this.hooks.onError(`Could not set up the call with ${peer.deviceName}: ${asMessage(error)}`);
      } finally {
        peer.makingOffer = false;
      }
    };

    pc.onicecandidate = ({ candidate }) => {
      if (!candidate?.candidate) {
        return; // The end-of-candidates marker; the far side infers it.
      }

      this.hooks.send({
        kind: 'ice',
        callId: this.callId,
        to: peer.deviceId,
        candidate: {
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid,
          sdpMLineIndex: candidate.sdpMLineIndex,
          usernameFragment: candidate.usernameFragment
        }
      });
    };

    pc.ontrack = ({ track }) => {
      /*
       * The remote stream is assembled here rather than taken from the event.
       * A transceiver created without a track carries no stream id, so
       * `event.streams` can legitimately be empty — building it locally means
       * the video element has something to point at either way.
       */
      peer.stream.addTrack(track);
      track.addEventListener('ended', () => {
        peer.stream.removeTrack(track);
        this.publishPeers();
      });
      this.publishPeers();
    };

    pc.onconnectionstatechange = () => {
      switch (pc.connectionState) {
        case 'connected':
          peer.state = 'connected';
          break;
        case 'disconnected':
          peer.state = 'interrupted';
          break;
        case 'failed':
          peer.state = 'failed';
          /*
           * On a LAN a failure is almost always client isolation — the access
           * point refusing to pass traffic between two of its own clients. No
           * amount of retrying fixes that, so say so plainly instead.
           */
          this.hooks.onError(
            `Could not reach ${peer.deviceName} directly. This network may be blocking traffic between devices, which stops calls even though messages still work.`
          );
          break;
        case 'closed':
          peer.state = 'failed';
          break;
        default:
          peer.state = 'connecting';
          break;
      }
      this.publishPeers();
    };

    // Any `'device'` state that arrived before this peer existed is applied
    // right away, rather than waiting for that peer to next toggle something.
    const buffered = this.pendingDeviceState.get(deviceId);
    if (buffered) {
      this.pendingDeviceState.delete(deviceId);
      peer.micOn = buffered.micOn;
      peer.cameraOn = buffered.cameraOn;
      peer.sharing = buffered.sharing;
    }

    this.peers.set(deviceId, peer);
    this.publishPeers();
    return peer;
  }

  private dropPeer(deviceId: string): void {
    const peer = this.peers.get(deviceId);
    if (!peer) {
      return;
    }

    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    peer.pc.onnegotiationneeded = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.close();
    this.peers.delete(deviceId);
    this.publishPeers();
  }

  private sendDescription(peer: Peer): void {
    const description = peer.pc.localDescription;
    if (!description || (description.type !== 'offer' && description.type !== 'answer')) {
      return;
    }

    this.hooks.send({
      kind: 'sdp',
      callId: this.callId,
      to: peer.deviceId,
      description: { type: description.type, sdp: description.sdp }
    });
  }

  /**
   * Perfect negotiation, as specified. Both ends may offer at the same time —
   * two people joining at once is the normal way that happens — and the impolite
   * end simply ignores the offer it collided with, while the polite end rolls
   * its own back and answers. Neither side has to be designated the caller.
   */
  private async handleDescription(
    deviceId: string,
    deviceName: string,
    description: { type: 'offer' | 'answer'; sdp: string }
  ): Promise<void> {
    const peer = this.ensurePeer(deviceId, deviceName);
    if (!peer || !description?.sdp) {
      return;
    }

    const collision =
      description.type === 'offer' && (peer.makingOffer || peer.pc.signalingState !== 'stable');

    peer.ignoreOffer = !peer.polite && collision;
    if (peer.ignoreOffer) {
      return;
    }

    try {
      await peer.pc.setRemoteDescription(description);
      await this.flushCandidates(peer);

      if (description.type === 'offer') {
        await peer.pc.setLocalDescription();
        this.sendDescription(peer);
      }
    } catch (error) {
      this.hooks.onError(`Could not agree a connection with ${peer.deviceName}: ${asMessage(error)}`);
    }
  }

  private async handleCandidate(
    deviceId: string,
    deviceName: string,
    candidate: RTCIceCandidateInit
  ): Promise<void> {
    const peer = this.ensurePeer(deviceId, deviceName);
    if (!peer || !candidate?.candidate) {
      return;
    }

    // A candidate is only attachable once there is a remote description to
    // attach it to, and on a fast network it routinely arrives first.
    if (!peer.pc.remoteDescription) {
      peer.pendingCandidates.push(candidate);
      return;
    }

    try {
      await peer.pc.addIceCandidate(candidate);
    } catch (error) {
      // Expected for the offer we deliberately ignored: its candidates belong to
      // a negotiation that never happened.
      if (!peer.ignoreOffer) {
        console.warn('Ignored an unusable ICE candidate', error);
      }
    }
  }

  private async flushCandidates(peer: Peer): Promise<void> {
    const queued = peer.pendingCandidates;
    peer.pendingCandidates = [];

    for (const candidate of queued) {
      try {
        await peer.pc.addIceCandidate(candidate);
      } catch (error) {
        console.warn('Ignored an unusable queued ICE candidate', error);
      }
    }
  }
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Media failures are one of the few places where the browser's own wording is
 * worse than useless — "NotAllowedError" tells the user nothing about what to do
 * next.
 */
export function describeMediaError(error: unknown, what: 'camera' | 'microphone' | 'screen'): string {
  const name = error instanceof DOMException ? error.name : '';

  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return what === 'screen'
      ? 'Screen sharing was refused by the system. On macOS, allow screen recording for this app in System Settings → Privacy & Security.'
      : `Access to the ${what} was refused by the system. Allow it for this app in your privacy settings, then try again.`;
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return `No ${what} was found on this device.`;
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return `The ${what} is in use by another application.`;
  }

  return `The ${what} could not be started: ${asMessage(error)}`;
}
