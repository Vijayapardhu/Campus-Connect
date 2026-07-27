# What does this change?

<!-- One or two sentences. If it closes an issue, write "Closes #123". -->

## Why

<!-- The problem this solves. Skip if it is obvious from the title. -->

## How it was tested

<!--
Clipboard sync is a two-device feature, so please say what you actually ran.
"Typechecks" is not enough for anything that touches the network or rooms.
-->

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] Tested on two devices on the same network
- [ ] Checked in both light and dark themes

## Screenshots

<!-- Required for any user interface change. Before/after is ideal. -->

## Anything reviewers should look at closely?

<!--
Call out trade-offs, things you were unsure about, or areas you would like a
second opinion on. This is genuinely useful and not a formality.
-->

---

<!--
If this touches encryption, room membership, or the wire protocol, please also
confirm the following. These are the invariants that make private rooms private.
-->

**For changes to security or the protocol:**

- [ ] Remote data still passes through `handleRoomPayload` — no second code path applies it
- [ ] Nothing secret was added to `RoomAdvert` (it is broadcast to the whole network)
- [ ] The room password is still never transmitted
- [ ] `PROTOCOL_VERSION` was bumped if the wire format changed
