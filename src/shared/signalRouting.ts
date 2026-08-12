/**
 * Where an arriving session signal should go.
 *
 * Calls and remote-desktop sessions negotiate the same way — an offer, an
 * answer, a stream of ICE candidates — and both got the same thing wrong, in
 * the same place, for the same reason. Pulled out as a plain function because
 * the fault was never in WebRTC or in the negotiation: it was one comparison
 * deciding an arriving signal belonged to nobody, inside a React effect where
 * nothing could test it.
 *
 * Both sessions start with an await the far end does not know about. Answering
 * a call is an IPC round trip and then opening the microphone; accepting a
 * remote-desktop request is an IPC round trip and then capturing a screen. In
 * both, this device tells the other end it is joining *before* either await
 * finishes, and the other end replies immediately with an offer. So there is a
 * window, every single time, in which a signal arrives for a session this
 * device is genuinely in but has no engine — and possibly no session id — for
 * yet.
 *
 * Treating that window as "not mine" discarded the offer. An offer is sent once
 * and nothing retries it, so both ends then sat showing each other as connected
 * with nothing passing between them, and no error anywhere to explain it: the
 * call was silent, the remote screen never painted.
 *
 * The rule is that only a session id naming a *different* session may be
 * ignored. Everything else is held until there is an engine to take it.
 */

export type SignalRoute =
  /** Give it to the engine now. */
  | 'handle'
  /** Hold it until there is an engine ready to take it. */
  | 'queue'
  /** Genuinely for a session this device is not in. */
  | 'ignore';

export function routeSessionSignal(options: {
  /**
   * The session this window is in. Empty in the gap before setup has run,
   * which is not the same as being in no session at all — and that distinction
   * is the whole point of this function.
   */
  sessionId: string;
  /** The session the arriving signal names. */
  signalSessionId: string;
  /**
   * Whether an engine exists and is able to take a signal. False during the
   * await that opens a microphone or captures a screen.
   */
  ready: boolean;
}): SignalRoute {
  const { sessionId, signalSessionId, ready } = options;

  /*
   * Only ignorable when this device is demonstrably in a *different* session.
   * Anything else is held, because the alternative is discarding a signal for
   * a session that is halfway through being set up.
   */
  if (sessionId && sessionId !== signalSessionId) {
    return 'ignore';
  }

  if (!sessionId || !ready) {
    return 'queue';
  }

  return 'handle';
}

/**
 * How many signals may be held while a session is still starting.
 *
 * An offer and the candidates behind it, several times over, and no more: the
 * queue also collects what arrives before there is any session to match
 * against, so without a ceiling an unanswered request left sitting on screen
 * would accumulate the other end's candidates for as long as it kept sending
 * them.
 */
export const MAX_PENDING_SIGNALS = 256;
