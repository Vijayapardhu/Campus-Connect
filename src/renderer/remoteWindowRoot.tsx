import React from 'react';
import type { AppState } from '../shared/types';
import { RemoteViewer, useRemote } from './remoteui';
import { Toasts, useToasts } from './ui';
import { WindowControls, useWindowState } from './windowcontrols';
import { api } from './api';

/**
 * The controller's window onto somebody else's screen.
 *
 * Opened by the main process the moment a request is granted — see the
 * `'grant'` case in `handleRemote`, `main.ts` — and closed by whoever is
 * looking at it, the same as closing the session window in TeamViewer or
 * AnyDesk. The host's side of a session stays in the main window instead
 * (`RemoteHostBar`): there is nothing to view locally beyond the status bar it
 * already shows, so it does not need a window of its own.
 */
export function RemoteWindowRoot() {
  const [state, setState] = React.useState<AppState | null>(null);
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

  const remote = useRemote({ push, allow: 'controller' });

  return (
    <div className="session-window">
      <div className="splash__bar">
        <WindowControls state={windowState} closeLabel="Disconnect" />
      </div>

      <div className="session-window__body">
        {remote.session?.role === 'controller' ? (
          <RemoteViewer
            session={remote.session}
            stream={remote.stream}
            connection={remote.connection}
            inputReady={remote.inputReady}
            capture={remote.capture}
            onEnd={() => remote.end()}
          />
        ) : (
          <div className="session-window__waiting">
            <span className="splash__dot" />
            <span>Connecting…</span>
          </div>
        )}
      </div>

      <Toasts toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
