// Apron relay core: shared by the Cloudflare Worker (worker.js) and Node (server.mjs).
// Standard Request/Response only, no dependencies. The API key lives only in the relay environment.
// Provider and model are never chosen here: PROVIDER, MODEL and API_KEY must be set by the team.

const PROVIDERS = ['anthropic', 'openai', 'gemini'];
const GOOD = ['good', 'offspec', 'defect'];
const CRITERIA = ['целостность', 'гниль и плесень', 'повреждения', 'свежесть', 'форма', 'окраска и зрелость', 'чистота', 'калибр'];
const GRADES = ['высший', 'первый', 'второй'];
const MAX_IMAGE = 2_000_000;

export function readConfig(env) {
  const get = (k, d = '') => (env[k] === undefined || env[k] === null ? d : String(env[k]).trim());
  const int = (k, d) => { const v = Number.parseInt(get(k), 10); return Number.isFinite(v) && v > 0 ? v : d; };
  const temperature = get('TEMPERATURE');
  return {
    provider: get('PROVIDER').toLowerCase(),
    model: get('MODEL'),
    apiKey: get('API_KEY'),
    apiBase: get('API_BASE').replace(/\/+$/, ''),
    allowedOrigins: get('ALLOWED_ORIGINS').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean),
    ratePerMinute: int('RATE_PER_MIN', 30),
    dailyLimit: int('DAILY_LIMIT', 500),
    timeoutMs: int('MODEL_TIMEOUT_MS', 9000),
    maxTokens: int('MAX_TOKENS', 800),
    // Optional knobs: sent only when set, because not every model accepts them.
    effort: get('EFFORT'),
    temperature: temperature === '' ? null : Number(temperature)
  };
}

export function configProblem(cfg) {
  if (!PROVIDERS.includes(cfg.provider)) return 'PROVIDER не задан или не поддерживается: ' + PROVIDERS.join(', ');
  if (!cfg.model) return 'MODEL не задан';
  if (!cfg.apiKey) return 'API_KEY не задан';
  if (!cfg.allowedOrigins.length) return 'ALLOWED_ORIGINS не задан';
  if (cfg.temperature !== null && !Number.isFinite(cfg.temperature)) return 'TEMPERATURE должен быть числом';
  return null;
}

// Schema helpers. The repository schema stays the source of truth; providers get a simplified copy.
function types(node) { return Array.isArray(node.type) ? node.type : node.type ? [node.type] : []; }

export function providerSchema(node, { nullableAs = 'anyOf' } = {}) {
  if (Array.isArray(node)) return node.map(n => providerSchema(n, { nullableAs }));
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (['$schema', 'title', 'maxLength', 'minLength', 'maxItems', 'minItems', 'minimum', 'maximum'].includes(k)) continue;
    out[k] = k === 'properties' ? Object.fromEntries(Object.entries(v).map(([p, s]) => [p, providerSchema(s, { nullableAs })])) : providerSchema(v, { nullableAs });
  }
  const t = types(node);
  if (nullableAs === 'anyOf' && t.length > 1 && t.includes('null')) {
    const base = t.find(x => x !== 'null');
    const variant = { type: base };
    if (Array.isArray(node.enum)) variant.enum = node.enum.filter(x => x !== null);
    delete out.type; delete out.enum;
    out.anyOf = [variant, { type: 'null' }];
  }
  return out;
}

// Truncate strings and arrays to schema limits and replace long dashes, as the prompt promises.
export function sanitize(value, schema) {
  if (typeof value === 'string') {
    let s = value.replace(/[‒–—―−]/g, '-');
    if (Number.isInteger(schema.maxLength) && [...s].length > schema.maxLength) s = [...s].slice(0, schema.maxLength).join('').trimEnd();
    return s;
  }
  if (Array.isArray(value)) {
    const items = Number.isInteger(schema.maxItems) ? value.slice(0, schema.maxItems) : value;
    return items.map(v => sanitize(v, schema.items || {}));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = schema.properties && schema.properties[k] ? sanitize(v, schema.properties[k]) : v;
    return out;
  }
  return value;
}

