import { Footer } from './Footer';
import { SubpageHeader } from './Header';

/*
 * This page is served from /changelog/, so everything at the site root is
 * one directory up — see Footer.tsx and Header.tsx for the same reasoning
 * applied there.
 */
const ROOT = '../';

/*
 * The release history.
 *
 * Every entry here is a real commit, checked against `git log` rather than
 * written from memory — the dates, and which fixes shipped in which
 * version, are exactly what the repository says they are.
 */
export default function ChangelogPage() {
  return (
    <>
      <SubpageHeader root={ROOT} />

      <main className="doc">
        <div className="wrap">
          <h1>Changelog</h1>
          <p className="updated">Every release, and what actually changed for the people using it.</p>
          <p className="intro">
            Versions track the wire protocol as much as the features. When{' '}
            <code>PROTOCOL_VERSION</code> changes, devices still on the old one stop seeing the new
            one by design — that is called out wherever it happened.
          </p>

          <div className="release">
            <div className="release__head">
              <h2>0.7.0</h2>
              <span className="release__now">Latest</span>
              <span className="release__date">7 August 2026</span>
            </div>

            <h3>New</h3>
            <ul>
              <li><strong>Calls and remote desktop have their own window.</strong> Each opens as its
              own OS window with its own taskbar entry. Closing it ends the call or the session;
              minimising or maximising it never does — the two used to be tangled together.</li>
              <li><strong>Direct 1:1 calling.</strong> Ring one person instead of the whole room, with
              a Call button right on their entry in the member list. Once placed it behaves exactly
              like a normal room call — other members can still see it and join.</li>
              <li><strong>Direct 1:1 messaging.</strong> Message any Campus Connect device visible on
              the network straight, with no shared room required — its own thread, its own unread
              badge, reachable the same way file transfer already was.</li>
              <li><strong>Phone access is HTTPS-only.</strong> The plaintext option is gone entirely;
              every phone session is encrypted end to end from the first request, with no setting to
              get wrong.</li>
              <li><strong>A floating host indicator</strong> for remote desktop, so the person sharing
              their screen always has a visible, click-to-end control — even while another window has
              focus.</li>
            </ul>

            <h3>Fixed</h3>
            <ul>
              <li>The phone bridge now enforces the same block list as the desktop app for file
              transfers and direct messages — a gap that let a blocked device reach both through a
              paired phone even though the desktop app itself refused them.</li>
              <li>Settings switches that depend on another setting (tray-start, the notification
              sound) now actually disable when their dependency is off, instead of just looking
              disabled.</li>
              <li>Chat and clipboard state from a previous room could briefly show while a new room
              was still loading, if you switched rooms quickly enough. It can't now.</li>
              <li>The command palette could start a second call on top of one already running.</li>
              <li>An incoming deep link no longer clobbers a modal you already had open, and Escape no
              longer closes two things at once.</li>
            </ul>
          </div>

          <div className="release">
            <div className="release__head">
              <h2>0.6.1</h2>
              <span className="release__date">6 August 2026</span>
            </div>
            <ul>
              <li>Installers no longer ship roughly 52MB of another platform's native binaries that no
              installed copy could ever load — Windows builds were carrying macOS and Linux prebuilds,
              and vice versa.</li>
            </ul>
          </div>

          <div className="release">
            <div className="release__head">
              <h2>0.6.0</h2>
              <span className="release__date">6 August 2026</span>
            </div>
            <ul>
              <li>Every message is now signed, so a device id has to be proved rather than claimed.</li>
              <li>Room keys are encrypted at rest, and a member can no longer be removed by someone
              without the standing to do it.</li>
              <li>A settings modal no longer drags focus back to its first field while you're still
              typing into a later one.</li>
            </ul>
          </div>

          <div className="release">
            <div className="release__head">
              <h2>0.5.0</h2>
              <span className="release__date">August 2026</span>
            </div>

            <h3>New</h3>
            <ul>
              <li><strong>Peer-to-peer file transfer.</strong> Send files straight to another machine
              from the new Files screen. No room, no history, nothing stored — they accept, you pick,
              and it streams over a direct connection.</li>
              <li><strong>Calls from a phone.</strong> Phone access is served over TLS, which is what
              lets a browser hand the page a microphone. A paired phone can now join voice and video
              calls.</li>
              <li><strong>Encrypted phone access.</strong> Your computer issues its own certificate, so
              the phone&rsquo;s session and its access token no longer cross the WiFi readable by
              anyone on it.</li>
              <li><strong>Links that open the app.</strong> <code>campusconnect://</code> links work,
              so scanning a room&rsquo;s QR code opens the join dialog with the code already filled
              in.</li>
              <li><strong>Start with your computer.</strong> A real setting, with the option to start
              straight to the tray. Earlier versions added themselves to startup with no way to
              decline.</li>
              <li><strong>A window of its own.</strong> The application draws its own title bar and
              controls, keeping the native traffic lights on macOS.</li>
              <li><strong>A first run that explains itself</strong> &mdash; rooms, the tray, and the
              paste shortcut.</li>
            </ul>

            <h3>Fixed</h3>
            <ul>
              <li>Notifications interrupt for things that expire &mdash; an incoming call, a transfer
              request, somebody asking for your screen &mdash; instead of staying silent behind a
              window.</li>
              <li>Remote desktop only accepts an answer to a request this device actually made.</li>
              <li>Removing somebody from a room now ends any remote session they had with you.</li>
              <li>Losing the shared display ends the session instead of freezing the far end.</li>
              <li>Substantial layout work at small sizes; the interface no longer breaks between a
              phone and a tablet.</li>
            </ul>
          </div>

          <div className="release">
            <div className="release__head">
              <h2>0.4.0</h2>
              <span className="release__date">31 July 2026</span>
            </div>
            <ul>
              <li>Voice and video calls over the local network, peer to peer, with screen sharing.</li>
              <li>Remote desktop, asked for every time and revocable from either end.</li>
              <li>Phone access &mdash; scan a code and the whole interface runs in your phone&rsquo;s
              browser.</li>
              <li>Quick-paste overlay, command palette and saved snippets.</li>
              <li>Renamed from Shared Clipboard to Campus Connect.</li>
            </ul>
          </div>

          <div className="release">
            <div className="release__head">
              <h2>0.3.7</h2>
              <span className="release__date">30 July 2026</span>
            </div>
            <ul>
              <li>Unsigned builds can install their own updates properly.</li>
            </ul>
          </div>

          <div className="release">
            <div className="release__head">
              <h2>0.3.0 &ndash; 0.3.6</h2>
              <span className="release__date">28&ndash;30 July 2026</span>
            </div>
            <ul>
              <li>Chunked transfer, so large screenshots sync without falling over.</li>
              <li>File attachments in chat.</li>
              <li>QR codes for join codes.</li>
              <li>Pinned clipboard items, and search across the whole history.</li>
              <li>Keyboard shortcuts throughout.</li>
            </ul>
          </div>

          <h2>Full history</h2>
          <p>
            Every release, with its installers and complete notes, is on{' '}
            <a href="https://github.com/Vijayapardhu/Clipboard/releases">the releases page</a>. The
            commits behind each of them are in{' '}
            <a href="https://github.com/Vijayapardhu/Clipboard">the repository</a>.
          </p>
        </div>
      </main>

      <Footer prefix={ROOT} />
    </>
  );
}
