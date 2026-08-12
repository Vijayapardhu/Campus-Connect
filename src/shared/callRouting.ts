/**
 * Where an arriving call signal should go.
 *
 * Pulled out of the call window as a plain function because getting it wrong
 * broke calls completely and silently, and nothing could test it while it lived
 * inside a React effect. The failure was not in WebRTC or in the negotiation —
 * it was one comparison deciding a signal belonged to nobody.
 *
 * Answering a call is two awaits deep: an IPC round trip to join, and then
 * opening the microphone. The main process sends this device's `join` onto the
 * wire during the first of those, and the caller answers it with an SDP offer
 * the moment it arrives — well before either await has finished here. So there
 * is a window, every single time a call is answered, in which a signal arrives
 * for a call this device is genuinely joining but has no session object for
 * yet.
 *
 * Treating an empty session id as "not my call" dropped the offer in that
 * window. An offer is sent once and nothing retries it, so both ends then sat
 * showing each other as joined participants with no media between them and no
 * error anywhere to explain it.
 */

export type CallSignalRoute =
  /** Give it to the engine now. */
  | 'handle'
  /** Hold it until there is an engine ready to take it. */
  | 'queue'
  /** Genuinely for a call this device is not in. */
  | 'ignore';

export function routeCallSignal(options: {
  /**
   * The call this window is in. Empty in the gap between answering and the
   * session being set up — which is not the same as being in no call, and is
   * exactly the distinction that matters here.
   */
  sessionId: string;
  /** The call the arriving signal names. */
  signalCallId: string;
  /** Whether the engine exists and has finished opening its devices. */
  ready: boolean;
}): CallSignalRoute {
  const { sessionId, signalCallId, ready } = options;

  /*
   * Only ignorable when this device is demonstrably in a *different* call.
   * Anything else is held, because the alternative is discarding a signal for a
   * call that is halfway through being joined.
   */
  if (sessionId && sessionId !== signalCallId) {
    return 'ignore';
  }

  if (!sessionId || !ready) {
    return 'queue';
  }

  return 'handle';
}
