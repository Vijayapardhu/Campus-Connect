import { useEffect, useState } from 'react';
import type { Platform } from '../data/release';

/*
 * Which installer this visitor probably wants.
 *
 * A guess, and treated as one: it decides which card is promoted, never
 * which downloads are reachable. All three stay one click away, because
 * user-agent sniffing is wrong often enough — a Linux desktop reporting X11,
 * an ARM Windows machine, a browser with the string scrubbed for privacy —
 * that hiding the other two would strand people with no way back.
 *
 * Resolved in an effect rather than during render so the first paint is the
 * same for everyone. It is a one-frame correction on a section far below the
 * fold, and it keeps the initial render free of anything environment-specific.
 */
export function usePlatform(): Platform | null {
  const [platform, setPlatform] = useState<Platform | null>(null);

  useEffect(() => {
    /* userAgentData is the non-deprecated route, and it is not muddied by the
       compatibility tokens that make every user agent string claim to be
       several operating systems at once. It only exists in Chromium. */
    const hinted = (navigator as Navigator & { userAgentData?: { platform?: string } })
      .userAgentData?.platform;
    const source = hinted || navigator.userAgent;

    if (/mac|iphone|ipad|ipod/i.test(source)) setPlatform('mac');
    else if (/linux|x11|android|cros/i.test(source)) setPlatform('linux');
    else if (/win/i.test(source)) setPlatform('win');
    else setPlatform(null);
  }, []);

  return platform;
}
