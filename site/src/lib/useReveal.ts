import { useReducedMotion } from 'motion/react';

/*
 * Annotated as a tuple rather than left to inference.
 *
 * Written inline inside JSX the contextual type makes this a cubic bezier;
 * built out here it widens to number[], which Motion's Transition will not
 * accept — the four control points are a fixed-length thing.
 */
const EASE: [number, number, number, number] = [0.16, 1, 0.3, 1];

/*
 * Arrival props, spread onto whichever element is arriving.
 *
 * This started as a <Reveal> component that wrapped its children in a div,
 * which quietly broke every sibling selector in the stylesheet — most
 * visibly `.statement + .lede`, so a heading and its opening paragraph ended
 * up jammed together — and put a plain div between `.grid` and the `.card`
 * that was supposed to be its grid item. Handing back props instead means
 * the element that animates is the element the CSS is written for, and
 * anything else it needs (a pointer handler, an href, a download attribute)
 * is just written on it as usual.
 *
 * Returns a factory rather than the props themselves so a `.map` can stagger
 * its items without calling a hook in a loop.
 *
 * `once: true` because an element that re-animates every time it re-enters
 * turns scrolling back up into a light show. The viewport margin pulls the
 * trigger line up off the very bottom of the window, so things start moving
 * while they are still being scrolled toward rather than after they land.
 */
export function useReveal() {
  const calm = useReducedMotion();

  return (delay = 0, y = 20) =>
    calm
      ? {}
      : {
          initial: { opacity: 0, y },
          whileInView: { opacity: 1, y: 0 },
          viewport: { once: true, margin: '0px 0px -12% 0px' },
          transition: { duration: 0.8, delay, ease: EASE }
        };
}
