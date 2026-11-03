(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ApronQR = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  // Minimal QR Code Model 2 encoder: byte mode, error correction level M, versions 1-10.
  // Enough for a room link (up to 213 bytes). Written for Apron so the page needs no library.
  var BLOCKS = [null, [1, 10], [1, 16], [1, 26], [2, 18], [2, 24], [4, 16], [4, 18], [4, 22], [5, 22], [5, 26]]; // [blocks, EC codewords per block] for level M
  var MAX_VERSION = 10;

  function gfMultiply(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; }
    return z;
  }
  function rsDivisor(degree) {
    var result = new Array(degree).fill(0), root = 1;
    result[degree - 1] = 1;
    for (var i = 0; i < degree; i++) {
      for (var j = 0; j < result.length; j++) { result[j] = gfMultiply(result[j], root); if (j + 1 < result.length) result[j] ^= result[j + 1]; }
      root = gfMultiply(root, 0x02);
    }
    return result;
  }
  function rsRemainder(data, divisor) {
    var result = divisor.map(function () { return 0; });
    data.forEach(function (b) {
      var factor = b ^ result.shift(); result.push(0);
      divisor.forEach(function (coef, i) { result[i] ^= gfMultiply(coef, factor); });
    });
    return result;
  }
  function rawModules(ver) {
    var result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) { var n = Math.floor(ver / 7) + 2; result -= (25 * n - 10) * n - 55; if (ver >= 7) result -= 36; }
    return result;
  }
  function dataCodewords(ver) { return Math.floor(rawModules(ver) / 8) - BLOCKS[ver][0] * BLOCKS[ver][1]; }
  function alignment(ver) {
    if (ver === 1) return [];
    var n = Math.floor(ver / 7) + 2, size = ver * 4 + 17, step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2, out = [6];
    for (var pos = size - 7; out.length < n; pos -= step) out.splice(1, 0, pos);
    return out;
  }
  function utf8(text) {
    if (typeof TextEncoder !== 'undefined') return Array.from(new TextEncoder().encode(text));
    return Array.from(unescape(encodeURIComponent(text)), function (c) { return c.charCodeAt(0); });
  }

  function encode(text) {
    var bytes = utf8(String(text)), ver;
    for (ver = 1; ver <= MAX_VERSION; ver++) if (4 + (ver < 10 ? 8 : 16) + bytes.length * 8 <= dataCodewords(ver) * 8) break;
    if (ver > MAX_VERSION) throw new Error('Слишком длинная ссылка для QR');
    var capacity = dataCodewords(ver) * 8, bits = [];
    var push = function (value, length) { for (var i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
    push(4, 4); push(bytes.length, ver < 10 ? 8 : 16); bytes.forEach(function (b) { push(b, 8); });
    push(0, Math.min(4, capacity - bits.length));
    push(0, (8 - bits.length % 8) % 8);
    for (var pad = 0xEC; bits.length < capacity; pad ^= 0xEC ^ 0x11) push(pad, 8);
    var data = [];
    for (var i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
    return draw(ver, interleave(ver, data));
  }

  function interleave(ver, data) {
    var numBlocks = BLOCKS[ver][0], ecLen = BLOCKS[ver][1], raw = Math.floor(rawModules(ver) / 8);
    var short = numBlocks - raw % numBlocks, shortLen = Math.floor(raw / numBlocks), divisor = rsDivisor(ecLen), blocks = [];
    for (var i = 0, k = 0; i < numBlocks; i++) {
      var dat = data.slice(k, k + shortLen - ecLen + (i < short ? 0 : 1)); k += dat.length;
      var ecc = rsRemainder(dat, divisor);
      if (i < short) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    var out = [];
    for (var c = 0; c < blocks[0].length; c++) blocks.forEach(function (block, j) { if (c !== shortLen - ecLen || j >= short) out.push(block[c]); });
    return out;
  }

  function draw(ver, codewords) {
    var size = ver * 4 + 17, modules = [], fn = [];
    for (var y = 0; y < size; y++) { modules.push(new Array(size).fill(false)); fn.push(new Array(size).fill(false)); }
    var set = function (x, y, dark) { modules[y][x] = dark; fn[y][x] = true; };
    for (var i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    [[3, 3], [size - 4, 3], [3, size - 4]].forEach(function (c) {
      for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) {
        var d = Math.max(Math.abs(dx), Math.abs(dy)), xx = c[0] + dx, yy = c[1] + dy;
        if (xx >= 0 && xx < size && yy >= 0 && yy < size) set(xx, yy, d !== 2 && d !== 4);
      }
    });
    var pos = alignment(ver), last = pos.length - 1;
    pos.forEach(function (ay, a) {
      pos.forEach(function (ax, b) {
        if ((a === 0 && b === 0) || (a === 0 && b === last) || (a === last && b === 0)) return;
        for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      });
    });
    formatBits(set, size, 0);
    if (ver >= 7) {
      var rem = ver;
      for (var r = 0; r < 12; r++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      var vbits = ver << 12 | rem;
      for (var v = 0; v < 18; v++) { var bit = ((vbits >>> v) & 1) === 1, a2 = size - 11 + v % 3, b2 = Math.floor(v / 3); set(a2, b2, bit); set(b2, a2, bit); }
    }
    var bitIndex = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) for (var j = 0; j < 2; j++) {
        var x = right - j, upward = ((right + 1) & 2) === 0, yy2 = upward ? size - 1 - vert : vert;
        if (!fn[yy2][x] && bitIndex < codewords.length * 8) { modules[yy2][x] = ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) === 1; bitIndex++; }
      }
    }
    var best = null, bestScore = Infinity;
    for (var mask = 0; mask < 8; mask++) {
      var candidate = modules.map(function (row) { return row.slice(); });
      applyMask(candidate, fn, mask);
      formatBits(function (x, y, dark) { candidate[y][x] = dark; }, size, mask);
      var score = penalty(candidate);
      if (score < bestScore) { bestScore = score; best = candidate; }
    }
    return { size: size, version: ver, modules: best };
  }

  function formatBits(set, size, mask) {
    var data = mask, rem = data; // level M has format bits 00
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    var bits = (data << 10 | rem) ^ 0x5412, bit = function (k) { return ((bits >>> k) & 1) === 1; };
    for (var a = 0; a <= 5; a++) set(8, a, bit(a));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (var b = 9; b < 15; b++) set(14 - b, 8, bit(b));
    for (var c = 0; c < 8; c++) set(size - 1 - c, 8, bit(c));
    for (var d = 8; d < 15; d++) set(8, size - 15 + d, bit(d));
    set(8, size - 8, true);
  }

  function applyMask(modules, fn, mask) {
    var size = modules.length;
    for (var y = 0; y < size; y++) for (var x = 0; x < size; x++) {
      if (fn[y][x]) continue;
      var invert = [
        (x + y) % 2 === 0, y % 2 === 0, x % 3 === 0, (x + y) % 3 === 0,
        (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, x * y % 2 + x * y % 3 === 0,
        (x * y % 2 + x * y % 3) % 2 === 0, ((x + y) % 2 + x * y % 3) % 2 === 0
      ][mask];
      if (invert) modules[y][x] = !modules[y][x];
    }
  }

  // Standard penalty rules; any mask decodes, the score only picks the cleanest one.
  function penalty(m) {
    var size = m.length, score = 0, dark = 0;
    var lines = [];
    for (var i = 0; i < size; i++) { lines.push(m[i]); lines.push(m.map(function (row) { return row[i]; })); }
    var finderA = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0].join(''), finderB = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1].join('');
    lines.forEach(function (line) {
      var run = 1;
      for (var k = 1; k <= size; k++) {
        if (k < size && line[k] === line[k - 1]) run++;
        else { if (run >= 5) score += 3 + run - 5; run = 1; }
      }
      var s = '0000' + line.map(function (v) { return v ? 1 : 0; }).join('') + '0000';
      for (var p = 0; p + 11 <= s.length; p++) { var part = s.slice(p, p + 11); if (part === finderA || part === finderB) score += 40; }
    });
    for (var y = 0; y < size; y++) for (var x = 0; x < size; x++) {
      if (m[y][x]) dark++;
      if (x + 1 < size && y + 1 < size && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) score += 3;
    }
    var total = size * size;
    score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return score;
  }

  // SVG path of dark modules with a quiet zone of `border` modules.
  function svgPath(qr, border) {
    var d = [];
    qr.modules.forEach(function (row, y) { row.forEach(function (dark, x) { if (dark) d.push('M' + (x + border) + ' ' + (y + border) + 'h1v1h-1z'); }); });
    return d.join('');
  }

  return { encode: encode, svgPath: svgPath };
});
