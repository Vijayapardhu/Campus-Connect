import { BrowserWindow, app, globalShortcut, screen } from 'electron';
import log from 'electron-log';
import path from 'node:path';

/**
 * The quick-paste overlay: a small window that appears over whatever you are
 * working in, on a hotkey, and puts something from your history into it.
 *
 * This is the part that turns the app from something you switch to into
 * something you use without switching. The whole design follows from one
 * requirement — **it must work while the main window is closed** — which is why
 * it is a second window with its own lifetime rather than a panel inside the
 * first, and why the hotkey is registered globally rather than as a page
 * shortcut.
 *
 * Two things it must never do: take focus permanently, or stay on screen after
 * you have chosen. Both would put it in the way of the work it is meant to be
 * helping with.
 */

/** Big enough for a readable list, small enough not to cover what you are doing. */
const WIDTH = 720;
const HEIGHT = 520;

/**
 * How long to wait after hiding before pressing paste.
 *
 * The operating system returns focus to the previous application when this
 * window goes away, and that is not instantaneous. Pasting too early sends the
 * keystroke into nothing. Measured rather than guessed: below about 80ms it
 * fails intermittently on Windows, and anything above ~150ms is perceptible as
 * a lag between choosing and seeing the text appear.
 */
const FOCUS_RETURN_MS = 120;

export type QuickPasteOptions = {
  preloadPath: string;
  /** The dev server URL, or undefined for a packaged build. */
  devServerUrl?: string;
  /** Presses paste in the app that had focus. Absent when unavailable. */
  paste: (() => void) | null;
  /** True once the app is genuinely quitting, so the window stops being kept. */
  isQuitting: () => boolean;
  onOpened: () => void;
};

export class QuickPaste {
  private window: BrowserWindow | null = null;
  private registered = '';

  constructor(private readonly options: QuickPasteOptions) {}

  /**
   * Creates the window up front, hidden.
   *
   * Building it lazily on the first hotkey press would put the whole cost of
   * starting a renderer — several hundred milliseconds — between pressing the
   * key and seeing anything, every first time. For a feature whose entire value
   * is being instant, that is the wrong trade.
   */
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
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      // Rounded corners and the drop shadow are drawn by the page, so the
      // window itself has to let the background through.
      transparent: true,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false
      }
    });

    /*
     * Above full-screen applications too. Something that only appears over
     * ordinary windows is not much use to someone working in a full-screen
     * editor, which is most of the time this is wanted.
     */
    window.setAlwaysOnTop(true, 'screen-saver');
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    // Clicking away is a dismissal. Anything else would leave it floating over
    // the work it is supposed to be getting out of the way of.
    window.on('blur', () => this.hide());

    // The tray keeps the app alive, so this window is hidden rather than closed.
    window.on('close', (event) => {
      if (!this.options.isQuitting()) {
        event.preventDefault();
        this.hide();
      }
    });

    if (this.options.devServerUrl) {
      window.loadURL(`${this.options.devServerUrl}#quick-paste`);
    } else {
      window.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: 'quick-paste' });
    }

    this.window = window;
    return window;
  }

  /** Builds the window ahead of the first use, so the first use is instant. */
  warmUp(): void {
    this.ensureWindow();
  }

  /**
   * Registers the system-wide hotkey. Returns what went wrong, or an empty
   * string — a shortcut another application already owns simply cannot be had,
   * and the user needs to be told that rather than left pressing a dead key.
   */
  setShortcut(accelerator: string): string {
    if (this.registered) {
      globalShortcut.unregister(this.registered);
      this.registered = '';
    }

    const wanted = accelerator.trim();
    if (!wanted) {
      return '';
    }

    try {
      if (!globalShortcut.register(wanted, () => this.toggle())) {
        log.warn(`Quick paste: ${wanted} is already taken by another application`);
        return `${wanted} is already in use by another application. Pick a different combination.`;
      }
    } catch (error) {
      log.warn(`Quick paste: ${wanted} could not be registered — ${(error as Error).message}`);
      return `${wanted} is not a valid shortcut.`;
    }

    this.registered = wanted;
    return '';
  }

  toggle(): void {
    if (this.window?.isVisible()) {
      this.hide();
    } else {
      this.show();
    }
  }

  show(): void {
    const window = this.ensureWindow();

    /*
     * On the screen the pointer is on, not the primary one and not wherever it
     * was last time. On a multi-monitor desk the pointer is a reliable proxy for
     * which screen you are actually looking at.
     */
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const { x, y, width, height } = display.workArea;

    window.setBounds({
      x: Math.round(x + (width - WIDTH) / 2),
      // Slightly above centre. Dead centre reads as a modal demanding an answer;
      // a little high reads as a palette, which is what this is.
      y: Math.round(y + Math.max(0, height * 0.28)),
      width: WIDTH,
      height: HEIGHT
    });

    this.options.onOpened();
    window.showInactive();
    window.focus();
  }

  hide(): void {
    const window = this.window;
    if (!window || window.isDestroyed() || !window.isVisible()) {
      return;
    }

    window.hide();

    /*
     * macOS keeps the application itself focused after its last visible window
     * goes away, so the paste would land on Campus Connect rather than on
     * whatever you were working in. Stepping the whole app out of the way hands
     * focus back to where it came from. Only when nothing else of ours is on
     * screen — hiding the app while the main window is open would be rude.
     */
    if (process.platform === 'darwin') {
      const othersVisible = BrowserWindow.getAllWindows().some(
        (candidate) => candidate !== window && !candidate.isDestroyed() && candidate.isVisible()
      );
      if (!othersVisible) {
        app.hide();
      }
    }
  }

  /**
   * Hides, waits for focus to go back where it came from, and presses paste.
   *
   * The clipboard write has already happened by the time this is called — this
   * is only the keystroke. When pasting is unavailable (no native module) the
   * item is still on the clipboard, so the feature degrades to "copied for you"
   * rather than to nothing.
   */
  pasteAndHide(): void {
    this.hide();

    const paste = this.options.paste;
    if (!paste) {
      return;
    }

    setTimeout(() => {
      try {
        paste();
      } catch (error) {
        log.warn(`Quick paste: could not send the paste keystroke — ${(error as Error).message}`);
      }
    }, FOCUS_RETURN_MS);
  }

  send(channel: string, payload: unknown): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send(channel, payload);
    }
  }

  isOverlay(window: BrowserWindow | null): boolean {
    return Boolean(window) && window === this.window;
  }

  destroy(): void {
    if (this.registered) {
      globalShortcut.unregister(this.registered);
      this.registered = '';
    }

    if (this.window && !this.window.isDestroyed()) {
      this.window.destroy();
    }
    this.window = null;
  }
}
