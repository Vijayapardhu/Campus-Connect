import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  motion,
  useAnimationFrame,
  useMotionValue,
  useReducedMotion,
  useScroll,
  useSpring,
  useTransform,
  useVelocity
} from 'motion/react';

interface MarqueeProps {
  children: ReactNode;
  /** Pixels per second at rest, before scrolling adds to it. */
  speed?: number;
  /** Run right-to-left instead. Two rows in opposition read as motion; two
      rows the same way read as one thick row. */
  reverse?: boolean;
  /**
   * Where in the loop this row starts, 0–1 of one copy's width. Two rows
   * beginning at the same point line their chips up into a grid, which is
   * the one arrangement that makes them look like a table rather than a
   * surface in motion.
   */
  offset?: number;
  className?: string;
}

/*
 * A row that never reaches its end, and that answers the scroll wheel.
 *
 * Three things are going on.
 *
 * The loop: the content is repeated and the strip is translated by the width
 * of one copy, then wrapped. Because the wrap lands on an identical copy
 * there is no seam, and the loop needs to know nothing about how many items
 * there are or how wide they are together.
 *
 * The count: enough copies to cover the viewport *after* a full wrap, worked
 * out from the measured widths rather than assumed. Two was the obvious
 * number and it was wrong — one copy of the top row measures 912px against a
 * 1265px window, so at the moment the strip wrapped there were only 912px of
 * content left to fill 1265px and a 353px hole opened at the right-hand
 * edge, once per cycle, on every screen wider than the row. That is the
 * "not filled" this fixes.
 *
 * The coupling: the row's speed is added to by how fast the page is
 * scrolling, and its direction flips to match. Scroll and it surges the way
 * you are going; stop and it settles back to its own drift. The velocity is
 * sprung before it is used, so a flick of the wheel becomes a swell rather
 * than a jolt.
 *
 * None of this is a CSS animation, because a keyframe cannot be sped up
 * mid-flight, cannot be paused on hover without restarting, and cannot stop
 * when the row is off screen.
 */
export function Marquee({ children, speed = 40, reverse = false, offset = 0, className }: MarqueeProps) {
  const calm = useReducedMotion();
  const host = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const span = useRef(0);
  const seeded = useRef(false);
  const [copies, setCopies] = useState(2);
  const [held, setHeld] = useState(false);
  const x = useMotionValue(0);

  const { scrollY } = useScroll();
  const velocity = useVelocity(scrollY);
  const smoothed = useSpring(velocity, { damping: 48, stiffness: 380 });

  /*
   * Scroll speed as a multiplier on the drift. Unclamped on purpose — a hard
   * flick should be allowed past the end of the range, because a ceiling is
   * what would make fast scrolling feel like it had stopped mattering.
   */
  const surge = useTransform(smoothed, [-1400, 0, 1400], [-3.2, 0, 3.2], { clamp: false });

  /* Which way it is travelling: its own direction until the scroll overrules
     it, and back again once the scroll stops. */
  const heading = useRef(reverse ? 1 : -1);

  const measure = useCallback(() => {
    const strip = row.current;
    const frame = host.current;
    if (!strip || !frame) return;

    const width = strip.getBoundingClientRect().width;
    if (!width) return;
    span.current = width;

    /*
     * After a wrap the first copy has been consumed, so the remaining
     * `copies - 1` have to span the frame on their own. The +1 is that
     * consumed copy; the floor of 2 keeps a seamless loop on a row that is
     * already wider than the window.
     */
    const needed = Math.max(2, Math.ceil(frame.getBoundingClientRect().width / width) + 1);
    setCopies((current) => (current === needed ? current : needed));

    /* Seeded once, and only after there is a real width to take a fraction
       of — before the font resolves, `offset` of nothing is nothing. */
    if (!seeded.current) {
      x.set(-width * offset);
      seeded.current = true;
    }
  }, [offset, x]);

  useEffect(() => {
    const strip = row.current;
    const frame = host.current;
    if (!strip || !frame) return;

    measure();

    /* The row's own width settles the count; the frame's width decides how
       many of them are needed. Both have to be watched. */
    const watcher = new ResizeObserver(measure);
    watcher.observe(strip);
    watcher.observe(frame);

    /* Chips are text, so they resize when Inter replaces the fallback face.
       Re-measuring then is what keeps the wrap exact. */
    document.fonts?.ready.then(measure).catch(() => {});

    return () => watcher.disconnect();
  }, [measure]);

  useAnimationFrame((_time, delta) => {
    if (calm || held) return;
    const width = span.current;
    if (!width) return;

    const pushed = surge.get();
    if (pushed < 0) heading.current = reverse ? 1 : -1;
    else if (pushed > 0) heading.current = reverse ? -1 : 1;

    /* Base drift, then the same again scaled by how hard the page is moving. */
    const base = heading.current * speed * (delta / 1000);
    let next = x.get() + base + base * Math.abs(pushed);

    /* Wrapped in a loop rather than with a single correction: a long frame —
       a tab coming back from the background, or a hard scroll — can leave the
       offset more than one span out, and a single add would snap. */
    while (next <= -width) next += width;
    while (next > 0) next -= width;
    x.set(next);
  });

  return (
    <div
      className={className ? `marquee ${className}` : 'marquee'}
      ref={host}
      /*
       * Held rather than stopped: the row keeps its position and picks up
       * where it was. Pausing is what makes the chips readable — they are the
       * one place on the page that says what the product does in single
       * words, and they were sliding past too fast to finish.
       */
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
    >
      <motion.div className="marquee__track" style={{ x }}>
        {Array.from({ length: copies }, (_, index) => (
          <div
            key={index}
            className="marquee__row"
            /* The first copy is the content; the rest are the loop. */
            ref={index === 0 ? row : undefined}
            aria-hidden={index === 0 ? undefined : true}
          >
            {children}
          </div>
        ))}
      </motion.div>
    </div>
  );
}
