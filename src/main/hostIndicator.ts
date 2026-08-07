import { BrowserWindow, screen } from 'electron';
import path from 'node:path';

/**
 * The one thing left visible when the main window is not: that this machine
 * is currently being driven by someone else.
 *
 * `RemoteHostBar` already shows this, but only inside the main window — the
 * moment the host minimises it or switches to something else, the only way
 * left to know a session is live (short of the panic shortcut) is trusting
 * memory. This is a second, tiny surface for the same fact, built the same
 * way the quick-paste overlay is: frameless, transparent, always on top, and
 * never taking focus it was not asked for.
 */

const WIDTH = 260;
const HEIGHT = 56;
/** Distance from the corner of the work area, so it never touches the edge. */
const MARGIN = 16;

export type HostIndicatorOptions = {
  preloadPath: string;
  /** The dev server URL, or undefined for a packaged build. */
  devServerUrl?: string;
};

export class HostIndicator {
  private window: BrowserWindow | null = null;

  constructor(
    private readonly options: HostIndicatorOptions,
    /** Told about the window the moment it exists, so it can join the broadcast list. */
    private readonly onCreated: (window: BrowserWindow) => void
  ) {}

  private ensureWindow(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) {
      return this.window;
    }

    const window = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      show: false,
      frame: false,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      transparent: true,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false
      }
    });

    // Above full-screen applications too — a host who has tabbed into a
    // full-screen editor is exactly who most needs the reminder.
    window.setAlwaysOnTop(true, 'screen-saver');
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    if (this.options.devServerUrl) {
      window.loadURL(`${this.options.devServerUrl}#host-indicator`);
    } else {
      window.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: 'host-indicator' });
    }

    this.window = window;
    this.onCreated(window);
    return window;
  }

  /** Shows the indicator near a corner of the screen the pointer is on. */
  show(): void {
    const window = this.ensureWindow();

    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const { x, y, width } = display.workArea;

    window.setBounds({
      x: Math.round(x + width - WIDTH - MARGIN),
      y: Math.round(y + MARGIN),
      width: WIDTH,
      height: HEIGHT
    });

    // Never takes focus — the whole point is to stay out of the way of
    // whatever the host is doing while still being visible.
    window.showInactive();
  }

  hide(): void {
    if (this.window && !this.window.isDestroyed() && this.window.isVisible()) {
      this.window.hide();
    }
  }

  /** Torn down on quit, same as every other window this app owns. */
  destroy(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.destroy();
    }
    this.window = null;
  }
}
