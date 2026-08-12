/*
 * The engineering record behind /build.html.
 *
 * Every figure and every line here came out of the repository, not out of
 * memory. The commands are written beside each block so the page can be
 * re-derived rather than believed:
 *
 *   commits    git rev-list --count HEAD
 *   releases   git tag | wc -l
 *   days       git log --date=short --pretty=%ad | sort -u
 *   lines      find src -name '*.ts*' | xargs wc -l
 *   tests      npm test
 *   protocol   PROTOCOL_VERSION in src/shared/types.ts
 *
 * The "what broke" entries are real commit subjects, kept in the words they
 * were committed in. A build log that only lists what went right is a
 * marketing page wearing a lab coat.
 */

export interface Stat {
  value: string;
  label: string;
  note: string;
}

export const STATS: Stat[] = [
  { value: '83', label: 'commits', note: 'one author, no co-authors' },
  { value: '23', label: 'tagged releases', note: 'v0.1.0 through v0.9.0' },
  { value: '12', label: 'days with commits', note: 'inside a seventeen-day span' },
  { value: '31k', label: 'lines of TypeScript', note: 'across 68 source files' },
  { value: '361', label: 'tests', note: 'run on every build' },
  { value: '6', label: 'wire protocol revisions', note: 'checked on every packet' }
];

/* ---------------------------------------------------------------- days -- */

export interface Day {
  date: string;
  commits: number;
  title: string;
  body: string;
  releases: string[];
}

export const TIMELINE: Day[] = [
  {
    date: '27 July',
    commits: 10,
    releases: ['v0.1.0', 'v0.1.1', 'v0.1.2', 'v0.1.3'],
    title: 'Rooms, and a reason for them',
    body:
      'The first commit already had encrypted room-based clipboard sync in it, because a shared ' +
      'clipboard with no boundary is not a feature anyone would switch on. Chunked transfer, QR ' +
      'join codes, pinning and search followed the same day, then the rebrand and the release ' +
      'automation. Four tags before midnight, mostly because packaging is where the surprises are.'
  },
  {
    date: '28 July',
    commits: 11,
    releases: ['v0.1.4', 'v0.1.5', 'v0.2.0', 'v0.2.1', 'v0.2.2', 'v0.3.0', 'v0.3.1', 'v0.3.2', 'v0.3.3'],
    title: 'The network gets serious',
    body:
      'Discovery was failing between devices on the same network — the bug that makes the whole ' +
      'product pointless — and fixing it led to a second transport: TCP alongside UDP, for payloads ' +
      'a datagram should never have been carrying. Auto-update landed the same day, and immediately ' +
      'shipped a build that packaged the previous build inside itself.'
  },
  {
    date: '29 July',
    commits: 6,
    releases: ['v0.3.4', 'v0.3.5', 'v0.3.6'],
    title: 'Making it survivable',
    body:
      'Three releases spent on the difference between working and not falling over: a notification ' +
      'storm silenced, images made to arrive quickly, and a failed save or a stalled update stopped ' +
      'from taking the whole application down with it.'
  },
  {
    date: '30 July',
    commits: 4,
    releases: ['v0.3.7'],
    title: 'A day lost to CI',
    body:
      'None of this changed the product. A flaky Electron download was failing releases, the build ' +
      'cache was in a directory the job-level environment could not name, and an unsigned build ' +
      'turned out to be unable to install its own updates.'
  },
  {
    date: '31 July',
    commits: 3,
    releases: ['v0.4.0'],
    title: 'Calls, screens and a phone',
    body:
      'The largest single release: voice and video peer to peer over WebRTC with no signalling ' +
      'server, remote desktop with an approval gate in front of every input event, phone access ' +
      'served from the desktop itself, and the productivity layer — snippets, quick paste, the ' +
      'command palette.'
  },
  {
    date: '5 August',
    commits: 9,
    releases: ['v0.5.0'],
    title: 'Direct files, and an app of its own',
    body:
      'Peer-to-peer file transfer with no room and no history behind it, calls from a paired phone ' +
      'over TLS, and an application shell drawn by the app rather than the platform. The rest of ' +
      'the day went on the website, and on an updater that had been downloading the same release ' +
      'three and four times over.'
  },
  {
    date: '6 August',
    commits: 6,
    releases: ['v0.6.0', 'v0.6.1'],
    title: 'A claim becomes a proof',
    body:
      'Every message is now signed, so a device id has to be proved rather than claimed — the ' +
      'security work everything after it builds on. A settings modal that kept dragging focus back ' +
      'to its first field mid-sentence was fixed the same day, and the release right behind it ' +
      'stopped shipping 52MB of another platform’s native binaries that no installed copy could ever ' +
      'have loaded.'
  },
  {
    date: '7 August',
    commits: 16,
    releases: ['v0.7.0'],
    title: 'Its own window, its own address',
    body:
      'Calls and remote desktop got their own OS windows, direct 1:1 calling and messaging arrived ' +
      'alongside them, and a phone-bridge gap that let a blocked device reach both through a paired ' +
      'phone even though the desktop app itself refused them was closed. The rest of the day went to ' +
      'the site: clean URLs instead of trailing .html, an Open Graph banner, a macOS build that had ' +
      'been pruning the Intel and Apple Silicon halves it still needed to merge, and a custom domain ' +
      'that kept vanishing on every rebuild until it was finally given a real source file to build ' +
      'from instead of being hand-edited into the output.'
  },
  {
    date: '8 August',
    commits: 6,
    releases: ['v0.8.0'],
    title: 'Direct messages catch up',
    body:
      'Direct messages reached full parity with room chat in one release — end-to-end encryption of ' +
      'their own, delivered/seen receipts, a typing indicator, search that finally reaches a DM ' +
      'thread, @mentions, forwarding, pinning, pasting an image straight into the composer, exporting ' +
      'a conversation to a file — alongside a long list of correctness fixes in the same push: a ' +
      'wrong room password no longer gets cached as if it had worked, an incoming call’s ring can no ' +
      'longer close itself before anyone gets a chance to answer, and the remote-desktop pointer ' +
      'stopped drifting on any display that was not running at 100% scaling.'
  },
  {
    date: '9–11 August',
    commits: 4,
    releases: [],
    title: 'A full pass over everything, twice',
    body:
      'A systematic audit of every module for real bugs, rather than waiting on the next report: a ' +
      'room-hijack spoofing gap, a chat- and clipboard-identity forgery closed the same way, a ' +
      'remote session able to outlive the room membership it depended on, and a file transfer that ' +
      'could get stuck busy forever on a single dropped acknowledgement, among a long list of smaller ' +
      'ones. A second, narrower pass went back over file sharing specifically and found three more. ' +
      'The custom domain needed one more correction in between — dropping a leading www. that never ' +
      'actually resolved.'
  },
  {
    date: '12 August',
    commits: 3,
    releases: ['v0.9.0'],
    title: 'The name catches up with itself',
    body:
      'The repository was renamed to Campus-Connect a while before this, and the old name had kept ' +
      'quietly living on: hardcoded in package.json — including the electron-builder config the ' +
      'shipped app’s own auto-updater reads — in the CLI installer’s actual download logic, in the ' +
      'in-app About screen, and across every doc and site link. All of it pointed at the current ' +
      'repository by the end of the day, alongside the security and reliability fixes from the two ' +
      'days before it, released together as v0.9.0.'
  }
];

