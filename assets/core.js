(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ApronCore = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  // Demo assumptions, not a verified specification of a retail chain.
  var CONFIG = {
    sampleTotal: 30,
    seed: { checked: 28, defects: 1, offSpec: 0, defectBoxes: [{ p: 7, b: 12 }] },
    tolerance: { defect: 10, offspec: 10 },
    risk: { low: 15, high: 25 },
    boxes: [{ p: 7, b: 23 }, { p: 3, b: 11 }, { p: 12, b: 5 }],
    money: { revenue: 1200000, foundPercent: 15 },
    trip: { departure: 'сегодня в 18:00', arrival: 'завтра в 06:00', distance: 900 },
    slot: { ramp: 4, time: 'завтра в 06:00' },
    spec: { product: 'томаты свежие, круглые, розовые', grade: 'первый', chain: 'Город', chain_rules: [], reference: null },
    // Set only after the separately hosted relay is connected. Never put an API key here.
    analyzeUrl: '', analyzeTimeoutMs: 10000, minConfidence: 0.7,
    modelCard: { model: null, checked: null, agreed: null, p90: null }
  };
  var VERDICTS = ['good', 'offspec', 'defect'];
  var CRITERIA = ['целостность', 'гниль и плесень', 'повреждения', 'свежесть', 'форма', 'окраска и зрелость', 'чистота', 'калибр'];
  var FINDINGS = ['открытая трещина', 'зажившая трещина', 'порез или прокол', 'гниль', 'вершинная гниль', 'плесень', 'вмятина', 'перезревание', 'увядание', 'подмораживание', 'солнечный ожог', 'вредители', 'зелёная спинка', 'незрелость', 'неоднородная окраска', 'деформация', 'пробковое образование', 'шрам', 'загрязнение', 'другое'];
  var cache = new Map();
  function logGamma(z) {
    var c = [676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406, 12.507343278686905, -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7];
    if (z < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z);
    z -= 1;
    var x = 0.9999999999998099;
    c.forEach(function (v, i) { x += v / (z + i + 1); });
    var t = z + 7.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
  }
  function betaFraction(a, b, x) {
    var tiny = 1e-300, c = 1, d = 1 - (a + b) * x / (a + 1);
    if (Math.abs(d) < tiny) d = tiny;
    d = 1 / d;
    var h = d;
    for (var m = 1; m <= 250; m++) {
      var aa = m * (b - m) * x / ((a + 2 * m - 1) * (a + 2 * m));
      d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny;
      c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny;
      d = 1 / d; h *= d * c;
      aa = -(a + m) * (a + b + m) * x / ((a + 2 * m) * (a + 2 * m + 1));
      d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny;
      c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny;
      d = 1 / d;
      var delta = d * c; h *= delta;
      if (Math.abs(delta - 1) < 3e-14) return h;
    }
    throw new Error('Не удалось рассчитать риск');
  }
  function betaCDF(x, a, b) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    var bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log1p(-x));
    return x < (a + 1) / (a + b + 2) ? bt * betaFraction(a, b, x) / a : 1 - bt * betaFraction(b, a, 1 - x) / b;
  }
  function risk(k, n, tolerance) {
    if (!Number.isInteger(k) || !Number.isInteger(n) || k < 0 || n < k || !Number.isFinite(tolerance) || tolerance < 0 || tolerance > 100) throw new Error('Неверная проба');
    var key = [k, n, tolerance].join(':');
    if (!cache.has(key)) {
      if (cache.size > 5000) cache.clear();
      // Survival function by symmetry avoids cancellation for very small risks.
      cache.set(key, Math.max(0, Math.min(1, betaCDF(1 - tolerance / 100, n - k + 0.5, k + 0.5))));
    }
    return cache.get(key);
  }
  function wilson(k, n) {
    if (!n) return [0, 1];
    var z = 1.959963984540054, p = k / n, den = 1 + z * z / n;
    var mid = (p + z * z / (2 * n)) / den;
    var half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den;
    return [Math.max(0, mid - half), Math.min(1, mid + half)];
  }
  function defaultBatch(example) {
    return {
      id: 'batch-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8), example: !!example,
      code: example ? '0611-07' : '', product: 'Томаты розовые', supplier: example ? 'Южная гряда' : '', chain: example ? 'Город' : '', rc: example ? 'РЦ Север' : '',
      weight: example ? 10 : null, sampleTotal: 30, tolerance: { defect: 10, offspec: 10 }, pallets: example ? 20 : 1, boxesPerPallet: example ? 84 : 1,
      revenue: example ? 1200000 : null, departure: example ? CONFIG.trip.departure : '', arrival: example ? CONFIG.trip.arrival : '', distance: example ? 900 : null,
      ramp: example ? '4' : '', slotTime: example ? CONFIG.slot.time : '', grade: 'первый', rules: '',
      measurements: { temperature: example ? 12.4 : null, caliber: example ? 62 : null, mass: example ? 6.04 : null, firmness: example ? 2.4 : null, brix: example ? 5.4 : null, nitrates: example ? 112 : null },
      documents: { declaration: false, quality: false, lab: false, shipment: false, labels: false }, packaging: false
    };
  }
  function validateBatch(b) {
    function text(k, max, required) { if (typeof b[k] !== 'string' || b[k].length > max || (required && !b[k].trim())) throw new Error('Проверьте данные партии'); }
    function num(v, min, max, integer, nullable) { if (nullable && v === null) return; if (!Number.isFinite(v) || v < min || v > max || (integer && !Number.isInteger(v))) throw new Error('Проверьте числовые значения'); }
    if (!b || typeof b !== 'object' || Array.isArray(b) || typeof b.example !== 'boolean' || typeof b.id !== 'string' || !/^batch-[a-z0-9-]+$/.test(b.id) || b.id.length > 100) throw new Error('Не удалось прочитать партию');
    ['code', 'product', 'supplier', 'chain', 'rc'].forEach(function (k) { text(k, 100, true); });
    ['departure', 'arrival', 'ramp', 'slotTime'].forEach(function (k) { text(k, 100, false); }); text('rules', 1500, false);
    if (['высший', 'первый', 'второй'].indexOf(b.grade) < 0) throw new Error('Выберите товарный сорт');
    num(b.weight, 0.001, 100000, false, false); num(b.sampleTotal, 1, 2000, true, false); num(b.pallets, 1, 1000, true, false); num(b.boxesPerPallet, 1, 10000, true, false);
    if (!b.tolerance) throw new Error('Укажите допуски');
    num(b.tolerance.defect, 0, 100, false, false); num(b.tolerance.offspec, 0, 100, false, false);
    num(b.revenue, 0, 1e12, false, true); num(b.distance, 0, 100000, true, true);
    if (!b.measurements || !b.documents || typeof b.packaging !== 'boolean') throw new Error('Проверьте замеры и документы');
    ['temperature', 'caliber', 'mass', 'firmness', 'brix', 'nitrates'].forEach(function (k) { num(b.measurements[k], k === 'temperature' ? -100 : 0, 1000000, false, true); });
    ['declaration', 'quality', 'lab', 'shipment', 'labels'].forEach(function (k) { if (typeof b.documents[k] !== 'boolean') throw new Error('Проверьте документы'); });
    return b;
  }
  function baseState(example) {
    if (example === undefined) example = true;
    return { version: 3, batch: defaultBatch(example), seed: example ? JSON.parse(JSON.stringify(CONFIG.seed)) : { checked: 0, defects: 0, offSpec: 0, defectBoxes: [] }, goal: CONFIG.sampleTotal, fruits: [], pending: null, decision: null, events: [], role: 'supplier' };
  }
  function updateBatch(s, batch) {
    validateBatch(batch);
    if (batch.id !== s.batch.id) throw new Error('Это другая партия');
    if (batch.sampleTotal < stats(s).checked) throw new Error('Размер пробы не может быть меньше числа уже проверенных плодов');
    var specChanged = ['product', 'chain', 'grade', 'rules'].some(function (k) { return batch[k] !== s.batch[k]; });
    if (specChanged) s.fruits.forEach(function (f) { if (f.source === 'model') f.needsReview = true; });
    if (s.pending) { s.pending.result = null; s.pending.reason = null; }
    s.batch = JSON.parse(JSON.stringify(batch)); s.goal = batch.sampleTotal; s.decision = null;
  }
  function resetSample(s) {
    s.seed = { checked: 0, defects: 0, offSpec: 0, defectBoxes: [] }; s.fruits = []; s.pending = null; s.decision = null; s.events = []; s.goal = s.batch.sampleTotal; s.role = 'supplier';
    return s;
  }
  function stats(s) {
    var n = s.seed.checked + s.fruits.length;
    var defects = s.seed.defects + s.fruits.filter(function (f) { return f.verdict === 'defect'; }).length;
    var offSpec = s.seed.offSpec + s.fruits.filter(function (f) { return f.verdict === 'offspec'; }).length;
    var dr = risk(defects, n, s.batch.tolerance.defect), or = risk(offSpec, n, s.batch.tolerance.offspec);
    var r = Math.max(dr, or), category = n && or > dr ? 'offspec' : 'defect';
    var needsReview = s.fruits.some(function (f) { return !!f.needsReview; });
    return { checked: n, defects: defects, offSpec: offSpec, defectRisk: dr, offspecRisk: or, risk: n && !needsReview ? r : null, category: category, level: !n ? 'empty' : needsReview ? 'review' : r * 100 < CONFIG.risk.low ? 'low' : r * 100 < CONFIG.risk.high ? 'medium' : 'high', done: n >= s.goal, needsReview: needsReview };
  }
  function extraNeeded(s) {
    var st = stats(s);
    if (!st.checked) return s.goal;
    for (var extra = 0; extra <= 1000; extra++) {
      if (Math.max(risk(st.defects, st.checked + extra, s.batch.tolerance.defect), risk(st.offSpec, st.checked + extra, s.batch.tolerance.offspec)) * 100 < CONFIG.risk.low) return extra;
    }
    return null;
  }
  function addFruit(s, fruit) {
    if (VERDICTS.indexOf(fruit.verdict) < 0 || typeof fruit.id !== 'string') throw new Error('Неверный результат');
    if (s.fruits.some(function (f) { return f.id === fruit.id; })) return false;
    s.fruits.push(fruit); s.pending = null; s.decision = null;
    return true;
  }
  function correctFruit(s, id, verdict) {
    var fruit = s.fruits.find(function (f) { return f.id === id; });
    if (!fruit || VERDICTS.indexOf(verdict) < 0) throw new Error('Неверное исправление');
    fruit.verdict = verdict; fruit.source = fruit.source === 'test' ? 'test' : 'manual'; fruit.corrected = true; fruit.needsReview = false; fruit.updatedAt = Date.now();
    s.decision = null;
    return fruit;
  }
  function allowedDecisions(s) {
    var st = stats(s);
    if (!st.checked || st.needsReview) return [];
    if (!st.done && (st.level !== 'high' || st.defects + st.offSpec === 0)) return [];
    return st.level === 'low' ? ['wait'] : ['resort', 'wait_strict'];
  }
  function isBox(x) { return !!x && Number.isInteger(x.p) && x.p > 0 && x.p <= 1000 && Number.isInteger(x.b) && x.b > 0 && x.b <= 10000; }
  function isPhoto(x) { return typeof x === 'string' && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(x) && x.length < 1600000; }
  function validateResult(r) {
    var fail = function () { throw new Error('Некорректный ответ модели'); };
    var object = function (v) { return v && typeof v === 'object' && !Array.isArray(v); };
    var string = function (v, max) { return typeof v === 'string' && v.length <= max; };
    var nullable = function (v, max) { return v === null || string(v, max); };
    var keys = ['verdict', 'confidence', 'title', 'explanation', 'checks', 'findings', 'not_visible', 'ripeness', 'photo_issue', 'retake_hint', 'label_text', 'rc_hint', 'note'];
    if (!object(r) || keys.some(function (k) { return !Object.prototype.hasOwnProperty.call(r, k); }) || Object.keys(r).some(function (k) { return keys.indexOf(k) < 0; })) fail();
    if (VERDICTS.concat(['bad_photo', 'not_tomato']).indexOf(r.verdict) < 0 || !Number.isFinite(r.confidence) || r.confidence < 0 || r.confidence > 1 || !string(r.title, 40) || !r.title.trim() || !string(r.explanation, 200)) fail();
    if (!Array.isArray(r.checks) || r.checks.length !== (VERDICTS.indexOf(r.verdict) >= 0 ? 8 : 0)) fail();
    r.checks.forEach(function (c, i) {
      if (!object(c) || Object.keys(c).length !== 3 || c.criterion !== CRITERIA[i] || ['ok', 'fail', 'warn', 'not_visible'].indexOf(c.status) < 0 || !string(c.note, 80)) fail();
    });
    if (!Array.isArray(r.findings) || r.findings.length > 6) fail();
    r.findings.forEach(function (f) {
      if (!object(f) || Object.keys(f).length !== 5 || FINDINGS.indexOf(f.type) < 0 || ['у плодоножки', 'на боку', 'на вершине', 'по всему плоду', 'не определить'].indexOf(f.location) < 0 || !string(f.size, 60) || ['незначительный', 'заметный', 'сильный'].indexOf(f.severity) < 0 || ['defect', 'offspec', 'none'].indexOf(f.counts_as) < 0) fail();
    });
    if (!Array.isArray(r.not_visible) || r.not_visible.length > 6 || r.not_visible.some(function (v) { return !string(v, 40); }) || [null, 'незрелый', 'частично окрашен', 'зрелый', 'перезрелый'].indexOf(r.ripeness) < 0 || [null, 'размыто', 'темно', 'пересвет', 'плод обрезан', 'плод закрыт', 'несколько плодов', 'снимок экрана'].indexOf(r.photo_issue) < 0 || !nullable(r.retake_hint, 80) || !nullable(r.label_text, 60) || !nullable(r.rc_hint, 120) || !nullable(r.note, 120)) fail();
    return r;
  }
  function restore(raw) {
    var s = JSON.parse(raw);
    if (s && s.version === 2) { s.version = 3; s.batch = defaultBatch(true); s.seed = JSON.parse(JSON.stringify(CONFIG.seed)); s.batch.sampleTotal = s.goal; }
    if (!s || s.version !== 3 || !Array.isArray(s.fruits) || s.fruits.length > 2000 || !Number.isInteger(s.goal) || s.goal < 1 || s.goal > 2000) throw new Error('Неверная сохранённая проба');
    validateBatch(s.batch);
    if (!s.seed || !Number.isInteger(s.seed.checked) || !Number.isInteger(s.seed.defects) || !Number.isInteger(s.seed.offSpec) || s.seed.checked < 0 || s.seed.checked > 1000 || s.seed.defects < 0 || s.seed.offSpec < 0 || s.seed.defects + s.seed.offSpec > s.seed.checked || !Array.isArray(s.seed.defectBoxes) || !s.seed.defectBoxes.every(isBox)) throw new Error('Неверные исходные данные');
    if (s.seed.checked + s.fruits.length > 2000) throw new Error('Слишком большая проба');
    var seen = new Set();
    s.fruits.forEach(function (f, i) {
      if (!f || typeof f.id !== 'string' || seen.has(f.id) || f.n !== s.seed.checked + i + 1 || VERDICTS.indexOf(f.verdict) < 0 || ['model', 'manual', 'test'].indexOf(f.source) < 0 || !isBox(f.box) || !Number.isFinite(f.ts) || (f.photo !== null && !isPhoto(f.photo))) throw new Error('Неверный плод');
      if (f.source === 'model' && (!f.result || !Number.isFinite(f.ms) || f.ms < 0)) throw new Error('Неверный источник результата');
      if (f.result !== null) validateResult(f.result);
      seen.add(f.id);
    });
    if (s.pending && (typeof s.pending.id !== 'string' || seen.has(s.pending.id) || s.pending.n !== s.seed.checked + s.fruits.length + 1 || !isBox(s.pending.box) || !Number.isFinite(s.pending.ts) || (s.pending.photo !== null && !isPhoto(s.pending.photo)))) throw new Error('Неверный снимок');
    if (s.pending && s.pending.result) validateResult(s.pending.result);
    if (!Array.isArray(s.events)) s.events = [];
    s.events = s.events.filter(function (e) { return e && typeof e.text === 'string' && e.text.length < 400 && Number.isFinite(e.ts); }).slice(-30);
    if (s.decision && (allowedDecisions(s).indexOf(s.decision.kind) < 0 || !Number.isFinite(s.decision.ts))) s.decision = null;
    s.role = s.role === 'rc' ? 'rc' : 'supplier';
    return s;
  }
  function selftest() {
    var cases = [[0, 30, 1], [1, 28, 12], [1, 29, 11], [1, 30, 10], [2, 29, 31], [2, 30, 29]];
    var lines = cases.map(function (x) { var got = Math.round(risk(x[0], x[1], 10) * 100); if (got !== x[2]) throw new Error('Риск ' + x[0] + '/' + x[1]); return x[0] + ' из ' + x[1] + ': ' + got + ' %'; });
    var s = baseState(); addFruit(s, { id: 'a', verdict: 'good' }); addFruit(s, { id: 'b', verdict: 'defect' });
    if (extraNeeded(s) !== 10) throw new Error('Дополнительная проба');
    var interval = wilson(2, 30);
    if (Math.abs(interval[0] * 100 - 1.8477) > 0.001 || Math.abs(interval[1] * 100 - 21.3235) > 0.001) throw new Error('Интервал Уилсона');
    return lines.concat(['После 2 из 30: ещё 10 годных плодов', 'Интервал Уилсона: 1,8-21,3 %']);
  }
  return { CONFIG: CONFIG, VERDICTS: VERDICTS, risk: risk, wilson: wilson, defaultBatch: defaultBatch, validateBatch: validateBatch, updateBatch: updateBatch, resetSample: resetSample, baseState: baseState, stats: stats, extraNeeded: extraNeeded, addFruit: addFruit, correctFruit: correctFruit, allowedDecisions: allowedDecisions, validateResult: validateResult, restore: restore, selftest: selftest };
});
