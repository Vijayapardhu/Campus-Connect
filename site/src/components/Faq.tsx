import { useId, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useReveal } from '../lib/useReveal';
import { Words } from '../lib/effects';

const QUESTIONS: Array<{ q: string; a: ReactNode }> = [
  {
    q: 'Does it really work without the internet?',
    a: (
      <>
        <p>
          Yes, and that is the whole design. Devices find each other by broadcasting on the
          local network and then talk directly. If your campus WiFi has no route out — or the
          connection drops entirely — nothing changes, because nothing was going that way.
        </p>
        <p>The only time it touches the internet is when you ask it to check for a new version.</p>
      </>
    )
  },
  {
    q: 'Is my clipboard sent to a server somewhere?',
    a: (
      <p>
        There is no server. No account to make, nothing to sign in to, and no company holding
        your data — including us. What you copy goes to the other devices in your room and
        nowhere else.
      </p>
    )
  },
  {
    q: 'Will it work on university WiFi?',
    a: (
      <p>
        Usually. It needs the two machines to be able to reach each other on the network, which
        most campus WiFi allows. Some networks turn on <em>client isolation</em>, which
        deliberately stops devices seeing one another — that blocks this and every other direct
        tool. Settings → Network will tell you which situation you are in.
      </p>
    )
  },
  {
    q: 'How is it encrypted, exactly?',
    a: (
      <>
        <p>
          A room's password is put through a key derivation function and the result encrypts
          everything in that room with AES-256-GCM. The password itself never leaves your device
          and is never sent, not even to prove you know it.
        </p>
        <p>
          Calls and screen sharing go peer to peer over WebRTC, encrypted by DTLS-SRTP. The{' '}
          <a href="#private">privacy section</a> lists what is <em>not</em> private too.
        </p>
      </>
    )
  },
  {
    q: 'Why does Windows say "Unknown publisher"?',
    a: (
      <>
        <p>
          Because the installer is not code-signed. A signing certificate costs a few hundred
          pounds a year, which is not something a student project has. The warning is Windows
          being honest that it cannot verify who built it.
        </p>
        <p>
          If that is a problem for you, build it from source — the instructions are in the
          repository and the result is identical.
        </p>
      </>
    )
  },
  {
    q: 'Can I use it on my phone?',
    a: (
      <>
        <p>
          Yes. Turn on phone access on the computer, scan the code, and your phone has the whole
          application in its browser — nothing to install. Since 0.5.0 that connection is served
          over TLS, which is also what lets a phone join a voice or video call.
        </p>
        <p>
          The first time you pair, your phone will warn you about the certificate. That is
          expected: the certificate is issued by your own computer, which no browser has any
          reason to trust in advance.
        </p>
      </>
    )
  },
  {
    q: 'Is it free? What is the catch?',
    a: (
      <p>
        Free, MIT licensed, and there is no catch. There is nothing to upsell, because there is
        no server to run and therefore nothing that costs money to keep alive.
      </p>
    )
  },
  {
    q: 'How many people can be in a room?',
    a: (
      <p>
        Clipboard, chat and files have no fixed limit beyond what your network will carry. Calls
        cap at six, because every participant holds a connection to every other one and past
        roughly that the encoders give out before the network does.
      </p>
    )
  }
];

/*
 * A disclosure, not a <details>.
 *
 * <details> was the right call while this was a static page: it opened before
 * any script ran. The page is a React application now, so that argument is
 * gone — and the element brings a real cost with it, because its content is
 * not laid out at all until `open` flips. There is no height to animate to on
 * the way down and the element is gone before it can shrink on the way back.
 *
 * A button and a region give the same keyboard behaviour and the same
 * announcement, and let the answer be measured while it moves.
 */
function Question({ q, a }: { q: string; a: ReactNode }) {
  const [open, setOpen] = useState(false);
  const calm = useReducedMotion();
  const id = useId();

  return (
    <div className="qa" data-open={open}>
      <button
        type="button"
        className="qa__q"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((was) => !was)}
      >
        {q}
        <span className="plus" aria-hidden="true" />
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={id}
            className="answer"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: calm ? 0 : 0.38, ease: [0.22, 0.61, 0.36, 1] }}
            /* The padding lives on an inner element. Animating height on a
               box that also carries bottom padding bottoms out at the padding
               value and then drops the last of it in one frame — which is
               exactly the snap this is here to remove. */
          >
            <div className="answer__body">{a}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function Faq() {
  const reveal = useReveal();

  return (
    <section id="faq">
      <div className="wrap">
        <motion.p className="eyebrow" {...reveal()}>Questions</motion.p>
        <h2 className="statement">
          <Words inView>Eight questions.</Words>{' '}
          <em><Words inView delay={0.16}>Answered straight.</Words></em>
        </h2>

        <motion.div className="faq" {...reveal(0.12)}>
          {QUESTIONS.map((item) => (
            <Question key={item.q} q={item.q} a={item.a} />
          ))}
        </motion.div>
      </div>
    </section>
  );
}
