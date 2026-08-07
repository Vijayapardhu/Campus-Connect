import { BrowserWindow, nativeTheme, screen, shell } from 'electron';
import path from 'node:path';
import type { WindowState } from '../shared/types';

/**
 * A call or a remote-desktop session, in a window of its own.
 *
 * Everywhere else a second window exists in this app — the quick-paste
 * overlay — closing it means "get out of the way", so it is hidden rather
 * than destroyed. This is the opposite kind of window: closing it is how you
 * hang up or disconnect, the same as clicking the button on TeamViewer's or
 * AnyDesk's own session window. So the close button is left to do exactly
 * what it looks like it does, and the one thing guarded against is the other
 * direction — a session that ends for some other reason (the peer hung up,
 * it timed out) has to take the window down with it, without that self-close
 * looping back around and trying to end the session a second time.
 */

/**
 * Whether this platform keeps its own window controls.
 *
 * Only macOS does. Windows and Linux hand the whole frame over, which is what
 * lets a window own its top edge rather than sitting under a strip of system
 * chrome in the wrong colour. Shared with `main.ts`'s main window so the two
 * never quietly drift into disagreeing about which platform draws what.
 */
export const IS_MAC = process.platform === 'darwin';

/**
 * How far a maximised window reaches above the usable screen.
 *
 * Windows grows a maximised window by the width of its invisible resize
 * border on every side. With a frame that is unnoticeable; without one it
 * quietly clips the top of the application — including part of the window
 * controls. Every frameless window in this app is affected the same way, so
 * this lives here once rather than once per window that draws its own
 * titlebar.
 *
 * Measured against the display's work area rather than assumed to be a fixed
 * number of pixels, because it scales with DPI and differs per monitor.
 */
export function maximizedTopInset(window: BrowserWindow): number {
  if (!window.isMaximized() || window.isFullScreen()) {
    return 0;
  }

  const bounds = window.getBounds();
  const { workArea } = screen.getDisplayMatching(bounds);
  return Math.max(0, Math.min(16, workArea.y - bounds.y));
}

export function currentWindowState(window: BrowserWindow): WindowState {
  return {
    maximized: window.isMaximized(),
    fullScreen: window.isFullScreen(),
    // The renderer decides whether to draw controls at all from this, so it
    // is reported rather than guessed at from a user-agent string.
    platform: IS_MAC ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux',
    topInset: maximizedTopInset(window)
  };
}

export type SessionWindowKind = 'call' | 'remote';

export type SessionWindowOptions = {
  kind: SessionWindowKind;
  title: string;
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  preloadPath: string;
  /** The dev server URL, or undefined for a packaged build. */
  devServerUrl?: string;
  /** The window was closed by whoever was looking at it — hang up, disconnect. */
  onClosedByUser: () => void;
};

export class SessionWindow {
  private window: BrowserWindow | null = null;
  /** Set right before a self-close, so that close does not also hang up. */
  private endingProgrammatically = false;

  constructor(
    private readonly options: SessionWindowOptions,
    /** Told about the window the moment it exists, so it can join the broadcast list. */
    private readonly onCreated: (window: BrowserWindow) => void
  ) {}

  private ensureWindow(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) {
      return this.window;
    }

    const window = new BrowserWindow({
      width: this.options.width,
      height: this.options.height,
      minWidth: this.options.minWidth,
      minHeight: this.options.minHeight,
      title: this.options.title,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1115' : '#ffffff',
      // A real window — its own taskbar entry, resizable, minimisable — not the
      // quick-paste overlay's borrowed, dismiss-on-blur kind. Minimising or
      // maximising this one must never be able to reach the session, so
      // nothing here is wired to either.
      frame: IS_MAC,
      titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
      trafficLightPosition: IS_MAC ? { x: 18, y: 18 } : undefined,
      resizable: true,
      minimizable: true,
      maximizable: true,
      movable: true,
      skipTaskbar: false,
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        // A minimised call window is still a live call. Nothing here should be
        // throttled just because the window is not the one on screen.
        backgroundThrottling: false
      }
    });

    window.on('close', () => {
      if (this.endingProgrammatically) {
        return;
      }
      this.options.onClosedByUser();
    });

    window.on('closed', () => {
      this.window = null;
      this.endingProgrammatically = false;
    });

    const reportWindowState = () => {
      if (!window.isDestroyed()) {
        window.webContents.send('window:state', currentWindowState(window));
      }
    };

    window.on('maximize', reportWindowState);
    window.on('unmaximize', reportWindowState);
    window.on('enter-full-screen', reportWindowState);
    window.on('leave-full-screen', reportWindowState);
    window.webContents.on('did-finish-load', reportWindowState);

    window.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });

    window.webContents.on('before-input-event', (_event, input) => {
      if (input.type !== 'keyDown') {
        return;
      }
      if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
        window.webContents.toggleDevTools();
      }
    });

    if (this.options.devServerUrl) {
      window.loadURL(`${this.options.devServerUrl}#${this.options.kind}`);
    } else {
      window.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: this.options.kind });
    }

    this.window = window;
    this.onCreated(window);
    return window;
  }

  /** Opens the window, creating it if needed, and brings it to the front. */
  open(): void {
    const window = this.ensureWindow();
    if (window.isMinimized()) {
      window.restore();
    }
    window.show();
    window.focus();
  }

  isOpen(): boolean {
    return Boolean(this.window) && !this.window!.isDestroyed();
  }

  /**
   * Takes the window down because the session ended some other way — the peer
   * hung up, a request timed out. `destroy` rather than `close`, so this does
   * not run back through the close handler and try to end the session again.
   */
  closeIfOpen(): void {
    if (!this.window || this.window.isDestroyed()) {
      return;
    }
    this.endingProgrammatically = true;
    this.window.destroy();
  }

  /** Torn down on quit, same as every other window this app owns. */
  destroy(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.endingProgrammatically = true;
      this.window.destroy();
    }
    this.window = null;
  }
}
