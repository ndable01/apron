#!/usr/bin/env node
'use strict';
// Offline mode for the stage: serves the site and the part of the ntfy protocol Apron uses, in memory.
// Node 18+, no dependencies. Run: node server/relay.js --port 8080   (laptop and team phones on one Wi-Fi)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const TOPIC_RE = /^[-_A-Za-z0-9]{1,64}$/;
const MAX_MESSAGES = 500, MAX_MESSAGE_BYTES = 4096, MAX_FILE_BYTES = 3 * 1024 * 1024, MAX_FILES_BYTES = 200 * 1024 * 1024;
const MESSAGE_TTL = 12 * 3600, FILE_TTL = 3 * 3600;
// Only the app's own folders are served. Relay secrets (relay/.env), git data and eval results stay private.
const PUBLIC = ['index.html', 'sw.js', 'assets/', 'fonts/', 'qr/', 'vendor/', 'seed/', 'prompts/'];
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };

function args(argv) {
  const out = { port: 8080, host: '0.0.0.0', room: 'apron-local' };
  for (let i = 0; i < argv.length; i++) {
    const [k, inline] = argv[i].replace(/^--/, '').split('=');
    const v = inline !== undefined ? inline : argv[++i];
    if (!(k in out)) throw new Error('Неизвестный параметр --' + k);
    out[k] = k === 'port' ? Number(v) : v;
  }
  if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535) throw new Error('--port: число от 1 до 65535');
  if (!TOPIC_RE.test(out.room)) throw new Error('--room: латинские буквы, цифры, - и _');
  return out;
}

