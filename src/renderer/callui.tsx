import React from 'react';
import type {
  ActiveCall,
  CallDeviceState,
  CallMode,
  CallRinging,
  RoomInfo
} from '../shared/types';
import type { CallSignalEvent, ScreenSource, StatusTone } from '../shared/bridge';
import { CallEngine, describeMediaError, type CallPeer } from './callEngine';
import { routeCallSignal } from '../shared/callRouting';
import { Button, Modal } from './ui';
import { initials } from './format';
import {
  FullscreenExitIcon,
  FullscreenIcon,
  MicIcon,
  MicOffIcon,
  MonitorIcon,
  PhoneIcon,
  PhoneOffIcon,
  ScreenShareIcon,
  VideoIcon,
  VideoOffIcon,
  XIcon
} from './icons';

import { api } from './api';
import { hasNativeFeatures } from './httpApi';
/**
 * How many signals may be held while a call is still being answered.
 *
 * An offer and the ICE candidates behind it, several times over, and no more:
 * the queue also collects signals arriving before there is any session to
 * match them against, so without a ceiling a ring left unanswered in the
 * corner of the screen would accumulate the other end's candidates for as long
 * as it kept sending them.
 */
const MAX_PENDING_SIGNALS = 256;

/** What the window knows about the call this device is in. */
export type CallSession = {
  callId: string;
  roomId: string;
  mode: CallMode;
  startedAt: number;
  peers: CallPeer[];
  local: CallDeviceState;
  /** This device's own video, or null before the camera has produced any. */
  preview: MediaStream | null;
  /** True until the microphone has actually opened. */
  connecting: boolean;
};

export type CallController = {
  session: CallSession | null;
  ringing: CallRinging | null;
  /** With `targetDeviceId`, rings that one member directly instead of the whole room. */
  start: (roomId: string, mode: CallMode, targetDeviceId?: string) => Promise<void>;
  join: (callId: string) => Promise<void>;
  answer: (ring: CallRinging) => Promise<void>;
  decline: (callId: string) => Promise<void>;
  leave: () => Promise<void>;
  toggleMic: () => void;
  toggleCamera: () => void;
  shareScreen: (sourceId: string) => Promise<void>;
  stopSharing: () => Promise<void>;
};

/**
 * Everything the window needs to be on a call.
 *
 * The engine below it owns the media; this owns the lifecycle — when a call
 * starts, what happens when a signal arrives before the microphone has opened,
 * and making sure that hanging up actually releases the camera rather than
 * leaving its light on.
 */
