import { useRef, useState, type ReactNode } from 'react';
import { motion, useScroll, useTransform, useMotionValueEvent, useReducedMotion } from 'motion/react';
import { useReveal } from '../lib/useReveal';
import { useMediaQuery } from '../lib/useMediaQuery';
import { Words } from '../lib/effects';
import { RoomIcon, LockIcon, PhoneIcon, ClipboardIcon } from './icons';

interface Step {
  icon: ReactNode;
  title: string;
  shot: string;
  alt: string;
  body: ReactNode;
}

const STEPS: Step[] = [
  {
    icon: <RoomIcon size={17} />,
    title: 'They find each other',
    shot: './screenshots/members-light.png',
    alt: 'The members list showing another device found on the network',
    body: (
      <>
        Install it on both machines and put them on the <strong>same WiFi</strong>. Each one
        announces itself on the local network, and the other is simply there — no pairing
        code, no account, no lookup on the way.
      </>
    )
  },
  {
    icon: <LockIcon size={17} />,
    title: 'A room gets a key',
    shot: './screenshots/create-room.png',
    alt: 'Creating a room and setting its password',
    body: (
      <>
        Make a room and give it a password. That password is put through a key derivation
        function and becomes the <strong>AES-256-GCM key</strong> for everything inside — and
        it never leaves your device, not even to prove you know it.
      </>
    )
  },
  {
    icon: <PhoneIcon size={17} />,
    title: 'Someone joins',
    shot: './screenshots/qr-code.png',
    alt: "A room's join code shown as a QR code",
    body: (
      <>
        Share the six-character code, or let the other machine <strong>scan the QR</strong>.
        The owner approves who gets in, so being on the network is not the same as being in
        the room.
      </>
    )
  },
  {
    icon: <ClipboardIcon size={17} />,
    title: 'You forget it is there',
    shot: './screenshots/clipboard-light.png',
    alt: 'Shared clipboard history filling up across devices',
    body: (
      <>
        Copy something. It is on the other machine{' '}
        <strong>before you have turned your head</strong> — and it stays in a history you can
        search, pin to and clear, on both.
      </>
    )
  }
];

/* How much scrolling each panel is worth. Below about 70 the track rushes
   past before a panel can be read; much above 110 it feels stuck. */
const SCROLL_PER_PANEL_VH = 88;

/* -------------------------------------------------------------- headline -- */

function Heading() {
  const reveal = useReveal();
  return (
    <div className="wrap">
      <motion.p className="eyebrow" {...reveal()}>How it works</motion.p>
      <h2 className="statement">
        <Words inView>Four steps.</Words>{' '}
        <em><Words inView delay={0.16}>Then you forget it is there.</Words></em>
      </h2>
    </div>
  );
}

/* ------------------------------------------------------------ horizontal -- */

/*
 * The four steps, taken sideways.
 *
 * The section pins itself and the scroll wheel drives a horizontal track
 * instead of the page — so the four steps are one continuous movement rather
 * than four blocks that happen to be stacked. It replaces a sticky screenshot
 * beside a column of text, which showed the same four things but let you skim
 * past all of them in one flick without any of them registering.
 *
 * The pinning is done with `position: sticky` inside a tall track rather than
 * by fixing anything: the scroll position stays real, so Lenis, the progress
 * bar and the browser's own find-on-page all keep working, and there is no
 * layout jump when it releases at either end.
 */
function HorizontalJourney() {
  const track = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);

  const { scrollYProgress } = useScroll({
    target: track,
    /* Starts when the pinned stage reaches the top, ends when the track's
       foot does — which is exactly the span the sticky child is stuck for. */
    offset: ['start start', 'end end']
  });

  const x = useTransform(scrollYProgress, [0, 1], ['0%', `-${(STEPS.length - 1) * 100}%`]);

  useMotionValueEvent(scrollYProgress, 'change', (value) => {
    /* Rounding rather than flooring: the label should change when a panel is
       more than half way in, not the moment the previous one starts to leave. */
    const index = Math.round(value * (STEPS.length - 1));
    setActive(Math.min(STEPS.length - 1, Math.max(0, index)));
  });

  return (
    <div
      className="journey"
      ref={track}
      style={{ height: `${STEPS.length * SCROLL_PER_PANEL_VH}vh` }}
    >
      <div className="journey__stage">
        <motion.div className="journey__rail" style={{ x }}>
          {STEPS.map((step, index) => (
            <article className="panel" key={step.title}>
              <div className="panel__inner">
                <div className="panel__copy">
                  <span className="panel__num">
                    <span className="ico">{step.icon}</span>
                    Step {String(index + 1).padStart(2, '0')}
                  </span>
                  <h3>{step.title}</h3>
                  <p>{step.body}</p>
                </div>
                <figure className="panel__shot">
                  <img src={step.shot} alt={step.alt} width={1320} height={880} loading="lazy" />
                </figure>
              </div>
            </article>
          ))}
        </motion.div>

        {/* Where you are in the four, and how far through. The dots name the
            steps for anyone who cannot see the track move. */}
        <div className="journey__hud wrap">
          <ol className="journey__dots">
            {STEPS.map((step, index) => (
              <li key={step.title} className={index === active ? 'is-on' : undefined}>
                <span className="sr-only">{step.title}</span>
              </li>
            ))}
          </ol>
          <div className="journey__rule">
            <motion.span style={{ scaleX: scrollYProgress }} />
          </div>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- stacked -- */

/*
 * The same four steps, read downward.
 *
 * Used on narrow screens and whenever motion is turned down. Pinning a
 * section and taking the scroll away from the reader is exactly the kind of
 * thing `prefers-reduced-motion` is asking you not to do, and on a phone
 * there is no width to travel across in the first place.
 */
function StackedSteps() {
  const reveal = useReveal();

  return (
    <div className="wrap stack">
      {STEPS.map((step, index) => (
        <motion.article className="stack__step" key={step.title} {...reveal(index * 0.05)}>
          <span className="panel__num">
            <span className="ico">{step.icon}</span>
            Step {String(index + 1).padStart(2, '0')}
          </span>
          <h3>{step.title}</h3>
          <p>{step.body}</p>
          <figure className="panel__shot">
            <img src={step.shot} alt={step.alt} width={1320} height={880} loading="lazy" />
          </figure>
        </motion.article>
      ))}
    </div>
  );
}

export function HowItWorks() {
  const calm = useReducedMotion();
  const wide = useMediaQuery('(min-width: 920px)');

  return (
    <section id="how" className={wide && !calm ? 'how how--pinned' : 'how'}>
      <Heading />
      {wide && !calm ? <HorizontalJourney /> : <StackedSteps />}
    </section>
  );
}