export function validate(value, schema, path = 'result') {
  const fail = why => { throw new Error(path + ': ' + why); };
  const t = types(schema);
  const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
  if (t.length && !t.includes(kind) && !(kind === 'integer' && t.includes('number'))) fail('тип ' + kind);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) fail('значение вне списка');
  if (typeof value === 'string' && Number.isInteger(schema.maxLength) && [...value].length > schema.maxLength) fail('слишком длинно');
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('не число');
    if (schema.minimum !== undefined && value < schema.minimum) fail('меньше минимума');
    if (schema.maximum !== undefined && value > schema.maximum) fail('больше максимума');
  }
  if (Array.isArray(value)) {
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) fail('слишком много элементов');
    value.forEach((v, i) => validate(v, schema.items || {}, path + '[' + i + ']'));
  }
  if (kind === 'object') {
    for (const k of schema.required || []) if (!Object.prototype.hasOwnProperty.call(value, k)) fail('нет поля ' + k);
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties && schema.properties[k]) validate(v, schema.properties[k], path + '.' + k);
      else if (schema.additionalProperties === false) fail('лишнее поле ' + k);
    }
  }
  return value;
}

// Rules the JSON schema cannot express but the app relies on (see prompts/inspect-system.md, "Как писать").
export function checkSemantics(r) {
  const expected = GOOD.includes(r.verdict) ? CRITERIA : [];
  if (r.checks.length !== expected.length || r.checks.some((c, i) => c.criterion !== expected[i])) throw new Error('result.checks: нужен список из 8 критериев по порядку');
  if (!r.title.trim()) throw new Error('result.title: пусто');
  // "Not enough data" must say what is missing and must not carry a hidden verdict.
  if (r.verdict === 'insufficient' && (!r.not_visible.length || r.findings.length || r.rc_hint !== null || r.photo_issue !== null)) throw new Error('result: для insufficient нужен not_visible, без findings, rc_hint и photo_issue');
  return r;
}

export function parseRequest(body) {
  const fail = why => { const e = new Error(why); e.status = 400; throw e; };
  const object = v => v && typeof v === 'object' && !Array.isArray(v);
  const text = (v, max) => typeof v === 'string' && v.length <= max;
  if (!object(body)) fail('Нужен JSON');
  const { image, spec, context } = body;
  if (typeof image !== 'string' || image.length > MAX_IMAGE || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(image)) fail('Нужно фото JPEG в data URL');
  if (!object(spec) || !text(spec.product, 200) || !spec.product.trim() || !GRADES.includes(spec.grade) || !text(spec.chain, 100) || !Array.isArray(spec.chain_rules) || spec.chain_rules.length > 30 || !spec.chain_rules.every(r => text(r, 300)) || !(spec.reference === null || text(spec.reference, 200))) fail('Неверная спецификация');
  if (!object(context) || !(context.expected_box === null || text(context.expected_box, 80)) || !Number.isInteger(context.fruit) || context.fruit < 1 || context.fruit > 100000) fail('Неверный контекст');
  return {
    image,
    payload: { product: spec.product, grade: spec.grade, chain: spec.chain, chain_rules: spec.chain_rules, reference: spec.reference, expected_box: context.expected_box, fruit: context.fruit }
  };
}

