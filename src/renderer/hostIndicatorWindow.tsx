import React from 'react';
import type { RemoteSessionState } from '../shared/types';
import { Button } from './ui';
import { MinimiseIcon, XIcon } from './icons';
import { api } from './api';

/**
 * The floating reminder that this machine is being driven, for whenever
 * `RemoteHostBar` is not on screen to say so — the main window minimised, or
 * switched away from. Opened and closed by the main process (`hostIndicator.ts`)
 * around a hosted session's lifetime; this component only has to render what
 * that session looks like, the same as `RemoteWindowRoot` does for the
 * controller's side.
 *
 * Stopping the share here calls the same `remoteEnd` every other "Stop
 * sharing" button calls — there is nothing indicator-specific about ending a
 * session, just a second place to reach the one path that does it.
 *
 * The window itself has no minimise button of its own — it is frameless and
 * `skipTaskbar`, on purpose, so it never claims a taskbar slot for something
 * this small. "Hide" is a second thing entirely: it tucks this always-on-top
 * copy of the reminder away without touching the session, safe to do because
 * `RemoteHostBar` inside the main window shows the exact same state and the
 * exact same Stop button — nothing is lost, only one more surface for it.
 */
export function HostIndicatorWindow() {
  const [session, setSession] = React.useState<RemoteSessionState | null>(null);

  React.useEffect(() => {
    api.getState().then((state) => {
      if (state.remote?.role === 'host') {
        setSession(state.remote);
      }
    });

    const unsubscribers = [
      api.onRemoteStarted((started) => {
        if (started.role === 'host') {
          setSession(started);
        }
      }),
      // The host can hand control over or take it back without ending the
      // session — the wording below has to follow, or it goes stale the first
      // time `RemoteHostBar`'s own "Give control"/"Take back control" button
      // is used while this window happens to be the one on screen.
      api.onRemoteGrantChanged((grant) => {
        setSession((current) => (current ? { ...current, grant } : current));
      }),
      api.onRemoteEnded(() => setSession(null))
    ];

    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, []);

  // The window itself is shown and hidden by the main process around the
  // session's lifetime; this only guards the instant between the window
  // appearing and the first bit of session state arriving.
  if (!session) {
    return null;
  }

  // "Controlled" is only true once the peer can move the mouse — view-only
  // access is watching, not driving, and RemoteHostBar already makes the same
  // distinction; this second surface saying something stronger than the first
  // would be its own small lie.
  const controlling = session.grant === 'control';

  return (
    <div className={controlling ? 'host-indicator is-control' : 'host-indicator'}>
      <span className="host-indicator__dot" aria-hidden="true" />
      <span className="host-indicator__text">
        <strong>{session.peerName}</strong> {controlling ? 'is controlling' : 'is watching'}
      </span>
      <Button
        size="sm"
        variant="ghost"
        icon
        onClick={() => void api.remoteHideIndicator()}
        aria-label="Hide this reminder"
        title="Hide — the session keeps running; check the main window to stop it later"
      >
        <MinimiseIcon size={13} />
      </Button>
      <Button size="sm" variant="danger" onClick={() => void api.remoteEnd()}>
        <XIcon size={13} />
        Stop sharing
      </Button>
    </div>
  );
}
