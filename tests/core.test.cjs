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
  assert.equal(examples.length, 4);
  examples.forEach(result => assert.equal(Core.validateResult(result), result));
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
