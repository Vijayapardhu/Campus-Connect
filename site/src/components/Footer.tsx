import { useRef } from 'react';
import { motion, useScroll, useTransform, useReducedMotion } from 'motion/react';
import { Magnetic } from '../lib/Magnetic';
import { ICON } from '../lib/assets';
import { release } from '../data/release';
import { ArrowIcon } from './icons';

const MARK = 'Campus Connect';

/*
 * Three kinds of link, because the footer is rendered at two depths.
 *
 *   hash — a section of the landing page. On the landing page itself it stays
 *          a bare `#what`, so Lenis intercepts it and scrolls; anywhere else
 *          it has to become a real navigation to index.html.
 *   page — a directory one level down (`changelog/`, `privacy/`, ...),
 *          prefixed to get back to it. Every page but the landing one lives
 *          in its own folder with an index.html inside, so its URL is that
 *          folder's name with no extension in it anywhere.
 *   to   — absolute, used as written.
 *
 * The footer itself is rendered at two depths — root and one down — which is
 * why every relative link goes through `prefix` rather than being hardcoded.
 */
interface Column {
  heading: string;
  links: Array<{ label: string; hash?: string; page?: string; to?: string }>;
}

const COLUMNS: Column[] = [
  {
    heading: 'Product',
    links: [
      { label: 'What it does', hash: 'what' },
      { label: 'How it works', hash: 'how' },
      { label: 'Privacy', hash: 'private' },
      { label: 'Download', hash: 'get' }
    ]
  },
  {
    heading: 'Project',
    links: [
      { label: 'How it is built', page: 'build/' },
      { label: 'Source', to: 'https://github.com/Vijayapardhu/Campus-Connect' },
      { label: 'Issues', to: 'https://github.com/Vijayapardhu/Campus-Connect/issues' },
      { label: 'Releases', to: 'https://github.com/Vijayapardhu/Campus-Connect/releases' },
      { label: 'Changelog', page: 'changelog/' }
    ]
  },
  {
    heading: 'Legal',
    links: [
      { label: 'Privacy policy', page: 'privacy/' },
      { label: 'Terms', page: 'terms/' },
      { label: 'MIT licence', to: 'https://github.com/Vijayapardhu/Campus-Connect/blob/main/LICENSE' }
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

/**
 * @param prefix Path back to the site root — `./` from a root page, `../`
 *   from the build log, which sits in its own directory so its URL can drop
 *   the .html extension.
 */
export function Footer({ prefix = './' }: { prefix?: string }) {
  const atRoot = prefix === './';
  const home = atRoot ? '#top' : `${prefix}index.html`;
  /* Bare hash on the landing page so the smooth scroll survives; a real
     navigation from anywhere else, where the target is another document. */
  const section = (id: string) => (atRoot ? `#${id}` : `${prefix}index.html#${id}`);

  return (
    <footer className="footer">
      <div className="wrap footer__top">
        <div className="footer__pitch">
          <a className="brand" href={home}>
            <img src={ICON} alt="" width={27} height={27} />
            <span>Campus Connect</span>
          </a>
          <p>
            Everything between your devices. <em>None of it online.</em>
          </p>
          <Magnetic strength={8}>
            <a className="btn btn--glass btn--sm" href={section('get')}>
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
                    <a href={link.to ?? (link.hash ? section(link.hash) : `${prefix}${link.page}`)}>
                      {link.label}
                    </a>
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
