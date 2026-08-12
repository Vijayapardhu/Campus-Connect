/**
 * Test suite for the security-critical modules.
 *
 *   npm test
 *
 * crypto.ts, roomManager.ts and historyManager.ts deliberately import nothing
 * from Electron, so they can be required straight out of dist/main and run in
 * plain Node. No test framework, no dependencies — `node --test` would work too,
 * but this keeps the output readable for anyone reviewing the project.
 */

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..', 'dist', 'main');

if (!fs.existsSync(path.join(ROOT, 'crypto.js'))) {
  console.error('\nCompiled output not found. Run `npm run build:main` first.\n');
  process.exit(1);
}

const crypto = require(path.join(ROOT, 'crypto.js'));
const { RoomManager, directRoomId } = require(path.join(ROOT, 'roomManager.js'));
const {
  HistoryManager,
  MAX_CLIPBOARD_PER_ROOM,
  MAX_CHAT_PER_ROOM
} = require(path.join(ROOT, 'historyManager.js'));

/*
 * Caps are asserted against the exported constants rather than the numbers they
 * happen to hold. These tests were written with 100 and 500 inline, so raising
 * the caps failed five of them for no reason but the literal — which says
 * nothing about whether trimming still works.
 */
const OVER_CLIPBOARD_CAP = MAX_CLIPBOARD_PER_ROOM + 50;
const OVER_CHAT_CAP = MAX_CHAT_PER_ROOM + 100;
const { DirectMessageManager } = require(path.join(ROOT, 'directMessage.js'));
const { CallManager, PARTICIPANT_TTL_MS } = require(path.join(ROOT, 'callManager.js'));
const { migrateUserData } = require(path.join(ROOT, 'migrate.js'));
const {
  createInjector,
  parseRemoteInput,
  toRobotKey,
  toScreenPoint,
  scaleBounds,
  MAX_TEXT_LENGTH,
  MAX_SCROLL_NOTCHES
} = require(path.join(ROOT, 'remoteControl.js'));
const { RemoteSessionManager, REQUEST_TIMEOUT_MS } = require(path.join(ROOT, 'remoteSession.js'));
const { SnippetManager } = require(path.join(ROOT, 'snippetManager.js'));
const {
  PhoneSessions,
  generateKey,
  MAX_PIN_ATTEMPTS,
  LOCKOUT_MS,
  PAIRING_TTL_MS
} = require(path.join(ROOT, 'phoneSession.js'));
const { detectContent, isOpenableUrl } = require(path.join(__dirname, '..', 'dist', 'shared', 'contentType.js'));
const { findMentions, mentionedDeviceIds, splitOnMentions } = require(
  path.join(__dirname, '..', 'dist', 'shared', 'mentions.js')
);
const { dataUrlBytes } = require(path.join(__dirname, '..', 'dist', 'shared', 'dataUrl.js'));
const { routeCallSignal } = require(path.join(__dirname, '..', 'dist', 'shared', 'callRouting.js'));
const { formatTranscript, transcriptFileName } = require(
  path.join(__dirname, '..', 'dist', 'shared', 'transcript.js')
);
const { ChunkAssembler, splitIntoChunks } = require(path.join(ROOT, 'transfer.js'));
const net = require(path.join(ROOT, 'network.js'));
const { FrameDecoder, encodeFrame, HEADER_BYTES } = require(path.join(ROOT, 'framing.js'));

// The npx installer. Plain JavaScript rather than compiled output, and it holds
// no Electron or app state, so it is required straight from source.
const { target, pickAsset, pickManifest, sha512For } = require(
  path.join(__dirname, '..', 'cli', 'lib', 'select.js')
);

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${error.message}`);
    process.exitCode = 1;
  }
}

/**
 * Tests whose subject only exists across awaits.
 *
 * File transfer is a conversation, not a function call: half of what is worth
 * asserting about it — that the second file follows the first, that a cancel
 * releases whoever was waiting — cannot be observed synchronously. These are
 * collected and run after the synchronous suite so the output stays ordered.
 */
const deferred = [];

function testAsync(name, fn) {
  deferred.push(async () => {
    try {
      await fn();
      passed++;
      console.log(`  PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`  FAIL  ${name}\n        ${error.message}`);
      process.exitCode = 1;
    }
  });
}

console.log('\n-- crypto --');

test('key derivation is deterministic per (password, salt)', () => {
  const salt = crypto.generateSalt();
  assert.deepStrictEqual(crypto.deriveRoomKey('hunter2', salt), crypto.deriveRoomKey('hunter2', salt));
});

test('different password yields a different key', () => {
  const salt = crypto.generateSalt();
  assert.notDeepStrictEqual(crypto.deriveRoomKey('hunter2', salt), crypto.deriveRoomKey('hunter3', salt));
});

test('different salt yields a different key for the same password', () => {
  const a = crypto.deriveRoomKey('hunter2', crypto.generateSalt());
  const b = crypto.deriveRoomKey('hunter2', crypto.generateSalt());
  assert.notDeepStrictEqual(a, b);
});

test('seal/open round-trips JSON', () => {
  const key = crypto.deriveRoomKey('pw', crypto.generateSalt());
  const body = { payload: { kind: 'text', text: 'npm run dev', sourceName: 'Laptop-A' } };
  assert.deepStrictEqual(crypto.openJson(key, crypto.sealJson(key, body)), body);
});

test('wrong key cannot open the envelope', () => {
  const salt = crypto.generateSalt();
  const env = crypto.seal(crypto.deriveRoomKey('right', salt), 'secret');
  assert.strictEqual(crypto.open(crypto.deriveRoomKey('wrong', salt), env), null);
});

test('tampered ciphertext is rejected by the auth tag', () => {
  const key = crypto.deriveRoomKey('pw', crypto.generateSalt());
  const env = crypto.seal(key, 'transfer 100 rupees');
  const buf = Buffer.from(env.data, 'base64');
  buf[0] ^= 0xff;
  assert.strictEqual(crypto.open(key, { ...env, data: buf.toString('base64') }), null);
});

test('tampered auth tag is rejected', () => {
  const key = crypto.deriveRoomKey('pw', crypto.generateSalt());
  const env = crypto.seal(key, 'hello');
  const tag = Buffer.from(env.tag, 'hex');
  tag[0] ^= 0xff;
  assert.strictEqual(crypto.open(key, { ...env, tag: tag.toString('hex') }), null);
});

test('nonce is unique across seals (no IV reuse)', () => {
  const key = crypto.deriveRoomKey('pw', crypto.generateSalt());
  const ivs = new Set();
  for (let i = 0; i < 500; i++) ivs.add(crypto.seal(key, 'same plaintext').iv);
  assert.strictEqual(ivs.size, 500);
});

test('proof verifies only with the correct password', () => {
  const salt = crypto.generateSalt();
  const roomId = 'room-abc';
  const proof = crypto.createProof(crypto.deriveRoomKey('correct', salt), roomId);
  assert.strictEqual(crypto.verifyProof(crypto.deriveRoomKey('correct', salt), roomId, proof), true);
  assert.strictEqual(crypto.verifyProof(crypto.deriveRoomKey('wrong', salt), roomId, proof), false);
});

test('a proof for one room does not verify for another', () => {
  const salt = crypto.generateSalt();
  const key = crypto.deriveRoomKey('pw', salt);
  assert.strictEqual(crypto.verifyProof(key, 'room-B', crypto.createProof(key, 'room-A')), false);
});

test('join codes are 6 chars from the unambiguous alphabet', () => {
  for (let i = 0; i < 200; i++) {
    const code = crypto.generateJoinCode();
    assert.strictEqual(code.length, 6);
    assert.match(code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
  }
});

test('join codes are not obviously repeating', () => {
  const codes = new Set();
  for (let i = 0; i < 2000; i++) codes.add(crypto.generateJoinCode());
  assert.ok(codes.size > 1990, `only ${codes.size}/2000 unique`);
});

test('join code alphabet is uniformly distributed (no modulo bias)', () => {
  const counts = new Map();
  const N = 60000;
  for (let i = 0; i < N / 6; i++) {
    for (const ch of crypto.generateJoinCode()) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  const expected = N / 31;
  for (const [ch, n] of counts) {
    const drift = Math.abs(n - expected) / expected;
    assert.ok(drift < 0.12, `'${ch}' drifted ${(drift * 100).toFixed(1)}% from uniform`);
  }
});

test('normalizeJoinCode cleans user input', () => {
  assert.strictEqual(crypto.normalizeJoinCode('  a1b-2c3 '), 'A1B2C3');
});

console.log('\n-- rooms --');

function makeManager() {
  let rooms = [];
  let keys = {};
  return new RoomManager({
    readRooms: () => rooms,
    writeRooms: (next) => { rooms = next; },
    readKeys: () => keys,
    writeKeys: (next) => { keys = next; },
    _dump: () => ({ rooms, keys })
  });
}

test('a private room is encrypted, coded, and owned', () => {
  const rm = makeManager();
  const room = rm.createRoom({ name: 'Secret', type: 'private', password: 'pw1234', ownerId: 'A', ownerName: 'Laptop-A' });
  assert.strictEqual(room.encrypted, true);
  assert.strictEqual(room.joinCode.length, 6);
  assert.strictEqual(room.members[0].role, 'owner');
  assert.strictEqual(rm.isAcceptedMember(room.roomId, 'A'), true);
  assert.ok(rm.getKey(room.roomId));
});

test('a public room without a password is not encrypted', () => {
  const rm = makeManager();
  const room = rm.createRoom({ name: 'Open', type: 'public', password: '', ownerId: 'A', ownerName: 'A' });
  assert.strictEqual(room.encrypted, false);
  assert.strictEqual(rm.getKey(room.roomId), undefined);
});

test('the advert leaks neither the roster nor the join code', () => {
  const rm = makeManager();
  const room = rm.createRoom({ name: 'Secret', type: 'private', password: 'pw1234', ownerId: 'A', ownerName: 'A' });
  rm.addPendingMember(room.roomId, 'B', 'Laptop-B');
  const advert = rm.toAdvert(rm.getRoom(room.roomId));
  assert.strictEqual(advert.joinCode, undefined);
  assert.strictEqual(advert.members, undefined);
  assert.strictEqual(JSON.stringify(advert).includes(room.joinCode), false);
  assert.strictEqual(advert.memberCount, 1, 'pending members must not be counted');
});

test('pending members are not accepted members', () => {
  const rm = makeManager();
  const room = rm.createRoom({ name: 'R', type: 'private', password: 'pw1234', ownerId: 'A', ownerName: 'A' });
  rm.addPendingMember(room.roomId, 'B', 'Laptop-B');
  assert.strictEqual(rm.isAcceptedMember(room.roomId, 'B'), false);
  rm.approveMember(room.roomId, 'B');
  assert.strictEqual(rm.isAcceptedMember(room.roomId, 'B'), true);
});

test('re-requesting does not duplicate or downgrade a member', () => {
  const rm = makeManager();
  const room = rm.createRoom({ name: 'R', type: 'public', password: '', ownerId: 'A', ownerName: 'A' });
  rm.addAcceptedMember(room.roomId, 'B', 'Laptop-B');
  assert.strictEqual(rm.addPendingMember(room.roomId, 'B', 'Laptop-B'), undefined);
  assert.strictEqual(rm.isAcceptedMember(room.roomId, 'B'), true);
  assert.strictEqual(rm.getMembers(room.roomId).length, 2);
});

test('the owner cannot be removed from their own room', () => {
  const rm = makeManager();
  const room = rm.createRoom({ name: 'R', type: 'private', password: 'pw1234', ownerId: 'A', ownerName: 'A' });
  assert.strictEqual(rm.removeMember(room.roomId, 'A'), undefined);
  assert.strictEqual(rm.isAcceptedMember(room.roomId, 'A'), true);
});

test('a removed member loses access', () => {
  const rm = makeManager();
  const room = rm.createRoom({ name: 'R', type: 'private', password: 'pw1234', ownerId: 'A', ownerName: 'A' });
  rm.addAcceptedMember(room.roomId, 'B', 'B');
  rm.removeMember(room.roomId, 'B');
  assert.strictEqual(rm.isAcceptedMember(room.roomId, 'B'), false);
});

test('rooms and keys survive a restart', () => {
  let rooms = [];
  let keys = {};
  const persistence = {
    readRooms: () => rooms,
    writeRooms: (n) => { rooms = n; },
    readKeys: () => keys,
    writeKeys: (n) => { keys = n; }
  };

  const first = new RoomManager(persistence);
  const room = first.createRoom({ name: 'R', type: 'private', password: 'pw1234', ownerId: 'A', ownerName: 'A' });

  const second = new RoomManager(persistence);
  assert.strictEqual(second.getRoom(room.roomId).name, 'R');
  assert.deepStrictEqual(second.getKey(room.roomId), first.getKey(room.roomId));
  assert.strictEqual(second.isLocked(room.roomId), false);
});

test('a room whose key is missing reports as locked', () => {
  let rooms = [];
  const persistence = {
    readRooms: () => rooms,
    writeRooms: (n) => { rooms = n; },
    readKeys: () => ({}),
    writeKeys: () => {}
  };
  const first = new RoomManager(persistence);
  const room = first.createRoom({ name: 'R', type: 'private', password: 'pw1234', ownerId: 'A', ownerName: 'A' });
  const second = new RoomManager(persistence);
  assert.strictEqual(second.isLocked(room.roomId), true);
});

test('dropping the key locks the room without leaving it', () => {
  const rm = makeManager();
  const room = rm.createRoom({ name: 'R', type: 'private', password: 'pw1234', ownerId: 'A', ownerName: 'A' });
  assert.strictEqual(rm.isLocked(room.roomId), false);

  // What happens on a member's device when the owner changes the password.
  rm.dropKey(room.roomId);
  assert.strictEqual(rm.isLocked(room.roomId), true);
  assert.strictEqual(rm.getKey(room.roomId), undefined);
  assert.ok(rm.getRoom(room.roomId), 'the room itself must survive');
  assert.strictEqual(rm.isAcceptedMember(room.roomId, 'A'), true, 'and so must membership');
});

test('a re-keyed room needs the new password, and the old one no longer works', () => {
  const rm = makeManager();
  const room = rm.createRoom({ name: 'R', type: 'private', password: 'old-one', ownerId: 'A', ownerName: 'A' });

  // The owner re-keys: new salt, new key derived from the new password.
  const newSalt = crypto.generateSalt();
  rm.saveRoom({ ...room, keySalt: newSalt });
  rm.setKey(room.roomId, crypto.deriveRoomKey('new-one', newSalt));

  const sealed = crypto.sealJson(rm.getKey(room.roomId), { secret: 'after' });
  assert.strictEqual(crypto.openJson(crypto.deriveRoomKey('old-one', room.keySalt), sealed), null);
  assert.deepStrictEqual(crypto.openJson(crypto.deriveRoomKey('new-one', newSalt), sealed), {
    secret: 'after'
  });
});

test('an unjoined advert shows as discovered; a joined one does not', () => {
  const rm = makeManager();
  rm.recordAdvert({ roomId: 'x', name: 'Elsewhere', type: 'public', ownerId: 'Z', ownerName: 'Z', keySalt: 'aa', encrypted: false, memberCount: 1, createdAt: Date.now() }, '10.0.0.5');
  assert.strictEqual(rm.getDiscoveredRooms().length, 1);
  const own = rm.createRoom({ name: 'Mine', type: 'public', password: '', ownerId: 'A', ownerName: 'A' });
  rm.recordAdvert(rm.toAdvert(own), '10.0.0.1');
  assert.strictEqual(rm.getDiscoveredRooms().length, 1, 'a room we are in must not appear as discoverable');
});

console.log('\n-- member restrictions --');

/** A room with one accepted, non-owner member — the only kind that can be restricted. */
function makeRestrictableRoom() {
  const rm = makeManager();
  const room = rm.createRoom({ name: 'R', type: 'public', password: '', ownerId: 'A', ownerName: 'A' });
  rm.addPendingMember(room.roomId, 'B', 'Phone-B');
  rm.approveMember(room.roomId, 'B');
  return { rm, roomId: room.roomId };
}

test('each restriction is stored independently of the others', () => {
  const { rm, roomId } = makeRestrictableRoom();
  rm.setMemberRestrictions(roomId, 'B', { remote: true });
  assert.deepStrictEqual(rm.getRestrictions(roomId, 'B'), {
    chat: false,
    files: false,
    calls: false,
    remote: true
  }, 'screen sharing must not be inferred from, or fold into, the calls flag');
});

test('restricting calls leaves screen sharing alone, and the reverse', () => {
  const { rm, roomId } = makeRestrictableRoom();
  rm.setMemberRestrictions(roomId, 'B', { calls: true });
  assert.strictEqual(rm.getRestrictions(roomId, 'B').remote, false);
  rm.setMemberRestrictions(roomId, 'B', { remote: true });
  assert.strictEqual(rm.getRestrictions(roomId, 'B').calls, false);
});

test('clearing every flag drops the record rather than storing an all-false one', () => {
  const { rm, roomId } = makeRestrictableRoom();
  rm.setMemberRestrictions(roomId, 'B', { chat: true, remote: true });
  assert.ok(rm.getRestrictions(roomId, 'B'));
  rm.setMemberRestrictions(roomId, 'B', {});
  assert.strictEqual(rm.getRestrictions(roomId, 'B'), undefined, 'all-false must not read as restricted');
});

test('the owner cannot be restricted', () => {
  const { rm, roomId } = makeRestrictableRoom();
  assert.strictEqual(rm.setMemberRestrictions(roomId, 'A', { remote: true }), undefined);
  assert.strictEqual(rm.getRestrictions(roomId, 'A'), undefined);
});

test('restrictions survive a reload, since they ride the persisted roster', () => {
  // One backing store, two managers — what a restart actually looks like.
  let rooms = [];
  let keys = {};
  const store = {
    readRooms: () => rooms,
    writeRooms: (next) => { rooms = next; },
    readKeys: () => keys,
    writeKeys: (next) => { keys = next; }
  };

  const first = new RoomManager(store);
  const room = first.createRoom({ name: 'R', type: 'public', password: '', ownerId: 'A', ownerName: 'A' });
  first.addPendingMember(room.roomId, 'B', 'Phone-B');
  first.approveMember(room.roomId, 'B');
  first.setMemberRestrictions(room.roomId, 'B', { remote: true, files: true });

  const reloaded = new RoomManager(store);
  assert.deepStrictEqual(reloaded.getRestrictions(room.roomId, 'B'), {
    chat: false,
    files: true,
    calls: false,
    remote: true
  });
});

console.log('\n-- direct-call rooms --');

test('directRoomId is deterministic and order-independent', () => {
  assert.strictEqual(directRoomId('A', 'B'), directRoomId('B', 'A'));
  assert.notStrictEqual(directRoomId('A', 'B'), directRoomId('A', 'C'));
});

test('ensureDirectRoom is computed identically from either side', () => {
  const caller = makeManager().ensureDirectRoom('A', 'Laptop-A', 'B', 'Phone-B');
  const callee = makeManager().ensureDirectRoom('B', 'Phone-B', 'A', 'Laptop-A');
  assert.strictEqual(caller.roomId, callee.roomId);
  assert.strictEqual(caller.ownerId, callee.ownerId, 'whichever id sorts first, both sides must agree on it');
  assert.strictEqual(caller.type, 'direct');
  assert.strictEqual(caller.encrypted, false);
  assert.deepStrictEqual(
    caller.members.map((m) => m.deviceId).sort(),
    callee.members.map((m) => m.deviceId).sort()
  );
});

test('a direct room is never advertised and never locked', () => {
  const rm = makeManager();
  const room = rm.ensureDirectRoom('A', 'A', 'B', 'B');
  assert.strictEqual(rm.isLocked(room.roomId), false);
  assert.strictEqual(rm.isAcceptedMember(room.roomId, 'A'), true);
  assert.strictEqual(rm.isAcceptedMember(room.roomId, 'B'), true);
});

test('ensureDirectRoom is idempotent and keeps the peer name current', () => {
  const rm = makeManager();
  const first = rm.ensureDirectRoom('A', 'A', 'B', 'Old Name');
  const second = rm.ensureDirectRoom('A', 'A', 'B', 'New Name');
  assert.strictEqual(first.roomId, second.roomId);
  assert.strictEqual(rm.getRoom(first.roomId).members.find((m) => m.deviceId === 'B').deviceName, 'New Name');
});

console.log('\n-- direct messages --');

function makeDirectMessages() {
  let messages = [];
  let archived = [];
  return new DirectMessageManager({
    read: () => messages,
    write: (next) => { messages = next; },
    readArchived: () => archived,
    writeArchived: (next) => { archived = next; }
  });
}

test('a sent message round-trips through the thread and the summary', () => {
  const dm = makeDirectMessages();
  const sent = dm.send('B', 'Phone-B', { type: 'text', content: 'hi' });
  assert.strictEqual(sent.fromSelf, true);
  assert.deepStrictEqual(dm.getThread('B').map((m) => m.id), [sent.id]);
  assert.strictEqual(dm.listThreads()[0].lastMessage, 'hi');
});

test('a retransmitted receive is not stored twice, but a genuinely new one from the same peer is', () => {
  const dm = makeDirectMessages();
  const signal = { kind: 'message', id: 'm1', type: 'text', content: 'hey', sentAt: Date.now() };
  assert.ok(dm.receive('B', 'B', signal));
  assert.strictEqual(dm.receive('B', 'B', signal), undefined, 'a repeat of the same id must be dropped');
  assert.ok(dm.receive('B', 'B', { ...signal, id: 'm2' }));
  assert.strictEqual(dm.getThread('B').length, 2);
});

test('only the message\'s own side may edit or delete it', () => {
  const dm = makeDirectMessages();
  const mine = dm.send('B', 'B', { type: 'text', content: 'draft' });
  const theirs = dm.receive('B', 'B', { kind: 'message', id: 'x1', type: 'text', content: 'reply', sentAt: Date.now() });

  assert.strictEqual(dm.editMessage('B', mine.id, 'fixed', Date.now(), true).content, 'fixed');
  assert.strictEqual(dm.editMessage('B', mine.id, 'nope', Date.now(), false), undefined, 'the peer cannot edit our own message');
  assert.strictEqual(dm.editMessage('B', theirs.id, 'nope', Date.now(), true), undefined, 'we cannot edit the peer\'s message');

  const deleted = dm.markDeleted('B', mine.id, true);
  assert.strictEqual(deleted.deleted, true);
  assert.strictEqual(deleted.content, '', 'a tombstone keeps the row but scrubs the content');
});

test('a local-only delete removes the row without any ownership check', () => {
  const dm = makeDirectMessages();
  const theirs = dm.receive('B', 'B', { kind: 'message', id: 'x1', type: 'text', content: 'hi', sentAt: Date.now() });
  assert.strictEqual(dm.deleteMessageLocal('B', theirs.id), true);
  assert.strictEqual(dm.getThread('B').length, 0);
});

test('a reaction toggles on and off, keyed by whichever device reacted', () => {
  const dm = makeDirectMessages();
  const sent = dm.send('B', 'B', { type: 'text', content: 'hi' });
  assert.strictEqual(dm.setReaction('B', sent.id, '👍', 'B', true), true);
  assert.strictEqual(dm.findMessage('B', sent.id).reactions['👍'][0], 'B');
  assert.strictEqual(dm.setReaction('B', sent.id, '👍', 'B', true), false, 'already on — no-op reports no change');
  assert.strictEqual(dm.setReaction('B', sent.id, '👍', 'B', false), true);
  assert.strictEqual(dm.findMessage('B', sent.id).reactions, undefined);
});

test('a receipt only ever acknowledges the messages this device sent', () => {
  const dm = makeDirectMessages();
  const mine = dm.send('B', 'B', { type: 'text', content: 'hi' });
  const theirs = dm.receive('B', 'B', { kind: 'message', id: 'x1', type: 'text', content: 'hey', sentAt: Date.now() });

  const changed = dm.recordReceipt('B', [mine.id, theirs.id], 'delivered');
  assert.deepStrictEqual(changed.map((m) => m.id), [mine.id], 'the peer cannot mark their own message delivered to us');
  assert.deepStrictEqual(dm.findMessage('B', mine.id).deliveredTo, ['B']);
  assert.strictEqual(dm.findMessage('B', theirs.id).deliveredTo, undefined);
});

test('a receipt does not cross threads', () => {
  const dm = makeDirectMessages();
  const toB = dm.send('B', 'B', { type: 'text', content: 'hi B' });
  dm.send('C', 'C', { type: 'text', content: 'hi C' });
  assert.deepStrictEqual(dm.recordReceipt('B', [toB.id], 'delivered').map((m) => m.id), [toB.id]);
  assert.strictEqual(dm.getThread('C')[0].deliveredTo, undefined, 'C never acknowledged anything');
});

test('a seen receipt implies delivered, even when the delivered one never arrived', () => {
  const dm = makeDirectMessages();
  const sent = dm.send('B', 'B', { type: 'text', content: 'hi' });
  dm.recordReceipt('B', [sent.id], 'seen');
  const stored = dm.findMessage('B', sent.id);
  assert.deepStrictEqual(stored.deliveredTo, ['B']);
  assert.deepStrictEqual(stored.seenBy, ['B']);
});

test('a repeated receipt reports no change rather than listing the peer twice', () => {
  const dm = makeDirectMessages();
  const sent = dm.send('B', 'B', { type: 'text', content: 'hi' });
  assert.strictEqual(dm.recordReceipt('B', [sent.id], 'delivered').length, 1);
  assert.strictEqual(dm.recordReceipt('B', [sent.id], 'delivered').length, 0, 'already delivered — nothing to emit');
  assert.strictEqual(dm.recordReceipt('B', [sent.id], 'seen').length, 1, 'but seen is still new');
  assert.strictEqual(dm.recordReceipt('B', [sent.id], 'seen').length, 0);
  assert.deepStrictEqual(dm.findMessage('B', sent.id).deliveredTo, ['B'], 'the peer is listed once, not once per receipt');
});

test('a receipt naming a message this device has never heard of changes nothing', () => {
  const dm = makeDirectMessages();
  dm.send('B', 'B', { type: 'text', content: 'hi' });
  assert.strictEqual(dm.recordReceipt('B', ['no-such-id'], 'seen').length, 0);
});

test('archiving a thread is undone by sending into it again', () => {
  const dm = makeDirectMessages();
  dm.send('B', 'B', { type: 'text', content: 'hi' });
  dm.setArchived('B', true);
  assert.strictEqual(dm.listThreads()[0].archived, true);
  dm.send('B', 'B', { type: 'text', content: 'hi again' });
  assert.strictEqual(dm.listThreads()[0].archived, false);
});

test('deleting a thread clears its messages, unread count and archived flag', () => {
  const dm = makeDirectMessages();
  dm.receive('B', 'B', { kind: 'message', id: 'x1', type: 'text', content: 'hi', sentAt: Date.now() });
  dm.setArchived('B', true);
  dm.deleteThread('B');
  assert.strictEqual(dm.getThread('B').length, 0);
  assert.strictEqual(dm.listThreads().length, 0);
});

test('search finds a DM by content, marked so the caller knows to open a thread rather than switch rooms', () => {
  const dm = makeDirectMessages();
  dm.send('B', 'Phone-B', { type: 'text', content: 'the wifi password is hunter2' });
  const hits = dm.search('wifi password', 'My Laptop');
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].kind, 'dm');
  assert.strictEqual(hits[0].peerId, 'B');
  assert.strictEqual(hits[0].deviceName, 'My Laptop', 'a self-sent hit is labelled with this device, not the peer');
});