/* ------------------------------------------------------------- modules -- */

export interface Module {
  name: string;
  lines: number;
  role: string;
  detail: string;
  uses: string[];
}

/* The ones worth explaining. Descriptions follow ARCHITECTURE.md §7, which is
   the document these were written against. */
export const MODULES: Module[] = [
  {
    name: 'crypto.ts',
    lines: 256,
    role: 'Key derivation and sealing',
    detail:
      "A room's password goes through scrypt with a per-room salt and becomes a 32-byte key. " +
      'Everything in the room is sealed with AES-256-GCM, and `open` returns null on any failure ' +
      'rather than throwing — a tampered packet is simply not a message. Password knowledge is ' +
      'proved against the room id, so the password itself is never sent, not even to prove you ' +
      "have it. Direct messages use a different key entirely: X25519 agreement between the two " +
      "device's own keypairs, domain-separated by their sorted ids, so both sides derive the same " +
      "key from nothing sent over the wire at all. Pure functions with no Electron imports, which " +
      'is what makes it testable.',
    uses: ['node:crypto', 'scrypt', 'AES-256-GCM', 'X25519']
  },
  {
    name: 'types.ts',
    lines: 1220,
    role: 'The wire protocol',
    detail:
      'Every message that crosses the network is described here, and `PROTOCOL_VERSION` is checked ' +
      'on each one. It has moved six times. When it moves, devices on the old number stop seeing ' +
      'the new one by design — a version mismatch is reported rather than half-working, which was ' +
      'itself the subject of a fix on the second day.',
    uses: ['TypeScript', 'discriminated unions']
  },
  {
    name: 'network.ts',
    lines: 184,
    role: 'Discovery',
    detail:
      'Devices announce themselves on the local network by UDP broadcast and find each other with ' +
      'no lookup, no rendezvous and no account. The advert is deliberately thin — enough to know a ' +
      'room exists and who owns it, and nothing about what is in it.',
    uses: ['node:dgram', 'UDP broadcast']
  },
  {
    name: 'tcp.ts + framing.ts',
    lines: 455,
    role: 'The second transport',
    detail:
      'A datagram is the wrong shape for anything large, so a direct TCP connection is dialled to ' +
      'known peers and preferred for big payloads. Because TCP is a stream and not messages, ' +
      'framing.ts puts a length in front of every one — 85 lines that exist entirely because the ' +
      'first version assumed a read equalled a message.',
    uses: ['node:net', 'length-prefixed framing']
  },
  {
    name: 'keyVault.ts',
    lines: 162,
    role: 'Where the keys sleep',
    detail:
      'Derived room keys used to sit in config.json as plain hex, so anyone who could read the user ' +
      'profile — another account, a copied folder, a backup — held every key this device had ever ' +
      'derived. They now go through the OS credential store: DPAPI, Keychain, libsecret. The ' +
      'ciphertext is bound to your account, so a copied profile is useless. Where no keyring exists ' +
      'the keys are held for the session and never written, because a fallback to plaintext would ' +
      'mean the fix quietly not applying on exactly the systems that need it.',
    uses: ['Electron safeStorage', 'DPAPI / Keychain / libsecret']
  },
  {
    name: 'roomManager.ts',
    lines: 473,
    role: 'Rooms, keys and members',
    detail:
      'Persists through an interface rather than reaching for electron-store directly, which is the ' +
      'reason it can be tested at all. The invariants are the interesting part: the owner cannot be ' +
      'removed, and a re-request from an accepted member can never quietly downgrade them back to ' +
      'pending — checked before anything about that member is touched, including their name, not ' +
      'just their key.',
    uses: ['electron-store', 'injected persistence']
  },
  {
    name: 'historyManager.ts',
    lines: 555,
    role: 'What is kept, and for how long',
    detail:
      'Caps are enforced per room — 100 clipboard entries, 500 messages — so a busy room cannot ' +
      'evict a quiet one. Writes are debounced by 750ms because a clipboard poller would otherwise ' +
      'touch the disk every second, and consecutive identical entries are dropped, which is what ' +
      'stops polling producing duplicates.',
    uses: ['electron-store', 'debounced writes']
  },
  {
    name: 'fileShare.ts',
    lines: 907,
    role: 'Direct file transfer',
    detail:
      'A state machine with no persistence behind it: request, accept, stream, finish. Files land ' +
      'in a partials directory and are renamed atomically on completion, so an interrupted transfer ' +
      'never leaves a half-file wearing the right name. One session at a time in either direction, ' +
      'and a 512MB ceiling checked before anything is read. A guard now stops two overlapping sends ' +
      'from the same transfer corrupting each other, and a fully-received transfer no longer stays ' +
      'stuck open forever if the single packet announcing it is done gets lost.',
    uses: ['node:fs', 'TCP preferred, UDP fallback']
  },
  {
    name: 'phoneSession.ts',
    lines: 272,
    role: 'The phone security boundary',
    detail:
      'PIN generation, constant-time comparison, brute-force lockout, token issue and expiry. The ' +
      'rate limit is the load-bearing part: six digits is a million possibilities, which an ' +
      'unthrottled attacker on the same WiFi exhausts in seconds. The PIN is only meaningful ' +
      'because guessing is made slow.',
    uses: ['constant-time compare', 'token expiry']
  },
  {
    name: 'phoneServer.ts',
    lines: 541,
    role: 'The phone client, served locally',
    detail:
      'A small HTTPS server on port 37778, off unless switched on, serving one self-contained page ' +
      'and four JSON endpoints. The token travels in an Authorization header rather than a cookie, ' +
      'so there is no CSRF surface at all. It is also the one place the app hands out plaintext — a ' +
      'browser cannot hold the room key, so the desktop decrypts and serves. That is documented in ' +
      'the interface rather than hidden. Unpairing a phone now closes its live event stream too, not ' +
      'just future API calls — that stream is what pushes every clipboard entry, chat message and ' +
      'call ring in real time, and it used to keep receiving all of it for as long as the connection ' +
      'happened to stay open after the phone was supposedly cut off.',
    uses: ['node:https', 'self-signed TLS', 'bearer tokens']
  },
  {
    name: 'remoteSession.ts',
    lines: 251,
    role: 'Who may drive what',
    detail:
      'One session at a time in either role, an approval queue per session, and `mayInject` — the ' +
      'single gate every input event has to pass. No Electron and no native module in here, so the ' +
      'permission logic can be tested exhaustively. Given this is what lets another machine type on ' +
      'your keyboard, that was not optional.',
    uses: ['pure TypeScript']
  },
  {
    name: 'remoteControl.ts + remoteInput.ts',
    lines: 520,
    role: 'Injecting the input',
    detail:
      'The injector is built by dependency injection, so the whole path can be tested against a ' +
      'fake that records what it was asked to do. remoteInput.ts is the only file that touches the ' +
      'native module: lazy require, capability detection for Wayland and macOS Accessibility, and ' +
      'display bounds read fresh on every event so a screen unplugged mid-session cannot leave the ' +
      'pointer mapped into a rectangle that no longer exists.',
    uses: ['@jitsi/robotjs', 'Electron screen API']
  },
  {
    name: 'callEngine.ts',
    lines: 740,
    role: 'Voice, video and screens',
    detail:
      'WebRTC peer connections with no signalling server anywhere — the offers and answers travel ' +
      'over the same encrypted room the rest of the app uses. Media is encrypted by DTLS-SRTP, ' +
      'which is WebRTC doing its own job rather than anything added on top. Calls cap at six, ' +
      "because every participant holds a connection to every other one. A peer's mic/camera/share " +
      'state can arrive before this device has even created a connection for them — signalling has ' +
      'no ordering guarantee — so that update is buffered now instead of silently dropped, and ' +
      'applied the moment the connection actually exists.',
    uses: ['WebRTC', 'DTLS-SRTP']
  },
  {
    name: 'callManager.ts',
    lines: 184,
    role: 'Who is in which call',
    detail:
      'And nothing else — no media, no Electron, no persistence. A call cannot survive a restart, ' +
      'because a stale one would be worse than none. Participants that stop announcing are swept ' +
      'after 20 seconds and an empty call ends itself. Tested against an injected clock.',
    uses: ['injected clock']
  },
  {
    name: 'updater.ts + updatePolicy.ts',
    lines: 326,
    role: 'Getting the next version',
    detail:
      'The only part of the application that ever touches the internet, and the source of more ' +
      'fixes than anything else here: a build that packaged its predecessor inside itself, a ' +
      'download that could not resume, an unsigned build that could not install its own update, a ' +
      'policy that fetched the same release three and four times over, and — the newest one — a ' +
      "second update's own genuine failure getting reported as success because a stale record of " +
      "the *first* update's success was still lying around.",
    uses: ['electron-updater', 'GitHub releases']
  },
  {
    name: 'migrate.ts',
    lines: 109,
    role: 'Surviving the rename',
    detail:
      'Electron names the per-user data directory after the application, so renaming it to Campus ' +
      'Connect moved everything. This copies the old directory across on first run — identity, ' +
      'rooms, keys, history — so a rename does not read as a fresh install. It only runs when the ' +
      'new directory has no settings of its own, leaves the old one in place, and logs a failure ' +
      'rather than dying on it. The copy itself now lands in a staging directory next to the real ' +
      'one and is only made visible by a single atomic rename — a process killed mid-copy used to ' +
      'be able to leave the marker file present with the rest of the copy incomplete, which the next ' +
      'launch read as "already done" and never revisited.',
    uses: ['node:fs']
  }
];