// Provider adapters: build the HTTP request and pull the JSON text out of the response.
const ADAPTERS = {
  anthropic: {
    request(cfg, system, schema, payload, image) {
      const body = {
        model: cfg.model, max_tokens: cfg.maxTokens, system,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image.slice(image.indexOf(',') + 1) } },
          { type: 'text', text: JSON.stringify(payload) }
        ] }],
        output_config: { format: { type: 'json_schema', schema: providerSchema(schema) } }
      };
      if (cfg.effort) body.output_config.effort = cfg.effort;
      if (cfg.temperature !== null) body.temperature = cfg.temperature;
      return { url: (cfg.apiBase || 'https://api.anthropic.com') + '/v1/messages', headers: { 'x-api-key': cfg.apiKey, 'anthropic-version': '2026-10-21' }, body };
    },
    text(data) {
      if (data.stop_reason === 'refusal') throw new Error('Модель отказалась отвечать');
      if (data.stop_reason === 'max_tokens') throw Object.assign(new Error('Ответ модели обрезан: увеличьте MAX_TOKENS'), { retry: false });
      return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    }
  },
  openai: {
    request(cfg, system, schema, payload, image) {
      const body = {
        model: cfg.model, max_completion_tokens: cfg.maxTokens,
        messages: [{ role: 'system', content: system }, { role: 'user', content: [
          { type: 'text', text: JSON.stringify(payload) },
          { type: 'image_url', image_url: { url: image } }
        ] }],
        response_format: { type: 'json_schema', json_schema: { name: 'apron_inspect_result', strict: true, schema: providerSchema(schema, { nullableAs: 'array' }) } }
      };
      if (cfg.effort) body.reasoning_effort = cfg.effort;
      if (cfg.temperature !== null) body.temperature = cfg.temperature;
      return { url: (cfg.apiBase || 'https://api.openai.com/v1') + '/chat/completions', headers: { authorization: 'Bearer ' + cfg.apiKey }, body };
    },
    text(data) {
      const choice = data.choices && data.choices[0];
      if (!choice) throw new Error('Пустой ответ модели');
      if (choice.message && choice.message.refusal) throw new Error('Модель отказалась отвечать');
      if (choice.finish_reason === 'length') throw Object.assign(new Error('Ответ модели обрезан: увеличьте MAX_TOKENS'), { retry: false });
      return choice.message && choice.message.content || '';
    }
  },
  gemini: {
    request(cfg, system, schema, payload, image) {
      const generationConfig = { responseMimeType: 'application/json', responseJsonSchema: providerSchema(schema, { nullableAs: 'array' }), maxOutputTokens: cfg.maxTokens };
      if (cfg.temperature !== null) generationConfig.temperature = cfg.temperature;
      if (cfg.effort) generationConfig.thinkingConfig = { thinkingLevel: cfg.effort };
      return {
        url: (cfg.apiBase || 'https://generativelanguage.googleapis.com/v1beta') + '/models/' + encodeURIComponent(cfg.model) + ':generateContent',
        headers: { 'x-goog-api-key': cfg.apiKey },
        body: {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: JSON.stringify(payload) }, { inlineData: { mimeType: 'image/jpeg', data: image.slice(image.indexOf(',') + 1) } }] }],
          generationConfig
        }
      };
    },
    text(data) {
      const c = data.candidates && data.candidates[0];
      if (!c) throw new Error(data.promptFeedback && data.promptFeedback.blockReason ? 'Модель отказалась отвечать' : 'Пустой ответ модели');
      if (c.finishReason === 'MAX_TOKENS') throw Object.assign(new Error('Ответ модели обрезан: увеличьте MAX_TOKENS'), { retry: false });
      return (c.content && c.content.parts || []).map(p => p.text || '').join('');
    }
  }
};

async function callModel(cfg, system, schema, payload, image, fetchImpl, deadline) {
  const adapter = ADAPTERS[cfg.provider];
  const req = adapter.request(cfg, system, schema, payload, image);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1, deadline - Date.now()));
  try {
    const res = await fetchImpl(req.url, { method: 'POST', headers: { 'content-type': 'application/json', ...req.headers }, body: JSON.stringify(req.body), signal: ctrl.signal });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) throw Object.assign(new Error('Провайдер ответил ошибкой ' + res.status), { retry: false, providerStatus: res.status, detail: data && (data.error && (data.error.message || data.error.type) || data.message) });
    const raw = adapter.text(data);
    let parsed;
    try { parsed = JSON.parse(String(raw).trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); }
    catch { throw Object.assign(new Error('Модель вернула не JSON'), { retry: true }); }
    try { return checkSemantics(validate(sanitize(parsed, schema), schema)); }
    catch (e) { throw Object.assign(new Error('Ответ не по схеме: ' + e.message), { retry: true }); }
  } catch (e) {
    if (e.name === 'AbortError') throw Object.assign(new Error('Модель не ответила за ' + cfg.timeoutMs + ' мс'), { retry: false, timeout: true });
    throw e;
  } finally { clearTimeout(timer); }
}

