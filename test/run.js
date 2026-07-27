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
const { RoomManager } = require(path.join(ROOT, 'roomManager.js'));
const { HistoryManager } = require(path.join(ROOT, 'historyManager.js'));

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

test('an unjoined advert shows as discovered; a joined one does not', () => {
  const rm = makeManager();
  rm.recordAdvert({ roomId: 'x', name: 'Elsewhere', type: 'public', ownerId: 'Z', ownerName: 'Z', keySalt: 'aa', encrypted: false, memberCount: 1, createdAt: Date.now() }, '10.0.0.5');
  assert.strictEqual(rm.getDiscoveredRooms().length, 1);
  const own = rm.createRoom({ name: 'Mine', type: 'public', password: '', ownerId: 'A', ownerName: 'A' });
  rm.recordAdvert(rm.toAdvert(own), '10.0.0.1');
  assert.strictEqual(rm.getDiscoveredRooms().length, 1, 'a room we are in must not appear as discoverable');
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
  for (let i = 0; i < 130; i++) h.addClipboardEntry('text', `r1-${i}`, 'A', 'A', 'r1');
  for (let i = 0; i < 10; i++) h.addClipboardEntry('text', `r2-${i}`, 'A', 'A', 'r2');
  assert.strictEqual(h.getClipboardHistory('r1').length, 100);
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
  const m = h.addChatMessage('text', 'hi', 'A', 'A', 'r1');
  assert.strictEqual(h.hasChatMessage(m.id), true);
  assert.strictEqual(h.hasChatMessage('nope'), false);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
