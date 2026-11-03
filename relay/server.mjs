// Node 18+ relay without dependencies, for a server outside GitHub Pages.
// Run: node --env-file=relay/.env relay/server.mjs   (Node 20.6+; on Node 18 export the variables instead)
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRelay, readConfig, configProblem } from './core.mjs';

const root = new URL('../prompts/', import.meta.url);
const system = readFileSync(fileURLToPath(new URL('inspect-system.md', root)), 'utf8');
const schema = JSON.parse(readFileSync(fileURLToPath(new URL('inspect-schema.json', root)), 'utf8'));
const handle = createRelay({ env: process.env, system, schema });
const port = Number(process.env.PORT) || 8787;
const host = process.env.HOST || '0.0.0.0';
const trustProxy = process.env.TRUST_PROXY === '1';

const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 2_100_000) { res.writeHead(413, { 'content-type': 'application/json' }); res.end('{"ok":false,"error":"Фото слишком большое"}'); return; }
      chunks.push(chunk);
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const body = ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : Buffer.concat(chunks);
    const request = new Request('http://relay' + req.url, { method: req.method, headers, body });
    const forwarded = trustProxy && typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'].split(',')[0].trim() : '';
    const response = await handle(request, { ip: forwarded || req.socket.remoteAddress || 'unknown' });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error(error);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"ok":false,"error":"Ошибка relay"}');
  }
});

server.listen(port, host, () => {
  const cfg = readConfig(process.env), problem = configProblem(cfg);
  console.log('Apron relay: http://' + (host === '0.0.0.0' ? 'localhost' : host) + ':' + port);
  console.log(problem ? 'Не настроен: ' + problem + '. /inspect отвечает not_configured.' : 'Провайдер ' + cfg.provider + ', модель ' + cfg.model + '. Разрешены: ' + cfg.allowedOrigins.join(', '));
});