test('search does not surface a withdrawn message', () => {
  const dm = makeDirectMessages();
  const sent = dm.send('B', 'B', { type: 'text', content: 'oops sent the wrong link' });
  dm.markDeleted('B', sent.id, true);
  assert.strictEqual(dm.search('wrong link', 'Me').length, 0);
});

test('search covers every thread, each hit correctly tagged with its own peer', () => {
  const dm = makeDirectMessages();
  dm.send('B', 'B', { type: 'text', content: 'same phrase' });
  dm.send('C', 'C', { type: 'text', content: 'same phrase' });
  const hits = dm.search('same phrase', 'Me');
  assert.deepStrictEqual(
    hits.map((h) => h.peerId).sort(),
    ['B', 'C']
  );
});

test('a receipt only ever touches this device\'s own sent messages', () => {
  const dm = makeDirectMessages();
  const mine = dm.send('B', 'B', { type: 'text', content: 'hi' });
  const theirs = dm.receive('B', 'B', { kind: 'message', id: 'x1', type: 'text', content: 'hey', sentAt: Date.now() });

  const changed = dm.recordReceipt('B', [mine.id, theirs.id], 'delivered');
  assert.deepStrictEqual(changed.map((m) => m.id), [mine.id], 'the receipt is about our own message, not theirs');
  assert.deepStrictEqual(dm.findMessage('B', mine.id).deliveredTo, ['B']);
  assert.strictEqual(dm.findMessage('B', theirs.id).deliveredTo, undefined);
});

test('a seen receipt implies delivered, even if delivered never arrived first', () => {
  const dm = makeDirectMessages();
  const mine = dm.send('B', 'B', { type: 'text', content: 'hi' });
  dm.recordReceipt('B', [mine.id], 'seen');
  const after = dm.findMessage('B', mine.id);
  assert.deepStrictEqual(after.deliveredTo, ['B']);
  assert.deepStrictEqual(after.seenBy, ['B']);
});

test('a repeated receipt is a no-op, not a duplicate entry', () => {
  const dm = makeDirectMessages();
  const mine = dm.send('B', 'B', { type: 'text', content: 'hi' });
  dm.recordReceipt('B', [mine.id], 'delivered');
  const second = dm.recordReceipt('B', [mine.id], 'delivered');
  assert.strictEqual(second.length, 0, 'nothing changed, so nothing is reported changed');
  assert.deepStrictEqual(dm.findMessage('B', mine.id).deliveredTo, ['B']);
});

console.log('\n-- history --');

function makeHistory() {
  let clipboard = [];
  let chat = [];
  return new HistoryManager({
    readClipboard: () => clipboard,
    writeClipboard: (n) => { clipboard = n; },
    readChat: () => chat,
    writeChat: (n) => { chat = n; }
  });
}

test('history is scoped per room', () => {
  const h = makeHistory();
  h.addClipboardEntry('text', 'from room 1', 'A', 'A', 'r1');
  h.addClipboardEntry('text', 'from room 2', 'A', 'A', 'r2');
  assert.strictEqual(h.getClipboardHistory('r1').length, 1);
  assert.strictEqual(h.getClipboardHistory('r1')[0].text, 'from room 1');
});

test('the polled clipboard does not create duplicates', () => {
  const h = makeHistory();
  h.addClipboardEntry('text', 'same', 'A', 'A', 'r1');
  assert.strictEqual(h.addClipboardEntry('text', 'same', 'A', 'A', 'r1'), undefined);
  assert.strictEqual(h.getClipboardHistory('r1').length, 1);
});

test('per-room caps are enforced independently', () => {
  const h = makeHistory();
  for (let i = 0; i < OVER_CLIPBOARD_CAP; i++) h.addClipboardEntry('text', `r1-${i}`, 'A', 'A', 'r1');
  for (let i = 0; i < 10; i++) h.addClipboardEntry('text', `r2-${i}`, 'A', 'A', 'r2');
  assert.strictEqual(h.getClipboardHistory('r1').length, MAX_CLIPBOARD_PER_ROOM);
  assert.strictEqual(h.getClipboardHistory('r2').length, 10, 'a busy room must not evict a quiet one');
});

test('clearing one room leaves the others intact', () => {
  const h = makeHistory();
  h.addClipboardEntry('text', 'a', 'A', 'A', 'r1');
  h.addClipboardEntry('text', 'b', 'A', 'A', 'r2');
  h.clearRoom('r1');
  assert.strictEqual(h.getClipboardHistory('r1').length, 0);
  assert.strictEqual(h.getClipboardHistory('r2').length, 1);
});

test('chat messages are deduplicated by id on rebroadcast', () => {
  const h = makeHistory();
  const m = h.addChatMessage({ type: 'text', content: 'hi', deviceId: 'A', deviceName: 'A', roomId: 'r1' });
  assert.strictEqual(h.hasChatMessage(m.id), true);
  assert.strictEqual(h.hasChatMessage('nope'), false);
});

test('a file message keeps its name and size', () => {
  const h = makeHistory();
  const m = h.addChatMessage({
    type: 'file', content: 'report.pdf', deviceId: 'A', deviceName: 'A', roomId: 'r1',
    fileName: 'report.pdf', fileSize: 2048, dataUrl: 'data:application/pdf;base64,AAAA'
  });
  assert.strictEqual(m.fileName, 'report.pdf');
  assert.strictEqual(m.fileSize, 2048);
});

console.log('\n-- answering a call --');

/*
 * The window between tapping answer and having a call to put signals into.
 * Every one of these was reachable in ordinary use; the first is what made two
 * people watch each other sit in a call that never carried any sound.
 */

test('an offer arriving before the session exists is kept', () => {
  // Answering is an IPC round trip and then opening the microphone. The caller
  // replies to the `join` sent at the start of that with an offer, which lands
  // here while the session id is still empty. Treating empty as "not my call"
  // discarded it, and an offer is sent once.
  assert.strictEqual(
    routeCallSignal({ sessionId: '', signalCallId: 'call-1', ready: false }),
    'queue'
  );
});

test('a signal for the call being joined is kept until the engine is ready', () => {
  assert.strictEqual(
    routeCallSignal({ sessionId: 'call-1', signalCallId: 'call-1', ready: false }),
    'queue'
  );
});

test('a signal for the call in progress goes straight to the engine', () => {
  assert.strictEqual(
    routeCallSignal({ sessionId: 'call-1', signalCallId: 'call-1', ready: true }),
    'handle'
  );
});

test('a signal for somebody else’s call is still ignored', () => {
  // The reason the comparison existed. Widening it must not lose this.
  assert.strictEqual(
    routeCallSignal({ sessionId: 'call-1', signalCallId: 'call-2', ready: true }),
    'ignore'
  );
  assert.strictEqual(
    routeCallSignal({ sessionId: 'call-1', signalCallId: 'call-2', ready: false }),
    'ignore'
  );
});

console.log('\n-- pinned items --');

test('a pinned item is not evicted by newer items', () => {
  const h = makeHistory();
  const first = h.addClipboardEntry('text', 'keep me', 'A', 'A', 'r1');
  assert.strictEqual(h.togglePin(first.id), true);
  for (let i = 0; i < OVER_CLIPBOARD_CAP; i++) h.addClipboardEntry('text', `noise-${i}`, 'A', 'A', 'r1');
  const survivors = h.getClipboardHistory('r1');
  assert.ok(survivors.some((e) => e.id === first.id), 'the pinned entry was evicted');
});

test('pinned items do not consume the cap', () => {
  const h = makeHistory();
  for (let i = 0; i < 5; i++) {
    const e = h.addClipboardEntry('text', `pin-${i}`, 'A', 'A', 'r1');
    h.togglePin(e.id);
  }
  for (let i = 0; i < OVER_CLIPBOARD_CAP; i++) h.addClipboardEntry('text', `noise-${i}`, 'A', 'A', 'r1');
  const all = h.getClipboardHistory('r1');
  assert.strictEqual(all.filter((e) => e.pinned).length, 5);
  assert.strictEqual(all.filter((e) => !e.pinned).length, MAX_CLIPBOARD_PER_ROOM, 'unpinned entries should still be capped');
});

test('pinned items sort above the rest', () => {
  const h = makeHistory();
  h.addClipboardEntry('text', 'old', 'A', 'A', 'r1');
  const old = h.getClipboardHistory('r1')[0];
  h.addClipboardEntry('text', 'newer', 'A', 'A', 'r1');
  h.togglePin(old.id);
  assert.strictEqual(h.getClipboardHistory('r1')[0].text, 'old');
});

test('unpinning re-exposes an item to the cap', () => {
  const h = makeHistory();
  const first = h.addClipboardEntry('text', 'temporary', 'A', 'A', 'r1');
  h.togglePin(first.id);
  for (let i = 0; i < OVER_CLIPBOARD_CAP; i++) h.addClipboardEntry('text', `noise-${i}`, 'A', 'A', 'r1');
  assert.strictEqual(h.togglePin(first.id), false);
  assert.ok(!h.getClipboardHistory('r1').some((e) => e.id === first.id), 'it should be trimmed once unpinned');
});

test('pinning survives a restart', () => {
  let clipboard = [], chat = [];
  const persistence = {
    readClipboard: () => clipboard, writeClipboard: (n) => { clipboard = n; },
    readChat: () => chat, writeChat: (n) => { chat = n; }
  };
  const first = new HistoryManager(persistence);
  const entry = first.addClipboardEntry('text', 'important', 'A', 'A', 'r1');
  first.togglePin(entry.id);
  first.flush();

  const second = new HistoryManager(persistence);
  assert.strictEqual(second.getClipboardHistory('r1')[0].pinned, true);
});

test('pinning something that is gone reports failure', () => {
  const h = makeHistory();
  assert.strictEqual(h.togglePin('does-not-exist'), undefined);
});

console.log('\n-- pinned messages --');

function addChat(h, roomId, content) {
  return h.addChatMessage({ type: 'text', content, deviceId: 'A', deviceName: 'A', roomId });
}

test('a pinned chat message is not evicted by the ones after it', () => {
  const h = makeHistory();
  const first = addChat(h, 'r1', 'keep me');
  assert.strictEqual(h.toggleChatPin(first.id), true);
  for (let i = 0; i < OVER_CHAT_CAP; i++) addChat(h, 'r1', `noise-${i}`);
  assert.ok(h.getChatHistory('r1').some((m) => m.id === first.id), 'the pinned message was evicted');
});

test('pinned chat messages do not consume the cap', () => {
  const h = makeHistory();
  for (let i = 0; i < 5; i++) {
    h.toggleChatPin(addChat(h, 'r1', `pin-${i}`).id);
  }
  for (let i = 0; i < OVER_CHAT_CAP; i++) addChat(h, 'r1', `noise-${i}`);
  const all = h.getChatHistory('r1');
  assert.strictEqual(all.filter((m) => m.pinned).length, 5);
  assert.strictEqual(all.filter((m) => !m.pinned).length, MAX_CHAT_PER_ROOM, 'unpinned messages are still capped');
});

test('unpinning a chat message re-exposes it to the cap', () => {
  const h = makeHistory();
  const first = addChat(h, 'r1', 'temporary');
  h.toggleChatPin(first.id);
  for (let i = 0; i < OVER_CHAT_CAP; i++) addChat(h, 'r1', `noise-${i}`);
  assert.strictEqual(h.toggleChatPin(first.id), false);
  assert.ok(!h.getChatHistory('r1').some((m) => m.id === first.id), 'it should be trimmed once unpinned');
});

test('pinning a chat message that is gone reports failure', () => {
  assert.strictEqual(makeHistory().toggleChatPin('does-not-exist'), undefined);
});

test('a pinned DM survives the per-peer cap, and unpinning gives it back', () => {
  const dm = makeDirectMessages();
  const kept = dm.send('B', 'B', { type: 'text', content: 'keep me' });
  assert.strictEqual(dm.togglePin('B', kept.id).pinned, true);
  for (let i = 0; i < OVER_CHAT_CAP; i++) dm.send('B', 'B', { type: 'text', content: `noise-${i}` });
  assert.ok(dm.findMessage('B', kept.id), 'the pinned message was evicted');

  assert.strictEqual(dm.togglePin('B', kept.id).pinned, false);
  dm.send('B', 'B', { type: 'text', content: 'one more' });
  assert.strictEqual(dm.findMessage('B', kept.id), undefined, 'it should be trimmed once unpinned');
});

test('pinning a DM is local: it never touches the peer or another thread', () => {
  const dm = makeDirectMessages();
  const mine = dm.send('B', 'B', { type: 'text', content: 'hi' });
  dm.send('C', 'C', { type: 'text', content: 'hi' });
  dm.togglePin('B', mine.id);
  assert.strictEqual(dm.getThread('C')[0].pinned, undefined, 'another thread must be untouched');
  assert.strictEqual(dm.togglePin('C', mine.id), undefined, 'a message is only pinnable from its own thread');
});

test('pinning a DM that is gone reports failure', () => {
  assert.strictEqual(makeDirectMessages().togglePin('B', 'does-not-exist'), undefined);
});

console.log('\n-- chunked transfer --');

const CHUNK = 100;

function chunksFor(message, transferId = 't1') {
  const parts = splitIntoChunks(message, CHUNK);
  return parts.map((data, index) => ({ transferId, index, total: parts.length, data }));
}

test('splitting then joining is lossless', () => {
  const message = 'x'.repeat(1000) + 'tail';
  assert.strictEqual(splitIntoChunks(message, CHUNK).join(''), message);
});

test('an exact multiple does not produce an empty trailing chunk', () => {
  assert.strictEqual(splitIntoChunks('y'.repeat(300), CHUNK).length, 3);
});

test('an empty message still produces one chunk', () => {
  assert.deepStrictEqual(splitIntoChunks('', CHUNK), ['']);
});

test('chunks arriving in order reassemble', () => {
  const a = new ChunkAssembler();
  const message = JSON.stringify({ type: 'clipboard', text: 'z'.repeat(500) });
  const parts = chunksFor(message);
  let result = null;
  for (const part of parts) result = a.accept('A', part);
  assert.strictEqual(result, message);
});

test('chunks arriving out of order reassemble', () => {
  const a = new ChunkAssembler();
  const message = 'q'.repeat(750) + 'END';
  const parts = chunksFor(message).reverse();
  let result = null;
  for (const part of parts) result = a.accept('A', part);
  assert.strictEqual(result, message);
});

test('duplicate chunks do not corrupt or double-complete', () => {
  const a = new ChunkAssembler();
  const message = 'd'.repeat(250);
  const parts = chunksFor(message);
  let completions = 0;
  for (const part of [...parts, ...parts]) {
    if (a.accept('A', part) !== null) completions++;
  }
  assert.strictEqual(completions, 1, 'must complete exactly once');
});

test('an incomplete transfer reports exactly what is missing', () => {
  const a = new ChunkAssembler();
  const parts = chunksFor('m'.repeat(500));
  a.accept('A', parts[0]);
  a.accept('A', parts[2]);
  a.accept('A', parts[4]);
  assert.deepStrictEqual(a.missing('A', 't1'), [1, 3]);
});

test('a transfer completes after the missing chunks are resent', () => {
  const a = new ChunkAssembler();
  const message = 'r'.repeat(500);
  const parts = chunksFor(message);
  parts.forEach((p, i) => { if (i !== 2) a.accept('A', p); });
  assert.strictEqual(a.accept('A', parts[2]), message, 'the retransmit should finish it');
});

test('two senders reusing the same transferId do not collide', () => {
  const a = new ChunkAssembler();
  const one = 'a'.repeat(150);
  const two = 'b'.repeat(150);
  const pa = chunksFor(one), pb = chunksFor(two);
  a.accept('A', pa[0]);
  a.accept('B', pb[0]);
  assert.strictEqual(a.accept('B', pb[1]), two);
  assert.strictEqual(a.accept('A', pa[1]), one);
});

test('a sender changing total mid-transfer is dropped', () => {
  const a = new ChunkAssembler();
  a.accept('A', { transferId: 't1', index: 0, total: 3, data: 'x' });
  assert.strictEqual(a.accept('A', { transferId: 't1', index: 1, total: 9, data: 'y' }), null);
  assert.strictEqual(a.inFlight, 0, 'the transfer must be abandoned, not silently merged');
});

test('an index beyond total is rejected', () => {
  const a = new ChunkAssembler();
  assert.strictEqual(a.accept('A', { transferId: 't1', index: 5, total: 3, data: 'x' }), null);
  assert.strictEqual(a.inFlight, 0);
});

test('malformed chunks are rejected without allocating', () => {
  const a = new ChunkAssembler();
  for (const bad of [
    { transferId: '', index: 0, total: 1, data: 'x' },
    { transferId: 't', index: -1, total: 1, data: 'x' },
    { transferId: 't', index: 0, total: 0, data: 'x' },
    { transferId: 't', index: 0, total: 1.5, data: 'x' },
    { transferId: 't', index: 0, total: 1, data: 42 },
    { transferId: 't'.repeat(200), index: 0, total: 1, data: 'x' }
  ]) {
    assert.strictEqual(a.accept('A', bad), null);
  }
  assert.strictEqual(a.inFlight, 0);
});

