/**
 * The desktop's events, pushed to a paired phone.
 *
 * HTTP does not push, so the phone polled for state every second and a half —
 * always a beat behind, and structurally unable to hear anything that expires
 * on its own. A ring, a transfer request, somebody asking to be let into a
 * room: all of those were over before the next poll.
 *
 * Server-sent events fix that, with one wrinkle. `EventSource` cannot carry an
 * `Authorization` header, and its only alternative is the token in the query
 * string — which is exactly what this app takes care to avoid elsewhere, since
 * a URL ends up in history, in logs, and in whatever the browser syncs. So the
 * stream is read from `fetch` instead and the frames are parsed here. It is
 * about thirty lines, and it keeps the credential in a header where it belongs.
 */

export type StreamEvent = { channel: string; payload: unknown };

/** Gap before reconnecting, and the ceiling it backs off to. */
const RETRY_MS = 1000;
const MAX_RETRY_MS = 15000;

/**
 * Opens the stream and keeps it open. Returns a function that closes it for
 * good — a reconnect loop that ignores being told to stop is a leak that
 * survives every unmount.
 */
export function openEventStream(
  token: () => string,
  onEvent: (event: StreamEvent) => void,
  onOpen?: () => void
): () => void {
  let stopped = false;
  let controller: AbortController | null = null;
  let retry = RETRY_MS;
  let timer = 0;

  async function connect(): Promise<void> {
    if (stopped) {
      return;
    }

    controller = new AbortController();
    try {
      const response = await fetch('/api/events', {
        headers: { Authorization: `Bearer ${token()}`, Accept: 'text/event-stream' },
        signal: controller.signal
      });

      if (!response.ok || !response.body) {
        throw new Error(`stream refused: ${response.status}`);
      }

      // Connected, so the next failure starts backing off from the bottom again.
      retry = RETRY_MS;
      onOpen?.();

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { value, done } = await reader.read();
        if (done || stopped) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        // Frames are separated by a blank line; anything after the last one is
        // a partial frame and waits for the rest of itself.
        let split = buffer.indexOf('\n\n');
        while (split !== -1) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const event = parseFrame(frame);
          if (event) {
            onEvent(event);
          }
          split = buffer.indexOf('\n\n');
        }
      }
    } catch {
      // Sleeping phone, changed network, desktop switched off. All the same
      // thing from here: wait, then try again.
    }

    if (stopped) {
      return;
    }

    timer = window.setTimeout(connect, retry);
    retry = Math.min(MAX_RETRY_MS, retry * 2);
  }

  void connect();

  return () => {
    stopped = true;
    window.clearTimeout(timer);
    controller?.abort();
  };
}

/** One `event:`/`data:` frame. Comments — the heartbeat — yield nothing. */
function parseFrame(frame: string): StreamEvent | null {
  let channel = '';
  const data: string[] = [];

  for (const line of frame.split('\n')) {
    if (line.startsWith(':') || line.length === 0) {
      continue;
    }
    if (line.startsWith('event:')) {
      channel = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      data.push(line.slice(5).trimStart());
    }
  }

  if (!channel) {
    return null;
  }

  try {
    return { channel, payload: data.length ? JSON.parse(data.join('\n')) : null };
  } catch {
    return null;
  }
}
