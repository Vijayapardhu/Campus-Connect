import type { ReactNode, PointerEvent } from 'react';
import { motion } from 'motion/react';
import { useReveal } from '../lib/useReveal';
import { useTilt, Words } from '../lib/effects';
import {
  ScreenIcon,
  PeopleIcon,
  PresentIcon,
  NoWifiIcon,
  ClipboardIcon,
  TransferIcon,
  RoomIcon,
  CallIcon,
  PhoneIcon
} from './icons';

/* ---------------------------------------------------------------- campus -- */

interface Scene {
  icon: ReactNode;
  title: string;
  was: string;
  now: string;
}

const SCENES: Scene[] = [
  {
    icon: <ScreenIcon size={17} />,
    title: 'In the lab',
    was: 'Sign in to a shared machine, email the error to yourself, sign out and hope you remembered to.',
    now: 'Copy it. It is on your laptop, and nothing of yours was ever on that computer.'
  },
  {
    icon: <PeopleIcon size={17} />,
    title: 'Group project',
    was: 'A group chat nobody scrolls back through, and four copies of the same file with different names.',
    now: 'One room. Snippets, screenshots and files reach all four of you, and the history stays on your machines.'
  },
  {
    icon: <PresentIcon size={17} />,
    title: 'Presentation day',
    was: 'A USB stick you left in the room, or a cloud drive that wants a login the podium machine will not give you.',
    now: 'Send the deck straight across. They accept, it arrives, and nothing is stored anywhere afterwards.'
  },
  {
    icon: <NoWifiIcon size={17} />,
    title: 'WiFi with no way out',
    was: 'The campus network blocks it, the connection drops, and everything that needed the internet stops working.',
    now: 'Nothing changes. It never used the internet, so there is nothing for a blocked or dead connection to break.'
  }
];

/*
 * Its own component because useTilt is a hook, and a hook cannot be called
 * from inside the `.map` that renders these.
 */
function SceneCard({ scene, delay }: { scene: Scene; delay: number }) {
  const reveal = useReveal();
  const tilt = useTilt(4);

  return (
    <motion.article className="scene" {...reveal(delay)} {...tilt}>
      <h3><span className="ico">{scene.icon}</span>{scene.title}</h3>
      <dl className="swap">
        <div className="was"><dt>Today</dt><dd>{scene.was}</dd></div>
        <div className="now"><dt>Instead</dt><dd>{scene.now}</dd></div>
      </dl>
    </motion.article>
  );
}