test('total above the chunk ceiling is refused', () => {
  const a = new ChunkAssembler({ maxMessageBytes: 1e9, maxTotalBytes: 1e9, maxConcurrentTransfers: 10, maxChunks: 8, ttlMs: 1000 });
  assert.strictEqual(a.accept('A', { transferId: 't1', index: 0, total: 9, data: 'x' }), null);
});

test('a message beyond the size ceiling is dropped, not buffered', () => {
  const a = new ChunkAssembler({ maxMessageBytes: 150, maxTotalBytes: 1e6, maxConcurrentTransfers: 10, maxChunks: 100, ttlMs: 1000 });
  const parts = chunksFor('z'.repeat(400));
  let result = null;
  for (const part of parts) result = a.accept('A', part);
  assert.strictEqual(result, null);
  assert.strictEqual(a.inFlight, 0);
  assert.strictEqual(a.buffered, 0, 'refusing a transfer must not leak its buffer');
});

test('the concurrent transfer cap holds', () => {
  const a = new ChunkAssembler({ maxMessageBytes: 1e6, maxTotalBytes: 1e6, maxConcurrentTransfers: 2, maxChunks: 100, ttlMs: 1000 });
  a.accept('A', { transferId: 't1', index: 0, total: 5, data: 'x' });
  a.accept('A', { transferId: 't2', index: 0, total: 5, data: 'x' });
  a.accept('A', { transferId: 't3', index: 0, total: 5, data: 'x' });
  assert.strictEqual(a.inFlight, 2);
});

test('the total buffer ceiling holds across transfers', () => {
  const a = new ChunkAssembler({ maxMessageBytes: 1e6, maxTotalBytes: 20, maxConcurrentTransfers: 10, maxChunks: 100, ttlMs: 1000 });
  a.accept('A', { transferId: 't1', index: 0, total: 5, data: 'x'.repeat(15) });
  a.accept('A', { transferId: 't2', index: 0, total: 5, data: 'y'.repeat(15) });
  assert.ok(a.buffered <= 20, `buffered ${a.buffered} exceeded the ceiling`);
});

test('a stalled transfer is swept and its memory released', () => {
  const a = new ChunkAssembler({ maxMessageBytes: 1e6, maxTotalBytes: 1e6, maxConcurrentTransfers: 10, maxChunks: 100, ttlMs: 1000 });
  a.accept('A', { transferId: 't1', index: 0, total: 5, data: 'x'.repeat(50) }, 1000);
  assert.strictEqual(a.sweep(1500).length, 0, 'must not sweep a transfer still within its ttl');
  const expired = a.sweep(3000);
  assert.strictEqual(expired.length, 1);
  assert.strictEqual(expired[0].received, 1);
  assert.strictEqual(expired[0].total, 5);
  assert.strictEqual(a.inFlight, 0);
  assert.strictEqual(a.buffered, 0);
});

test('progress refreshes the sweep deadline', () => {
  const a = new ChunkAssembler({ maxMessageBytes: 1e6, maxTotalBytes: 1e6, maxConcurrentTransfers: 10, maxChunks: 100, ttlMs: 1000 });
  a.accept('A', { transferId: 't1', index: 0, total: 3, data: 'x' }, 1000);
  a.accept('A', { transferId: 't1', index: 1, total: 3, data: 'y' }, 1800);
  assert.strictEqual(a.sweep(2500).length, 0, 'the later chunk should have reset the timer');
});

test('forgetting a sender releases only that sender', () => {
  const a = new ChunkAssembler();
  a.accept('A', { transferId: 't1', index: 0, total: 5, data: 'x' });
  a.accept('B', { transferId: 't1', index: 0, total: 5, data: 'y' });
  a.forgetSender('A');
  assert.strictEqual(a.inFlight, 1);
  assert.deepStrictEqual(a.missing('A', 't1'), []);
  assert.strictEqual(a.missing('B', 't1').length, 4);
});

test('a realistic screenshot-sized payload survives loss and reordering', () => {
  const a = new ChunkAssembler();
  // ~600 KB of base64, the shape of a real screenshot data URL.
  const message = JSON.stringify({ type: 'clipboard', dataUrl: 'data:image/png;base64,' + 'A'.repeat(600 * 1024) });
  const parts = splitIntoChunks(message, 40000).map((data, index, all) => ({ transferId: 'big', index, total: all.length, data }));

  const shuffled = [...parts].sort((x, y) => ((x.index * 7919) % 13) - ((y.index * 7919) % 13));
  const dropped = shuffled.filter((p) => p.index % 5 !== 3);

  let result = null;
  for (const part of dropped) result = a.accept('A', part);
  assert.strictEqual(result, null, 'must not complete while chunks are missing');

  const gaps = a.missing('A', 'big');
  assert.ok(gaps.length > 0);
  for (const index of gaps) result = a.accept('A', parts[index]);

  assert.strictEqual(result, message, 'retransmitting the gaps must reproduce the payload exactly');
});

console.log('\n-- network discovery --');

// Exactly what a Windows machine with WSL or VirtualBox installed looks like.
// This layout is why two devices on the same WiFi could not see each other.
const WINDOWS_DEV = [
  { name: 'vEthernet (WSL (Hyper-V firewall))', address: '172.29.128.1', netmask: '255.255.240.0', family: 'IPv4', internal: false },
  { name: 'VirtualBox Host-Only Network', address: '192.168.56.1', netmask: '255.255.255.0', family: 'IPv4', internal: false },
  { name: 'Wi-Fi', address: '192.168.1.7', netmask: '255.255.255.0', family: 'IPv4', internal: false },
  { name: 'Loopback Pseudo-Interface 1', address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true }
];

test('a subnet broadcast address is computed correctly', () => {
  assert.strictEqual(net.subnetBroadcast('192.168.1.7', '255.255.255.0'), '192.168.1.255');
  assert.strictEqual(net.subnetBroadcast('10.0.5.23', '255.255.0.0'), '10.0.255.255');
  assert.strictEqual(net.subnetBroadcast('172.29.128.1', '255.255.240.0'), '172.29.143.255');
  assert.strictEqual(net.subnetBroadcast('10.1.2.3', '255.0.0.0'), '10.255.255.255');
});

test('nonsense addresses do not produce a broadcast', () => {
  assert.strictEqual(net.subnetBroadcast('not.an.address', '255.255.255.0'), null);
  assert.strictEqual(net.subnetBroadcast('192.168.1.7', ''), null);
  assert.strictEqual(net.subnetBroadcast('192.168.1.7', '255.255.255.255'), null);
  assert.strictEqual(net.subnetBroadcast('999.1.1.1', '255.255.255.0'), null);
});

test('the WiFi subnet is broadcast to, not only 255.255.255.255', () => {
  const targets = net.listBroadcastTargets(WINDOWS_DEV);
  assert.ok(targets.includes('192.168.1.255'), 'missing the real WiFi subnet: ' + targets.join(', '));
  assert.ok(targets.includes(net.LIMITED_BROADCAST), 'limited broadcast should remain as a fallback');
});

test('virtual adapters are broadcast to as well, since the guess can be wrong', () => {
  const targets = net.listBroadcastTargets(WINDOWS_DEV);
  assert.ok(targets.includes('172.29.143.255'));
  assert.ok(targets.includes('192.168.56.255'));
});

test('the reply address is the WiFi adapter, not WSL or VirtualBox', () => {
  assert.strictEqual(net.pickLocalAddress(WINDOWS_DEV), '192.168.1.7');
});

test('enumeration order does not decide the reply address', () => {
  const shuffled = [WINDOWS_DEV[2], WINDOWS_DEV[0], WINDOWS_DEV[1], WINDOWS_DEV[3]];
  assert.strictEqual(net.pickLocalAddress(shuffled), '192.168.1.7');
});

test('loopback and link-local are never broadcast to or chosen', () => {
  const nics = [
    { name: 'Loopback', address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true },
    { name: 'Ethernet', address: '169.254.10.5', netmask: '255.255.0.0', family: 'IPv4', internal: false }
  ];
  assert.deepStrictEqual(net.listBroadcastTargets(nics), [net.LIMITED_BROADCAST]);
  assert.strictEqual(net.pickLocalAddress(nics), '127.0.0.1');
});

test('IPv6 addresses are ignored', () => {
  const nics = [
    { name: 'Wi-Fi', address: 'fe80::1', netmask: 'ffff::', family: 'IPv6', internal: false },
    { name: 'Wi-Fi', address: '192.168.1.7', netmask: '255.255.255.0', family: 'IPv4', internal: false }
  ];
  assert.deepStrictEqual(net.listBroadcastTargets(nics), ['192.168.1.255', net.LIMITED_BROADCAST]);
});

test('virtual adapters are recognised by name', () => {
  for (const name of ['vEthernet (WSL)', 'VirtualBox Host-Only Network', 'VMware Network Adapter VMnet8', 'Docker0', 'Tailscale']) {
    assert.strictEqual(net.isVirtualInterface(name), true, name + ' should be virtual');
  }
  for (const name of ['Wi-Fi', 'Ethernet', 'wlan0', 'en0']) {
    assert.strictEqual(net.isVirtualInterface(name), false, name + ' should be real');
  }
});

test('a machine with a single real adapter still works', () => {
  const nics = [{ name: 'Ethernet', address: '10.0.0.42', netmask: '255.255.255.0', family: 'IPv4', internal: false }];
  assert.deepStrictEqual(net.listBroadcastTargets(nics), ['10.0.0.255', net.LIMITED_BROADCAST]);
  assert.strictEqual(net.pickLocalAddress(nics), '10.0.0.42');
});

test('diagnostics mark which interface was chosen', () => {
  const report = net.describeInterfaces(WINDOWS_DEV);
  const wifi = report.find((r) => r.name === 'Wi-Fi');
  assert.ok(wifi.chosen);
  assert.strictEqual(wifi.broadcast, '192.168.1.255');
  assert.strictEqual(report.find((r) => r.name.indexOf('WSL') >= 0).virtual, true);
  assert.strictEqual(report.some((r) => r.address === '127.0.0.1'), false);
});

console.log('\n-- TCP framing --');

const MAX_FRAME = 1024 * 1024;
const decode = () => new FrameDecoder(MAX_FRAME);

test('a frame round-trips', () => {
  const d = decode();
  assert.deepStrictEqual(d.push(encodeFrame('{"a":1}', MAX_FRAME)), ['{"a":1}']);
});

test('two frames in one read both emerge', () => {
  const d = decode();
  const both = Buffer.concat([encodeFrame('one', MAX_FRAME), encodeFrame('two', MAX_FRAME)]);
  assert.deepStrictEqual(d.push(both), ['one', 'two']);
});

test('a frame split across reads is reassembled', () => {
  const d = decode();
  const frame = encodeFrame('{"hello":"world"}', MAX_FRAME);
  let out = [];
  for (const byte of frame) out = out.concat(d.push(Buffer.from([byte])));
  assert.deepStrictEqual(out, ['{"hello":"world"}'], 'byte-at-a-time delivery must still work');
});

test('a header split across reads is handled', () => {
  const d = decode();
  const frame = encodeFrame('payload', MAX_FRAME);
  assert.deepStrictEqual(d.push(frame.subarray(0, 2)), [], 'half a header yields nothing');
  assert.deepStrictEqual(d.push(frame.subarray(2)), ['payload']);
});

test('a frame plus part of the next holds the remainder back', () => {
  const d = decode();
  const a = encodeFrame('first', MAX_FRAME);
  const b = encodeFrame('second', MAX_FRAME);
  assert.deepStrictEqual(d.push(Buffer.concat([a, b.subarray(0, 3)])), ['first']);
  assert.deepStrictEqual(d.push(b.subarray(3)), ['second']);
});

test('unicode survives a split in the middle of a character', () => {
  const d = decode();
  const text = JSON.stringify({ note: 'café — naïve 日本語' });
  const frame = encodeFrame(text, MAX_FRAME);
  const cut = Math.floor(frame.length / 2);
  let out = d.push(frame.subarray(0, cut));
  out = out.concat(d.push(frame.subarray(cut)));
  assert.deepStrictEqual(out, [text]);
});

test('an oversized length is refused before anything is buffered', () => {
  const d = new FrameDecoder(100);
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32BE(500 * 1024 * 1024, 0);
  assert.deepStrictEqual(d.push(header), []);
  assert.strictEqual(d.isBroken, true, 'the connection should be marked for closing');
  assert.strictEqual(d.buffered, 0, 'nothing may be retained');
});

test('a zero-length frame is refused', () => {
  const d = decode();
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32BE(0, 0);
  d.push(header);
  assert.strictEqual(d.isBroken, true);
});

test('a broken decoder ignores everything after', () => {
  const d = new FrameDecoder(50);
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32BE(999999, 0);
  d.push(header);
  assert.deepStrictEqual(d.push(encodeFrame('ok', 50)), [], 'must stay shut once broken');
});

test('encoding refuses to build an oversized frame', () => {
  assert.throws(() => encodeFrame('x'.repeat(200), 100), /exceeds/);
});

test('a large frame survives fragmented delivery', () => {
  const d = decode();
  const text = JSON.stringify({ blob: 'A'.repeat(400 * 1024) });
  const frame = encodeFrame(text, MAX_FRAME);
  let out = [];
  for (let i = 0; i < frame.length; i += 1300) out = out.concat(d.push(frame.subarray(i, i + 1300)));
  assert.deepStrictEqual(out, [text]);
  assert.strictEqual(d.buffered, 0);
});

console.log('\n-- calls --');

/** A CallManager with a clock the test drives, so nothing waits on real time. */
function makeCalls() {
  const clock = { now: 1_000_000 };
  const manager = new CallManager(() => clock.now);
  return { manager, clock };
}

test('joining a call records the participant and the room', () => {
  const { manager } = makeCalls();
  manager.join('c1', 'r1', 'audio', 'A', 'Alice');

  const call = manager.getCall('c1');
  assert.strictEqual(call.roomId, 'r1');
  assert.strictEqual(call.mode, 'audio');
  assert.deepStrictEqual(call.participants, [{ deviceId: 'A', deviceName: 'Alice' }]);
});

test('re-joining is not treated as news, but a rename is', () => {
  const { manager } = makeCalls();
  assert.strictEqual(manager.join('c1', 'r1', 'audio', 'A', 'Alice'), true);
  assert.strictEqual(manager.join('c1', 'r1', 'audio', 'A', 'Alice'), false, 'a heartbeat is not news');
  assert.strictEqual(manager.join('c1', 'r1', 'audio', 'A', 'Alastair'), true, 'a rename is');
  assert.strictEqual(manager.countParticipants('c1'), 1, 'and does not duplicate the participant');
});

test('a call widens to video when anyone brings a camera, and stays there', () => {
  const { manager } = makeCalls();
  manager.join('c1', 'r1', 'audio', 'A', 'Alice');
  manager.join('c1', 'r1', 'video', 'B', 'Bob');
  assert.strictEqual(manager.getCall('c1').mode, 'video');

  manager.join('c1', 'r1', 'audio', 'C', 'Cara');
  assert.strictEqual(manager.getCall('c1').mode, 'video', 'a later audio joiner must not narrow it');
});

test('the last participant leaving ends the call', () => {
  const { manager } = makeCalls();
  manager.join('c1', 'r1', 'audio', 'A', 'Alice');
  manager.join('c1', 'r1', 'audio', 'B', 'Bob');

  manager.leave('c1', 'A');
  assert.strictEqual(manager.countParticipants('c1'), 1);
  manager.leave('c1', 'B');
  assert.strictEqual(manager.getCall('c1'), undefined);
  assert.deepStrictEqual(manager.list(), []);
});

test('leaving a call twice is harmless', () => {
  const { manager } = makeCalls();
  manager.join('c1', 'r1', 'audio', 'A', 'Alice');
  assert.strictEqual(manager.leave('c1', 'A'), true);
  assert.strictEqual(manager.leave('c1', 'A'), false);
});

test('a participant that goes quiet is swept, and takes an empty call with it', () => {
  const { manager, clock } = makeCalls();
  manager.join('c1', 'r1', 'audio', 'A', 'Alice');
  manager.join('c1', 'r1', 'audio', 'B', 'Bob');

  // Only one of them keeps announcing itself.
  clock.now += PARTICIPANT_TTL_MS - 1;
  manager.touch('c1', 'A');
  clock.now += 2;

  assert.strictEqual(manager.sweep(), true);
  assert.deepStrictEqual(
    manager.getCall('c1').participants.map((p) => p.deviceId),
    ['A'],
    'the one that stopped announcing is dropped'
  );

  clock.now += PARTICIPANT_TTL_MS + 1;
  manager.sweep();
  assert.strictEqual(manager.getCall('c1'), undefined, 'a call with nobody in it is over');
});

test('a sweep with nothing to do reports no change', () => {
  const { manager } = makeCalls();
  manager.join('c1', 'r1', 'audio', 'A', 'Alice');
  assert.strictEqual(manager.sweep(), false);
});

test('calls are tracked per room, oldest first', () => {
  const { manager, clock } = makeCalls();
  manager.join('c1', 'r1', 'audio', 'A', 'Alice');
  clock.now += 5000;
  manager.join('c2', 'r1', 'audio', 'B', 'Bob');
  manager.join('c3', 'r2', 'audio', 'C', 'Cara');

  assert.strictEqual(manager.getRoomCall('r1').callId, 'c1', 'the older call wins');
  assert.strictEqual(manager.getRoomCall('r2').callId, 'c3');
  assert.strictEqual(manager.getRoomCall('r3'), undefined);
  assert.deepStrictEqual(manager.list().map((c) => c.callId), ['c1', 'c2', 'c3']);
});

test('closing a room forgets its calls and leaves the others alone', () => {
  const { manager } = makeCalls();
  manager.join('c1', 'r1', 'audio', 'A', 'Alice');
  manager.join('c2', 'r2', 'audio', 'B', 'Bob');

  assert.strictEqual(manager.clearRoom('r1'), true);
  assert.strictEqual(manager.getCall('c1'), undefined);
  assert.strictEqual(manager.getCall('c2').callId, 'c2');
  assert.strictEqual(manager.clearRoom('r1'), false, 'a second clear changes nothing');
});

test('blocking a device takes it out of every call it was in', () => {
  const { manager } = makeCalls();
  manager.join('c1', 'r1', 'audio', 'A', 'Alice');
  manager.join('c1', 'r1', 'audio', 'B', 'Bob');
  manager.join('c2', 'r2', 'audio', 'B', 'Bob');

  assert.strictEqual(manager.leaveAll('B'), true);
  assert.strictEqual(manager.isParticipant('c1', 'B'), false);
  assert.strictEqual(manager.getCall('c2'), undefined, 'a call it was alone in ends');
  assert.strictEqual(manager.isParticipant('c1', 'A'), true, 'everyone else is untouched');
});

test('participants are listed by name, so the grid does not reshuffle', () => {
  const { manager } = makeCalls();
  manager.join('c1', 'r1', 'audio', 'C', 'Zoe');
  manager.join('c1', 'r1', 'audio', 'A', 'Adam');
  manager.join('c1', 'r1', 'audio', 'B', 'Mia');

  assert.deepStrictEqual(
    manager.getCall('c1').participants.map((p) => p.deviceName),
    ['Adam', 'Mia', 'Zoe']
  );
});

console.log('\n-- user data migration --');

const os = require('node:os');

/** A throwaway appData root with the directories a case needs. */
function makeDirs(layout) {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-migrate-'));
  for (const [name, config] of Object.entries(layout)) {
    fs.mkdirSync(path.join(appData, name), { recursive: true });
    if (config !== null) {
      fs.writeFileSync(path.join(appData, name, 'config.json'), JSON.stringify(config));
    }
  }
  return appData;
}

function readConfig(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
}

test('a previous install is carried across to the new name', () => {
  const appData = makeDirs({ 'shared-clipboard-desktop': { deviceId: 'kept', rooms: [1, 2] } });
  const userData = path.join(appData, 'campus-connect-desktop');

  const result = migrateUserData({
    appData,
    userData,
    legacyNames: ['shared-clipboard-desktop', 'Shared Clipboard']
  });

  assert.strictEqual(result.migrated, true);
  assert.strictEqual(readConfig(userData).deviceId, 'kept');
  assert.deepStrictEqual(readConfig(userData).rooms, [1, 2]);
});

test('the old directory is left where it was, so the old build still runs', () => {
  const appData = makeDirs({ 'shared-clipboard-desktop': { deviceId: 'kept' } });
  const userData = path.join(appData, 'campus-connect-desktop');

  migrateUserData({ appData, userData, legacyNames: ['shared-clipboard-desktop'] });
  assert.strictEqual(readConfig(path.join(appData, 'shared-clipboard-desktop')).deviceId, 'kept');
});

test('an existing install is never overwritten', () => {
  const appData = makeDirs({
    'shared-clipboard-desktop': { deviceId: 'old' },
    'campus-connect-desktop': { deviceId: 'current' }
  });
  const userData = path.join(appData, 'campus-connect-desktop');

  const result = migrateUserData({ appData, userData, legacyNames: ['shared-clipboard-desktop'] });
  assert.strictEqual(result.migrated, false);
  assert.strictEqual(readConfig(userData).deviceId, 'current');
});

test('a fresh machine with nothing to migrate is not an error', () => {
  const appData = makeDirs({});
  const result = migrateUserData({
    appData,
    userData: path.join(appData, 'campus-connect-desktop'),
    legacyNames: ['shared-clipboard-desktop']
  });

  assert.strictEqual(result.migrated, false);
  assert.strictEqual(result.error, undefined);
});

test('a legacy directory with no settings file is not treated as an install', () => {
  const appData = makeDirs({ 'shared-clipboard-desktop': null });
  const result = migrateUserData({
    appData,
    userData: path.join(appData, 'campus-connect-desktop'),
    legacyNames: ['shared-clipboard-desktop']
  });

  assert.strictEqual(result.migrated, false);
});

test('the first legacy name that exists wins', () => {
  const appData = makeDirs({
    'shared-clipboard-desktop': { deviceId: 'newer' },
    'Shared Clipboard': { deviceId: 'older' }
  });
  const userData = path.join(appData, 'campus-connect-desktop');

  migrateUserData({
    appData,
    userData,
    legacyNames: ['shared-clipboard-desktop', 'Shared Clipboard']
  });
  assert.strictEqual(readConfig(userData).deviceId, 'newer');
});

