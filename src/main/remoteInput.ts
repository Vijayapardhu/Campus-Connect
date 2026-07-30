import { screen, systemPreferences } from 'electron';
import log from 'electron-log';
import type { RemoteCapabilities } from '../shared/types';
import { createInjector, type Injector, type RobotLike, type ScreenBounds } from './remoteControl';

/**
 * The bridge to the one native thing this application does.
 *
 * Injecting mouse and keyboard events is the only capability Electron does not
 * provide, so it comes from a native module. Everything about how that module is
 * used here is shaped by one rule: **being unable to load it must never break
 * anything else**. A machine that cannot be driven can still be watched, and
 * watching is most of the value.
 *
 * So the module is required lazily, inside a try, the first time control is
 * actually wanted — not at startup — and a failure is turned into a sentence
 * explaining what the user can do about it rather than an exception.
 */

/** Cached across calls: `require` of a native module is not cheap. */
let robot: RobotLike | null = null;
let loadFailure = '';
let attempted = false;

function loadRobot(): RobotLike | null {
  if (attempted) {
    return robot;
  }
  attempted = true;

  try {
    /*
     * Required by name at runtime rather than imported at the top, so that a
     * build or a platform without the native binary still starts. The module is
     * N-API, which is why no rebuild against Electron's ABI is needed.
     */
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    robot = require('@jitsi/robotjs') as RobotLike;
    log.info('Remote control: input injection is available');
  } catch (error) {
    loadFailure = (error as Error).message;
    log.warn(`Remote control: input injection unavailable — ${loadFailure}`);
    robot = null;
  }

  return robot;
}

/**
 * Wayland refuses synthetic input from an ordinary application, by design.
 *
 * There is no flag, no permission, and no workaround: the native module talks
 * XTest, which Wayland does not implement. Saying so plainly is far better than
 * offering control that silently does nothing.
 */
function isWayland(): boolean {
  return (
    process.platform === 'linux' &&
    (process.env.XDG_SESSION_TYPE === 'wayland' || Boolean(process.env.WAYLAND_DISPLAY))
  );
}

/**
 * What this machine can actually offer, checked rather than assumed.
 *
 * `prompt` asks macOS to show its Accessibility dialog. That is only appropriate
 * when the user has just asked for something that needs it — never on a
 * capability check made for the sake of drawing a button.
 */
export function getRemoteCapabilities(prompt = false): RemoteCapabilities {
  if (isWayland()) {
    return {
      canControl: false,
      reason:
        'Wayland does not let applications send mouse and keyboard events, so this machine can be watched but not controlled. Logging in with an X11 session enables control.'
    };
  }

  if (!loadRobot()) {
    return {
      canControl: false,
      reason: `Input control is not available on this machine${loadFailure ? ` (${loadFailure})` : ''}. Your screen can still be shared for viewing.`
    };
  }

  /*
   * macOS will happily load the module and then discard every event it sends
   * until the app is ticked in Accessibility. The failure is completely silent,
   * which makes checking here worth the trouble.
   */
  if (process.platform === 'darwin' && !systemPreferences.isTrustedAccessibilityClient(prompt)) {
    return {
      canControl: false,
      reason:
        'macOS has not granted this app permission to control the computer. Allow it under System Settings → Privacy & Security → Accessibility, then try again. Viewing works without it.'
    };
  }

  return { canControl: true, reason: '' };
}

/**
 * The screen being shared, by the id `desktopCapturer` gave for it.
 *
 * Read fresh every time rather than captured once: a display can be resized,
 * rotated or unplugged mid-session, and a stale rectangle would put the pointer
 * somewhere other than where the controller is pointing — on a multi-monitor
 * machine, possibly on an entirely different screen.
 */
export function boundsForDisplay(displayId: string): ScreenBounds | null {
  const display = screen.getAllDisplays().find((candidate) => String(candidate.id) === displayId);
  return display ? { ...display.bounds } : null;
}

/**
 * Presses the paste shortcut in whatever application currently has focus.
 *
 * Used by the quick-paste overlay, which has already put the chosen item on the
 * clipboard by the time this runs. Returns null when the native module is not
 * available — the overlay then simply leaves the item copied, which is a
 * reasonable half of the feature rather than a broken whole.
 *
 * Note this does *not* go through the remote-control capability check. Pasting
 * into your own machine on your own keypress is not remote control, and on
 * Wayland it works fine even though driving the mouse does not.
 */
export function getPasteAction(): (() => void) | null {
  const engine = loadRobot();
  if (!engine) {
    return null;
  }

  const modifier = process.platform === 'darwin' ? 'command' : 'control';
  return () => engine.keyTap('v', [modifier]);
}

/**
 * An injector aimed at one display. Returns null when this machine cannot be
 * driven at all, which the caller must treat as "view only" rather than as an
 * error.
 */
export function createDisplayInjector(displayId: string): Injector | null {
  const engine = loadRobot();
  if (!engine || !getRemoteCapabilities().canControl) {
    return null;
  }

  return createInjector(engine, () => boundsForDisplay(displayId));
}
