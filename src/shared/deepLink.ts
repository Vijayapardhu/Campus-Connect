import type { DeepLink } from './types';

/**
 * Links that open this application.
 *
 * The scheme was being minted long before anything could receive it — every
 * room QR code encodes `campusconnect://join?code=…` — so this is the half that
 * was missing rather than a new idea.
 *
 * Kept free of Electron so the parsing can be tested directly. That matters
 * more here than the indirection costs: a deep link is unvalidated input from
 * outside the application, handed over by the operating system, and anyone who
 * can get a URL in front of the user can call this.
 */

export const DEEP_LINK_SCHEME = 'campusconnect';

/** Longest join code and room name accepted, so a link cannot carry an essay. */
const MAX_CODE = 64;
const MAX_ROOM_NAME = 64;

/**
 * Turns a URL into something the interface can act on, or nothing at all.
 *
 * Deliberately total: anything unrecognised becomes null rather than a partly
 * understood link, because the one thing a link from outside must not do is
 * leave the interface in a state it cannot describe.
 */
export function parseDeepLink(raw: string): DeepLink | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol !== `${DEEP_LINK_SCHEME}:`) {
    return null;
  }

  /*
   * `campusconnect://join?code=…` puts the action in the hostname, while
   * `campusconnect:/join?code=…` puts it in the path. Both spellings turn up in
   * the wild depending on what wrote the link, and both mean the same thing.
   */
  const action = (url.hostname || url.pathname.replace(/^\/+/, '')).toLowerCase();

  if (action === 'join') {
    const code = (url.searchParams.get('code') ?? '').trim();
    if (!code) {
      return null;
    }

    return {
      kind: 'join',
      code: code.slice(0, MAX_CODE),
      // Cosmetic only — it names the room in the dialog and is never used to
      // decide anything. The code is the only part that admits anyone.
      roomName: (url.searchParams.get('room') ?? '').trim().slice(0, MAX_ROOM_NAME)
    };
  }

  return null;
}

/** The first `campusconnect:` URL in a command line, if there is one. */
export function deepLinkFromArgv(argv: readonly string[]): DeepLink | null {
  for (const argument of argv) {
    if (typeof argument === 'string' && argument.startsWith(`${DEEP_LINK_SCHEME}:`)) {
      const link = parseDeepLink(argument);
      if (link) {
        return link;
      }
    }
  }
  return null;
}
