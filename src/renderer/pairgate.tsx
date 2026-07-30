import React from 'react';
import { QrIcon } from './icons';

/**
 * What a phone sees when it has arrived without being invited.
 *
 * There is deliberately nothing to fill in. Pairing happens by scanning a code
 * on the computer, which carries a key no one could type; somebody who merely
 * knows the address — and on a local network, everybody can find the address —
 * gets this screen and no way past it.
 */
export function PairGate({ error }: { error: string }) {
  return (
    <div className="pair">
      <div className="pair__mark">
        <QrIcon size={26} />
      </div>
      <h1 className="pair__title">Scan to connect</h1>
      <p className="pair__lede">
        Open <strong>Settings → Phone</strong> on the computer and scan the code it shows with this
        phone's camera.
      </p>
      <p className="pair__note">
        Typing the address on its own will not connect — the code is what grants access, and each
        one works for a single device.
      </p>
      {error ? <div className="pair__error">{error}</div> : null}
    </div>
  );
}

/** Shown for the moment between scanning and being let in. */
export function PairPending() {
  return (
    <div className="pair">
      <div className="pair__mark">
        <QrIcon size={26} />
      </div>
      <h1 className="pair__title">Connecting…</h1>
      <p className="pair__lede">Pairing this phone with your computer.</p>
    </div>
  );
}