export function useCall({
  deviceId,
  startCallsMuted,
  push,
  active = true
}: {
  deviceId: string;
  startCallsMuted: boolean;
  push: (message: string, tone?: StatusTone) => void;
  /**
   * Whether this window is the one that owns the call — hears about rings,
   * negotiates, holds the microphone. Desktop's main window is not: the call
   * window is, and both hearing the same `call:ring` would mean two engines
   * reaching for the same camera. A phone has no second window to hand this
   * to, so it stays the default.
   */
  active?: boolean;
}): CallController {
  const [session, setSession] = React.useState<CallSession | null>(null);
  const [ringing, setRinging] = React.useState<CallRinging | null>(null);

  const engineRef = React.useRef<CallEngine | null>(null);
  /**
   * Whether the engine has its microphone. Signals must not reach it before
   * then: a connection built without a track would negotiate itself into a call
   * with nothing in it, and there would be no second chance to add one.
   */
  const readyRef = React.useRef(false);
  /**
   * Signals that arrived while it was not. Opening a microphone takes long
   * enough for the other end's offer to beat it, and a dropped offer is a call
   * that connects to silence.
   */
  const pendingRef = React.useRef<CallSignalEvent[]>([]);
  const sessionIdRef = React.useRef('');

  // Settings can change mid-call; handlers registered once still need the
  // current value.
  const startMutedRef = React.useRef(startCallsMuted);
  startMutedRef.current = startCallsMuted;
  const pushRef = React.useRef(push);
  pushRef.current = push;

  const teardown = React.useCallback(() => {
    engineRef.current?.stop();
    engineRef.current = null;
    readyRef.current = false;
    pendingRef.current = [];
    sessionIdRef.current = '';
    setSession(null);
  }, []);

  const begin = React.useCallback(
    async (callId: string, roomId: string, mode: CallMode) => {
      const engine = new CallEngine({
        send: (signal) => {
          void api.callSignal(signal);
        },
        onPeersChanged: (peers) => {
          setSession((current) => (current?.callId === callId ? { ...current, peers } : current));
        },
        onLocalPreview: (preview) => {
          setSession((current) => (current?.callId === callId ? { ...current, preview } : current));
        },
        onLocalStateChanged: (local) => {
          setSession((current) => (current?.callId === callId ? { ...current, local } : current));
        },
        onError: (message) => pushRef.current(message, 'error')
      });

      engineRef.current = engine;
      readyRef.current = false;
      // Deliberately not cleared: anything that arrived while this call was
      // being answered is queued here already, and is drained below once the
      // engine is ready. Emptying it now is what used to lose the offer.
      sessionIdRef.current = callId;
      setSession({
        callId,
        roomId,
        mode,
        startedAt: Date.now(),
        peers: [],
        local: { micOn: !startMutedRef.current, cameraOn: mode === 'video', sharing: false },
        preview: null,
        connecting: true
      });

      try {
        await engine.start({ callId, selfId: deviceId, mode, startMuted: startMutedRef.current });
      } catch (error) {
        pushRef.current(describeMediaError(error, 'microphone'), 'error');
        void api.callLeave();
        teardown();
        return;
      }

      // The call may have been hung up while the microphone was opening.
      if (sessionIdRef.current !== callId) {
        engine.stop();
        return;
      }

      setSession((current) => (current?.callId === callId ? { ...current, connecting: false } : current));

      readyRef.current = true;
      // Filtered by call, because the queue now also collects what arrives
      // before there is a session to compare against — including signals for a
      // ring that was declined, or for a call this one replaced.
      const queued = pendingRef.current.filter((event) => event.signal.callId === callId);
      pendingRef.current = [];
      for (const event of queued) {
        void engine.handleSignal(event);
      }
    },
    [deviceId, teardown]
  );

  // A ring that started before this window had finished loading — the call
  // window is opened the moment one arrives, so its own `onCallRing`
  // subscription below can easily lose the race with the event that caused it
  // to exist in the first place. Read once, rather than trusted to arrive.
  React.useEffect(() => {
    if (!active) {
      return;
    }
    void api.getState().then((current) => {
      if (current.incomingCall) {
        setRinging((existing) => existing ?? current.incomingCall ?? null);
      }
    });
  }, [active]);

  React.useEffect(() => {
    if (!active) {
      return;
    }
    const unsubscribers = [
      api.onCallRing((ring) => setRinging((current) => current ?? ring)),
      api.onCallRingCancelled((callId) => {
        setRinging((current) => (current?.callId === callId ? null : current));
      }),
      api.onCallSignal((event) => {
        const route = routeCallSignal({
          sessionId: sessionIdRef.current,
          signalCallId: event.signal.callId,
          ready: readyRef.current && Boolean(engineRef.current)
        });

        if (route === 'ignore') {
          return;
        }

        if (route === 'queue') {
          if (pendingRef.current.length < MAX_PENDING_SIGNALS) {
            pendingRef.current.push(event);
          }
          return;
        }

        void engineRef.current!.handleSignal(event);
      }),
      api.onCallEnded((callId) => {
        if (sessionIdRef.current === callId) {
          teardown();
        }
        setRinging((current) => (current?.callId === callId ? null : current));
      })
    ];

    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [active, teardown]);

  // A call must not outlive the window. Without this the camera light stays on.
  React.useEffect(() => {
    const release = () => {
      engineRef.current?.stop();
    };
    window.addEventListener('beforeunload', release);
    return () => window.removeEventListener('beforeunload', release);
  }, []);

  const start = React.useCallback(
    async (roomId: string, mode: CallMode, targetDeviceId?: string) => {
      const result = await api.callStart(roomId, mode, targetDeviceId);
      if (!result.ok || !result.callId) {
        pushRef.current(result.message, 'error');
        return;
      }
      await begin(result.callId, roomId, mode);
    },
    [begin]
  );

  const join = React.useCallback(
    async (callId: string) => {
      const result = await api.callJoin(callId);
      if (!result.ok || !result.callId || !result.roomId) {
        pushRef.current(result.message, 'error');
        return;
      }
      await begin(result.callId, result.roomId, result.mode ?? 'audio');
    },
    [begin]
  );

  const answer = React.useCallback(
    async (ring: CallRinging) => {
      setRinging(null);
      const result = await api.callJoin(ring.callId);
      if (!result.ok || !result.callId) {
        pushRef.current(result.message, 'error');
        return;
      }
      await begin(result.callId, result.roomId ?? ring.roomId, result.mode ?? ring.mode);
    },
    [begin]
  );

  const decline = React.useCallback(async (callId: string) => {
    setRinging((current) => (current?.callId === callId ? null : current));
    await api.callDecline(callId);
  }, []);

  const leave = React.useCallback(async () => {
    teardown();
    await api.callLeave();
  }, [teardown]);

  const toggleMic = React.useCallback(() => {
    const engine = engineRef.current;
    if (engine) {
      engine.setMicOn(!engine.getLocalState().micOn);
    }
  }, []);

  const toggleCamera = React.useCallback(() => {
    const engine = engineRef.current;
    if (engine) {
      void engine.setCameraOn(!engine.getLocalState().cameraOn);
    }
  }, []);

  const shareScreen = React.useCallback(async (sourceId: string) => {
    await engineRef.current?.startScreenShare(sourceId);
  }, []);

  const stopSharing = React.useCallback(async () => {
    await engineRef.current?.stopScreenShare();
  }, []);

  return {
    session,
    ringing,
    start,
    join,
    answer,
    decline,
    leave,
    toggleMic,
    toggleCamera,
    shareScreen,
    stopSharing
  };
}

/**
 * Real fullscreen, on one element.
 *
 * The Fullscreen API rather than an Electron window call, because the same
 * component is served to a phone browser where no such call exists — and on a
 * phone, filling the screen is most of what makes a video call usable at all.
 */
export function useFullscreen(ref: React.RefObject<HTMLElement | null>) {
  const [active, setActive] = React.useState(false);

  React.useEffect(() => {
    const sync = () => setActive(document.fullscreenElement === ref.current);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, [ref]);

  const toggle = React.useCallback(async () => {
    const element = ref.current;
    if (!element) {
      return;
    }

    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch {
        // Ignore errors
      }
    } else {
      try {
        // Request fullscreen with video playback support
        await element.requestFullscreen?.({ navigationUI: 'hide' });
      } catch {
        // iOS Safari has no element fullscreen; failing quietly leaves the call
        // working at its normal size rather than throwing at the user.
      }
    }
  }, [ref]);

  return { active, toggle };
}

// ------------------------------------------------------------------ ringtone

/**
 * The ring, synthesised rather than shipped.
 *
 * A two-note chirp on a repeating cycle, built from oscillators. It means no
 * audio file in the bundle and nothing to load before the first ring — which
 * matters, because a ringtone that arrives late has already failed.
 */
export function useRingtone(active: boolean): void {
  React.useEffect(() => {
    if (!active) {
      return;
    }

    let context: AudioContext | null = null;
    try {
      context = new AudioContext();
    } catch {
      return; // No audio device. The dialog is still on screen.
    }

    const audio = context;
    let cancelled = false;

    const chirp = () => {
      if (cancelled || audio.state === 'closed') {
        return;
      }

      const now = audio.currentTime;
      for (const [index, frequency] of [660, 520].entries()) {
        const oscillator = audio.createOscillator();
        const gain = audio.createGain();
        const at = now + index * 0.42;

        oscillator.type = 'sine';
        oscillator.frequency.value = frequency;
        // Shaped rather than switched: a square edge on a sine is a click.
        gain.gain.setValueAtTime(0, at);
        gain.gain.linearRampToValueAtTime(0.12, at + 0.03);
        gain.gain.linearRampToValueAtTime(0, at + 0.36);

        oscillator.connect(gain).connect(audio.destination);
        oscillator.start(at);
        oscillator.stop(at + 0.4);
      }
    };

    chirp();
    const timer = window.setInterval(chirp, 2600);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      void audio.close().catch(() => undefined);
    };
  }, [active]);
}

