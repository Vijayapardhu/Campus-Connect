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
const { CallManager, PARTICIPANT_TTL_MS } = require(path.join(ROOT, 'callManager.js'));
const { migrateUserData } = require(path.join(ROOT, 'migrate.js'));
const {
  createInjector,
  parseRemoteInput,
  toRobotKey,
  toScreenPoint,
  MAX_TEXT_LENGTH
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

console.log('\n-- pinned items --');

test('a pinned item is not evicted by newer items', () => {
  const h = makeHistory();
  const first = h.addClipboardEntry('text', 'keep me', 'A', 'A', 'r1');
  assert.strictEqual(h.togglePin(first.id), true);
  for (let i = 0; i < 150; i++) h.addClipboardEntry('text', `noise-${i}`, 'A', 'A', 'r1');
  const survivors = h.getClipboardHistory('r1');
  assert.ok(survivors.some((e) => e.id === first.id), 'the pinned entry was evicted');
});

test('pinned items do not consume the cap', () => {
  const h = makeHistory();
  for (let i = 0; i < 5; i++) {
    const e = h.addClipboardEntry('text', `pin-${i}`, 'A', 'A', 'r1');
    h.togglePin(e.id);
  }
  for (let i = 0; i < 150; i++) h.addClipboardEntry('text', `noise-${i}`, 'A', 'A', 'r1');
  const all = h.getClipboardHistory('r1');
  assert.strictEqual(all.filter((e) => e.pinned).length, 5);
  assert.strictEqual(all.filter((e) => !e.pinned).length, 100, 'unpinned entries should still be capped at 100');
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
  for (let i = 0; i < 150; i++) h.addClipboardEntry('text', `noise-${i}`, 'A', 'A', 'r1');
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

console.log(`\n${passed} passed, ${failed} failed\n`);
