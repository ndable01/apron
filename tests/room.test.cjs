'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../assets/core.js');
const Room = require('../assets/room.js');
const QR = require('../assets/qr.js');

let clock = Date.now();
const ev = (fields, from = 'd-supplier1') => Room.validateEvent(Object.assign({ from, ts: ++clock }, fields));
const decisionText = kind => 'решение ' + kind;
const fruit = (n, verdict, extra = {}) => Object.assign({ t: 'fruit', id: 'f' + n, n, box: { p: 7, b: 23 }, verdict, source: 'model', conf: 0.9, ms: 2100, title: verdict === 'defect' ? 'Брак: открытая трещина у плодоножки' : 'Годен', explanation: 'Видно всё. Вторая фраза.', rc_hint: verdict === 'defect' ? 'Смотрите плоды у плодоножки' : null, findings: verdict === 'defect' ? ['открытая трещина'] : [], thumb: null, photo: 'https://ntfy.sh/file/abc.jpg', corrected: false }, extra);

test('events are validated and garbage is dropped', () => {
  assert.ok(ev({ t: 'box', n: 29, box: { p: 7, b: 23 } }));
  assert.equal(ev({ t: 'box', n: 29, box: { p: 7, b: 23, x: 1 } }), null);
  assert.equal(ev({ t: 'unknown' }), null);
  assert.equal(ev({ t: 'decision', kind: 'approve', pallets: [] }), null);
  assert.equal(Room.validateEvent({ t: 'reset', from: 'BAD ID', ts: Date.now() }), null);
  assert.equal(Room.validateEvent({ t: 'reset', from: 'd-ok12', ts: 5 }), null);
  assert.equal(ev(fruit(29, 'good', { photo: 'javascript:alert(1)' })), null);
  assert.equal(ev(fruit(29, 'good', { findings: ['что-то своё'] })), null);
  assert.equal(ev({ t: 'state', goal: 30, checked: 2, defects: 2, offSpec: 1, boxes: [] }), null);
  const clean = ev(Object.assign(fruit(29, 'good'), { extra: 'x' }));
  assert.equal(clean.extra, undefined);
});

test('events stay under 3500 bytes: explanation goes first, then the thumbnail', () => {
  const thumb = 'data:image/jpeg;base64,' + 'A'.repeat(2500);
  const big = Object.assign(fruit(29, 'good'), { from: 'd-x1234', ts: Date.now(), thumb, explanation: 'я'.repeat(200), title: 'я'.repeat(40) });
  big.rc_hint = 'я'.repeat(120);
  const fitted = Room.fit(big);
  assert.ok(Buffer.byteLength(JSON.stringify(fitted)) <= Room.MAX_EVENT_BYTES);
  assert.equal(fitted.explanation, undefined);
  assert.equal(fitted.thumb, thumb);
  assert.ok(Room.validateEvent(fitted));
});

test('room and role come only from the link, CONFIG.room is a flagged fallback', () => {
  assert.deepEqual(Room.fromLink('?role=hall&room=apron-abc12345&demo=1', { room: '' }), { room: 'apron-abc12345', linked: true, role: 'hall', demo: true, local: false });
  assert.equal(Room.fromLink('?role=rc', { room: '' }).room, null);
  assert.equal(Room.fromLink('?role=rc&room=bad room', { room: '' }).room, null);
  const fallback = Room.fromLink('?role=rc', { room: 'apron-local1' });
  assert.equal(fallback.room, 'apron-local1'); assert.equal(fallback.linked, false);
  assert.equal(Room.fromLink('?room=apron-abc12345', { room: '' }).role, 'supplier');
  assert.match(Room.newCode(), /^apron-[a-z2-9]{8}$/);
});

test('sync server: ntfy on the web, the page itself on a local network', () => {
  const config = { sync: { server: 'https://ntfy.sh/' } };
  assert.equal(Room.syncServer({ protocol: 'https:', hostname: 'ndable01.github.io', origin: 'https://ndable01.github.io' }, false, config), 'https://ntfy.sh');
  assert.equal(Room.syncServer({ protocol: 'http:', hostname: '192.168.1.20', origin: 'http://192.168.1.20:8080' }, false, config), 'http://192.168.1.20:8080');
  assert.equal(Room.syncServer({ protocol: 'http:', hostname: 'localhost', origin: 'http://localhost:8080' }, false, config), 'http://localhost:8080');
  assert.equal(Room.syncServer({ protocol: 'https:', hostname: 'x.example', origin: 'https://x.example' }, true, config), 'https://x.example');
});

