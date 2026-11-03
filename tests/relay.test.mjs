import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRelay, providerSchema, sanitize, validate } from '../relay/core.mjs';

const system = readFileSync('prompts/inspect-system.md', 'utf8');
const schema = JSON.parse(readFileSync('prompts/inspect-schema.json', 'utf8'));
const examples = system.split('\n').filter(l => l.startsWith('{"verdict"')).map(l => JSON.parse(l));
const good = examples.find(e => e.verdict === 'good');
const ORIGIN = 'http://localhost:8000';
const env = { PROVIDER: 'anthropic', MODEL: 'test-model', API_KEY: 'test-key', ALLOWED_ORIGINS: ORIGIN + ',https://ndable01.github.io' };
const body = { image: 'data:image/jpeg;base64,/9j/AAAA', spec: { product: 'томаты свежие, круглые, розовые', grade: 'первый', chain: 'Город', chain_rules: [], reference: null }, context: { expected_box: 'паллета 7, ящик 23', fruit: 29 } };
const quiet = { warn() {} };

function anthropicReply(result, extra = {}) {
  return new Response(JSON.stringify({ content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }], stop_reason: 'end_turn', ...extra }), { status: 200 });
}
function relay(replies, overrides = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init: { ...init, body: JSON.parse(init.body) } }); const r = replies.shift(); if (r instanceof Error) throw r; return typeof r === 'function' ? r(init) : r; };
  return { calls, handle: createRelay({ env: { ...env, ...overrides }, system, schema, fetchImpl, log: quiet }) };
}
function post(payload = body, origin = ORIGIN) {
  const headers = { 'content-type': 'application/json' };
  if (origin) headers.origin = origin;
  return new Request('http://relay/inspect', { method: 'POST', headers, body: JSON.stringify(payload) });
}

test('prompt examples satisfy the repository schema', () => {
  assert.equal(examples.length, 4);
  for (const e of examples) validate(e, schema);
});

test('anthropic request carries prompt, photo, spec and a provider-safe schema', async () => {
  const { calls, handle } = relay([anthropicReply(good)]);
  const res = await handle(post());
  const out = await res.json();
  assert.equal(res.status, 200);
  assert.equal(out.ok, true);
  assert.equal(out.model, 'test-model');
  assert.deepEqual(out.result, good);
  assert.ok(Number.isFinite(out.ms));
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  const sent = calls[0];
  assert.equal(sent.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(sent.init.headers['x-api-key'], 'test-key');
  assert.equal(sent.init.body.system, system);
  assert.equal(sent.init.body.model, 'test-model');
  assert.equal(sent.init.body.max_tokens, 800);
  assert.equal(sent.init.body.temperature, undefined);
  const [image, text] = sent.init.body.messages[0].content;
  assert.equal(image.source.data, '/9j/AAAA');
  assert.deepEqual(JSON.parse(text.text), { ...body.spec, expected_box: 'паллета 7, ящик 23', fruit: 29 });
  const sentSchema = JSON.stringify(sent.init.body.output_config.format.schema);
  for (const banned of ['maxLength', 'maxItems', 'minimum', 'maximum', '"type":["']) assert.ok(!sentSchema.includes(banned), banned);
});

test('optional knobs are sent only when configured', async () => {
  const { calls, handle } = relay([anthropicReply(good)], { EFFORT: 'low', TEMPERATURE: '0' });
  await handle(post());
  assert.equal(calls[0].init.body.output_config.effort, 'low');
  assert.equal(calls[0].init.body.temperature, 0);
});

test('long strings are truncated and long dashes replaced', async () => {
  const long = { ...good, title: 'Годен — без замечаний и без единого пятна на всей видимой стороне', explanation: 'x'.repeat(260) };
  const { handle } = relay([anthropicReply(long)]);
  const out = await (await handle(post())).json();
  assert.equal(out.ok, true);
  assert.ok(!out.result.title.includes('—'));
  assert.ok([...out.result.title].length <= 40);
  assert.equal(out.result.explanation.length, 200);
});

test('invalid JSON is retried once, then reported', async () => {
  let r = relay([anthropicReply('not json'), anthropicReply(good)]);
  let out = await (await r.handle(post())).json();
  assert.equal(out.ok, true);
  assert.equal(r.calls.length, 2);
  r = relay([anthropicReply('not json'), anthropicReply({ ...good, verdict: 'great' })]);
  const res = await r.handle(post());
  out = await res.json();
  assert.equal(res.status, 502);
  assert.equal(out.ok, false);
  assert.equal(r.calls.length, 2);
});

test('checks must list all 8 criteria in order for counted verdicts', async () => {
  const shuffled = { ...good, checks: good.checks.slice().reverse() };
  const { handle } = relay([anthropicReply(shuffled), anthropicReply(shuffled)]);
  const out = await (await handle(post())).json();
  assert.equal(out.ok, false);
});

test('refusal and truncated answers are errors without a retry', async () => {
  let r = relay([anthropicReply(good, { stop_reason: 'refusal' })]);
  assert.equal((await (await r.handle(post())).json()).ok, false);
  r = relay([anthropicReply('{"verdict":', { stop_reason: 'max_tokens' })]);
  const out = await (await r.handle(post())).json();
  assert.match(out.error, /MAX_TOKENS/);
  assert.equal(r.calls.length, 1);
});

test('provider timeout becomes a timeout error', async () => {
  const hang = init => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  const { handle } = relay([hang], { MODEL_TIMEOUT_MS: '30' });
  const res = await handle(post());
  assert.equal(res.status, 504);
  assert.equal((await res.json()).error, 'timeout');
});

test('provider HTTP errors do not leak details to the page', async () => {
  const { handle } = relay([new Response(JSON.stringify({ error: { message: 'invalid x-api-key test-key' } }), { status: 401 })]);
  const out = await (await handle(post())).json();
  assert.equal(out.ok, false);
  assert.ok(!JSON.stringify(out).includes('test-key'));
});

test('unknown origins, bad input and missing configuration are refused', async () => {
  const { calls, handle } = relay([]);
  assert.equal((await handle(post(body, 'https://evil.example'))).status, 403);
  assert.equal((await handle(post(body, null))).status, 403);
  assert.equal((await handle(post({ ...body, image: 'data:image/png;base64,AAAA' }))).status, 400);
  assert.equal((await handle(post({ ...body, spec: { ...body.spec, grade: 'экстра' } }))).status, 400);
  assert.equal((await handle(post({ ...body, context: { expected_box: 'x', fruit: 0 } }))).status, 400);
  assert.equal(calls.length, 0);
  for (const missing of ['PROVIDER', 'MODEL', 'API_KEY']) {
    const r = relay([], { [missing]: '' });
    const res = await r.handle(post());
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, 'not_configured');
    const health = await r.handle(new Request('http://relay/health', { headers: { origin: ORIGIN } }));
    assert.equal(health.status, 503);
  }
});

