'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Core = require('../assets/core.js');
const photo = 'data:image/jpeg;base64,/9j/AA==';
function fruit(id, verdict, n = 29) { return { id, n, verdict, box: { p: 7, b: 23 }, source: 'manual', photo, result: null, ts: 1793510000000 }; }
function example() { return JSON.parse(fs.readFileSync('prompts/inspect-system.md', 'utf8').split('\n').find(line => line.startsWith('{"verdict":"good"'))); }

test('published statistical control values and interval', () => {
  assert.equal(Core.selftest().length, 8);
  assert.ok(Math.abs(Core.risk(2, 30, 10) - 0.2909016) < 1e-6);
  assert.equal(Core.risk(0, 30, 0), 1);
  assert.equal(Core.risk(30, 30, 100), 0);
  assert.throws(() => Core.risk(3, 2, 10));
  assert.throws(() => Core.risk(1, 30, NaN));
});
test('more good fruit lowers risk, more defects raises it, including endpoints', () => {
  for (const k of [0, 1, 2, 10, 29]) {
    // Extreme tails can round to 1 in IEEE-754 arithmetic.
    assert.ok(Core.risk(k, 31, 10) <= Core.risk(k, 30, 10));
    assert.ok(Core.risk(k + 1, 30, 10) >= Core.risk(k, 30, 10));
  }
  assert.ok(Core.risk(2, 31, 10) < Core.risk(2, 30, 10));
  assert.ok(Number.isFinite(Core.risk(0, 1000, 10)));
  assert.ok(Core.risk(1000, 1000, 10) > .99999);
});
test('two good fruit complete a personal sample with the wait decision', () => {
  const s = Core.baseState();
  assert.deepEqual(Core.allowedDecisions(s), []);
  Core.addFruit(s, fruit('a', 'good'));
  Core.addFruit(s, fruit('b', 'good', 30));
  assert.equal(Core.stats(s).checked, 30);
  assert.equal(Core.stats(s).defects, 1);
  assert.equal(Math.round(Core.stats(s).risk * 100), 10);
  assert.deepEqual(Core.allowedDecisions(s), ['wait']);
});
test('bad fruit raises risk and opens both cautious decisions before completion', () => {
  const s = Core.baseState();
  Core.addFruit(s, fruit('a', 'defect'));
  assert.equal(Core.stats(s).done, false);
  assert.equal(Core.stats(s).level, 'high');
  assert.deepEqual(Core.allowedDecisions(s), ['resort', 'wait_strict']);
  Core.addFruit(s, fruit('b', 'good', 30));
  assert.equal(Core.extraNeeded(s), 10);
  s.goal = 40;
  for (let n = 31; n <= 40; n++) Core.addFruit(s, fruit('fruit-' + n, 'good', n));
  assert.equal(Core.stats(s).level, 'low');
  assert.equal(Core.stats(s).done, true);
});
test('correction replaces a verdict and invalidates the old RC decision', () => {
  const s = Core.baseState();
  Core.addFruit(s, fruit('a', 'defect'));
  assert.equal(Core.addFruit(s, fruit('a', 'defect')), false);
  s.decision = { kind: 'resort', ts: Date.now() };
  Core.correctFruit(s, 'a', 'offspec');
  assert.equal(Core.stats(s).checked, 29);
  assert.equal(Core.stats(s).defects, 1);
  assert.equal(Core.stats(s).offSpec, 1);
  assert.equal(s.decision, null);
  assert.equal(s.fruits[0].source, 'manual');
  assert.throws(() => Core.correctFruit(s, 'missing', 'good'));
});
test('offspec counts and risk stay separate and drive the displayed category', () => {
  const s = Core.baseState();
  Core.addFruit(s, fruit('a', 'offspec'));
  Core.addFruit(s, fruit('b', 'offspec', 30));
  const st = Core.stats(s);
  assert.equal(st.defects, 1);
  assert.equal(st.offSpec, 2);
  assert.equal(st.category, 'offspec');
  assert.equal(st.risk, st.offspecRisk);
});
test('a pending photo and selected box survive a reload', () => {
  const s = Core.baseState();
  s.pending = { id: 'pending', n: 29, box: { p: 3, b: 11 }, ts: Date.now(), photo, test: false, result: null };
  const restored = Core.restore(JSON.stringify(s));
  assert.deepEqual(restored.pending, s.pending);
  Core.addFruit(restored, fruit('a', 'good'));
  assert.equal(restored.pending, null);
});
test('corrupt storage is rejected instead of silently changing counts', () => {
  const s = Core.baseState();
  Core.addFruit(s, fruit('a', 'good'));
  assert.equal(Core.restore(JSON.stringify(s)).fruits.length, 1);
  s.fruits.push(fruit('a', 'good', 30));
  assert.throws(() => Core.restore(JSON.stringify(s)));
  s.fruits = [fruit('b', 'good', 50)];
  assert.throws(() => Core.restore(JSON.stringify(s)));
  assert.throws(() => Core.restore('{bad json'));
});
test('actual prompt examples satisfy the client contract', () => {
  const examples = fs.readFileSync('prompts/inspect-system.md', 'utf8').split('\n').filter(line => line.startsWith('{"verdict":')).map(JSON.parse);
  assert.equal(examples.length, 5);
  examples.forEach(result => assert.equal(Core.validateResult(result), result));
  const insufficient = examples.find(r => r.verdict === 'insufficient');
  assert.throws(() => Core.validateResult({ ...insufficient, not_visible: [] }));
  assert.throws(() => Core.validateResult({ ...insufficient, rc_hint: 'Смотрите пятна' }));
  assert.throws(() => Core.validateResult({ ...insufficient, checks: example().checks }));
  assert.throws(() => Core.addFruit(Core.baseState(), { id: 'x', verdict: 'insufficient' }));
});
test('invalid and incomplete provider answers cannot become sample results', () => {
  assert.throws(() => Core.validateResult({ verdict: 'good' }));
  const r = example();
  r.confidence = 1.1;
  assert.throws(() => Core.validateResult(r));
  r.confidence = .9; r.checks.pop();
  assert.throws(() => Core.validateResult(r));
  const duplicate = example(); duplicate.checks[0] = duplicate.checks[1];
  assert.throws(() => Core.validateResult(duplicate));
  const long = example(); long.title = 'a'.repeat(41);
  assert.throws(() => Core.validateResult(long));
});
test('reset creates new arrays and keeps personal sessions independent', () => {
  const a = Core.baseState(), b = Core.baseState();
  Core.addFruit(a, fruit('a', 'defect'));
  assert.equal(b.fruits.length, 0);
  assert.equal(Core.stats(b).checked, 28);
  const fresh = Core.baseState();
  assert.equal(fresh.decision, null);
  assert.equal(fresh.pending, null);
});

