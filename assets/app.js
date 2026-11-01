(function () {
  'use strict';
  var Core = window.ApronCore, CONFIG = Core.CONFIG;
  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.from(document.querySelectorAll(s)); };
  var params = new URLSearchParams(location.search);
  var STORE_KEY = 'apron-personal-sample-v2';
  var TITLES = { good: 'Годен', offspec: 'Не по критериям', defect: 'Брак' };
  var LEVELS = { low: 'низкий', medium: 'заметный', high: 'высокий' };
  var REASONS = { manual: 'Отмечено вручную', test: 'Тест, отмечено вручную', model: 'Модель' };
  var route = '', lastResultId = null, cameraStream = null, cameraAttempt = 0, analysisAttempt = 0, controller = null;
  var cameraMessage = '', toastTimer = null, wakeLock = null, resultBusy = false;
  var number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
  var decimal = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
  var S = Core.baseState();
  try { var stored = sessionStorage.getItem(STORE_KEY); if (stored) S = Core.restore(stored); }
  catch (error) { $('#storage-warning').hidden = false; $('#storage-warning').textContent = 'Сохранённая проба недоступна. Начинаем новую проверку в этой вкладке.'; }

  function element(tag, className, text) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function save() {
    try { sessionStorage.setItem(STORE_KEY, JSON.stringify(S)); $('#storage-warning').hidden = true; }
    catch (error) { $('#storage-warning').hidden = false; $('#storage-warning').textContent = 'Не удалось сохранить пробу. Оставьте эту вкладку открытой.'; }
  }
  function event(text) { S.events.push({ text: text, ts: Date.now() }); S.events = S.events.slice(-30); }
  function boxText(box) { return 'паллета ' + box.p + ', ящик ' + box.b; }
  function time(ts) { return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); }
  function riskText(st) { return Math.round(st.risk * 100) + ' %, ' + LEVELS[st.level]; }
  function fruitCount(n) { var mod = n % 100; return n + ' ' + (mod >= 11 && mod <= 14 ? 'плодов' : n % 10 === 1 ? 'плод' : n % 10 >= 2 && n % 10 <= 4 ? 'плода' : 'плодов'); }
  function sourceText(f) {
    if (f.source !== 'model') return REASONS[f.source] + (f.corrected ? ', исправление' : '');
    return 'Модель, уверенность ' + Math.round(f.result.confidence * 100) + ' %. Ответ за ' + decimal.format(f.ms / 1000) + ' с';
  }
  function boxesWithFindings() {
    var boxes = CONFIG.seed.defectBoxes.slice();
    S.fruits.filter(function (f) { return f.verdict !== 'good'; }).forEach(function (f) { if (!boxes.some(function (b) { return b.p === f.box.p && b.b === f.box.b; })) boxes.push(f.box); });
    return boxes;
  }
  function palletTargets() { var ids = Array.from(new Set(boxesWithFindings().map(function (b) { return b.p; }))); return (ids.length === 1 ? 'паллету ' : 'паллеты ') + ids.join(', '); }
  function recommendation(st) {
    if (st.level === 'low') return st.done ? 'Можно отгружать по результатам пробы. Окончательное решение после приёмки РЦ.' : 'Осталось проверить ' + fruitCount(Math.max(0, S.goal - st.checked)) + '.';
    var extra = Core.extraNeeded(S), noun = st.category === 'offspec' ? 'отклонений' : 'брака';
    var action = extra === null ? 'Расширьте пробу' : 'Проверьте ещё ' + extra + ' плодов без брака и отклонений';
    return (st.level === 'high' ? 'Не отгружайте как есть. ' : '') + action + ' или досортируйте ' + palletTargets() + '. Риск рассчитан по доле ' + noun + '.';
  }
  function money(st, target) {
    target.hidden = st.level === 'low';
    var tolerance = CONFIG.tolerance.defect;
    var cut = Math.max(0, CONFIG.money.foundPercent - tolerance) / 100 * CONFIG.money.revenue;
    target.textContent = 'Партия ' + number.format(CONFIG.money.revenue) + ' ₽. Если на приёмке найдут ' + CONFIG.money.foundPercent + ' % брака при допуске ' + tolerance + ' %: срез около ' + number.format(cut) + ' ₽ и штраф по договору. Условный пример.';
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
    if (kind === 'wait') return 'РЦ сети «Город» ждёт машину: рампа ' + CONFIG.slot.ramp + ', ' + CONFIG.slot.time + '.';
    if (kind === 'wait_strict') return 'РЦ сети «Город» ждёт машину, приёмка усиленная: сначала проверят ' + palletTargets() + '.';
    return 'РЦ сети «Город»: досортируйте ' + palletTargets() + ' до выезда.';
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
    $('#sup-category').textContent = st.category === 'offspec' ? 'Не по критериям' : 'Брак в пробе';
    $('#sup-number').textContent = (st.category === 'offspec' ? st.offSpec : st.defects) + ' из ' + st.checked;
    $('#sup-other').textContent = st.category === 'offspec' ? 'Брак: ' + st.defects + ' из ' + st.checked : 'Не по критериям: ' + st.offSpec + ' из ' + st.checked;
    $('#sup-risk').textContent = riskText(st); $('#sup-risk').className = 's-' + st.level;
    $('#sup-note').textContent = recommendation(st); money(st, $('#sup-money'));
    $('#sup-cta').textContent = st.done ? 'Посмотреть со стороны РЦ' : pendingPhoto ? 'Продолжить проверку снимка' : 'Проверить плод';
    $('#sup-extend').hidden = !st.done || st.checked >= 1030;
    var extra = Core.extraNeeded(S);
    $('#sup-extend').textContent = 'Расширить пробу: ещё ' + fruitCount(Math.max(1, extra || 10));
    $('#sup-review').hidden = st.done || st.level !== 'high';
    renderDecision($('#sup-decision'));
  }

  function ensurePending() {
    if (S.pending) return S.pending;
    var box = CONFIG.boxes[Math.floor(Math.random() * CONFIG.boxes.length)];
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
    $('#cam-hint').textContent = cameraMessage || 'Возьмите любой плод из этого ящика. Снимите плод целиком, на светлом фоне, с видимой плодоножкой.';
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
    var p = ensurePending(); p.photo = photo; p.test = !!test; p.result = null; p.reason = null;
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
  async function analyze() {
    var p = S.pending; if (!p || !p.photo) { go('camera'); return; }
    if (!CONFIG.analyzeUrl || p.test) { p.reason = p.test ? 'test' : 'unconnected'; save(); go('nolink'); return; }
    cancelAnalysis(); var attempt = analysisAttempt, started = performance.now();
    var ctrl = new AbortController(); controller = ctrl;
    var timer = setTimeout(function () { ctrl.abort(); }, CONFIG.analyzeTimeoutMs);
    show('analysis'); $('#an-photo').src = p.photo; $('#an-status').textContent = 'Отправляем фото и ждём ответ модели';
    try {
      var url = new URL(CONFIG.analyzeUrl, location.href);
      if (url.origin !== location.origin && url.protocol !== 'https:') throw new Error('Небезопасный адрес модели');
      var response = await fetch(url.href, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: p.photo, spec: CONFIG.spec, context: { expected_box: boxText(p.box), fruit: p.n } }), signal: ctrl.signal });
      if (!response.ok) throw new Error('Сервис не ответил');
      var payload = await response.json();
      if (!payload || payload.ok !== true) throw new Error('Сервис вернул ошибку');
      var result = Core.validateResult(payload.result);
      if (attempt !== analysisAttempt || S.pending !== p) return;
      p.result = result; p.ms = Math.round(performance.now() - started); p.model = typeof payload.model === 'string' ? payload.model.slice(0, 120) : null;
      if (result.verdict === 'bad_photo' || result.verdict === 'not_tomato') {
        p.photo = null;
        cameraMessage = result.verdict === 'not_tomato' ? 'Это не похоже на томат. Снимите плод из ящика ' + p.box.b + '.' : result.retake_hint || result.explanation;
        event('Плод ' + p.n + ': ' + result.title + '. Снимок не засчитан.'); save(); go('camera'); return;
      }
      if (result.confidence < CONFIG.minConfidence) { p.reason = 'uncertain'; save(); go('nolink'); return; }
      await commitVerdict(result.verdict, 'model');
    } catch (error) {
      if (attempt !== analysisAttempt || S.pending !== p) return;
      p.reason = error.name === 'AbortError' ? 'timeout' : 'unavailable'; save(); go('nolink');
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
    $('#res-source').textContent = sourceText(f) + '. ' + boxText(f.box);
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
      figure.append(element('p', '', 'Плод ' + latest.n + ': ' + (latest.source === 'model' ? latest.result.title : TITLES[latest.verdict]).toLowerCase()), element('p', 'muted', sourceText(latest) + '. ' + boxText(latest.box)));
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
    $('#report-interval').textContent = 'Брак: ' + st.defects + ' из ' + st.checked + '. Интервал Уилсона 95 %: ' + decimal.format(interval[0] * 100) + '-' + decimal.format(interval[1] * 100) + ' % при случайном отборе плодов.';
    var hints = ['Первыми вскройте: ' + boxesWithFindings().map(boxText).join('; ') + '. В этих местах в пробе есть брак или отклонения.'];
    var modelHints = S.fruits.filter(function (f) { return f.verdict !== 'good' && f.source === 'model' && f.result && f.result.rc_hint; }).map(function (f) { return f.result.rc_hint; });
    hints = hints.concat(Array.from(new Set(modelHints)).slice(0, 3), ['Сверьте пломбу. Вскройте 3 своих случайных места.']);
    $('#report-hints').textContent = hints.join(' ');
    var photos = $('#report-photos'); photos.replaceChildren();
    if (!S.fruits.length) photos.append(element('p', 'note', 'Ваших снимков пока нет.'));
    S.fruits.forEach(function (f) {
      var item = element('article', 'fruit-item');
      if (f.photo) { var image = element('img'); image.src = f.photo; image.alt = 'Плод ' + f.n + ': ' + TITLES[f.verdict].toLowerCase(); image.loading = 'lazy'; item.append(image); }
      else item.append(element('div', 'photo-missing', 'Фото недоступно'));
      var info = element('div'); info.append(element('h3', '', 'Плод ' + f.n + ': ' + TITLES[f.verdict].toLowerCase()), element('p', '', boxText(f.box)), element('p', '', sourceText(f)), element('p', '', time(f.ts)));
      var edit = element('button', 'text-link', 'Исправить отметку'); edit.type = 'button'; edit.dataset.edit = f.id; edit.setAttribute('aria-label', 'Исправить отметку плода ' + f.n); info.append(edit); item.append(info); photos.append(item);
    });
    var card = CONFIG.modelCard;
    $('#model-card').hidden = !(card.model && Number.isInteger(card.checked) && card.checked > 0 && Number.isInteger(card.agreed) && Number.isFinite(card.p90));
    if (!$('#model-card').hidden) $('#model-card').textContent = 'Проверка модели ' + card.model + ': на ' + card.checked + ' наших фото совпала с нами в ' + card.agreed + '. 9 ответов из 10 быстрее ' + card.p90 + ' с.';
  }

  function support(target) {
    var groups = [
      ['Замеры поставщика', [['Температура', '12,4 °C', 'Введено вручную, термощуп'], ['Калибр', '62 мм', 'Введено вручную, линейка'], ['Масса нетто', '6,04 кг', 'Введено вручную, весы'], ['Твёрдость', '2,4 кг/см²', 'Введено вручную, пенетрометр'], ['Сахаристость', '5,4 °Bx', 'Введено вручную, рефрактометр'], ['Нитраты', '112 мг/кг', 'Введено вручную, прибор']]],
      ['Документы', [['Декларация', 'Действует', 'Документ'], ['Паспорт качества', 'Загружен', 'Документ'], ['Протокол испытаний', 'От 28.10', 'Документ'], ['ТТН и УПД', 'Загружены', 'Документ'], ['Маркировка и даты', 'Проверены', 'Введено вручную']]],
      ['Упаковка и рейс', [['Паллеты и тара', '20 паллет', 'Введено вручную'], ['Выезд', CONFIG.trip.departure, 'Расписание поставщика'], ['Прибытие', CONFIG.trip.arrival, 'Расписание поставщика'], ['Расстояние', CONFIG.trip.distance + ' км', 'Расписание поставщика']]]
    ];
    target.append(element('p', 'small muted detail-body', 'Демонстрационные значения. Документы и показания приборов не проверялись в этом прототипе.'));
    groups.forEach(function (g) { var group = element('section', 'support-group'); group.append(element('h3', '', g[0])); g[1].forEach(function (r) { var row = element('div', 'row'), left = element('span', 'row-l'); left.append(element('span', 'row-t', r[0]), element('span', 'row-s', r[2])); row.append(left, element('span', 'row-v', r[1])); group.append(row); }); target.append(group); });
  }
  function method(target) {
    [
      'Это расчётная вероятность превышения заданного допуска, а не гарантия приёмки. Для брака и несоответствия критериям используются отдельные допуски по 10 %. Это условия демонстрации, спецификация сети пока не предоставлена.',
      'Каждая категория: Beta(k + 0,5; n - k + 0,5), где k - число отклонений, n - число проверенных плодов. Общий показатель - больший из двух рисков, а не вероятность любого нарушения. Ниже 15 % - низкий, от 15 до 25 % - заметный, от 25 % - высокий. Уровень определяется до округления.',
      'Расчёт предполагает случайный отбор и независимые наблюдения. Выбор ящика помогает распределить пробу, но не исключает смещение отбора, ошибки распознавания и ухудшение качества в дороге. Уверенность модели - её собственная оценка ответа, а не измеренная точность.',
      'Фото показывает одну сторону одного плода. Калибр без эталона, твёрдость, сахаристость, нитраты и скрытые дефекты по нему не определяются.'
    ].forEach(function (p) { target.append(element('p', '', p)); });
  }
  function toast(text) { var t = $('#toast'); t.textContent = text; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 4000); }
  function normalizeRoute(r) {
    if (['supplier', 'camera', 'analysis', 'nolink', 'result', 'rc', 'passport'].indexOf(r) < 0) return 'supplier';
    if (r === 'analysis') return S.pending && S.pending.photo ? 'nolink' : 'supplier';
    if (r === 'nolink' && !(S.pending && S.pending.photo)) return 'supplier';
    if (r === 'result' && !S.fruits.length) return 'supplier';
    if ((r === 'rc' || r === 'passport') && !canReview()) return 'supplier';
    return r;
  }
  function show(r) {
    if (r !== 'analysis') r = normalizeRoute(r);
    if (route === 'analysis' && r !== 'analysis') cancelAnalysis();
    if (r !== 'camera') stopCamera();
    route = r;
    if (location.hash !== '#' + r) history.replaceState(null, '', location.pathname + location.search + '#' + r);
    $$('.screen').forEach(function (screen) { screen.classList.toggle('active', screen.id === 's-' + r); });
    if (r === 'supplier') renderSupplier();
    if (r === 'camera') enterCamera();
    if (r === 'nolink') renderManual();
    if (r === 'result') renderResult();
    if (r === 'rc') { S.role = 'rc'; save(); renderRC(); }
    if (r === 'passport') renderReport();
    window.scrollTo(0, 0);
    var heading = $('#s-' + r + ' h1'); if (heading) heading.focus({ preventScroll: true });
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
  function openTools() { $('#tools-model').textContent = CONFIG.analyzeUrl ? 'Модель: адрес сервиса задан, подключение проверяется при отправке снимка.' : 'Модель пока не подключена. Доступна ручная отметка.'; $('#tools').showModal(); }

  document.addEventListener('click', function (e) {
    var button = e.target.closest('button'); if (!button) return;
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
  $('#sup-cta').addEventListener('click', function () { var st = Core.stats(S); if (st.done) review(); else if (S.pending && S.pending.photo) analyze(); else go('camera'); });
  $('#sup-review').addEventListener('click', review);
  $('#sup-extend').addEventListener('click', function () { var st = Core.stats(S), extra = Math.max(1, Core.extraNeeded(S) || 10); S.goal = Math.min(1030, st.checked + extra); S.decision = null; event('Проба расширена до ' + S.goal + ' плодов'); save(); go('camera'); });
  $('#cam-shot').addEventListener('click', capture);
  $('#cam-file').addEventListener('change', function () { readFile(this); });
  $('#cam-resume').addEventListener('click', analyze);
  $('#nl-retry').addEventListener('click', function () { if (S.pending) { S.pending.photo = null; S.pending.result = null; S.pending.test = false; S.pending.reason = null; save(); } go('camera'); });
  $('#an-cancel').addEventListener('click', function () { cancelAnalysis(); go('supplier'); });
  $('#res-next').addEventListener('click', function () { if (Core.stats(S).done) review(); else go('camera'); });
  $('#res-correct').addEventListener('click', function () { openCorrection(resultFruit().id); });
  $('#reset-confirm').addEventListener('click', function () { cancelAnalysis(); stopCamera(); S = Core.baseState(); lastResultId = null; cameraMessage = ''; $('#reset-dialog').close(); save(); go('supplier'); toast('Новая проба: проверено 28 из 30 плодов'); });
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
  $$('[data-trip]').forEach(function (n) { n.textContent = CONFIG.trip[n.dataset.trip]; });
  support($('#sup-support')); support($('#report-support')); method($('#sup-method')); method($('#report-method'));
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
