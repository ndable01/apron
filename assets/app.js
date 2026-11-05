(function () {
  'use strict';
  var Core = window.ApronCore, CONFIG = Core.CONFIG;
  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.from(document.querySelectorAll(s)); };
  var params = new URLSearchParams(location.search);
  if (params.get('print') === '1') { printCards(); return; }
  var Room = window.ApronRoom, QR = window.ApronQR, Checks = window.ApronChecks;
  // On a laptop the checklist stays on the left and the opened section is shown next to it.
  var wide = window.matchMedia('(min-width: 960px)'), sectionKey = 'gost';
  // Shared room mode only with ?room= in the link; without it everything stays on this device.
  var LINK = Room.fromLink(location.search, CONFIG), ROLE = LINK.room ? LINK.role : null;
  var ROOM_KEY = ROLE ? 'apron-room-v1:' + LINK.room + ':' + ROLE : null;
  var deviceId = (function () {
    var id = null;
    try { id = sessionStorage.getItem('apron-device'); } catch (error) { /* Private mode. */ }
    if (!id || !/^[a-z0-9-]{4,40}$/.test(id)) { id = 'd-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); try { sessionStorage.setItem('apron-device', id); } catch (error) { /* Private mode. */ } }
    return id;
  })();
  var sync = null, syncStatus = 'connecting', uploads = new Map(), lastPublishTs = 0, lastShooting = null, saveTimer = null, hallPhotoId = null;
  // Printable A5 box cards for the stage: the card is the background of the photo, so the model can read the label.
  function printCards() {
    document.title = 'Apron: карточки ящиков';
    // A5 only for the box cards; the batch passport prints on A4.
    var page = document.createElement('style'); page.textContent = '@page { size: A5 portrait; margin: 0 }'; document.head.append(page);
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
  var S = ROLE ? Core.roomState(LINK.room, ROLE) : Core.baseState();
  // A first visit without any saved work starts from the new batch screen, so the viewer gets the context first.
  var freshStart = !ROLE;
  try {
    var stored = ROLE ? localStorage.getItem(ROOM_KEY) : sessionStorage.getItem(STORE_KEY) || sessionStorage.getItem('apron-personal-sample-v2');
    if (ROLE) { if (stored) { var restored = Core.restore(stored); if (restored.room && restored.room.id === LINK.room && restored.room.role === ROLE) S = restored; } }
    else if (stored) { S = Core.restore(stored); freshStart = false; }
    else {
      var lastBatch = localStorage.getItem('apron-last-batch-v1');
      var savedBatch = lastBatch && localStorage.getItem(LIBRARY_PREFIX + lastBatch);
      if (savedBatch) { S = Core.restore(savedBatch); S.role = 'supplier'; freshStart = false; }
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
    S.updatedAt = Date.now(); clearTimeout(saveTimer); saveTimer = null;
    if (ROLE) {
      // The room key keeps each role apart, so hall and supplier windows on one laptop do not overwrite each other.
      try { localStorage.setItem(ROOM_KEY, JSON.stringify(S)); } catch (error) { saved = false; }
      $('#storage-warning').hidden = saved;
      if (!saved) $('#storage-warning').textContent = 'В браузере не хватает места для сохранения. Не закрывайте эту вкладку.';
      return saved;
    }
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
    if (b.example) reportSections($('#report-support')); else support($('#report-support'));
    method($('#sup-method')); method($('#report-method'));
    if (route === 'supplier') renderChecklist();
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
  function plural(n, one, few, many) { var mod = n % 100, d = n % 10; return n + ' ' + (mod >= 11 && mod <= 14 ? many : d === 1 ? one : d >= 2 && d <= 4 ? few : many); }
  function fruitCount(n) { var mod = n % 100; return n + ' ' + (mod >= 11 && mod <= 14 ? 'плодов' : n % 10 === 1 ? 'плод' : n % 10 >= 2 && n % 10 <= 4 ? 'плода' : 'плодов'); }
  // What the model said about a fruit: the full answer on the supplier, a short copy from the room on RC and hall.
  function info(f) {
    if (f.source !== 'model') return null;
    if (f.result) return { title: f.result.title, explanation: f.result.explanation, conf: f.result.confidence, rc_hint: f.result.rc_hint, findings: f.result.findings.map(function (x) { return x.type; }) };
    return f.remote || null;
  }
  function sourceText(f) {
    if (f.source !== 'model') return REASONS[f.source] + (f.corrected ? ', исправление' : '');
    var m = info(f), parts = ['Модель'];
    if (m && m.conf !== null) parts[0] += ', уверенность ' + Math.round(m.conf * 100) + ' %';
    return parts[0] + (Number.isFinite(f.ms) ? '. Ответ за ' + decimal.format(f.ms / 1000) + ' с' : '');
  }
  function fruitTitle(f) { var m = info(f); return m && m.title ? m.title : TITLES[f.verdict]; }
  function firstSentence(text) { var m = /^.*?[.!?](\s|$)/.exec(text || ''); return (m ? m[0] : text || '').trim(); }
  // Photo from the room link first, then the small copy inside the event, then an honest «фото не дошло».
  function photoNode(f, alt, className) {
    var missing = function () { return element('div', 'photo-missing', Core.isViewer(S) ? 'Фото не дошло' : 'Фото недоступно'); };
    var first = f.photoUrl || f.photo; if (!first) return missing();
    var img = element('img', className); img.alt = alt; var fellBack = !f.photoUrl;
    img.addEventListener('error', function () { if (!fellBack && f.photo) { fellBack = true; img.src = f.photo; } else img.replaceWith(missing()); });
    img.src = first; return img;
  }
  function boxesWithFindings() { return Core.boxesWithFindings(S); }
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
    target.append(metric, other);
    var manual = unverified(); if (manual.count) target.append(element('p', 'small unverified', unverifiedText(manual)));
    target.append(line, element('p', 'small muted risk-explain', RISK_PLAIN), element('p', 'recommendation', recommendation(st)));
  }
  var RISK_PLAIN = 'Срез - когда сеть снижает оплату за брак сверх допуска. Риск показывает, насколько это вероятно по вашей пробе.';
  // Fruits marked by hand (no model answer, a test or a correction) still count, but are always shown apart:
  // the supplier vouches for them, and the RC knows which boxes to open first.
  function unverified() {
    var list = S.fruits.filter(function (f) { return f.source !== 'model'; }), boxes = [];
    list.forEach(function (f) { if (!boxes.some(function (b) { return b.p === f.box.p && b.b === f.box.b; })) boxes.push({ p: f.box.p, b: f.box.b }); });
    return { count: list.length, total: S.fruits.length, boxes: boxes };
  }
  function unverifiedText(u) {
    return 'Без проверки моделью: ' + u.count + ' из ' + plural(u.total, 'снимка', 'снимков', 'снимков') + ' (' + Math.round(u.count / u.total * 100) + ' %). Отметку поставил поставщик вручную, это на его ответственности' + (u.boxes.length ? '. Ящики: ' + u.boxes.map(boxText).join('; ') : '') + '.';
  }
  function decisionText(kind) {
    if (kind === 'wait') return S.batch.rc + ' сети «' + S.batch.chain + '» ждёт машину' + (S.batch.ramp ? ': рампа ' + S.batch.ramp : '') + (S.batch.slotTime ? ', ' + S.batch.slotTime : '') + '.';
    if (kind === 'wait_strict') return S.batch.rc + ' сети «' + S.batch.chain + '» ждёт машину, приёмка усиленная' + (boxesWithFindings().length ? ': сначала проверят ' + palletTargets() : '') + '.';
    return S.batch.rc + ' сети «' + S.batch.chain + '»: досортируйте ' + (boxesWithFindings().length ? palletTargets() : 'партию') + ' до выезда.';
  }
  function finalText(kind) { return kind === 'resort' ? 'Фура ещё на складе: досортировка вместо среза.' : kind === 'wait_strict' ? 'Машина выезжает, РЦ знает, что вскрыть первым.' : 'Машина выезжает, РЦ её ждёт.'; }
  var DECISION_NAMES = { wait: 'Ждём машину', wait_strict: 'Ждём, приёмка усиленная', resort: 'Вернуть на досортировку' };
  var RC_OWN = { wait: 'Вы ждёте машину', wait_strict: 'Вы ждёте машину, приёмка усиленная', resort: 'Вы вернули партию на досортировку' };
  function renderDecision(target) {
    target.hidden = !S.decision; target.replaceChildren();
    if (!S.decision) return;
    var kind = S.decision.kind;
    if (ROLE === 'rc') target.append(element('p', '', RC_OWN[kind] + ', ' + time(S.decision.ts)), element('p', 'small muted', finalText(kind)));
    else if (ROLE === 'supplier') target.append(element('p', '', decisionText(kind)), element('p', 'small muted', 'Решение РЦ, ' + time(S.decision.ts)));
    else target.append(element('p', '', decisionText(kind)), element('p', '', finalText(kind)), element('p', 'small muted', 'Ваше решение со стороны РЦ, ' + time(S.decision.ts)));
  }
  function canReview() { return Core.allowedDecisions(S).length > 0; }
  function renderSupplier() {
    var st = Core.stats(S), pendingPhoto = S.pending && S.pending.photo;
    $('#sup-count').textContent = st.checked + ' из ' + S.goal;
    var left = Math.max(0, S.goal - st.checked), manual = unverified();
    $('#sup-sample-note').hidden = !(S.batch.example && S.seed.checked);
    $('#sup-sample-note').textContent = 'Для показа проба уменьшена: в жизни поставщик проверяет больше плодов и из большего числа ящиков. ' + S.seed.checked + ' уже проверены утром' + (left ? ', вам ' + (left === 1 ? 'остался один плод' : 'осталось ' + fruitCount(left)) : '') + '.';
    $('#sup-unverified').hidden = !manual.count; if (manual.count) $('#sup-unverified').textContent = unverifiedText(manual);
    $('#sup-progress').max = S.goal; $('#sup-progress').value = st.checked;
    $('#sup-number').parentElement.hidden = !st.checked; $('#sup-other').hidden = !st.checked;
    $('#sup-category').textContent = st.category === 'offspec' ? 'Не по критериям' : 'Брак в пробе';
    $('#sup-number').textContent = (st.category === 'offspec' ? st.offSpec : st.defects) + ' из ' + st.checked;
    $('#sup-other').textContent = st.category === 'offspec' ? 'Брак: ' + st.defects + ' из ' + st.checked : 'Не по критериям: ' + st.offSpec + ' из ' + st.checked;
    $('#sup-risk').textContent = riskText(st); $('#sup-risk').className = 's-' + st.level;
    $('#sup-note').textContent = recommendation(st); money(st, $('#sup-money'));
    $('#sup-cta').textContent = st.needsReview ? 'Проверить отметки в отчёте' : st.done ? (ROLE ? 'Открыть отчёт о пробе' : 'Посмотреть со стороны РЦ') : pendingPhoto ? 'Продолжить проверку снимка' : 'Проверить плод';
    $('#sup-extend').hidden = !st.done || st.needsReview || st.checked >= 2000 || S.fruits.length >= 2000;
    var extra = Core.extraNeeded(S);
    $('#sup-extend').textContent = 'Расширить пробу: ещё ' + fruitCount(Math.max(1, extra || 10));
    $('#sup-review').hidden = !!ROLE || st.done || st.level !== 'high';
    renderDecision($('#sup-decision'));
    renderChecklist();
  }

  // Preparation checklist: five sections of readings and documents, then the photo sample and the RC decision.
  function checkSections() {
    var files = {}; ['declaration', 'quality', 'lab', 'shipment', 'labels'].forEach(function (k) { files[k] = filesFor(k).length; });
    return Checks.sections(S.batch, { files: files });
  }
  function checkMark(node, done) { node.className = 'cl-mark' + (done ? ' done' : ''); }
  var CHEVRON = '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4l5 5-5 5"/></svg>';
  function renderChecklist() {
    var sections = checkSections(), st = Core.stats(S), list = $('#checklist'), anchor = $('#check-sections-anchor');
    $$('#checklist .cl-section').forEach(function (n) { list.removeChild(n); });
    sections.forEach(function (sec) {
      var li = element('li', 'cl-section'), b = element('button', 'cl-row cl-link'); b.type = 'button'; b.dataset.section = sec.key;
      if (wide.matches && sec.key === sectionKey) b.setAttribute('aria-current', 'true');
      var mark = element('span'); checkMark(mark, sec.done); mark.setAttribute('aria-hidden', 'true');
      var text = element('span', 'cl-text'); text.append(element('span', 'cl-title', sec.title), element('span', 'cl-plain', sec.plain), element('span', 'cl-sum', sec.summary));
      var chev = element('span', 'cl-chev'); chev.innerHTML = CHEVRON;
      b.append(mark, text, chev); b.setAttribute('aria-label', sec.title + (sec.done ? ', готово' : ', не заполнено') + '. ' + sec.summary);
      li.append(b); list.insertBefore(li, anchor);
    });
    checkMark($('#photo-mark'), st.done && !st.needsReview);
    var manual = unverified();
    $('#photo-sum').textContent = 'Проверено ' + st.checked + ' из ' + S.goal + (st.done ? ', проба закончена' : '') + (manual.count ? '. Без проверки моделью: ' + manual.count : '');
    checkMark($('#rc-mark'), !!S.decision);
    $('#rc-sum').textContent = S.decision ? DECISION_NAMES[S.decision.kind] + ', ' + time(S.decision.ts) : canReview() ? 'Можно передать результат РЦ' : 'Ждёт конца пробы';
    var done = sections.filter(function (x) { return x.done; }).length + (st.done && !st.needsReview ? 1 : 0) + (S.decision ? 1 : 0);
    $('#check-count').textContent = done + ' из 7'; $('#check-progress').value = done;
    var reqs = Checks.requirements(sections);
    $('#check-req').textContent = reqs.total ? 'Требования сети: выполнено ' + reqs.met + ' из ' + reqs.total + (S.batch.example ? ' (спецификация для примера)' : '') : 'Требования сети записаны текстом в данных партии и автоматически не сверяются.';
    $('#sup-detail').hidden = !wide.matches;
    if (wide.matches) renderSection(sections.find(function (x) { return x.key === sectionKey; }) || sections[0], $('#sup-detail'), 'panel');
  }
  // One section with its readings: a screen on the phone, the side panel on a laptop, a block in the report.
  function renderSection(sec, target, mode) {
    target.replaceChildren();
    var head = element('header', mode === 'report' ? 'section-head report' : 'head section-head');
    var h = element(mode === 'screen' ? 'h1' : mode === 'panel' ? 'h2' : 'h3', mode === 'report' ? '' : 'title', sec.title); if (mode === 'screen') h.tabIndex = -1;
    head.append(h); if (mode !== 'report') head.append(element('p', 'sub', sec.lead));
    target.append(head);
    if (sec.example) target.append(element('p', 'example-note', 'Пример показаний: значения, серийные номера, даты и номера документов условные.'));
    sec.items.forEach(function (item) {
      var box = element('div', 'measure'), top = element('div', 'measure-head');
      top.append(element('span', 'measure-name', item.name), element('strong', 'measure-value', item.value)); box.append(top);
      (item.details || []).forEach(function (d) { box.append(element('p', 'measure-detail', d)); });
      if (item.list && item.list.length) { var ul = element('ul', 'measure-list'); item.list.forEach(function (x) { ul.append(element('li', '', x)); }); box.append(ul); }
      if (item.check) {
        var req = element('p', 'measure-req'); req.append(element('span', 'muted', 'Сеть требует: '), document.createTextNode(item.check.req + '. '), element('strong', item.check.ok ? 's-low' : 's-medium', item.check.ok ? 'Соответствует' : 'Отклонение'));
        box.append(req);
      }
      if (item.meta && item.meta.length) {
        var dl = element('dl', 'measure-meta');
        item.meta.forEach(function (m) { dl.append(element('dt', '', m[0]), element('dd', '', m[1])); }); box.append(dl);
      }
      target.append(box);
    });
    if (!sec.example && !ROLE && mode !== 'report') { var edit = element('button', 'text-link mt18', 'Заполнить или изменить'); edit.type = 'button'; edit.dataset.go = 'measurements'; target.append(edit); }
  }
  function reportSections(target) {
    target.replaceChildren();
    checkSections().forEach(function (sec) {
      var d = element('details', 'report-section'), sum = element('summary', '', sec.title + ': ' + sec.summary.charAt(0).toLowerCase() + sec.summary.slice(1));
      var body = element('div', 'report-section-body'); renderSection(sec, body, 'report'); d.append(sum, body); target.append(d);
    });
  }
  // Batch passport at shipment: one document for the supplier and the RC, saved as PDF through printing.
  function passTable(head, rows) {
    var wrap = element('div', 'pass-table-wrap'), table = element('table', 'pass-table'), thead = element('thead'), tr = element('tr');
    head.forEach(function (h) { tr.append(element('th', '', h)); }); thead.append(tr); table.append(thead);
    var body = element('tbody');
    rows.forEach(function (r) { var row = element('tr'); r.forEach(function (c) { var td = element('td'); if (c instanceof Node) td.append(c); else td.textContent = c; row.append(td); }); body.append(row); });
    table.append(body); wrap.append(table); return wrap;
  }
  function passSection(doc, title) { var s = element('section', 'pass-section'); s.append(element('h2', 'pass-h', title)); doc.append(s); return s; }
  function renderPassport() {
    var doc = $('#pass-doc'), b = S.batch, st = Core.stats(S), sections = checkSections(), reqs = Checks.requirements(sections), now = new Date();
    var modelHints = Array.from(new Set(S.fruits.filter(function (f) { return f.verdict !== 'good' && info(f) && info(f).rc_hint; }).map(function (f) { var h = info(f).rc_hint; return /[.!?]$/.test(h) ? h : h + '.'; }))).slice(0, 3);
    var manual = unverified(), trip = Checks.transit(b, { boxes: boxesWithFindings(), hints: modelHints, unverified: manual.boxes });
    doc.replaceChildren();
    var head = element('header', 'pass-head');
    head.append(element('p', 'pass-brand', 'Apron'), element('h1', 'pass-title', 'Паспорт партии ' + b.code), element('p', 'pass-sub', batchTitle() + '. ' + b.supplier + ' для сети «' + b.chain + '», ' + b.rc + '.'));
    var status = !st.done ? 'Черновик: проба не закончена, проверено ' + st.checked + ' из ' + S.goal + '.' : !S.decision ? 'Проба закончена. Решение РЦ ещё не принято.' : 'Решение РЦ: «' + DECISION_NAMES[S.decision.kind] + '», ' + time(S.decision.ts) + '.';
    head.append(element('p', 'pass-status', 'Сформирован ' + now.toLocaleDateString('ru-RU') + ' в ' + now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) + '. ' + status));
    if (b.example) head.append(element('p', 'pass-note', 'Пример: показания приборов, серийные номера, номера документов и спецификация сети «Город» условные.'));
    doc.append(head);

    var sum = passSection(doc, 'Заключение'), list = element('ul', 'pass-list');
    list.append(element('li', '', reqs.total ? 'Требования сети: выполнено ' + reqs.met + ' из ' + reqs.total + '.' : 'Требования сети записаны текстом в данных партии и автоматически не сверялись.'));
    list.append(element('li', '', 'Проба: брак ' + st.defects + ' из ' + st.checked + ', не по критериям ' + st.offSpec + ' из ' + st.checked + '. Риск среза ' + riskText(st) + '.'));
    if (manual.count) list.append(element('li', '', unverifiedText(manual)));
    list.append(element('li', '', recommendation(st)));
    list.append(element('li', '', S.decision ? decisionText(S.decision.kind) + ' ' + finalText(S.decision.kind) : 'Решение РЦ ещё не принято.'));
    sum.append(list);

    var batch = passSection(doc, 'Партия и рейс'), grid = element('dl', 'pass-grid');
    [['Продукция', b.product + ', ' + precise.format(b.weight) + ' т, сорт ' + b.grade], ['Поставщик', b.supplier + ', партия ' + b.code], ['Получатель', 'Сеть «' + b.chain + '», ' + b.rc], ['Паллеты', plural(b.pallets, 'паллета', 'паллеты', 'паллет') + ' по ' + plural(b.boxesPerPallet, 'ящику', 'ящика', 'ящиков')],
     ['Выезд', b.departure || 'Не указан'], ['Прибытие', b.arrival || 'Не указано'], ['Расстояние', b.distance === null ? 'Не указано' : number.format(b.distance) + ' км'], ['Стоимость', b.revenue === null ? 'Не указана' : number.format(b.revenue) + ' ₽']]
      .concat(b.example ? [['Логгер', 'Testo 184 T3, № 39017744, пример'], ['Пломба', '№ 0458812, пример']] : [])
      .forEach(function (r) { grid.append(element('dt', '', r[0]), element('dd', '', r[1])); });
    batch.append(grid);

    var sample = passSection(doc, 'Проба по фото'), interval = Core.wilson(st.defects, st.checked);
    sample.append(element('p', 'pass-p', 'Проверено ' + st.checked + ' плодов из ' + S.goal + '. Брак ' + st.defects + ', не по критериям ' + st.offSpec + '. При ' + st.defects + ' из ' + st.checked + ' брак партии с вероятностью 95 % от ' + decimal.format(interval[0] * 100) + ' до ' + decimal.format(interval[1] * 100) + ' % (интервал Уилсона).'));
    if (S.seed.checked) sample.append(element('p', 'pass-p muted', 'Первые ' + S.seed.checked + ' плодов проверены раньше, фото этой части пробы нет.'));
    if (S.fruits.length) {
      var shots = element('div', 'pass-fruits');
      S.fruits.forEach(function (f) { var card = element('figure', 'pass-fruit'); card.append(photoNode(f, 'Плод ' + f.n)); var cap = element('figcaption'); cap.append(element('strong', '', 'Плод ' + f.n + ': ' + fruitTitle(f).toLowerCase()), element('span', '', sourceText(f)), element('span', '', placeText(f))); card.append(cap); shots.append(card); });
      sample.append(shots);
    }

    var meas = passSection(doc, 'Замеры и требования сети'), rows = [];
    sections.forEach(function (sec) {
      sec.items.forEach(function (i) {
        if (i.list) return;
        var meta = (i.meta || []).filter(function (m) { return ['Прибор', 'Документ', 'Серийный номер', 'Поверка', 'Калибровка'].indexOf(m[0]) >= 0; }).map(function (m) { return m[1]; }).join('; ');
        var verdict = i.check ? element('strong', i.check.ok ? 's-low' : 's-medium', i.check.ok ? 'Соответствует' : 'Отклонение') : '-';
        rows.push([i.name, i.value, i.check ? i.check.req : '-', meta || '-', verdict]);
      });
    });
    meas.append(passTable(['Показатель', 'Факт', 'Сеть требует', 'Прибор и проверка', 'Итог'], rows));

    var way = passSection(doc, 'Что произойдёт с плодами в пути');
    trip.forecast.forEach(function (p) { way.append(element('p', 'pass-p', p)); });
    var risk = passSection(doc, 'Риски в пути: как избежать и что проверить');
    risk.append(passTable(['Риск', 'Почему опасно', 'Как избежать', 'Что проверить на рампе'], trip.risks.map(function (r) { return [r.risk, r.why, r.avoid, r.check]; })));
    var dock = passSection(doc, 'Порядок проверки на рампе РЦ'), ol = element('ol', 'pass-list');
    trip.dock.forEach(function (d) { ol.append(element('li', '', d)); }); dock.append(ol);

    var docs = passSection(doc, 'Документы'), safety = sections.find(function (x) { return x.key === 'safety'; }), dl = element('dl', 'pass-grid');
    safety.items.forEach(function (i) { var m = (i.meta || []).map(function (x) { return x[1]; }).join(', '); dl.append(element('dt', '', i.name), element('dd', '', i.value + (m ? '. ' + m : ''))); });
    docs.append(dl);

    var sign = passSection(doc, 'Подписи'), signs = element('div', 'pass-signs');
    ['Поставщик', 'Перевозчик', 'Приёмка РЦ'].forEach(function (who) { var s = element('div', 'pass-sign'); s.append(element('span', 'pass-sign-line'), element('span', 'small muted', who + ': ФИО, подпись, дата')); signs.append(s); });
    sign.append(signs);
    doc.append(element('p', 'pass-foot', 'Риск среза - вероятность превышения допуска сети по результатам пробы, Beta(k + 0,5; n - k + 0,5). Прогноз в пути - ориентир по данным о хранении томатов, а не обещание. Окончательное решение о приёмке принимает РЦ.'));
  }
  function printPassport() {
    var title = document.title; document.title = 'Паспорт партии ' + S.batch.code;
    window.addEventListener('afterprint', function done() { document.title = title; window.removeEventListener('afterprint', done); });
    window.print();
  }
  function renderSectionScreen(key) { renderSection(checkSections().find(function (x) { return x.key === key; }), $('#section-body'), 'screen'); }

  // Room events. Every device stamps its own events; time only moves forward so keys stay unique.
  function publish(type, data) {
    if (!sync) return;
    lastPublishTs = Math.max(Date.now(), lastPublishTs + 1);
    sync.publish(Object.assign({ t: type, from: deviceId, ts: lastPublishTs }, data || {}));
  }
  function saveSoon() { if (!saveTimer) saveTimer = setTimeout(save, 400); }
  async function dataURLBlob(url) { return (await fetch(url)).blob(); }
  async function uploadPhoto(photo, n) {
    if (!sync) return null;
    try { var small = await resizePhoto(photo, 480, 0.8); return await sync.upload(await dataURLBlob(small), 'apron-plod-' + n + '.jpg'); }
    catch (error) { return null; }
  }
  async function thumbFor(photo) {
    if (!photo) return null;
    for (var i = 0, sizes = [[72, 0.6], [56, 0.5]]; i < sizes.length; i++) {
      try { var t = await resizePhoto(photo, sizes[i][0], sizes[i][1]); if (Room.isThumb(t)) return t; } catch (error) { return null; }
    }
    return null;
  }
  function within(promise, ms) { return Promise.race([promise, new Promise(function (resolve) { setTimeout(function () { resolve(null); }, ms); })]); }
  // The photo goes as an ntfy attachment (started while the model is still looking); the event carries its link.
  async function publishFruit(f, onlyWithPhoto) {
    if (!sync) return;
    var url = f.photoUrl || null;
    if (!url && uploads.has(f.id)) url = await within(uploads.get(f.id), 4000);
    if (!url && f.photo) url = await within(uploadPhoto(f.photo, f.n), 4000);
    uploads.delete(f.id);
    if (url && f.photoUrl !== url) { f.photoUrl = url; save(); }
    if (onlyWithPhoto && !url) return;
    var m = info(f), event = { id: f.id, n: f.n, box: { p: f.box.p, b: f.box.b }, verdict: f.verdict, source: f.source, conf: m ? m.conf : null, ms: Number.isFinite(f.ms) ? Math.round(f.ms) : null, title: m ? m.title : null, explanation: m ? m.explanation : null, rc_hint: m ? m.rc_hint : null, findings: m ? m.findings : [], thumb: await thumbFor(f.photo), photo: url, corrected: !!f.corrected, tally: Core.tally(S) };
    if (f.boxCheck) event.boxCheck = f.boxCheck;
    if (Number.isInteger(f.shotDelay)) event.shotDelay = f.shotDelay;
    publish('fruit', event);
  }
  // After a connection gap, photos that only went out as a small copy are uploaded again.
  var retrying = new Set();
  function retryPhotos() {
    if (ROLE !== 'supplier') return;
    S.fruits.slice(-10).filter(function (f) { return f.photo && !f.photoUrl && !retrying.has(f.id); }).forEach(function (f) {
      retrying.add(f.id); publishFruit(f, true).finally(function () { if (!f.photoUrl) retrying.delete(f.id); });
    });
  }
  function syncText() { return syncStatus === 'online' ? 'Связь есть' : syncStatus === 'offline' ? 'Нет связи, данные на этом устройстве' : 'Подключаемся'; }
  function renderSync() {
    $$('[data-sync]').forEach(function (n) { n.hidden = !ROLE; n.textContent = syncText(); n.classList.toggle('s-high', syncStatus === 'offline'); });
    if ($('#tools').open) renderRoomTools();
  }
  function onRoomEvent(e) {
    var res = Core.applyRoomEvent(S, e, decisionText);
    if (!res.changed) return;
    if (res.reset && ROLE === 'supplier') { cancelAnalysis(); stopCamera(); lastResultId = null; cameraMessage = ''; uploads.clear(); }
    save();
    // Browsers allow vibration only after the person has touched the page once.
    if (res.vibrate && navigator.vibrate && (!navigator.userActivation || navigator.userActivation.hasBeenActive)) { try { navigator.vibrate(ROLE === 'rc' ? 120 : [80, 60, 80]); } catch (error) { /* Not on iPhone. */ } }
    if (ROLE === 'supplier' && e.t === 'decision' && route !== 'supplier') toast(decisionText(e.kind));
    if (res.reset && ROLE === 'supplier' && route !== 'supplier') { go('supplier'); toast('Проба сброшена на всех устройствах'); return; }
    refresh();
  }
  // Re-render the open screen in place, without scrolling or moving focus.
  function refresh() {
    if (route === 'supplier') renderSupplier();
    else if (route === 'rc') renderRC();
    else if (route === 'passport') renderReport();
    else if (route === 'hall') renderHall();
    else if (route === 'result') { summary($('#res-summary')); }
  }
  function startSync() {
    if (!ROLE) return;
    var outbox = (S.room.outbox || []).map(Room.validateEvent).filter(Boolean);
    sync = Room.connect({
      room: LINK.room, server: Room.syncServer(location, LINK.local, CONFIG), from: deviceId, cursor: S.room.cursor, catchUp: CONFIG.sync.catchUpSince, outbox: outbox,
      onEvent: onRoomEvent,
      onStatus: function (status) { syncStatus = status; renderSync(); if (status === 'online') retryPhotos(); },
      onCursor: function (cursor) { S.room.cursor = cursor; saveSoon(); },
      onOutbox: function (queue) { S.room.outbox = queue; saveSoon(); }
    });
  }

  function ensurePending() {
    if (S.pending) return S.pending;
    var box = Core.pickBox(S.batch);
    S.pending = { id: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2), n: Core.stats(S).checked + 1, box: { p: box.p, b: box.b }, ts: Date.now(), photo: null, test: false, result: null, reason: null, ms: null };
    event('Apron выбрал: ' + boxText(box) + '. Плод ' + S.pending.n); save();
    publish('box', { n: S.pending.n, box: { p: box.p, b: box.b } });
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
    if (lastShooting !== p.id) { lastShooting = p.id; publish('shooting', { n: p.n }); }
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
    if (sync) uploads.set(p.id, uploadPhoto(photo, p.n));
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
        event('Плод ' + p.n + ': попытка снять не тот ящик. На этикетке «' + result.label_text + '», а Apron выбрал: ' + boxText(p.box) + '.'); save();
        publish('wrongbox', { n: p.n, box: { p: p.box.p, b: p.box.b }, label: result.label_text.slice(0, 60) }); uploads.delete(p.id); go('camera'); return;
      }
      if (result.verdict === 'insufficient') { p.reason = 'insufficient'; save(); go('nolink'); return; }
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
      lastResultId = fruit.id; save(); go('result'); publishFruit(fruit);
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
    if (p.reason === 'insufficient' && p.result) {
      $('#nl-title').textContent = p.result.title; $('#nl-text').textContent = p.result.explanation;
      $('#nl-source').textContent = 'Модель не дала результата, плод не засчитан. Переснимите его или отметьте сами: отметка будет видна как ручная.';
      var details = $('#nl-model'); details.replaceChildren(element('p', 'model-note', 'Не хватает: ' + p.result.not_visible.join(', ') + '.'));
      if (p.result.retake_hint) details.append(element('p', 'model-note', 'Как переснять: ' + p.result.retake_hint.replace(/[.\s]+$/, '').replace(/^./, function (c) { return c.toLowerCase(); }) + '.'));
      if (p.result.note) details.append(element('p', 'model-note', p.result.note));
      return;
    }
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
    if (f.result && f.result.verdict === 'insufficient') $('#res-model').replaceChildren(element('p', 'model-note', 'Модели не хватило данных для вывода, отметка выбрана вручную. Не хватало: ' + f.result.not_visible.join(', ') + '.'));
    else if (f.result && f.source !== 'model') $('#res-model').prepend(element('p', 'model-note', 'Ниже первоначальное наблюдение модели. Итоговая отметка выбрана вручную.'));
    summary($('#res-summary')); $('#res-next').textContent = st.done ? (ROLE ? 'Открыть отчёт о пробе' : 'Посмотреть со стороны РЦ') : 'Проверить следующий плод';
  }
  function renderRC() {
    // In a room the RC follows the sample live; decision buttons still appear only when the sample allows them.
    var ready = ROLE === 'rc' || canReview(); $('#rc-waiting').hidden = ready; $('#rc-content').hidden = !ready;
    if (!ready) return;
    summary($('#rc-summary')); money(Core.stats(S), $('#rc-money')); renderDecision($('#rc-decision'));
    var latest = S.fruits[S.fruits.length - 1], wrap = $('#rc-latest'); wrap.replaceChildren();
    var now = S.room && S.room.box && (!latest || S.room.box.n > latest.n) ? S.room.box : null;
    if (now) {
      var live = element('p', 'decision-note', 'Apron выбрал: ' + boxText(now.box) + '. ' + (S.room.shooting === now.n ? 'Поставщик снимает плод ' + now.n + '.' : 'Плод ' + now.n + '.'));
      if (S.room.wrongbox && S.room.wrongbox.n === now.n) live.append(element('span', 's-high', ' Попытка снять не тот ящик.'));
      wrap.append(live);
    }
    if (latest) {
      var figure = element('div', 'latest-photo');
      figure.append(photoNode(latest, 'Последний проверенный плод'));
      var m = info(latest);
      figure.append(element('p', '', 'Плод ' + latest.n + ': ' + fruitTitle(latest).toLowerCase()), element('p', 'muted', sourceText(latest) + '. ' + placeText(latest)));
      if (m && m.explanation) figure.append(element('p', '', ROLE ? firstSentence(m.explanation) : m.explanation)); wrap.append(figure);
    } else if (ROLE === 'rc' && !now) wrap.append(element('p', 'note', 'Поставщик ещё не снял ни одного плода. Здесь появятся фото и результаты.'));
    var buttons = $('#rc-decisions'); buttons.replaceChildren();
    var names = DECISION_NAMES;
    if (ROLE === 'rc' && !Core.allowedDecisions(S).length) buttons.append(element('p', 'small muted', 'Кнопки решения появятся, когда проба закончится или риск станет высоким.'));
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
    var modelHints = S.fruits.filter(function (f) { return f.verdict !== 'good' && info(f) && info(f).rc_hint; }).map(function (f) { return info(f).rc_hint; });
    var manualBoxes = unverified().boxes;
    if (manualBoxes.length) hints.push('Проверьте ящики, где плоды отмечены вручную без проверки моделью: ' + manualBoxes.map(boxText).join('; ') + '.');
    hints = hints.concat(Array.from(new Set(modelHints)).slice(0, 3).map(function (h) { return /[.!?]$/.test(h) ? h : h + '.'; }), ['Сверьте пломбу. Вскройте 3 своих случайных места.']);
    $('#report-hints').textContent = hints.join(' ');
    var photos = $('#report-photos'); photos.replaceChildren();
    if (!S.fruits.length) photos.append(element('p', 'note', 'Ваших снимков пока нет.'));
    S.fruits.forEach(function (f) {
      var item = element('article', 'fruit-item');
      var image = photoNode(f, 'Плод ' + f.n + ': ' + TITLES[f.verdict].toLowerCase()); if (image.tagName === 'IMG') image.loading = 'lazy'; item.append(image);
      var details = element('div'); details.append(element('h3', '', 'Плод ' + f.n + ': ' + TITLES[f.verdict].toLowerCase()), element('p', '', placeText(f)), element('p', '', sourceText(f)), element('p', '', time(f.ts)));
      if (f.needsReview) details.append(element('p', 's-medium', 'Условия изменились. Подтвердите результат по новым требованиям.'));
      // Only the supplier who took the photo can change its mark; RC sees the result as sent.
      if (!Core.isViewer(S)) { var edit = element('button', 'text-link', f.needsReview ? 'Подтвердить отметку' : 'Исправить отметку'); edit.type = 'button'; edit.dataset.edit = f.id; edit.setAttribute('aria-label', (f.needsReview ? 'Подтвердить' : 'Исправить') + ' отметку плода ' + f.n); details.append(edit); }
      item.append(details); photos.append(item);
    });
    $('#report-back').textContent = ROLE === 'supplier' ? 'К партии' : ROLE === 'rc' || canReview() ? 'К решению РЦ' : 'Продолжить проверку партии';
    var card = CONFIG.modelCard;
    $('#model-card').hidden = !(card.model && Number.isInteger(card.checked) && card.checked > 0 && Number.isInteger(card.agreed) && Number.isFinite(card.p90));
    if (!$('#model-card').hidden) $('#model-card').textContent = 'Проверка модели ' + card.model + ': на ' + card.checked + ' наших фото совпала с нами в ' + card.agreed + '. 9 ответов из 10 быстрее ' + decimal.format(card.p90) + ' с.';
  }

  // First screen of the viewer's path: the example batch as a filled form, created with one tap.
  function renderStart() {
    var b = Core.defaultBatch(true), list = $('#start-fields'); list.replaceChildren();
    [
      ['Продукция', b.product + ', ' + precise.format(b.weight) + ' т', 'Сорт ' + b.grade + ', ГОСТ 34298-2017'],
      ['Поставщик', b.supplier, 'Партия ' + b.code],
      ['Получатель', 'Сеть «' + b.chain + '», ' + b.rc, 'Решение о приёмке принимает РЦ'],
      ['Рейс', 'Выезд ' + b.departure, 'Прибытие ' + b.arrival + ', ' + number.format(b.distance) + ' км'],
      ['Партия', plural(b.pallets, 'паллета', 'паллеты', 'паллет') + ' по ' + plural(b.boxesPerPallet, 'ящику', 'ящика', 'ящиков'), 'Стоимость ' + number.format(b.revenue) + ' ₽'],
      ['Проба', b.sampleTotal + ' плодов', 'Допуск сети: брак ' + precise.format(b.tolerance.defect) + ' %, не по критериям ' + precise.format(b.tolerance.offspec) + ' %']
    ].forEach(function (r) { var field = element('div', 'start-field'); field.append(element('span', 'start-label', r[0]), element('span', 'start-value', r[1]), element('span', 'start-hint', r[2])); list.append(field); });
    $('#start-note').textContent = 'В примере утром уже проверено ' + CONFIG.seed.checked + ' плодов из ' + CONFIG.sampleTotal + ', найден ' + CONFIG.seed.defects + ' брак. ' + (CONFIG.sampleTotal - CONFIG.seed.checked === 1 ? 'Вам остался один плод: от него зависит, поедет ли партия как есть.' : 'Вам осталось ' + fruitCount(CONFIG.sampleTotal - CONFIG.seed.checked) + '.') + ' Для показа проба уменьшена: в жизни плодов проверяют больше.';
  }
  // The box is chosen before the camera opens and shown on its own screen, so the random choice is visible.
  function renderPick() {
    var p = ensurePending(), grid = $('#pick-grid'), stage = S.batch.example ? CONFIG.boxes.filter(function (x) { return x.p <= S.batch.pallets && x.b <= S.batch.boxesPerPallet; }) : [];
    $('#pick-count').textContent = 'Плод ' + p.n + ' из ' + S.goal;
    grid.replaceChildren(); grid.className = 'pick-grid' + (stage.length ? '' : ' pallets');
    if (stage.length) {
      $('#pick-sub').textContent = 'На сцене ' + plural(stage.length, 'ящик', 'ящика', 'ящиков') + ' из этой партии. Apron выбрал один из них случайно.';
      stage.forEach(function (x) { var chosen = x.p === p.box.p && x.b === p.box.b, tile = element('div', 'pick-tile' + (chosen ? ' chosen' : '')); tile.append(element('span', '', 'Паллета ' + x.p), element('span', '', 'ящик ' + x.b)); if (chosen) tile.setAttribute('aria-label', 'Выбран: паллета ' + x.p + ', ящик ' + x.b); grid.append(tile); });
    } else {
      $('#pick-sub').textContent = 'В партии ' + plural(S.batch.pallets, 'паллета', 'паллеты', 'паллет') + ' по ' + plural(S.batch.boxesPerPallet, 'ящику', 'ящика', 'ящиков') + '. Apron выбрал место случайно.';
      for (var i = 1; i <= Math.min(S.batch.pallets, 60); i++) { var tile = element('div', 'pick-tile' + (i === p.box.p ? ' chosen' : ''), String(i)); grid.append(tile); }
      if (S.batch.pallets > 60) grid.append(element('div', 'pick-tile', '...'));
    }
    grid.setAttribute('aria-hidden', 'true');
    $('#pick-box').textContent = 'Паллета ' + p.box.p + ', ящик ' + p.box.b;
  }
  function baseURL() { return location.origin + location.pathname; }
  function qrSVG(text) {
    var code = QR.encode(text), size = code.size + 8, ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', '0 0 ' + size + ' ' + size); svg.setAttribute('shape-rendering', 'crispEdges'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'QR-код ссылки для РЦ');
    var bg = document.createElementNS(ns, 'rect'); bg.setAttribute('width', size); bg.setAttribute('height', size); bg.setAttribute('fill', '#FFFFFF');
    var path = document.createElementNS(ns, 'path'); path.setAttribute('d', QR.svgPath(code, 4)); path.setAttribute('fill', '#1C1C1A');
    svg.append(bg, path); return svg;
  }
  // Projector screen: before start, live sample in three columns, and the final line after the RC decision.
  function renderHall() {
    var st = Core.stats(S), latest = S.fruits[S.fruits.length - 1], r = S.room;
    var started = !!(S.fruits.length || r.box || S.decision);
    $('#hall-start').hidden = started; $('#hall-live').hidden = !started;
    var rcLink = Room.roleLink(baseURL(), LINK.room, 'rc', false);
    if (!started) {
      $('#hall-lead').textContent = 'Партия томатов ' + precise.format(S.batch.weight) + ' т едет в РЦ сети «' + S.batch.chain + '»';
      if ($('#hall-qr').dataset.link !== rcLink) { $('#hall-qr').replaceChildren(qrSVG(rcLink)); $('#hall-qr').dataset.link = rcLink; }
      $('#hall-qr-caption').textContent = 'Отсканируйте: вы - РЦ сети «' + S.batch.chain + '»';
      hallPhotoId = null; return;
    }
    $('#hall-batch').textContent = batchTitle() + '. Сеть «' + S.batch.chain + '», ' + S.batch.rc;
    var now = r.box && (!latest || r.box.n > latest.n) ? r.box : null, photo = $('#hall-photo');
    if (now) {
      if (hallPhotoId !== 'wait-' + now.n) { photo.replaceChildren(element('div', 'hall-wait', 'Поставщик снимает плод ' + now.n)); hallPhotoId = 'wait-' + now.n; }
      $('#hall-verdict').textContent = 'Apron выбрал: ' + boxText(now.box); $('#hall-verdict').className = 'hall-verdict';
      $('#hall-explain').textContent = r.wrongbox && r.wrongbox.n === now.n ? 'Попытка снять не тот ящик: снимок не засчитан.' : 'Возьмите любой плод из этого ящика.';
      $('#hall-explain').className = 'hall-explain' + (r.wrongbox && r.wrongbox.n === now.n ? ' s-high' : '');
      $('#hall-place').textContent = '';
    } else if (latest) {
      var key = latest.id + ':' + (latest.photoUrl || '') + ':' + (latest.photo ? latest.photo.length : 0);
      if (hallPhotoId !== key) { var img = photoNode(latest, 'Плод ' + latest.n, 'hall-img'); photo.replaceChildren(img); hallPhotoId = key; }
      var m = info(latest), how = latest.source === 'model' ? (m && m.conf !== null ? ', уверенность ' + Math.round(m.conf * 100) + ' %' : '') : latest.source === 'test' ? ', тест, отмечено вручную' : ', отмечено вручную';
      $('#hall-verdict').textContent = 'Плод ' + latest.n + ': ' + TITLES[latest.verdict].toLowerCase() + how;
      $('#hall-verdict').className = 'hall-verdict ' + (latest.verdict === 'good' ? 's-low' : latest.verdict === 'defect' ? 's-high' : 's-medium');
      $('#hall-explain').textContent = m && m.explanation ? firstSentence(m.explanation) : ''; $('#hall-explain').className = 'hall-explain';
      $('#hall-place').textContent = boxText(latest.box) + (latest.boxCheck === 'confirmed' ? ', ящик подтверждён по этикетке' : '');
    } else {
      photo.replaceChildren(element('div', 'hall-wait', 'Снимков пока нет')); hallPhotoId = null;
      $('#hall-verdict').textContent = ''; $('#hall-explain').textContent = ''; $('#hall-place').textContent = '';
    }
    var offspec = st.category === 'offspec';
    $('#hall-sample').className = 'hall-col hall-sample level-' + st.level;
    $('#hall-category').textContent = offspec ? 'Не по критериям' : 'Брак в пробе';
    $('#hall-number').textContent = (offspec ? st.offSpec : st.defects) + ' из ' + st.checked;
    var handMarked = unverified();
    $('#hall-other').textContent = (offspec ? 'Брак: ' + st.defects : 'Не по критериям: ' + st.offSpec) + ' из ' + st.checked + '. Проба ' + st.checked + ' из ' + S.goal + (handMarked.count ? '. Без проверки моделью: ' + handMarked.count : '');
    $('#hall-risk').textContent = st.risk === null ? 'Риск среза: ' + riskText(st).toLowerCase() : 'Риск среза ' + Math.round(st.risk * 100) + ' %, ' + LEVELS[st.level];
    $('#hall-risk').className = 'hall-risk s-' + st.level;
    $('#hall-rec').textContent = recommendation(st); money(st, $('#hall-money'));
    $('#hall-rc-title').textContent = S.batch.rc + ' сети «' + S.batch.chain + '»';
    $('#hall-decision').textContent = S.decision ? DECISION_NAMES[S.decision.kind] : Core.allowedDecisions(S).length ? 'Принимает решение' : 'Ждёт данных';
    $('#hall-decision').className = 'hall-decision' + (S.decision ? '' : ' muted');
    var events = $('#hall-events'); events.replaceChildren();
    S.events.slice().reverse().slice(0, 5).forEach(function (e) { var li = element('li'); var stamp = element('time', '', time(e.ts)); stamp.dateTime = new Date(e.ts).toISOString(); li.append(stamp, element('span', '', e.text)); events.append(li); });
    $('#hall-final').hidden = !S.decision; if (S.decision) $('#hall-final').textContent = finalText(S.decision.kind);
  }
  function renderRoomTools() {
    var box = $('#tools-room'); box.hidden = !ROLE; if (!ROLE) return;
    box.replaceChildren();
    box.append(element('p', 'small', 'Комната ' + LINK.room + '. ' + syncText() + (sync && sync.pending() ? ', ждут отправки: ' + sync.pending() : '') + '.'));
    if (!LINK.linked) box.append(element('p', 'small s-high', 'Комната взята из CONFIG.room, а не из ссылки. Для показа откройте ссылки с ?room=.'));
    if (location.protocol === 'http:' && /^(localhost|127\.)/.test(location.hostname)) box.append(element('p', 'small muted', 'Страница открыта на этом компьютере. Телефонам нужен адрес в локальной сети, его печатает server/relay.js.'));
    [['supplier', 'Поставщик'], ['rc', 'РЦ'], ['hall', 'Зал']].forEach(function (role) {
      var url = Room.roleLink(baseURL(), LINK.room, role[0], role[0] !== 'rc');
      var row = element('p', 'small room-link'); var a = element('a', 'text-link', role[1]); a.href = url; a.target = '_blank'; a.rel = 'noopener';
      row.append(a, element('span', 'muted', ' ' + url)); box.append(row);
    });
    if (ROLE === 'hall') { var fresh = element('button', 'btn-line', 'Новая комната'); fresh.type = 'button'; fresh.id = 'new-room'; box.append(fresh); }
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
    // Each room role keeps to its own screens: the hall only shows, the RC decides and reads the report.
    if (ROLE === 'hall') return 'hall';
    if (ROLE === 'rc') return r === 'passport' || r === 'pass' ? r : 'rc';
    if (ROLE === 'supplier' && ['rc', 'batches', 'batch-edit', 'measurements'].indexOf(r) >= 0) return 'supplier';
    if (/^sec-/.test(r)) {
      if (Checks.KEYS.indexOf(r.slice(4)) < 0 || ROLE === 'rc' || ROLE === 'hall') return 'supplier';
      if (wide.matches) { sectionKey = r.slice(4); return 'supplier'; }
      return r;
    }
    if (['pass', 'start', 'pick', 'supplier', 'camera', 'analysis', 'nolink', 'result', 'rc', 'passport', 'batch-edit', 'measurements', 'batches'].indexOf(r) < 0) return 'supplier';
    if (r === 'start' && ROLE) return 'supplier';
    if (r === 'pick' && (Core.stats(S).done || (S.pending && S.pending.photo))) return 'supplier';
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
    var screenId = /^sec-/.test(r) ? 'section' : r;
    $$('.screen').forEach(function (screen) { screen.classList.toggle('active', screen.id === 's-' + screenId); });
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
    if (r === 'hall') renderHall();
    if (r === 'start') renderStart();
    if (r === 'pick') renderPick();
    if (screenId === 'section') renderSectionScreen(r.slice(4));
    if (r === 'pass') renderPassport();
    document.body.classList.toggle('printing-pass', r === 'pass');
    renderSync();
    window.scrollTo(0, 0);
    var heading = $('#s-' + screenId + ' h1'); if (heading) heading.focus({ preventScroll: true });
    var batchId = S.batch.id;
    ensureDocuments(r !== 'measurements').then(function () { if (S.batch.id === batchId) renderBatchInfo(); }).catch(function () { if (S.batch.id === batchId) renderBatchInfo(); });
  }
  function go(r) {
    var target = normalizeRoute(r);
    if ((r === 'rc' || r === 'passport') && target === 'supplier') toast('Сначала завершите пробу со стороны поставщика');
    if (location.hash !== '#' + target) { history.pushState(null, '', location.pathname + location.search + '#' + target); }
    show(target);
  }
  function review() { if (ROLE === 'supplier') { go('passport'); return; } if (!canReview()) return; if (S.pending && !S.pending.photo) S.pending = null; S.role = 'rc'; save(); go('rc'); }
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
  function openTools() {
    $('#test-photo').hidden = ROLE === 'rc' || ROLE === 'hall'; $('#test-photo-note').hidden = $('#test-photo').hidden;
    renderRoomTools(); $('#tools').showModal(); checkRelay();
  }

  document.addEventListener('click', function (e) {
    var button = e.target.closest('button'); if (!button) return;
    if (button.closest('#menu') && !button.dataset.close) $('#menu').close();
    if (button.id === 'menu-open') { $('#menu .menu-rc').hidden = !!ROLE || !canReview(); $('#menu').showModal(); return; }
    if (button.dataset.section) {
      if (wide.matches) { sectionKey = button.dataset.section; renderChecklist(); $('#sup-detail').scrollTop = 0; }
      else go('sec-' + button.dataset.section);
      return;
    }
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
    if (button.hasAttribute('data-reset')) { if ($('#tools').open) $('#tools').close(); resetDialogText(); $('#reset-dialog').showModal(); return; }
    if (button.dataset.mark) { commitVerdict(button.dataset.mark, 'manual'); return; }
    if (button.dataset.edit) { openCorrection(button.dataset.edit); return; }
    if (button.dataset.correct) {
      if (Core.isViewer(S)) return;
      var f = Core.correctFruit(S, lastResultId, button.dataset.correct);
      event('Плод ' + f.n + ': отметка исправлена на «' + TITLES[f.verdict].toLowerCase() + '». Решение РЦ требует повторного выбора.');
      save(); $('#correction-dialog').close(); show(route); toast('Отметка исправлена, проба пересчитана'); publishFruit(f); return;
    }
    if (button.id === 'new-room') { location.href = Room.roleLink(baseURL(), Room.newCode(), 'hall', true); return; }
    if (button.dataset.decision) {
      var kind = button.dataset.decision; if (Core.allowedDecisions(S).indexOf(kind) < 0) return;
      lastPublishTs = Math.max(Date.now(), lastPublishTs + 1);
      S.decision = { kind: kind, ts: lastPublishTs }; event(decisionText(kind)); save(); renderRC(); $('#rc-decision').setAttribute('tabindex', '-1'); $('#rc-decision').focus({ preventScroll: true });
      if (sync) {
        sync.publish({ t: 'decision', from: deviceId, ts: S.decision.ts, kind: kind, pallets: Array.from(new Set(boxesWithFindings().map(function (b) { return b.p; }))).slice(0, 50) });
        toast(syncStatus === 'online' ? 'Решение отправлено поставщику' : 'Решение сохранено. Поставщик увидит его, когда вернётся связь.');
      } else toast('Решение сохранено. Поставщик видит ваш ответ.');
    }
  });
  $('#edit-batch').addEventListener('click', function () { openBatchEditor(false); });
  $('#new-batch').addEventListener('click', function () { openBatchEditor(true); });
  $('#report-back').addEventListener('click', function () { go(canReview() ? 'rc' : 'supplier'); });
  $('#open-example').addEventListener('click', function () { go('start'); });
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
  $('#sup-cta').addEventListener('click', function () { var st = Core.stats(S); if (st.needsReview) go('passport'); else if (st.done) review(); else if (S.pending && S.pending.photo) analyze(); else go('pick'); });
  $('#sup-review').addEventListener('click', review);
  $('#sup-extend').addEventListener('click', function () { var st = Core.stats(S), extra = Math.max(1, Core.extraNeeded(S) || 10); S.goal = Math.min(2000, st.checked + extra); S.decision = null; event('Проба расширена до ' + S.goal + ' плодов'); save(); publish('state', Core.tally(S)); go('pick'); });
  $('#cam-shot').addEventListener('click', capture);
  $('#cam-file').addEventListener('change', function () { readFile(this); });
  $('#cam-resume').addEventListener('click', analyze);
  $('#nl-retry').addEventListener('click', function () { if (S.pending) { S.pending.photo = null; S.pending.result = null; S.pending.test = false; S.pending.reason = null; save(); } go('camera'); });
  $('#an-cancel').addEventListener('click', function () { cancelAnalysis(); go('supplier'); });
  $('#res-next').addEventListener('click', function () { if (Core.stats(S).done) review(); else go('pick'); });
  $('#pick-go').addEventListener('click', function () { go('camera'); });
  $('#pass-print').addEventListener('click', printPassport);
  $('#pass-print-2').addEventListener('click', printPassport);
  $('#pass-back').addEventListener('click', function () { if (history.length > 1) history.back(); else go(ROLE === 'rc' ? 'rc' : 'supplier'); });
  $('#start-own').addEventListener('click', function () { openBatchEditor(true); });
  $('#start-create').addEventListener('click', function () {
    cancelAnalysis(); stopCamera(); S = Core.baseState(); draftBatch = null; lastResultId = null;
    event('Создана партия ' + S.batch.code + '. Проверено ' + S.seed.checked + ' из ' + S.goal + '.'); save(); go('supplier');
    toast('Партия создана. Осталось проверить ' + fruitCount(S.goal - S.seed.checked) + '.');
  });
  $('#res-correct').addEventListener('click', function () { openCorrection(resultFruit().id); });
  $('#reset-confirm').addEventListener('click', function () {
    cancelAnalysis(); stopCamera(); lastResultId = null; cameraMessage = ''; $('#reset-dialog').close();
    if (ROLE) {
      // Room reset: back to the stage start on every device of the room, RC decision cleared.
      Core.resetRoomSample(S); uploads.clear(); hallPhotoId = null; event('Проба сброшена: снова ' + S.seed.checked + ' из ' + S.goal + '.'); save(); publish('reset');
      go(ROLE === 'supplier' ? 'supplier' : ROLE); toast('Проба сброшена на всех устройствах комнаты'); return;
    }
    Core.resetSample(S); save(); go('supplier'); toast('Новая проба готова. Начните с первого плода.');
  });
  function resetDialogText() {
    $('#reset-text').textContent = ROLE ? 'Проба вернётся к ' + CONFIG.seed.checked + ' из ' + CONFIG.sampleTotal + ' на всех устройствах этой комнаты: у поставщика, РЦ и в зале. Решение РЦ очистится.' : 'Снимки и решение РЦ в этой пробе будут удалены. Данные партии, замеры и допуски сохранятся. Начнём проверку с первого плода.';
  }
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
  wide.addEventListener('change', function () { if (route === 'supplier') renderChecklist(); else if (wide.matches && /^sec-/.test(route)) { sectionKey = route.slice(4); go('supplier'); } });
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
  if (ROLE) {
    // A shared room: the judge holds the supplier phone, so editing and switching roles is hidden there.
    document.body.classList.add('room-mode', 'role-' + ROLE);
    $$('.seg, .header-actions, #s-supplier [data-go="batches"], #s-supplier .restart, .support-details > .text-link, #menu .menu-edit, #menu .menu-rc').forEach(function (n) { n.hidden = true; });
    $('#s-passport .back').textContent = ROLE === 'supplier' ? 'К партии' : 'К РЦ';
    $('#s-passport .back').dataset.go = ROLE === 'supplier' ? 'supplier' : 'rc';
    requestWakeLock(); startSync();
  }
  // Without a room, fresh links (including old QR links with role only) start as supplier.
  // A completed personal session may return to its report after a reload.
  var initial = location.hash.slice(1);
  if (ROLE) initial = ROLE === 'supplier' ? (initial || 'supplier') : ROLE === 'rc' ? (initial === 'passport' ? 'passport' : 'rc') : 'hall';
  else if (freshStart) initial = 'start';
  else {
    if (!S.fruits.length && !S.pending) initial = 'supplier';
    if (!initial) initial = S.role === 'rc' && canReview() ? 'rc' : 'supplier';
  }
  show(normalizeRoute(initial));
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', function () { navigator.serviceWorker.register('./sw.js').catch(function () { /* Online flow still works if offline caching is unavailable. */ }); });
  }
})();
