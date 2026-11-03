(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ApronRoom = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  // One room = one ntfy topic. Every device publishes small JSON events and replays the others.
  var ROOM_RE = /^[A-Za-z0-9_-]{4,64}$/;
  var ROLES = ['supplier', 'rc', 'hall'];
  var TYPES = ['box', 'shooting', 'fruit', 'state', 'decision', 'reset', 'wrongbox'];
  var VERDICTS = ['good', 'offspec', 'defect'];
  var FINDINGS = ['открытая трещина', 'зажившая трещина', 'порез или прокол', 'гниль', 'вершинная гниль', 'плесень', 'вмятина', 'перезревание', 'увядание', 'подмораживание', 'солнечный ожог', 'вредители', 'зелёная спинка', 'незрелость', 'неоднородная окраска', 'деформация', 'пробковое образование', 'шрам', 'загрязнение', 'другое'];
  var MAX_EVENT_BYTES = 3500, MAX_THUMB = 2600;

  function isInt(v, min, max) { return Number.isInteger(v) && v >= min && v <= max; }
  function isText(v, max) { return typeof v === 'string' && v.length <= max; }
  function orNull(v, check) { return v === null || check(v); }
  function isBox(x) { return !!x && typeof x === 'object' && Object.keys(x).length === 2 && isInt(x.p, 1, 1000) && isInt(x.b, 1, 10000); }
  function isThumb(v) { return typeof v === 'string' && v.length <= MAX_THUMB && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(v); }
  function isPhotoURL(v) { return typeof v === 'string' && v.length <= 300 && /^https?:\/\/[^\s"'<>]+$/.test(v); }
  function isTally(t) {
    return !!t && typeof t === 'object' && isInt(t.goal, 1, 2000) && isInt(t.checked, 0, 2000) && isInt(t.defects, 0, 2000) && isInt(t.offSpec, 0, 2000) && t.defects + t.offSpec <= t.checked && Array.isArray(t.boxes) && t.boxes.length <= 50 && t.boxes.every(isBox);
  }
  function tallyOf(t) { return { goal: t.goal, checked: t.checked, defects: t.defects, offSpec: t.offSpec, boxes: t.boxes.map(function (b) { return { p: b.p, b: b.b }; }) }; }

  // Returns a clean copy of a valid event or null. Anything unexpected is dropped silently.
  function validateEvent(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    var e = raw, now = Date.now();
    if (TYPES.indexOf(e.t) < 0 || !isText(e.from, 40) || !/^[a-z0-9-]{4,40}$/.test(e.from) || !Number.isFinite(e.ts) || e.ts < 1.6e12 || e.ts > now + 864e5) return null;
    var out = { t: e.t, from: e.from, ts: e.ts };
    if (e.t === 'box') { if (!isInt(e.n, 1, 2000) || !isBox(e.box)) return null; out.n = e.n; out.box = { p: e.box.p, b: e.box.b }; }
    else if (e.t === 'shooting') { if (!isInt(e.n, 1, 2000)) return null; out.n = e.n; }
    else if (e.t === 'state') { if (!isTally(e)) return null; Object.assign(out, tallyOf(e)); }
    else if (e.t === 'decision') {
      if (['wait', 'wait_strict', 'resort'].indexOf(e.kind) < 0 || !Array.isArray(e.pallets) || e.pallets.length > 50 || !e.pallets.every(function (p) { return isInt(p, 1, 1000); })) return null;
      out.kind = e.kind; out.pallets = e.pallets.slice();
    }
    else if (e.t === 'wrongbox') { if (!isInt(e.n, 1, 2000) || !isBox(e.box) || !isText(e.label, 60)) return null; out.n = e.n; out.box = { p: e.box.p, b: e.box.b }; out.label = e.label; }
    else if (e.t === 'fruit') {
      var ok = isText(e.id, 64) && e.id.length > 0 && isInt(e.n, 1, 2000) && isBox(e.box) && VERDICTS.indexOf(e.verdict) >= 0 && ['model', 'manual', 'test'].indexOf(e.source) >= 0 &&
        orNull(e.conf, function (v) { return Number.isFinite(v) && v >= 0 && v <= 1; }) && orNull(e.ms, function (v) { return isInt(v, 0, 600000); }) &&
        orNull(e.title, function (v) { return isText(v, 40); }) && (e.explanation === undefined || orNull(e.explanation, function (v) { return isText(v, 200); })) && orNull(e.rc_hint, function (v) { return isText(v, 120); }) &&
        Array.isArray(e.findings) && e.findings.length <= 6 && e.findings.every(function (f) { return FINDINGS.indexOf(f) >= 0; }) &&
        (e.thumb === undefined || orNull(e.thumb, isThumb)) && orNull(e.photo, isPhotoURL) && typeof e.corrected === 'boolean' &&
        (e.boxCheck === undefined || ['confirmed', 'unconfirmed'].indexOf(e.boxCheck) >= 0) && (e.shotDelay === undefined || isInt(e.shotDelay, 0, 864000)) &&
        (e.tally === undefined || isTally(e.tally));
      if (!ok) return null;
      ['id', 'n', 'verdict', 'source', 'conf', 'ms', 'title', 'rc_hint', 'photo', 'corrected'].forEach(function (k) { out[k] = e[k]; });
      out.box = { p: e.box.p, b: e.box.b }; out.findings = e.findings.slice();
      out.explanation = e.explanation === undefined ? null : e.explanation; out.thumb = e.thumb === undefined ? null : e.thumb;
      if (e.boxCheck !== undefined) out.boxCheck = e.boxCheck;
      if (e.shotDelay !== undefined) out.shotDelay = e.shotDelay;
      if (e.tally !== undefined) out.tally = tallyOf(e.tally);
    }
    return out;
  }
  function eventKey(e) { return e.from + ':' + e.ts + ':' + e.t; }
  function bytes(e) { var s = JSON.stringify(e); return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s).length : unescape(encodeURIComponent(s)).length; }
  // ntfy turns bodies over 4096 bytes into attachments, so events stay under 3500: explanation goes first, then the thumbnail.
  function fit(e) {
    var out = Object.assign({}, e);
    if (bytes(out) <= MAX_EVENT_BYTES) return out;
    if (out.explanation !== undefined) { delete out.explanation; if (bytes(out) <= MAX_EVENT_BYTES) return out; }
    if (out.thumb !== undefined) { delete out.thumb; if (bytes(out) <= MAX_EVENT_BYTES) return out; }
    return null;
  }

  // Room only from the link. CONFIG.room is a local fallback that the demo panel warns about.
  function fromLink(search, config) {
    var params = new URLSearchParams(search), room = params.get('room'), role = params.get('role');
    var linked = !!room && ROOM_RE.test(room);
    if (!linked && params.has('role') && config.room && ROOM_RE.test(config.room)) room = config.room;
    else if (!linked) room = null;
    return { room: room, linked: linked, role: room && ROLES.indexOf(role) >= 0 ? role : room ? 'supplier' : null, demo: params.get('demo') === '1', local: params.get('sync') === 'local' };
  }
  // A page served by plain http from an IP or localhost (the offline router setup) syncs through its own server.
  function syncServer(loc, local, config) {
    var lan = loc.protocol === 'http:' && (/^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|\d+\.\d+\.\d+\.\d+)$/.test(loc.hostname) || /\.local$/.test(loc.hostname));
    return local || lan ? loc.origin : config.sync.server.replace(/\/+$/, '');
  }
  function newCode(random) {
    random = random || Math.random;
    var chars = 'abcdefghjkmnpqrstuvwxyz23456789', code = 'apron-';
    for (var i = 0; i < 8; i++) code += chars[Math.floor(random() * chars.length)];
    return code;
  }
  function roleLink(base, room, role, demo) { return base + '?role=' + role + '&room=' + encodeURIComponent(room) + (demo ? '&demo=1' : ''); }

  // Browser transport: BroadcastChannel for windows on one laptop, ntfy (or the local server) for other devices.
  function connect(opts) {
    var base = opts.server + '/' + encodeURIComponent(opts.room);
    var cursor = opts.cursor || null, queue = (opts.outbox || []).slice(), seen = new Set(), seenIds = new Set();
    var source = null, sseOpen = false, openTimer = null, pollTimer = null, reconnectTimer = null, flushTimer = null, flushing = false, closed = false;
    var status = 'connecting', lastSeen = 0;
    var channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('apron-room-' + opts.room) : null;
    function setStatus(next) { if (next !== status) { status = next; opts.onStatus(status); } }
    function deliver(raw) {
      var e = validateEvent(raw);
      if (!e || e.from === opts.from) return;
      var key = eventKey(e); if (seen.has(key)) return;
      seen.add(key); if (seen.size > 3000) seen = new Set(Array.from(seen).slice(-1500));
      opts.onEvent(e);
    }
    function message(m) {
      if (!m || m.event !== 'message' || typeof m.message !== 'string') return;
      if (typeof m.id === 'string') {
        if (seenIds.has(m.id)) return;
        seenIds.add(m.id); if (seenIds.size > 3000) seenIds = new Set(Array.from(seenIds).slice(-1500));
        cursor = m.id; opts.onCursor(cursor);
      }
      var parsed; try { parsed = JSON.parse(m.message); } catch (error) { return; }
      deliver(parsed);
    }
    function since() { return encodeURIComponent(cursor || opts.catchUp); }
    function openStream() {
      if (closed || typeof EventSource !== 'function') { startPolling(); return; }
      if (source) source.close();
      sseOpen = false; source = new EventSource(base + '/sse?since=' + since());
      clearTimeout(openTimer); openTimer = setTimeout(function () { if (!sseOpen) startPolling(); }, 3000);
      source.onopen = function () { sseOpen = true; lastSeen = Date.now(); setStatus('online'); stopPolling(); flush(); };
      source.onmessage = function (ev) { lastSeen = Date.now(); try { message(JSON.parse(ev.data)); } catch (error) { /* Not ours. */ } };
      source.addEventListener('keepalive', function () { lastSeen = Date.now(); });
      source.onerror = function () {
        sseOpen = false; if (source) source.close(); source = null; startPolling();
        clearTimeout(reconnectTimer); reconnectTimer = setTimeout(openStream, 5000);
      };
    }
    function stopPolling() { clearInterval(pollTimer); pollTimer = null; }
    function startPolling() { if (pollTimer || closed) return; poll(); pollTimer = setInterval(poll, 3000); }
    async function poll() {
      if (sseOpen) { stopPolling(); return; }
      try {
        var res = await fetchWithTimeout(base + '/json?poll=1&since=' + since(), { cache: 'no-store' }, 5000);
        if (!res.ok) throw new Error('poll ' + res.status);
        (await res.text()).split('\n').forEach(function (line) { if (line.trim()) { try { message(JSON.parse(line)); } catch (error) { /* Skip. */ } } });
        lastSeen = Date.now(); setStatus('online'); flush();
      } catch (error) { setStatus('offline'); }
    }
    function persist() { opts.onOutbox(queue.slice()); }
    async function flush() {
      if (flushing || closed || !queue.length) return;
      flushing = true; clearTimeout(flushTimer);
      try {
        while (queue.length) {
          var res = await fetchWithTimeout(base, { method: 'POST', body: JSON.stringify(queue[0]) }, 6000);
          if (!res.ok) throw new Error('publish ' + res.status);
          queue.shift(); persist(); lastSeen = Date.now(); if (status !== 'online') setStatus('online');
        }
      } catch (error) {
        setStatus(sseOpen ? 'online' : 'offline');
        flushTimer = setTimeout(flush, 3000);
      } finally { flushing = false; }
    }
    function publish(event) {
      var e = fit(event); if (!e) return false;
      if (channel) { try { channel.postMessage(e); } catch (error) { /* Other windows will catch up from the server. */ } }
      queue.push(e); if (queue.length > 60) queue.splice(0, queue.length - 60);
      persist(); flush();
      return true;
    }
    async function upload(blob, name) {
      try {
        var res = await fetchWithTimeout(base + '?filename=' + encodeURIComponent(name), { method: 'PUT', body: blob }, 6000);
        if (!res.ok) return null;
        var body = await res.json(), url = body && body.attachment && body.attachment.url;
        return isPhotoURL(url) && url.indexOf(opts.server + '/') === 0 ? url : null;
      } catch (error) { return null; }
    }
    if (channel) channel.onmessage = function (ev) { deliver(ev.data); };
    openStream(); flush();
    var watchdog = setInterval(function () { if (!sseOpen && !pollTimer) startPolling(); if (Date.now() - lastSeen > 70000 && sseOpen) { sseOpen = false; openStream(); } }, 5000);
    return {
      publish: publish, upload: upload, status: function () { return status; }, pending: function () { return queue.length; },
      close: function () { closed = true; if (source) source.close(); stopPolling(); clearTimeout(openTimer); clearTimeout(reconnectTimer); clearTimeout(flushTimer); clearInterval(watchdog); if (channel) channel.close(); }
    };
  }
  function fetchWithTimeout(url, init, ms) {
    var ctrl = new AbortController(), timer = setTimeout(function () { ctrl.abort(); }, ms);
    return fetch(url, Object.assign({}, init, { signal: ctrl.signal })).finally(function () { clearTimeout(timer); });
  }

  return { ROOM_RE: ROOM_RE, ROLES: ROLES, validateEvent: validateEvent, eventKey: eventKey, fit: fit, isTally: isTally, isThumb: isThumb, isPhotoURL: isPhotoURL, fromLink: fromLink, syncServer: syncServer, newCode: newCode, roleLink: roleLink, connect: connect, MAX_EVENT_BYTES: MAX_EVENT_BYTES };
});
