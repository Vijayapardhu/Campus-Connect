import type { RemoteInputEvent, RemoteMouseButton } from '../shared/types';

/**
 * Turning input events from another machine into input on this one.
 *
 * Everything here is deliberately free of both Electron and the native module.
 * The one function that actually moves the mouse takes the robot as an argument,
 * so the whole path — validation, key translation, coordinate mapping, the
 * bookkeeping that stops a key being left held down — can be tested against a
 * fake that records what it was asked to do. Given this is the code that lets
 * another device type on your keyboard, being able to test it exhaustively
 * matters more than the small indirection costs.
 */

/** The rectangle of the shared screen in desktop coordinates. */
export type ScreenBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** The slice of robotjs this needs. Anything matching it will do. */
export interface RobotLike {
  moveMouse(x: number, y: number): void;
  mouseToggle(down: 'down' | 'up', button: RemoteMouseButton): void;
  scrollMouse(x: number, y: number): void;
  keyToggle(key: string, down: 'down' | 'up'): void;
  /** Press and release in one go. Used to send a paste to the focused app. */
  keyTap(key: string, modifiers?: string[]): void;
  typeString(text: string): void;
}

/**
 * Keys named differently by the browser and by robotjs.
 *
 * Anything absent falls through to the lowercased name, which covers the
 * letters, the digits and the punctuation. Only the ones that genuinely differ
 * are listed, so this stays a table of exceptions rather than a second
 * keyboard layout to keep in step.
 */
const KEY_NAMES: Record<string, string> = {
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
  escape: 'escape',
  esc: 'escape',
  enter: 'enter',
  return: 'enter',
  ' ': 'space',
  spacebar: 'space',
  backspace: 'backspace',
  delete: 'delete',
  del: 'delete',
  tab: 'tab',
  home: 'home',
  end: 'end',
  pageup: 'pageup',
  pagedown: 'pagedown',
  insert: 'insert',
  printscreen: 'printscreen',
  capslock: 'capslock',
  numlock: 'numlock',
  scrolllock: 'scrolllock',
  pause: 'pause',
  menu: 'menu',
  contextmenu: 'menu',
  control: 'control',
  ctrl: 'control',
  alt: 'alt',
  altgraph: 'alt',
  shift: 'shift',
  meta: 'command',
  os: 'command',
  super: 'command'
};

/**
 * Keys this refuses to press, whatever it is asked.
 *
 * These do not do what a remote operator would expect and can leave the machine
 * in a state the person sitting at it cannot get out of. Windows reserves
 * Ctrl+Alt+Delete for the secure attention sequence and will not accept a
 * synthetic one anyway, so offering it would only be a lie.
 */
const REFUSED_KEYS = new Set(['power', 'sleep', 'wake', 'eject', 'brightnessup', 'brightnessdown']);

/** Modifiers are held rather than tapped, so they need to be recognised. */
const MODIFIERS = new Set(['control', 'alt', 'shift', 'command']);

const MOUSE_BUTTONS = new Set<RemoteMouseButton>(['left', 'right', 'middle']);

/** Longest run of text accepted in one go, so a paste cannot be used to flood. */
export const MAX_TEXT_LENGTH = 4096;

/**
 * Translates a browser key name into robotjs's. Returns null for anything
 * unrecognised or refused, and the caller drops it rather than guessing.
 */
export function toRobotKey(key: string): string | null {
  if (typeof key !== 'string' || key.length === 0 || key.length > 20) {
    return null;
  }

  const lower = key.toLowerCase();
  const mapped = KEY_NAMES[lower] ?? lower;

  if (REFUSED_KEYS.has(mapped)) {
    return null;
  }
  // Function keys, then anything that is a single character.
  if (/^f([1-9]|1\d|2[0-4])$/.test(mapped)) {
    return mapped;
  }
  if (mapped.length === 1) {
    return mapped;
  }

  return KEY_NAMES[lower] ? mapped : null;
}

export function isModifier(robotKey: string): boolean {
  return MODIFIERS.has(robotKey);
}

/**
 * Maps a fraction of the shared screen onto a desktop coordinate.
 *
 * Clamped rather than trusted: a hostile or simply buggy controller sending
 * 12.5 must not be able to fling the pointer onto another monitor, and on a
 * multi-monitor machine the shared screen is only part of the desktop.
 */
export function toScreenPoint(x: number, y: number, bounds: ScreenBounds): { x: number; y: number } {
  const clamp = (value: number) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

  return {
    // The far edge is one pixel inside the screen; `bounds.x + width` is
    // already the first pixel of whatever is next to it.
    x: Math.round(bounds.x + clamp(x) * Math.max(0, bounds.width - 1)),
    y: Math.round(bounds.y + clamp(y) * Math.max(0, bounds.height - 1))
  };
}

