import React from 'react';
import type {
  RemoteCapabilities,
  RemoteGrant,
  RemoteRequest,
  RemoteSessionState
} from '../shared/types';
import type { RemoteSignalEvent, ScreenSource, StatusTone } from '../shared/bridge';
import { MAX_PENDING_SIGNALS, routeSessionSignal } from '../shared/signalRouting';
import { RemoteEngine, createInputCapture, type RemoteConnectionState } from './remoteEngine';
import { Button, Modal } from './ui';
import { useFullscreen } from './callui';
import { initials } from './format';
import {
  AlertIcon,
  CheckIcon,
  EyeIcon,
  FullscreenExitIcon,
  FullscreenIcon,
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
  push,
  allow = 'all'
}: {
  push: (message: string, tone?: StatusTone) => void;
  /**
   * Which side of a session this window cares about. The host bar and the
   * controller's viewer now live in separate windows — each running its own
   * `RemoteEngine` — so without this both would react to the same
   * `remote:started` event and build a second, unwanted engine for whichever
   * role is not theirs to own. `'all'` is the single-window behaviour this
   * used to have unconditionally.
   */
  allow?: 'host' | 'controller' | 'all';
}): RemoteController {
  const [session, setSession] = React.useState<RemoteSessionState | null>(null);
  const [request, setRequest] = React.useState<RemoteRequest | null>(null);
  const [stream, setStream] = React.useState<MediaStream | null>(null);
  const [connection, setConnection] = React.useState<RemoteConnectionState>('connecting');
  const [inputReady, setInputReady] = React.useState(false);

  const engineRef = React.useRef<RemoteEngine | null>(null);
  const sessionIdRef = React.useRef('');
  const peerIdRef = React.useRef('');
  /**
   * Signals that arrived before there was an engine to take them. Capturing a
   * screen takes long enough for the controller's offer to beat it, and a
   * dropped offer is a session that connects to a black rectangle.
   */
  const pendingRef = React.useRef<RemoteSignalEvent[]>([]);
  /**
   * Whether the engine can actually answer. Distinct from the engine merely
   * existing: the host builds its engine and only then captures a screen, and a
   * signal answered in between negotiates a session with no tracks in it — a
   * connection that reports itself as up and shows a black rectangle forever.
   */
  const readyRef = React.useRef(false);
  const pushRef = React.useRef(push);
  pushRef.current = push;

  const teardown = React.useCallback(() => {
    engineRef.current?.stop();
    engineRef.current = null;
    sessionIdRef.current = '';
    peerIdRef.current = '';
    pendingRef.current = [];
    readyRef.current = false;
    setSession(null);
    setStream(null);
    setConnection('connecting');
    setInputReady(false);
  }, []);

  // Kept in a ref so the engine, which is built once, can always reach the
  // current teardown without being rebuilt.
  const teardownRef = React.useRef(teardown);
  teardownRef.current = teardown;

  /**
   * Hands the engine whatever arrived before it existed.
   *
   * Filtered by session, because the queue also collects what turns up before
   * there is a session id to compare against — a request that was declined, or
   * one this session replaced, should not have its candidates replayed into an
   * unrelated connection.
   */
  const drainPending = React.useCallback((sessionId: string, engine: RemoteEngine) => {
    const queued = pendingRef.current.filter((event) => event.signal.sessionId === sessionId);
    pendingRef.current = [];
    for (const event of queued) {
      void engine.handleSignal(event);
    }
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
          if (next === 'failed') {
            /*
             * Unlike 'interrupted', a failed connection never recovers on
             * its own — and until now, nothing acted on that. The engine
             * kept running (screen capture, the input injector, the host
             * indicator), and `remoteSessions.current` on the main process
             * stayed non-null indefinitely, since nothing ever told it the
             * session was over. `RemoteSessionManager.busy` staying true
             * then refused every future remote-desktop request on this
             * device, in either role, until a human happened to notice and
             * manually disconnect. `onError` already told them why; this is
             * what actually ends it.
             */
            void api.remoteEnd();
            teardownRef.current();
          }
        },
        onInput: (event) => {
          /*
           * The host end. Handed straight to the main process, which is the only
           * thing entitled to decide whether it happens — this side deliberately
           * makes no judgement about it at all.
           */
          void api.remoteInput(state.sessionId, state.peerId, event);
        },
        onScreenLost: () => {
          // Nothing left to share, so nothing left to keep open. Ended rather
          // than reported, or the far side keeps a frozen picture of a screen
          // that is gone and this side keeps claiming to be sharing it.
          pushRef.current('The shared screen is no longer available, so the session ended.', 'warning');
          void api.remoteEnd();
          teardownRef.current();
        },
        onError: (message) => pushRef.current(message, 'error')
      }),
    []
  );

  /**
   * Builds the controller's engine, unless one already exists for this
   * session. The push event and the mount-time state fetch below can both
   * decide to do this for the same session — the guard is what keeps that
   * from building two engines and two microphones' worth of nothing, since a
   * remote session is video and input only, but two peer connections all the
   * same.
   */
  const startControllerSession = React.useCallback(
    (started: RemoteSessionState) => {
      if (sessionIdRef.current === started.sessionId && engineRef.current) {
        return;
      }
      sessionIdRef.current = started.sessionId;
      peerIdRef.current = started.peerId;
      setSession(started);
      setConnection('connecting');
      const engine = buildEngine(started);
      engineRef.current = engine;
      readyRef.current = false;
      engine.startAsController(started.sessionId);
      readyRef.current = true;
      drainPending(started.sessionId, engine);
    },
    [buildEngine, drainPending]
  );

  React.useEffect(() => {
    const unsubscribers = [
      ...(allow !== 'controller'
        ? [
            api.onRemoteRequest((incoming) => setRequest((current) => current ?? incoming)),
            api.onRemoteRequestExpired((sessionId) => {
              setRequest((current) => (current?.sessionId === sessionId ? null : current));
            })
          ]
        : []),

      api.onRemoteStarted((started) => {
        // Not this window's role to carry — the paired window (host bar or
        // viewer) owns it instead.
        if (allow !== 'all' && started.role !== allow) {
          return;
        }

        if (started.role === 'controller') {
          startControllerSession(started);
          return;
        }

        // The host's own engine is started by the request dialog, because it
        // needs the screen the user picked there — this only tracks state.
        sessionIdRef.current = started.sessionId;
        peerIdRef.current = started.peerId;
        setSession(started);
        setConnection('connecting');
      }),

      api.onRemoteSignal((event) => {
        const route = routeSessionSignal({
          sessionId: sessionIdRef.current,
          signalSessionId: event.signal.sessionId,
          ready: readyRef.current && Boolean(engineRef.current)
        });

        if (route === 'ignore') {
          return;
        }

        /*
         * Held rather than dropped on the floor. Accepting a request answers
         * the controller over IPC, and the controller replies with its offer
         * immediately — while this side is still inside that await, and then
         * inside capturing a screen, with no engine built yet. The old
         * `engineRef.current?.` swallowed exactly that, silently, every time it
         * happened: no error, no connection, a viewer that never painted.
         */
        if (route === 'queue') {
          if (pendingRef.current.length < MAX_PENDING_SIGNALS) {
            pendingRef.current.push(event);
          }
          return;
        }

        void engineRef.current!.handleSignal(event);
      }),

      api.onRemoteGrantChanged((grant) => {
        setSession((current) => (current ? { ...current, grant } : current));
      }),

      api.onRemoteEnded(({ sessionId, reason }) => {
        if (sessionIdRef.current !== sessionId) {
          return; // Not a session this window was ever tracking.
        }
        teardown();
        if (reason) {
          pushRef.current(reason, 'info');
        }
      })
    ];

    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [allow, buildEngine, teardown, startControllerSession]);

  // A session must not outlive the window; the screen capture would keep running.
  React.useEffect(() => {
    const release = () => engineRef.current?.stop();
    window.addEventListener('beforeunload', release);
    return () => window.removeEventListener('beforeunload', release);
  }, []);

  /*
   * What the main process already knows, read once at mount rather than
   * watched through state — watching would race a session this window is
   * itself in the middle of setting up.
   *
   * Two things can be true here. A controller session that started before
   * this window had finished loading is the normal case now that the window
   * opens on demand rather than always being present — `startControllerSession`
   * is idempotent, so if the push event also arrives, only the first of the
   * two actually does anything. A *host* session with nothing engineering it
   * is the original, narrower case this effect was written for: only possible
   * when the main window was reloaded mid-session, and it cannot be resumed —
   * the peer connection and the captured stream went with the old window.
   */
  React.useEffect(() => {
    void api.getState().then((current) => {
      const remote = current.remote;
      if (!remote || (allow !== 'all' && remote.role !== allow)) {
        return;
      }

      if (remote.role === 'controller') {
        startControllerSession(remote);
        return;
      }

      if (!engineRef.current) {
        pushRef.current('A remote session was left running and has been ended.', 'warning');
        void api.remoteEnd();
      }
    });
  }, [allow, startControllerSession]);

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
        screen?.name ?? '',
        screen?.displayId
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
      readyRef.current = false;

      try {
        await engine.startAsHost(state.sessionId, screen.id);
        readyRef.current = true;
        // Only once the screen is actually captured: the controller's offer is
        // answered with these tracks, and answering before they exist
        // negotiates a session that carries no picture.
        drainPending(state.sessionId, engine);
      } catch (error) {
        pushRef.current(
          `That screen could not be captured: ${error instanceof Error ? error.message : String(error)}`,
          'error'
        );
        await api.remoteEnd();
        teardown();
      }
    },
    [request, buildEngine, teardown, drainPending]
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

  const handleRespond = (allow: boolean, grant: RemoteGrant) => {
    if (!allow) {
      onRespond(false, 'view', null);
      return;
    }
    if (!screen) {
      // If no screen selected but screens available, pick the first one
      if (screens && screens.length > 0) {
        onRespond(true, grant, screens[0]);
      }
      return;
    }
    onRespond(true, grant, screen);
  };

  return (
    <Modal
      title="Screen access requested"
      description={`${request.fromDeviceName} is asking to see your screen through ${request.roomName}.`}
      onClose={onDismiss}
      footer={
        <>
          <Button variant="danger" onClick={() => handleRespond(false, 'view')}>
            <XIcon size={15} />
            Decline
          </Button>
          <Button onClick={() => handleRespond(true, 'view')} disabled={!screen && !screens?.length}>
            <EyeIcon size={15} />
            Allow viewing
          </Button>
          <Button
            variant="primary"
            onClick={() => handleRespond(true, 'control')}
            disabled={!screen && !screens?.length || !capabilities.canControl}
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
      
      <div className="remote-bar__shortcut">
        <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>X</kbd> to stop
      </div>
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

  // Handle playsInline attribute for better fullscreen video handling
  React.useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (fullscreen.active) {
      video.removeAttribute('playsInline');
    } else {
      video.setAttribute('playsInline', '');
    }
  }, [fullscreen.active]);

  /*
   * Full screen implies actual size, and leaving it goes back to fitting.
   *
   * Deliberately keyed on the fullscreen transition alone. With `actualSize` in
   * the dependencies too, this ran again the instant the button changed it and
   * put it straight back — so outside full screen the Actual size button did
   * nothing at all.
   */
  React.useEffect(() => {
    setActualSize(fullscreen.active);
  }, [fullscreen.active]);

  /*
   * What the auto-hide-header effect below calls to bring the header back.
   * Read by the keyboard-capture effect too — see its own comment for why a
   * ref is what bridges them, rather than the stage's own `keydown` listener.
   */
  const revealHeaderRef = React.useRef<() => void>(() => {});

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
      // The panic shortcut (Ctrl+Alt+Shift+X) is handled globally in main process
      // Allow Escape to exit fullscreen when in fullscreen mode
      if (event.key === 'Escape' && document.fullscreenElement) {
        return;
      }
      // Called directly rather than left to the stage's own `keydown`
      // listener below: this handler runs in the capture phase and calls
      // `stopPropagation()` on every key it forwards, which stops that
      // bubble-phase listener from ever seeing the event at all. Without
      // this, the header could only be brought back by moving the mouse —
      // someone controlling the remote machine purely by typing had no way
      // to reach Disconnect once the header auto-hid.
      revealHeaderRef.current();
      event.preventDefault();
      event.stopPropagation();
      capture.key(event, true);
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && document.fullscreenElement) {
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

  // Handle focus to ensure keyboard capture works
  React.useEffect(() => {
    if (!live || !capture) return;
    
    const video = videoRef.current;
    if (!video) return;
    
    const onFocus = () => {
      // Re-focus the video element to ensure keyboard events are captured
      video.focus();
    };
    
    video.addEventListener('focus', onFocus);
    video.focus(); // Initial focus
    
    return () => {
      video.removeEventListener('focus', onFocus);
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

  /*
   * Mouse-up is watched on the window, not on the picture.
   *
   * Dragging on the far machine — a window by its title bar, a selection, a
   * scrollbar — routinely ends with the pointer outside this element, and the
   * element's own mouseup never fires. The host is then holding a button down
   * that nothing will ever release, which it experiences as a stuck mouse.
   */
  const dragging = React.useRef(false);
  React.useEffect(() => {
    if (!live || !capture) {
      dragging.current = false;
      return;
    }

    const onUp = (event: MouseEvent) => {
      if (!dragging.current || !videoRef.current) {
        return;
      }
      dragging.current = false;
      capture.button(event, videoRef.current, false);
    };

    window.addEventListener('mouseup', onUp);
    return () => window.removeEventListener('mouseup', onUp);
  }, [live, capture]);

  // Auto-hide header in fullscreen after a delay
  const [showHeader, setShowHeader] = React.useState(true);
  React.useEffect(() => {
    if (!fullscreen.active) {
      setShowHeader(true);
      revealHeaderRef.current = () => {};
      return;
    }

    let hideTimer: ReturnType<typeof setTimeout>;
    const show = () => {
      setShowHeader(true);
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => setShowHeader(false), 3000);
    };

    show();
    revealHeaderRef.current = show;
    const stage = stageRef.current;
    if (stage) {
      stage.addEventListener('mousemove', show);
      stage.addEventListener('keydown', show);
    }
    return () => {
      if (stage) {
        stage.removeEventListener('mousemove', show);
        stage.removeEventListener('keydown', show);
      }
      clearTimeout(hideTimer);
      revealHeaderRef.current = () => {};
    };
  }, [fullscreen.active]);

  return (
    <div className="remote-stage" ref={stageRef}>
      {showHeader && (
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

          <button 
            className="call-btn call-btn--slim" 
            onClick={() => setActualSize((current) => !current)}
            title={actualSize ? 'Fit to window (Esc to exit fullscreen)' : 'Actual size (1:1 pixel mapping)'}
          >
            {actualSize ? 'Fit to window' : 'Actual size'}
          </button>
          {/* Full screen matters more here than anywhere: you are working on
              somebody else's desktop through a window inside your own. */}
          <button
            className="call-btn call-btn--slim"
            onClick={fullscreen.toggle}
            title={fullscreen.active ? 'Leave full screen (Esc)' : 'Full screen (F)'}
          >
            {fullscreen.active ? <FullscreenExitIcon size={15} /> : <FullscreenIcon size={15} />}
          </button>
          <button className="call-btn call-btn--slim call-btn--leave" onClick={onEnd}>
            <XIcon size={14} />
            Disconnect
          </button>
        </header>
      )}

      <div className={actualSize ? 'remote-surface is-actual' : 'remote-surface'}>
        <video
          ref={videoRef}
          className={live ? 'remote-video is-live' : 'remote-video'}
          autoPlay
          playsInline
          muted
          tabIndex={0}
          onMouseMove={pointer((event) => capture?.move(event.nativeEvent, videoRef.current!))}
          onMouseDown={pointer((event) => {
            dragging.current = true;
            capture?.button(event.nativeEvent, videoRef.current!, true);
          })}
          // Release is handled on the window, so a drag that ends off the
          // picture still lets go of the button on the far machine.
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