test('a legacy name that resolves to the same directory is skipped', () => {
  const appData = makeDirs({ 'campus-connect-desktop': { deviceId: 'current' } });
  const userData = path.join(appData, 'campus-connect-desktop');

  // Nothing to do, and above all nothing that could copy a directory onto
  // itself and destroy it.
  const result = migrateUserData({
    appData,
    userData,
    legacyNames: ['campus-connect-desktop']
  });
  assert.strictEqual(result.migrated, false);
  assert.strictEqual(readConfig(userData).deviceId, 'current');
});

console.log('\n-- remote desktop: input mapping --');

test('browser key names translate to robotjs names', () => {
  assert.strictEqual(toRobotKey('ArrowUp'), 'up');
  assert.strictEqual(toRobotKey('Escape'), 'escape');
  assert.strictEqual(toRobotKey('Enter'), 'enter');
  assert.strictEqual(toRobotKey(' '), 'space');
  assert.strictEqual(toRobotKey('Control'), 'control');
  assert.strictEqual(toRobotKey('Meta'), 'command');
  assert.strictEqual(toRobotKey('F5'), 'f5');
  assert.strictEqual(toRobotKey('a'), 'a');
  assert.strictEqual(toRobotKey('A'), 'a');
  assert.strictEqual(toRobotKey('/'), '/');
});

test('unrecognised and dangerous keys are refused rather than guessed', () => {
  assert.strictEqual(toRobotKey('BrightnessUp'), null);
  assert.strictEqual(toRobotKey('Power'), null);
  assert.strictEqual(toRobotKey('SomethingInvented'), null);
  assert.strictEqual(toRobotKey('f25'), null, 'there is no F25');
  assert.strictEqual(toRobotKey(''), null);
  assert.strictEqual(toRobotKey('x'.repeat(50)), null);
});

test('fractions map onto the shared screen, including a second monitor', () => {
  const primary = { x: 0, y: 0, width: 1920, height: 1080 };
  assert.deepStrictEqual(toScreenPoint(0, 0, primary), { x: 0, y: 0 });
  assert.deepStrictEqual(toScreenPoint(1, 1, primary), { x: 1919, y: 1079 });
  assert.deepStrictEqual(toScreenPoint(0.5, 0.5, primary), { x: 960, y: 540 });

  // A display to the right of the primary one starts at x=1920.
  const secondary = { x: 1920, y: 0, width: 1280, height: 720 };
  assert.deepStrictEqual(toScreenPoint(0, 0, secondary), { x: 1920, y: 0 });
  assert.deepStrictEqual(toScreenPoint(1, 1, secondary), { x: 3199, y: 719 });
});

test('out-of-range coordinates are clamped, not obeyed', () => {
  const bounds = { x: 0, y: 0, width: 1920, height: 1080 };
  // A controller must not be able to fling the pointer off the shared screen.
  assert.deepStrictEqual(toScreenPoint(12.5, -4, bounds), { x: 1919, y: 0 });
  // Garbage is not interpreted generously: a non-finite coordinate becomes the
  // origin rather than being guessed at as "the far edge".
  assert.deepStrictEqual(toScreenPoint(NaN, Infinity, bounds), { x: 0, y: 0 });
});

test('bounds are scaled from logical to physical pixels for a non-100% display', () => {
  // A 1920x1080 *logical* display at 150% Windows scaling is really
  // 2880x1620 physical pixels — what the native cursor APIs expect.
  const logical = { x: 0, y: 0, width: 1920, height: 1080 };
  assert.deepStrictEqual(scaleBounds(logical, 1.5), { x: 0, y: 0, width: 2880, height: 1620 });

  // A second, logical-space display to the right of a scaled primary one —
  // its origin scales along with everything else.
  const secondary = { x: 1920, y: 0, width: 1280, height: 720 };
  assert.deepStrictEqual(scaleBounds(secondary, 1.5), { x: 2880, y: 0, width: 1920, height: 1080 });

  // 100% scaling is a no-op, and negative origins (a monitor above/left of
  // the primary) scale arithmetically rather than being treated specially.
  assert.deepStrictEqual(scaleBounds(logical, 1), logical);
  const aboveLeft = { x: -1920, y: -200, width: 1920, height: 1080 };
  assert.deepStrictEqual(scaleBounds(aboveLeft, 2), { x: -3840, y: -400, width: 3840, height: 2160 });

  // A missing or nonsensical scale factor falls back to 1 rather than
  // producing NaN/Infinity coordinates the injector would then clamp oddly.
  assert.deepStrictEqual(scaleBounds(logical, 0), logical);
  assert.deepStrictEqual(scaleBounds(logical, NaN), logical);
});

console.log('\n-- remote desktop: event validation --');

test('well-formed events survive validation', () => {
  assert.deepStrictEqual(parseRemoteInput({ t: 'move', x: 0.5, y: 0.25 }), { t: 'move', x: 0.5, y: 0.25 });
  assert.deepStrictEqual(parseRemoteInput({ t: 'down', x: 0, y: 0, b: 'right' }), {
    t: 'down',
    x: 0,
    y: 0,
    b: 'right'
  });
  assert.deepStrictEqual(parseRemoteInput({ t: 'scroll', dx: 0, dy: -3 }), { t: 'scroll', dx: 0, dy: -3 });
  assert.deepStrictEqual(parseRemoteInput({ t: 'key', k: 'a', down: true }), { t: 'key', k: 'a', down: true });
  assert.deepStrictEqual(parseRemoteInput({ t: 'text', s: 'hi' }), { t: 'text', s: 'hi' });
});

test('malformed events are rejected outright', () => {
  for (const bad of [
    null,
    undefined,
    'move',
    42,
    {},
    { t: 'nonsense' },
    { t: 'move', x: '0.5', y: 0.5 },
    { t: 'move', x: 0.5 },
    { t: 'down', x: 0, y: 0, b: 'extra' },
    { t: 'key', k: 'a' },
    { t: 'key', k: 5, down: true },
    { t: 'text', s: '' }
  ]) {
    assert.strictEqual(parseRemoteInput(bad), null, `${JSON.stringify(bad)} must be refused`);
  }
});

test('a paste cannot be used to flood the host', () => {
  assert.ok(parseRemoteInput({ t: 'text', s: 'x'.repeat(MAX_TEXT_LENGTH) }));
  assert.strictEqual(parseRemoteInput({ t: 'text', s: 'x'.repeat(MAX_TEXT_LENGTH + 1) }), null);
});

console.log('\n-- remote desktop: injection --');

/** A stand-in for the native module that records what it was told to do. */
function fakeRobot() {
  const calls = [];
  return {
    calls,
    moveMouse: (x, y) => calls.push(['move', x, y]),
    mouseToggle: (down, button) => calls.push(['mouse', down, button]),
    scrollMouse: (x, y) => calls.push(['scroll', x, y]),
    keyToggle: (key, down) => calls.push(['key', key, down]),
    typeString: (text) => calls.push(['type', text])
  };
}

const BOUNDS = { x: 0, y: 0, width: 1000, height: 1000 };

test('a move becomes a move at the mapped point', () => {
  const robot = fakeRobot();
  const injector = createInjector(robot, () => BOUNDS);

  assert.strictEqual(injector.apply({ t: 'move', x: 0.5, y: 0.5 }), true);
  assert.deepStrictEqual(robot.calls, [['move', 500, 500]]);
});

test('a click moves first, so it lands where the controller is pointing', () => {
  const robot = fakeRobot();
  const injector = createInjector(robot, () => BOUNDS);

  injector.apply({ t: 'down', x: 0.25, y: 0.75, b: 'left' });
  // Without the move, a dropped move event would put the click at the previous
  // position — which is how a remote click lands on the wrong thing.
  assert.deepStrictEqual(robot.calls, [
    ['move', 250, 749],
    ['mouse', 'down', 'left']
  ]);
});

test('text is typed as a string, not as key presses', () => {
  const robot = fakeRobot();
  const injector = createInjector(robot, () => BOUNDS);

  injector.apply({ t: 'text', s: 'héllo' });
  // Key codes belong to the controller's layout; a string does not.
  assert.deepStrictEqual(robot.calls, [['type', 'héllo']]);
});

test('a refused key never reaches the machine', () => {
  const robot = fakeRobot();
  const injector = createInjector(robot, () => BOUNDS);

  assert.strictEqual(injector.apply({ t: 'key', k: 'Power', down: true }), false);
  assert.deepStrictEqual(robot.calls, []);
});

test('nothing is injected when the shared screen has gone', () => {
  const robot = fakeRobot();
  const injector = createInjector(robot, () => null);

  assert.strictEqual(injector.apply({ t: 'move', x: 0.5, y: 0.5 }), false);
  assert.strictEqual(injector.apply({ t: 'down', x: 0.5, y: 0.5, b: 'left' }), false);
  assert.deepStrictEqual(robot.calls, [], 'an unplugged monitor must not mean a click at (0,0)');
});

test('held keys and buttons are released when the session ends', () => {
  const robot = fakeRobot();
  const injector = createInjector(robot, () => BOUNDS);

  injector.apply({ t: 'key', k: 'Control', down: true });
  injector.apply({ t: 'key', k: 'c', down: true });
  injector.apply({ t: 'down', x: 0, y: 0, b: 'left' });
  assert.deepStrictEqual(injector.held(), ['c', 'control', 'left']);

  robot.calls.length = 0;
  injector.releaseAll();

  // Every one of them let go, or the person at the host is left with a stuck
  // modifier and a keyboard that has apparently stopped working.
  assert.deepStrictEqual(robot.calls.sort(), [
    ['key', 'c', 'up'],
    ['key', 'control', 'up'],
    ['mouse', 'up', 'left']
  ]);
  assert.deepStrictEqual(injector.held(), []);
});

test('a key released normally is not released twice', () => {
  const robot = fakeRobot();
  const injector = createInjector(robot, () => BOUNDS);

  injector.apply({ t: 'key', k: 'Shift', down: true });
  injector.apply({ t: 'key', k: 'Shift', down: false });
  assert.deepStrictEqual(injector.held(), []);

  robot.calls.length = 0;
  injector.releaseAll();
  assert.deepStrictEqual(robot.calls, []);
});

test('releasing survives the native module throwing', () => {
  const robot = fakeRobot();
  const injector = createInjector(robot, () => BOUNDS);

  injector.apply({ t: 'key', k: 'Control', down: true });
  injector.apply({ t: 'key', k: 'Alt', down: true });
  injector.apply({ t: 'down', x: 0, y: 0, b: 'left' });

  // The device disappears between the session ending and the keys being let go.
  let thrown = 0;
  robot.keyToggle = () => {
    thrown += 1;
    throw new Error('device gone');
  };

  assert.doesNotThrow(() => injector.releaseAll());
  assert.strictEqual(thrown, 2, 'both keys are still attempted');
  assert.deepStrictEqual(
    robot.calls.filter((call) => call[0] === 'mouse'),
    [['mouse', 'down', 'left'], ['mouse', 'up', 'left']],
    'the button is still released after the keys failed'
  );
  assert.deepStrictEqual(injector.held(), [], 'one key failing must not strand the rest');
});

console.log('\n-- remote desktop: sessions --');

function makeSessions() {
  const clock = { now: 1_000_000 };
  return { manager: new RemoteSessionManager(() => clock.now), clock };
}

const HOST_SESSION = {
  sessionId: 's1',
  roomId: 'r1',
  role: 'host',
  peerId: 'B',
  peerName: 'Bob',
  grant: 'control',
  screenLabel: 'Screen 1'
};

test('input is only injected for a live hosted session with control granted', () => {
  const { manager } = makeSessions();
  assert.strictEqual(manager.mayInject('s1', 'B'), false, 'no session means no');

  manager.start(HOST_SESSION);
  assert.strictEqual(manager.mayInject('s1', 'B'), true);
});

test('viewing never permits input', () => {
  const { manager } = makeSessions();
  manager.start({ ...HOST_SESSION, grant: 'view' });
  assert.strictEqual(manager.mayInject('s1', 'B'), false);
});

test('taking control back stops input immediately', () => {
  const { manager } = makeSessions();
  manager.start(HOST_SESSION);
  assert.strictEqual(manager.mayInject('s1', 'B'), true);

  manager.setGrant('s1', 'view');
  assert.strictEqual(manager.mayInject('s1', 'B'), false);
});

test('the wrong device or the wrong session cannot inject', () => {
  const { manager } = makeSessions();
  manager.start(HOST_SESSION);

  assert.strictEqual(manager.mayInject('s1', 'C'), false, 'a different device');
  assert.strictEqual(manager.mayInject('s2', 'B'), false, 'a different session');
  assert.strictEqual(manager.mayInject('', ''), false);
});

test('the controlling end never injects into itself', () => {
  const { manager } = makeSessions();
  manager.start({ ...HOST_SESSION, role: 'controller' });
  // Being in a session as the controller must not make this machine drivable.
  assert.strictEqual(manager.mayInject('s1', 'B'), false);
});

test('a second session cannot displace a running one', () => {
  const { manager } = makeSessions();
  manager.start(HOST_SESSION);

  assert.strictEqual(manager.start({ ...HOST_SESSION, sessionId: 's2', peerId: 'C' }), false);
  assert.strictEqual(manager.current.sessionId, 's1');
  assert.strictEqual(manager.mayInject('s2', 'C'), false);
});

test('requests are refused while a session is running', () => {
  const { manager } = makeSessions();
  manager.start(HOST_SESSION);

  const added = manager.addRequest({
    sessionId: 's9',
    roomId: 'r1',
    fromDeviceId: 'C',
    fromDeviceName: 'Cara',
    at: Date.now()
  });
  assert.strictEqual(added, false);
});

test('a duplicate request is not queued twice', () => {
  const { manager, clock } = makeSessions();
  const request = { sessionId: 's1', roomId: 'r1', fromDeviceId: 'B', fromDeviceName: 'Bob', at: clock.now };

  assert.strictEqual(manager.addRequest(request), true);
  assert.strictEqual(manager.addRequest(request), false);
  assert.strictEqual(manager.listRequests().length, 1);
});

test('an unanswered request expires rather than waiting forever', () => {
  const { manager, clock } = makeSessions();
  manager.addRequest({ sessionId: 's1', roomId: 'r1', fromDeviceId: 'B', fromDeviceName: 'Bob', at: clock.now });

  clock.now += REQUEST_TIMEOUT_MS - 1;
  assert.deepStrictEqual(manager.sweepRequests(), []);

  clock.now += 2;
  assert.deepStrictEqual(manager.sweepRequests(), ['s1']);
  assert.deepStrictEqual(manager.listRequests(), []);
});

test('ending a session stops any further injection', () => {
  const { manager } = makeSessions();
  manager.start(HOST_SESSION);

  const ended = manager.end();
  assert.strictEqual(ended.sessionId, 's1');
  assert.strictEqual(manager.mayInject('s1', 'B'), false);
  assert.strictEqual(manager.current, null);
});

test('losing the room ends the session it belonged to', () => {
  const { manager } = makeSessions();
  manager.start(HOST_SESSION);

  assert.strictEqual(manager.clearRoom('other'), null, 'a different room changes nothing');
  assert.ok(manager.current);

  assert.ok(manager.clearRoom('r1'));
  assert.strictEqual(manager.mayInject('s1', 'B'), false);
});

test('blocking the peer ends the session and drops its requests', () => {
  const { manager, clock } = makeSessions();
  manager.addRequest({ sessionId: 's2', roomId: 'r1', fromDeviceId: 'B', fromDeviceName: 'Bob', at: clock.now });
  manager.start(HOST_SESSION);

  assert.ok(manager.clearDevice('B'));
  assert.strictEqual(manager.mayInject('s1', 'B'), false);
  assert.deepStrictEqual(manager.listRequests(), []);
});

test('ending someone else\'s session id does nothing', () => {
  const { manager } = makeSessions();
  manager.start(HOST_SESSION);

  assert.strictEqual(manager.end('s2'), null);
  assert.strictEqual(manager.mayInject('s1', 'B'), true, 'the real session is untouched');
});

console.log('\n-- snippets --');

function makeSnippets() {
  const clock = { now: 1_000_000 };
  let stored = [];
  const manager = new SnippetManager(
    { read: () => stored, write: (next) => { stored = next; } },
    () => clock.now
  );
  return { manager, clock, dump: () => stored };
}

test('a snippet is saved and comes back', () => {
  const { manager, dump } = makeSnippets();
  const saved = manager.save({ label: 'Dev', content: 'npm run dev' });

  assert.strictEqual(saved.label, 'Dev');
  assert.strictEqual(saved.content, 'npm run dev');
  assert.strictEqual(dump().length, 1, 'and is persisted');
});

test('blank content is refused', () => {
  const { manager } = makeSnippets();
  assert.strictEqual(manager.save({ label: 'x', content: '   ' }), null);
});

test('saving the same content twice leaves one snippet', () => {
  const { manager } = makeSnippets();
  const first = manager.save({ label: '', content: 'npm run dev' });
  const second = manager.save({ label: 'Dev', content: 'npm run dev' });

  assert.strictEqual(second.id, first.id, 'the existing one is returned');
  assert.strictEqual(second.label, 'Dev', 'and picks up the new name');
  assert.strictEqual(manager.list().length, 1);
});

test('an edit rewrites in place rather than adding', () => {
  const { manager } = makeSnippets();
  const saved = manager.save({ label: 'Dev', content: 'npm run dev' });
  manager.save({ id: saved.id, label: 'Dev server', content: 'npm run dev -- --host' });

  assert.strictEqual(manager.list().length, 1);
  assert.strictEqual(manager.get(saved.id).content, 'npm run dev -- --host');
});

test('what you reach for surfaces first', () => {
  const { manager, clock } = makeSnippets();
  manager.save({ label: 'A', content: 'a' });
  manager.save({ label: 'B', content: 'b' });
  const c = manager.save({ label: 'C', content: 'c' });

  clock.now += 1000;
  manager.markUsed(c.id);

  assert.strictEqual(manager.list()[0].label, 'C', 'recently used wins');
});

test('a stale favourite does not outrank something used today', () => {
  const { manager, clock } = makeSnippets();
  const old = manager.save({ label: 'Last term', content: 'old' });

  // Used forty times, but months ago.
  for (let i = 0; i < 40; i++) manager.markUsed(old.id);

  clock.now += 60 * 24 * 60 * 60 * 1000;
  const fresh = manager.save({ label: 'Today', content: 'new' });
  manager.markUsed(fresh.id);

  assert.strictEqual(manager.list()[0].label, 'Today');
});

test('unused snippets fall back to newest first', () => {
  const { manager, clock } = makeSnippets();
  manager.save({ label: 'First', content: '1' });
  clock.now += 1000;
  manager.save({ label: 'Second', content: '2' });

  assert.deepStrictEqual(manager.list().map((s) => s.label), ['Second', 'First']);
});

test('search matches the name and the content', () => {
  const { manager } = makeSnippets();
  manager.save({ label: 'Dev server', content: 'npm run dev' });
  manager.save({ label: 'Build', content: 'npm run build' });

  assert.deepStrictEqual(manager.search('server').map((s) => s.label), ['Dev server']);
  assert.strictEqual(manager.search('npm').length, 2, 'content matches too');
  assert.strictEqual(manager.search('nothing').length, 0);
  assert.strictEqual(manager.search('  ').length, 2, 'a blank query is not a filter');
});

test('deleting removes it, and deleting twice is harmless', () => {
  const { manager } = makeSnippets();
  const saved = manager.save({ label: 'X', content: 'x' });

  assert.strictEqual(manager.remove(saved.id), true);
  assert.strictEqual(manager.remove(saved.id), false);
  assert.deepStrictEqual(manager.list(), []);
});

test('snippets survive a restart', () => {
  let stored = [];
  const persistence = { read: () => stored, write: (next) => { stored = next; } };

  const first = new SnippetManager(persistence);
  first.save({ label: 'Kept', content: 'keep me' });

  const second = new SnippetManager(persistence);
  assert.strictEqual(second.list()[0].label, 'Kept');
});

console.log('\n-- universal search --');

test('one query finds both a copied item and a message', () => {
  const h = makeHistory();
  h.addClipboardEntry('text', 'https://example.com/deploy', 'A', 'Laptop-A', 'r1');
  h.addChatMessage({ type: 'text', content: 'deploy is broken again', deviceId: 'B', deviceName: 'Laptop-B', roomId: 'r2' });

  const hits = h.search('deploy', new Map([['r1', 'Project'], ['r2', 'Team']]));
  assert.strictEqual(hits.length, 2);
  assert.deepStrictEqual(hits.map((hit) => hit.kind).sort(), ['chat', 'clipboard']);
  assert.deepStrictEqual(hits.map((hit) => hit.roomName).sort(), ['Project', 'Team']);
});

test('search is case-insensitive and spans every room', () => {
  const h = makeHistory();
  h.addClipboardEntry('text', 'API_KEY=abc', 'A', 'A', 'r1');
  h.addClipboardEntry('text', 'api docs', 'A', 'A', 'r2');

  assert.strictEqual(h.search('API', new Map()).length, 2);
});

test('a blank query finds nothing rather than everything', () => {
  const h = makeHistory();
  h.addClipboardEntry('text', 'something', 'A', 'A', 'r1');

  assert.deepStrictEqual(h.search('', new Map()), []);
  assert.deepStrictEqual(h.search('   ', new Map()), []);
});

test('a withdrawn message cannot be found', () => {
  const h = makeHistory();
  const message = h.addChatMessage({ type: 'text', content: 'the password is hunter2', deviceId: 'A', deviceName: 'A', roomId: 'r1' });
  h.markChatMessageDeleted(message.id, 'A');

  // Surfacing it in search would undo the withdrawal.
  assert.deepStrictEqual(h.search('hunter2', new Map()), []);
});

test('the excerpt is taken from around the match, not the start', () => {
  const h = makeHistory();
  const padding = 'x'.repeat(500);
  h.addClipboardEntry('text', padding + ' NEEDLE ' + padding, 'A', 'A', 'r1');

  const [hit] = h.search('needle', new Map());
  assert.ok(hit.excerpt.includes('NEEDLE'), 'the match must be in the excerpt');
  assert.ok(hit.excerpt.length < 250, 'excerpt was ' + hit.excerpt.length + ' chars');
  assert.strictEqual(
    hit.excerpt.slice(hit.matchStart, hit.matchStart + hit.matchLength).toLowerCase(),
    'needle',
    'the offsets must point at the match'
  );
});