/* Everything, by area — the numbers behind the 31k. */
export const AREAS: Array<{ area: string; files: number; lines: number; what: string }> = [
  {
    area: 'src/main',
    files: 31,
    lines: 14828,
    what: 'The Node side: networking, crypto, storage, the phone server, remote input, updates.'
  },
  {
    area: 'src/renderer',
    files: 30,
    lines: 14129,
    what: 'The interface: panels, settings, call and remote UI, the WebRTC engine, the phone client.'
  },
  {
    area: 'src/shared',
    files: 7,
    lines: 2163,
    what: 'The wire protocol, the IPC contract, content typing and deep links — used by both sides.'
  }
];

/* ------------------------------------------------------------ mistakes -- */

export interface Misstep {
  commit: string;
  date: string;
  lesson: string;
}

/*
 * Real commit subjects, in the words they were committed in. Eighteen of
 * the eighty-three commits are shaped like this — counted by grepping
 * commit subjects for fix/stop/never/resume/close/correct, which almost
 * certainly undercounts it (a commit titled "Sign every message, so a
 * device id has to be proved rather than claimed" is fixing a weakness
 * without using any of those words) but is a number anyone can rerun
 * rather than one taken on faith. A build log that lists only what went
 * right is a marketing page wearing a lab coat.
 */
