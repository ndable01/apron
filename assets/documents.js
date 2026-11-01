(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ApronDocuments = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';
  var MAX_SIZE = 20 * 1024 * 1024, MAX_FILES = 10;
  var CATEGORIES = ['declaration', 'quality', 'lab', 'shipment', 'labels'];
  var TYPES = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', rtf: 'application/rtf', txt: 'text/plain' };
  var dbPromise = null;
  function sizeText(size) { return size < 1024 ? size + ' Б' : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(size / (size < 1048576 ? 1024 : 1048576)) + (size < 1048576 ? ' КБ' : ' МБ'); }
  function signature(ext, bytes) {
    var text = String.fromCharCode.apply(null, bytes.slice(0, 1024));
    if (ext === 'pdf') return text.indexOf('%PDF-') >= 0;
    if (ext === 'jpg' || ext === 'jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (ext === 'png') return [137, 80, 78, 71, 13, 10, 26, 10].every(function (v, i) { return bytes[i] === v; });
    if (ext === 'webp') return text.slice(0, 4) === 'RIFF' && text.slice(8, 12) === 'WEBP';
    if (ext === 'heic' || ext === 'heif') return text.slice(4, 8) === 'ftyp';
    if (ext === 'doc' || ext === 'xls') return [208, 207, 17, 224, 161, 177, 26, 225].every(function (v, i) { return bytes[i] === v; });
    if (ext === 'docx' || ext === 'xlsx') return text.slice(0, 4) === 'PK\x03\x04';
    if (ext === 'rtf') return text.trimStart().slice(0, 5) === '{\\rtf';
    return ext === 'txt';
  }
  async function prepare(file, batchId, category) {
    if (CATEGORIES.indexOf(category) < 0 || typeof batchId !== 'string' || !batchId.startsWith('batch-')) throw new Error('Выберите пункт чек-листа');
    var ext = typeof file.name === 'string' ? file.name.split('.').pop().toLowerCase() : '';
    if (!TYPES[ext]) throw new Error('Этот формат не поддерживается. Выберите PDF, фото, Word, Excel, RTF или TXT.');
    if (!Number.isFinite(file.size) || !file.size) throw new Error('Файл пустой. Выберите другой документ.');
    if (file.size > MAX_SIZE) throw new Error('Файл «' + file.name.slice(0, 100) + '» больше 20 МБ. Разделите его или уменьшите размер.');
    var header = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
    if (!signature(ext, header)) throw new Error('Формат файла «' + file.name.slice(0, 100) + '» не совпадает с расширением. Выберите исходный документ.');
    var cleanName = file.name.replace(/[\\/\x00-\x1f\x7f]/g, '_');
    if (cleanName.length > 180) cleanName = cleanName.slice(0, 160) + '.' + ext;
    var id = 'doc-' + (root.crypto && root.crypto.randomUUID ? root.crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2));
    // Normalize MIME instead of trusting the browser-provided File.type.
    return { id: id, batchId: batchId, category: category, name: cleanName, type: TYPES[ext], size: file.size, addedAt: Date.now(), blob: new Blob([file], { type: TYPES[ext] }) };
  }
  function validRecord(r, batchId) {
    return !!r && r.batchId === batchId && typeof r.id === 'string' && /^doc-[a-z0-9-]+$/.test(r.id) && CATEGORIES.indexOf(r.category) >= 0 && typeof r.name === 'string' && r.name.length > 0 && r.name.length <= 180 && Object.values(TYPES).indexOf(r.type) >= 0 && Number.isFinite(r.addedAt) && Number.isInteger(r.size) && r.size > 0 && r.size <= MAX_SIZE && r.blob instanceof Blob && r.blob.size === r.size && r.blob.type === r.type;
  }
  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!root.indexedDB) { reject(new Error('В этом браузере хранение файлов недоступно.')); return; }
      var request = root.indexedDB.open('apron-documents', 1), blocked = false;
      request.onupgradeneeded = function () {
        var store = request.result.createObjectStore('files', { keyPath: 'id' });
        store.createIndex('batchId', 'batchId', { unique: false });
      };
      request.onsuccess = function () { var db = request.result; if (blocked) { db.close(); return; } db.onversionchange = function () { db.close(); dbPromise = null; }; resolve(db); };
      request.onerror = function () { reject(request.error || new Error('Не удалось открыть хранилище документов')); };
      request.onblocked = function () { blocked = true; reject(new Error('Хранилище занято другой вкладкой. Закройте её и попробуйте снова.')); };
    }).catch(function (error) { dbPromise = null; throw error; });
    return dbPromise;
  }
  async function list(batchId) {
    var db = await open();
    return new Promise(function (resolve, reject) {
      var tx = db.transaction('files', 'readonly');
      var req = tx.objectStore('files').index('batchId').getAll(batchId);
      req.onsuccess = function () { resolve(req.result.filter(function (r) { return validRecord(r, batchId); }).sort(function (a, b) { return a.addedAt - b.addedAt; })); };
      req.onerror = function () { reject(req.error); }; tx.onabort = function () { reject(tx.error || new Error('Не удалось прочитать документы')); };
    });
  }
  function validateSet(batchId, records) {
    var ids = new Set();
    records.forEach(function (r) { if (!validRecord(r, batchId) || ids.has(r.id)) throw new Error('Некорректный документ'); ids.add(r.id); });
    CATEGORIES.forEach(function (category) { if (records.filter(function (r) { return r.category === category; }).length > MAX_FILES) throw new Error('К одному пункту можно приложить до 10 файлов.'); });
  }
  async function commit(batchId, records, baselineIds) {
    validateSet(batchId, records);
    var db = await open();
    return new Promise(function (resolve, reject) {
      var tx = db.transaction('files', 'readwrite'), store = tx.objectStore('files');
      var req = store.index('batchId').getAll(batchId), reason = null;
      req.onsuccess = function () {
        var old = req.result;
        var oldIds = old.filter(function (r) { return validRecord(r, batchId); }).map(function (r) { return r.id; }).sort();
        if (JSON.stringify(oldIds) !== JSON.stringify(baselineIds.slice().sort())) {
          reason = new Error('Документы изменены в другой вкладке. Откройте партию заново перед сохранением.'); tx.abort(); return;
        }
        var nextIds = new Set(records.map(function (r) { return r.id; }));
        old.forEach(function (r) { if (!nextIds.has(r.id)) store.delete(r.id); });
        var existing = new Set(oldIds);
        records.forEach(function (r) { if (!existing.has(r.id)) store.put(r); });
      };
      tx.oncomplete = function () { resolve(records.slice()); };
      tx.onerror = function () { /* onabort reports the complete transaction failure. */ };
      tx.onabort = function () { reject(reason || tx.error || new Error('Не удалось сохранить документы')); };
    });
  }
  return { MAX_SIZE: MAX_SIZE, MAX_FILES: MAX_FILES, ACCEPT: Object.keys(TYPES).map(function (x) { return '.' + x; }).join(','), prepare: prepare, list: list, commit: commit, validateSet: validateSet, sizeText: sizeText };
});