test('offsets stay correct when whitespace is collapsed', () => {
  const h = makeHistory();
  h.addClipboardEntry('text', 'line one\n\n\n   line two NEEDLE here', 'A', 'A', 'r1');

  const [hit] = h.search('needle', new Map());
  assert.strictEqual(
    hit.excerpt.slice(hit.matchStart, hit.matchStart + hit.matchLength).toLowerCase(),
    'needle'
  );
});

test('a file name is searchable even when the message body is not', () => {
  const h = makeHistory();
  h.addChatMessage({ type: 'file', content: '', fileName: 'lecture-notes.pdf', fileSize: 10, deviceId: 'A', deviceName: 'A', roomId: 'r1' });

  const [hit] = h.search('lecture', new Map([['r1', 'Class']]));
  assert.strictEqual(hit.fileName, 'lecture-notes.pdf');
});

test('a room you have left is labelled rather than shown as an id', () => {
  const h = makeHistory();
  h.addClipboardEntry('text', 'orphaned', 'A', 'A', 'gone');

  const [hit] = h.search('orphaned', new Map());
  assert.strictEqual(hit.roomName, 'A room you have left');
});

test('results come back newest first', () => {
  const h = makeHistory();
  h.addClipboardEntry('text', 'match one', 'A', 'A', 'r1');
  h.addClipboardEntry('text', 'match two', 'A', 'A', 'r1');

  const hits = h.search('match', new Map());
  assert.ok(hits[0].timestamp >= hits[1].timestamp);
});

console.log('\n-- content types --');

test('a bare URL is recognised and labelled by host', () => {
  const info = detectContent('https://github.com/Vijayapardhu/Clipboard');
  assert.strictEqual(info.kind, 'url');
  assert.strictEqual(info.label, 'github.com');
  assert.strictEqual(info.value, 'https://github.com/Vijayapardhu/Clipboard');
});

test('prose merely containing a link is not a link', () => {
  // A wrong guess here would put an "Open" button on a sentence.
  assert.strictEqual(detectContent('have a look at https://example.com when you can').kind, 'text');
});

test('an email address is recognised', () => {
  const info = detectContent('someone@example.ac.uk');
  assert.strictEqual(info.kind, 'email');
  assert.strictEqual(info.value, 'someone@example.ac.uk');
});

test('colours are recognised in hex and rgb', () => {
  for (const value of ['#fff', '#4f46e5', '#4f46e5cc', 'rgb(79, 70, 229)', 'rgba(79,70,229,0.5)']) {
    assert.strictEqual(detectContent(value).kind, 'color', value + ' should be a colour');
  }
  assert.strictEqual(detectContent('#zzzzzz').kind, 'text');
});

test('JSON is recognised and its shape described', () => {
  assert.strictEqual(detectContent('{"a":1,"b":2}').label, 'JSON · 2 fields');
  assert.strictEqual(detectContent('[1,2,3]').label, 'JSON · 3 items');
  assert.strictEqual(detectContent('{"a":1}').label, 'JSON · 1 field');
  assert.strictEqual(detectContent('{not json').kind !== 'json', true);
});

test('shell commands and code are recognised', () => {
  for (const value of [
    'npm run dev -- --host',
    'git commit -m "fix"',
    'const x = () => 1;',
    'function hello() {\n  return 1;\n}',
    'sudo apt install nodejs'
  ]) {
    assert.strictEqual(detectContent(value).kind, 'code', JSON.stringify(value) + ' should be code');
  }
});

test('ordinary prose is not mistaken for code', () => {
  for (const value of [
    'remember to bring the lab report tomorrow',
    'The meeting is at 3pm; bring your laptop.',
    'Hello there'
  ]) {
    assert.strictEqual(detectContent(value).kind, 'text', JSON.stringify(value) + ' should be text');
  }
});

test('numbers are recognised, long digit strings are not over-claimed', () => {
  assert.strictEqual(detectContent('20BQ1A0501').kind, 'text');
  assert.strictEqual(detectContent('1234567890').kind, 'number');
  assert.strictEqual(detectContent('  42  ').kind, 'number');
});

test('empty and enormous values fall back to plain text', () => {
  assert.strictEqual(detectContent('').kind, 'text');
  assert.strictEqual(detectContent('   ').kind, 'text');
  assert.strictEqual(detectContent('https://example.com/' + 'a'.repeat(5000)).kind, 'text');
});

test('only http and https are ever openable', () => {
  assert.strictEqual(isOpenableUrl('https://example.com'), true);
  assert.strictEqual(isOpenableUrl('http://192.168.1.5:8080/x'), true);

  // Everything a clipboard can plausibly contain that must never be launched.
  for (const value of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'ms-msdt:/id',
    'smb://server/share',
    'not a url at all',
    ''
  ]) {
    assert.strictEqual(isOpenableUrl(value), false, JSON.stringify(value) + ' must not be openable');
  }
});

console.log('\n-- exporting a conversation --');

// Injected so the assertions do not depend on the machine's locale or timezone.
const AT = (t) => `T${t}`;
const OPTS = { title: 'Team Room', exportedAt: 500, formatTime: AT };

function textEntry(timestamp, author, content, extra = {}) {
  return { timestamp, author, type: 'text', content, ...extra };
}

test('a transcript reads oldest first, whatever order it was handed', () => {
  const out = formatTranscript(
    [textEntry(300, 'Bob', 'third'), textEntry(100, 'Alice', 'first'), textEntry(200, 'Bob', 'second')],
    OPTS
  );
  const body = out.split('\n').filter((line) => line.startsWith('[T'));
  assert.deepStrictEqual(body, ['[T100] Alice: first', '[T200] Bob: second', '[T300] Bob: third']);
});

test('the header names the conversation and counts what is in it', () => {
  const out = formatTranscript([textEntry(1, 'A', 'x'), textEntry(2, 'B', 'y')], OPTS);
  assert.ok(out.startsWith('Campus Connect — Team Room\n'), 'the title comes first');
  assert.ok(out.includes('Exported T500'));
  assert.ok(out.includes('2 messages'));
});

test('one message is counted in the singular', () => {
  assert.ok(formatTranscript([textEntry(1, 'A', 'x')], OPTS).includes('1 message\n'));
});

test('an attachment is named rather than written, and says which kind it was', () => {
  const out = formatTranscript(
    [
      { timestamp: 1, author: 'A', type: 'file', content: '', fileName: 'report.pdf' },
      { timestamp: 2, author: 'A', type: 'image', content: '', fileName: 'screen.png' }
    ],
    OPTS
  );
  assert.ok(out.includes('[T1] A: [sent a file: report.pdf]'));
  assert.ok(out.includes('[T2] A: [sent an image: screen.png]'));
});

test('an attachment with no name still exports as something readable', () => {
  const out = formatTranscript([{ timestamp: 1, author: 'A', type: 'file', content: '' }], OPTS);
  assert.ok(out.includes('[sent a file: attachment]'));
});

test('a withdrawn message leaves a marker, not its content', () => {
  const out = formatTranscript([textEntry(1, 'A', '', { deleted: true })], OPTS);
  assert.ok(out.includes('[T1] A: (message deleted)'));
});

test('a deleted attachment reports as deleted rather than as a file', () => {
  const out = formatTranscript(
    [{ timestamp: 1, author: 'A', type: 'file', content: '', fileName: 'gone.pdf', deleted: true }],
    OPTS
  );
  assert.ok(out.includes('(message deleted)'));
  assert.ok(!out.includes('gone.pdf'), 'a withdrawn message must not leak its filename');
});

test('an edited message is marked as edited', () => {
  const out = formatTranscript([textEntry(1, 'A', 'fixed', { editedAt: 9 })], OPTS);
  assert.ok(out.includes('[T1] A: fixed (edited)'));
});

test('a multi-line message is indented under its own header, so it cannot read as two', () => {
  const out = formatTranscript([textEntry(1, 'A', 'line one\nline two'), textEntry(2, 'B', 'after')], OPTS);
  assert.ok(out.includes('[T1] A: line one\n    line two\n'));
  assert.ok(out.includes('[T2] B: after'));
});

test('an empty conversation still produces a well-formed file', () => {
  const out = formatTranscript([], OPTS);
  assert.ok(out.includes('0 messages'));
  assert.ok(out.endsWith('\n'));
});

test('the file ends with a newline, the way a text file should', () => {
  assert.ok(formatTranscript([textEntry(1, 'A', 'x')], OPTS).endsWith('\n'));
});

test('a filename is dated and stripped of anything a filesystem would object to', () => {
  assert.strictEqual(transcriptFileName('Team Room', Date.UTC(2026, 7, 8)), 'Team-Room-2026-08-08.txt');
  assert.strictEqual(transcriptFileName('a/b\\c:d*?"<>|', Date.UTC(2026, 7, 8)), 'a-b-c-d-2026-08-08.txt');
});

test('a name that is entirely punctuation still yields a usable filename', () => {
  assert.strictEqual(transcriptFileName('***', Date.UTC(2026, 7, 8)), 'conversation-2026-08-08.txt');
});

test('a very long conversation name is truncated rather than refused', () => {
  const name = transcriptFileName('x'.repeat(200), Date.UTC(2026, 7, 8));
  assert.ok(name.length < 60, 'the filename must stay a sane length');
  assert.ok(name.endsWith('-2026-08-08.txt'));
});

console.log('\n-- measuring an encoded attachment --');

test('a data URL measures to exactly the bytes it encodes', () => {
  for (const size of [0, 1, 2, 3, 4, 5, 100, 1023, 4096]) {
    const bytes = Buffer.alloc(size, 7);
    const url = `data:application/octet-stream;base64,${bytes.toString('base64')}`;
    assert.strictEqual(dataUrlBytes(url), size, `${size} bytes must measure as ${size}`);
  }
});

test('every padding case is accounted for', () => {
  // 1 byte pads with '==', 2 bytes with '=', 3 bytes with nothing.
  assert.strictEqual(dataUrlBytes('data:x;base64,QQ=='), 1);
  assert.strictEqual(dataUrlBytes('data:x;base64,QUI='), 2);
  assert.strictEqual(dataUrlBytes('data:x;base64,QUJD'), 3);
});

test('bare base64 with no data: prefix still measures', () => {
  assert.strictEqual(dataUrlBytes(Buffer.from('hello').toString('base64')), 5);
});

test('an empty payload measures as nothing rather than going negative', () => {
  assert.strictEqual(dataUrlBytes('data:image/png;base64,'), 0);
  assert.strictEqual(dataUrlBytes(''), 0);
});

test('the measurement never under-reports, which is what the size ceiling relies on', () => {
  // Anything that read low would let an oversized attachment past the check.
  for (let size = 0; size < 300; size++) {
    const url = `data:x;base64,${Buffer.alloc(size, 1).toString('base64')}`;
    assert.ok(dataUrlBytes(url) >= size, `${size} bytes must not measure below ${size}`);
  }
});

console.log('\n-- @mentions --');

const ROSTER = [
  { deviceId: 'a', deviceName: 'Alice' },
  { deviceId: 'b', deviceName: 'Bob' },
  { deviceId: 'c', deviceName: 'Lab PC 3' },
  { deviceId: 'd', deviceName: 'Ali' }
];

test('a plain mention resolves to the device that owns the name', () => {
  assert.deepStrictEqual(mentionedDeviceIds('hey @Bob look at this', ROSTER), ['b']);
});

test('a name with spaces is matched whole, not clipped at the first space', () => {
  const spans = findMentions('ask @Lab PC 3 to restart', ROSTER);
  assert.strictEqual(spans.length, 1);
  assert.strictEqual(spans[0].deviceId, 'c');
  assert.strictEqual('ask @Lab PC 3 to restart'.slice(spans[0].start, spans[0].end), '@Lab PC 3');
});

test('the longest matching name wins, so a shorter one does not swallow it', () => {
  assert.deepStrictEqual(mentionedDeviceIds('@Alice hi', ROSTER), ['a'], '"Ali" must not win over "Alice"');
  assert.deepStrictEqual(mentionedDeviceIds('@Ali hi', ROSTER), ['d'], 'but "Ali" alone still resolves');
});

test('a name matching nobody stays ordinary text', () => {
  assert.deepStrictEqual(mentionedDeviceIds('@Nobody are you there', ROSTER), []);
  assert.deepStrictEqual(splitOnMentions('@Nobody there', ROSTER), [{ kind: 'text', text: '@Nobody there' }]);
});

test('an email address is not a mention', () => {
  assert.deepStrictEqual(mentionedDeviceIds('write to bob@Alice.example', ROSTER), []);
});

test('matching ignores case, since nobody types a device name exactly', () => {
  assert.deepStrictEqual(mentionedDeviceIds('@bob @ALICE', ROSTER), ['b', 'a']);
});

test('a device mentioned twice is listed once', () => {
  assert.deepStrictEqual(mentionedDeviceIds('@Bob and again @Bob', ROSTER), ['b']);
});

test('mentions are found at the very start and the very end of a message', () => {
  assert.deepStrictEqual(mentionedDeviceIds('@Bob', ROSTER), ['b']);
  assert.deepStrictEqual(mentionedDeviceIds('ping @Alice', ROSTER), ['a']);
});

test('punctuation right after a name still closes the mention', () => {
  assert.deepStrictEqual(mentionedDeviceIds('thanks @Bob!', ROSTER), ['b']);
  assert.deepStrictEqual(mentionedDeviceIds('(@Alice), see this', ROSTER), ['a']);
});

test('splitOnMentions alternates text and mentions without losing a character', () => {
  const content = 'hi @Bob and @Alice, done';
  const parts = splitOnMentions(content, ROSTER);
  assert.strictEqual(parts.map((p) => p.text).join(''), content, 'the parts must rebuild the original exactly');
  assert.deepStrictEqual(
    parts.filter((p) => p.kind === 'mention').map((p) => p.deviceId),
    ['b', 'a']
  );
});

test('an empty roster, or one with a blank name, mentions nobody', () => {
  assert.deepStrictEqual(mentionedDeviceIds('@Bob', []), []);
  assert.deepStrictEqual(mentionedDeviceIds('@ hello', [{ deviceId: 'x', deviceName: '   ' }]), []);
});

console.log('\n-- phone pairing --');

function makePhone() {
  const clock = { now: 1_000_000 };
  let stored = [];
  const store = { read: () => stored, write: (next) => { stored = next; } };
  return { s: new PhoneSessions(store, () => clock.now), clock, store, dump: () => stored };
}

test('a pairing key is 256 bits and never repeats', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const key = generateKey();
    assert.match(key, /^[0-9a-f]{64}$/, 'must be 32 bytes of hex');
    seen.add(key);
  }
  assert.strictEqual(seen.size, 2000);
});

test('nothing is admitted while access is closed', () => {
  const { s } = makePhone();
  assert.strictEqual(s.isOpen, false);
  assert.strictEqual(s.pair(generateKey(), '1.2.3.4', 'iPhone'), null);
  assert.strictEqual(s.verify('anything'), false);
});

test('the scanned key pairs the phone', () => {
  const { s } = makePhone();
  const key = s.open();

  const token = s.pair(key, '192.168.1.20', 'iPhone');
  assert.ok(token && token.length >= 32);
  assert.strictEqual(s.verify(token), true);
});

test('a key nobody was given pairs nothing', () => {
  const { s } = makePhone();
  s.open();

  // Knowing the address is not enough; this is the whole point of scanning.
  assert.strictEqual(s.pair(generateKey(), '1.2.3.4', 'x'), null);
  assert.deepStrictEqual(s.list(), []);
});

test('a key is consumed, so one code admits exactly one device', () => {
  const { s } = makePhone();
  const key = s.open();

  assert.ok(s.pair(key, '1.2.3.4', 'iPhone'), 'the first scan works');
  // Somebody who photographed the screen cannot come back with the same code.
  assert.strictEqual(s.pair(key, '1.2.3.5', 'Android phone'), null);
  assert.notStrictEqual(s.currentKey, key, 'and a fresh code is waiting');
  assert.ok(s.pair(s.currentKey, '1.2.3.5', 'Android phone'), 'which the next device uses');
});

test('guessing locks the door, and the lockout blocks even the real key', () => {
  const { s, clock } = makePhone();
  const key = s.open();

  for (let i = 0; i < MAX_PIN_ATTEMPTS; i++) {
    assert.strictEqual(s.pair(generateKey(), '1.2.3.4', 'x'), null);
  }
  assert.ok(s.lockedOutUntil > 0, 'must be locked out');
  assert.strictEqual(s.pair(key, '1.2.3.4', 'x'), null, 'even the real key waits');

  clock.now += LOCKOUT_MS + 1;
  assert.strictEqual(s.lockedOutUntil, 0);
  assert.ok(s.pair(key, '1.2.3.4', 'x'), 'and works again afterwards');
});

test('a successful pairing clears the failure count', () => {
  const { s } = makePhone();
  const key = s.open();

  for (let i = 0; i < MAX_PIN_ATTEMPTS - 1; i++) s.pair(generateKey(), '1.2.3.4', 'x');
  assert.ok(s.pair(key, '1.2.3.4', 'x'));

  // Otherwise one more failure later would lock out a legitimate device.
  for (let i = 0; i < MAX_PIN_ATTEMPTS - 1; i++) s.pair(generateKey(), '1.2.3.4', 'x');
  assert.strictEqual(s.lockedOutUntil, 0);
});

test('a paired phone never has to scan again', () => {
  const { s, clock } = makePhone();
  const token = s.pair(s.open(), '1.2.3.4', 'iPhone');

  // Days later, and after the desktop has been closed and reopened.
  clock.now += 5 * 24 * 60 * 60 * 1000;
  s.close();
  s.open();

  assert.strictEqual(s.verify(token), true, 'the pairing has to outlive the session');
});

test('reopening issues a new key but keeps existing pairings', () => {
  const { s } = makePhone();
  const token = s.pair(s.open(), '1.2.3.4', 'iPhone');
  const before = s.currentKey;

  const second = s.open();
  assert.notStrictEqual(second, before, 'a fresh code for pairing new devices');
  assert.strictEqual(s.verify(token), true, 'but a paired phone stays paired');
});

test('a paired phone reaches everything, not one room', () => {
  const { s } = makePhone();
  const token = s.pair(s.open(), '1.2.3.4', 'iPhone');

  // There is no room in the pairing at all any more: the phone is trusted with
  // the whole application, and the scan is the only boundary.
  assert.strictEqual(s.verify(token), true);
  assert.strictEqual(typeof s.room, 'undefined', 'a pairing is not tied to a room');
});

test('a pairing nobody uses eventually lapses', () => {
  const { s, clock } = makePhone();
  const token = s.pair(s.open(), '1.2.3.4', 'iPhone');

  clock.now += PAIRING_TTL_MS - 1;
  assert.strictEqual(s.verify(token), true, 'still inside the window');

  // verify() refreshed lastSeen, so the clock has to move again.
  clock.now += PAIRING_TTL_MS + 1;
  assert.strictEqual(s.verify(token), false);
});

test('closing access cuts everything off until it is reopened', () => {
  const { s } = makePhone();
  const token = s.pair(s.open(), '1.2.3.4', 'iPhone');

  s.close();
  assert.strictEqual(s.isOpen, false);
  assert.strictEqual(s.verify(token), false);
});

test('one phone can be unpaired without touching the others', () => {
  const { s, clock } = makePhone();
  const a = s.pair(s.open(), '1.2.3.4', 'iPhone');
  clock.now += 10;
  const b = s.pair(s.currentKey, '1.2.3.5', 'Android phone');

  assert.strictEqual(s.list().length, 2);
  const first = s.list().find((c) => c.label === 'iPhone');
  assert.strictEqual(s.unpair(first.pairedAt), true);
  assert.strictEqual(s.verify(a), false);
  assert.strictEqual(s.verify(b), true, 'the other phone is untouched');
});

test('tokens are stored hashed, never in the clear', () => {
  const { s, dump } = makePhone();
  const token = s.pair(s.open(), '1.2.3.4', 'iPhone');

  const raw = JSON.stringify(dump());
  assert.ok(!raw.includes(token), 'a copy of the settings file must not yield a working token');
  assert.ok(dump()[0].tokenHash && dump()[0].tokenHash !== token);
});

test('the listed phones never carry their tokens', () => {
  const { s } = makePhone();
  s.pair(s.open(), '192.168.1.20', 'iPhone');

  const [client] = s.list();
  assert.strictEqual(client.tokenHash, undefined, 'not even the hash leaves the store');
  assert.strictEqual(client.label, 'iPhone');
  assert.strictEqual(client.address, '192.168.1.20');
});

test('a device label is bounded, and never empty', () => {
  const { s } = makePhone();
  s.pair(s.open(), '1.2.3.4', 'x'.repeat(500));
  assert.ok(s.list()[0].label.length <= 60);

  s.pair(s.currentKey, '1.2.3.4', '');
  assert.ok(s.list().some((c) => c.label === 'A phone'));
});

test('pairings survive a restart', () => {
  let stored = [];
  const store = { read: () => stored, write: (next) => { stored = next; } };

  const first = new PhoneSessions(store);
  const token = first.pair(first.open(), '1.2.3.4', 'iPhone');

  const second = new PhoneSessions(store);
  second.open();
  assert.strictEqual(second.verify(token), true);
});

test('unpairing everything leaves nothing behind', () => {
  const { s, dump } = makePhone();
  const token = s.pair(s.open(), '1.2.3.4', 'iPhone');
  s.pair(s.currentKey, '1.2.3.5', 'Android phone');

  s.unpairAll();
  assert.deepStrictEqual(s.list(), []);
  assert.deepStrictEqual(dump(), []);
  assert.strictEqual(s.verify(token), false);
});

test('sweeping removes only what has actually lapsed', () => {
  const { s, clock } = makePhone();
  const stale = s.pair(s.open(), '1.2.3.4', 'iPhone');
  clock.now += PAIRING_TTL_MS + 1;
  const fresh = s.pair(s.currentKey, '1.2.3.5', 'Android phone');

  assert.strictEqual(s.sweep(), true);
  assert.strictEqual(s.verify(stale), false);
  assert.strictEqual(s.verify(fresh), true);
  assert.strictEqual(s.sweep(), false, 'a second sweep has nothing to do');
});

