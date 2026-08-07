import React from 'react';
import type { AppState } from '../shared/types';
import { CallStage, IncomingCallModal, ScreenPickerModal, useCall } from './callui';
import { Toasts, useToasts } from './ui';
import { WindowControls, useWindowState } from './windowcontrols';
import { api } from './api';

/**
 * The call, in a window of its own.
 *
 * Opened by the main process the moment a call rings or is placed — see
 * `openCallWindow` in `main.ts` — and closed by whoever is looking at it, the
 * same as hanging up in TeamViewer or AnyDesk's own call window. Minimising or
 * maximising this window is never wired to anything call-related, which is
 * the other half of that: the call lives in the engine `useCall` owns, not in
 * whether this window happens to be the one on screen.
 */
export function CallWindowRoot() {
  const [state, setState] = React.useState<AppState | null>(null);
  const [screenPicker, setScreenPicker] = React.useState(false);
  const { toasts, push, dismiss } = useToasts();
  const windowState = useWindowState();

  React.useEffect(() => {
    api.getState().then(setState);
    return api.onStateChanged(setState);
  }, []);

  const platform = windowState?.platform;
  const topInset = windowState?.topInset ?? 0;
  React.useEffect(() => {
    if (platform) {
      document.documentElement.dataset.platform = platform;
    }
    document.documentElement.style.setProperty('--window-top-inset', `${topInset}px`);
  }, [platform, topInset]);

  const theme = state?.settings.theme ?? 'system';
  React.useEffect(() => {
    if (theme === 'system') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', theme);
    }
  }, [theme]);

  const call = useCall({
    deviceId: state?.deviceId ?? '',
    startCallsMuted: state?.settings.startCallsMuted ?? false,
    push
  });

  // Read inside the intent's async callback below, so it sees whatever is
  // true when the answer actually arrives rather than whatever was true when
  // the request went out — `call` is a fresh object every render, and the
  // callback would otherwise close over a `session` already stale by then.
  const sessionRef = React.useRef(call.session);
  sessionRef.current = call.session;

  /*
   * What this window was opened to do — place a call, or join one — pulled
   * once state (and with it a real device id) is ready. A ring needs none of
   * this: it is already on screen the moment `useCall` hears about it, via
   * either the event or the state it read at mount.
   */
  const intentTaken = React.useRef(false);
  React.useEffect(() => {
    if (!state || intentTaken.current) {
      return;
    }
    intentTaken.current = true;

    void api.callWindowTakeIntent().then((intent) => {
      if (!intent || sessionRef.current) {
        return; // Already under way — a stray intent from before it was.
      }
      if (intent.kind === 'start') {
        void call.start(intent.roomId, intent.mode, intent.targetDeviceId);
      } else {
        void call.join(intent.callId);
      }
    });
  }, [state, call]);

  const callRoom = call.session ? state?.rooms.find((room) => room.roomId === call.session!.roomId) : undefined;

  return (
    <div className="session-window">
      <div className="splash__bar">
        <WindowControls state={windowState} closeLabel="End call" />
      </div>

      <div className="session-window__body">
        {call.session ? (
          <CallStage
            session={call.session}
            room={callRoom}
            deviceName={state?.deviceName ?? ''}
            onToggleMic={call.toggleMic}
            onToggleCamera={call.toggleCamera}
            onShare={() => setScreenPicker(true)}
            onStopSharing={() => call.stopSharing()}
            onLeave={() => call.leave()}
          />
        ) : (
          <div className="session-window__waiting">
            <span className="splash__dot" />
            <span>{call.ringing ? 'Incoming call…' : 'Connecting…'}</span>
          </div>
        )}
      </div>

      {call.ringing && (
        <IncomingCallModal
          ring={call.ringing}
          ringtone={state?.settings.ringOnCalls ?? true}
          onAnswer={() => call.answer(call.ringing!)}
          onDecline={() => call.decline(call.ringing!.callId)}
        />
      )}

      {screenPicker && (
        <ScreenPickerModal
          onClose={() => setScreenPicker(false)}
          onPick={(sourceId) => {
            setScreenPicker(false);
            void call.shareScreen(sourceId);
          }}
        />
      )}

      <Toasts toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