test('RC follows the stage: box, photo, 2 of 30, decision, final', () => {
  const rc = Core.roomState('apron-test0001', 'rc');
  assert.equal(Core.stats(rc).checked, 28);
  assert.deepEqual(Core.allowedDecisions(rc), []);
  Core.applyRoomEvent(rc, ev({ t: 'box', n: 29, box: { p: 7, b: 23 } }), decisionText);
  assert.equal(rc.room.box.n, 29);
  Core.applyRoomEvent(rc, ev({ t: 'shooting', n: 29 }), decisionText);
  assert.equal(rc.room.shooting, 29);
  const first = Core.applyRoomEvent(rc, ev(fruit(29, 'good', { tally: { goal: 30, checked: 29, defects: 1, offSpec: 0, boxes: [{ p: 7, b: 12 }] } })), decisionText);
  assert.equal(first.vibrate, true);
  assert.equal(rc.room.box, null);
  Core.applyRoomEvent(rc, ev({ t: 'box', n: 30, box: { p: 3, b: 11 } }), decisionText);
  Core.applyRoomEvent(rc, ev({ t: 'box', n: 30, box: { p: 12, b: 5 } }), decisionText);
  assert.match(rc.events[rc.events.length - 1].text, /Apron выбрал заново/);
  Core.applyRoomEvent(rc, ev({ t: 'wrongbox', n: 30, box: { p: 12, b: 5 }, label: 'Паллета 3, ящик 11' }), decisionText);
  assert.match(rc.events[rc.events.length - 1].text, /Попытка снять не тот ящик/);
  Core.applyRoomEvent(rc, ev(fruit(30, 'defect', { box: { p: 12, b: 5 }, tally: { goal: 30, checked: 30, defects: 2, offSpec: 0, boxes: [{ p: 7, b: 12 }, { p: 12, b: 5 }] } })), decisionText);
  const st = Core.stats(rc);
  assert.deepEqual([st.checked, st.defects, Math.round(st.risk * 100), st.level], [30, 2, 29, 'high']);
  assert.deepEqual(Core.allowedDecisions(rc), ['resort', 'wait_strict']);
  assert.deepEqual(Core.boxesWithFindings(rc), [{ p: 7, b: 12 }, { p: 12, b: 5 }]);
  const restored = Core.restore(JSON.stringify(rc));
  assert.equal(Core.stats(restored).checked, 30);
  assert.equal(restored.fruits[1].remote.title, 'Брак: открытая трещина у плодоножки');
});

test('the supplier takes decisions and resets from the room, but not fruit from others', () => {
  const supplier = Core.roomState('apron-test0001', 'supplier');
  Core.addFruit(supplier, { id: 'a', n: 29, verdict: 'good', source: 'manual', box: { p: 7, b: 23 }, ts: Date.now(), photo: null, result: null });
  Core.addFruit(supplier, { id: 'b', n: 30, verdict: 'defect', source: 'manual', box: { p: 7, b: 23 }, ts: Date.now(), photo: null, result: null });
  assert.equal(Core.applyRoomEvent(supplier, ev(fruit(31, 'good'), 'd-other1'), decisionText).changed, false);
  assert.equal(Core.applyRoomEvent(supplier, ev({ t: 'decision', kind: 'wait', pallets: [] }, 'd-rc0001'), decisionText).changed, false, 'decision not allowed at high risk');
  const got = Core.applyRoomEvent(supplier, ev({ t: 'decision', kind: 'resort', pallets: [7] }, 'd-rc0001'), decisionText);
  assert.equal(got.vibrate, true);
  assert.equal(supplier.decision.kind, 'resort');
  const older = ev({ t: 'decision', kind: 'wait_strict', pallets: [7] }, 'd-rc0002'); older.ts = supplier.decision.ts - 1;
  assert.equal(Core.applyRoomEvent(supplier, older, decisionText).changed, false, 'older decision does not win');
  assert.equal(Core.applyRoomEvent(supplier, ev({ t: 'reset' }, 'd-hall001'), decisionText).reset, true);
  assert.deepEqual([Core.stats(supplier).checked, supplier.fruits.length, supplier.decision], [28, 0, null]);
});

test('a correction replaces the fruit on RC and clears the decision', () => {
  const rc = Core.roomState('apron-test0001', 'rc');
  Core.applyRoomEvent(rc, ev(fruit(29, 'defect', { tally: { goal: 30, checked: 29, defects: 2, offSpec: 0, boxes: [{ p: 7, b: 12 }, { p: 7, b: 23 }] } })), decisionText);
  Core.applyRoomEvent(rc, ev({ t: 'decision', kind: 'resort', pallets: [7] }, 'd-rc0001'), decisionText);
  assert.equal(rc.decision.kind, 'resort');
  Core.applyRoomEvent(rc, ev(fruit(29, 'good', { source: 'manual', conf: null, title: null, explanation: null, corrected: true, tally: { goal: 30, checked: 29, defects: 1, offSpec: 0, boxes: [{ p: 7, b: 12 }] } })), decisionText);
  assert.equal(rc.fruits.length, 1);
  assert.equal(rc.fruits[0].verdict, 'good');
  assert.equal(rc.decision, null);
  assert.match(rc.events[rc.events.length - 1].text, /исправлена на «годен»/);
});

test('the room tally is exactly what the supplier counted', () => {
  const s = Core.roomState('apron-test0001', 'supplier');
  Core.addFruit(s, { id: 'a', n: 29, verdict: 'defect', source: 'manual', box: { p: 3, b: 11 }, ts: Date.now(), photo: null, result: null });
  assert.deepEqual(Core.tally(s), { goal: 30, checked: 29, defects: 2, offSpec: 0, boxes: [{ p: 7, b: 12 }, { p: 3, b: 11 }] });
  assert.ok(Room.validateEvent(Object.assign({ t: 'state', from: 'd-s1234', ts: Date.now() }, Core.tally(s))));
});

test('QR encoder keeps the structure decoders look for', () => {
  const code = QR.encode('https://ndable01.github.io/apron/?role=rc&room=apron-k3x9q2mf');
  assert.equal(code.size, code.version * 4 + 17);
  const m = code.modules, finder = (x, y) => [0, 1, 2, 3, 4, 5, 6].every(i => m[y][x + i] && m[y + 6][x + i] && m[y + i][x] && m[y + i][x + 6]) && m[y + 3][x + 3];
  assert.ok(finder(0, 0) && finder(code.size - 7, 0) && finder(0, code.size - 7));
  assert.ok(m[code.size - 8][8], 'dark module');
  for (let i = 8; i < code.size - 8; i++) assert.equal(m[6][i], i % 2 === 0);
  assert.throws(() => QR.encode('x'.repeat(300)));
});
