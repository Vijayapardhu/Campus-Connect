import { useEffect } from 'react';
import Lenis from 'lenis';

/** Cleared by the fixed header, which would otherwise cover a section's first line. */
const HEADER_OFFSET = -86;

/*
 * Weighted, inertial scrolling.
 *
 * Lenis intercepts the wheel and drives `window.scrollTo` itself, which is
 * what gives the page its glide. Two consequences worth knowing:
 *
 *   1. The document's real scroll position still moves, so anything reading
 *      it — Motion's useScroll, IntersectionObserver, the header's stuck
 *      state — keeps working untouched.
 *   2. Native smooth scrolling has to be off while it runs, or an anchor
 *      jump is interpolated twice and overshoots. Lenis puts a `.lenis`
 *      class on <html>; the stylesheet keys `scroll-behavior` off that, so
 *      the native path is what remains when this hook does nothing.
 *
 * It does nothing when the reader has asked for reduced motion. Inertia is
 * exactly the kind of movement that request is about, and a page that glides
 * anyway is ignoring it.
 */
export function useSmoothScroll(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;

    const lenis = new Lenis({
      duration: 1.05,
      /* Slightly past linear at the tail, so it settles rather than stops. */
      easing: (t: number) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
      wheelMultiplier: 1,
      touchMultiplier: 1.8,
      /*
       * Touch scrolling is left to the operating system. Hijacking it costs
       * the rubber-band and the momentum the platform already does better,
       * and on iOS it fights the address bar collapsing.
       */
      syncTouch: false
    });

    let frame = requestAnimationFrame(function raf(time: number) {
      lenis.raf(time);
      frame = requestAnimationFrame(raf);
    });

    /*
     * In-page links, routed through Lenis.
     *
     * With native smooth scrolling switched off these would otherwise snap.
     * Delegated from the document so links rendered later are covered without
     * anything re-binding, and every modified click (new tab, download,
     * middle button) is handed straight back to the browser.
     */
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const link = (event.target as Element | null)?.closest?.('a[href^="#"]');
      if (!(link instanceof HTMLAnchorElement)) return;

      const id = link.getAttribute('href')?.slice(1);
      if (!id) return;

      const target = document.getElementById(id);
      if (!target) return;

      event.preventDefault();
      lenis.scrollTo(target, { offset: HEADER_OFFSET });

      /* The address bar should still name the section, but without the jump
         a normal hash change would cause on top of the animation. */
      history.pushState(null, '', `#${id}`);
    };

    document.addEventListener('click', onClick);

    return () => {
      document.removeEventListener('click', onClick);
      cancelAnimationFrame(frame);
      lenis.destroy();
    };
  }, [enabled]);
}