// ------------------------------------------------------------------- pieces

function useElapsed(startedAt: number): string {
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const total = Math.max(0, Math.floor((now - startedAt) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  const hours = Math.floor(minutes / 60);

  const body = `${String(minutes % 60).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return hours > 0 ? `${hours}:${body}` : body;
}

/**
 * A `<video>` pointed at a MediaStream. The stream is attached imperatively
 * because `srcObject` is not an attribute and React cannot set it.
 */
function StreamVideo({
  stream,
  muted,
  mirrored
}: {
  stream: MediaStream | null;
  muted: boolean;
  mirrored: boolean;
}) {
  const ref = React.useRef<HTMLVideoElement>(null);

  React.useEffect(() => {
    const element = ref.current;
    if (element && element.srcObject !== stream) {
      element.srcObject = stream;
    }
  }, [stream]);

  return (
    <video
      ref={ref}
      className={mirrored ? 'call-tile__video is-mirrored' : 'call-tile__video'}
      autoPlay
      playsInline
      // The local tile is always muted. Playing your own microphone back into
      // the room is how a call turns into a howl.
      muted={muted}
    />
  );
}

function CallTile({
  name,
  stream,
  live,
  self,
  micOn,
  sharing,
  status,
  focused,
  onSelect
}: {
  /** Puts this participant on the stage alone, or takes them off it again. */
  focused?: boolean;
  onSelect?: () => void;
  name: string;
  stream: MediaStream | null;
  /** Whether there is a moving picture to show, as opposed to a placeholder. */
  live: boolean;
  self: boolean;
  micOn: boolean;
  sharing: boolean;
  status?: string;
}) {
  return (
    <div
      className={[live ? 'call-tile is-live' : 'call-tile', focused ? 'is-focused' : '']
        .filter(Boolean)
        .join(' ')}
      onDoubleClick={onSelect}
      title={onSelect ? 'Double-click to focus' : undefined}
    >
      {/* Rendered even with the camera off: a peer's audio arrives on this
          element, so removing it would mute them. */}
      <StreamVideo stream={stream} muted={self} mirrored={self && !sharing} />

      {!live && (
        <div className="call-tile__placeholder">
          <span className="call-tile__avatar">{initials(name)}</span>
          {status ? <span className="call-tile__status">{status}</span> : null}
        </div>
      )}

      <div className="call-tile__label">
        <span className={micOn ? 'call-tile__mic' : 'call-tile__mic is-off'}>
          {micOn ? <MicIcon size={12} /> : <MicOffIcon size={12} />}
        </span>
        <span className="call-tile__name">{self ? `${name} (you)` : name}</span>
        {sharing ? (
          <span className="call-tile__badge">
            <MonitorIcon size={11} />
            Sharing
          </span>
        ) : null}
      </div>
    </div>
  );
}

function peerStatus(peer: CallPeer): string | undefined {
  if (peer.state === 'connecting') return 'Connecting…';
  if (peer.state === 'interrupted') return 'Connection interrupted';
  if (peer.state === 'failed') return 'Could not connect';
  return undefined;
}

// -------------------------------------------------------------- call stage

export function CallStage({
  session,
  room,
  deviceName,
  onToggleMic,
  onToggleCamera,
  onShare,
  onStopSharing,
  onLeave
}: {
  session: CallSession;
  room: RoomInfo | undefined;
  deviceName: string;
  onToggleMic: () => void;
  onToggleCamera: () => void;
  onShare: () => void;
  onStopSharing: () => void;
  onLeave: () => void;
}) {
  const elapsed = useElapsed(session.startedAt);
  const stageRef = React.useRef<HTMLDivElement>(null);
  const fullscreen = useFullscreen(stageRef);
  /**
   * Focus mode: one participant fills the stage and the rest become a strip.
   *
   * What a mesh grid is bad at is the commonest case — somebody is presenting,
   * or talking, and everyone else is a thumbnail. An equal grid gives a shared
   * screen the same space as five idle faces.
   */
  const [focused, setFocused] = React.useState<string>('');

  const { local, peers } = session;
  const count = peers.length + 1;

  // A focus on somebody who has left has to fall away by itself.
  React.useEffect(() => {
    if (focused && focused !== 'self' && !peers.some((peer) => peer.deviceId === focused)) {
      setFocused('');
    }
  }, [focused, peers]);

  // Whoever starts sharing a screen is almost certainly what everyone wants to
  // look at, so the stage follows them unless somebody has chosen otherwise.
  const sharing = peers.find((peer) => peer.sharing);
  const spotlight = focused || (sharing ? sharing.deviceId : '');

  return (
    <div className={spotlight ? 'call-stage is-focused' : 'call-stage'} ref={stageRef}>
      <header className="call-stage__header">
        <span className="call-stage__dot" aria-hidden="true" />
        <span className="call-stage__title">
          {session.mode === 'video' ? 'Video call' : 'Voice call'}
          {room ? ` · ${room.name}` : ''}
        </span>
        <span className="call-stage__meta">
          {count} {count === 1 ? 'device' : 'devices'} · {elapsed}
        </span>
        <span className="call-stage__spacer" />
        {room?.encrypted ? <span className="call-stage__meta">Encrypted end to end</span> : null}

        {spotlight ? (
          <button className="call-btn call-btn--slim" onClick={() => setFocused('')}>
            Show everyone
          </button>
        ) : null}
        <button
          className="call-btn call-btn--slim"
          onClick={fullscreen.toggle}
          title={fullscreen.active ? 'Leave full screen' : 'Full screen'}
        >
          {fullscreen.active ? <FullscreenExitIcon size={15} /> : <FullscreenIcon size={15} />}
        </button>
      </header>

      <div
        className={spotlight ? 'call-grid is-strip' : 'call-grid'}
        data-count={Math.min(count, 6)}
        data-spotlight={spotlight || undefined}
      >
        <CallTile
          onSelect={() => setFocused((current) => (current === 'self' ? '' : 'self'))}
          focused={spotlight === 'self'}
          name={deviceName}
          stream={session.preview}
          live={Boolean(session.preview && (local.cameraOn || local.sharing))}
          self
          micOn={local.micOn}
          sharing={local.sharing}
          status={session.connecting ? 'Starting…' : undefined}
        />

        {peers.map((peer) => (
          <CallTile
            key={peer.deviceId}
            onSelect={() =>
              setFocused((current) => (current === peer.deviceId ? '' : peer.deviceId))
            }
            focused={spotlight === peer.deviceId}
            name={peer.deviceName}
            stream={peer.stream}
            live={peer.state === 'connected' && (peer.cameraOn || peer.sharing)}
            self={false}
            micOn={peer.micOn}
            sharing={peer.sharing}
            status={peerStatus(peer)}
          />
        ))}

        {peers.length === 0 && !session.connecting ? (
          <div className="call-tile call-tile--waiting">
            <div className="call-tile__placeholder">
              <span className="call-tile__status">Waiting for someone to answer…</span>
            </div>
          </div>
        ) : null}
      </div>

      <div className="call-controls">
        <button
          className={local.micOn ? 'call-btn' : 'call-btn is-off'}
          onClick={onToggleMic}
          aria-pressed={!local.micOn}
          title={local.micOn ? 'Mute your microphone' : 'Unmute your microphone'}
        >
          {local.micOn ? <MicIcon size={17} /> : <MicOffIcon size={17} />}
          <span>{local.micOn ? 'Mute' : 'Unmute'}</span>
        </button>

        <button
          className={local.cameraOn ? 'call-btn' : 'call-btn is-off'}
          onClick={onToggleCamera}
          aria-pressed={!local.cameraOn}
          title={local.cameraOn ? 'Turn your camera off' : 'Turn your camera on'}
        >
          {local.cameraOn ? <VideoIcon size={17} /> : <VideoOffIcon size={17} />}
          <span>{local.cameraOn ? 'Camera' : 'Camera off'}</span>
        </button>

        <button
          className={local.sharing ? 'call-btn is-active' : 'call-btn'}
          onClick={local.sharing ? onStopSharing : onShare}
          aria-pressed={local.sharing}
          title={local.sharing ? 'Stop sharing your screen' : 'Share a screen or window'}
        >
          <ScreenShareIcon size={17} />
          <span>{local.sharing ? 'Stop sharing' : 'Share screen'}</span>
        </button>

        <button className="call-btn call-btn--leave" onClick={onLeave} title="Leave the call">
          <PhoneOffIcon size={17} />
          <span>Leave</span>
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ incoming call

export function IncomingCallModal({
  ring,
  ringtone,
  onAnswer,
  onDecline
}: {
  ring: CallRinging;
  /** Whether to ring out loud. The dialog appears either way. */
  ringtone: boolean;
  onAnswer: () => void;
  onDecline: () => void;
}) {
  useRingtone(ringtone);

  return (
    <Modal
      title={ring.mode === 'video' ? 'Incoming video call' : 'Incoming voice call'}
      description={
        ring.direct
          ? `${ring.fromDeviceName} is calling you directly.`
          : `${ring.fromDeviceName} is calling ${ring.roomName}.`
      }
      onClose={onDecline}
      footer={
        <>
          <Button variant="danger" onClick={onDecline}>
            <PhoneOffIcon size={15} />
            Decline
          </Button>
          <Button variant="primary" onClick={onAnswer}>
            {ring.mode === 'video' ? <VideoIcon size={15} /> : <PhoneIcon size={15} />}
            Answer
          </Button>
        </>
      }
    >
      <div className="incoming-call">
        <span className="incoming-call__avatar">{initials(ring.fromDeviceName)}</span>
        <div>
          <div className="incoming-call__name">{ring.fromDeviceName}</div>
          <div className="text-sm text-secondary">
            {ring.mode === 'video' ? 'Camera and microphone' : 'Microphone only'} · stays on this
            network
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------ screen picker

export function ScreenPickerModal({
  onPick,
  onClose
}: {
  onPick: (sourceId: string) => void;
  onClose: () => void;
}) {
  const [sources, setSources] = React.useState<ScreenSource[] | null>(null);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    let cancelled = false;

    api
      .callScreenSources()
      .then((list) => {
        if (!cancelled) {
          setSources(list);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(
            reason instanceof Error
              ? reason.message
              : 'The list of screens could not be read from this system.'
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const screens = sources?.filter((source) => source.kind === 'screen') ?? [];
  const windows = sources?.filter((source) => source.kind === 'window') ?? [];

  return (
    <Modal
      title="Share your screen"
      description="Everyone on the call sees this until you stop sharing."
      onClose={onClose}
      footer={
        <Button onClick={onClose}>
          <XIcon size={15} />
          Cancel
        </Button>
      }
    >
      {error ? <p className="field__error">{error}</p> : null}
      {!sources && !error ? <p className="text-secondary">Looking for screens…</p> : null}

      {screens.length > 0 && (
        <>
          <div className="picker__label">Screens</div>
          <div className="picker__grid">
            {screens.map((source) => (
              <SourceCard key={source.id} source={source} onPick={onPick} />
            ))}
          </div>
        </>
      )}

      {windows.length > 0 && (
        <>
          <div className="picker__label">Windows</div>
          <div className="picker__grid">
            {windows.map((source) => (
              <SourceCard key={source.id} source={source} onPick={onPick} />
            ))}
          </div>
        </>
      )}

      {sources?.length === 0 ? (
        <p className="text-secondary">
          Nothing is available to share. On macOS, this app needs screen recording permission in
          System Settings → Privacy &amp; Security.
        </p>
      ) : null}
    </Modal>
  );
}

function SourceCard({ source, onPick }: { source: ScreenSource; onPick: (id: string) => void }) {
  return (
    <button
      className="picker__item"
      onClick={() => onPick(source.id)}
      onDoubleClick={() => onPick(source.id)}
      title={source.name}
    >
      <img className="picker__thumb" src={source.thumbnail} alt="" />
      <span className="picker__name">{source.name}</span>
      <span className="picker__check">✓</span>
    </button>
  );
}

// ------------------------------------------------------- call-in-room banner

/** Offers a call already under way to someone who is not in it. */
export function CallInProgressBanner({
  call,
  onJoin
}: {
  call: ActiveCall;
  onJoin: () => void;
}) {
  const names = call.participants.map((participant) => participant.deviceName);
  const summary =
    names.length === 0
      ? 'A call is happening in this room'
      : names.length <= 2
        ? `${names.join(' and ')} ${names.length === 1 ? 'is' : 'are'} on a call`
        : `${names[0]}, ${names[1]} and ${names.length - 2} more are on a call`;

  return (
    <div className="call-banner">
      <span className="call-stage__dot" aria-hidden="true" />
      <span className="call-banner__text">{summary}</span>
      <Button size="sm" variant="primary" onClick={onJoin}>
        {call.mode === 'video' ? <VideoIcon size={14} /> : <PhoneIcon size={14} />}
        Join
      </Button>
    </div>
  );
}
