import React from 'react';
import type { StatusTone } from '../shared/bridge';
import { rawRpc } from './httpApi';
import { DownloadIcon, SendIcon, XIcon } from './icons';

/**
 * The two things a phone is actually for: take what is on the laptop, or put
 * something on it. Two buttons, nothing to fill in.
 *
 * Both directions are **private** — they read and write the laptop's clipboard
 * directly and never touch a room, because what gets moved this way is usually a
 * password, a code or a link meant for one person.
 *
 * ---
 *
 * **Why there is a button rather than it just happening.**
 *
 * A web page cannot put something on the phone's clipboard by itself. Browsers
 * only allow a clipboard write during a real tap, and they drop that permission
 * the instant the handler awaits anything — so "fetch the text, then copy it"
 * fails silently, which is exactly how this behaved before.
 *
 * So the text is already in hand: the laptop's clipboard is polled in the
 * background, and the tap copies something local, finishing inside the gesture
 * with nothing awaited between the finger and the clipboard.
 */

/** How often the phone quietly asks what is on the laptop's clipboard. */
const POLL_MS = 2000;

export function PhoneHome({ push }: { push: (message: string, tone?: StatusTone) => void }) {
  const [onLaptop, setOnLaptop] = React.useState('');
  const [composing, setComposing] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  const [sending, setSending] = React.useState(false);
  /** Shown only when a browser refuses the copy, so it can be long-pressed. */
  const [fallback, setFallback] = React.useState('');
  const draftRef = React.useRef<HTMLTextAreaElement>(null);

  React.useEffect(() => {
    let cancelled = false;

    const read = async () => {
      try {
        const result = await rawRpc<{ text: string }>('phone:pull-clipboard');
        if (!cancelled) {
          setOnLaptop(result?.text ?? '');
        }
      } catch {
        // A dropped poll is not worth reporting; the next one says the same.
      }
    };

    void read();
    const timer = window.setInterval(read, POLL_MS);
    const onVisible = () => {
      if (!document.hidden) {
        void read();
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  React.useEffect(() => {
    if (composing) {
      draftRef.current?.focus();
    }
  }, [composing]);

  /*
   * Genuinely automatic, where the platform allows it.
   *
   * The async Clipboard API can write without a tap when the page is focused —
   * but it only exists on a secure origin, which plain HTTP over a LAN is not.
   * So on most phones this does nothing and the button below is the answer; on
   * a secure origin the clipboard simply follows the laptop with no tap at all.
   * Attempting it costs nothing and there is no way to detect the difference
   * except by trying.
   */
  React.useEffect(() => {
    if (!onLaptop.trim() || !window.isSecureContext || !navigator.clipboard?.writeText) {
      return;
    }
    if (document.hidden) {
      return;
    }

    navigator.clipboard
      .writeText(onLaptop)
      .then(() => setFallback(''))
      .catch(() => undefined);
  }, [onLaptop]);

  function copyFromLaptop() {
    if (!onLaptop.trim()) {
      push('There is nothing on the computer’s clipboard.', 'warning');
      return;
    }

    // Synchronous, inside the tap. Nothing is awaited on this path.
    if (copyText(onLaptop)) {
      setFallback('');
      push('Copied to this phone.', 'success');
      return;
    }

    // Some browsers refuse whatever technique is used. Then the text has to be
    // on screen to be long-pressed, or there is no way to get at it at all.
    setFallback(onLaptop);
    push('Press and hold the text to copy it.', 'info');
  }

  /**
   * Sends whatever was pasted, immediately.
   *
   * There is no way to read the phone's clipboard without asking: that needs the
   * async Clipboard API, which does not exist on a plain-HTTP origin. So the
   * paste itself is the trigger — the field is only ever a place for the system
   * paste to land, and the moment something arrives it goes. Nothing is typed
   * and there is no second button to find.
   */
  async function sendText(value: string) {
    const text = value.trim();
    if (!text) {
      return;
    }

    setSending(true);
    try {
      const result = await rawRpc<{ ok: boolean; message: string }>('phone:push-clipboard', text);
      push(result?.message ?? 'Sent.', result?.ok ? 'success' : 'error');
      if (result?.ok) {
        setDraft('');
        setComposing(false);
      }
    } catch {
      push('Could not reach the computer.', 'error');
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="phone-home">
      <h2 className="phone-home__title">This phone and your computer</h2>
      <p className="phone-home__lede">Private — not shared with the room.</p>

      {/* The button says what it will actually give you, so there is no need for
          a panel of text sitting above it doing the same job. */}
      <button className="phone-action" onClick={copyFromLaptop} disabled={!onLaptop.trim()}>
        <span className="phone-action__icon">
          <DownloadIcon size={20} />
        </span>
        <span className="phone-action__body">
          <span className="phone-action__title">Copy from computer</span>
          <span className="phone-action__desc">
            {onLaptop.trim() ? oneLine(onLaptop) : 'Nothing copied on the computer yet'}
          </span>
        </span>
      </button>

      {fallback ? <pre className="laptop-clip__text">{fallback}</pre> : null}

      {composing ? (
        <div className="phone-compose">
          <div className="phone-compose__prompt">
            {sending ? 'Sending…' : 'Press and hold below, then choose Paste.'}
          </div>
          <textarea
            ref={draftRef}
            className="input input--area phone-home__draft"
            value={draft}
            /* The paste is the send. Nothing else is needed and nothing is typed. */
            onPaste={(event) => {
              const text = event.clipboardData.getData('text');
              if (text.trim()) {
                event.preventDefault();
                void sendText(text);
              }
            }}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void sendText(draft);
              }
            }}
            placeholder="Paste here"
            rows={3}
          />
          <div className="row">
            {/* Only for anyone who typed instead of pasting. */}
            {draft.trim() ? (
              <button
                className="phone-action phone-action--primary phone-action--compact"
                onClick={() => sendText(draft)}
                disabled={sending}
              >
                <SendIcon size={17} />
                Send
              </button>
            ) : null}
            <button
              className="phone-action phone-action--compact"
              onClick={() => {
                setComposing(false);
                setDraft('');
              }}
            >
              <XIcon size={17} />
              Cancel
            </button>
          </div>
        </div>
      ) : (
        /* The field appears when it is wanted, so the home screen stays two
           buttons rather than a form. */
        <button className="phone-action" onClick={() => setComposing(true)}>
          <span className="phone-action__icon">
            <SendIcon size={20} />
          </span>
          <span className="phone-action__body">
            <span className="phone-action__title">Paste to computer</span>
            <span className="phone-action__desc">
              Paste from this phone straight onto the computer&rsquo;s clipboard
            </span>
          </span>
        </button>
      )}
    </section>
  );
}

/** A one-line preview, so the button says what tapping it will give you. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 48 ? `${flat.slice(0, 48)}…` : flat;
}

/**
 * Copies text to the phone's clipboard, synchronously.
 *
 * Three techniques, because no single one works everywhere:
 *
 *  1. The async Clipboard API, when it exists. On a plain-HTTP origin it does
 *     not exist at all — not refused, absent — so this only fires over HTTPS or
 *     on localhost.
 *  2. A Range **and** `setSelectionRange`, which is what iOS Safari needs. A
 *     Range alone selects nothing from a textarea, because its value is not DOM
 *     text; `setSelectionRange` alone is ignored by iOS. Only both together
 *     work, and that is why this failed on a phone while passing on a desktop.
 *  3. `select()` as well, for everything else.
 *
 * `readonly` is deliberate: it stops the on-screen keyboard appearing, and iOS
 * still selects from a readonly field.
 *
 * Must be called straight from a tap handler with nothing awaited before it —
 * browsers drop clipboard permission the moment a handler awaits.
 */
function copyText(text: string): boolean {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text).catch(() => undefined);
    return true;
  }

  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  /*
   * On screen and real, not `display:none`. Safari will not copy from an element
   * it considers invisible. 16px, or focusing it zooms the whole page.
   */
  field.style.cssText =
    'position:fixed;top:50%;left:0;width:1px;height:1px;padding:0;margin:0;' +
    'border:none;outline:none;box-shadow:none;background:transparent;' +
    'color:transparent;font-size:16px;';
  document.body.appendChild(field);

  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(field);
  selection?.removeAllRanges();
  selection?.addRange(range);

  field.select();
  field.setSelectionRange(0, text.length);

  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }

  selection?.removeAllRanges();
  document.body.removeChild(field);
  return copied;
}