export function createRelay({ env, system, schema, fetchImpl = fetch, now = () => Date.now(), log = console }) {
  const cfg = readConfig(env);
  const problem = configProblem(cfg);
  const perIp = new Map();
  let day = '', dayCount = 0;

  function cors(origin) {
    const h = { vary: 'Origin' };
    if (origin && cfg.allowedOrigins.includes(origin)) Object.assign(h, { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'Content-Type', 'access-control-max-age': '600' });
    return h;
  }
  function json(status, body, origin) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors(origin) } });
  }
  function limited(ip) {
    const t = now(), today = new Date(t).toISOString().slice(0, 10);
    if (today !== day) { day = today; dayCount = 0; }
    if (dayCount >= cfg.dailyLimit) return 'Дневной лимит проверок исчерпан';
    const recent = (perIp.get(ip) || []).filter(x => t - x < 60_000);
    if (recent.length >= cfg.ratePerMinute) { perIp.set(ip, recent); return 'Слишком много запросов, подождите минуту'; }
    recent.push(t); perIp.set(ip, recent); dayCount++;
    if (perIp.size > 5000) for (const [k, v] of perIp) if (!v.some(x => t - x < 60_000)) perIp.delete(k);
    return null;
  }

  return async function handle(request, { ip = 'unknown' } = {}) {
    const url = new URL(request.url);
    const origin = (request.headers.get('origin') || '').replace(/\/+$/, '');
    const allowed = origin && cfg.allowedOrigins.includes(origin);
    if (request.method === 'OPTIONS') return new Response(null, { status: allowed ? 204 : 403, headers: cors(origin) });
    if (url.pathname === '/health' && request.method === 'GET') {
      if (origin && !allowed) return json(403, { ok: false, error: 'Адрес страницы не разрешён' }, origin);
      return problem ? json(503, { ok: false, error: 'not_configured', model: null }, origin) : json(200, { ok: true, model: cfg.model }, origin);
    }
    if (url.pathname !== '/inspect' || request.method !== 'POST') return json(404, { ok: false, error: 'Нет такого адреса' }, origin);
    if (!allowed) return json(403, { ok: false, error: 'Адрес страницы не разрешён' }, origin);
    if (problem) { log.warn('relay not configured: ' + problem); return json(503, { ok: false, error: 'not_configured' }, origin); }
    const length = Number(request.headers.get('content-length') || 0);
    if (length > MAX_IMAGE + 20_000) return json(413, { ok: false, error: 'Фото слишком большое' }, origin);
    let input;
    try {
      const raw = await request.text();
      if (raw.length > MAX_IMAGE + 20_000) return json(413, { ok: false, error: 'Фото слишком большое' }, origin);
      input = parseRequest(JSON.parse(raw));
    } catch (e) { return json(400, { ok: false, error: e.status ? e.message : 'Нужен JSON' }, origin); }
    const busy = limited(ip);
    if (busy) return json(429, { ok: false, error: busy }, origin);

    const started = now(), deadline = Date.now() + cfg.timeoutMs;
    for (let attempt = 1; ; attempt++) {
      try {
        const result = await callModel(cfg, system, schema, input.payload, input.image, fetchImpl, deadline);
        return json(200, { ok: true, result, model: cfg.model, ms: now() - started }, origin);
      } catch (e) {
        log.warn('inspect attempt ' + attempt + ': ' + e.message + (e.detail ? ' (' + String(e.detail).slice(0, 200) + ')' : ''));
        if (e.retry && attempt < 2 && deadline - Date.now() > 1500) continue;
        return json(e.timeout ? 504 : 502, { ok: false, error: e.timeout ? 'timeout' : e.message }, origin);
      }
    }
  };
}