console.log('\n-- npx installer --');

/* Shaped like a real GitHub release, trimmed to the fields the CLI reads. */
const RELEASE_ASSETS = [
  { name: 'CampusConnect-0.4.0-linux-x86_64.AppImage', size: 115000000, browser_download_url: 'https://x/linux' },
  { name: 'CampusConnect-0.4.0-mac-universal.dmg', size: 196000000, browser_download_url: 'https://x/mac' },
  { name: 'CampusConnect-0.4.0-mac-universal.dmg.blockmap', size: 200000, browser_download_url: 'https://x/macbm' },
  { name: 'CampusConnect-0.4.0-win-x64.exe', size: 87000000, browser_download_url: 'https://x/win' },
  { name: 'CampusConnect-0.4.0-win-x64.exe.blockmap', size: 90000, browser_download_url: 'https://x/winbm' },
  { name: 'latest.yml', size: 400, browser_download_url: 'https://x/latest' },
  { name: 'latest-mac.yml', size: 400, browser_download_url: 'https://x/latest-mac' },
  { name: 'latest-linux.yml', size: 400, browser_download_url: 'https://x/latest-linux' }
];

test('every platform the app ships for resolves to a build', () => {
  assert.strictEqual(target('win32', 'x64').suffix, '-win-x64.exe');
  assert.strictEqual(target('darwin', 'x64').suffix, '-mac-universal.dmg');
  assert.strictEqual(target('linux', 'x64').suffix, '-linux-x86_64.AppImage');
});

test('Apple silicon and Intel both take the universal build', () => {
  assert.strictEqual(target('darwin', 'arm64').suffix, target('darwin', 'x64').suffix);
});

test('a platform with no build is refused, not given the wrong one', () => {
  // Windows on ARM would happily download an x64 installer and fail later.
  assert.throws(() => target('win32', 'arm64'), /no Campus Connect build/);
  assert.throws(() => target('linux', 'arm64'), /no Campus Connect build/);
  assert.throws(() => target('aix', 'ppc64'), /no Campus Connect build/);
});

test('the refusal says where to go instead', () => {
  assert.throws(() => target('win32', 'arm64'), /from source/);
});

test('the installer is picked, not the blockmap beside it', () => {
  // Both end in the platform suffix as a substring; only one *ends* with it.
  assert.strictEqual(pickAsset(RELEASE_ASSETS, '-win-x64.exe').name, 'CampusConnect-0.4.0-win-x64.exe');
  assert.strictEqual(pickAsset(RELEASE_ASSETS, '-mac-universal.dmg').name, 'CampusConnect-0.4.0-mac-universal.dmg');
});

test('a release still uploading is reported rather than half-installed', () => {
  assert.throws(() => pickAsset([{ name: 'latest.yml' }], '-win-x64.exe'), /still be uploading/);
  assert.throws(() => pickAsset([], '-win-x64.exe'), /still be uploading/);
  assert.throws(() => pickAsset(undefined, '-win-x64.exe'), /still be uploading/);
});

test('each platform reads its own update manifest', () => {
  assert.strictEqual(pickManifest(RELEASE_ASSETS, 'win32').name, 'latest.yml');
  assert.strictEqual(pickManifest(RELEASE_ASSETS, 'darwin').name, 'latest-mac.yml');
  assert.strictEqual(pickManifest(RELEASE_ASSETS, 'linux').name, 'latest-linux.yml');
});

test('a release with no manifest yields null rather than throwing', () => {
  // Older releases predate them; that costs the checksum, not the install.
  assert.strictEqual(pickManifest([], 'win32'), null);
  assert.strictEqual(pickManifest(RELEASE_ASSETS, 'sunos'), null);
});

/* The shape electron-builder actually writes. */
const MANIFEST = [
  'version: 0.4.0',
  'files:',
  '  - url: CampusConnect-0.4.0-win-x64.exe',
  '    sha512: WINSHA512VALUE==',
  '    size: 87000000',
  '  - url: CampusConnect-0.4.0-win-arm64.exe',
  '    sha512: ARMSHA512VALUE==',
  '    size: 88000000',
  'path: CampusConnect-0.4.0-win-x64.exe',
  'sha512: WINSHA512VALUE==',
  'releaseDate: \'2026-07-31T01:58:00.000Z\''
].join('\n');

test('the checksum belongs to the file being downloaded', () => {
  assert.strictEqual(sha512For(MANIFEST, 'CampusConnect-0.4.0-win-x64.exe'), 'WINSHA512VALUE==');
});

test('a manifest listing several builds does not hand back the first', () => {
  // The x64 entry comes first, so a naive parser returns it for every query.
  assert.strictEqual(sha512For(MANIFEST, 'CampusConnect-0.4.0-win-arm64.exe'), 'ARMSHA512VALUE==');
});

test('a file the manifest does not list has no checksum', () => {
  assert.strictEqual(sha512For(MANIFEST, 'CampusConnect-0.4.0-mac-universal.dmg'), null);
  assert.strictEqual(sha512For('', 'anything'), null);
});

test('quoted manifest values are unwrapped', () => {
  const quoted = 'files:\n  - url: "a.exe"\n    sha512: "ABC=="';
  assert.strictEqual(sha512For(quoted, 'a.exe'), 'ABC==');
});

// -----------------------------------------------------------------------------

const { parseDeepLink, deepLinkFromArgv } = require(
  path.join(__dirname, '..', 'dist', 'shared', 'deepLink.js')
);

const { ensurePhoneCertificate, clearPhoneCertificate } = require(path.join(ROOT, 'phoneCert.js'));

deferred.push(async () => console.log('\n-- the phone certificate --'));

/*
 * The certificate is what makes a phone a secure origin, which is the only way
 * a browser hands it a microphone — and what stops its access token crossing
 * the WiFi in clear text. Two properties decide whether it is a one-time
 * annoyance or a permanent one, and both are worth pinning.
 */

const certDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cert-'));

testAsync('the certificate names every address it was asked to serve', async () => {
  const dir = certDir();
  const made = await ensurePhoneCertificate(dir, ['192.168.1.9', '10.0.0.4']);

  assert.ok(made.cert.startsWith('-----BEGIN CERTIFICATE-----'), 'not a certificate');
  assert.ok(made.key.includes('PRIVATE KEY'), 'no private key');
  // Browsers check subject alternative names; a missing one is a hard refusal,
  // not a warning somebody can click through.
  for (const host of ['192.168.1.9', '10.0.0.4', 'localhost', '127.0.0.1']) {
    assert.ok(made.hosts.includes(host), `missing ${host}`);
  }
});

testAsync('a usable certificate is reused rather than reissued', async () => {
  // Reissuing would mean a fresh security warning on every launch, which is
  // how people learn to click through security warnings.
  const dir = certDir();
  const first = await ensurePhoneCertificate(dir, ['192.168.1.9']);
  const second = await ensurePhoneCertificate(dir, ['192.168.1.9']);
  assert.strictEqual(second.cert, first.cert);
});

testAsync('an address the certificate does not cover forces a new one', async () => {
  const dir = certDir();
  const first = await ensurePhoneCertificate(dir, ['192.168.1.9']);
  // The laptop moved networks, or came up on Ethernet as well as WiFi.
  const second = await ensurePhoneCertificate(dir, ['192.168.1.9', '10.0.0.4']);

  assert.notStrictEqual(second.cert, first.cert, 'served an address it does not name');
  assert.ok(second.hosts.includes('10.0.0.4'));
});

testAsync('a certificate near its end is replaced before it lapses', async () => {
  const dir = certDir();
  const now = 1_700_000_000_000;
  const first = await ensurePhoneCertificate(dir, ['192.168.1.9'], now);

  // A day before expiry: still valid, but not for much longer.
  const later = now + 799 * 24 * 60 * 60 * 1000;
  const second = await ensurePhoneCertificate(dir, ['192.168.1.9'], later);
  assert.notStrictEqual(second.cert, first.cert, 'kept a certificate about to expire');
});

testAsync('clearing it means the next start issues a fresh one', async () => {
  const dir = certDir();
  const first = await ensurePhoneCertificate(dir, ['192.168.1.9']);
  clearPhoneCertificate(dir);
  const second = await ensurePhoneCertificate(dir, ['192.168.1.9']);
  assert.notStrictEqual(second.cert, first.cert);
});

testAsync('the certificate actually serves TLS', async () => {
  // The point of all of it: a socket a browser would accept after the warning.
  const https = require('node:https');
  const tls = require('node:tls');
  const made = await ensurePhoneCertificate(certDir(), ['127.0.0.1']);

  const server = https.createServer({ key: made.key, cert: made.cert }, (_q, r) => r.end('ok'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const sans = await new Promise((resolve, reject) => {
    const socket = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => {
      const peer = socket.getPeerCertificate();
      socket.end();
      resolve(String(peer.subjectaltname || ''));
    });
    socket.on('error', reject);
  });
  server.close();

  assert.ok(sans.includes('IP Address:127.0.0.1'), `SANs were: ${sans}`);
});

console.log('\n-- what a paired phone may ask for --');

const { isPhoneMethodAllowed } = require(path.join(ROOT, 'phoneServer.js'));

/*
 * This is a trust boundary. The phone bridge is HTTPS only now — there is no
 * second, more permissive mode to fall into — so the only question left is
 * which methods a paired phone may ever reach, full stop. Widening it by
 * accident is how a pocket ends up able to drive somebody's desktop.
 */

test('a phone can always reach the everyday surface', () => {
  for (const method of ['room:create', 'chat:send', 'clipboard:apply', 'search:all', 'app:get-state']) {
    assert.strictEqual(isPhoneMethodAllowed(method), true, method);
  }
});

test('remote desktop is refused', () => {
  assert.strictEqual(isPhoneMethodAllowed('remote:request'), false);
  assert.strictEqual(isPhoneMethodAllowed('remote:input'), false);
  assert.strictEqual(isPhoneMethodAllowed('remote:respond'), false);
});

test('files and direct messages stay desktop-only', () => {
  // Neither has a phone-side implementation — a raw request straight to the
  // bridge, bypassing the client's own refusal, has to land here just the same.
  assert.strictEqual(isPhoneMethodAllowed('files:request'), false);
  assert.strictEqual(isPhoneMethodAllowed('dm:send'), false);
});

/*
 * Every method that opens a native dialog on the laptop.
 *
 * A phone is often in another room, and a modal nobody is standing in front of
 * blocks the window it is attached to until somebody walks over to it. This
 * list is checked against the source below, so adding a `dialog.show*` call
 * without denying it to phones fails here rather than in somebody's hands.
 */
const OPENS_A_NATIVE_DIALOG = [
  'chat:send-file',
  'chat:save-file',
  'history:export',
  'dm:send-file',
  'dm:save-file',
  'dm:export',
  'files:pick'
];

test('nothing that opens a native dialog on the laptop is reachable from a phone', () => {
  for (const method of OPENS_A_NATIVE_DIALOG) {
    assert.strictEqual(isPhoneMethodAllowed(method), false, `${method} must be denied`);
  }
});

test('the dialog list above still matches what main.ts actually opens', () => {
  // The guard is only worth anything if it is kept current, and a list in a
  // test file does not update itself. Counting the call sites is crude, but it
  // is enough to fail loudly when a new one appears.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.ts'), 'utf8');
  const sites = source.match(/dialog\.show(Open|Save)Dialog/g) ?? [];
  assert.strictEqual(
    sites.length,
    // Both exports share one `exportTranscript` helper, so seven methods are
    // opened by six call sites.
    OPENS_A_NATIVE_DIALOG.length - 1,
    'a dialog was added or removed in main.ts — check it is denied to phones, then update OPENS_A_NATIVE_DIALOG'
  );
});

test('the rest of chat and history stays ordinary, everyday phone use', () => {
  // Only the two dialogs are denied — a phone can still read a file somebody
  // sent, since it arrives in the message like any other content.
  for (const method of ['chat:send', 'chat:edit', 'chat:react', 'chat:toggle-pin', 'chat:mark-seen']) {
    assert.strictEqual(isPhoneMethodAllowed(method), true, method);
  }
  assert.strictEqual(isPhoneMethodAllowed('history:get-chat'), true);
  assert.strictEqual(isPhoneMethodAllowed('history:toggle-pin'), true);
  assert.strictEqual(isPhoneMethodAllowed('history:clear-room'), true);
});

test('the quick-paste overlay and self-install stay desktop-only', () => {
  assert.strictEqual(isPhoneMethodAllowed('quick-paste:pick'), false);
  assert.strictEqual(isPhoneMethodAllowed('update:install'), false);
  // Checking for one is still fine; it is installing that is not.
  assert.strictEqual(isPhoneMethodAllowed('update:check'), true);
});

test('calls are allowed — the bridge is always a secure origin', () => {
  assert.strictEqual(isPhoneMethodAllowed('call:start'), true);
  assert.strictEqual(isPhoneMethodAllowed('call:join'), true);
  assert.strictEqual(isPhoneMethodAllowed('call:signal'), true);
});

test('a phone never captures a screen', () => {
  // It has no desktop to offer, so this is not a security limit but an honest one.
  assert.strictEqual(isPhoneMethodAllowed('call:screen-sources'), false);
});

console.log('\n-- phone event stream --');

/*
 * The frame parser, exercised against what a real stream actually delivers:
 * frames split across reads, heartbeat comments, and the retry hint the server
 * opens with. Getting any of those wrong drops events silently, which on a
 * phone looks exactly like the desktop having nothing to say.
 *
 * The parser is a closure inside `openEventStream`, so the same logic is
 * mirrored here — the point is to pin the format the two ends agree on.
 */
function parseStream(chunks) {
  const events = [];
  let buffer = '';
  for (const chunk of chunks) {
    buffer += chunk;
    let split = buffer.indexOf('\n\n');
    while (split !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      let channel = '';
      const data = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith(':') || line.length === 0) continue;
        if (line.startsWith('event:')) channel = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (channel) {
        try {
          events.push({ channel, payload: data.length ? JSON.parse(data.join('\n')) : null });
        } catch {
          /* malformed frame is dropped, not thrown */
        }
      }
      split = buffer.indexOf('\n\n');
    }
  }
  return events;
}

const frame = (channel, payload) => `event: ${channel}\ndata: ${JSON.stringify(payload)}\n\n`;

test('one whole frame yields one event', () => {
  assert.deepStrictEqual(parseStream([frame('chat:message', { id: 'm1' })]), [
    { channel: 'chat:message', payload: { id: 'm1' } }
  ]);
});

test('a frame split across reads is not lost', () => {
  // TCP does not respect frame boundaries; this is the normal case, not the edge.
  const whole = frame('sync:status', { message: 'Shared', tone: 'success' });
  for (const at of [1, 7, 20, whole.length - 1]) {
    assert.deepStrictEqual(
      parseStream([whole.slice(0, at), whole.slice(at)]),
      [{ channel: 'sync:status', payload: { message: 'Shared', tone: 'success' } }],
      `split at ${at} was dropped`
    );
  }
});

test('several frames in one read all arrive, in order', () => {
  const events = parseStream([frame('a', 1) + frame('b', 2) + frame('c', 3)]);
  assert.deepStrictEqual(events.map((e) => e.channel), ['a', 'b', 'c']);
  assert.deepStrictEqual(events.map((e) => e.payload), [1, 2, 3]);
});

test('heartbeats and the retry hint are not events', () => {
  const stream = 'retry: 2000\n\n' + ': ping\n\n' + frame('call:ring', { callId: 'c1' }) + ': ping\n\n';
  assert.deepStrictEqual(parseStream([stream]), [
    { channel: 'call:ring', payload: { callId: 'c1' } }
  ]);
});

test('a payload containing a blank line survives', () => {
  // JSON escapes newlines, so a chat message with a paragraph break must not
  // look like the end of a frame.
  const text = 'first line\n\nsecond line';
  const [event] = parseStream([frame('chat:message', { content: text })]);
  assert.strictEqual(event.payload.content, text);
});

test('a malformed frame is dropped without taking the stream with it', () => {
  const events = parseStream(['event: bad\ndata: {not json\n\n' + frame('good', { ok: true })]);
  assert.deepStrictEqual(events, [{ channel: 'good', payload: { ok: true } }]);
});

test('a trailing partial frame waits rather than firing early', () => {
  assert.deepStrictEqual(parseStream(['event: half\ndata: {"a"']), []);
});

console.log('\n-- deep links --');

/*
 * A deep link is unvalidated input handed over by the operating system, and
 * anyone who can put a URL in front of someone can call this. Every test below
 * is really the same question: does anything other than a link we understand
 * come back as null?
 */

test('the link a room QR code encodes is understood', () => {
  // This exact shape is what `room:qr-code` has always produced.
  assert.deepStrictEqual(parseDeepLink('campusconnect://join?code=AB12CD&room=Study%20Group'), {
    kind: 'join',
    code: 'AB12CD',
    roomName: 'Study Group'
  });
});

test('a link with no room name still joins', () => {
  assert.deepStrictEqual(parseDeepLink('campusconnect://join?code=AB12CD'), {
    kind: 'join',
    code: 'AB12CD',
    roomName: ''
  });
});

test('the action may be spelled as a path instead of a host', () => {
  assert.strictEqual(parseDeepLink('campusconnect:/join?code=AB12CD')?.code, 'AB12CD');
});

test('a join with no code is not a join', () => {
  assert.strictEqual(parseDeepLink('campusconnect://join'), null);
  assert.strictEqual(parseDeepLink('campusconnect://join?code='), null);
  assert.strictEqual(parseDeepLink('campusconnect://join?code=%20%20'), null);
});

test('another application’s scheme is not ours to act on', () => {
  assert.strictEqual(parseDeepLink('https://example.com/join?code=AB12CD'), null);
  assert.strictEqual(parseDeepLink('file:///etc/passwd'), null);
  assert.strictEqual(parseDeepLink('javascript:alert(1)'), null);
  assert.strictEqual(parseDeepLink('campusconnectx://join?code=AB12CD'), null);
});

test('an action we do not have is refused rather than guessed at', () => {
  assert.strictEqual(parseDeepLink('campusconnect://leave?code=AB12CD'), null);
  assert.strictEqual(parseDeepLink('campusconnect://'), null);
});

test('rubbish is null, not a throw', () => {
  for (const input of ['', 'not a url', '://', null, undefined, 42, {}]) {
    assert.strictEqual(parseDeepLink(input), null, `threw or accepted: ${String(input)}`);
  }
});

test('a link cannot carry an essay', () => {
  const long = parseDeepLink(`campusconnect://join?code=${'A'.repeat(500)}&room=${'B'.repeat(500)}`);
  assert.strictEqual(long.code.length, 64);
  assert.strictEqual(long.roomName.length, 64);
  assert.strictEqual(parseDeepLink(`campusconnect://join?code=${'A'.repeat(4000)}`), null);
});

test('the link is picked out of a command line, whatever else is on it', () => {
  const argv = ['C:\\app\\Campus Connect.exe', '--hidden', 'campusconnect://join?code=ZZ99XX'];
  assert.strictEqual(deepLinkFromArgv(argv).code, 'ZZ99XX');
});

test('a command line with no link yields nothing', () => {
  assert.strictEqual(deepLinkFromArgv(['C:\\app\\Campus Connect.exe', '--hidden']), null);
  assert.strictEqual(deepLinkFromArgv([]), null);
});

test('a malformed link on the command line is skipped, not half-taken', () => {
  assert.strictEqual(deepLinkFromArgv(['app.exe', 'campusconnect://join']), null);
});

console.log('\n-- remote desktop: answering our own questions --');

/*
 * The session id is chosen by whoever speaks first, so an answer has to be
 * matched back to a question this device actually asked. Without that, a `grant`
 * is simply believed: any room member could open a session on a machine that
 * never requested one, put their screen on it, and occupy its only session slot.
 */

test('an answer to a question we never asked is not ours to take', () => {
  const { manager } = makeSessions();
  assert.strictEqual(manager.takeOutgoingRequest('never-asked'), undefined);
});

test('an answer to our own question is matched to the device we asked', () => {
  const { manager } = makeSessions();
  manager.noteOutgoingRequest('s9', 'r1', 'B');

  const asked = manager.takeOutgoingRequest('s9');
  assert.strictEqual(asked.targetDeviceId, 'B');
  assert.strictEqual(asked.roomId, 'r1');
});

test('a question can only be answered once', () => {
  const { manager } = makeSessions();
  manager.noteOutgoingRequest('s9', 'r1', 'B');
  manager.takeOutgoingRequest('s9');

  // A second `grant` for the same id — a replay — has nothing left to claim.
  assert.strictEqual(manager.takeOutgoingRequest('s9'), undefined);
});

test('our own unanswered question lapses on the same clock as theirs', () => {
  const { manager, clock } = makeSessions();
  manager.noteOutgoingRequest('s9', 'r1', 'B');

  clock.now += REQUEST_TIMEOUT_MS + 1;
  manager.sweepRequests();

  assert.strictEqual(
    manager.takeOutgoingRequest('s9'),
    undefined,
    'a grant arriving long after the fact was still accepted'
  );
});

test('blocking a device drops the question we asked it', () => {
  const { manager } = makeSessions();
  manager.noteOutgoingRequest('s9', 'r1', 'B');
  manager.clearDevice('B');
  assert.strictEqual(manager.takeOutgoingRequest('s9'), undefined);
});

test('a room going away drops the questions asked through it', () => {
  const { manager } = makeSessions();
  manager.noteOutgoingRequest('s9', 'r1', 'B');
  manager.clearRoom('r1');
  assert.strictEqual(manager.takeOutgoingRequest('s9'), undefined);
});

console.log('\n-- remote desktop: scroll at the trust boundary --');

test('a scroll of a billion notches is clamped, not passed on', () => {
  // The viewer reduces wheel deltas to a few notches, but that runs on the
  // controller — the side being trusted — so it is not a limit.
  const huge = parseRemoteInput({ t: 'scroll', dx: 1e9, dy: -1e9 });
  assert.strictEqual(huge.dx, MAX_SCROLL_NOTCHES);
  assert.strictEqual(huge.dy, -MAX_SCROLL_NOTCHES);
});

