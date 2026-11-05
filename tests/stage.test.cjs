'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../assets/core.js');

const fruit = verdict => ({ id: verdict, n: 30, verdict, box: { p: 7, b: 23 }, source: 'manual', photo: null, result: null, ts: Date.now() });

test('the stage starts at 29 of 30, so one photo decides the ending', () => {
  const s = Core.baseState();
  const st = Core.stats(s);
  assert.deepEqual([st.checked, st.defects, Math.round(st.risk * 100), st.level, st.done], [29, 1, 11, 'low', false]);
  assert.deepEqual(Core.allowedDecisions(s), []);
});

test('a good fruit ends at 1 of 30, low risk, and the RC waits for the truck', () => {
  const s = Core.baseState(); Core.addFruit(s, fruit('good'));
  const st = Core.stats(s);
  assert.deepEqual([st.checked, st.defects, Math.round(st.risk * 100), st.level, st.done], [30, 1, 10, 'low', true]);
  assert.deepEqual(Core.allowedDecisions(s), ['wait']);
});

test('a defect ends at 2 of 30, high risk, and the RC can send the batch back to sorting', () => {
  const s = Core.baseState(); Core.addFruit(s, fruit('defect'));
  const st = Core.stats(s);
  assert.deepEqual([st.checked, st.defects, Math.round(st.risk * 100), st.level, st.done], [30, 2, 29, 'high', true]);
  assert.deepEqual(Core.allowedDecisions(s), ['resort', 'wait_strict']);
  assert.equal(Core.extraNeeded(s), 10);
});

test('the self-test still passes with the stage start', () => {
  assert.ok(Core.selftest().length >= 6);
});