function createServer() {
  const topics = new Map();
  const files = new Map();
  let filesBytes = 0;
  const now = () => Math.floor(Date.now() / 1000);
  const id = () => crypto.randomBytes(9).toString('base64url').slice(0, 12);
  function topic(name) {
    if (!topics.has(name)) topics.set(name, { messages: [], clients: new Set() });
    return topics.get(name);
  }
  function cleanup() {
    const t = now();
    for (const [key, f] of files) if (f.expires < t) { files.delete(key); filesBytes -= f.data.length; }
    for (const room of topics.values()) room.messages = room.messages.filter(m => m.expires >= t);
  }
  function since(room, value) {
    const list = room.messages;
    if (!value || value === 'all') return list;
    const dur = /^(\d+)([smhd])$/.exec(value);
    if (dur) { const from = now() - Number(dur[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[dur[2]]; return list.filter(m => m.time >= from); }
    if (/^\d{9,11}$/.test(value)) return list.filter(m => m.time >= Number(value));
    const i = list.findIndex(m => m.id === value);
    // Unknown id (for example after a restart): send everything so the device can catch up.
    return i < 0 ? list : list.slice(i + 1);
  }
  function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
  }
  function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }
  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0;
      req.on('data', c => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }
  function broadcast(room, message) {
    const line = 'data: ' + JSON.stringify(message) + '\n\n';
    for (const client of room.clients) client.write(line);
  }
  async function publish(req, res, name, url) {
    const room = topic(name), filename = url.searchParams.get('filename');
    const body = await readBody(req, filename ? MAX_FILE_BYTES : MAX_FILE_BYTES);
    const message = { id: id(), time: now(), expires: now() + MESSAGE_TTL, event: 'message', topic: name };
    if (filename || body.length > MAX_MESSAGE_BYTES) {
      // Same shape as ntfy: the body becomes an attachment and the message carries its link.
      cleanup();
      if (filesBytes + body.length > MAX_FILES_BYTES) return json(res, 507, { error: 'storage full' });
      const ext = /\.png$/i.test(filename || '') ? '.png' : '.jpg', key = message.id + ext;
      const type = ext === '.png' ? 'image/png' : 'image/jpeg';
      files.set(key, { data: body, type, expires: now() + FILE_TTL }); filesBytes += body.length;
      message.message = 'You received a file: ' + (filename || key);
      message.attachment = { name: filename || key, type, size: body.length, expires: now() + FILE_TTL, url: 'http://' + req.headers.host + '/file/' + key };
    } else message.message = body.toString('utf8');
    room.messages.push(message);
    if (room.messages.length > MAX_MESSAGES) room.messages.splice(0, room.messages.length - MAX_MESSAGES);
    broadcast(room, message);
    json(res, 200, message);
  }
  function stream(req, res, name, url) {
    const room = topic(name);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('event: open\ndata: ' + JSON.stringify({ id: id(), time: now(), event: 'open', topic: name }) + '\n\n');
    for (const m of since(room, url.searchParams.get('since'))) res.write('data: ' + JSON.stringify(m) + '\n\n');
    room.clients.add(res);
    const keepalive = setInterval(() => res.write('event: keepalive\ndata: ' + JSON.stringify({ id: id(), time: now(), event: 'keepalive', topic: name }) + '\n\n'), 25000);
    req.on('close', () => { clearInterval(keepalive); room.clients.delete(res); });
  }
  function poll(res, name, url) {
    const lines = since(topic(name), url.searchParams.get('since')).map(m => JSON.stringify(m)).join('\n');
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(lines ? lines + '\n' : '');
  }
  function serveFile(res, key) {
    const f = files.get(key);
    if (!f || f.expires < now()) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': f.type, 'Content-Length': f.data.length, 'Cache-Control': 'public, max-age=3600' });
    res.end(f.data);
  }
  function serveStatic(res, pathname) {
    let rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(ROOT, rel);
    const inside = file.startsWith(ROOT + path.sep) && !rel.split('/').some(part => part.startsWith('.'));
    if (!inside || !PUBLIC.some(p => p.endsWith('/') ? rel.startsWith(p) : rel === p)) return json(res, 404, { error: 'not found' });
    fs.readFile(file, (error, data) => {
      if (error) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': /\.(html|js)$/.test(file) ? 'no-cache' : 'public, max-age=300' });
      res.end(data);
    });
  }
  return http.createServer(async (req, res) => {
    cors(res);
    try {
      const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
      const parts = url.pathname.split('/').filter(Boolean);
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      if ((req.method === 'POST' || req.method === 'PUT') && parts.length === 1 && TOPIC_RE.test(parts[0])) return await publish(req, res, parts[0], url);
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
      if (parts.length === 2 && parts[0] === 'file') return serveFile(res, parts[1]);
      if (parts.length === 2 && TOPIC_RE.test(parts[0]) && parts[1] === 'sse') return stream(req, res, parts[0], url);
      if (parts.length === 2 && TOPIC_RE.test(parts[0]) && parts[1] === 'json') return poll(res, parts[0], url);
      return serveStatic(res, url.pathname);
    } catch (error) {
      if (!res.headersSent) json(res, error.status || 400, { error: error.status === 413 ? 'too large' : 'bad request' });
      else res.end();
    }
  });
}

function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat().filter(a => a && a.family === 'IPv4' && !a.internal).map(a => a.address);
}

if (require.main === module) {
  let opts;
  try { opts = args(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exit(1); }
  createServer().listen(opts.port, opts.host, () => {
    const hosts = lanAddresses();
    console.log('Apron без интернета: сайт и синхронизация на порту ' + opts.port + '.');
    if (!hosts.length) console.log('Сеть не найдена. Подключите ноутбук к Wi-Fi роутера и перезапустите.');
    for (const h of hosts) {
      const base = 'http://' + h + ':' + opts.port + '/';
      console.log('\nАдрес в сети: ' + base);
      console.log('  Зал:       ' + base + '?role=hall&room=' + opts.room + '&demo=1');
      console.log('  Поставщик: ' + base + '?role=supplier&room=' + opts.room + '&demo=1');
      console.log('  РЦ:        ' + base + '?role=rc&room=' + opts.room);
    }
    console.log('\nКамера по http не включится: на телефоне сработает «Снять системной камерой». Модели без интернета нет, плоды отмечаются вручную.');
  });
}

module.exports = { createServer };