export const MISSTEPS: Misstep[] = [
  {
    commit: 'Fix discovery failing between devices on the same network',
    date: '28 July',
    lesson:
      'The one bug that makes the entire product pointless, and it shipped. Two devices on the same ' +
      'WiFi could not see each other — everything else in the app is downstream of that working.'
  },
  {
    commit: 'Make a version mismatch visible instead of invisible',
    date: '28 July',
    lesson:
      'Devices on different protocol versions were failing silently, which looks exactly like a ' +
      'network problem. A refusal you can read beats a failure you have to guess at.'
  },
  {
    commit: 'Add auto-update, and stop packaging the previous build into the new one',
    date: '28 July',
    lesson:
      'The installer was carrying the release before it inside itself. Caught by the size of the ' +
      'artifact, not by any test.'
  },
  {
    commit: 'Package dist/shared, and check the package can start before publishing',
    date: '28 July',
    lesson:
      'v0.3.1 shipped installers that could not start: a narrowed files glob silently dropped a ' +
      'directory that main.js requires before any logging exists. Typecheck and tests both passed, ' +
      'because the fault was in the packaging rather than the code. The release pipeline now reads ' +
      'the built asar and refuses to publish anything with a missing require.'
  },
  {
    commit: 'Resume an update download that dies mid-transfer',
    date: '28 July',
    lesson: 'A dropped connection was restarting the whole download instead of continuing it.'
  },
  {
    commit: 'Stop the notification storm, and make images arrive quickly',
    date: '29 July',
    lesson:
      'Every arriving item was worth a notification, until forty of them arrived at once and it ' +
      'became obvious that none of them were.'
  },
  {
    commit: 'Never let a failed save, or a stalled update, take the app down',
    date: '29 July',
    lesson:
      'Two unrelated paths that both ended in an unhandled rejection, and therefore in a closed ' +
      'window.'
  },
  {
    commit: 'Stop a flaky download from failing a release',
    date: '30 July',
    lesson:
      'v0.3.6 died on "An existing connection was forcibly closed by the remote host", partway ' +
      'through a 121MB Electron zip. The fetch is now cached and retried three times, because a ' +
      'dropped byte should not cost a release.'
  },
  {
    commit: 'Let an unsigned build actually install its own updates',
    date: '30 July',
    lesson:
      'Auto-update was refusing its own artifacts because they carried no signature — correct ' +
      'behaviour for a signed product, and completely wrong for this one.'
  },
  {
    commit: 'Stop downloading the same update three and four times over',
    date: '5 August',
    lesson:
      'Nothing was tracking whether a check was already in flight, so overlapping triggers each ' +
      'started their own download of the same file.'
  },
  {
    commit: 'Stop the modal dragging focus back to its first field mid-word',
    date: '6 August',
    lesson:
      'A settings dialog kept re-stealing focus to its first input on every render, which is only ' +
      'noticeable the moment you are actually typing into a later one — exactly when it is worst.'
  },
  {
    commit: 'Stop shipping 52 MB that no installed copy can ever read',
    date: '6 August',
    lesson:
      'Windows builds were carrying macOS and Linux prebuilds, and vice versa — every installer was ' +
      'roughly a third larger than the platform it actually ran on needed.'
  },
  {
    commit: 'Stop the macOS universal build from pruning the halves it still needs to merge',
    date: '7 August',
    lesson:
      'A cleanup step meant to slim the final artifact was running before the Intel and Apple ' +
      'Silicon builds it was supposed to combine had actually been combined.'
  },
  {
    commit: 'Fix a wide batch of real bugs found across a full-codebase audit',
    date: '11 August',
    lesson:
      'The one worth naming: any accepted member of a room could forge a chat message or clipboard ' +
      'share under a different member’s name, because the handler trusted a self-reported field ' +
      'inside the encrypted payload instead of the sender identity the signature had already proved. ' +
      'A separate handler had the identical gap for who owns a room, closed the same way.'
  },
  {
    commit: 'Fix real bugs found in a focused file-sharing audit',
    date: '11 August',
    lesson:
      'A single lost "the transfer is finished" packet — sent once, never acknowledged, unlike every ' +
      'file slice before it — left a fully-received file stuck open forever on the receiving end, ' +
      'with the app itself refusing every future transfer because it still believed one was running.'
  }
];
