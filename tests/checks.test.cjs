'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../assets/core.js');
const Checks = require('../assets/checks.js');

test('the example batch shows five filled sections, every reading marked as an example', () => {
  const sections = Checks.sections(Core.defaultBatch(true), { today: new Date('2026-11-06T10:00:00') });
  assert.deepEqual(sections.map(s => s.key), ['origin', 'gost', 'cold', 'ripeness', 'safety']);
  assert.ok(sections.every(s => s.done && s.example && s.items.length && s.summary));
  assert.match(sections[0].summary, /05\.11/);
  const serials = sections.flatMap(s => s.items).flatMap(i => i.meta || []).filter(m => m[0] === 'Серийный номер');
  assert.ok(serials.length >= 5);
  assert.ok(serials.every(m => /пример$/.test(m[1])));
  const text = JSON.stringify(sections);
  assert.ok(!/[—·→]/.test(text), 'no long dashes, middle dots or arrows');
  assert.ok(!/поверка/i.test(JSON.stringify(sections[3].items[1].meta.filter(m => m[0] === 'Поверка'))), 'penetrometer is calibrated, not verified');
});

test('every example requirement of the chain is checked and met, own batches get none invented', () => {
  const ex = Checks.sections(Core.defaultBatch(true));
  const r = Checks.requirements(ex);
  assert.equal(r.total, 17);
  assert.equal(r.met, 17);
  assert.ok(r.checks.every(c => c.req && c.value));
  const b = Core.defaultBatch(false); Object.assign(b, { code: 'П-1', supplier: 'Х', chain: 'С', rc: 'Р', weight: 5, rules: 'Калибр 60-70 мм\nБез зелёных' });
  const own = Checks.sections(b, { files: {} });
  assert.equal(Checks.requirements(own).total, 0);
  assert.deepEqual(own[0].items[0].list, ['Калибр 60-70 мм', 'Без зелёных']);
});

test('the passport names risks on the way, how to avoid them and what the RC opens first', () => {
  const t = Checks.transit(Core.defaultBatch(true), { boxes: [{ p: 7, b: 12 }], hints: ['Смотрите плодоножки.'] });
  assert.ok(t.forecast.length >= 3 && t.forecast.every(p => !/[—·→]/.test(p)));
  assert.ok(t.risks.every(x => x.risk && x.why && x.avoid && x.check));
  assert.ok(t.risks.some(x => /Брак, найденный в пробе/.test(x.risk)));
  assert.match(t.dock[0], /паллета 7, ящик 12/);
  assert.ok(t.dock.includes('Смотрите плодоножки.'));
  assert.equal(Checks.transit(Core.defaultBatch(true), {}).risks.length, 5);
});

test('own batches show only what the supplier entered', () => {
  const b = Core.defaultBatch(false);
  Object.assign(b, { code: 'П-1', supplier: 'Хозяйство', chain: 'Сеть', rc: 'РЦ', weight: 5 });
  let s = Checks.sections(b, { files: {} });
  assert.deepEqual(s.map(x => x.done), [true, false, false, false, false]);
  assert.equal(s[2].items[0].value, 'Не измеряли');
  b.measurements = { temperature: 11.5, caliber: 60, mass: 6, firmness: 2.2, brix: 5, nitrates: 90 };
  b.documents = { declaration: true, quality: true, lab: false, shipment: true, labels: true }; b.packaging = true;
  s = Checks.sections(b, { files: { lab: 1 } });
  assert.deepEqual(s.map(x => x.done), [true, true, true, true, true]);
  assert.equal(s[2].items[0].value, '11,5 °C');
  assert.equal(s[4].summary, 'Документы 5 из 5, упаковка проверена');
});