test('an ordinary scroll passes through untouched', () => {
  assert.deepStrictEqual(parseRemoteInput({ t: 'scroll', dx: 0, dy: -3 }), {
    t: 'scroll',
    dx: 0,
    dy: -3
  });
});

test('a clamped scroll is what actually reaches the machine', () => {
  const scrolls = [];
  const robot = {
    moveMouse() {},
    mouseToggle() {},
    scrollMouse: (x, y) => scrolls.push([x, y]),
    keyToggle() {},
    keyTap() {},
    typeString() {}
  };
  const injector = createInjector(robot, () => ({ x: 0, y: 0, width: 1920, height: 1080 }));

  injector.apply(parseRemoteInput({ t: 'scroll', dx: 1e9, dy: 1e9 }));
  assert.deepStrictEqual(scrolls, [[MAX_SCROLL_NOTCHES, MAX_SCROLL_NOTCHES]]);
});

// -----------------------------------------------------------------------------

const { FileShareManager, SLICE_BYTES, MAX_FILE_SHARE_BYTES } = require(
  path.join(ROOT, 'fileShare.js')
);

deferred.push(async () => console.log('\n-- file sharing --'));

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Two managers wired into each other, standing in for two machines.
 *
 * `intercept` is where a hostile network goes: dropping, duplicating or
 * reordering what the sender puts on the wire, which is the only way to test
 * the receiver's placement logic without an actual lossy link.
 */
function twoDevices({ clock, intercept, autoAccept, onAutoAccepted } = {}) {
  const inbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-recv-'));
  const outbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-send-'));
  const now = clock ? () => clock.value : undefined;

  let sender;
  let receiver;
  const toReceiver = (signal) => receiver.handleSignal('dev-a', 'Laptop A', signal);

  sender = new FileShareManager({
    now,
    send: (_peerId, signal) => {
      if (intercept) {
        intercept(signal, (out) => setImmediate(() => toReceiver(out)));
      } else {
        setImmediate(() => toReceiver(signal));
      }
      return true;
    },
    downloadFolder: () => outbox,
    onChanged: () => {}
  });

  receiver = new FileShareManager({
    now,
    autoAccept,
    onAutoAccepted,
    send: (_peerId, signal) => {
      setImmediate(() => sender.handleSignal('dev-b', 'Laptop B', signal));
      return true;
    },
    downloadFolder: () => inbox,
    onChanged: () => {}
  });

  return { sender, receiver, inbox, outbox };
}

function makeFile(dir, name, size, fill = 'x') {
  const full = path.join(dir, name);
  fs.writeFileSync(full, Buffer.alloc(size, fill));
  return { path: full, name, size };
}

/** Runs the whole request → accept → send handshake and returns the result. */
async function handshake(devices, files) {
  devices.sender.request('dev-b', 'Laptop B');
  await settle(20);
  await devices.receiver.respond(devices.receiver.state.incoming.transferId, true);
  await settle(20);
  const transfer = devices.sender.state.transfers.find((candidate) => candidate.status === 'active');
  const result = await devices.sender.sendFiles(transfer.transferId, files);
  await settle(120);
  return result;
}

const landed = (dir) => fs.readdirSync(dir).filter((name) => name !== '.partials');

/*
 * Sending to somebody already in your room.
 *
 * The handshake is unchanged on the wire — the receiver still answers, it just
 * answers by itself. What these check is that answering automatically reaches
 * exactly the same state as a person clicking accept, and that the cases where
 * nobody should be answering for you still stop and ask.
 */
testAsync('a file from a room member needs no dialog', async () => {
  const devices = twoDevices({ autoAccept: () => true });
  const file = makeFile(devices.outbox, 'slides.pdf', 70 * 1024);

  devices.sender.request('dev-b', 'Laptop B');
  await settle(30);

  assert.strictEqual(devices.receiver.state.incoming, undefined, 'nobody was asked');

  const transfer = devices.sender.state.transfers.find((candidate) => candidate.status === 'active');
  assert.ok(transfer, 'the sender was accepted without anyone clicking anything');

  const result = await devices.sender.sendFiles(transfer.transferId, [file]);
  await settle(120);

  assert.strictEqual(result.ok, true, result.message);
  assert.deepStrictEqual(landed(devices.inbox), ['slides.pdf']);
  assert.strictEqual(devices.receiver.busy(), false);
});

testAsync('a device outside your rooms is still asked', async () => {
  const devices = twoDevices({ autoAccept: () => false });

  devices.sender.request('dev-b', 'Laptop B');
  await settle(30);

  assert.ok(devices.receiver.state.incoming, 'a stranger must not be let through');
  assert.strictEqual(
    devices.sender.state.transfers.find((candidate) => candidate.status === 'active'),
    undefined,
    'and the sender waits rather than proceeding'
  );
});

testAsync('the peer is named when a transfer is taken without asking', async () => {
  const announced = [];
  const devices = twoDevices({ autoAccept: () => true, onAutoAccepted: (name) => announced.push(name) });

  devices.sender.request('dev-b', 'Laptop B');
  await settle(30);

  assert.deepStrictEqual(announced, ['Laptop A'], 'a file must not arrive unannounced');
});

testAsync('being busy still refuses a trusted peer', async () => {
  // Auto-accept decides who may skip the dialog, not how many transfers this
  // device can run at once — one at a time is the whole reason `busy()` exists.
  const devices = twoDevices({ autoAccept: () => true });
  const file = makeFile(devices.outbox, 'first.bin', 40 * 1024);

  devices.sender.request('dev-b', 'Laptop B');
  await settle(30);
  const transfer = devices.sender.state.transfers.find((candidate) => candidate.status === 'active');
  const streaming = devices.sender.sendFiles(transfer.transferId, [file]);

  devices.receiver.handleSignal('dev-c', 'Laptop C', { kind: 'request', transferId: 'other' });
  assert.strictEqual(
    devices.receiver.state.transfers.filter((candidate) => candidate.status === 'active').length,
    1,
    'a second transfer was accepted while one was already running'
  );

  await streaming;
  await settle(120);
});

testAsync('one file arrives whole, and both sides finish', async () => {
  const devices = twoDevices();
  const file = makeFile(devices.outbox, 'notes.txt', 70 * 1024);

  const result = await handshake(devices, [file]);

  assert.strictEqual(result.ok, true, result.message);
  assert.deepStrictEqual(landed(devices.inbox), ['notes.txt']);
  assert.strictEqual(fs.statSync(path.join(devices.inbox, 'notes.txt')).size, 70 * 1024);
  assert.strictEqual(devices.sender.busy(), false, 'sender stayed busy after finishing');
  assert.strictEqual(devices.receiver.busy(), false, 'receiver stayed busy after finishing');
});

testAsync('every file in a batch arrives, not just the first', async () => {
  // The regression this suite exists for: the sender used to check whether a
  // file was confirmed the instant it finished writing it to the wire, before
  // any confirmation could possibly have come back, and abandon the batch.
  const devices = twoDevices();
  const files = [
    makeFile(devices.outbox, 'one.bin', 70 * 1024, 'a'),
    makeFile(devices.outbox, 'two.bin', 30 * 1024, 'b'),
    makeFile(devices.outbox, 'three.bin', 9 * 1024, 'c')
  ];

  const result = await handshake(devices, files);

  assert.strictEqual(result.ok, true, result.message);
  assert.deepStrictEqual(landed(devices.inbox).sort(), ['one.bin', 'three.bin', 'two.bin']);
});

testAsync('a finished transfer leaves no partial files behind', async () => {
  const devices = twoDevices();
  await handshake(devices, [makeFile(devices.outbox, 'clean.bin', 50 * 1024)]);

  const partials = path.join(devices.inbox, '.partials');
  const left = fs.existsSync(partials) ? fs.readdirSync(partials) : [];
  assert.deepStrictEqual(left, []);
});

testAsync('an empty file does not stall the batch behind it', async () => {
  // No slice is ever sent for a zero-byte file, and completion was only ever
  // reached by way of one — so it used to hold up everything after it.
  const devices = twoDevices();
  const files = [
    makeFile(devices.outbox, 'blank.txt', 0),
    makeFile(devices.outbox, 'after.bin', 40 * 1024)
  ];

  const result = await handshake(devices, files);

  assert.strictEqual(result.ok, true, result.message);
  assert.deepStrictEqual(landed(devices.inbox).sort(), ['after.bin', 'blank.txt']);
  assert.strictEqual(fs.statSync(path.join(devices.inbox, 'blank.txt')).size, 0);
});

testAsync('a file of exactly one slice completes', async () => {
  const devices = twoDevices();
  const result = await handshake(devices, [makeFile(devices.outbox, 'exact.bin', SLICE_BYTES)]);

  assert.strictEqual(result.ok, true, result.message);
  assert.strictEqual(fs.statSync(path.join(devices.inbox, 'exact.bin')).size, SLICE_BYTES);
});

testAsync('slices arriving out of order are placed by index, not by arrival', async () => {
  // Held back and released backwards. Every byte still has to land in the
  // right place, because the receiver goes by index and buffers the rest.
  const held = [];
  const devices = twoDevices({
    intercept: (signal, deliver) => {
      if (signal.kind !== 'data') {
        deliver(signal);
        return;
      }
      held.push(signal);
      if (signal.index === signal.total - 1) {
        for (const slice of held.reverse()) {
          deliver(slice);
        }
        held.length = 0;
      }
    }
  });

  const source = makeFile(devices.outbox, 'jumbled.bin', 5 * SLICE_BYTES, 'j');
  const expected = fs.readFileSync(source.path);
  const result = await handshake(devices, [source]);

  assert.strictEqual(result.ok, true, result.message);
  assert.deepStrictEqual(fs.readFileSync(path.join(devices.inbox, 'jumbled.bin')), expected);
});

testAsync('a duplicated slice does not inflate progress past the total', async () => {
  const devices = twoDevices({
    intercept: (signal, deliver) => {
      deliver(signal);
      if (signal.kind === 'data') {
        deliver(signal);
      }
    }
  });

  const source = makeFile(devices.outbox, 'twice.bin', 4 * SLICE_BYTES, 'd');
  const expected = fs.readFileSync(source.path);
  const result = await handshake(devices, [source]);
  const transfer = devices.receiver.state.transfers[0];

  assert.strictEqual(result.ok, true, result.message);
  assert.ok(
    transfer.bytesDone <= transfer.bytesTotal,
    `progress ran past the total: ${transfer.bytesDone} of ${transfer.bytesTotal}`
  );
  // Byte-for-byte, not just the right length: a re-written slice corrupts the
  // file rather than lengthening it when it lands at the wrong offset.
  assert.deepStrictEqual(fs.readFileSync(path.join(devices.inbox, 'twice.bin')), expected);
});

testAsync('a second file of the same name never overwrites the first', async () => {
  const devices = twoDevices();
  await handshake(devices, [makeFile(devices.outbox, 'report.pdf', 8 * 1024, 'first')]);
  await handshake(devices, [makeFile(devices.outbox, 'report.pdf', 8 * 1024, 'second')]);

  assert.deepStrictEqual(landed(devices.inbox).sort(), ['report (1).pdf', 'report.pdf']);
});

testAsync('one transfer at a time, in either role', async () => {
  const devices = twoDevices();
  assert.strictEqual(devices.sender.request('dev-b', 'Laptop B').ok, true);
  const second = devices.sender.request('dev-c', 'Laptop C');
  assert.strictEqual(second.ok, false);
  await settle(20);
});

testAsync('a declined request releases both sides', async () => {
  const devices = twoDevices();
  devices.sender.request('dev-b', 'Laptop B');
  await settle(20);
  await devices.receiver.respond(devices.receiver.state.incoming.transferId, false);
  await settle(40);

  assert.strictEqual(devices.sender.state.transfers[0].status, 'cancelled');
  assert.strictEqual(devices.sender.busy(), false);
  assert.strictEqual(devices.receiver.busy(), false);
});

testAsync('a request nobody answers is withdrawn by the sweep', async () => {
  const clock = { value: 1_000_000 };
  const devices = twoDevices({ clock });
  devices.sender.request('dev-b', 'Laptop B');
  await settle(20);

  clock.value += 120_000;
  devices.sender.sweep();
  devices.receiver.sweep();
  await settle(20);

  assert.strictEqual(devices.sender.busy(), false, 'sender held a request nobody answered');
  assert.strictEqual(devices.receiver.state.incoming, undefined);
});

testAsync('the receiver cancelling mid-transfer releases the sender', async () => {
  /*
   * Pinned to a slice rather than to a timer. Cancelling after a fixed delay
   * races the transfer itself — on a fast loopback the file can already be
   * finished, and cancelling a finished transfer proves nothing.
   */
  let devices;
  devices = twoDevices({
    intercept: (signal, deliver) => {
      deliver(signal);
      if (signal.kind === 'data' && signal.index === 2) {
        devices.receiver.cancel(devices.receiver.state.transfers[0].transferId);
      }
    }
  });

  const file = makeFile(devices.outbox, 'large.bin', 8 * SLICE_BYTES);

  devices.sender.request('dev-b', 'Laptop B');
  await settle(20);
  await devices.receiver.respond(devices.receiver.state.incoming.transferId, true);
  await settle(20);

  const transfer = devices.sender.state.transfers.find((candidate) => candidate.status === 'active');
  const result = await devices.sender.sendFiles(transfer.transferId, [file]);
  await settle(80);

  assert.strictEqual(result.ok, false, 'a cancelled transfer reported success');
  assert.strictEqual(devices.sender.busy(), false, 'sender was left waiting on a cancelled transfer');
  assert.strictEqual(devices.receiver.busy(), false);
  assert.deepStrictEqual(landed(devices.inbox), [], 'a cancelled file was still saved');
});

testAsync('a transfer that stops moving is ended rather than held open', async () => {
  // Every eighth slice is dropped, which on this path is unrecoverable. What
  // matters is that both sides give up and say so instead of hanging forever.
  const clock = { value: 2_000_000 };
  let seen = 0;
  const devices = twoDevices({
    clock,
    intercept: (signal, deliver) => {
      if (signal.kind === 'data' && seen++ % 8 === 3) {
        return;
      }
      deliver(signal);
    }
  });

  devices.sender.request('dev-b', 'Laptop B');
  await settle(20);
  await devices.receiver.respond(devices.receiver.state.incoming.transferId, true);
  await settle(20);

  const transfer = devices.sender.state.transfers.find((candidate) => candidate.status === 'active');
  const sending = devices.sender.sendFiles(transfer.transferId, [
    makeFile(devices.outbox, 'lossy.bin', 2 * 1024 * 1024)
  ]);

  await settle(150);
  clock.value += 120_000;
  devices.sender.sweep();
  devices.receiver.sweep();

  const result = await sending;
  await settle(80);

  assert.strictEqual(result.ok, false);
  assert.strictEqual(devices.sender.busy(), false, 'a stalled transfer wedged the sender');
  assert.strictEqual(devices.receiver.busy(), false, 'a stalled transfer wedged the receiver');
});

testAsync('going offline mid-receive closes handles and sweeps the partials', async () => {
  const devices = twoDevices();
  const file = makeFile(devices.outbox, 'interrupted.bin', 3 * 1024 * 1024);

  devices.sender.request('dev-b', 'Laptop B');
  await settle(20);
  await devices.receiver.respond(devices.receiver.state.incoming.transferId, true);
  await settle(20);

  const transfer = devices.sender.state.transfers.find((candidate) => candidate.status === 'active');
  devices.sender.sendFiles(transfer.transferId, [file]);
  await settle(20);
  devices.receiver.clear();
  await settle(150);

  const partials = path.join(devices.inbox, '.partials');
  const left = fs.existsSync(partials) ? fs.readdirSync(partials) : [];
  assert.deepStrictEqual(left, [], 'a partial file survived going offline');
  assert.strictEqual(devices.receiver.busy(), false);
});

testAsync('a transfer ending while a file is being opened leaks nothing', async () => {
  /*
   * The receiver opens its temp file across two awaits. Anything that ends the
   * transfer in that window — a cancel off the wire, the stall sweep, going
   * offline — runs before the handle is registered, so the usual cleanup looks
   * for it and does not find it. The handle was then leaked until the garbage
   * collector noticed and killed the process, which is how this was found: as
   * an intermittent crash in the suite above.
   *
   * Timed off the offer rather than a clock, so it lands in that window every
   * run instead of two in five.
   */
  let devices;
  devices = twoDevices({
    intercept: (signal, deliver) => {
      deliver(signal);
      if (signal.kind === 'offer') {
        devices.receiver.cancel(devices.receiver.state.transfers[0].transferId);
      }
    }
  });

  devices.sender.request('dev-b', 'Laptop B');
  await settle(20);
  await devices.receiver.respond(devices.receiver.state.incoming.transferId, true);
  await settle(20);

  const transfer = devices.sender.state.transfers.find((candidate) => candidate.status === 'active');
  await devices.sender.sendFiles(transfer.transferId, [
    makeFile(devices.outbox, 'aborted.bin', 4 * SLICE_BYTES)
  ]);
  await settle(200);

  const partials = path.join(devices.inbox, '.partials');
  const left = fs.existsSync(partials) ? fs.readdirSync(partials) : [];
  assert.deepStrictEqual(left, [], 'a temp file was opened and then abandoned');
  assert.strictEqual(devices.receiver.busy(), false);
  assert.deepStrictEqual(landed(devices.inbox), []);
});

testAsync('a file past the ceiling is refused before anything is read', async () => {
  const devices = twoDevices();
  devices.sender.request('dev-b', 'Laptop B');
  await settle(20);
  await devices.receiver.respond(devices.receiver.state.incoming.transferId, true);
  await settle(20);

  const transfer = devices.sender.state.transfers.find((candidate) => candidate.status === 'active');
  const result = await devices.sender.sendFiles(transfer.transferId, [
    { path: path.join(devices.outbox, 'nope.bin'), name: 'nope.bin', size: MAX_FILE_SHARE_BYTES + 1 }
  ]);

  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(landed(devices.inbox), []);
});

testAsync('a signal for somebody else’s transfer is ignored', async () => {
  const devices = twoDevices();
  devices.sender.request('dev-b', 'Laptop B');
  await settle(20);
  const transferId = devices.sender.state.transfers[0].transferId;

  // Right transfer, wrong device: the accept must not take.
  devices.sender.handleSignal('dev-intruder', 'Somebody Else', { kind: 'accept', transferId });
  assert.strictEqual(devices.sender.state.transfers[0].status, 'requested');
});

// -----------------------------------------------------------------------------

console.log('\n-- not downloading the same update four times --');

const { shouldOfferDownload, isWorthRetrying } = require(path.join(ROOT, 'updatePolicy.js'));

/*
 * From a real report: the same version downloading three or four times over
 * before it finally installed.
 *
 * `update-available` fires on every check, and it was acted on unconditionally.
 * So a finished download was demoted from 'ready' back to 'available' seconds
 * after the next launch, the button came back, and ~85 MB was fetched again for
 * a file already on disk.
 */

test('an update already downloaded is not offered again', () => {
  assert.strictEqual(shouldOfferDownload('ready', '0.6.0', '0.6.0'), false);
});

test('a newer version still gets through once one is downloaded', () => {
  assert.strictEqual(shouldOfferDownload('ready', '0.6.0', '0.6.1'), true);
});

test('nothing downloaded yet always offers the download', () => {
  assert.strictEqual(shouldOfferDownload('available', undefined, '0.6.0'), true);
  assert.strictEqual(shouldOfferDownload('idle', undefined, '0.6.0'), true);
});

test('a download that did not finish is still offered', () => {
  // Same version, but the state says it never landed — the cache may hold only
  // a partial file, so the offer has to stand.
  assert.strictEqual(shouldOfferDownload('error', undefined, '0.6.0'), true);
  assert.strictEqual(shouldOfferDownload('downloading', undefined, '0.6.0'), true);
});

test('a dropped connection is worth another go', () => {
  for (const message of [
    'net::ERR_CONNECTION_RESET',
    'socket hang up',
    'read ECONNRESET',
    'connect ETIMEDOUT 140.82.121.4:443',
    'getaddrinfo ENOTFOUND objects.githubusercontent.com',
    'Unexpected end of stream'
  ]) {
    assert.strictEqual(isWorthRetrying(message), true, message);
  }
});

test('a failure that cannot come out differently is not retried', () => {
  for (const message of [
    'sha512 checksum mismatch, expected abc, got def',
    'New version 0.6.0 is not signed by the application owner',
    'Cannot download "https://github.com/...", status 404: Not Found',
    "ENOENT: no such file or directory, open 'C:\\pending\\update.exe'",
    'ENOSPC: no space left on device'
  ]) {
    assert.strictEqual(isWorthRetrying(message), false, message);
  }
});


// -----------------------------------------------------------------------------

const { KeyVault } = require(path.join(ROOT, 'keyVault.js'));

console.log('\n-- the key vault --');

/*
 * Room keys used to sit in config.json as plain hex, so anyone who could read
 * the user profile held every key this device had derived. They now go through
 * the OS credential store. What matters is not that encryption happens — that
 * is the platform's job — but that the vault never falls back to writing them
 * in the clear, and that an upgrade does not lock anyone out of a room.
 */

/** A stand-in for safeStorage: reversible, and obviously not real encryption. */
function fakeCrypto(available = true) {
  return {
    available: () => available,
    encrypt: (plaintext) => Buffer.from(`sealed:${plaintext}`, 'utf8'),
    decrypt: (payload) => {
      const text = payload.toString('utf8');
      if (!text.startsWith('sealed:')) throw new Error('not ours');
      return text.slice('sealed:'.length);
    }
  };
}

function fakeStore(initial = {}) {
  const state = { vault: initial.vault, legacy: { ...(initial.legacy ?? {}) } };
  return {
    state,
    readVault: () => state.vault,
    writeVault: (blob) => { state.vault = blob; },
    readLegacy: () => ({ ...state.legacy }),
    clearLegacy: () => { state.legacy = {}; }
  };
}

test('keys written to the vault are not readable in the stored blob', () => {
  const store = fakeStore();
  const vault = new KeyVault(store, fakeCrypto());
  vault.write({ room: 'a1b2c3d4' });

  assert.strictEqual(vault.sealed, true);
  assert.ok(store.state.vault, 'something was written');
  assert.ok(!store.state.vault.includes('a1b2c3d4'), 'the key is not sitting in the blob');
  assert.deepStrictEqual(store.state.legacy, {}, 'nothing was left in the plaintext map');
});