export function Campus() {
  const reveal = useReveal();

  return (
    <section id="campus">
      <div className="wrap">
        <motion.p className="eyebrow" {...reveal()}>Built for campuses</motion.p>
        <h2 className="statement">
          <Words inView>The lab machine cannot log in to anything.</Words>{' '}
          <em><Words inView delay={0.3}>It does not need to.</Words></em>
        </h2>
        <motion.p className="lede" {...reveal(0.12)}>
          College networks block half the internet, the shared machines are not yours to sign
          in on, and the WiFi drops at the worst moment. Campus Connect never leaves the
          network, so none of that is its problem.
        </motion.p>

        <div className="scenes">
          {SCENES.map((scene, index) => (
            <SceneCard key={scene.title} scene={scene} delay={index * 0.07} />
          ))}
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- features -- */

interface Feature {
  icon: ReactNode;
  title: string;
  tag?: string;
  body: string;
}

const FEATURES: Feature[] = [
  {
    icon: <ClipboardIcon />,
    title: 'Clipboard sync',
    body: "Copy on one machine, paste on another. Text and images, sealed with the room's key, in a history you can search and pin things in."
  },
  {
    icon: <TransferIcon />,
    title: 'File transfer',
    tag: 'New',
    body: 'Send files straight to another machine. No room, no history, nothing stored — they accept, you pick, and it streams over a direct connection.'
  },
  {
    icon: <RoomIcon />,
    title: 'Rooms and chat',
    body: 'A room is a shared space with a password only its members know. Messages, replies, reactions and read receipts, encrypted with it.'
  },
  {
    icon: <CallIcon />,
    title: 'Voice and video',
    tag: 'From a phone',
    body: 'Call everyone in the room, peer to peer over WebRTC, with no signalling server anywhere. Share a screen while you talk.'
  },
  {
    icon: <ScreenIcon />,
    title: 'Remote desktop',
    body: "See another machine's screen and take its mouse and keyboard — after its owner says yes, and only for as long as they allow."
  },
  {
    icon: <PhoneIcon />,
    title: 'Your phone, paired once',
    body: 'Scan a code and your phone has the whole app in its browser. Nothing to install, and the connection is encrypted.'
  }
];

/* The card's sheen follows the cursor. Written as custom properties rather
   than as state so it never costs a React render — the value goes straight
   to the style engine, which is the only thing that reads it. */
function trackCursor(event: PointerEvent<HTMLElement>) {
  const card = event.currentTarget;
  const box = card.getBoundingClientRect();
  card.style.setProperty('--mx', `${event.clientX - box.left}px`);
  card.style.setProperty('--my', `${event.clientY - box.top}px`);
}

function FeatureCard({ feature, delay }: { feature: Feature; delay: number }) {
  const reveal = useReveal();
  const tilt = useTilt(6);

  return (
    <motion.article
      className="card"
      {...reveal(delay)}
      {...tilt}
      onPointerMove={(event) => {
        trackCursor(event);
        tilt.onPointerMove?.(event);
      }}
    >
      <span className="ico">{feature.icon}</span>
      <h3>
        {feature.title}
        {feature.tag ? <span className="tag">{feature.tag}</span> : null}
      </h3>
      <p>{feature.body}</p>
    </motion.article>
  );
}

export function Features() {
  const reveal = useReveal();

  return (
    <section id="what">
      <div className="wrap">
        <motion.p className="eyebrow" {...reveal()}>What it does</motion.p>
        <h2 className="statement">
          <Words inView>Six things.</Words>{' '}
          <em><Words inView delay={0.16}>None of them touch the internet.</Words></em>
        </h2>

        <div className="grid">
          {FEATURES.map((feature, index) => (
            <FeatureCard key={feature.title} feature={feature} delay={index * 0.06} />
          ))}
        </div>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- privacy -- */

const FACTS: Array<[string, string]> = [
  ['Room contents', 'AES-256-GCM, key derived from your password'],
  ['Where the password goes', 'Nowhere. It only feeds key derivation, locally'],
  ['Calls and screen sharing', 'Peer to peer, DTLS-SRTP, no server involved'],
  ["Your phone's connection", 'TLS, with a certificate this machine issues'],
  ['A tampered packet', 'Rejected outright by the authentication tag'],
  ['Publicly visible', 'Room and owner names — devices have to find rooms'],
  ['Visible on the network', 'That a room is busy, and roughly how large messages are'],
  ['A room with no password', 'Plain text. The app labels it "Not encrypted"']
];

export function Privacy() {
  const reveal = useReveal();

  return (
    <section id="private">
      <div className="wrap">
        <motion.p className="eyebrow" {...reveal()}>Privacy</motion.p>
        <h2 className="statement">
          <Words inView>&ldquo;Encrypted&rdquo; gets claimed a lot.</Words>{' '}
          <em><Words inView delay={0.28}>Here is exactly what happens.</Words></em>
        </h2>
        <motion.p className="lede" {...reveal(0.12)}>
          All of it is checkable in the source. The parts that are <em>not</em> private are
          listed too — a security page that only lists strengths is not telling you anything.
        </motion.p>

        <div className="facts">
          {FACTS.map(([label, value], index) => (
            <motion.div className="fact" key={label} {...reveal(index * 0.04, 12)}>
              <span>{label}</span>
              <span>{value}</span>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
