# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through
[GitHub Security Advisories](https://github.com/Vijayapardhu/Clipboard/security/advisories/new).
That gives us a private thread to work in and lets you be credited when it is
fixed.

Please include:

- What the problem is, and what an attacker could actually do with it.
- Steps to reproduce, or a proof of concept.
- The version you tested, and your operating system.

You can expect an acknowledgement within a few days. This is a small project
maintained by a student, so please be patient — but the security model is the
part we care most about getting right, so these reports go to the front of the
queue.

## Supported versions

The project is pre-1.0 and moving quickly. Only the latest commit on `main` is
supported. Please confirm a problem still exists there before reporting it.

---

## The security model

Understanding what the app claims makes it much easier to judge whether
something is a real vulnerability.

### What is protected

| Claim | How |
|-------|-----|
| Room contents are unreadable without the password | AES-256-GCM with a key from `scrypt(password, keySalt, N=32768)` |
| The password never travels over the network | Membership is proven with a sealed proof, not by sending the password |
| Tampered packets are rejected, not just undecryptable | GCM authentication tag verified on every message |
| Non-members cannot inject data into a room | Every inbound payload passes the four-way check in `handleRoomPayload` |
| A removed device loses access immediately | The owner is authoritative for the roster; a removed device is no longer accepted by anyone |
| Join codes are unguessable | `crypto.randomBytes` with rejection sampling over a 31-symbol alphabet |
| Replaying a captured proof at another room fails | Proofs are bound to the `roomId` |

### What is not protected — and is not a vulnerability

These are known and documented, not oversights. Please do not report them as
vulnerabilities, though improvements are very welcome as feature requests:

- **Room names and owner names are public.** Adverts are broadcast in the clear
  so devices can discover rooms. Rosters, join codes and content are not.
- **Traffic analysis.** An observer on the network can see that a room is busy
  and roughly how large its messages are.
- **Derived keys are cached on disk** in `electron-store` so you do not retype
  the password every launch. Anyone with access to your user profile can read
  them. Deleting the room deletes its key.
- **Unencrypted public rooms are plain text.** That is what "public, no password"
  means, and the interface labels those rooms "Not encrypted".
- **Device identity is a UUID, not a certificate.** A removed device cannot read
  new traffic, but nothing stops someone generating a fresh UUID and asking to
  join again — which still requires the password and, for private rooms,
  approval.
- **A malicious room owner sees everything in their own room.** By design.
- **Physical or administrator access to a machine defeats everything.** Out of
  scope.

### What *is* a vulnerability

Roughly, anything that breaks one of the claims in the first table. For example:

- Reading a room's contents without its password.
- Getting a payload applied while not an accepted member of the room.
- Getting a join accepted with the wrong password, or with a proof captured
  from a different room.
- Recovering the password from anything transmitted on the network.
- Causing a crash or a hang from a malformed datagram.
- Path traversal, code execution, or anything that escapes the renderer
  sandbox (`contextIsolation` and `nodeIntegration: false` are both enforced).

### Testing it yourself

The security-critical modules run in plain Node with no Electron dependency:

```bash
npm test
```

The suite covers key derivation, envelope tampering, IV reuse, proof forgery,
join code distribution, and the membership rules. If you are looking for holes,
`src/main/crypto.ts` and the `handleRoomPayload` function in `src/main/main.ts`
are the two places worth the most attention.
