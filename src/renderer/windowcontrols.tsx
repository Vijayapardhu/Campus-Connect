import React from 'react';
import type { WindowState } from '../shared/types';
import { api } from './api';
import { isPhoneClient } from './httpApi';

/**
 * The window's own minimise, maximise and close.
 *
 * Drawn rather than inherited, because the system's strip of chrome cannot be
 * themed and sits above the application looking like it belongs to something
 * else. Three rules keep this from feeling like a reimplementation:
 *
 *  - **Native where native is expected.** macOS keeps its traffic lights; this
 *    renders nothing at all there. Only Windows and Linux hand the frame over.
 *  - **Geometry people already know.** Full-height targets, flush into the
 *    corner, close on the right and red on hover. Squarer and quieter than the
 *    system's, but in the same places and the same order.
 *  - **The icons are one stroke weight.** They are drawn at 10px on a 1px grid
 *    so the lines land on whole pixels and stay crisp without hinting.
 */

/** Marks a rendering that should stay out of the drag region. */
const NO_DRAG: React.CSSProperties = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;

function MinimiseGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M0.5 5.5h9" stroke="currentColor" strokeWidth="1" fill="none" />
    </svg>
  );
}

function MaximiseGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" strokeWidth="1" fill="none" />
    </svg>
  );
}

/** Two offset panes — the usual shorthand for "put it back how it was". */
function RestoreGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M2.5 2.5V0.5h7v7h-2" stroke="currentColor" strokeWidth="1" fill="none" />
      <rect x="0.5" y="2.5" width="7" height="7" stroke="currentColor" strokeWidth="1" fill="none" />
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" strokeWidth="1" fill="none" />
    </svg>
  );
}

/**
 * Whether this build draws its own controls.
 *
 * The single answer both the component and the stylesheet work from — the bar
 * has to surrender its right inset in exactly the cases something is going to
 * occupy it, and those two decisions drifting apart is what leaves the buttons
 * either floating short of the corner or hanging past it.
 */
export function hasWindowControls(state: WindowState | null): boolean {
  return Boolean(state) && state!.platform !== 'darwin' && !isPhoneClient();
}

export function useWindowState(): WindowState | null {
  const [state, setState] = React.useState<WindowState | null>(null);

  React.useEffect(() => {
    if (isPhoneClient()) {
      return;
    }

    void api.windowState().then(setState);
    // Maximising happens without this app's involvement too — a double-click on
    // the drag region, a keyboard shortcut, the window manager deciding — so the
    // icon follows the window rather than the last button pressed.
    return api.onWindowState(setState);
  }, []);

  return state;
}

export function WindowControls({
  state,
  closeLabel = 'Close to the tray'
}: {
  state: WindowState | null;
  /**
   * What the close button says it does. Right for the main window, where
   * close means hide to the tray — wrong for the call and remote windows,
   * where the same button hangs up or disconnects, so those pass their own.
   */
  closeLabel?: string;
}) {
  // Nothing to draw when the system is still drawing it, or in a browser tab.
  if (!hasWindowControls(state)) {
    return null;
  }

  const maximized = state!.maximized || state!.fullScreen;

  return (
    <div className="wincontrols" style={NO_DRAG}>
      <button
        className="wincontrols__btn"
        onClick={() => void api.windowMinimize()}
        aria-label="Minimise"
        title="Minimise"
      >
        <MinimiseGlyph />
      </button>
      <button
        className="wincontrols__btn"
        onClick={() => void api.windowToggleMaximize()}
        aria-label={maximized ? 'Restore down' : 'Maximise'}
        title={maximized ? 'Restore down' : 'Maximise'}
      >
        {maximized ? <RestoreGlyph /> : <MaximiseGlyph />}
      </button>
      <button
        className="wincontrols__btn wincontrols__btn--close"
        onClick={() => void api.windowClose()}
        aria-label="Close"
        title={closeLabel}
      >
        <CloseGlyph />
      </button>
    </div>
  );
}
