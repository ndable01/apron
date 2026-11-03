(function () {
  'use strict';
  var Core = window.ApronCore, CONFIG = Core.CONFIG;
  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.from(document.querySelectorAll(s)); };
  var params = new URLSearchParams(location.search);
  if (params.get('print') === '1') { printCards(); return; }
  // Printable A5 box cards for the stage: the card is the background of the photo, so the model can read the label.
  function printCards() {
    document.title = 'Apron: карточки ящиков';
    var sheet = document.createElement('div'); sheet.className = 'print-sheet';
    var note = document.createElement('p'); note.className = 'print-note';
    note.textContent = 'Карточки для сцены. Печать на A5, без полей и масштабирования. Плод кладут в светлое поле, надпись ящика должна попасть в кадр.';
    var button = document.createElement('button'); button.type = 'button'; button.className = 'btn print-action'; button.textContent = 'Распечатать';
    button.addEventListener('click', function () { window.print(); });
    sheet.append(note, button);
    Core.CONFIG.boxes.forEach(function (box) {
      var card = document.createElement('section'); card.className = 'print-card';
      var head = document.createElement('p'); head.className = 'print-label'; head.textContent = 'Паллета ' + box.p + ', ящик ' + box.b;
      var field = document.createElement('div'); field.className = 'print-field'; field.setAttribute('aria-label', 'Поле для плода');
      var foot = document.createElement('p'); foot.className = 'print-foot'; foot.textContent = 'Apron. Положите плод в поле, плодоножкой вверх';
      var tail = document.createElement('p'); tail.className = 'print-label print-label-small'; tail.textContent = 'Паллета ' + box.p + ', ящик ' + box.b;
      card.append(head, field, tail, foot); sheet.append(card);
    });
    document.getElementById('app').replaceWith(sheet);
    document.querySelectorAll('dialog, .toast').forEach(function (n) { n.remove(); });
  }
  var STORE_KEY = 'apron-personal-sample-v3';
  var TITLES = { good: 'Годен', offspec: 'Не по критериям', defect: 'Брак' };
  var LEVELS = { low: 'низкий', medium: 'заметный', high: 'высокий' };
  var REASONS = { manual: 'Отмечено вручную', test: 'Тест, отмечено вручную', model: 'Модель' };
  var route = '', lastResultId = null, cameraStream = null, cameraAttempt = 0, analysisAttempt = 0, controller = null;
  var cameraMessage = '', toastTimer = null, wakeLock = null, resultBusy = false;
  var editingNew = false, draftBatch = null;
  var Docs = window.ApronDocuments, documentFiles = [], documentBatch = '', documentLoad = null, documentLoadError = '';
  var documentDraft = null, documentBaseline = [], documentDraftId = 0, documentPicker = null, documentBusy = false, measurementsSaving = false;
  var documentManualDraft = {};
  var documentURLs = new Map();
  var LIBRARY_PREFIX = 'apron-saved-batch-v1:';
  var number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
  var decimal = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
  var precise = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 6 });
  var S = Core.baseState();
  try {
    var stored = sessionStorage.getItem(STORE_KEY) || sessionStorage.getItem('apron-personal-sample-v2');
    if (stored) S = Core.restore(stored);
    else {
      var lastBatch = localStorage.getItem('apron-last-batch-v1');
      var savedBatch = lastBatch && localStorage.getItem(LIBRARY_PREFIX + lastBatch);
      if (savedBatch) { S = Core.restore(savedBatch); S.role = 'supplier'; }
    }
  }
  catch (error) { $('#storage-warning').hidden = false; $('#storage-warning').textContent = 'Сохранённая проба недоступна. Начинаем новую проверку в этой вкладке.'; }

  function element(tag, className, text) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function save(forcePersist) {
    var saved = true;
    S.updatedAt = Date.now();
    try { sessionStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (error) { saved = false; }
    try {
      if (!S.batch.example || forcePersist || localStorage.getItem(LIBRARY_PREFIX + S.batch.id)) {
        localStorage.setItem(LIBRARY_PREFIX + S.batch.id, JSON.stringify(S)); localStorage.setItem('apron-last-batch-v1', S.batch.id);
      }
    } catch (error) { saved = false; }
    $('#storage-warning').hidden = saved;
    if (!saved) $('#storage-warning').textContent = 'В браузере не хватает места для сохранения. Не закрывайте эту вкладку; снимки и изменения пока доступны здесь.';
    return saved;
  }
  function batchTitle() { return S.batch.product + ', ' + precise.format(S.batch.weight) + ' т'; }
  function specForBatch() { return { product: S.batch.product, grade: S.batch.grade, chain: S.batch.chain, chain_rules: S.batch.rules.split('\n').map(function (x) { return x.trim(); }).filter(Boolean), reference: null }; }
  function renderBatchInfo() {
    var b = S.batch;
    var description = ['Партия ' + b.code, b.supplier];
    if (b.departure) description.push('Выезд ' + b.departure);
    if (b.arrival) description.push('Прибытие ' + b.arrival);
    if (b.distance !== null) description.push(number.format(b.distance) + ' км');
    var values = { title: batchTitle(), destination: 'Сеть «' + b.chain + '», ' + b.rc, description: description.join('. '), rc: b.rc, code: 'Партия ' + b.code, supplierArrival: b.supplier + (b.arrival ? '. Прибытие ' + b.arrival : ''), reportHeading: batchTitle() + '. ' + b.supplier + ', сеть «' + b.chain + '»' };
    $$('[data-batch]').forEach(function (n) { n.textContent = values[n.dataset.batch]; });
    $('#sample-origin').textContent = b.example ? (S.seed.checked ? 'Пример партии: первые ' + S.seed.checked + ' плодов заданы заранее. Создайте свою партию, чтобы начать проверку с нуля.' : 'Новая проверка на данных примера. Свои данные можно указать в новой партии.') : 'Проба вашей партии. Фото, отметки и замеры сохраняются на этом устройстве.';
    $('#report-origin').hidden = !S.seed.checked;
    $('#report-origin').textContent = 'Исходные ' + S.seed.checked + ' плодов заданы в примере, среди них ' + S.seed.defects + ' брак. Фото этой части пробы нет.';
    var measured = Object.values(b.measurements).filter(function (v) { return v !== null; }).length;
    var docs = Object.keys(b.documents).filter(function (key) { return b.documents[key] || filesFor(key).length; }).length;
    $('#support-summary').textContent = 'Замеры ' + measured + ' из 6, ' + (documentBatch === b.id ? 'документы ' + docs + ' из 5' : documentLoadError ? 'файлы недоступны' : 'читаем документы') + (b.packaging ? ', упаковка отмечена' : '');
    support($('#sup-support')); support($('#report-support')); method($('#sup-method')); method($('#report-method'));
  }
  function event(text) { S.events.push({ text: text, ts: Date.now() }); S.events = S.events.slice(-30); }
  function boxText(box) { return 'паллета ' + box.p + ', ящик ' + box.b; }
  function placeText(f) {
    var text = 'П' + boxText(f.box).slice(1) + (f.boxCheck === 'confirmed' ? ', ящик подтверждён по этикетке' : f.boxCheck === 'unconfirmed' ? ', ящик не подтверждён' : '');
    if (Number.isInteger(f.shotDelay)) text += '. Снято через ' + (f.shotDelay < 120 ? f.shotDelay + ' с' : Math.round(f.shotDelay / 60) + ' мин') + ' после выбора ящика';
    return text;
  }
  function time(ts) { var d = new Date(ts); return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  function riskText(st) { return st.level === 'empty' ? 'Пока нет данных' : st.needsReview ? 'Нужна перепроверка' : Math.round(st.risk * 100) + ' %, ' + LEVELS[st.level]; }
  function fruitCount(n) { var mod = n % 100; return n + ' ' + (mod >= 11 && mod <= 14 ? 'плодов' : n % 10 === 1 ? 'плод' : n % 10 >= 2 && n % 10 <= 4 ? 'плода' : 'плодов'); }
  function sourceText(f) {
    if (f.source !== 'model') return REASONS[f.source] + (f.corrected ? ', исправление' : '');
    return 'Модель, уверенность ' + Math.round(f.result.confidence * 100) + ' %. Ответ за ' + decimal.format(f.ms / 1000) + ' с';
  }
  function boxesWithFindings() {
    var boxes = S.seed.defectBoxes.slice();
    S.fruits.filter(function (f) { return f.verdict !== 'good'; }).forEach(function (f) { if (!boxes.some(function (b) { return b.p === f.box.p && b.b === f.box.b; })) boxes.push(f.box); });
    return boxes;
  }
  function palletTargets() { var ids = Array.from(new Set(boxesWithFindings().map(function (b) { return b.p; }))); return (ids.length === 1 ? 'паллету ' : 'паллеты ') + ids.join(', '); }
  function recommendation(st) {
    if (!st.checked) return 'Начните с первого плода. Apron подскажет, из какого ящика его взять.';
    if (st.needsReview) return 'Условия приёмки изменились. Проверьте и подтвердите отметки в отчёте.';
    if (!st.defects && !st.offSpec && st.level !== 'low') {
      var more = Core.extraNeeded(S);
      return 'Отклонений пока нет, но данных для низкого риска мало. ' + (more === null ? 'Продолжите проверку по условиям сети.' : 'Проверьте ещё ' + fruitCount(more) + ' без отклонений.');
    }
    if (st.level === 'low') return st.done ? 'Можно отгружать по результатам пробы. Окончательное решение после приёмки РЦ.' : 'Осталось проверить ' + fruitCount(Math.max(0, S.goal - st.checked)) + '.';
    var extra = Core.extraNeeded(S), noun = st.category === 'offspec' ? 'отклонений' : 'брака';
    var action = extra === null ? 'Расширьте пробу' : 'Проверьте ещё ' + extra + ' плодов без брака и отклонений';
    return (st.level === 'high' ? 'Не отгружайте как есть. ' : '') + action + (boxesWithFindings().length ? ' или досортируйте ' + palletTargets() : '') + '. Риск рассчитан по доле ' + noun + '.';
  }
  function money(st, target) {
    target.hidden = !st.checked || !st.defects && !st.offSpec || st.level === 'low' || st.needsReview || S.batch.revenue === null;
    var tolerance = S.batch.tolerance.defect, scenario = Math.min(100, tolerance + 5);
    var cut = Math.max(0, scenario - tolerance) / 100 * S.batch.revenue;
    target.textContent = 'Стоимость партии ' + number.format(S.batch.revenue) + ' ₽. Для оценки потерь: при ' + precise.format(scenario) + ' % брака и допуске ' + precise.format(tolerance) + ' % разница составит ' + number.format(cut) + ' ₽. Условия удержания зависят от договора.';
  }
  function summary(target) {
    var st = Core.stats(S), category = st.category === 'offspec';
    target.replaceChildren();
    var metric = element('div', 'sample-metric');
    metric.append(element('span', '', category ? 'Не по критериям' : 'Брак в пробе'), element('strong', '', (category ? st.offSpec : st.defects) + ' из ' + st.checked));
    var other = element('p', 'small muted', category ? 'Брак: ' + st.defects + ' из ' + st.checked : 'Не по критериям: ' + st.offSpec + ' из ' + st.checked);
    var line = element('div', 'risk-line'); line.append(element('span', '', 'Риск среза'), element('strong', 's-' + st.level, riskText(st)));
    target.append(metric, other, line, element('p', 'recommendation', recommendation(st)));
  }
  function decisionText(kind) {
    if (kind === 'wait') return S.batch.rc + ' сети «' + S.batch.chain + '» ждёт машину' + (S.batch.ramp ? ': рампа ' + S.batch.ramp : '') + (S.batch.slotTime ? ', ' + S.batch.slotTime : '') + '.';
    if (kind === 'wait_strict') return S.batch.rc + ' сети «' + S.batch.chain + '» ждёт машину, приёмка усиленная' + (boxesWithFindings().length ? ': сначала проверят ' + palletTargets() : '') + '.';
    return S.batch.rc + ' сети «' + S.batch.chain + '»: досортируйте ' + (boxesWithFindings().length ? palletTargets() : 'партию') + ' до выезда.';
  }
  function finalText(kind) { return kind === 'resort' ? 'Фура ещё на складе: досортировка вместо среза.' : kind === 'wait_strict' ? 'Машина выезжает, РЦ знает, что вскрыть первым.' : 'Машина выезжает, РЦ её ждёт.'; }
  function renderDecision(target) {
    target.hidden = !S.decision; target.replaceChildren();
    if (!S.decision) return;
    target.append(element('p', '', decisionText(S.decision.kind)), element('p', '', finalText(S.decision.kind)), element('p', 'small muted', 'Ваше решение со стороны РЦ, ' + time(S.decision.ts)));
  }
  function canReview() { return Core.allowedDecisions(S).length > 0; }
  function renderSupplier() {
    var st = Core.stats(S), pendingPhoto = S.pending && S.pending.photo;
    $('#sup-count').textContent = st.checked + ' из ' + S.goal;
    $('#sup-progress').max = S.goal; $('#sup-progress').value = st.checked;
    $('#sup-number').parentElement.hidden = !st.checked; $('#sup-other').hidden = !st.checked;
    $('#sup-category').textContent = st.category === 'offspec' ? 'Не по критериям' : 'Брак в пробе';
    $('#sup-number').textContent = (st.category === 'offspec' ? st.offSpec : st.defects) + ' из ' + st.checked;
    $('#sup-other').textContent = st.category === 'offspec' ? 'Брак: ' + st.defects + ' из ' + st.checked : 'Не по критериям: ' + st.offSpec + ' из ' + st.checked;
    $('#sup-risk').textContent = riskText(st); $('#sup-risk').className = 's-' + st.level;
    $('#sup-note').textContent = recommendation(st); money(st, $('#sup-money'));
    $('#sup-cta').textContent = st.needsReview ? 'Проверить отметки в отчёте' : st.done ? 'Посмотреть со стороны РЦ' : pendingPhoto ? 'Продолжить проверку снимка' : 'Проверить плод';
    $('#sup-extend').hidden = !st.done || st.needsReview || st.checked >= 2000 || S.fruits.length >= 2000;
    var extra = Core.extraNeeded(S);
    $('#sup-extend').textContent = 'Расширить пробу: ещё ' + fruitCount(Math.max(1, extra || 10));
    $('#sup-review').hidden = st.done || st.level !== 'high';
    renderDecision($('#sup-decision'));
  }

  function ensurePending() {
    if (S.pending) return S.pending;
    var box = Core.pickBox(S.batch);
    S.pending = { id: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2), n: Core.stats(S).checked + 1, box: { p: box.p, b: box.b }, ts: Date.now(), photo: null, test: false, result: null, reason: null, ms: null };
    event('Apron выбрал: ' + boxText(box) + '. Плод ' + S.pending.n); save();
    return S.pending;
  }
  function stopCamera() {
    cameraAttempt++;
    if (cameraStream) cameraStream.getTracks().forEach(function (t) { t.stop(); });
    cameraStream = null; $('#cam-video').srcObject = null;
  }
  function cameraUnavailable(message) {
    $('#cam-video').hidden = true; $('#cam-empty').hidden = false;
    $('#cam-shot').hidden = true; $('#cam-system').hidden = false;
    $('#cam-status').textContent = message || 'Видоискатель недоступен. Используйте системную камеру.';
  }
  async function startCamera() {
    stopCamera();
    var attempt = cameraAttempt;
    $('#cam-shot').disabled = true; $('#cam-shot').hidden = false; $('#cam-system').hidden = true;
    $('#cam-empty').hidden = true; $('#cam-video').hidden = false;
    $('#cam-status').textContent = 'Запускаем камеру';
    var timeout = setTimeout(function () {
      if (attempt !== cameraAttempt || route !== 'camera') return;
      stopCamera(); cameraUnavailable('Видоискатель не запустился. Снимите плод системной камерой.');
    }, 6000);
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('Камера недоступна по этому адресу.');
      var stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 1280 } } });
      if (attempt !== cameraAttempt || route !== 'camera') { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
      cameraStream = stream; var video = $('#cam-video'); video.srcObject = stream;
      await video.play();
      if (attempt !== cameraAttempt || route !== 'camera') return;
      $('#cam-shot').disabled = false; $('#cam-status').textContent = 'Один плод, ровный свет, без бликов';
    } catch (error) {
      if (attempt !== cameraAttempt || route !== 'camera') return;
      stopCamera();
      cameraUnavailable(error.name === 'NotAllowedError' ? 'Доступ к камере закрыт. Можно снять плод системной камерой.' : 'Камера недоступна. Снимите плод системной камерой.');
    } finally { clearTimeout(timeout); }
  }
  function enterCamera() {
    if (Core.stats(S).done) { go('supplier'); return; }
    var p = ensurePending();
    $('#cam-count').textContent = 'Плод ' + p.n + ' из ' + S.goal;
    $('#cam-box').textContent = 'Apron выбрал: ' + boxText(p.box);
    $('#cam-hint').textContent = cameraMessage || 'Возьмите любой плод из этого ящика. ' + (S.batch.example ? 'Положите его на карточку ящика так, чтобы надпись попала в кадр, и снимите с видимой плодоножкой.' : 'Снимите плод целиком, на светлом фоне, с видимой плодоножкой.');
    $('#cam-hint').classList.toggle('s-high', !!cameraMessage); cameraMessage = '';
    $('#cam-resume').hidden = !p.photo;
    startCamera();
  }
  function loadImage(src) { return new Promise(function (resolve, reject) { var img = new Image(); img.onload = function () { resolve(img); }; img.onerror = function () { reject(new Error('Не удалось открыть фото')); }; img.src = src; }); }
  async function resizePhoto(src, size, quality) {
    var img = await loadImage(src), scale = Math.min(1, size / Math.max(img.naturalWidth, img.naturalHeight));
    var canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(img.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', quality);
  }
  async function capture() {
    var video = $('#cam-video');
    if (!cameraStream || !video.videoWidth || !video.videoHeight) { toast('Камера ещё запускается'); return; }
    $('#cam-shot').disabled = true;
    var canvas = document.createElement('canvas'), scale = Math.min(1, 1024 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    await acceptPhoto(canvas.toDataURL('image/jpeg', 0.85), false);
  }
  async function acceptPhoto(photo, test) {
    var p = ensurePending(); p.photo = photo; p.test = !!test; p.result = null; p.reason = null; p.shotAt = Date.now();
    stopCamera(); save(); await analyze();
  }
  async function readFile(input) {
    var file = input.files && input.files[0]; input.value = '';
    if (!file) return;
    if (file.size > 30 * 1024 * 1024) { toast('Фото слишком большое. Снимите с меньшим разрешением.'); return; }
    var pendingId = ensurePending().id;
    $('#cam-system').classList.add('muted');
    var url = URL.createObjectURL(file);
    try {
      var photo = await resizePhoto(url, 1024, 0.85);
      if (route !== 'camera' || !S.pending || S.pending.id !== pendingId) return;
      await acceptPhoto(photo, false);
    } catch (error) { toast('Не удалось открыть фото. Снимите в формате JPEG.'); }
    finally { URL.revokeObjectURL(url); $('#cam-system').classList.remove('muted'); }
  }
  function cancelAnalysis() { analysisAttempt++; if (controller) controller.abort(); controller = null; }
  function relayURL(path) {
    var url = new URL(path ? new URL(path, new URL(CONFIG.analyzeUrl, location.href)).href : CONFIG.analyzeUrl, location.href);
    if (url.origin !== location.origin && url.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1)$/.test(url.hostname)) throw new Error('Небезопасный адрес модели');
    return url.href;
  }
  // XHR instead of fetch: the upload event tells when the photo has really left the phone.
  function postInspect(url, body, ctrl, onUploaded) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', url); xhr.setRequestHeader('Content-Type', 'application/json'); xhr.responseType = 'text';
      xhr.upload.onload = onUploaded;
      xhr.onload = function () { var payload = null; try { payload = JSON.parse(xhr.responseText); } catch (error) { /* Not JSON: handled below. */ } resolve({ status: xhr.status, payload: payload }); };
      xhr.onerror = function () { reject(new Error('Нет связи с сервисом')); };
      xhr.onabort = function () { reject(Object.assign(new Error('Отменено'), { name: 'AbortError' })); };
      ctrl.signal.addEventListener('abort', function () { xhr.abort(); });
      xhr.send(body);
    });
  }
  async function analyze() {
    var p = S.pending; if (!p || !p.photo) { go('camera'); return; }
    if (!CONFIG.analyzeUrl || p.test) { p.reason = p.test ? 'test' : 'unconnected'; save(); go('nolink'); return; }
    cancelAnalysis(); var attempt = analysisAttempt, started = performance.now();
    var ctrl = new AbortController(); controller = ctrl;
    var timer = setTimeout(function () { ctrl.abort(); }, CONFIG.analyzeTimeoutMs);
    show('analysis'); $('#an-photo').src = p.photo; $('#an-status').textContent = 'Отправляем фото';
    try {
      var answer = await postInspect(relayURL(), JSON.stringify({ image: p.photo, spec: specForBatch(), context: { expected_box: boxText(p.box), fruit: p.n } }), ctrl, function () {
        if (attempt === analysisAttempt && route === 'analysis') $('#an-status').textContent = 'Модель смотрит на плод';
      });
      var payload = answer.payload;
      if (payload && payload.error === 'not_configured') throw Object.assign(new Error('Модель не настроена'), { unconnected: true });
      if (answer.status < 200 || answer.status >= 300 || !payload || payload.ok !== true) throw new Error('Сервис вернул ошибку');
      var result = Core.validateResult(payload.result);
      if (attempt !== analysisAttempt || S.pending !== p) return;
      p.result = result; p.ms = Math.round(performance.now() - started); p.model = typeof payload.model === 'string' ? payload.model.slice(0, 120) : null;
      if (result.verdict === 'bad_photo' || result.verdict === 'not_tomato') {
        p.photo = null;
        cameraMessage = result.verdict === 'not_tomato' ? 'Это не похоже на томат. Снимите плод из ящика ' + p.box.b + '.' : result.retake_hint || result.explanation;
        event('Плод ' + p.n + ': ' + result.title + '. Снимок не засчитан.'); save(); go('camera'); return;
      }
      var label = Core.labelCheck(result.label_text, p.box);
      if (label.status === 'mismatch') {
        p.photo = null; p.result = null;
        cameraMessage = (label.box !== null && label.box !== p.box.b ? 'Это ящик ' + label.box + ', а Apron выбрал ящик ' + p.box.b : 'Это паллета ' + label.pallet + ', а Apron выбрал паллету ' + p.box.p) + ': снимок не засчитан.';
        event('Плод ' + p.n + ': попытка снять не тот ящик. На этикетке «' + result.label_text + '», а Apron выбрал: ' + boxText(p.box) + '.'); save(); go('camera'); return;
      }
      if (result.confidence < CONFIG.minConfidence) { p.reason = 'uncertain'; save(); go('nolink'); return; }
      await commitVerdict(result.verdict, 'model');
    } catch (error) {
      if (attempt !== analysisAttempt || S.pending !== p) return;
      p.reason = error.unconnected ? 'unconnected' : error.name === 'AbortError' ? 'timeout' : 'unavailable'; save(); go('nolink');
    } finally { clearTimeout(timer); if (controller === ctrl) controller = null; }
  }
  async function commitVerdict(verdict, source) {
    var p = S.pending;
    if (!p || !p.photo || resultBusy) return;
    resultBusy = true; $$('#nl-marks button').forEach(function (b) { b.disabled = true; });
    try {
      var photo = await resizePhoto(p.photo, 480, 0.8);
      if (S.pending !== p) return;
      var fruit = { id: p.id, n: p.n, box: p.box, ts: Date.now(), photo: photo, verdict: verdict, source: p.test ? 'test' : source, result: p.result || null, ms: p.ms, model: p.model || null, corrected: false };
      if (p.result) fruit.boxCheck = Core.labelCheck(p.result.label_text, p.box).status === 'confirmed' ? 'confirmed' : 'unconfirmed';
      if (Number.isFinite(p.shotAt) && p.shotAt >= p.ts) fruit.shotDelay = Math.round((p.shotAt - p.ts) / 1000);
      if (!Core.addFruit(S, fruit)) return;
      event('Плод ' + fruit.n + ': ' + TITLES[verdict].toLowerCase() + '. ' + sourceText(fruit));
      lastResultId = fruit.id; save(); go('result');
    } catch (error) { toast('Не удалось сохранить снимок. Попробуйте ещё раз.'); }
    finally { resultBusy = false; $$('#nl-marks button').forEach(function (b) { b.disabled = false; }); }
  }
  function renderModel(result, target) {
    target.replaceChildren(); if (!result) return;
    var labels = { ok: 'В норме', fail: 'Не проходит', warn: 'Отклонение', not_visible: 'По фото не видно' };
    var priority = { fail: 0, warn: 1, ok: 2, not_visible: 3 };
    result.checks.slice().sort(function (a, b) { return priority[a.status] - priority[b.status]; }).forEach(function (check) {
      var row = element('div', 'check-row');
      row.append(element('strong', check.status === 'fail' ? 's-high' : check.status === 'warn' ? 's-medium' : '', check.criterion + ': ' + labels[check.status].toLowerCase()), element('p', '', check.note)); target.append(row);
    });
    if (result.not_visible.length) target.append(element('p', 'model-note', 'По фото не видно: ' + result.not_visible.join(', ') + '.'));
    if (result.note) target.append(element('p', 'model-note', result.note));
  }
  function renderManual() {
    var p = S.pending;
    $('#nl-photo').src = p.photo; $('#nl-count').textContent = 'Плод ' + p.n;
    var uncertain = p.reason === 'uncertain';
    $('#nl-title').textContent = uncertain ? 'Модель не уверена' : p.reason === 'unconnected' ? 'Отметьте плод вручную' : p.reason === 'test' ? 'Тестовый снимок' : 'Модель не ответила';
    $('#nl-text').textContent = uncertain ? p.result.explanation : p.reason === 'unconnected' ? 'Модель пока не подключена. Посмотрите на плод и выберите результат. Фото сохранится в вашей пробе.' : p.reason === 'test' ? 'Подготовленное фото для проверки сценария. Выберите отметку вручную.' : 'Не удалось получить результат. Посмотрите на плод сами и отметьте его или переснимите фото.';
    $('#nl-source').textContent = uncertain ? 'Предложение модели: ' + p.result.title + ', уверенность ' + Math.round(p.result.confidence * 100) + ' %. Итоговую отметку выбираете вы.' : 'Отметка будет видна поставщику и РЦ как ручная.';
    renderModel(uncertain ? p.result : null, $('#nl-model'));
  }
  function resultFruit() { return S.fruits.find(function (f) { return f.id === lastResultId; }) || S.fruits[S.fruits.length - 1]; }
  function renderResult() {
    var f = resultFruit(), st = Core.stats(S);
    $('#res-photo').src = f.photo; $('#res-count').textContent = 'Плод ' + f.n;
    $('#res-title').textContent = f.source === 'model' ? f.result.title : TITLES[f.verdict];
    $('#res-title').className = 'verdict ' + (f.verdict === 'good' ? 's-low' : f.verdict === 'defect' ? 's-high' : 's-medium');
    $('#res-text').textContent = f.source === 'model' ? f.result.explanation : f.verdict === 'good' ? 'Вы отметили плод как годный. Он добавлен в пробу.' : f.verdict === 'defect' ? 'Вы отметили брак. Apron пересчитал риск по вашей пробе.' : 'Плод целый, но вы отметили несоответствие критериям. Оно учитывается отдельно от брака.';
    $('#res-source').textContent = sourceText(f) + '. ' + placeText(f);
    $('#res-correct').textContent = f.source === 'model' ? 'Не согласен с результатом' : 'Изменить отметку';
    renderModel(f.result, $('#res-model'));
    if (f.result && f.source !== 'model') $('#res-model').prepend(element('p', 'model-note', 'Ниже первоначальное наблюдение модели. Итоговая отметка выбрана вручную.'));
    summary($('#res-summary')); $('#res-next').textContent = st.done ? 'Посмотреть со стороны РЦ' : 'Проверить следующий плод';
  }
  function renderRC() {
    var ready = canReview(); $('#rc-waiting').hidden = ready; $('#rc-content').hidden = !ready;
    if (!ready) return;
    summary($('#rc-summary')); money(Core.stats(S), $('#rc-money')); renderDecision($('#rc-decision'));
    var latest = S.fruits[S.fruits.length - 1], wrap = $('#rc-latest'); wrap.replaceChildren();
    if (latest) {
      var figure = element('div', 'latest-photo');
      if (latest.photo) { var img = element('img'); img.src = latest.photo; img.alt = 'Последний проверенный плод'; figure.append(img); }
      else figure.append(element('p', 'small muted', 'Фото недоступно'));
      figure.append(element('p', '', 'Плод ' + latest.n + ': ' + (latest.source === 'model' ? latest.result.title : TITLES[latest.verdict]).toLowerCase()), element('p', 'muted', sourceText(latest) + '. ' + placeText(latest)));
      if (latest.source === 'model') figure.append(element('p', '', latest.result.explanation)); wrap.append(figure);
    }
    var buttons = $('#rc-decisions'); buttons.replaceChildren();
    var names = { wait: 'Ждём машину', wait_strict: 'Ждём, приёмка усиленная', resort: 'Вернуть на досортировку' };
    Core.allowedDecisions(S).forEach(function (kind, i) {
      var b = element('button', i === 0 ? 'btn' : 'btn-line', names[kind]); b.type = 'button'; b.dataset.decision = kind;
      b.setAttribute('aria-pressed', String(!!S.decision && S.decision.kind === kind)); buttons.append(b);
    });
    if (S.decision) buttons.prepend(element('p', 'small muted', 'Можно изменить решение. Действует последнее.'));
    var events = $('#rc-events'); events.replaceChildren();
    S.events.slice().reverse().slice(0, 10).forEach(function (e) { var li = element('li'); var stamp = element('time', '', time(e.ts)); stamp.dateTime = new Date(e.ts).toISOString(); li.append(stamp, element('span', '', e.text)); events.append(li); });
  }
  function renderReport() {
    summary($('#report-summary'));
    var st = Core.stats(S), interval = Core.wilson(st.defects, st.checked);
    $('#report-interval').hidden = !st.checked;
    $('#report-interval').textContent = 'Брак: ' + st.defects + ' из ' + st.checked + '. Интервал Уилсона 95 %: ' + decimal.format(interval[0] * 100) + '-' + decimal.format(interval[1] * 100) + ' % при случайном отборе плодов.';
    var hints = boxesWithFindings().length ? ['Первыми вскройте: ' + boxesWithFindings().map(boxText).join('; ') + '. В этих местах в пробе есть брак или отклонения.'] : ['В проверенной части пробы брак и отклонения не отмечены.'];
    var modelHints = S.fruits.filter(function (f) { return f.verdict !== 'good' && f.source === 'model' && f.result && f.result.rc_hint; }).map(function (f) { return f.result.rc_hint; });
    hints = hints.concat(Array.from(new Set(modelHints)).slice(0, 3).map(function (h) { return /[.!?]$/.test(h) ? h : h + '.'; }), ['Сверьте пломбу. Вскройте 3 своих случайных места.']);
    $('#report-hints').textContent = hints.join(' ');
    var photos = $('#report-photos'); photos.replaceChildren();
    if (!S.fruits.length) photos.append(element('p', 'note', 'Ваших снимков пока нет.'));
    S.fruits.forEach(function (f) {
      var item = element('article', 'fruit-item');
      if (f.photo) { var image = element('img'); image.src = f.photo; image.alt = 'Плод ' + f.n + ': ' + TITLES[f.verdict].toLowerCase(); image.loading = 'lazy'; item.append(image); }
      else item.append(element('div', 'photo-missing', 'Фото недоступно'));
      var info = element('div'); info.append(element('h3', '', 'Плод ' + f.n + ': ' + TITLES[f.verdict].toLowerCase()), element('p', '', placeText(f)), element('p', '', sourceText(f)), element('p', '', time(f.ts)));
      if (f.needsReview) info.append(element('p', 's-medium', 'Условия изменились. Подтвердите результат по новым требованиям.'));
      var edit = element('button', 'text-link', f.needsReview ? 'Подтвердить отметку' : 'Исправить отметку'); edit.type = 'button'; edit.dataset.edit = f.id; edit.setAttribute('aria-label', (f.needsReview ? 'Подтвердить' : 'Исправить') + ' отметку плода ' + f.n); info.append(edit); item.append(info); photos.append(item);
    });
    $('#report-back').textContent = canReview() ? 'К решению РЦ' : 'Продолжить проверку партии';
    var card = CONFIG.modelCard;
    $('#model-card').hidden = !(card.model && Number.isInteger(card.checked) && card.checked > 0 && Number.isInteger(card.agreed) && Number.isFinite(card.p90));
    if (!$('#model-card').hidden) $('#model-card').textContent = 'Проверка модели ' + card.model + ': на ' + card.checked + ' наших фото совпала с нами в ' + card.agreed + '. 9 ответов из 10 быстрее ' + card.p90 + ' с.';
  }

  var MEASUREMENTS = [
    ['temperature', 'Температура', '°C', 'термощуп'], ['caliber', 'Калибр', 'мм', 'линейка'], ['mass', 'Масса нетто', 'кг', 'весы'], ['firmness', 'Твёрдость', 'кг/см²', 'пенетрометр'], ['brix', 'Сахаристость', '°Bx', 'рефрактометр'], ['nitrates', 'Нитраты', 'мг/кг', 'прибор']
  ];
  var DOCUMENTS = [['declaration', 'Декларация соответствия'], ['quality', 'Паспорт качества'], ['lab', 'Протокол испытаний'], ['shipment', 'ТТН и УПД'], ['labels', 'Маркировка и даты']];
  function filesFor(key) { return documentBatch === S.batch.id ? documentFiles.filter(function (f) { return f.category === key; }) : []; }
  function releaseDocumentURLs(records) {
    var ids = new Set(records.map(function (r) { return r.id; }));
    documentURLs.forEach(function (url, id) { if (!ids.has(id)) { URL.revokeObjectURL(url); documentURLs.delete(id); } });
  }
  function fileURL(record) {
    if (!documentURLs.has(record.id)) documentURLs.set(record.id, URL.createObjectURL(record.blob));
    return documentURLs.get(record.id);
  }
  function fileList(records, editable, category) {
    var list = element('ul', 'document-files');
    records.forEach(function (record) {
      var li = element('li', 'document-file'), info = element('div', 'document-file-info'), actions = element('div', 'document-file-actions');
      info.append(element('p', 'document-filename', record.name), element('span', 'small muted', Docs.sizeText(record.size)));
      if (record.type === 'application/pdf' || record.type.startsWith('image/')) {
        var open = element('a', 'text-link', 'Открыть'); open.href = fileURL(record); open.target = '_blank'; open.rel = 'noopener noreferrer'; open.setAttribute('aria-label', 'Открыть ' + record.name); actions.append(open);
      }
      var download = element('a', 'text-link', 'Скачать'); download.href = fileURL(record); download.download = record.name; download.setAttribute('aria-label', 'Скачать ' + record.name); actions.append(download);
      if (editable) {
        var replace = element('button', 'text-link', 'Заменить'); replace.type = 'button'; replace.dataset.docReplace = record.id; replace.dataset.docCategory = category; replace.disabled = documentBusy; replace.setAttribute('aria-label', 'Заменить ' + record.name);
        var remove = element('button', 'text-link', 'Удалить'); remove.type = 'button'; remove.dataset.docRemove = record.id; remove.dataset.docCategory = category; remove.disabled = documentBusy; remove.setAttribute('aria-label', 'Удалить ' + record.name); actions.append(replace, remove);
      }
      li.append(info, actions); list.append(li);
    });
    return list;
  }
  function ensureDocuments(force) {
    var id = S.batch.id;
    if (documentBatch === id && !force) return Promise.resolve(documentFiles);
    if (documentLoad && documentLoad.id === id) return documentLoad.promise;
    var job = { id: id, promise: null }; documentLoad = job; documentLoadError = '';
    job.promise = Docs.list(id).then(function (records) {
      if (S.batch.id === id) { documentBatch = id; documentFiles = records; documentLoadError = ''; releaseDocumentURLs(records); }
      return records;
    }).catch(function (error) {
      if (S.batch.id === id) documentLoadError = 'Не удалось прочитать файлы. ' + (error && error.message || 'Хранилище недоступно.');
      throw error;
    }).finally(function () { if (documentLoad === job) documentLoad = null; });
    return job.promise;
  }
  function renderDocumentEditor() {
    var target = $('#document-editor'); target.replaceChildren();
    DOCUMENTS.forEach(function (d) {
      var records = documentDraft ? documentDraft.filter(function (r) { return r.category === d[0]; }) : [];
      var section = element('section', 'document-item'), label = element('label', 'check-label'), input = document.createElement('input');
      input.type = 'checkbox'; input.name = d[0]; input.checked = !!documentManualDraft[d[0]] || records.length > 0; input.disabled = records.length > 0 || documentBusy;
      input.addEventListener('change', function () { documentManualDraft[d[0]] = this.checked; });
      label.append(input, document.createTextNode(d[1])); section.append(label);
      section.append(element('p', 'document-hint', records.length ? 'Файлов: ' + records.length + '. Наличие учтено по приложению.' : documentManualDraft[d[0]] ? 'Отмечено вручную. Файл не приложен.' : 'Файл не приложен.'));
      if (records.length) section.append(fileList(records, true, d[0]));
      var add = element('button', 'text-link', records.length ? 'Добавить ещё файл' : 'Прикрепить файл'); add.type = 'button'; add.id = 'doc-add-' + d[0]; add.dataset.docAdd = d[0]; add.disabled = !documentDraft || documentBusy || records.length >= Docs.MAX_FILES; add.setAttribute('aria-label', 'Добавить файл: ' + d[1]); section.append(add); target.append(section);
    });
  }
  function loadDocumentDraft() {
    var draftId = ++documentDraftId, batchId = S.batch.id;
    documentDraft = null; documentBaseline = []; documentBusy = false; documentPicker = null; documentManualDraft = Object.assign({}, S.batch.documents);
    $('#documents-status').textContent = 'Читаем документы партии'; $('#measurements-save').disabled = true; renderDocumentEditor();
    ensureDocuments(true).then(function (records) {
      if (route !== 'measurements' || draftId !== documentDraftId || S.batch.id !== batchId) return;
      documentDraft = records.slice(); documentBaseline = records.map(function (r) { return r.id; });
      $('#documents-status').textContent = 'Файлы хранятся на этом устройстве и доступны в отчёте РЦ.'; renderDocumentEditor(); renderBatchInfo();
    }).catch(function () {
      if (route !== 'measurements' || draftId !== documentDraftId || S.batch.id !== batchId) return;
      $('#documents-status').textContent = documentLoadError + ' Можно сохранить замеры и ручные отметки без изменения файлов.'; renderDocumentEditor();
    }).finally(function () { if (draftId === documentDraftId) $('#measurements-save').disabled = false; });
  }
  function pickDocument(category, replaceId) {
    if (!documentDraft || documentBusy) return;
    documentPicker = { category: category, replaceId: replaceId || null, draftId: documentDraftId, batchId: S.batch.id };
    var input = $('#document-file'); input.accept = Docs.ACCEPT; input.multiple = !replaceId; input.value = ''; input.click();
  }
  async function receiveDocuments(input) {
    var selected = Array.from(input.files || []), picker = documentPicker; input.value = '';
    if (!selected.length || !picker || !documentDraft) return;
    var active = function () { return route === 'measurements' && picker.draftId === documentDraftId && picker.batchId === S.batch.id; };
    documentBusy = true; $('#measurements-save').disabled = true; $('#measurements-error').hidden = true; $('#documents-status').textContent = 'Проверяем выбранные файлы'; renderDocumentEditor();
    try {
      var remaining = documentDraft.filter(function (r) { return r.id !== picker.replaceId; });
      if ((picker.replaceId && selected.length !== 1) || remaining.filter(function (r) { return r.category === picker.category; }).length + selected.length > Docs.MAX_FILES) throw new Error('К одному пункту можно приложить до 10 файлов. Для замены выберите один файл.');
      var prepared = await Promise.all(selected.map(function (file) { return Docs.prepare(file, picker.batchId, picker.category); }));
      if (!active()) return;
      documentDraft = remaining.concat(prepared);
      $('#documents-status').textContent = 'Файлы выбраны. Нажмите «Сохранить замеры и документы», чтобы приложить их к партии.';
    } catch (error) {
      if (!active()) return;
      $('#measurements-error').hidden = false; $('#measurements-error').textContent = error.message;
      $('#documents-status').textContent = 'Выбранные файлы не добавлены. Прежние документы сохранены.';
    } finally {
      if (active()) { documentBusy = false; $('#measurements-save').disabled = false; renderDocumentEditor(); $('#doc-add-' + picker.category).focus({ preventScroll: true }); }
    }
  }
  function support(target) {
    target.replaceChildren(); var b = S.batch;
    var groups = [
      ['Замеры поставщика', MEASUREMENTS.map(function (m) { return [m[1], b.measurements[m[0]] === null ? 'Не измеряли' : precise.format(b.measurements[m[0]]) + ' ' + m[2], b.example && b.measurementsExample !== false ? 'Пример показаний, ' + m[3] : 'Введено поставщиком, ' + m[3]]; })],
      ['Документы', DOCUMENTS.map(function (d) { var files = filesFor(d[0]); return [d[1], files.length ? 'Файлов: ' + files.length : b.documents[d[0]] ? 'Отмечено' : documentBatch !== b.id ? documentLoadError ? 'Недоступно' : 'Читаем файлы' : 'Не приложено', files.length ? 'Файлы приложены поставщиком' : documentLoadError ? 'Файлы пока недоступны' : 'Наличие отмечает поставщик']; })],
      ['Упаковка и рейс', [['Паллеты и тара', b.packaging ? 'Проверены' : 'Не отмечено', 'Отметка поставщика'], ['Паллет в партии', String(b.pallets), 'Данные партии'], ['Выезд', b.departure || 'Не указан', 'Расписание поставщика'], ['Прибытие', b.arrival || 'Не указано', 'Расписание поставщика']]]
    ];
    groups.forEach(function (g) { var group = element('section', 'support-group'); group.append(element('h3', '', g[0])); g[1].forEach(function (r, i) { var row = element('div', 'row'), left = element('span', 'row-l'); left.append(element('span', 'row-t', r[0]), element('span', 'row-s', r[2])); row.append(left, element('span', 'row-v', r[1])); group.append(row); if (g[0] === 'Документы') { var files = filesFor(DOCUMENTS[i][0]); if (files.length) group.append(fileList(files, false)); } }); target.append(group); });
  }
  function method(target) {
    target.replaceChildren();
    [
      'Риск показывает, насколько вероятно превышение допуска по результатам пробы. Ваши допуски: брак ' + precise.format(S.batch.tolerance.defect) + ' %, несоответствие критериям ' + precise.format(S.batch.tolerance.offspec) + ' %. Их можно изменить в данных партии.',
      'Для каждой категории считаем Beta(k + 0,5; n - k + 0,5), где k - число отклонений, n - число проверенных плодов. Общий показатель - больший из двух рисков, а не вероятность любого нарушения. Ниже 15 % - низкий, от 15 до 25 % - заметный, от 25 % - высокий.',
      'Результат зависит от отбора пробы. Берите плоды из разных мест без предварительной сортировки. Расчёт предполагает независимые наблюдения, не учитывает скрытые дефекты и изменения в дороге. Окончательная приёмка остаётся за РЦ.',
      'Фото показывает одну сторону плода. Твёрдость, сахаристость и нитраты вносятся по приборам; калибр без эталона по фото не определяем.'
    ].forEach(function (p) { target.append(element('p', '', p)); });
  }
  function openBatchEditor(create) {
    editingNew = !!create; draftBatch = create ? Core.defaultBatch(false) : JSON.parse(JSON.stringify(S.batch));
    if (!create) draftBatch.sampleTotal = S.goal;
    if (create) draftBatch.code = 'П-' + new Date().toLocaleDateString('ru-RU').replace(/\./g, '') + '-' + Math.random().toString(36).slice(2, 5).toUpperCase();
    go('batch-edit');
  }
  function fillBatchForm() {
    if (!draftBatch) { editingNew = false; draftBatch = JSON.parse(JSON.stringify(S.batch)); draftBatch.sampleTotal = S.goal; }
    var f = $('#batch-form');
    ['code', 'product', 'supplier', 'chain', 'rc', 'weight', 'revenue', 'sampleTotal', 'grade', 'rules', 'pallets', 'boxesPerPallet', 'departure', 'arrival', 'distance', 'ramp', 'slotTime'].forEach(function (k) { f.elements[k].value = draftBatch[k] === null ? '' : draftBatch[k]; });
    f.elements.defectTolerance.value = draftBatch.tolerance.defect; f.elements.offspecTolerance.value = draftBatch.tolerance.offspec;
    f.elements.sampleTotal.min = editingNew ? 1 : Math.max(1, Core.stats(S).checked);
    $('#batch-form-title').textContent = editingNew ? 'Новая партия' : 'Изменить партию';
    $('#batch-save').textContent = editingNew ? 'Создать и начать проверку' : 'Сохранить изменения';
    $('#sample-size-help').textContent = editingNew ? 'Проверка начнётся с первого плода.' : 'Проверено ' + Core.stats(S).checked + '. Снимки сохранятся, риск пересчитается по новым допускам.';
    $('#batch-form-error').hidden = true;
  }
  function fillMeasurements() {
    var f = $('#measurements-form');
    MEASUREMENTS.forEach(function (m) { var v = S.batch.measurements[m[0]]; f.elements[m[0]].value = v === null ? '' : v; });
    f.elements.packaging.checked = S.batch.packaging; $('#measurements-error').hidden = true;
    loadDocumentDraft();
  }
  function renderLibrary() {
    var list = $('#batch-list'); list.replaceChildren(); var batches = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i); if (!key || !key.startsWith(LIBRARY_PREFIX)) continue;
        try { var item = Core.restore(localStorage.getItem(key)); batches.push(item); } catch (error) { /* Other damaged records do not block this party. */ }
      }
    } catch (error) { list.append(element('p', 'note', 'Сохранение в браузере недоступно. Текущая партия остаётся в этой вкладке.')); }
    if (!S.batch.example && !batches.some(function (item) { return item.batch.id === S.batch.id; })) batches.push(S);
    batches.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    if (!batches.length) list.append(element('p', 'empty-state', 'Здесь будут ваши партии. Создайте первую или посмотрите, как устроена проверка, на примере.'));
    batches.forEach(function (item) {
      var b = element('button', 'batch-item'); b.type = 'button'; b.dataset.openBatch = item.batch.id;
      b.append(element('strong', '', item.batch.product + ', ' + precise.format(item.batch.weight) + ' т'), element('span', 'small muted', item.batch.code + '. ' + item.batch.supplier), element('span', 'small', 'Проверено ' + Core.stats(item).checked + ' из ' + item.goal + (item.decision ? '. Решение РЦ сохранено' : ''))); list.append(b);
    });
  }
  function toast(text) { var t = $('#toast'); t.textContent = text; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 4000); }
  function normalizeRoute(r) {
    if (['supplier', 'camera', 'analysis', 'nolink', 'result', 'rc', 'passport', 'batch-edit', 'measurements', 'batches'].indexOf(r) < 0) return 'supplier';
    if (r === 'analysis') return S.pending && S.pending.photo ? 'nolink' : 'supplier';
    if (r === 'nolink' && !(S.pending && S.pending.photo)) return 'supplier';
    if (r === 'result' && !S.fruits.length) return 'supplier';
    if (r === 'rc' && !canReview()) return 'supplier';
    return r;
  }
  function show(r) {
    if (r !== 'analysis') r = normalizeRoute(r);
    if (route === 'analysis' && r !== 'analysis') cancelAnalysis();
    if (r !== 'camera') stopCamera();
    if (r !== 'measurements') { documentDraftId++; documentDraft = null; documentPicker = null; documentBusy = false; releaseDocumentURLs(documentBatch === S.batch.id ? documentFiles : []); }
    route = r;
    if (location.hash !== '#' + r) history.replaceState(null, '', location.pathname + location.search + '#' + r);
    $$('.screen').forEach(function (screen) { screen.classList.toggle('active', screen.id === 's-' + r); });
    renderBatchInfo();
    if (r === 'batch-edit') fillBatchForm();
    if (r === 'measurements') fillMeasurements();
    if (r === 'batches') renderLibrary();
    if (r === 'supplier') renderSupplier();
    if (r === 'camera') enterCamera();
    if (r === 'nolink') renderManual();
    if (r === 'result') renderResult();
    if (r === 'rc') { S.role = 'rc'; save(); renderRC(); }
    if (r === 'passport') renderReport();
    window.scrollTo(0, 0);
    var heading = $('#s-' + r + ' h1'); if (heading) heading.focus({ preventScroll: true });
    var batchId = S.batch.id;
    ensureDocuments(r !== 'measurements').then(function () { if (S.batch.id === batchId) renderBatchInfo(); }).catch(function () { if (S.batch.id === batchId) renderBatchInfo(); });
  }
  function go(r) {
    var target = normalizeRoute(r);
    if ((r === 'rc' || r === 'passport') && target === 'supplier') toast('Сначала завершите пробу со стороны поставщика');
    if (location.hash !== '#' + target) { history.pushState(null, '', location.pathname + location.search + '#' + target); }
    show(target);
  }
  function review() { if (!canReview()) return; if (S.pending && !S.pending.photo) S.pending = null; S.role = 'rc'; save(); go('rc'); }
  function openCorrection(id) { lastResultId = id; $('#correction-dialog').showModal(); }
  async function requestWakeLock() {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible' || (wakeLock && !wakeLock.released)) return;
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch (error) { /* Optional on unsupported or power-saving devices. */ }
  }
  async function checkRelay() {
    var target = $('#tools-model');
    if (!CONFIG.analyzeUrl) { target.textContent = 'Модель не подключена: адрес relay не задан. Доступна ручная отметка.'; return; }
    target.textContent = 'Проверяем связь с моделью';
    var ctrl = new AbortController(), timer = setTimeout(function () { ctrl.abort(); }, 5000), started = performance.now();
    try {
      var response = await fetch(relayURL('health'), { cache: 'no-store', signal: ctrl.signal });
      var payload = await response.json().catch(function () { return null; }), ms = Math.round(performance.now() - started);
      target.textContent = payload && payload.ok === true && typeof payload.model === 'string' ? 'Модель ' + payload.model.slice(0, 80) + ': связь есть, relay ответил за ' + ms + ' мс.' : payload && payload.error === 'not_configured' ? 'Relay доступен, но модель не настроена: нет провайдера, модели или ключа.' : 'Relay ответил ошибкой ' + response.status + '.';
    } catch (error) { target.textContent = 'Relay не отвечает. Плоды можно отметить вручную.'; }
    finally { clearTimeout(timer); }
  }
  function openTools() { $('#tools').showModal(); checkRelay(); }

  document.addEventListener('click', function (e) {
    var button = e.target.closest('button'); if (!button) return;
    if (button.dataset.docAdd) { pickDocument(button.dataset.docAdd); return; }
    if (button.dataset.docReplace) { pickDocument(button.dataset.docCategory, button.dataset.docReplace); return; }
    if (button.dataset.docRemove) {
      if (documentDraft && !documentBusy) {
        documentDraft = documentDraft.filter(function (r) { return r.id !== button.dataset.docRemove; }); renderDocumentEditor();
        $('#documents-status').textContent = 'Файл убран из списка. Сохраните изменения или нажмите «Отменить», чтобы вернуть его.';
        $('#doc-add-' + button.dataset.docCategory).focus({ preventScroll: true });
      }
      return;
    }
    if (button.hasAttribute('data-new')) { openBatchEditor(true); return; }
    if (button.dataset.openBatch) {
      if (button.dataset.openBatch !== S.batch.id) { try { S = Core.restore(localStorage.getItem(LIBRARY_PREFIX + button.dataset.openBatch)); } catch (error) { toast('Не удалось открыть партию'); return; } }
      lastResultId = null; draftBatch = null; save(); go('supplier'); return;
    }
    if (button.dataset.go) { go(button.dataset.go); return; }
    if (button.dataset.close) { $('#' + button.dataset.close).close(); return; }
    if (button.hasAttribute('data-reset')) { if ($('#tools').open) $('#tools').close(); $('#reset-dialog').showModal(); return; }
    if (button.dataset.mark) { commitVerdict(button.dataset.mark, 'manual'); return; }
    if (button.dataset.edit) { openCorrection(button.dataset.edit); return; }
    if (button.dataset.correct) {
      var f = Core.correctFruit(S, lastResultId, button.dataset.correct);
      event('Плод ' + f.n + ': отметка исправлена на «' + TITLES[f.verdict].toLowerCase() + '». Решение РЦ требует повторного выбора.');
      save(); $('#correction-dialog').close(); show(route); toast('Отметка исправлена, проба пересчитана'); return;
    }
    if (button.dataset.decision) {
      var kind = button.dataset.decision; if (Core.allowedDecisions(S).indexOf(kind) < 0) return;
      S.decision = { kind: kind, ts: Date.now() }; event(decisionText(kind)); save(); renderRC(); $('#rc-decision').setAttribute('tabindex', '-1'); $('#rc-decision').focus({ preventScroll: true }); toast('Решение сохранено. Поставщик видит ваш ответ.');
    }
  });
  $('#edit-batch').addEventListener('click', function () { openBatchEditor(false); });
  $('#new-batch').addEventListener('click', function () { openBatchEditor(true); });
  $('#report-back').addEventListener('click', function () { go(canReview() ? 'rc' : 'supplier'); });
  $('#open-example').addEventListener('click', function () { cancelAnalysis(); stopCamera(); S = Core.baseState(); draftBatch = null; lastResultId = null; save(); go('supplier'); });
  $('#batch-form').addEventListener('submit', function (e) {
    e.preventDefault(); var form = this, b = JSON.parse(JSON.stringify(draftBatch));
    ['code', 'product', 'supplier', 'chain', 'rc', 'grade', 'rules', 'departure', 'arrival', 'ramp', 'slotTime'].forEach(function (k) { b[k] = form.elements[k].value.trim(); });
    ['weight', 'sampleTotal', 'pallets', 'boxesPerPallet', 'revenue', 'distance'].forEach(function (k) { b[k] = form.elements[k].value === '' ? null : Number(form.elements[k].value); });
    b.tolerance = { defect: Number(form.elements.defectTolerance.value), offspec: Number(form.elements.offspecTolerance.value) };
    try {
      Core.validateBatch(b);
      if (editingNew) { cancelAnalysis(); stopCamera(); S = Core.baseState(false); S.batch = b; S.goal = b.sampleTotal; event('Создана партия ' + b.code); }
      else { Core.updateBatch(S, b); event('Данные партии обновлены. Риск пересчитан по текущим допускам.'); }
      draftBatch = null; lastResultId = null; save(); go('supplier'); toast(editingNew ? 'Партия создана. Можно начинать проверку.' : 'Изменения сохранены');
    } catch (error) { $('#batch-form-error').hidden = false; $('#batch-form-error').textContent = error.message; $('#batch-form-error').scrollIntoView({ block: 'center' }); }
  });
  $('#measurements-form').addEventListener('submit', async function (e) {
    e.preventDefault(); if (documentBusy || measurementsSaving) return;
    var f = this, b = JSON.parse(JSON.stringify(S.batch)), state = S, records = documentDraft && documentDraft.slice(), baseline = documentBaseline.slice();
    MEASUREMENTS.forEach(function (m) { b.measurements[m[0]] = f.elements[m[0]].value === '' ? null : Number(f.elements[m[0]].value); });
    b.documents = Object.assign({}, documentManualDraft); b.packaging = f.elements.packaging.checked; b.measurementsExample = false;
    try {
      Core.validateBatch(b); measurementsSaving = true;
      $$('#s-measurements button, #measurements-form input').forEach(function (n) { n.disabled = true; }); $('#measurements-save').textContent = 'Сохраняем';
      if (records) {
        if (!save(true)) throw new Error('Не удалось сохранить данные партии в браузере. Документы не изменены; освободите место и попробуйте ещё раз.');
        await Docs.commit(b.id, records, baseline);
        if (S !== state) return;
        documentBatch = b.id; documentFiles = records; releaseDocumentURLs(records);
      }
      S.batch = b; S.decision = null; event('Замеры и документы обновлены'); var saved = save(); go('supplier');
      toast(saved ? 'Замеры и документы сохранены' : 'Файлы сохранены. Не удалось сохранить часть данных партии.');
    } catch (error) {
      $('#measurements-error').hidden = false; $('#measurements-error').textContent = error.name === 'QuotaExceededError' ? 'Недостаточно места для документов. Уменьшите файлы или удалите ненужные. Прежние документы не изменены.' : error.message;
      $('#measurements-error').scrollIntoView({ block: 'center' });
    } finally {
      measurementsSaving = false; $$('#s-measurements button, #measurements-form input').forEach(function (n) { n.disabled = false; }); $('#measurements-save').textContent = 'Сохранить замеры и документы';
      if (route === 'measurements') renderDocumentEditor();
    }
  });
  $('#document-file').addEventListener('change', function () { receiveDocuments(this); });
  $('#sup-cta').addEventListener('click', function () { var st = Core.stats(S); if (st.needsReview) go('passport'); else if (st.done) review(); else if (S.pending && S.pending.photo) analyze(); else go('camera'); });
  $('#sup-review').addEventListener('click', review);
  $('#sup-extend').addEventListener('click', function () { var st = Core.stats(S), extra = Math.max(1, Core.extraNeeded(S) || 10); S.goal = Math.min(2000, st.checked + extra); S.decision = null; event('Проба расширена до ' + S.goal + ' плодов'); save(); go('camera'); });
  $('#cam-shot').addEventListener('click', capture);
  $('#cam-file').addEventListener('change', function () { readFile(this); });
  $('#cam-resume').addEventListener('click', analyze);
  $('#nl-retry').addEventListener('click', function () { if (S.pending) { S.pending.photo = null; S.pending.result = null; S.pending.test = false; S.pending.reason = null; save(); } go('camera'); });
  $('#an-cancel').addEventListener('click', function () { cancelAnalysis(); go('supplier'); });
  $('#res-next').addEventListener('click', function () { if (Core.stats(S).done) review(); else go('camera'); });
  $('#res-correct').addEventListener('click', function () { openCorrection(resultFruit().id); });
  $('#reset-confirm').addEventListener('click', function () { cancelAnalysis(); stopCamera(); Core.resetSample(S); lastResultId = null; cameraMessage = ''; $('#reset-dialog').close(); save(); go('supplier'); toast('Новая проба готова. Начните с первого плода.'); });
  $('#test-photo').addEventListener('click', async function () {
    if (Core.stats(S).done) { toast('Сначала расширьте или сбросьте пробу'); return; }
    $('#tools').close();
    try { var photo = await resizePhoto('assets/test-tomato.jpg', 1024, 0.85); await acceptPhoto(photo, true); }
    catch (error) { toast('Тестовое фото недоступно'); }
  });
  if (params.get('demo') === '1') {
    $$('.wordmark').filter(function (w) { return w.tagName === 'BUTTON'; }).forEach(function (wordmark) {
      var timer;
      wordmark.addEventListener('pointerdown', function () { timer = setTimeout(openTools, 2000); });
      ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (name) { wordmark.addEventListener(name, function () { clearTimeout(timer); }); });
      wordmark.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTools(); } });
      wordmark.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    });
  }
  window.addEventListener('popstate', function () { show(location.hash.slice(1)); });
  window.addEventListener('hashchange', function () { show(location.hash.slice(1)); });
  document.addEventListener('visibilitychange', function () { if (document.hidden) stopCamera(); else { requestWakeLock(); if (route === 'camera') startCamera(); } });
  document.addEventListener('pointerdown', requestWakeLock, { once: true });
  $$('.tools').forEach(function (dialog) { dialog.addEventListener('click', function (e) { if (e.target === dialog) { var r = dialog.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close(); } }); });

  $('#browser-hint').hidden = !/Telegram|VKClient|VKAndroidApp|VKCOM/i.test(navigator.userAgent);
  if (params.has('selftest')) {
    var test = element('pre', 'selftest');
    try { test.textContent = 'Самопроверка пройдена\n' + Core.selftest().join('\n'); console.info(test.textContent); }
    catch (error) { test.textContent = 'Ошибка самопроверки: ' + error.message; console.error(error); }
    document.body.prepend(test);
  }
  // All fresh links, including legacy QR links with role/room, start as supplier.
  // A completed personal session may return to its report after a reload.
  var initial = location.hash.slice(1);
  if (!S.fruits.length && !S.pending) initial = 'supplier';
  if (!initial) initial = S.role === 'rc' && canReview() ? 'rc' : 'supplier';
  show(normalizeRoute(initial));
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', function () { navigator.serviceWorker.register('./sw.js').catch(function () { /* Online flow still works if offline caching is unavailable. */ }); });
  }
})();
