import { lazy, Suspense, useRef } from 'react';
import { motion, useScroll, useTransform, useReducedMotion } from 'motion/react';
import { Magnetic } from '../lib/Magnetic';
import { Words } from '../lib/effects';
import { Marquee } from './Marquee';
import { release } from '../data/release';
import {
  ClipboardIcon,
  TransferIcon,
  RoomIcon,
  CallIcon,
  ScreenIcon,
  PhoneIcon,
  LockIcon,
  SearchIcon,
  ShareIcon,
  NoWifiIcon
} from './icons';

/*
 * Three.js is roughly three quarters of the JavaScript on this page and none
 * of it is needed to read a word. Split out, the document, the styles and the
 * rest of the bundle arrive first and the shader follows into a background
 * that already has a gradient in it — so nothing is ever missing, it just
 * starts moving a moment later.
 */
const HeroCanvas = lazy(() =>
  import('../three/HeroCanvas').then((module) => ({ default: module.HeroCanvas }))
);

/*
 * The capability strip under the fold — what the product does, at a glance,
 * before anyone has scrolled far enough to read about any of it.
 *
 * Two rows travelling opposite ways. One row reads as a ticker and the eye
 * skips it; two in opposition read as a surface in motion, and the chips
 * that matter get a second pass in the other direction. Hovering either row
 * holds it, because a label nobody can finish reading is decoration.
 */
const CHIPS_TOP = [
  { icon: <ClipboardIcon size={15} />, label: 'Clipboard sync' },
  { icon: <TransferIcon size={15} />, label: 'Direct file transfer' },
  { icon: <RoomIcon size={15} />, label: 'Encrypted rooms' },
  { icon: <CallIcon size={15} />, label: 'Voice and video' },
  { icon: <ShareIcon size={15} />, label: 'Screen sharing' }
];

const CHIPS_BOTTOM = [
  { icon: <ScreenIcon size={15} />, label: 'Remote desktop' },
  { icon: <PhoneIcon size={15} />, label: 'Phone, nothing to install' },
  { icon: <LockIcon size={15} />, label: 'AES-256-GCM' },
  { icon: <SearchIcon size={15} />, label: 'Searchable history' },
  { icon: <NoWifiIcon size={15} />, label: 'Works with no internet' }
];

function Chip({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <span className="chip">
      <span className="chip__mark">{icon}</span>
      {label}
    </span>
  );
}

export function Hero() {
  const calm = useReducedMotion();
  const showcase = useRef<HTMLDivElement>(null);

  /*
   * The screenshot rises into place as it is scrolled toward.
   *
   * Tracked from the moment its top edge enters the viewport to the moment
   * that edge is a third of the way up it, which is roughly the window in
   * which it is being looked at rather than glanced past. Tying it to scroll
   * rather than firing a one-shot animation means turning back retraces it,
   * so the page does not feel like a slideshow that has already been played.
   */
  const { scrollYProgress } = useScroll({
    target: showcase,
    offset: ['start end', 'start 0.32']
  });

  const rotateX = useTransform(scrollYProgress, [0, 1], [9, 0]);
  const scale = useTransform(scrollYProgress, [0, 1], [0.93, 1]);
  const y = useTransform(scrollYProgress, [0, 1], [40, 0]);

  return (
    <section className="hero mid" id="top">
      <Suspense fallback={<div className="hero-canvas hero-canvas--still" />}>
        <HeroCanvas />
      </Suspense>

      <div className="wrap">
        <motion.span
          className="tagline"
          initial={calm ? false : { opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.05, ease: [0.16, 1, 0.3, 1] }}
        >
          <i />
          Version {release.version}
          <span className="tagline__more">&nbsp;— now with peer-to-peer file transfer</span>
        </motion.span>

        <h1>
          <Words delay={0.18}>The campus network,</Words>{' '}
          <em><Words delay={0.4}>finally useful.</Words></em>
        </h1>

        {/*
          * Two lengths of the same sentence.
          *
          * The full one ran to seven lines on a 375px screen, which put the
          * download button below the fold on the one page where it should
          * never be. Swapped in CSS rather than by measuring the window, so
          * there is no flash of the wrong one and nothing to recompute on
          * rotate; `display: none` also keeps the unused copy out of the
          * accessibility tree, so it is never read twice.
          */}
        <motion.p
          className="lede"
          initial={calm ? false : { opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.85, delay: 0.62, ease: [0.16, 1, 0.3, 1] }}
        >
          <span className="lede__full">
            Share a clipboard, send a file, start a call or take over a screen — between the
            machines already sitting on your college WiFi. No account, no server, and nothing
            that has to leave the building to get to the desk beside you.
          </span>
          <span className="lede__short">
            Clipboard, files, calls and screens — straight between the machines on your college
            WiFi. No account, no server, nothing online.
          </span>
        </motion.p>

        <motion.div
          className="hero-actions"
          initial={calm ? false : { opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.85, delay: 0.74, ease: [0.16, 1, 0.3, 1] }}
        >
          <Magnetic>
            <a className="btn btn--go" href="#get">Download for free</a>
          </Magnetic>
          <Magnetic>
            <a className="btn btn--ghost" href="#campus">See what it solves</a>
          </Magnetic>
        </motion.div>

        <motion.p
          className="hero-note"
          initial={calm ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.85, delay: 0.86 }}
        >
          Windows, macOS and Linux · and your phone, from its browser · MIT licensed
        </motion.p>
      </div>

      <motion.div
        initial={calm ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 1, delay: 0.98 }}
        style={{ marginTop: 46 }}
      >
        <div className="rails">
          <Marquee speed={38}>
            {CHIPS_TOP.map((chip) => <Chip key={chip.label} {...chip} />)}
          </Marquee>
          <Marquee speed={30} reverse offset={0.5}>
            {CHIPS_BOTTOM.map((chip) => <Chip key={chip.label} {...chip} />)}
          </Marquee>
        </div>
      </motion.div>

      <div className="wrap">
        <div className="showcase" ref={showcase}>
          <motion.div
            className="frame"
            style={calm ? undefined : { rotateX, scale, y, transformOrigin: '50% 100%' }}
          >
            <img
              src="./screenshots/clipboard-light.png"
              alt="Campus Connect showing shared clipboard history"
              width={1320}
              height={880}
              fetchPriority="high"
            />
          </motion.div>
        </div>
      </div>
    </section>
  );
}
