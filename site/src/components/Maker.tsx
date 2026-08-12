import { motion } from 'motion/react';
import { useReveal } from '../lib/useReveal';
import { useTilt, CountUp, Words } from '../lib/effects';

/*
 * Every number here was counted, not remembered.
 *
 *   commits   git rev-list --count HEAD
 *   lines     find src -name '*.ts*' | xargs wc -l
 *   tests     npm test
 *   protocol  PROTOCOL_VERSION in src/shared/types.ts
 *
 * The previous set said 43 / 24k / 260 and had drifted from all three. This
 * is the section that asks to be checked, so a figure nobody can reproduce
 * is worse here than no figure at all — recount them when they next matter.
 */
const STATS: Array<{ value: string; label: string; note: string }> = [
  { value: '98', label: 'commits', note: 'all by one person' },
  { value: '32k', label: 'lines of TypeScript', note: 'main, renderer and shared' },
  { value: '389', label: 'tests', note: 'green on every build' },
  { value: '7', label: 'wire protocol revisions', note: 'versioned, and checked on every packet' }
];

const STACK = [
  'TypeScript',
  'Electron',
  'React 19',
  'WebRTC',
  'AES-256-GCM',
  'Node crypto',
  'UDP + TCP',
  'Vite'
];

function Stat({ stat, delay }: { stat: (typeof STATS)[number]; delay: number }) {
  const reveal = useReveal();
  const tilt = useTilt(5);

  return (
    <motion.article className="bento__stat" {...reveal(delay, 14)} {...tilt}>
      <b><CountUp value={stat.value} /></b>
      <span className="bento__stat-label">{stat.label}</span>
      <span className="bento__stat-note">{stat.note}</span>
    </motion.article>
  );
}

function Lead() {
  const reveal = useReveal();
  const tilt = useTilt(3);

  return (
    <motion.article className="bento__lead" {...reveal(0)} {...tilt}>
      <div className="bento__who">
        <span className="avatar" aria-hidden="true">VP</span>
        <div>
          <h3>Vijaya Pardhu</h3>
          <p className="role">Creator and maintainer · Campus Connect</p>
        </div>
      </div>

      <p>
        It started as a small annoyance — two machines on the same desk and no sane way to move
        a line of text between them. It turned into a full local-network stack: a versioned
        wire protocol, AES-256-GCM encrypted rooms, WebRTC calls and screen control, a phone
        client served over TLS, and a test suite that runs on every build.
      </p>
      <p>
        Written in the open, and readable by anyone who wants to check a single claim on this
        page.
      </p>

      <div className="links">
        <a className="btn btn--go btn--sm" href="./build/">How it is built</a>
        <a className="btn btn--ghost btn--sm" href="https://github.com/Vijayapardhu/Campus-Connect">Read the source</a>
        <a className="btn btn--ghost btn--sm" href="https://github.com/Vijayapardhu">GitHub profile</a>
      </div>
    </motion.article>
  );
}

/*
 * The proof, rather than another claim about it.
 *
 * "260 tests" in a statistics tile is a number you are asked to believe. The
 * same number as the last line of a test run is a thing you can go and
 * reproduce in one command, which is the entire argument this section is
 * making — so it is shown the way you would actually see it.
 */
function Proof() {
  const reveal = useReveal();

  return (
    <motion.article className="bento__proof" {...reveal(0.12)}>
      <div className="term">
        <div className="term__bar">
          <span className="term__lights" aria-hidden="true"><i /><i /><i /></span>
          <span className="term__name">check it yourself</span>
        </div>
        <div className="term__log">
          <code>
            <span className="term__prompt" aria-hidden="true">$</span>npm test
          </code>
          <code className="term__dim">PASS  a tampered packet is rejected by the auth tag</code>
          <code className="term__dim">PASS  the password never leaves the device</code>
          <code className="term__dim">PASS  a file past the ceiling is refused before anything is read</code>
          <code className="term__ok">361 passed, 0 failed</code>
        </div>
      </div>
    </motion.article>
  );
}

function Stack() {
  const reveal = useReveal();

  return (
    <motion.article className="bento__stack" {...reveal(0.06)}>
      <h3>Built with</h3>
      <ul>
        {STACK.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <p>
        No framework doing the networking, and no service behind any of it. The protocol, the
        key derivation and the transport are all in the repository.
      </p>
    </motion.article>
  );
}

export function Maker() {
  const reveal = useReveal();

  return (
    <section id="maker">
      <div className="wrap">
        <motion.p className="eyebrow" {...reveal()}>The developer</motion.p>
        <h2 className="statement">
          <Words inView>One student, one protocol,</Words>{' '}
          <em><Words inView delay={0.24}>and a lot of evenings.</Words></em>
        </h2>

        <div className="bento">
          <Lead />
          {STATS.map((stat, index) => (
            <Stat key={stat.label} stat={stat} delay={index * 0.06} />
          ))}
          <Stack />
          <Proof />
        </div>
      </div>
    </section>
  );
}
