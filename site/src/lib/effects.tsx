import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  animate,
  motion,
  useInView,
  useMotionValue,
  useScroll,
  useSpring,
  useTransform,
  useReducedMotion
} from 'motion/react';

const EASE: [number, number, number, number] = [0.16, 1, 0.3, 1];

/* ------------------------------------------------------------- headline -- */

interface WordsProps {
  children: string;
  /** Seconds before the first word moves. */
  delay?: number;
  /** Seconds between one word and the next. */
  step?: number;
  /**
   * Wait to be scrolled to, rather than running on load. The hero wants the
   * former; every heading below the fold wants the latter, or it plays to an
   * empty room and is already over by the time it is read.
   */
  inView?: boolean;
  className?: string;
}

/*
 * A headline that assembles itself, one word at a time.
 *
 * Fading a whole heading in as a block is a single event you either catch or
 * miss. Per word, it becomes a movement with a direction — and the blur is
 * what makes it read as coming into focus rather than sliding. Each word is
 * inline-block so it can carry a transform, with real spaces between the
 * spans rather than non-breaking ones so the line still wraps where it
 * should.
 *
 * The whole string stays in the DOM as text either way: under reduced motion
 * this returns it untouched, so nothing about the page's content depends on
 * the animation having run.
 */
export function Words({ children, delay = 0, step = 0.06, inView, className }: WordsProps) {
  const calm = useReducedMotion();
  if (calm) return <>{children}</>;

  const words = children.split(' ');
  const arrived = { opacity: 1, y: 0, filter: 'blur(0px)' };

  return (
    <>
      {words.map((word, index) => (
        <Fragment key={`${word}-${index}`}>
          <motion.span
            className={className}
            style={{ display: 'inline-block', willChange: 'transform, filter, opacity' }}
            initial={{ opacity: 0, y: '0.45em', filter: 'blur(12px)' }}
            {...(inView
              ? { whileInView: arrived, viewport: { once: true, margin: '0px 0px -18% 0px' } }
              : { animate: arrived })}
            transition={{ duration: 0.95, delay: delay + index * step, ease: EASE }}
          >
            {word}
          </motion.span>
          {index < words.length - 1 ? ' ' : null}
        </Fragment>
      ))}
    </>
  );
}

/* ----------------------------------------------------------------- tilt -- */

/*
 * A card that turns to face the cursor.
 *
 * Returns props to spread rather than a wrapper component, for the same
 * reason as useReveal: the element that tilts has to be the grid item, not a
 * div wrapped around it.
 *
 * `transformPerspective` is set on the element rather than as `perspective`
 * on the grid, because a shared perspective origin makes cards at the edge of
 * a wide row shear rather than tilt — each one should look like it is being
 * viewed head-on.
 *
 * Because this is a hook it has to be called once per card, which is why the
 * cards are their own components rather than JSX inside a `.map`.
 */
export function useTilt(maxDegrees = 7) {
  const calm = useReducedMotion();

  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const spring = { stiffness: 220, damping: 20, mass: 0.5 };
  const rotateX = useSpring(y, spring);
  const rotateY = useSpring(x, spring);

  if (calm) return {};

  return {
    style: { rotateX, rotateY, transformPerspective: 900 },
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => {
      if (event.pointerType !== 'mouse') return;
      const box = event.currentTarget.getBoundingClientRect();
      x.set(((event.clientX - (box.left + box.width / 2)) / (box.width / 2)) * maxDegrees);
      y.set(-((event.clientY - (box.top + box.height / 2)) / (box.height / 2)) * maxDegrees);
    },
    onPointerLeave: () => {
      x.set(0);
      y.set(0);
    }
  };
}

/* -------------------------------------------------------------- numbers -- */

/*
 * Splits "29k" into the part that can count and the part that cannot.
 * Anything without a leading number (there is none today, but the data is
 * editable) falls through and is printed as written.
 */
function splitNumber(value: string): { target: number; suffix: string } | null {
  const match = /^(\d+)(.*)$/.exec(value);
  return match ? { target: Number(match[1]), suffix: match[2] } : null;
}

export function CountUp({ value }: { value: string }) {
  /* Memoised so the effect below is not re-run by a fresh object identity on
     every render, which would restart the animation each time. */
  const parts = useMemo(() => splitNumber(value), [value]);
  const ref = useRef<HTMLSpanElement>(null);
  const calm = useReducedMotion();

  /*
   * No negative viewport margin.
   *
   * It used to trigger at `0px 0px -15% 0px`, which shrinks the detection box
   * by 15% of the window — and a tile sitting 695px down an 820px viewport
   * fell into the 123px that shrinking removed. It never fired.
   */
  const seen = useInView(ref, { once: true });

  const [running, setRunning] = useState(false);
  const count = useMotionValue(0);
  const shown = useTransform(count, (v) => Math.round(v).toString());

  useEffect(() => {
    if (!parts || !seen || calm) return;
    setRunning(true);
    const run = animate(count, parts.target, { duration: 1.5, ease: EASE });
    return () => run.stop();
  }, [seen, calm, parts, count]);

  if (!parts || calm) return <span ref={ref}>{value}</span>;

  /*
   * The real figure until the count actually starts.
   *
   * The motion value begins at zero because that is where the animation
   * begins, and the previous version rendered it unconditionally — so a tile
   * whose trigger never fired sat there reading "0 wire protocol revisions",
   * which is not a missing animation but a false statement. Failing to
   * animate should degrade to the truth, not to zero.
   */
  return (
    <span ref={ref}>
      {running ? <motion.span>{shown}</motion.span> : parts.target}
      {parts.suffix}
    </span>
  );
}

/* ------------------------------------------------------------- progress -- */

/*
 * How far down the page you are, as a hairline across the top.
 *
 * Sprung rather than bound straight to scroll: with Lenis already easing the
 * scroll position, a rigid bar tracks it exactly and reads as mechanical.
 * A little lag makes it feel attached to the page rather than to the wheel.
 */
export function ScrollProgress() {
  const calm = useReducedMotion();
  const { scrollYProgress } = useScroll();
  const scaleX = useSpring(scrollYProgress, { stiffness: 140, damping: 28, restDelta: 0.001 });

  if (calm) return null;
  return <motion.div className="scroll-progress" style={{ scaleX }} aria-hidden="true" />;
}

/* ------------------------------------------------------------- parallax -- */

/*
 * Moves its child against the scroll as the section passes.
 *
 * `distance` is in pixels of counter-movement across the whole pass — small
 * numbers only. Past about 60 the layer stops reading as depth and starts
 * reading as something sliding out of its box.
 */
export function Parallax({
  children,
  distance = 40,
  className
}: {
  children: ReactNode;
  distance?: number;
  className?: string;
}) {
  const calm = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'end start'] });
  const y = useTransform(scrollYProgress, [0, 1], [distance, -distance]);

  if (calm) {
    return <div className={className}>{children}</div>;
  }

  return (
    <div ref={ref} className={className}>
      <motion.div style={{ y }}>{children}</motion.div>
    </div>
  );
}
