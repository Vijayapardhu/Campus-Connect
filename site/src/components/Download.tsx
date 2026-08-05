import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useReveal } from '../lib/useReveal';
import { useTilt, Words } from '../lib/effects';
import { Magnetic } from '../lib/Magnetic';
import { usePlatform } from '../lib/usePlatform';
import { release, type Platform } from '../data/release';
import { WindowsMark, AppleMark, LinuxMark, ArrowIcon } from './icons';

interface PlatformCard {
  key: Platform;
  mark: ReactNode;
  name: string;
  detail: string;
  needs: string;
}

const PLATFORMS: PlatformCard[] = [
  {
    key: 'win',
    mark: <WindowsMark />,
    name: 'Windows',
    detail: 'Installer · 64-bit',
    needs: 'Windows 10 or 11'
  },
  {
    key: 'mac',
    mark: <AppleMark />,
    name: 'macOS',
    detail: 'Universal · Apple silicon and Intel',
    needs: 'macOS 11 Big Sur or later'
  },
  {
    key: 'linux',
    mark: <LinuxMark />,
    name: 'Linux',
    detail: 'AppImage · x86_64',
    needs: 'Any distribution with FUSE'
  }
];

const TERMINAL_COMMAND = 'npx campus-connect';

/* ---------------------------------------------------------- the one line -- */

/*
 * The other way in, given a block of its own rather than a footnote.
 *
 * The installer is still the headline — most people want a file, and it is
 * the only route that gets desktop shortcuts and auto-update. But a single
 * command that needs nothing downloaded and nothing installed is the fastest
 * possible first run, and it was previously a grey line of monospace at the
 * bottom of the section that read as a footnote to the real answer.
 *
 * Dressed as a terminal because that is the thing it is asking you to open,
 * and dark because every terminal is: it is the one place on this page where
 * a light panel would be the surprising choice.
 */
function InstallCommand() {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  /* A component unmounted mid-countdown would otherwise set state on the way
     out, and the timer would outlive the thing it was going to update. */
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(TERMINAL_COMMAND);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1900);
    } catch {
      /* Denied permission, or an insecure origin. The command is on screen
         and selectable either way, so there is nothing useful to report. */
    }
  };

  return (
    <div className="install">
      <div className="install__intro">
        <h3>Or run it with one line.</h3>
        <p>Nothing downloaded, nothing installed. Needs Node 18 or later.</p>
      </div>

      <div className="term">
        <div className="term__bar">
          <span className="term__lights" aria-hidden="true"><i /><i /><i /></span>
          <span className="term__name">campus-connect</span>
        </div>

        <div className="term__body">
          <code>
            <span className="term__prompt" aria-hidden="true">$</span>
            {TERMINAL_COMMAND}
          </code>
          <button type="button" className="term__copy" onClick={copy}>
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={copied ? 'done' : 'idle'}
                initial={{ opacity: 0, y: 7 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -7 }}
                transition={{ duration: 0.18 }}
              >
                {copied ? 'Copied' : 'Copy'}
              </motion.span>
            </AnimatePresence>
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- the hero -- */

/*
 * The one card for the machine you are on.
 *
 * Three equal cards made every visitor do a small job the page could do for
 * them — find their own logo, then read across to the right file. This
 * promotes the likely one to a real call to action and leaves the other two
 * as a quiet row underneath, so nobody is stranded by a wrong guess.
 */
function PrimaryDownload({ platform }: { platform: PlatformCard }) {
  const asset = release.assets[platform.key];
  const tilt = useTilt(3);

  return (
    <motion.div className="get__lead" {...tilt}>
      <span className="get__mark">{platform.mark}</span>

      <div className="get__lead-copy">
        <p className="get__for">Looks like you are on {platform.name}</p>
        <h3>Campus Connect {release.version}</h3>
        <p className="get__spec">
          {platform.detail} · {asset.size} · {platform.needs}
        </p>
      </div>

      <Magnetic strength={10}>
        <a className="btn btn--go" download href={asset.url}>
          Download for {platform.name} <ArrowIcon />
        </a>
      </Magnetic>
    </motion.div>
  );
}

function SecondaryDownload({ platform, delay }: { platform: PlatformCard; delay: number }) {
  const reveal = useReveal();
  const tilt = useTilt(5);
  const asset = release.assets[platform.key];

  return (
    <motion.a className="get__alt" download href={asset.url} {...reveal(delay, 14)} {...tilt}>
      <span className="logo">{platform.mark}</span>
      <span className="get__alt-name">
        <b>{platform.name}</b>
        <small>{platform.detail} · {asset.size}</small>
      </span>
      <span className="get__alt-go"><ArrowIcon /></span>
    </motion.a>
  );
}

/* ------------------------------------------------------------------------ */

/*
 * The buttons link straight at the installers rather than at the releases
 * page, because GitHub serves those with `Content-Disposition: attachment` —
 * the browser downloads the file and the visitor never leaves the site.
 *
 * The cost of that is a version inside every URL, which goes stale the moment
 * the next release lands. The URLs are built from release.json, and the
 * release workflow writes that file from the installers it actually
 * published. See scripts/sync-site-version.js.
 */
export function Download() {
  const reveal = useReveal();
  const detected = usePlatform();

  /* Before the guess resolves — and if it never does — the three cards are
     shown flat, which is the honest layout when nothing is known. */
  const lead = PLATFORMS.find((p) => p.key === detected) ?? null;
  const rest = lead ? PLATFORMS.filter((p) => p.key !== lead.key) : PLATFORMS;

  return (
    <section id="get">
      <div className="wrap">
        <motion.p className="eyebrow" {...reveal()}>Download</motion.p>
        <h2 className="statement">
          <Words inView>{`Version ${release.version}.`}</Words>{' '}
          <em><Words inView delay={0.16}>Free, and open source.</Words></em>
        </h2>
        <motion.p className="lede" {...reveal(0.12)}>
          Windows will say "Unknown publisher" — the installer is not code-signed yet. That is
          expected, and the source is right there if you would rather build it.
        </motion.p>

        {lead ? (
          <motion.div {...reveal(0.18)}>
            <PrimaryDownload platform={lead} />
          </motion.div>
        ) : null}

        <div className={lead ? 'get__row' : 'get__row get__row--all'}>
          {rest.map((platform, index) => (
            <SecondaryDownload key={platform.key} platform={platform} delay={index * 0.07} />
          ))}
        </div>

        <motion.div {...reveal(0.24)}>
          <InstallCommand />
        </motion.div>
      </div>
    </section>
  );
}