test('preflight and health', async () => {
  const { handle } = relay([]);
  const pre = await handle(new Request('http://relay/inspect', { method: 'OPTIONS', headers: { origin: ORIGIN } }));
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('access-control-allow-headers'), /Content-Type/);
  const health = await handle(new Request('http://relay/health', { headers: { origin: ORIGIN } }));
  assert.deepEqual(await health.json(), { ok: true, model: 'test-model' });
});

test('per-IP and daily limits', async () => {
  const replies = Array.from({ length: 10 }, () => anthropicReply(good));
  const { handle } = relay(replies, { RATE_PER_MIN: '2', DAILY_LIMIT: '3' });
  assert.equal((await handle(post(), { ip: 'a' })).status, 200);
  assert.equal((await handle(post(), { ip: 'a' })).status, 200);
  assert.equal((await handle(post(), { ip: 'a' })).status, 429);
  assert.equal((await handle(post(), { ip: 'b' })).status, 200);
  assert.equal((await handle(post(), { ip: 'c' })).status, 429);
});

test('openai and gemini adapters build their own request shapes', async () => {
  let r = relay([new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(good) }, finish_reason: 'stop' }] }))], { PROVIDER: 'openai' });
  assert.equal((await (await r.handle(post())).json()).ok, true);
  assert.equal(r.calls[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(r.calls[0].init.headers.authorization, 'Bearer test-key');
  assert.equal(r.calls[0].init.body.response_format.json_schema.strict, true);
  r = relay([new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(good) }] }, finishReason: 'STOP' }] }))], { PROVIDER: 'gemini', API_BASE: 'https://proxy.example/v1beta/' });
  assert.equal((await (await r.handle(post())).json()).ok, true);
  assert.equal(r.calls[0].url, 'https://proxy.example/v1beta/models/test-model:generateContent');
  assert.equal(r.calls[0].init.body.contents[0].parts[1].inlineData.data, '/9j/AAAA');
});

test('schema helpers keep enums and nullability', () => {
  const s = providerSchema(schema);
  assert.deepEqual(s.properties.ripeness.anyOf[1], { type: 'null' });
  assert.ok(!s.properties.ripeness.anyOf[0].enum.includes(null));
  const a = providerSchema(schema, { nullableAs: 'array' });
  assert.deepEqual(a.properties.note.type, ['string', 'null']);
  assert.equal(sanitize('a—b', { maxLength: 2 }), 'a-');
});
