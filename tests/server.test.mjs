import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createServer } = require('../server/relay.js');

async function withServer(fn) {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try { await fn(base); } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('publish, poll since a cursor and receive over SSE like ntfy', () => withServer(async base => {
  const first = await (await fetch(base + '/apron-test1', { method: 'POST', body: JSON.stringify({ t: 'reset' }) })).json();
  assert.equal(first.message, '{"t":"reset"}');
  const ctrl = new AbortController();
  const sse = await fetch(base + '/apron-test1/sse?since=' + first.id, { signal: ctrl.signal });
  assert.equal(sse.headers.get('access-control-allow-origin'), '*');
  const reader = sse.body.getReader();
  await fetch(base + '/apron-test1', { method: 'POST', body: 'second' });
  let text = '';
  while (!text.includes('second')) text += new TextDecoder().decode((await reader.read()).value);
  assert.ok(text.startsWith('event: open'));
  assert.ok(!text.includes('reset'), 'history before the cursor is not replayed');
  ctrl.abort();
  const all = (await (await fetch(base + '/apron-test1/json?poll=1&since=all')).text()).trim().split('\n').map(JSON.parse);
  assert.deepEqual(all.map(m => m.message), ['{"t":"reset"}', 'second']);
  const after = (await (await fetch(base + '/apron-test1/json?poll=1&since=' + first.id)).text()).trim().split('\n').map(JSON.parse);
  assert.deepEqual(after.map(m => m.message), ['second']);
  const recent = (await (await fetch(base + '/apron-test1/json?poll=1&since=2h')).text()).trim().split('\n');
  assert.equal(recent.length, 2);
}));

test('photo attachments get a link on the same server', () => withServer(async base => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
  const sent = await (await fetch(base + '/apron-test2?filename=apron-plod-29.jpg', { method: 'PUT', body: jpeg, headers: { origin: 'http://192.168.1.5:8080' } })).json();
  assert.match(sent.attachment.url, /^http:\/\/127\.0\.0\.1:\d+\/file\/[\w-]+\.jpg$/);
  const file = await fetch(sent.attachment.url);
  assert.equal(file.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), jpeg);
}));

test('only the app is served: relay secrets and dotfiles stay private', () => withServer(async base => {
  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>Apron<\/title>/);
  assert.equal((await fetch(base + '/assets/room.js')).status, 200);
  for (const path of ['/relay/.env.example', '/relay/core.mjs', '/.git/config', '/assets/../relay/core.mjs', '/%2e%2e/etc/passwd', '/eval/run.mjs']) assert.equal((await fetch(base + path)).status, 404, path);
  const pre = await fetch(base + '/apron-test3', { method: 'OPTIONS' });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('access-control-allow-methods'), /PUT/);
}));
