import React from 'react';
import type {
  RemoteCapabilities,
  RemoteGrant,
  RemoteRequest,
  RemoteSessionState
} from '../shared/types';
import type { ScreenSource, StatusTone } from '../shared/bridge';
import { RemoteEngine, createInputCapture, type RemoteConnectionState } from './remoteEngine';
import { Button, Modal } from './ui';
import { useFullscreen } from './callui';
import { initials } from './format';
import {
  AlertIcon,
  CheckIcon,
  EyeIcon,
  MaximiseIcon,
  MinimiseIcon,
  MonitorIcon,
  MousePointerIcon,
  ShieldIcon,
  XIcon
} from './icons';

import { api } from './api';
export type RemoteController = {
  session: RemoteSessionState | null;
  request: RemoteRequest | null;
  stream: MediaStream | null;
  connection: RemoteConnectionState;
  /** Controller only: whether input is actually getting through. */
  inputReady: boolean;
  ask: (roomId: string, targetDeviceId: string) => Promise<void>;
  respond: (allow: boolean, grant: RemoteGrant, screen: ScreenSource | null) => Promise<void>;
  dismissRequest: () => void;
  setGrant: (grant: RemoteGrant) => Promise<void>;
  end: () => Promise<void>;
  capture: ReturnType<typeof createInputCapture> | null;
};

/**
 * The lifecycle of a remote desktop session in the window.
 *
 * The engine below owns the connection; this owns when one exists. The ordering
 * that matters: the host starts capturing only *after* it has answered the
 * dialog, and the controller starts listening the moment it is granted, so the
 * host's offer never arrives before there is anything to receive it.
 */
