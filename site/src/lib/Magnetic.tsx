import { useRef, type ReactNode } from 'react';
import { motion, useMotionValue, useSpring, useReducedMotion } from 'motion/react';

interface MagneticProps {
  children: ReactNode;
  /** How far the element is allowed to travel toward the cursor, in pixels. */
  strength?: number;
  className?: string;
}

/*
 * A control that leans toward the cursor.
 *
 * The pull is proportional to how far into the element the pointer is, capped
 * at `strength` so a wide button does not slide half its own width. A spring
 * rather than a tween because the interesting part is the release: the value
 * is set straight back to zero on leave and the spring carries it home.
 *
 * Two things switch it off. Reduced motion, for the obvious reason. And a
 * coarse pointer — on a touchscreen there is no hover to respond to, and the
 * effect would only fire as a jump at the moment of tapping.
 */
export function Magnetic({ children, strength = 12, className }: MagneticProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const calm = useReducedMotion();

  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const spring = { stiffness: 260, damping: 18, mass: 0.6 };
  const springX = useSpring(x, spring);
  const springY = useSpring(y, spring);

  if (calm) {
    return <span className={className ? `magnet ${className}` : 'magnet'}>{children}</span>;
  }

  return (
    <motion.span
      ref={ref}
      className={className ? `magnet ${className}` : 'magnet'}
      style={{ x: springX, y: springY }}
      onPointerMove={(event) => {
        if (event.pointerType !== 'mouse') return;
        const box = ref.current?.getBoundingClientRect();
        if (!box) return;

        const dx = (event.clientX - (box.left + box.width / 2)) / (box.width / 2);
        const dy = (event.clientY - (box.top + box.height / 2)) / (box.height / 2);
        x.set(Math.max(-1, Math.min(1, dx)) * strength);
        y.set(Math.max(-1, Math.min(1, dy)) * strength);
      }}
      onPointerLeave={() => {
        x.set(0);
        y.set(0);
      }}
    >
      {children}
    </motion.span>
  );
}
