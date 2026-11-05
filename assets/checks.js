(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ApronChecks = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  // Preparation checklist of a batch: five sections of readings and documents before shipment, each checked against the chain's specification.
  // The example batch shows sample readings with instruments; numbers, serials, dates and the chain's specification there are illustrative.
  // Instrument models and norms follow the team's research of 5 November 2026 (ГОСТ 34298-2017, ТР ТС 021/2011, UC Davis postharvest).
  var KEYS = ['origin', 'gost', 'cold', 'ripeness', 'safety'];
  var TITLES = { origin: 'Партия и происхождение', gost: 'Проба по ГОСТ', cold: 'Холодовая цепь', ripeness: 'Зрелость и вкус', safety: 'Безопасность и документы' };
  var LEADS = {
    origin: 'Что за партия, откуда она, куда едет и что требует сеть.',
    gost: 'Замеры, по которым по ГОСТ 34298-2017 решается спор о качестве: доля плодов ниже сорта, калибр и масса нетто. Приборы с поверкой.',
    cold: 'Температура плода и кузова при загрузке и логгер на весь рейс: по ним видно, где могла нарушиться холодовая цепь.',
    ripeness: 'Зрелость, плотность и вкус. ГОСТ их числом не задаёт, а сеть задаёт: они показывают, как плоды перенесут дорогу.',
    safety: 'Нитраты и пестициды подтверждает только протокол лаборатории, поэтому здесь документы, а не экспресс-тесты.'
  };
  // Example specification of the fictional chain «Город». Not a real chain's document.
  var CHAIN_SPEC = [
    'Томаты розовые, первый сорт по ГОСТ 34298-2017',
    'Плодов ниже сорта не более 5 % массы, загнивших и подмороженных нет',
    'Калибр 57-67 мм, разброс в ящике до 10 мм',
    'Масса нетто ящика в среднем не меньше 6,0 кг',
    'Температура плода при отгрузке 8-12 °C, уставка кузова 10-12 °C',
    'Логгер температуры в каждом рейсе, запись не реже чем раз в 15 минут',
    'Стадия зрелости 4-5 из 6, однородно в упаковке',
    'Твёрдость не ниже 1,8 кгс, сахаристость не ниже 4,5 °Bx',
    'Сбор не раньше чем за 48 часов до отгрузки, в пути не больше 24 часов',
    'Протоколы на нитраты и пестициды не старше 30 дней, действующая декларация',
    'Паллета не выше 1,8 м, этикетка паллеты читается'
  ];

  function day(d) { return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }); }
  function shift(d, days) { var x = new Date(d.getTime()); x.setDate(x.getDate() + days); return x; }
  function fmt(v) { return String(v).replace('.', ','); }

  function example(today) {
    var yesterday = day(shift(today, -1)), before = day(shift(today, -2));
    var scales = ['Прибор', 'Весы МАССА-К ТВ-S-32.2'], scalesSN = ['Серийный номер', '2041187, пример'], scalesCheck = ['Поверка', 'до 14.03.2027, ФГИС «Аршин»'];
    var probe = ['Прибор', 'Термощуп Testo 104-IR BT, ГРСИ 64813-16'], probeSN = ['Серийный номер', '61504822, пример'], probeCheck = ['Поверка', 'до 20.08.2027, ФГИС «Аршин»'];
    var ok = function (req) { return { req: req, ok: true }; };
    return {
      origin: { summary: 'Теплица, сбор ' + yesterday, items: [
        { name: 'Требования сети', value: '«Город», пример', details: ['Спецификация на томаты розовые, ' + CHAIN_SPEC.length + ' пунктов. Каждый замер ниже сверяется с ней.'], list: CHAIN_SPEC },
        { name: 'Продукция', value: 'Томаты розовые, 10 т', details: ['Первый сорт по ГОСТ 34298-2017', 'Партия 0611-07, поставщик «Южная гряда»'], check: ok('томаты розовые, первый сорт') },
        { name: 'Выращивание', value: 'Теплица', details: ['Защищённый грунт, Волгоградская область', 'Для теплицы норма нитратов 300 мг/кг, для открытого грунта 150'] },
        { name: 'Сбор и упаковка', value: 'Вчера и сегодня', details: ['Сбор ' + yesterday + ', упаковка сегодня в 08:30', 'Ящик 6 кг нетто, маркировка по ГОСТ'], check: ok('сбор не раньше чем за 48 часов до отгрузки') },
        { name: 'Партия', value: '20 паллет, 1680 ящиков', details: ['84 ящика на паллете'] },
        { name: 'Рейс', value: '900 км, 12 часов', details: ['Выезд сегодня в 18:00, прибытие завтра в 06:00, рефрижератор', 'Получатель: сеть «Город», РЦ Север'], check: ok('в пути не больше 24 часов') }
      ] },
      gost: { summary: 'Ниже сорта 4,1 % массы, калибр 58-67 мм', items: [
        { name: 'Отбор пробы', value: '25 ящиков', details: ['Из 1680 ящиков партии, места выбраны случайно', 'Объединённая проба 3,2 кг, по ГОСТ не меньше 3 кг'], check: ok('не меньше 20 ящиков, проба от 3 кг'),
          meta: [scales, scalesSN, scalesCheck, ['Отобрал', 'Кладовщик, сегодня 13:20']] },
        { name: 'Плоды ниже сорта', value: '4,1 % массы', details: ['По ГОСТ для первого сорта допускается до 10 %, из них до 1 % ниже второго', 'Не соответствуют второму сорту 0,3 %: открытая трещина', 'Загнивших, подмороженных и зелёных нет'], check: ok('не более 5 % массы, загнивших нет'),
          meta: [scales, scalesSN, scalesCheck, ['Сортировал', 'Контролёр качества, сегодня 13:40'], ['Фото фракций', '4 снимка']] },
        { name: 'Калибр', value: '58-67 мм', details: ['Разброс в ящике до 9 мм', 'Некалиброванных 2 %, по ГОСТ допускается 10 %'], check: ok('57-67 мм, разброс до 10 мм'),
          meta: [['Прибор', 'Штангенциркуль ШЦЦ-I-150-0,01, ГОСТ 166-89'], ['Серийный номер', '1129630, пример'], ['Поверка', 'до 02.06.2027, ФГИС «Аршин»'], ['Измерил', 'Контролёр качества, сегодня 13:55'], ['Где', 'Паллета 7, ящик 23; паллета 3, ящик 11; паллета 12, ящик 5']] },
        { name: 'Масса нетто ящика', value: '6,04 кг', details: ['Средняя по 10 ящикам при номинале 6,0 кг', 'Минимум 5,98 кг, тара 0,42 кг'], check: ok('в среднем не меньше 6,0 кг'),
          meta: [scales, scalesSN, scalesCheck, ['Взвесил', 'Кладовщик, сегодня 14:05'], ['Где', 'Паллета 7']] }
      ] },
      cold: { summary: 'Плод 11,6 °C, логгер на рейс запущен', items: [
        { name: 'Температура плода', value: '11,6 °C', details: ['3 плода: центр и край паллеты 7, щуп в мякоть', 'ГОСТ температуру не задаёт; ориентир хранения дозревающих томатов 10-12,5 °C'], check: ok('8-12 °C при отгрузке'),
          meta: [probe, probeSN, probeCheck, ['Измерил', 'Контролёр качества, сегодня 14:20'], ['Передача', 'По Bluetooth в приложение прибора']] },
        { name: 'Кузов при загрузке', value: '11,0 °C', details: ['Уставка рефустановки 11 °C, кузов охлаждён заранее', 'Чистый, без постороннего запаха, без бананов и яблок рядом'], check: ok('уставка 10-12 °C, кузов охлаждён заранее'),
          meta: [['Источник', 'Табло рефустановки, фото'], ['Контрольный замер', 'Testo 104-IR BT, 61504822, пример'], ['Записал', 'Старший смены, сегодня 15:10']] },
        { name: 'Логгер на рейс', value: 'Запущен', details: ['Пишет температуру каждые 10 минут, на приёмке РЦ получает PDF по USB', 'Ящик в центре паллеты 7 у задней двери'], check: ok('логгер в каждом рейсе, запись не реже раза в 15 минут'),
          meta: [['Прибор', 'Логгер Testo 184 T3'], ['Серийный номер', '39017744, пример'], ['Запущен', 'Сегодня 15:20'], ['Пломба', '№ 0458812, пример'], ['Запустил', 'Старший смены']] }
      ] },
      ripeness: { summary: 'Стадия 5 из 6, 4,8 °Bx', items: [
        { name: 'Окраска и зрелость', value: 'Стадия 5 из 6', details: ['Розовые, однородно в упаковке, зелёных нет', 'Шкала зрелости USDA; для розовых сортов это ориентир'], check: ok('стадия 4-5 из 6, однородно'),
          meta: [['Как', 'Фото со шкалой при одном освещении, 3 снимка'], ['Сверил', 'Контролёр качества, сегодня 13:50'], ['Где', 'Паллеты 3, 7, 12']] },
        { name: 'Твёрдость', value: '2,1 кгс', details: ['Среднее по 10 плодам, насадка 8 мм, со шкуркой', 'ГОСТ числом не нормирует, требует «плотные» плоды'], check: ok('не ниже 1,8 кгс'),
          meta: [['Прибор', 'Пенетрометр FT 327'], ['Серийный номер', '3270415, пример'], ['Калибровка', '01.10.2026, прибор не из Госреестра, поэтому не поверка'], ['Измерил', 'Контролёр качества, сегодня 14:30']] },
        { name: 'Сахаристость и кислотность', value: '4,8 °Bx; 0,42 %', details: ['Кислотность по лимонной кислоте, сок 5 плодов', 'ГОСТ для свежих томатов не нормирует'], check: ok('не ниже 4,5 °Bx'),
          meta: [['Прибор', 'Рефрактометр Atago PAL-BX|ACID3'], ['Серийный номер', '7303118, пример'], ['Калибровка', 'По дистиллированной воде, сегодня 14:35'], ['Измерил', 'Контролёр качества, сегодня 14:40']] }
      ] },
      safety: { summary: 'Протоколы и декларация приложены', items: [
        { name: 'Нитраты', value: '112 мг/кг', details: ['Норма для теплицы 300 мг/кг по ТР ТС 021/2011', 'Метод ГОСТ 34570-2019, аккредитованная лаборатория'], check: ok('в пределах ТР ТС, протокол не старше 30 дней'),
          meta: [['Документ', 'Протокол испытаний № 1452, пример'], ['Дата', before]] },
        { name: 'Пестициды', value: 'В пределах норм', details: ['ТР ТС 021/2011, лабораторные методы'], check: ok('в пределах ТР ТС, протокол не старше 30 дней'), meta: [['Документ', 'Протокол испытаний № 1453, пример'], ['Дата', before]] },
        { name: 'Декларация соответствия', value: 'Действует', details: ['ЕАЭС, на томаты свежие'], check: ok('действующая декларация'), meta: [['Документ', 'Номер в реестре, пример']] },
        { name: 'Маркировка ящиков', value: 'Проверена', details: ['Наименование, сорт, калибр, масса нетто, дата упаковки'] },
        { name: 'Тара и паллеты', value: 'Проверены', details: ['Ящики целые и чистые, паллеты обмотаны, высота 1,7 м'], check: ok('паллета не выше 1,8 м, этикетка читается') },
        { name: 'ТТН и УПД', value: 'Готовы', details: ['Подписываются при погрузке'] }
      ] }
    };
  }

  // Own batches show what the supplier has entered; empty readings stay empty and no chain checks are invented.
  function own(batch, files) {
    var m = batch.measurements, d = batch.documents, filled = function (v, unit) { return v === null ? 'Не измеряли' : fmt(v) + ' ' + unit; };
    var docNames = { declaration: 'Декларация соответствия', quality: 'Паспорт качества', lab: 'Протокол испытаний', shipment: 'ТТН и УПД', labels: 'Маркировка и даты' };
    var docs = Object.keys(docNames), ready = docs.filter(function (k) { return d[k] || (files[k] || 0) > 0; });
    var trip = [batch.departure && 'Выезд ' + batch.departure, batch.arrival && 'прибытие ' + batch.arrival, batch.distance !== null && batch.distance + ' км'].filter(Boolean).join(', ');
    var rules = batch.rules.split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
    return {
      origin: { done: true, summary: batch.supplier + ', партия ' + batch.code, items: [
        { name: 'Требования сети', value: rules.length ? rules.length + ' пунктов' : 'Не указаны', details: ['Допуски: брак ' + fmt(batch.tolerance.defect) + ' %, не по критериям ' + fmt(batch.tolerance.offspec) + ' %'], list: rules },
        { name: 'Продукция', value: batch.product + ', ' + fmt(batch.weight) + ' т', details: ['Сорт ' + batch.grade + ' по ГОСТ 34298-2017'] },
        { name: 'Партия', value: batch.pallets + ' × ' + batch.boxesPerPallet + ' ящиков', details: ['Паллет × ящиков на паллете'] },
        { name: 'Рейс', value: 'Сеть «' + batch.chain + '»', details: [batch.rc, trip || 'Рейс не указан'] }
      ] },
      gost: { done: m.caliber !== null && m.mass !== null, summary: m.caliber !== null || m.mass !== null ? [m.caliber !== null && 'калибр ' + fmt(m.caliber) + ' мм', m.mass !== null && 'масса ' + fmt(m.mass) + ' кг'].filter(Boolean).join(', ') : 'Не заполнено', items: [
        { name: 'Калибр', value: filled(m.caliber, 'мм'), details: ['Штангенциркуль'] },
        { name: 'Масса нетто ящика', value: filled(m.mass, 'кг'), details: ['Весы'] }
      ] },
      cold: { done: m.temperature !== null, summary: m.temperature !== null ? 'Плод ' + fmt(m.temperature) + ' °C' : 'Не заполнено', items: [
        { name: 'Температура плода', value: filled(m.temperature, '°C'), details: ['Термощуп в мякоть'] }
      ] },
      ripeness: { done: m.firmness !== null && m.brix !== null, summary: m.firmness !== null || m.brix !== null ? [m.firmness !== null && 'твёрдость ' + fmt(m.firmness), m.brix !== null && fmt(m.brix) + ' °Bx'].filter(Boolean).join(', ') : 'Не заполнено', items: [
        { name: 'Твёрдость', value: filled(m.firmness, 'кг/см²'), details: ['Пенетрометр'] },
        { name: 'Сахаристость', value: filled(m.brix, '°Bx'), details: ['Рефрактометр'] }
      ] },
      safety: { done: ready.length === docs.length && batch.packaging, summary: 'Документы ' + ready.length + ' из ' + docs.length + (batch.packaging ? ', упаковка проверена' : ''), items: [
        { name: 'Нитраты', value: filled(m.nitrates, 'мг/кг'), details: ['Юридический вес имеет протокол лаборатории'] }
      ].concat(docs.map(function (k) { return { name: docNames[k], value: (files[k] || 0) > 0 ? 'Файлов: ' + files[k] : d[k] ? 'Отмечено' : 'Нет', details: [] }; }), [
        { name: 'Тара и паллеты', value: batch.packaging ? 'Проверены' : 'Не отмечено', details: [] }
      ]) }
    };
  }

  // sections(batch, { today, files }) -> [{ key, title, lead, summary, done, example, items }]
  function sections(batch, opts) {
    opts = opts || {};
    var data = batch.example ? example(opts.today || new Date()) : own(batch, opts.files || {});
    return KEYS.map(function (k) {
      var s = data[k];
      return { key: k, title: TITLES[k], lead: LEADS[k], summary: s.summary, done: batch.example ? true : !!s.done, example: !!batch.example, items: s.items };
    });
  }
  // How many of the chain's checked requirements are met.
  function requirements(list) {
    var checks = [];
    list.forEach(function (s) { s.items.forEach(function (i) { if (i.check) checks.push({ section: s.title, name: i.name, value: i.value, req: i.check.req, ok: i.check.ok }); }); });
    return { total: checks.length, met: checks.filter(function (c) { return c.ok; }).length, checks: checks };
  }

  // What happens to the fruit on the way, the risks, how to avoid them and what the RC checks at the dock.
  // Postharvest ranges are guidance from UC Davis, not a forecast of this batch.
  function transit(batch, ctx) {
    ctx = ctx || {};
    var trip = batch.example ? 'около 12 часов, 900 км' : [batch.distance !== null && batch.distance + ' км', batch.arrival && 'прибытие ' + batch.arrival].filter(Boolean).join(', ') || 'время в пути не указано';
    var boxes = (ctx.boxes || []).map(function (b) { return 'паллета ' + b.p + ', ящик ' + b.b; });
    var forecast = [
      'В пути ' + trip + ' в рефрижераторе при 10-12 °C. При таком режиме томаты продолжают медленно дозревать: к приёмке плоды стадии 5 ожидаемо станут ближе к стадии 6 и чуть мягче. Это ориентир по данным UC Davis, а не прогноз для конкретной партии.',
      'Если кузов нагреется выше 15 °C дольше чем на пару часов, плоды быстрее мягчеют и дозревают, растёт риск гнили. Если опустится ниже 8-10 °C, возможны холодовые повреждения: водянистые пятна и неравномерная окраска. Кривая логгера покажет, было ли это.',
      'Механические повреждения в дороге чаще в нижних ящиках и у задней двери: там сильнее вибрация и удары при погрузке и выгрузке.'
    ];
    var risks = [
      { risk: 'Перегрев кузова', why: 'Плоды мягчеют, быстрее дозревают, растёт гниль', avoid: 'Уставка 10-12 °C, кузов охлаждён заранее, двери в пути не открывать', check: 'Кривая логгера и температура мякоти 3 плодов у задней двери' },
      { risk: 'Переохлаждение ниже 8 °C', why: 'Холодовые повреждения: водянистые пятна, плоды плохо доходят по цвету', avoid: 'Не ставить уставку ниже 10 °C, датчик не у самого испарителя', check: 'Минимумы на кривой логгера, пятна на плодах из передних паллет' },
      { risk: 'Дозревание в пути', why: 'Розовые плоды краснеют и мягчеют, особенно рядом с бананами и яблоками', avoid: 'Без совместной загрузки с бананами и яблоками, отгружать стадию 4-5', check: 'Стадия зрелости и твёрдость 10 плодов, сеть требует не ниже 1,8 кгс' },
      { risk: 'Удары и вибрация', why: 'Вмятины и трещины, чаще в нижних ящиках', avoid: 'Паллеты обмотаны и не выше 1,8 м, ремни в кузове', check: 'Нижние ящики паллет у задней двери' },
      { risk: 'Конденсат при выгрузке', why: 'Тёплый воздух на холодных плодах, плесень за 1-2 дня', avoid: 'Выгружать сразу в холодную камеру, не держать паллеты на рампе', check: 'Сколько времени паллеты простояли на рампе до камеры' }
    ];
    if (boxes.length) risks.push({ risk: 'Брак, найденный в пробе', why: 'В этих местах уже были дефектные плоды: рядом могут быть ещё', avoid: 'Досортировать эти паллеты до отгрузки', check: 'Первыми вскрыть: ' + boxes.join('; ') });
    var dock = (boxes.length ? ['Первыми вскройте: ' + boxes.join('; ') + '.'] : []).concat(ctx.hints || [], [
      'Сверьте номер пломбы' + (batch.example ? ' № 0458812' : '') + ' и снимите PDF с логгера' + (batch.example ? ' № 39017744' : '') + '.',
      'Измерьте температуру мякоти 3 плодов у задней двери.',
      'Вскройте 3 своих случайных места.'
    ]);
    return { forecast: forecast, risks: risks, dock: dock };
  }

  return { KEYS: KEYS, TITLES: TITLES, CHAIN_SPEC: CHAIN_SPEC, sections: sections, requirements: requirements, transit: transit };
});
