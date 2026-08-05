import { motion } from 'motion/react';
import { useReveal } from '../lib/useReveal';
import { useSmoothScroll } from '../lib/useSmoothScroll';
import { CountUp, ScrollProgress, Words } from '../lib/effects';
import { useReducedMotion } from 'motion/react';
import { Magnetic } from '../lib/Magnetic';
import { ICON } from '../lib/assets';
import { Footer } from './Footer';
import { ArrowIcon } from './icons';
import { STATS, TIMELINE, MODULES, AREAS, MISSTEPS } from '../data/build';
import {
  STACK,
  ROOM_TYPES,
  ADMISSION,
  NOT_PROTECTED,
  MESSAGES,
  TEST_AREAS,
  STORED
} from '../data/buildDetail';

/* ---------------------------------------------------------------- chrome -- */

/*
 * This page is served from /build/, so everything at the site root is one
 * directory up. The same goes for the footer, which takes a prefix.
 */
const ROOT = '../';

function Header() {
  return (
    <header className="is-stuck">
      <div className="wrap bar">
        <a className="brand" href={`${ROOT}index.html`}>
          <img src={ICON} alt="" width={27} height={27} />
          <span>Campus Connect</span>
        </a>
        <nav>
          <a className="hide-sm" href={`${ROOT}index.html#what`}>What it does</a>
          <a className="hide-sm" href={`${ROOT}index.html#private`}>Privacy</a>
          <a className="hide-sm" href={`${ROOT}changelog.html`}>Changelog</a>
          <Magnetic strength={7}>
            <a className="btn btn--go btn--sm" href={`${ROOT}index.html#get`}>Download</a>
          </Magnetic>
        </nav>
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------ page -- */

/*
 * The engineering record.
 *
 * Everything on this page is derived from the repository — commit counts,
 * tags, line counts, the test total — and the commands that produce each
 * figure are written into src/data/build.ts beside the data. The point of
 * the page is that a reader can go and check any of it, which only works if
 * nothing on it was estimated.
 *
 * It includes the mistakes. Fifteen of forty-three commits are the project
 * correcting itself, and a build log that lists only what went right is a
 * marketing page wearing a lab coat.
 */
export default function BuildLog() {
  const calm = useReducedMotion();
  useSmoothScroll(!calm);
  const reveal = useReveal();

  return (
    <>
      <ScrollProgress />
      <Header />

      <main>
        {/* ------------------------------------------------------- opening -- */}
        <section className="log-hero">
          <div className="wrap">
            <motion.p className="eyebrow" {...reveal()}>The build log</motion.p>
            <h1>
              <Words delay={0.1}>Forty-three commits,</Words>{' '}
              <em><Words delay={0.35}>and what each one cost.</Words></em>
            </h1>
            <motion.p className="lede" {...reveal(0.5)}>
              Every module in Campus Connect, what it does, what it is built on and why it is built
              that way — with the releases it took to get there and the things that broke on the way.
              Each figure below comes out of the repository; the commands that produce them are in
              the source of this page.
            </motion.p>

            <div className="log-stats">
              {STATS.map((stat, index) => (
                <motion.div className="log-stat" key={stat.label} {...reveal(0.55 + index * 0.05, 14)}>
                  <b><CountUp value={stat.value} /></b>
                  <span className="log-stat__label">{stat.label}</span>
                  <span className="log-stat__note">{stat.note}</span>
                </motion.div>
              ))}
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------ timeline -- */}
        <section id="timeline">
          <div className="wrap">
            <motion.p className="eyebrow" {...reveal()}>How it went</motion.p>
            <h2 className="statement">
              <Words inView>Six days with commits in them,</Words>{' '}
              <em><Words inView delay={0.28}>inside a ten-day span.</Words></em>
            </h2>
            <motion.p className="lede" {...reveal(0.12)}>
              Nineteen tagged releases, most of them on the day the work landed. A version number
              here is closer to a save point than an announcement.
            </motion.p>

            <ol className="track">
              {TIMELINE.map((day, index) => (
                <motion.li className="track__day" key={day.date} {...reveal(index * 0.05, 16)}>
                  <div className="track__when">
                    <b>{day.date}</b>
                    <span>{day.commits} commits</span>
                  </div>
                  <div className="track__what">
                    <h3>{day.title}</h3>
                    <p>{day.body}</p>
                    <ul className="track__tags">
                      {day.releases.map((tag) => (
                        <li key={tag}>{tag}</li>
                      ))}
                    </ul>
                  </div>
                </motion.li>
              ))}
            </ol>
          </div>
        </section>

        {/* ------------------------------------------------------- modules -- */}
        <section id="modules">
          <div className="wrap">
            <motion.p className="eyebrow" {...reveal()}>The modules</motion.p>
            <h2 className="statement">
              <Words inView>Fifty-five files.</Words>{' '}
              <em><Words inView delay={0.2}>These are the ones that matter.</Words></em>
            </h2>

            <div className="areas">
              {AREAS.map((area, index) => (
                <motion.div className="area" key={area.area} {...reveal(index * 0.06, 14)}>
                  <code>{area.area}</code>
                  <b>{area.lines.toLocaleString()}</b>
                  <span>{area.files} files</span>
                  <p>{area.what}</p>
                </motion.div>
              ))}
            </div>

            <div className="mods">
              {MODULES.map((mod, index) => (
                <motion.article className="mod" key={mod.name} {...reveal(index * 0.04, 16)}>
                  <div className="mod__head">
                    <code>{mod.name}</code>
                    <span className="mod__lines">{mod.lines.toLocaleString()} lines</span>
                  </div>
                  <h3>{mod.role}</h3>
                  <p>{mod.detail}</p>
                  <ul className="mod__uses">
                    {mod.uses.map((use) => (
                      <li key={use}>{use}</li>
                    ))}
                  </ul>
                </motion.article>
              ))}
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------- stack -- */}
        <section id="stack">
          <div className="wrap">
            <motion.p className="eyebrow" {...reveal()}>What it runs on</motion.p>
            <h2 className="statement">
              <Words inView>Two processes,</Words>{' '}
              <em><Words inView delay={0.18}>and one channel between them.</Words></em>
            </h2>
            <motion.p className="lede" {...reveal(0.12)}>
              The main process is Node: sockets, crypto, storage, the phone server, input injection.
              The renderer is Chromium with <code>contextIsolation</code> on and{' '}
              <code>nodeIntegration</code> off, so it has no Node access at all — every privileged
              operation goes through a named IPC channel declared in one file,{' '}
              <code>src/shared/bridge.ts</code>. Nothing else crosses.
            </motion.p>

            <motion.div className="spec" {...reveal(0.18)}>
              <table>
                <tbody>
                  {STACK.map(([layer, tech]) => (
                    <tr key={layer}>
                      <th scope="row">{layer}</th>
                      <td>{tech}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </motion.div>
          </div>
        </section>

        {/* ------------------------------------------------------- security -- */}
        <section id="security">
          <div className="wrap">
            <motion.p className="eyebrow" {...reveal()}>Security</motion.p>
            <h2 className="statement">
              <Words inView>The room model only means something</Words>{' '}
              <em><Words inView delay={0.34}>if these rules hold.</Words></em>
            </h2>

            <motion.div className="chain" {...reveal(0.12)}>
              <code>roomKey = scrypt(password, keySalt, 32 bytes, N=32768, r=8, p=1)</code>
              <p>
                The salt is 16 random bytes made when the room is created. It is public — it travels
                in the advert — and useless without the password. The cost is tuned to about 100ms,
                high enough that brute-forcing captured traffic is expensive and low enough that a
                person joining a room does not notice it. <strong>The password itself is never
                transmitted.</strong> It exists only as an input to scrypt, on each device.
              </p>
            </motion.div>

            <motion.h3 className="sub" {...reveal(0.16)}>Three kinds of room</motion.h3>
            <motion.div className="spec spec--wide" {...reveal(0.18)}>
              <table>
                <thead>
                  <tr><th>Type</th><th>Password</th><th>To join</th><th>Traffic</th></tr>
                </thead>
                <tbody>
                  {ROOM_TYPES.map((room) => (
                    <tr key={room.type}>
                      <th scope="row">{room.type}</th>
                      <td>{room.password}</td>
                      <td>{room.join}</td>
                      <td>{room.traffic}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </motion.div>

            <motion.h3 className="sub" {...reveal(0.2)}>Proving the password without sending it</motion.h3>
            <motion.p className="body" {...reveal(0.22)}>
              A device asking to join derives the key and seals a known constant with it. The owner
              opens that envelope with its own key and compares the result using{' '}
              <code>timingSafeEqual</code>. Only a device holding the right key can produce an
              envelope the owner can open — so the owner learns "this device knows the password"
              without the password ever crossing the wire. The constant is bound to the room id, so
              a proof captured from one room cannot be replayed at another.
            </motion.p>

            <motion.h3 className="sub" {...reveal(0.24)}>Four checks before anything is applied</motion.h3>
            <motion.p className="body" {...reveal(0.26)}>
              Every inbound clipboard or chat packet has to satisfy all four. Anything else is
              dropped and logged — without the third, a non-member's packet would be applied simply
              because it arrived.
            </motion.p>
            <ol className="gate">
              {ADMISSION.map((rule, index) => (
                <motion.li key={rule} {...reveal(0.28 + index * 0.04, 12)}>
                  <b>{index + 1}</b>
                  <span>{rule}</span>
                </motion.li>
              ))}
            </ol>

            <motion.h3 className="sub" {...reveal(0.3)}>And what is not protected</motion.h3>
            <motion.p className="body" {...reveal(0.32)}>
              A security page that only lists strengths is not telling you anything.
            </motion.p>
            <div className="honest">
              {NOT_PROTECTED.map((item, index) => (
                <motion.div className="honest__item" key={item.what} {...reveal(0.34 + index * 0.03, 12)}>
                  <b>{item.what}</b>
                  <p>{item.why}</p>
                </motion.div>
              ))}
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------- protocol -- */}
        <section id="protocol">
          <div className="wrap">
            <motion.p className="eyebrow" {...reveal()}>The wire protocol</motion.p>
            <h2 className="statement">
              <Words inView>Twenty message types,</Words>{' '}
              <em><Words inView delay={0.22}>and two ways to carry them.</Words></em>
            </h2>
            <motion.p className="lede" {...reveal(0.12)}>
              UDP broadcast is how devices find each other, and is all an ordinary network needs.
              Plenty of networks are not ordinary — many campus deployments filter broadcast, and
              some filter UDP entirely while leaving TCP alone — so every device also listens on TCP
              37777. Frames arriving either way go through the same handler and the same four checks.
              It is a different pipe, not a different set of rules.
            </motion.p>

            <motion.div className="note" {...reveal(0.16)}>
              <p>
                TCP is a byte stream, so each message is framed as a four-byte big-endian length
                followed by that many bytes of JSON. The length is checked <em>before</em> anything
                is buffered, which is what stops a hostile peer announcing a 4GB frame. No chunking
                is needed there — ordering and delivery are already guaranteed, and on loopback an
                8MB payload arrives in 0.3s against 1.8s for the same payload chunked over UDP.
              </p>
              <p>
                Client isolation defeats both. When the access point drops packets between two of its
                own clients, TCP fails exactly as UDP does. No transport, port or protocol changes
                that — it is enforced upstream of the application, and Settings → Network says so
                rather than pretending otherwise.
              </p>
            </motion.div>

            <motion.div className="spec spec--wide" {...reveal(0.2)}>
              <table>
                <thead>
                  <tr><th>Type</th><th>Direction</th><th>Purpose</th></tr>
                </thead>
                <tbody>
                  {MESSAGES.map((message) => (
                    <tr key={message.type}>
                      <th scope="row"><code>{message.type}</code></th>
                      <td>{message.direction}</td>
                      <td>{message.purpose}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </motion.div>
          </div>
        </section>

        {/* ---------------------------------------------------------- state -- */}
        <section id="state">
          <div className="wrap">
            <motion.p className="eyebrow" {...reveal()}>What is kept</motion.p>
            <h2 className="statement">
              <Words inView>One file on your machine,</Words>{' '}
              <em><Words inView delay={0.24}>and nothing anywhere else.</Words></em>
            </h2>
            <motion.p className="lede" {...reveal(0.12)}>
              All of it lives in electron-store, under your own user profile. There is no other copy,
              because there is nowhere else for one to be.
            </motion.p>

            <motion.div className="spec" {...reveal(0.16)}>
              <table>
                <tbody>
                  {STORED.map(([key, what]) => (
                    <tr key={key}>
                      <th scope="row"><code>{key}</code></th>
                      <td>{what}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </motion.div>
          </div>
        </section>

        {/* -------------------------------------------------------- testing -- */}
        <section id="tests">
          <div className="wrap">
            <motion.p className="eyebrow" {...reveal()}>Testing</motion.p>
            <h2 className="statement">
              <Words inView>248 assertions,</Words>{' '}
              <em><Words inView delay={0.2}>and no test framework.</Words></em>
            </h2>
            <motion.p className="lede" {...reveal(0.12)}>
              The modules that matter — crypto, rooms, history, chunking, file sharing — are free of
              Electron imports, so the suite requires them straight out of the build and runs in
              plain Node. No framework, no dependencies, one file.
            </motion.p>

            <div className="tests">
              {TEST_AREAS.map((area, index) => (
                <motion.article className="tests__area" key={area.area} {...reveal(index * 0.05, 14)}>
                  <h3>{area.area}</h3>
                  <p>{area.asserts}</p>
                </motion.article>
              ))}
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------- missteps -- */}
        <section id="broke">
          <div className="wrap">
            <motion.p className="eyebrow" {...reveal()}>What broke</motion.p>
            <h2 className="statement">
              <Words inView>Fifteen of the forty-three commits</Words>{' '}
              <em><Words inView delay={0.3}>are the project correcting itself.</Words></em>
            </h2>
            <motion.p className="lede" {...reveal(0.12)}>
              These are real commit subjects, in the words they were committed in. A build log that
              lists only what went right is a marketing page wearing a lab coat.
            </motion.p>

            <div className="broke">
              {MISSTEPS.map((step, index) => (
                <motion.article className="broke__item" key={step.commit} {...reveal(index * 0.04, 14)}>
                  <div className="broke__meta">
                    <span className="broke__date">{step.date}</span>
                  </div>
                  <div>
                    <p className="broke__commit">{step.commit}</p>
                    <p className="broke__lesson">{step.lesson}</p>
                  </div>
                </motion.article>
              ))}
            </div>
          </div>
        </section>

        {/* ----------------------------------------------------------- out -- */}
        <section id="read">
          <div className="wrap mid">
            <motion.h2 className="statement" {...reveal()}>
              All of it is in the repository.
            </motion.h2>
            <motion.p className="lede" {...reveal(0.08)}>
              Nothing on this page is a claim you have to take on trust. The protocol, the key
              derivation, the transport and the tests are all readable, and the commands that produce
              every number here are in the source of the page you are reading.
            </motion.p>
            <motion.div className="hero-actions" {...reveal(0.16)}>
              <Magnetic>
                <a className="btn btn--go" href="https://github.com/Vijayapardhu/Clipboard">
                  Read the source <ArrowIcon />
                </a>
              </Magnetic>
              <Magnetic>
                <a className="btn btn--ghost" href={`${ROOT}index.html#get`}>Download the app</a>
              </Magnetic>
            </motion.div>
          </div>
        </section>
      </main>

      <Footer prefix={ROOT} />
    </>
  );
}