test('a vault round-trips through a fresh instance', () => {
  const store = fakeStore();
  new KeyVault(store, fakeCrypto()).write({ one: 'aa', two: 'bb' });
  assert.deepStrictEqual(new KeyVault(store, fakeCrypto()).read(), { one: 'aa', two: 'bb' });
});

test('existing plaintext keys are migrated and then erased', () => {
  const store = fakeStore({ legacy: { room: 'deadbeef' } });
  const vault = new KeyVault(store, fakeCrypto());

  assert.deepStrictEqual(vault.read(), { room: 'deadbeef' }, 'the key still works this run');
  assert.deepStrictEqual(store.state.legacy, {}, 'the plaintext copy is gone');
  assert.ok(store.state.vault && !store.state.vault.includes('deadbeef'));
});

test('with no credential store, keys are kept for the session and never written', () => {
  const store = fakeStore({ legacy: { room: 'deadbeef' } });
  const warnings = [];
  const vault = new KeyVault(store, fakeCrypto(false), (m) => warnings.push(m));

  assert.strictEqual(vault.sealed, false);
  assert.deepStrictEqual(vault.read(), { room: 'deadbeef' }, 'this run still works');

  vault.write({ room: 'deadbeef', other: 'cafe' });
  assert.strictEqual(store.state.vault, undefined, 'nothing encrypted was written');
  assert.deepStrictEqual(store.state.legacy, {}, 'and nothing plaintext either');
  assert.deepStrictEqual(vault.read(), { room: 'deadbeef', other: 'cafe' }, 'memory still holds them');
  assert.ok(warnings.some((m) => /session only/i.test(m)), 'and it says so');
});

test('a vault written by another account is refused rather than trusted', () => {
  const store = fakeStore();
  store.state.vault = Buffer.from('somebody-elses-ciphertext', 'utf8').toString('base64');

  const warnings = [];
  const vault = new KeyVault(store, fakeCrypto(), (m) => warnings.push(m));

  assert.deepStrictEqual(vault.read(), {}, 'the rooms simply report as locked');
  assert.ok(warnings.some((m) => /could not be decrypted/i.test(m)));
});

test('emptying the vault clears the stored blob', () => {
  const store = fakeStore();
  const vault = new KeyVault(store, fakeCrypto());
  vault.write({ room: 'aa' });
  vault.write({});
  assert.strictEqual(store.state.vault, undefined);
});

/*
 * safeStorage as Electron actually behaves: it answers false, silently and
 * without throwing, until the app has emitted `ready`. Both vaults are built at
 * module scope, long before that, so a vault that decides whether it can seal
 * at construction time always decides no — and then writes nothing, for the
 * life of the install.
 */
function wakingCrypto() {
  const real = fakeCrypto();
  const gate = { ready: false, asked: 0 };
  return {
    gate,
    encryptor: {
      available: () => {
        gate.asked += 1;
        return gate.ready;
      },
      encrypt: real.encrypt,
      decrypt: real.decrypt
    }
  };
}

test('the credential store is consulted on first use, not at construction', () => {
  const store = fakeStore();
  const { gate, encryptor } = wakingCrypto();

  const vault = new KeyVault(store, encryptor);
  assert.strictEqual(gate.asked, 0, 'building the vault asks the platform nothing');

  gate.ready = true; // app.whenReady() fires.
  vault.write({ room: 'a1b2c3d4' });

  assert.strictEqual(vault.sealed, true, 'it seals once there is somewhere to seal to');
  assert.ok(store.state.vault, 'and the keys actually reach the disk');
  assert.strictEqual(gate.asked, 1, 'the platform is still only asked once');
});

/*
 * main.ts imports Electron, so it cannot be required here and its send paths
 * cannot be exercised directly. What can be checked is the shape of the code,
 * and for this particular fault that turns out to be the useful thing to check:
 * three separate call sites — chunk envelopes, retransmit requests, and file
 * data slices — each put `JSON.stringify(message)` straight into a `send`, and
 * each produced a message the far end silently discarded as unsigned. Every one
 * of them looked correct in review and passed every behavioural test, because
 * the modules under test are handed a fake `send` and never authenticate
 * anything.
 *
 * `signedJson` is the only sanctioned way to turn a message into bytes. This
 * asserts nothing goes around it.
 */
test('nothing serialises a message onto a socket without signing it', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.ts'), 'utf8');
  const unsigned = [...source.matchAll(/\.send\([^;]*?JSON\.stringify\(/g)];

  assert.deepStrictEqual(
    unsigned.map((match) => match[0]),
    [],
    'a send() is serialising a message itself instead of going through signedJson()'
  );
});

test('an identity outlives the launch that created it', () => {
  const store = fakeStore();
  const { gate, encryptor } = wakingCrypto();

  // This launch: vault built before ready, identity written after it.
  const first = new KeyVault(store, encryptor);
  gate.ready = true;
  first.write({ publicKey: 'pub-1', privateKey: 'priv-1' });

  // The next launch reads the same storage and must find the same key. Deciding
  // sealability at construction meant it found nothing, generated a replacement,
  // and every peer that had pinned 'pub-1' refused the device from then on.
  assert.deepStrictEqual(
    new KeyVault(store, fakeCrypto()).read(),
    { publicKey: 'pub-1', privateKey: 'priv-1' },
    'the same key comes back, so no peer is asked to accept a new one'
  );
});



// -----------------------------------------------------------------------------

console.log('\n-- leaving a room --');

/*
 * A device id on the wire is a claim, not a fact. The owner used to remove
 * whoever a `room-leave` named, which meant any device on the network that
 * knew a room id could evict any member of it — no password, no membership,
 * and `room-leave` is not behind the decryption gate that clipboard and chat
 * payloads pass through.
 */

function roomWithMember(encrypted) {
  const rooms = makeManager();
  const room = rooms.createRoom({
    name: 'Lab',
    type: 'private',
    password: encrypted ? 'a-good-password' : '',
    ownerId: 'owner',
    ownerName: 'Owner'
  });
  rooms.addPendingMember(room.roomId, 'member', 'Member');
  rooms.approveMember(room.roomId, 'member');
  return { rooms, room };
}

test('a stranger cannot evict a member of an encrypted room', () => {
  const { rooms, room } = roomWithMember(true);
  assert.strictEqual(rooms.mayLeave(room.roomId, 'member', false), false);
});

test('a device outside the room cannot leave on a member’s behalf', () => {
  const { rooms, room } = roomWithMember(true);
  assert.strictEqual(rooms.mayLeave(room.roomId, 'stranger', true), false);
});

test('a member holding the room key can leave', () => {
  const { rooms, room } = roomWithMember(true);
  assert.strictEqual(rooms.mayLeave(room.roomId, 'member', true), true);
});

test('an unencrypted room has no proof to demand, so membership is the gate', () => {
  const { rooms, room } = roomWithMember(false);
  assert.strictEqual(rooms.mayLeave(room.roomId, 'member', false), true);
  assert.strictEqual(rooms.mayLeave(room.roomId, 'stranger', false), false);
});

test('a leave for a room that does not exist is ignored', () => {
  const { rooms } = roomWithMember(true);
  assert.strictEqual(rooms.mayLeave('no-such-room', 'member', true), false);
});

test('the proof a leaving member sends verifies only for its own room', () => {
  const salt = crypto.generateSalt();
  const key = crypto.deriveRoomKey('a-good-password', salt);
  const proof = crypto.createProof(key, 'room-a');
  assert.strictEqual(crypto.verifyProof(key, 'room-a', proof), true);
  assert.strictEqual(crypto.verifyProof(key, 'room-b', proof), false);
});


// -----------------------------------------------------------------------------

const identity = require(path.join(ROOT, "deviceIdentity.js"));

console.log("\n-- device identity --");

/*
 * A device id used to be a bare UUID that nothing checked, so every rule keyed
 * on it was only as strong as the sender’s honesty. Each device now signs what
 * it sends. These are the properties the rest of the protocol leans on.
 */

const alice = identity.createIdentity();
const mallory = identity.createIdentity();

function payload(over) {
  return Object.assign({
    v: 7,
    type: "chat",
    deviceId: "device-a",
    ts: 1000,
    roomId: "room-1",
    digest: identity.digestOf({ text: "hello" })
  }, over || {});
}

test("a signature verifies with the matching public key", () => {
  const body = payload();
  assert.strictEqual(identity.verify(alice.publicKey, body, identity.sign(alice.privateKey, body)), true);
});

test("another device cannot sign as this one", () => {
  const body = payload();
  assert.strictEqual(identity.verify(alice.publicKey, body, identity.sign(mallory.privateKey, body)), false);
});

test("changing any signed field invalidates the signature", () => {
  const body = payload();
  const sig = identity.sign(alice.privateKey, body);
  for (const field of ["type", "deviceId", "roomId", "digest"]) {
    const tampered = payload();
    tampered[field] = "tampered";
    assert.strictEqual(identity.verify(alice.publicKey, tampered, sig), false, field);
  }
  const moved = payload({ ts: 2000 });
  assert.strictEqual(identity.verify(alice.publicKey, moved, sig), false, "ts");
});

test("swapping the body invalidates the signature", () => {
  const body = payload();
  const sig = identity.sign(alice.privateKey, body);
  const swapped = payload({ digest: identity.digestOf({ text: "goodbye" }) });
  assert.strictEqual(identity.verify(alice.publicKey, swapped, sig), false);
});

test("a message addressed to someone else cannot be re-aimed", () => {
  const body = payload({ targetDeviceId: "device-b" });
  const sig = identity.sign(alice.privateKey, body);
  const reaimed = payload({ targetDeviceId: "device-c" });
  assert.strictEqual(identity.verify(alice.publicKey, reaimed, sig), false);
});

test("garbage in place of a signature is refused, not thrown on", () => {
  const body = payload();
  for (const junk of ["", "not-base64!!", Buffer.from("short").toString("base64")]) {
    assert.strictEqual(identity.verify(alice.publicKey, body, junk), false, junk);
  }
  assert.strictEqual(identity.verify("", body, identity.sign(alice.privateKey, body)), false);
  assert.strictEqual(identity.verify("not-a-key", body, identity.sign(alice.privateKey, body)), false);
});

test("canonical form does not depend on key order", () => {
  const one = identity.canonical({ b: 2, a: 1, c: { y: 2, x: 1 } });
  const two = identity.canonical({ c: { x: 1, y: 2 }, a: 1, b: 2 });
  assert.strictEqual(one, two);
});

test("an absent field and an undefined field sign identically", () => {
  assert.strictEqual(
    identity.canonical({ a: 1, roomId: undefined }),
    identity.canonical({ a: 1 })
  );
});

test("two devices never share an identity", () => {
  assert.notStrictEqual(alice.publicKey, mallory.publicKey);
  assert.notStrictEqual(identity.fingerprint(alice.publicKey), identity.fingerprint(mallory.publicKey));
});

test("a fingerprint is stable and readable", () => {
  const first = identity.fingerprint(alice.publicKey);
  assert.strictEqual(first, identity.fingerprint(alice.publicKey));
  assert.match(first, /^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
});

test("a message from too far out of step is refused", () => {
  const now = 1_000_000;
  assert.strictEqual(identity.withinSkew(now, now), true);
  assert.strictEqual(identity.withinSkew(now - identity.CLOCK_SKEW_MS + 1, now), true);
  assert.strictEqual(identity.withinSkew(now - identity.CLOCK_SKEW_MS - 1, now), false);
  assert.strictEqual(identity.withinSkew(now + identity.CLOCK_SKEW_MS + 1, now), false);
  assert.strictEqual(identity.withinSkew(NaN, now), false);
});


// -----------------------------------------------------------------------------

const { DeviceRegistry } = require(path.join(ROOT, "deviceRegistry.js"));

console.log("\n-- who is who --");

/*
 * A signature proves only that the sender holds the key they attached, which
 * is no obstacle to anyone who generated one a moment ago. Remembering which
 * key belongs to which device id is what turns that into an identity.
 */

function registry() {
  let saved = {};
  const reg = new DeviceRegistry({
    read: () => saved,
    write: (records) => { saved = records; }
  });
  reg.saved = () => saved;
  return reg;
}

test("an unknown device is recorded on sight", () => {
  const reg = registry();
  assert.strictEqual(reg.check("laptop", "key-a"), "first-seen");
  assert.strictEqual(reg.check("laptop", "key-a"), "known");
});

test("a device id cannot be claimed by a second key", () => {
  const reg = registry();
  reg.check("laptop", "key-a");
  assert.strictEqual(reg.check("laptop", "key-b"), "mismatch");
  assert.strictEqual(reg.get("laptop").publicKey, "key-a", "the original key is kept");
});

test("approval binds a key harder than merely seeing it", () => {
  const reg = registry();
  reg.check("laptop", "seen-first");
  assert.strictEqual(reg.get("laptop").bound, false);

  reg.bind("laptop", "bound-at-approval");
  assert.strictEqual(reg.get("laptop").bound, true);
  assert.strictEqual(reg.get("laptop").publicKey, "bound-at-approval");
  assert.strictEqual(reg.check("laptop", "seen-first"), "mismatch", "the old key stops working");
});

test("a roster teaches keys for devices never seen", () => {
  const reg = registry();
  reg.adopt([{ deviceId: "phone", publicKey: "key-p" }]);
  assert.strictEqual(reg.check("phone", "key-p"), "known");
  assert.strictEqual(reg.get("phone").bound, true);
});

test("a roster cannot overwrite a key this device bound itself", () => {
  const reg = registry();
  reg.bind("laptop", "ours");
  reg.adopt([{ deviceId: "laptop", publicKey: "theirs" }]);
  assert.strictEqual(reg.get("laptop").publicKey, "ours");
});

test("a roster does overwrite a key that was only observed", () => {
  const reg = registry();
  reg.check("laptop", "observed");
  reg.adopt([{ deviceId: "laptop", publicKey: "from-owner" }]);
  assert.strictEqual(reg.get("laptop").publicKey, "from-owner");
  assert.strictEqual(reg.get("laptop").bound, true);
});

test("roster entries with no key are skipped rather than clearing one", () => {
  const reg = registry();
  reg.bind("laptop", "ours");
  reg.adopt([{ deviceId: "laptop" }, { deviceId: "", publicKey: "x" }]);
  assert.strictEqual(reg.get("laptop").publicKey, "ours");
});

test("empty input is a mismatch, not a silent pass", () => {
  const reg = registry();
  assert.strictEqual(reg.check("", "key"), "mismatch");
  assert.strictEqual(reg.check("laptop", ""), "mismatch");
});

test("what is learned survives a restart", () => {
  let saved = {};
  const storage = { read: () => saved, write: (r) => { saved = r; } };
  new DeviceRegistry(storage).bind("laptop", "key-a");
  assert.strictEqual(new DeviceRegistry(storage).check("laptop", "key-b"), "mismatch");
  assert.strictEqual(new DeviceRegistry(storage).check("laptop", "key-a"), "known");
});

test("forgetting a device lets it be learned again", () => {
  const reg = registry();
  reg.bind("laptop", "key-a");
  reg.forget("laptop");
  assert.strictEqual(reg.check("laptop", "key-b"), "first-seen");
});


// -----------------------------------------------------------------------------

console.log("\n-- handing a key to one device --");

/*
 * The password used to be the key, which made removing somebody a polite
 * request: they still knew the password, so they still held the key. Content
 * keys are random and wrapped to a particular device instead, so the owner can
 * replace one without changing the password — and the device that was removed
 * has no way to unwrap the replacement.
 */

const owner = identity.createIdentity();
const joiner = identity.createIdentity();
const removed = identity.createIdentity();

test("a content key is 32 bytes and never the same twice", () => {
  const a = crypto.generateContentKey();
  const b = crypto.generateContentKey();
  assert.strictEqual(a.length, 32);
  assert.notStrictEqual(a.toString("hex"), b.toString("hex"));
});

test("a wrapped key opens for the device it was addressed to", () => {
  const ck = crypto.generateContentKey();
  const env = crypto.wrapKeyFor(ck, owner.boxPrivateKey, joiner.boxPublicKey, "room-1");
  const out = crypto.unwrapKeyFrom(env, joiner.boxPrivateKey, owner.boxPublicKey, "room-1");
  assert.strictEqual(out.toString("hex"), ck.toString("hex"));
});

test("and for nobody else, however well connected", () => {
  const ck = crypto.generateContentKey();
  const env = crypto.wrapKeyFor(ck, owner.boxPrivateKey, joiner.boxPublicKey, "room-1");
  assert.strictEqual(
    crypto.unwrapKeyFrom(env, removed.boxPrivateKey, owner.boxPublicKey, "room-1"),
    null
  );
});

test("an envelope from one room does not open in another", () => {
  const ck = crypto.generateContentKey();
  const env = crypto.wrapKeyFor(ck, owner.boxPrivateKey, joiner.boxPublicKey, "room-1");
  assert.strictEqual(
    crypto.unwrapKeyFrom(env, joiner.boxPrivateKey, owner.boxPublicKey, "room-2"),
    null
  );
});

test("knowing the room password does not open a wrapped key", () => {
  const ck = crypto.generateContentKey();
  const env = crypto.wrapKeyFor(ck, owner.boxPrivateKey, joiner.boxPublicKey, "room-1");
  const fromPassword = crypto.deriveRoomKey("the-room-password", crypto.generateSalt());
  assert.strictEqual(crypto.open(fromPassword, env), null);
});

test("a re-key leaves the removed device holding nothing useful", () => {
  const first = crypto.generateContentKey();
  const toRemoved = crypto.wrapKeyFor(first, owner.boxPrivateKey, removed.boxPublicKey, "room-1");
  assert.ok(crypto.unwrapKeyFrom(toRemoved, removed.boxPrivateKey, owner.boxPublicKey, "room-1"));

  // The owner removes them and re-wraps a fresh key for everyone who remains.
  const second = crypto.generateContentKey();
  const toJoiner = crypto.wrapKeyFor(second, owner.boxPrivateKey, joiner.boxPublicKey, "room-1");

  assert.ok(crypto.unwrapKeyFrom(toJoiner, joiner.boxPrivateKey, owner.boxPublicKey, "room-1"));
  assert.strictEqual(
    crypto.unwrapKeyFrom(toJoiner, removed.boxPrivateKey, owner.boxPublicKey, "room-1"),
    null,
    "the removed device cannot read the new key"
  );

  const old = crypto.unwrapKeyFrom(toRemoved, removed.boxPrivateKey, owner.boxPublicKey, "room-1");
  assert.notStrictEqual(old.toString("hex"), second.toString("hex"), "and its old one is stale");
});

test("a tampered wrapper is refused rather than half-decoded", () => {
  const ck = crypto.generateContentKey();
  const env = crypto.wrapKeyFor(ck, owner.boxPrivateKey, joiner.boxPublicKey, "room-1");
  const bent = Object.assign({}, env, { tag: Buffer.alloc(16, 1).toString("hex") });
  assert.strictEqual(
    crypto.unwrapKeyFrom(bent, joiner.boxPrivateKey, owner.boxPublicKey, "room-1"),
    null
  );
});

test("nonsense in place of an envelope or a key returns null", () => {
  assert.strictEqual(
    crypto.unwrapKeyFrom(undefined, joiner.boxPrivateKey, owner.boxPublicKey, "room-1"),
    null
  );
  const ck = crypto.generateContentKey();
  const env = crypto.wrapKeyFor(ck, owner.boxPrivateKey, joiner.boxPublicKey, "room-1");
  assert.strictEqual(crypto.unwrapKeyFrom(env, "not-a-key", owner.boxPublicKey, "room-1"), null);
});

console.log("\n-- direct-message encryption --");

/*
 * A direct message has no room and so no password to derive a key from —
 * `dmAgreedKey` is what makes it end-to-end encrypted anyway: the same X25519
 * agreement `wrapKeyFor` uses, domain-separated by the sorted pair of device
 * ids instead of a room id, so both sides land on the identical key with no
 * exchange round trip of their own.
 */

const dmA = identity.createIdentity();
const dmB = identity.createIdentity();
const dmEve = identity.createIdentity();

test("both sides compute the identical key, whichever is 'self'", () => {
  const fromA = crypto.dmAgreedKey(dmA.boxPrivateKey, dmB.boxPublicKey, "a-id", "b-id");
  const fromB = crypto.dmAgreedKey(dmB.boxPrivateKey, dmA.boxPublicKey, "b-id", "a-id");
  assert.strictEqual(fromA.toString("hex"), fromB.toString("hex"));
});

test("a message sealed for one pair does not open for a different one", () => {
  const key = crypto.dmAgreedKey(dmA.boxPrivateKey, dmB.boxPublicKey, "a-id", "b-id");
  const sealed = crypto.sealJson(key, { text: "only for b" });

  const wrongPeer = crypto.dmAgreedKey(dmA.boxPrivateKey, dmEve.boxPublicKey, "a-id", "eve-id");
  assert.strictEqual(crypto.openJson(wrongPeer, sealed), null);

  const right = crypto.dmAgreedKey(dmB.boxPrivateKey, dmA.boxPublicKey, "b-id", "a-id");
  assert.deepStrictEqual(crypto.openJson(right, sealed), { text: "only for b" });
});

test("the key changes if either device id changes, even with the same two devices", () => {
  const a = crypto.dmAgreedKey(dmA.boxPrivateKey, dmB.boxPublicKey, "a-id", "b-id");
  const b = crypto.dmAgreedKey(dmA.boxPrivateKey, dmB.boxPublicKey, "a-id-2", "b-id");
  assert.notStrictEqual(a.toString("hex"), b.toString("hex"));
});

test("an eavesdropper who only sees the sealed envelope cannot open it", () => {
  const key = crypto.dmAgreedKey(dmA.boxPrivateKey, dmB.boxPublicKey, "a-id", "b-id");
  const sealed = crypto.sealJson(key, { text: "secret" });
  // Eve holds neither box private key for this pair, so no key she can
  // derive from her own keypair and anyone else's public one will match.
  const eveGuess = crypto.dmAgreedKey(dmEve.boxPrivateKey, dmB.boxPublicKey, "eve-id", "b-id");
  assert.strictEqual(crypto.openJson(eveGuess, sealed), null);
});

(async () => {
  for (const run of deferred) {
    await run();
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
})();
