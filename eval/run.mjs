#!/usr/bin/env node
// Runs labelled photos through the relay and prints how often the model agrees with us and how fast it answers.
// Node 18+, no dependencies. Usage: see DEMO.md, "Проверка модели на своих фото".
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';

const VERDICTS = ['good', 'offspec', 'defect', 'bad_photo', 'not_tomato'];
const NAMES = { good: 'годен', offspec: 'не по критериям', defect: 'брак', bad_photo: 'плохой кадр', not_tomato: 'не томат', error: 'ошибка' };

function args(argv) {
  const out = { manifest: 'eval/manifest.json', origin: 'http://localhost:8000', repeat: 1, pause: 2100, only: '', relay: process.env.RELAY_URL || '' };
  for (let i = 0; i < argv.length; i++) {
    const [k, inline] = argv[i].replace(/^--/, '').split('=');
    const v = inline !== undefined ? inline : argv[++i];
    if (!(k in out)) throw new Error('Неизвестный параметр --' + k);
    out[k] = ['repeat', 'pause'].includes(k) ? Number(v) : v;
  }
  if (!out.relay) throw new Error('Укажите адрес relay: --relay https://.../inspect или RELAY_URL');
  if (!Number.isInteger(out.repeat) || out.repeat < 1 || !Number.isFinite(out.pause) || out.pause < 0) throw new Error('--repeat и --pause должны быть положительными числами');
  return out;
}

function loadManifest(path) {
  const m = JSON.parse(readFileSync(path, 'utf8'));
  const base = dirname(resolve(path));
  const spec = { product: 'томаты свежие, круглые, розовые', grade: 'первый', chain: 'Город', chain_rules: [], reference: null, ...(m.spec || {}) };
  if (!Array.isArray(m.items) || !m.items.length) throw new Error('В манифесте нет items');
  const items = m.items.map((it, i) => {
    if (!it || typeof it.file !== 'string' || !VERDICTS.includes(it.verdict)) throw new Error('items[' + i + ']: нужны file и verdict из ' + VERDICTS.join(', '));
    return { file: it.file, path: join(base, it.file), verdict: it.verdict, box: typeof it.box === 'string' ? it.box : 'паллета 7, ящик 23' };
  });
  return { spec, items };
}

function photo(path) {
  if (!existsSync(path)) throw new Error('нет файла');
  const buf = readFileSync(path);
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('не JPEG');
  if (buf.length > 1_400_000) throw new Error('больше 1,4 МБ: сохраните с длинной стороной 1024 px');
  return 'data:image/jpeg;base64,' + buf.toString('base64');
}

function sec(ms) { return (ms / 1000).toFixed(1).replace('.', ','); }

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

async function inspect(opts, spec, item, fruit) {
  let image;
  try { image = photo(item.path); } catch (e) { return { got: 'skipped', ms: 0, error: e.message }; }
  const started = performance.now();
  try {
    const res = await fetch(opts.relay, { method: 'POST', headers: { 'content-type': 'application/json', origin: opts.origin }, body: JSON.stringify({ image, spec, context: { expected_box: item.box, fruit } }), signal: AbortSignal.timeout(15000) });
    const body = await res.json().catch(() => null);
    const ms = Math.round(performance.now() - started);
    if (!body || body.ok !== true) return { got: 'error', ms, error: body && body.error || 'HTTP ' + res.status };
    return { got: body.result.verdict, ms, model: body.model, confidence: body.result.confidence, title: body.result.title };
  } catch (e) {
    return { got: 'error', ms: Math.round(performance.now() - started), error: e.message };
  }
}

async function main() {
  const opts = args(process.argv.slice(2));
  const { spec, items } = loadManifest(opts.manifest);
  const runs = [], skipped = [];
  const chosen = items.filter(it => !opts.only || it.file.includes(opts.only));
  if (!chosen.length) throw new Error('Нет фото под --only ' + opts.only);
  let n = 0;
  for (let r = 0; r < opts.repeat; r++) {
    for (const item of chosen) {
      if (n++ && opts.pause) await new Promise(res => setTimeout(res, opts.pause));
      const out = await inspect(opts, spec, item, n);
      if (out.got === 'skipped') { skipped.push(item.file + ': ' + out.error); console.log(String(n).padStart(3) + '  пропущено   ' + item.file + '  ' + out.error); continue; }
      runs.push({ file: item.file, want: item.verdict, ...out });
      const mark = out.got === item.verdict ? 'совпало' : 'НЕ совпало';
      console.log([String(n).padStart(3), mark.padEnd(10), item.file, NAMES[item.verdict] + ' -> ' + NAMES[out.got], sec(out.ms) + ' с', out.confidence !== undefined ? 'уверенность ' + Math.round(out.confidence * 100) + ' %' : out.error].join('  '));
    }
  }

  if (!runs.length) throw new Error('Ни одно фото не отправлено. ' + skipped.join('; '));
  const model = runs.map(r => r.model).find(Boolean) || 'неизвестна';
  const agreed = runs.filter(r => r.got === r.want).length;
  const answered = runs.filter(r => r.got !== 'error');
  const times = answered.map(r => r.ms);
  const mean = times.length ? times.reduce((a, b) => a + b, 0) / times.length : null;
  const p90 = percentile(times, 0.9);
  console.log('\nМодель: ' + model);
  console.log('Совпало: ' + agreed + ' из ' + runs.length + (runs.length - answered.length ? '. Без ответа (считаются несовпадением): ' + (runs.length - answered.length) : ''));
  if (skipped.length) console.log('Пропущено, не считается: ' + skipped.length + '. Исправьте файлы: ' + Array.from(new Set(skipped)).join('; '));
  console.log('Несовпадения (правильный -> ответ модели):');
  const misses = {};
  for (const r of runs) if (r.got !== r.want) { const key = NAMES[r.want] + ' -> ' + NAMES[r.got]; misses[key] = (misses[key] || 0) + 1; }
  if (!Object.keys(misses).length) console.log('  нет');
  for (const [k, v] of Object.entries(misses).sort((a, b) => b[1] - a[1])) console.log('  ' + k + ': ' + v);
  console.log('По классам:');
  for (const v of VERDICTS) {
    const want = runs.filter(r => r.want === v);
    if (want.length) console.log('  ' + NAMES[v] + ': совпало ' + want.filter(r => r.got === v).length + ' из ' + want.length);
  }
  if (mean !== null) {
    console.log('Среднее время ответа: ' + sec(mean) + ' с. 9 ответов из 10 быстрее ' + sec(p90) + ' с');
    console.log('\nДля CONFIG.modelCard в assets/core.js:');
    console.log(JSON.stringify({ model, checked: runs.length, agreed, p90: Math.round(p90 / 100) / 10 }));
  }
  mkdirSync('eval/results', { recursive: true });
  const file = 'eval/results/' + model.replace(/[^\w.-]+/g, '_') + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
  writeFileSync(file, JSON.stringify({ model, relay: opts.relay, spec, repeat: opts.repeat, agreed, total: runs.length, meanMs: mean, p90Ms: p90, skipped, runs }, null, 2));
  console.log('Подробности: ' + file);
}

main().catch(e => { console.error(e.message); process.exit(1); });