export function useRemote({
  push
}: {
  push: (message: string, tone?: StatusTone) => void;
}): RemoteController {
  const [session, setSession] = React.useState<RemoteSessionState | null>(null);
  const [request, setRequest] = React.useState<RemoteRequest | null>(null);
  const [stream, setStream] = React.useState<MediaStream | null>(null);
  const [connection, setConnection] = React.useState<RemoteConnectionState>('connecting');
  const [inputReady, setInputReady] = React.useState(false);

  const engineRef = React.useRef<RemoteEngine | null>(null);
  const sessionIdRef = React.useRef('');
  const peerIdRef = React.useRef('');
  const pushRef = React.useRef(push);
  pushRef.current = push;

  const teardown = React.useCallback(() => {
    engineRef.current?.stop();
    engineRef.current = null;
    sessionIdRef.current = '';
    peerIdRef.current = '';
    setSession(null);
    setStream(null);
    setConnection('connecting');
    setInputReady(false);
  }, []);

  const buildEngine = React.useCallback(
    (state: RemoteSessionState) =>
      new RemoteEngine({
        send: (signal) => {
          void api.remoteSignal(signal);
        },
        onRemoteStream: setStream,
        onConnectionState: (next) => {
          setConnection(next);
          setInputReady(engineRef.current?.inputReady ?? false);
        },
        onInput: (event) => {
          /*
           * The host end. Handed straight to the main process, which is the only
           * thing entitled to decide whether it happens — this side deliberately
           * makes no judgement about it at all.
           */
          void api.remoteInput(state.sessionId, state.peerId, event);
        },
        onError: (message) => pushRef.current(message, 'error')
      }),
    []
  );

  React.useEffect(() => {
    const unsubscribers = [
      api.onRemoteRequest((incoming) => setRequest((current) => current ?? incoming)),
      api.onRemoteRequestExpired((sessionId) => {
        setRequest((current) => (current?.sessionId === sessionId ? null : current));
      }),

      api.onRemoteStarted((started) => {
        sessionIdRef.current = started.sessionId;
        peerIdRef.current = started.peerId;
        setSession(started);
        setConnection('connecting');

        // Only the controller sets up here. The host's engine is started by the
        // dialog, because it needs the screen the user picked.
        if (started.role === 'controller') {
          const engine = buildEngine(started);
          engineRef.current = engine;
          engine.startAsController(started.sessionId);
        }
      }),

      api.onRemoteSignal((event) => {
        if (sessionIdRef.current === event.signal.sessionId) {
          void engineRef.current?.handleSignal(event);
        }
      }),

      api.onRemoteGrantChanged((grant) => {
        setSession((current) => (current ? { ...current, grant } : current));
      }),

      api.onRemoteEnded(({ sessionId, reason }) => {
        if (sessionIdRef.current && sessionIdRef.current !== sessionId) {
          return;
        }
        teardown();
        if (reason) {
          pushRef.current(reason, 'info');
        }
      })
    ];

    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [buildEngine, teardown]);

  // A session must not outlive the window; the screen capture would keep running.
  React.useEffect(() => {
    const release = () => engineRef.current?.stop();
    window.addEventListener('beforeunload', release);
    return () => window.removeEventListener('beforeunload', release);
  }, []);

  // The data channel opens shortly after the connection does, and only then can
  // anything actually be typed.
  React.useEffect(() => {
    if (!session || session.role !== 'controller' || connection !== 'connected') {
      return;
    }

    const timer = window.setInterval(() => {
      setInputReady(engineRef.current?.inputReady ?? false);
    }, 400);
    return () => window.clearInterval(timer);
  }, [session, connection]);

  const capture = React.useMemo(() => {
    if (!session || session.role !== 'controller') {
      return null;
    }
    return createInputCapture((event) => engineRef.current?.sendInput(event));
  }, [session]);

  React.useEffect(() => () => capture?.dispose(), [capture]);

  const ask = React.useCallback(async (roomId: string, targetDeviceId: string) => {
    const result = await api.remoteRequest(roomId, targetDeviceId);
    pushRef.current(result.message, result.ok ? 'info' : 'error');
  }, []);

  const respond = React.useCallback(
    async (allow: boolean, grant: RemoteGrant, screen: ScreenSource | null) => {
      const pending = request;
      setRequest(null);
      if (!pending) {
        return;
      }

      const result = await api.remoteRespond(
        pending.sessionId,
        allow,
        grant,
        screen?.id ?? '',
        screen?.name ?? ''
      );
      pushRef.current(result.message, result.ok ? 'success' : 'error');

      if (!allow || !result.ok || !screen) {
        return;
      }

      /*
       * Capture starts here and nowhere else — after a person has answered the
       * dialog. There is deliberately no path from a message arriving on the
       * network to this line.
       */
      const state: RemoteSessionState = {
        sessionId: pending.sessionId,
        roomId: pending.roomId,
        role: 'host',
        peerId: pending.fromDeviceId,
        peerName: pending.fromDeviceName,
        grant,
        screenLabel: screen.name,
        startedAt: Date.now()
      };

      sessionIdRef.current = state.sessionId;
      peerIdRef.current = state.peerId;
      setSession(state);

      const engine = buildEngine(state);
      engineRef.current = engine;

      try {
        await engine.startAsHost(state.sessionId, screen.id);
      } catch (error) {
        pushRef.current(
          `That screen could not be captured: ${error instanceof Error ? error.message : String(error)}`,
          'error'
        );
        await api.remoteEnd();
        teardown();
      }
    },
    [request, buildEngine, teardown]
  );

  const dismissRequest = React.useCallback(() => {
    const pending = request;
    setRequest(null);
    if (pending) {
      void api.remoteRespond(pending.sessionId, false, 'view', '', '');
    }
  }, [request]);

  const setGrant = React.useCallback(async (grant: RemoteGrant) => {
    const result = await api.remoteSetGrant(grant);
    pushRef.current(result.message, result.ok ? 'success' : 'error');
  }, []);

  const end = React.useCallback(async () => {
    teardown();
    await api.remoteEnd();
  }, [teardown]);

  return {
    session,
    request,
    stream,
    connection,
    inputReady,
    ask,
    respond,
    dismissRequest,
    setGrant,
    end,
    capture
  };
}

// ------------------------------------------------------------- host approval

/**
 * The dialog that stands between someone asking and anything being shared.
 *
 * Written to be read under time pressure: who is asking, which room they are
 * asking through, and two clearly different answers. Viewing is offered first
 * and is the lighter of the two; control has to be chosen deliberately and says
 * plainly what it means.
 */
export function RemoteRequestModal({
  request,
  capabilities,
  onRespond,
  onDismiss
}: {
  request: RemoteRequest;
  capabilities: RemoteCapabilities;
  onRespond: (allow: boolean, grant: RemoteGrant, screen: ScreenSource | null) => void;
  onDismiss: () => void;
}) {
  const [screens, setScreens] = React.useState<ScreenSource[] | null>(null);
  const [chosen, setChosen] = React.useState<string>('');

  React.useEffect(() => {
    let cancelled = false;
    api.remoteScreens().then((list) => {
      if (cancelled) {
        return;
      }
      setScreens(list);
      setChosen((current) => current || (list[0]?.id ?? ''));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const screen = screens?.find((candidate) => candidate.id === chosen) ?? null;

  return (
    <Modal
      title="Screen access requested"
      description={`${request.fromDeviceName} is asking to see your screen through ${request.roomName}.`}
      onClose={onDismiss}
      footer={
        <>
          <Button variant="danger" onClick={() => onRespond(false, 'view', null)}>
            <XIcon size={15} />
            Decline
          </Button>
          <Button onClick={() => onRespond(true, 'view', screen)} disabled={!screen}>
            <EyeIcon size={15} />
            Allow viewing
          </Button>
          <Button
            variant="primary"
            onClick={() => onRespond(true, 'control', screen)}
            disabled={!screen || !capabilities.canControl}
            title={capabilities.canControl ? undefined : capabilities.reason}
          >
            <MousePointerIcon size={15} />
            Allow control
          </Button>
        </>
      }
    >
      <div className="incoming-call">
        <span className="incoming-call__avatar">{initials(request.fromDeviceName)}</span>
        <div>
          <div className="incoming-call__name">{request.fromDeviceName}</div>
          <div className="text-sm text-secondary">Nothing is shared until you choose below.</div>
        </div>
      </div>

      <div className="picker__label" style={{ marginTop: 'var(--space-5)' }}>
        Which screen
      </div>

      {!screens ? (
        <p className="text-secondary">Looking for screens…</p>
      ) : screens.length === 0 ? (
        <p className="text-secondary">
          No screen is available to share. On macOS, this app needs screen recording permission in
          System Settings → Privacy &amp; Security.
        </p>
      ) : (
        <div className="picker__grid">
          {screens.map((source) => (
            <button
              key={source.id}
              className={source.id === chosen ? 'picker__item is-selected' : 'picker__item'}
              onClick={() => setChosen(source.id)}
            >
              <img className="picker__thumb" src={source.thumbnail} alt="" />
              <span className="picker__name">
                {source.id === chosen ? <CheckIcon size={12} /> : null}
                {source.name}
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="callout callout--warning" style={{ marginTop: 'var(--space-5)' }}>
        <span className="callout__icon">
          <AlertIcon size={17} />
        </span>
        <div className="callout__body">
          <div className="callout__title">What each answer means</div>
          <div className="callout__text">
            <strong>Viewing</strong> lets them watch the screen you pick. <strong>Control</strong>{' '}
            also lets them move your mouse and type on your keyboard, which means anything you can
            do on this machine, they can do. You can take control back, or end it entirely, at any
            moment — and <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>X</kbd> ends it even
            if you cannot reach this window.
            {capabilities.canControl ? null : ` Control is unavailable: ${capabilities.reason}`}
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------- host indicator

/** Always on screen while this machine is being shared. Never dismissible. */
export function RemoteHostBar({
  session,
  onSetGrant,
  onEnd
}: {
  session: RemoteSessionState;
  onSetGrant: (grant: RemoteGrant) => void;
  onEnd: () => void;
}) {
  const controlling = session.grant === 'control';

  return (
    <div className={controlling ? 'remote-bar is-control' : 'remote-bar'}>
      <span className="call-stage__dot" aria-hidden="true" />
      <span className="remote-bar__text">
        <strong>{session.peerName}</strong> {controlling ? 'is controlling' : 'is watching'}{' '}
        {session.screenLabel}
      </span>

      {controlling ? (
        <Button size="sm" onClick={() => onSetGrant('view')}>
          <EyeIcon size={14} />
          Take back control
        </Button>
      ) : (
        <Button size="sm" onClick={() => onSetGrant('control')}>
          <MousePointerIcon size={14} />
          Give control
        </Button>
      )}

      <Button size="sm" variant="danger" onClick={onEnd}>
        <XIcon size={14} />
        Stop sharing
      </Button>
    </div>
  );
}

// ------------------------------------------------------------------- viewer

/**
 * The controller's window onto the other machine.
 *
 * Input is only wired up when control has been granted, so a view-only session
 * cannot send anything even by accident. Keyboard events are captured on the
 * surface itself and stopped from reaching the rest of the app — otherwise
 * typing into the remote machine would also be triggering this app's own
 * shortcuts.
 */
export function RemoteViewer({
  session,
  stream,
  connection,
  inputReady,
  capture,
  onEnd
}: {
  session: RemoteSessionState;
  stream: MediaStream | null;
  connection: RemoteConnectionState;
  inputReady: boolean;
  capture: ReturnType<typeof createInputCapture> | null;
  onEnd: () => void;
}) {
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const stageRef = React.useRef<HTMLDivElement>(null);
  const fullscreen = useFullscreen(stageRef);
  const [actualSize, setActualSize] = React.useState(false);
  const controlling = session.grant === 'control';
  const live = controlling && inputReady;

  React.useEffect(() => {
    const element = videoRef.current;
    if (element && element.srcObject !== stream) {
      element.srcObject = stream;
    }
  }, [stream]);

  /*
   * Keyboard capture lives on the window rather than on the element, because
   * the moment a click is forwarded to the remote machine this surface may not
   * hold focus in any meaningful sense. It is only attached while control is
   * actually live, so nothing is swallowed the rest of the time.
   */
  React.useEffect(() => {
    if (!live || !capture) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      // The one combination that must keep working here: it is how the person
      // driving gets out.
      if (event.key === 'Escape') {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      capture.key(event, true);
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      capture.key(event, false);
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
    };
  }, [live, capture]);

  function pointer(handler: (event: React.MouseEvent) => void) {
    return (event: React.MouseEvent) => {
      if (!live || !videoRef.current) {
        return;
      }
      event.preventDefault();
      handler(event);
    };
  }

  return (
    <div className="remote-stage" ref={stageRef}>
      <header className="call-stage__header">
        <MonitorIcon size={15} />
        <span className="call-stage__title">{session.peerName}</span>
        <span className="call-stage__meta">
          {session.screenLabel}
          {connection === 'connected' ? '' : ' · connecting…'}
        </span>
        <span className="call-stage__spacer" />

        <span className={controlling ? 'remote-chip is-control' : 'remote-chip'}>
          {controlling ? <MousePointerIcon size={12} /> : <EyeIcon size={12} />}
          {controlling ? (live ? 'Control' : 'Control — connecting') : 'View only'}
        </span>

        <button className="call-btn call-btn--slim" onClick={() => setActualSize((current) => !current)}>
          {actualSize ? 'Fit to window' : 'Actual size'}
        </button>
        {/* Full screen matters more here than anywhere: you are working on
            somebody else's desktop through a window inside your own. */}
        <button
          className="call-btn call-btn--slim"
          onClick={fullscreen.toggle}
          title={fullscreen.active ? 'Leave full screen' : 'Full screen'}
        >
          {fullscreen.active ? <MinimiseIcon size={15} /> : <MaximiseIcon size={15} />}
        </button>
        <button className="call-btn call-btn--slim call-btn--leave" onClick={onEnd}>
          <XIcon size={14} />
          Disconnect
        </button>
      </header>

      <div className={actualSize ? 'remote-surface is-actual' : 'remote-surface'}>
        <video
          ref={videoRef}
          className={live ? 'remote-video is-live' : 'remote-video'}
          autoPlay
          playsInline
          muted
          onMouseMove={pointer((event) => capture?.move(event.nativeEvent, videoRef.current!))}
          onMouseDown={pointer((event) => capture?.button(event.nativeEvent, videoRef.current!, true))}
          onMouseUp={pointer((event) => capture?.button(event.nativeEvent, videoRef.current!, false))}
          onContextMenu={(event) => event.preventDefault()}
          onWheel={(event) => {
            if (live) {
              capture?.scroll(event.nativeEvent);
            }
          }}
        />

        {!stream ? (
          <div className="remote-surface__note">
            <span className="call-tile__status">Waiting for the screen…</span>
          </div>
        ) : null}
      </div>

      {!controlling ? (
        <div className="remote-hint">
          <ShieldIcon size={14} />
          You are watching only. {session.peerName} has to hand over control before you can click or
          type.
        </div>
      ) : null}
    </div>
  );
}
