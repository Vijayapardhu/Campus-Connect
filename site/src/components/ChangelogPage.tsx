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
              <h2>0.9.0</h2>
              <span className="release__now">Latest</span>
              <span className="release__date">12 August 2026</span>
            </div>

            <p className="intro">
              No new surface area this time — a systematic audit of every module, twice, for real
              bugs rather than waiting on the next report. Several of them were security-relevant.
            </p>

            <h3>New</h3>
            <ul>
              <li><strong>Search reaches the room list, too.</strong> "On this network" in the
              sidebar had no way to filter a long list of discovered rooms — it does now, and the
              Messages page's device list and the find-someone modal both stop rendering unbounded
              results once there are more than a screenful.</li>
            </ul>

            <h3>Fixed — security</h3>
            <ul>
              <li><strong>Any accepted member of a room could forge a chat message or clipboard
              share under a different member's name.</strong> Both handlers trusted a self-reported
              identity field inside the encrypted payload instead of the sender identity the
              message's own signature had already proved. Fixed by using the authenticated sender
              everywhere an identity is recorded.</li>
              <li><strong>A device could spoof a room-accept and hand a victim a fabricated
              roster</strong> — including quietly downgrading an already-encrypted room to
              plaintext — because the handler never checked that the sender was actually the
              room's owner.</li>
              <li><strong>A device's delivery receipt could be forged against messages in a room it
              was never checked against</strong>, if it happened to also hold local history for that
              room from being a member of it before.</li>
              <li><strong>Unpairing a phone didn't stop it hearing anything.</strong> Revoking access
              only blocked new requests — the live push channel that delivers every clipboard entry,
              chat message and call ring in real time stayed open and kept receiving until it
              happened to disconnect on its own.</li>
            </ul>

            <h3>Fixed — reliability</h3>
            <ul>
              <li>A remote-desktop session that failed to connect, or whose connection later dropped
              for good, never actually ended — screen capture and the input injector kept running,
              and the device was locked out of remote desktop entirely, in either role, until someone
              noticed and manually disconnected.</li>
              <li>A file transfer could get stuck "busy" forever: either the receiver's accept never
              reaching the sender, or a single lost "the transfer is finished" packet (sent once,
              never acknowledged) leaving a fully-received file stuck open with nothing to close it.</li>
              <li>A member removed from a room — by the owner, or simply by a roster update — kept an
              active remote session or call with a fellow member fully intact, since the existing
              fix for this only ever checked the acting device's own session.</li>
              <li>Leaving a room you had never actually unlocked reported success even though the
              owner's side silently rejected it, since it had no key to prove the departure with —
              you were told you'd left a room you were, in fact, still a member of.</li>
              <li>A member offline while a room's password changed kept a silently dead key forever,
              with everything they sent unreadable to everyone else and no error ever shown to them.
              Now detected from the room's own periodic advert the moment they're back online.</li>
              <li>A crash partway through the one-time data migration (from the app's old name) could
              leave a permanently half-migrated profile with no indication anything had gone wrong.
              The copy is staged and committed atomically now.</li>
              <li>Two devices discovering each other at the same moment could end up tearing down a
              connection the other side was still holding, needing the next announce cycle to
              recover.</li>
            </ul>

            <h3>Fixed — smaller</h3>
            <ul>
              <li>A room's delivery status could read "Delivered" the instant any one of several
              members had a message, not once every member did, contradicting the receipt's own rule.</li>
              <li>Starting to reply to a message while mid-edit of another one sent the edit's
              leftover text as a new, unrelated message and silently discarded the intended edit.</li>
              <li>A second update's own genuine download failure could be reported as success, because
              a stale record from an earlier, unrelated update was still lying around.</li>
              <li>A room's QR code kept showing an already-rotated join code after regenerating it,
              without switching rooms to refresh it.</li>
              <li>Global search shortcuts fired even with the caret in the chat composer, discarding
              an unsent draft.</li>
              <li>Member-moderation controls — Block, Restrict, Remove — were hidden behind a check
              meant only for the Call/Message/Screen buttons, on any client without native media
              access.</li>
            </ul>
          </div>

          <div className="release">
            <div className="release__head">
              <h2>0.8.0</h2>
              <span className="release__date">8 August 2026</span>
            </div>

            <h3>New</h3>
            <ul>
              <li><strong>Direct messages are end-to-end encrypted.</strong> Each pair of devices
              derives its own key by X25519 agreement — the same way a room hands a fresh key to one
              member, reused here with no password to share and no exchange step either side has to
              do by hand.</li>
              <li><strong>Direct messages now have delivered/seen receipts and a typing
              indicator</strong> — the same tracking room chat already had, reaching a 1:1 thread for
              the first time.</li>
              <li><strong>Search reaches direct messages.</strong> <code>Ctrl+Shift+F</code> used to
              search clipboard history and room chat only; it now finds anything sent or received
              directly too.</li>
              <li><strong>Devices added by IP are remembered</strong> and reconnected to automatically
              on every future launch, instead of the address being asked for again each session.</li>
              <li><strong>A fourth room restriction: remote desktop.</strong> An owner could already
              stop a member sending messages, files, or starting calls in one room without a full
              block — screen sharing joins that same list.</li>
              <li><strong><code>@mentions</code> in room chat</strong>, with an autocomplete as you
              type and a stronger notification for whoever is named.</li>
              <li><strong>Forward any message</strong> — room chat or direct — to another room or
              thread without retyping it.</li>
              <li><strong>Pin a chat message</strong>, the same as a clipboard entry already could
              be.</li>
              <li><strong>Paste an image straight into the composer.</strong> Attaching a file no
              longer always means the native picker.</li>
              <li><strong>Export a conversation</strong> to a plain-text file, from either a room or a
              direct thread.</li>
            </ul>

            <h3>Fixed</h3>
            <ul>
              <li>A wrong room password used to be accepted unconditionally and cached, leaving the
              room looking unlocked while nothing in it could actually decrypt. It is now verified
              before anything is cached — a wrong password keeps the dialog open instead.</li>
              <li>An incoming call's ring could close itself before there had been a chance to answer
              it. A shorter, unrelated liveness check was tearing it down on ordinary heartbeat
              jitter, well before the real, deliberate 45-second timeout — it now relies on that
              timeout alone.</li>
              <li>Remote desktop's pointer was off on any display not at 100% Windows scaling (or a
              Retina Mac) — coordinates were computed from logical pixels; the native cursor APIs
              expect physical ones.</li>
              <li>Remote-desktop streaming now caps its bitrate and hints the encoder for screen
              content, so a burst of on-screen motion no longer pushes it into a lag spike the link
              has no headroom for.</li>
              <li>The master on/off switch was labelled &ldquo;Shared clipboard&rdquo; everywhere it
              appears, which read as clipboard-only even though it already stopped everything &mdash;
              chat, rooms, calls, all of it. Relabelled throughout.</li>
            </ul>
          </div>

          <div className="release">
            <div className="release__head">
              <h2>0.7.0</h2>
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
            <a href="https://github.com/Vijayapardhu/Campus-Connect/releases">the releases page</a>. The
            commits behind each of them are in{' '}
            <a href="https://github.com/Vijayapardhu/Campus-Connect">the repository</a>.
          </p>
        </div>
      </main>

      <Footer prefix={ROOT} />
    </>
  );
}
