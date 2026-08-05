import { useRef } from 'react';
import { motion, useScroll, useTransform, useReducedMotion } from 'motion/react';
import { Magnetic } from '../lib/Magnetic';
import { release } from '../data/release';
import { ArrowIcon } from './icons';

const MARK = 'Campus Connect';

const COLUMNS: Array<{ heading: string; links: Array<{ label: string; href: string }> }> = [
  {
    heading: 'Product',
    links: [
      { label: 'What it does', href: '#what' },
      { label: 'How it works', href: '#how' },
      { label: 'Privacy', href: '#private' },
      { label: 'Download', href: '#get' }
    ]
  },
  {
    heading: 'Project',
    links: [
      { label: 'How it is built', href: './build.html' },
      { label: 'Source', href: 'https://github.com/Vijayapardhu/Clipboard' },
      { label: 'Issues', href: 'https://github.com/Vijayapardhu/Clipboard/issues' },
      { label: 'Releases', href: 'https://github.com/Vijayapardhu/Clipboard/releases' },
      { label: 'Changelog', href: './changelog.html' }
    ]
  },
  {
    heading: 'Legal',
    links: [
      { label: 'Privacy policy', href: './privacy.html' },
      { label: 'Terms', href: './terms.html' },
      { label: 'MIT licence', href: 'https://github.com/Vijayapardhu/Clipboard/blob/main/LICENSE' }
    ]
  }
];

/*
 * The wordmark that closes the page.
 *
 * Cut from brushed glass: a vertical ramp pitched to start well short of
 * white and finish close to the colour behind the baseline, so the letters
 * are most of the way into the dark before the mask finishes the job. One
 * line, dissolving into the ground rather than being cropped by it.
 *
 * Nothing here reacts to the pointer. It carried a cursor-tracked dark patch
 * and a dimension probe, which were interesting to look at and wrong for the
 * job: this is the last thing on the page, after the reader has finished,
 * and something that responds to the mouse asks to be played with rather
 * than read past. The only movement left is a slight rise as the footer is
 * scrolled into place, which is the same treatment every other section gets.
 */
function Wordmark() {
  const ref = useRef<HTMLDivElement>(null);
  const calm = useReducedMotion();

  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'end end'] });
  const y = useTransform(scrollYProgress, [0, 1], ['14%', '0%']);

  return (
    <div className="wordmark" ref={ref} aria-hidden="true">
      <motion.span className="wordmark__text" style={calm ? undefined : { y }}>
        {MARK}
      </motion.span>
    </div>
  );
}

export function Footer() {
  return (
    <footer className="footer">
      <div className="wrap footer__top">
        <div className="footer__pitch">
          <a className="brand" href="#top">
            <img src="./icon.png" alt="" width={27} height={27} />
            <span>Campus Connect</span>
          </a>
          <p>
            Everything between your devices. <em>None of it online.</em>
          </p>
          <Magnetic strength={8}>
            <a className="btn btn--glass btn--sm" href="#get">
              Download {release.version} <ArrowIcon />
            </a>
          </Magnetic>
        </div>

        <nav className="footer__nav">
          {COLUMNS.map((column) => (
            <div key={column.heading}>
              <h2>{column.heading}</h2>
              <ul>
                {column.links.map((link) => (
                  <li key={link.label}>
                    <a href={link.href}>{link.label}</a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        <a className="footer__up" href="#top">
          <span>Back to top</span>
          <i>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 19V6M6 12l6-6 6 6" />
            </svg>
          </i>
        </a>
      </div>

      {/*
        * The status line. Every claim on this page is checkable, and these
        * are the facts that say which version of it you are reading.
        */}
      <div className="wrap footer__meta">
        <span className="footer__live"><i className="dot" /> v{release.version} · protocol stable</span>
        <span>MIT licensed</span>
        <span>No servers · no accounts · no analytics</span>
        <span className="footer__by">
          Built by <a href="https://github.com/Vijayapardhu">Vijaya Pardhu</a>
        </span>
      </div>

      <Wordmark />
    </footer>
  );
}
