# Contributing to Campus Connect

Thanks for being here. Campus Connect is open source because moving something
between two machines you already own is a problem plenty of people have, and
very few good, private, offline answers exist for.

Contributions of every size are welcome — a typo fix is a real contribution.
You do not need to ask permission to start; just open an issue or a draft pull
request so nobody duplicates your work.

---

## Getting set up

You need [Node.js 20 or newer](https://nodejs.org) and Git.

```bash
git clone https://github.com/Vijayapardhu/Campus-Connect.git
cd Clipboard
npm install
npm run dev
```

`npm run dev` starts three things at once: the TypeScript compiler watching the
main process, the Vite dev server for the interface, and Electron itself.

Useful commands:

| Command | What it does |
|---------|--------------|
| `npm run dev` | Run the app with hot reload |
| `npm run typecheck` | Typecheck both the main and renderer projects |
| `npm test` | Run the test suite for crypto, rooms and history |
| `npm run build` | Compile everything into `dist/` |
| `npm run build:exe` | Build a Windows installer into `release/` |

---

## Testing a change properly

Clipboard sync is a **two-device feature**. A change can typecheck perfectly and
still be completely broken, because the interesting failures all involve two
machines disagreeing.

If your change touches the network, rooms, or encryption, please test it on two
devices on the same WiFi before opening the pull request. If you only have one
machine, say so in the pull request — a maintainer can run the two-device pass
for you. That is much better than a silent assumption.

The manual pass that catches most regressions:

1. Create a private room on device A with a password. Note the join code.
2. On device B, enter the code with the **wrong** password. It must be rejected.
3. Enter the correct password. A shows a pending request; approve it.
4. Copy text on A, paste on B. Copy an image on B, paste on A.
5. Remove B from the room on A. Copy again on A — B must not receive it.

---

## Where things live

```
src/main/       The Electron main process: networking, crypto, storage
src/renderer/   The React interface
src/shared/     Types and the IPC contract, used by both sides
test/           The test suite
docs/           The GitHub Pages site
```

Read [ARCHITECTURE.md](ARCHITECTURE.md) before changing anything in `src/main`.
It is long but it is accurate, and section 5 explains the security model that
the rest of the code depends on.

---

## Rules that matter

Most of the codebase is ordinary TypeScript and you should just match the style
around you. These few rules exist because breaking them breaks the privacy
guarantee, quietly and without any test failing:

1. **All remote data goes through `handleRoomPayload`.** It is the single gate
   that checks the room exists, that you are a member, that the *sender* is a
   member, and that the payload decrypts. Do not add a second path that applies
   data from the network.

2. **Never put anything secret in `RoomAdvert`.** It is broadcast to every
   device on the network. No roster, no join code, nothing derived from the
   password. There is a test asserting this.

3. **The room password never goes on the wire.** Membership is proven with a
   sealed proof, not by sending the password. If you find yourself adding a
   password field to a message, stop and open an issue instead.

4. **Bump `PROTOCOL_VERSION`** in `src/shared/types.ts` when you change the wire
   format. Mismatched versions are ignored, which is what stops a half-upgraded
   pair of laptops corrupting each other's state.

5. **New IPC calls start in `src/shared/bridge.ts`**, then `preload.ts`, then
   `main.ts`. One contract, three consumers, no drift.

6. **Style with the tokens in `styles.css`.** No literal colours or pixel values
   in components — use `var(--space-3)`, `var(--text-sm)`, `var(--accent)` and
   friends, so light mode, dark mode, and the text size setting all keep working.

---

## Opening a pull request

- Branch from `main`.
- Keep the change focused. Two unrelated fixes are easier to review as two pull
  requests.
- Fill in the template, especially the testing section.
- Include screenshots for anything visual, in **both** light and dark themes.
- `npm run typecheck` and `npm test` must pass. CI runs both.

Do not worry about getting review comments. Everyone does, and a review is a
conversation rather than a verdict.

---

## Good first issues

If you want to help but do not know where to start, these are self-contained,
genuinely useful, and each touches a different part of the codebase:

| Idea | Where | Difficulty |
|------|-------|-----------|
| Keyboard shortcuts to switch rooms (`Ctrl+1..9`) | `src/renderer/App.tsx` | Easy |
| Search box to filter clipboard history | `src/renderer/panels.tsx` | Easy |
| Show "pinned" clipboard items that survive the 100-item cap | `historyManager.ts` | Medium |
| Chunk large images across several datagrams so big screenshots sync | `src/main/main.ts` | Hard |
| File transfer in chat (the type exists, the transfer does not) | main + renderer | Hard |
| A real QR code for join codes (the `qrcode` dependency is already installed) | `src/renderer/panels.tsx` | Medium |
| Translations, starting with the strings in `panels.tsx` and `modals.tsx` | renderer | Medium |

Issues labelled [`good first issue`](https://github.com/Vijayapardhu/Campus-Connect/labels/good%20first%20issue)
are kept scoped small on purpose.

---

## Reporting security problems

Please do not open a public issue. See [SECURITY.md](SECURITY.md).

---

## Code of conduct

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). It is
short and it comes down to: be decent to people.
