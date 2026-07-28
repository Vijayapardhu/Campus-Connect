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
const { ChunkAssembler, splitIntoChunks } = require(path.join(ROOT, 'transfer.js'));
const net = require(path.join(ROOT, 'network.js'));
const { FrameDecoder, encodeFrame, HEADER_BYTES } = require(path.join(ROOT, 'framing.js'));

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

console.log(`\n${passed} passed, ${failed} failed\n`);
