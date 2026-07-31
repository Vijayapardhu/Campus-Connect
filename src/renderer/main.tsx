import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles.css';
import App from './App';
import { QuickPasteOverlay } from './quickpaste';
import { PairGate, PairPending } from './pairgate';
import { checkPairing, createHttpApi, isPhoneClient, pairWithKey, scannedKey } from './httpApi';

/**
 * One bundle, three ways in.
 *
 * The desktop window and the quick-paste overlay are two Electron windows that
 * share a renderer process, told apart by the URL hash — a second entry point
 * would mean a second copy of React for the sake of one small component.
 *
 * A phone is the third. It loads the same bundle over HTTP, where there is no
 * preload script and therefore no `window.campusConnect`, so one is built out of
 * `fetch` before React starts. Everything above that line — every panel, every
 * dialog, every piece of state — is then identical to the desktop, because it
 * genuinely is the same code.
 */
const root = ReactDOM.createRoot(document.getElementById('root')!);

async function start() {
  if (window.location.hash === '#quick-paste') {
    document.body.classList.add('is-overlay');
    root.render(
      <React.StrictMode>
        <QuickPasteOverlay />
      </React.StrictMode>
    );
    return;
  }

  if (isPhoneClient()) {
    document.body.classList.add('is-phone');

    // A key in the address means this phone has just scanned the code.
    const key = scannedKey();
    if (key) {
      root.render(
        <React.StrictMode>
          <PairPending />
        </React.StrictMode>
      );

      const problem = await pairWithKey(key);
      if (problem) {
        root.render(
          <React.StrictMode>
            <PairGate error={problem} />
          </React.StrictMode>
        );
        return;
      }
    }

    renderPhone(await checkPairing());
    return;
  }

  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

function renderPhone(paired: boolean) {
  if (!paired) {
    root.render(
      <React.StrictMode>
        <PairGate error="" />
      </React.StrictMode>
    );
    return;
  }

  // Built once and attached to the window, so every module that reaches for
  // `window.campusConnect` — which is all of them — finds it there as usual.
  window.campusConnect = createHttpApi(() => renderPhone(false));

  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

void start();
