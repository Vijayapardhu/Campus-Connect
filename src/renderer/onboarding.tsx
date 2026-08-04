import React from 'react';
import { Button } from './ui';
import { hasNativeFeatures } from './httpApi';
import { ChevronLeftIcon, XIcon } from './icons';
import { ArtNetwork, ArtRooms, ArtShortcut, ArtTray } from './artwork';

/**
 * The first thing a new install shows, and the only chance to explain the one
 * idea the rest of the interface assumes you already have.
 *
 * Written to be skippable in one click and finished in under a minute. Each
 * step earns its place by covering something genuinely not discoverable:
 *
 *  - **Nothing leaves the network.** The product's whole premise, and the
 *    reason it behaves unlike everything else people have used.
 *  - **Rooms decide who sees what.** The mental model everything else rests on.
 *    Without it the app looks like it is either broken or sharing too much.
 *  - **The shortcut.** The fastest way to use any of this, and invisible unless
 *    somebody happens to read the settings.
 *  - **It keeps running.** Otherwise closing the window looks like quitting,
 *    and people wonder why their clipboard stopped following them.
 *
 * Steps that describe something this device cannot do are dropped rather than
 * shown greyed out — a phone has no keyboard shortcut and no tray, and being
 * told about both is worse than a shorter tour.
 */

type Step = {
  id: string;
  title: string;
  body: React.ReactNode;
  art: React.ReactNode;
};

/* ------------------------------------------------------------------ tour -- */

function buildSteps(quickPasteShortcut: string): Step[] {
  const native = hasNativeFeatures();

  const steps: Step[] = [
    {
      id: 'network',
      title: 'Everything stays on this network',
      body: (
        <>
          Campus Connect talks directly to the other devices on your WiFi. There is no account, no
          server and no internet connection involved — which is why it keeps working when the WiFi
          has no way out.
        </>
      ),
      art: <ArtNetwork />
    },
    {
      id: 'rooms',
      title: 'Rooms decide who sees what',
      body: (
        <>
          Nothing is shared until you are in a room with someone. A private room needs a code and
          your approval, and its contents are encrypted with a password that never leaves this
          device. Join one room for your project and another for your class, and neither sees the
          other.
        </>
      ),
      art: <ArtRooms />
    }
  ];

  if (native && quickPasteShortcut) {
    steps.push({
      id: 'shortcut',
      title: 'Paste from anywhere',
      body: (
        <>
          Press <kbd>{quickPasteShortcut.replace(/\+/g, ' + ')}</kbd> in any application to pick
          something from your shared history and paste it straight in. You never have to come back
          to this window to use it — and you can change the shortcut in Settings.
        </>
      ),
      art: <ArtShortcut />
    });
  }

  if (native) {
    steps.push({
      id: 'tray',
      title: 'It keeps running when you close it',
      body: (
        <>
          Closing the window puts Campus Connect in the tray rather than quitting it, so your
          clipboard keeps following you and files can still arrive. Click the tray icon to bring it
          back, and use Settings to start it with your computer.
        </>
      ),
      art: <ArtTray />
    });
  }

  return steps;
}

export function Onboarding({
  quickPasteShortcut,
  onFinish
}: {
  quickPasteShortcut: string;
  onFinish: () => void;
}) {
  const steps = React.useMemo(() => buildSteps(quickPasteShortcut), [quickPasteShortcut]);
  const [index, setIndex] = React.useState(0);
  const step = steps[index];
  const last = index === steps.length - 1;

  const back = () => setIndex((current) => Math.max(0, current - 1));
  const next = React.useCallback(() => {
    setIndex((current) => {
      if (current < steps.length - 1) {
        return current + 1;
      }
      onFinish();
      return current;
    });
  }, [steps.length, onFinish]);

  /*
   * Driveable from the keyboard, and escapable from it. Somebody who already
   * knows what this is should not have to reach for the mouse to say so.
   */
  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onFinish();
      } else if (event.key === 'ArrowRight' || event.key === 'Enter') {
        event.preventDefault();
        next();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        back();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [next, onFinish]);

  return (
    <div className="tour" role="dialog" aria-modal="true" aria-label="Welcome to Campus Connect">
      <div className="tour__card">
        <button className="tour__skip" onClick={onFinish} aria-label="Skip the tour">
          <XIcon size={15} />
        </button>

        {/* Keyed on the step so each one animates in rather than the text
            swapping under a static frame. */}
        <div className="tour__stage" key={step.id}>
          {/* The illustration gets a surface of its own. Floating on the card
              it read as a small diagram dropped into a text box; given an area
              and a horizon it reads as the subject of the step. */}
          <div className="tour__canvas">{step.art}</div>
          <div className="tour__copy">
            <h2 className="tour__title">{step.title}</h2>
            <p className="tour__body">{step.body}</p>
          </div>
        </div>

        <div className="tour__foot">
          <div className="tour__dots" role="tablist" aria-label="Tour progress">
            {steps.map((candidate, position) => (
              <button
                key={candidate.id}
                className={position === index ? 'tour__dot is-current' : 'tour__dot'}
                onClick={() => setIndex(position)}
                role="tab"
                aria-selected={position === index}
                aria-label={`Step ${position + 1}: ${candidate.title}`}
              />
            ))}
          </div>

          <span className="tour__spacer" />

          {index > 0 ? (
            <Button variant="ghost" onClick={back}>
              <ChevronLeftIcon size={15} />
              Back
            </Button>
          ) : (
            <Button variant="ghost" onClick={onFinish}>
              Skip
            </Button>
          )}

          <Button variant="primary" onClick={next}>
            {last ? 'Get started' : 'Next'}
          </Button>
        </div>
      </div>
    </div>
  );
}