function ownState() {
  const s = Core.baseState(false);
  Object.assign(s.batch, { code: 'OWN-1', supplier: 'Ферма', chain: 'Сеть', rc: 'РЦ', weight: 4 });
  return s;
}
test('own parties start empty, without an invented risk or RC decision', () => {
  const s = ownState();
  assert.equal(Core.stats(s).checked, 0);
  assert.equal(Core.stats(s).risk, null);
  assert.equal(Core.stats(s).level, 'empty');
  assert.deepEqual(Core.allowedDecisions(s), []);
  assert.equal(Core.restore(JSON.stringify(s)).batch.code, 'OWN-1');
});
test('edits recalculate per-party tolerances without losing photographs', () => {
  const s = ownState();
  Core.addFruit(s, fruit('a', 'defect', 1));
  const before = Core.stats(s).risk;
  const b = JSON.parse(JSON.stringify(s.batch));
  b.tolerance = { defect: 80, offspec: 80 }; b.product = 'Томаты красные'; b.revenue = 640000;
  s.decision = { kind: 'resort', ts: Date.now() };
  Core.updateBatch(s, b);
  assert.ok(Core.stats(s).risk < before);
  assert.equal(s.fruits[0].photo, photo);
  assert.equal(s.batch.product, 'Томаты красные');
  assert.equal(s.decision, null);
  assert.equal(Core.CONFIG.tolerance.defect, 10);
});
test('invalid edits are rejected before changing the party', () => {
  const s = ownState(), original = JSON.stringify(s);
  for (const change of [{ weight: -1 }, { sampleTotal: 0 }, { supplier: '  ' }, { pallets: 1.5 }, { revenue: Infinity }, { tolerance: { defect: 101, offspec: 10 } }]) {
    const b = JSON.parse(JSON.stringify(s.batch)); Object.assign(b, change);
    assert.throws(() => Core.updateBatch(s, b));
    assert.equal(JSON.stringify(s), original);
  }
});
test('goal cannot erase already counted fruit', () => {
  const s = ownState(); Core.addFruit(s, fruit('a', 'good', 1)); Core.addFruit(s, fruit('b', 'good', 2));
  const b = JSON.parse(JSON.stringify(s.batch)); b.sampleTotal = 1;
  assert.throws(() => Core.updateBatch(s, b)); assert.equal(s.fruits.length, 2);
});
test('a new sample preserves party data and measured values, without a fake seed', () => {
  const s = ownState(); s.batch.measurements.brix = 5.8; s.batch.documents.quality = true;
  Core.addFruit(s, fruit('a', 'defect', 1)); s.decision = { kind: 'resort', ts: Date.now() };
  Core.resetSample(s);
  assert.equal(Core.stats(s).checked, 0); assert.equal(s.batch.measurements.brix, 5.8);
  assert.equal(s.batch.documents.quality, true); assert.equal(s.decision, null);
  assert.equal(s.batch.supplier, 'Ферма');
});
test('legacy saved sessions migrate while preserving sample and verdicts', () => {
  const legacy = { version: 2, goal: 30, fruits: [fruit('legacy', 'good')], pending: null, decision: null, events: [], role: 'supplier' };
  const s = Core.restore(JSON.stringify(legacy));
  assert.equal(s.version, 3); assert.equal(Core.stats(s).checked, 29);
  assert.equal(s.fruits[0].id, 'legacy'); assert.equal(s.batch.example, true);
});
test('a changed model specification requires explicit confirmation of old model results', () => {
  const s = ownState();
  Core.addFruit(s, { ...fruit('model', 'good', 1), source: 'model', result: example(), ms: 1200 });
  const b = JSON.parse(JSON.stringify(s.batch)); b.grade = 'высший';
  Core.updateBatch(s, b);
  assert.equal(Core.stats(s).needsReview, true); assert.equal(Core.stats(s).risk, null);
  assert.deepEqual(Core.allowedDecisions(s), []);
  Core.correctFruit(s, 'model', 'good');
  assert.equal(Core.stats(s).needsReview, false); assert.equal(s.fruits[0].source, 'manual');
});
test('the example draws stage boxes, own parties draw from their own range', () => {
  const ex = Core.baseState().batch;
  for (let i = 0; i < 50; i++) { const x = Core.pickBox(ex); assert.ok(Core.CONFIG.boxes.some(b => b.p === x.p && b.b === x.b)); }
  const own = Core.defaultBatch(false); own.pallets = 2; own.boxesPerPallet = 3;
  for (let i = 0; i < 50; i++) { const x = Core.pickBox(own); assert.ok(x.p >= 1 && x.p <= 2 && x.b >= 1 && x.b <= 3); }
  assert.deepEqual(Core.pickBox(own, () => 0.999), { p: 2, b: 3 });
});
test('box labels confirm, contradict or stay unconfirmed', () => {
  const box = { p: 7, b: 23 };
  assert.equal(Core.labelCheck('Паллета 7, ящик 23', box).status, 'confirmed');
  assert.equal(Core.labelCheck('ЯЩИК №23', box).status, 'confirmed');
  assert.deepEqual(Core.labelCheck('Паллета 3, ящик 11', box), { status: 'mismatch', box: 11, pallet: 3 });
  assert.equal(Core.labelCheck('Паллета 3, ящик 23', box).status, 'mismatch');
  assert.equal(Core.labelCheck('Томаты розовые, 6 кг', box).status, 'unconfirmed');
  assert.equal(Core.labelCheck('Паллета 7', box).status, 'unconfirmed');
  assert.equal(Core.labelCheck(null, box).status, 'unconfirmed');
  assert.equal(Core.labelCheck('', box).status, 'unconfirmed');
});
test('label and timing marks survive a reload and are validated', () => {
  const s = Core.baseState();
  Core.addFruit(s, { ...fruit('a', 'good'), boxCheck: 'confirmed', shotDelay: 40 });
  const back = Core.restore(JSON.stringify(s));
  assert.equal(back.fruits[0].boxCheck, 'confirmed');
  assert.equal(back.fruits[0].shotDelay, 40);
  s.fruits[0].boxCheck = 'mismatch';
  assert.throws(() => Core.restore(JSON.stringify(s)));
  s.fruits[0].boxCheck = 'confirmed'; s.fruits[0].shotDelay = -1;
  assert.throws(() => Core.restore(JSON.stringify(s)));
});