/**
 * Checks an event arriving from another machine before any of it is believed.
 *
 * This is a trust boundary: the far side is a member of the room, which makes
 * it authenticated, not correct. Returns the event narrowed to its type, or
 * null — never a partially-validated object.
 */
export function parseRemoteInput(value: unknown): RemoteInputEvent | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const event = value as Record<string, unknown>;
  const isFraction = (candidate: unknown): candidate is number =>
    typeof candidate === 'number' && Number.isFinite(candidate);

  switch (event.t) {
    case 'move':
      return isFraction(event.x) && isFraction(event.y) ? { t: 'move', x: event.x, y: event.y } : null;

    case 'down':
    case 'up':
      return isFraction(event.x) && isFraction(event.y) && MOUSE_BUTTONS.has(event.b as RemoteMouseButton)
        ? { t: event.t, x: event.x, y: event.y, b: event.b as RemoteMouseButton }
        : null;

    case 'scroll':
      return isFraction(event.dx) && isFraction(event.dy)
        ? { t: 'scroll', dx: event.dx, dy: event.dy }
        : null;

    case 'key':
      return typeof event.k === 'string' && typeof event.down === 'boolean'
        ? { t: 'key', k: event.k, down: event.down }
        : null;

    case 'text':
      return typeof event.s === 'string' && event.s.length > 0 && event.s.length <= MAX_TEXT_LENGTH
        ? { t: 'text', s: event.s }
        : null;

    default:
      return null;
  }
}

export type Injector = {
  /** Applies one event. Returns false when it was refused or unusable. */
  apply(event: RemoteInputEvent): boolean;
  /**
   * Lets go of everything currently held. Called whenever a session ends, for
   * any reason at all.
   */
  releaseAll(): void;
  /** Keys and buttons believed to be held right now. For tests and diagnostics. */
  held(): string[];
};

/**
 * Builds the thing that actually drives the machine.
 *
 * `getBounds` is a function rather than a value because the shared screen can be
 * resized, rotated, or unplugged while a session is running, and a stale
 * rectangle would put the pointer in the wrong place — or on the wrong monitor —
 * for the rest of the session.
 */
export function createInjector(robot: RobotLike, getBounds: () => ScreenBounds | null): Injector {
  /*
   * What this session is holding down.
   *
   * Every held key is remembered so it can be released. Without this, a session
   * that ends while Ctrl is down — the controller's window losing focus mid
   * Ctrl+C is enough — leaves the host with a permanently held modifier, and the
   * person sitting in front of it has no idea why their keyboard has stopped
   * working. Recovering from that is not something a user should have to work
   * out.
   */
  const heldKeys = new Set<string>();
  const heldButtons = new Set<RemoteMouseButton>();

  function moveTo(x: number, y: number): boolean {
    const bounds = getBounds();
    if (!bounds) {
      return false;
    }

    const point = toScreenPoint(x, y, bounds);
    robot.moveMouse(point.x, point.y);
    return true;
  }

  return {
    apply(event: RemoteInputEvent): boolean {
      switch (event.t) {
        case 'move':
          return moveTo(event.x, event.y);

        case 'down':
          // Moved first, so the click lands where the controller is pointing
          // even if the move that should have preceded it was dropped.
          if (!moveTo(event.x, event.y)) {
            return false;
          }
          heldButtons.add(event.b);
          robot.mouseToggle('down', event.b);
          return true;

        case 'up':
          if (!moveTo(event.x, event.y)) {
            return false;
          }
          heldButtons.delete(event.b);
          robot.mouseToggle('up', event.b);
          return true;

        case 'scroll':
          robot.scrollMouse(Math.trunc(event.dx), Math.trunc(event.dy));
          return true;

        case 'key': {
          const key = toRobotKey(event.k);
          if (!key) {
            return false;
          }

          if (event.down) {
            heldKeys.add(key);
          } else {
            heldKeys.delete(key);
          }
          robot.keyToggle(key, event.down ? 'down' : 'up');
          return true;
        }

        case 'text':
          /*
           * Typed as a string rather than as key presses. Key codes are a
           * property of the *controller's* keyboard layout, so sending them
           * produces the wrong characters the moment the two machines disagree
           * about where the keys are — which a French and a US layout do
           * immediately. A string is layout-independent.
           */
          robot.typeString(event.s);
          return true;

        default:
          return false;
      }
    },

    releaseAll(): void {
      for (const key of heldKeys) {
        try {
          robot.keyToggle(key, 'up');
        } catch {
          // Releasing is best-effort: one key refusing must not strand the rest.
        }
      }
      heldKeys.clear();

      for (const button of heldButtons) {
        try {
          robot.mouseToggle('up', button);
        } catch {
          // As above.
        }
      }
      heldButtons.clear();
    },

    held(): string[] {
      return [...heldKeys, ...heldButtons].sort();
    }
  };
}
