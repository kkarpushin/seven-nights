/*
 * «Семь ночей» — модуль визуализации (ванильный JS, ES2020, только SVG).
 *
 * Публичный API (объявляется синхронно, до выполнения quiz.js):
 *   window.SevenNights = {
 *     drawHeroChart(el),                  // график «семь вечеров: до / после»
 *     drawDots(el),                       // мотив семи точек
 *     drawRing(el, value, max, animate)   // кольцо-дуга результата теста
 *   }
 *
 * Зависимостей нет. Цвета и шрифты берутся ТОЛЬКО из CSS-переменных :root
 * (см. FALLBACK — там же значения из §2.1 дизайна на случай, если styles.css
 * не подключился; модуль тогда рисует ровно в тех же цветах, а не ломается).
 */
(function () {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';

  /* ------------------------------------------------------------------ *
   * 1. Палитра и типографика
   * ------------------------------------------------------------------ */

  // Запасные значения = таблица токенов из §2.1 дизайна лендинга.
  // Используются, только если переменной нет в :root (styles.css не загрузился).
  var FALLBACK = {
    '--night': '#0F1233',
    '--dusk': '#1A1E4A',
    '--moon': '#F3EEE3',
    '--mist': '#A9ACC8',
    '--lamp': '#F2B56B',
    '--before': '#8A93D6',
    '--font-display': "'Prata', Georgia, 'Times New Roman', serif",
    '--font-body': "'Golos Text', system-ui, -apple-system, 'Segoe UI', sans-serif"
  };

  // Синонимы: сначала пробуем основное имя, потом альтернативное.
  var FONT_DISPLAY_ALIASES = ['--font-display', '--font-prata', '--font-heading'];
  var FONT_BODY_ALIASES = ['--font-body', '--font-text', '--font-golos'];

  /**
   * Читает первую непустую CSS-переменную из списка имён.
   * Пустая строка возвращается, когда переменная не объявлена, — тогда падаем
   * на запасное значение. Значение не парсим: подходит любой формат цвета.
   */
  function cssVar(names, fallback) {
    var root = document.documentElement;
    var cs;
    try {
      cs = window.getComputedStyle(root);
    } catch (e) {
      return fallback;
    }
    for (var i = 0; i < names.length; i++) {
      var raw = cs.getPropertyValue(names[i]);
      if (raw && raw.trim()) return raw.trim();
    }
    return fallback;
  }

  // Палитру читаем на каждую отрисовку — так модуль подхватывает изменения,
  // если styles.css догрузился позже или переменные переопределили.
  function palette() {
    return {
      night: cssVar(['--night'], FALLBACK['--night']),
      dusk: cssVar(['--dusk'], FALLBACK['--dusk']),
      moon: cssVar(['--moon'], FALLBACK['--moon']),
      mist: cssVar(['--mist'], FALLBACK['--mist']),
      lamp: cssVar(['--lamp'], FALLBACK['--lamp']),
      before: cssVar(['--before'], FALLBACK['--before']),
      fontDisplay: cssVar(FONT_DISPLAY_ALIASES, FALLBACK['--font-display']),
      fontBody: cssVar(FONT_BODY_ALIASES, FALLBACK['--font-body'])
    };
  }

  /* ------------------------------------------------------------------ *
   * 2. Мелкие утилиты
   * ------------------------------------------------------------------ */

  function el(name, attrs) {
    var node = document.createElementNS(SVG_NS, name);
    if (attrs) {
      for (var k in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, k) && attrs[k] != null) {
          node.setAttribute(k, String(attrs[k]));
        }
      }
    }
    return node;
  }

  function reducedMotion() {
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (e) {
      return false;
    }
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function round(v) {
    return Math.round(v * 100) / 100;
  }

  // Принудительный пересчёт стилей: без него Safari склеивает два присваивания
  // stroke-dashoffset в одно и переход не запускается.
  function reflow(node) {
    /* eslint-disable no-unused-expressions */
    node.getBoundingClientRect();
  }

  var uidCounter = 0;
  function uid(prefix) {
    uidCounter += 1;
    return prefix + '-' + uidCounter;
  }

  /* ------------------------------------------------------------------ *
   * 3. Сглаживание линий
   * ------------------------------------------------------------------ */

  /**
   * Монотонная кубическая интерполяция (Fritsch–Carlson) — это Catmull-Rom
   * с ограничением касательных. Обычный Catmull-Rom на данных вида 4, 4, 5
   * даёт провал ниже 4 между равными точками, то есть рисует изменение,
   * которого в данных нет. Здесь линия гладкая, но никогда не выходит
   * за пределы соседних значений.
   *
   * Возвращает массив сегментов {c1x, c1y, c2x, c2y, x, y} — по одному на
   * промежуток между точками. Хранить их отдельно нужно, чтобы построить
   * тот же путь в обратную сторону (для заливки между линиями).
   */
  function smoothSegments(pts) {
    var n = pts.length;
    if (n < 2) return [];

    var dx = [];
    var slope = [];
    var i;
    for (i = 0; i < n - 1; i++) {
      dx[i] = pts[i + 1].x - pts[i].x;
      slope[i] = (pts[i + 1].y - pts[i].y) / dx[i];
    }

    var m = [];
    m[0] = slope[0];
    m[n - 1] = slope[n - 2];
    for (i = 1; i < n - 1; i++) {
      m[i] = (slope[i - 1] + slope[i]) / 2;
    }
    // Ограничение касательных: на плоских участках — строго 0, на остальных
    // не больше трёх наклонов отрезка (иначе появится «перелёт»).
    for (i = 0; i < n - 1; i++) {
      if (slope[i] === 0) {
        m[i] = 0;
        m[i + 1] = 0;
      } else {
        var a = m[i] / slope[i];
        var b = m[i + 1] / slope[i];
        if (a < 0) m[i] = 0;
        if (b < 0) m[i + 1] = 0;
        if (a > 3) m[i] = 3 * slope[i];
        if (b > 3) m[i + 1] = 3 * slope[i];
      }
    }

    var segs = [];
    for (i = 0; i < n - 1; i++) {
      var h = dx[i] / 3;
      segs.push({
        c1x: pts[i].x + h,
        c1y: pts[i].y + m[i] * h,
        c2x: pts[i + 1].x - h,
        c2y: pts[i + 1].y - m[i + 1] * h,
        x: pts[i + 1].x,
        y: pts[i + 1].y
      });
    }
    return segs;
  }

  function forwardPath(pts, segs) {
    var d = 'M' + round(pts[0].x) + ',' + round(pts[0].y);
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      d += 'C' + round(s.c1x) + ',' + round(s.c1y) +
           ' ' + round(s.c2x) + ',' + round(s.c2y) +
           ' ' + round(s.x) + ',' + round(s.y);
    }
    return d;
  }

  // Тот же путь справа налево: контрольные точки каждого сегмента меняются местами.
  function reversePath(pts, segs) {
    var last = pts[pts.length - 1];
    var d = 'L' + round(last.x) + ',' + round(last.y);
    for (var i = segs.length - 1; i >= 0; i--) {
      var s = segs[i];
      d += 'C' + round(s.c2x) + ',' + round(s.c2y) +
           ' ' + round(s.c1x) + ',' + round(s.c1y) +
           ' ' + round(pts[i].x) + ',' + round(pts[i].y);
    }
    return d;
  }

  /* ------------------------------------------------------------------ *
   * 4. Фазы луны (ось X геройского графика)
   * ------------------------------------------------------------------ */

  /**
   * Освещённая часть луны при доле освещённости f (0 — новолуние, 1 — полная).
   * Правый полукруг — всегда край диска, левая граница — терминатор: дуга
   * эллипса с полуосью r*|1-2f|, выгнутая вправо при f<0.5 и влево при f>0.5.
   */
  function moonPath(cx, cy, r, f) {
    var rx = round(r * Math.abs(1 - 2 * f));
    var sweep = f < 0.5 ? 0 : 1;
    var top = round(cy - r);
    var bottom = round(cy + r);
    var x = round(cx);
    return 'M' + x + ',' + top +
      'A' + r + ',' + r + ' 0 0,1 ' + x + ',' + bottom +
      'A' + rx + ',' + r + ' 0 0,' + sweep + ' ' + x + ',' + top + 'Z';
  }

  /* ------------------------------------------------------------------ *
   * 5. drawHeroChart — сигнатурный график «семь вечеров»
   * ------------------------------------------------------------------ */

  // Данные-пример из §2.4 design-landing.md. Не обещание, а иллюстрация:
  // подпись «Пример» рядом с графиком обязательна и живёт в index.html.
  var HERO_BEFORE = [4, 4, 5, 5, 5, 6, 6];
  var HERO_AFTER = [5, 6, 6, 7, 7, 7, 7];

  // Описание графика для скринридера. Ставится на слот после отрисовки.
  var HERO_ARIA_LABEL = 'График семи вечеров: линия «до» и линия «после». Пример.';

  var SCALE_MIN = 0;
  var SCALE_MAX = 10;

  var heroStates = new WeakMap();

  function heroGeometry(width) {
    var compact = width < 480;
    var w = clamp(Math.round(width), 280, 860);
    var h = compact ? 230 : 300;
    var moonR = compact ? 8 : 10;
    var moonCy = 4 + moonR;
    var numFont = compact ? 12 : 13;
    var axisFont = compact ? 12 : 14;
    var labelFont = compact ? 12 : 13;
    var numBaseline = h - 5;
    return {
      compact: compact,
      w: w,
      h: h,
      padLeft: compact ? 28 : 34,
      padRight: compact ? 56 : 68,
      moonR: moonR,
      moonCy: moonCy,
      plotTop: moonCy + moonR + (compact ? 18 : 22),
      plotBottom: numBaseline - numFont - (compact ? 8 : 10),
      numBaseline: numBaseline,
      numFont: numFont,
      axisFont: axisFont,
      labelFont: labelFont
    };
  }

  /**
   * Рисует геройский график в переданный контейнер.
   * Контейнер сам несёт role="img" и aria-label (см. index.html), поэтому
   * SVG внутри помечаем aria-hidden — иначе скринридер прочитает всё дважды.
   */
  function drawHeroChart(node, opts) {
    if (!node) return null;
    opts = opts || {};

    var p = palette();
    var width = node.clientWidth || node.getBoundingClientRect().width || 360;
    var g = heroGeometry(width);

    var state = heroStates.get(node) || { phase: 'idle', width: 0, timers: [], play: null };
    // Отменяем таймеры прошлой отрисовки: иначе после перерисовки они
    // продолжат менять уже удалённые из DOM узлы.
    state.timers.forEach(clearTimeout);
    state.timers = [];
    state.play = null;
    state.width = width;
    heroStates.set(node, state);

    // static = финальное состояние без анимации (reduced-motion, перерисовка
    // после ресайза у уже показанного графика, отсутствие IntersectionObserver).
    var animate = opts.animate === true && !reducedMotion();

    var plotW = g.w - g.padLeft - g.padRight;
    var plotH = g.plotBottom - g.plotTop;
    var step = plotW / (HERO_BEFORE.length - 1);

    function xAt(i) { return g.padLeft + step * i; }
    function yAt(v) {
      var t = (clamp(v, SCALE_MIN, SCALE_MAX) - SCALE_MIN) / (SCALE_MAX - SCALE_MIN);
      return g.plotBottom - t * plotH;
    }

    var beforePts = HERO_BEFORE.map(function (v, i) { return { x: xAt(i), y: yAt(v) }; });
    var afterPts = HERO_AFTER.map(function (v, i) { return { x: xAt(i), y: yAt(v) }; });
    var beforeSegs = smoothSegments(beforePts);
    var afterSegs = smoothSegments(afterPts);

    var svg = el('svg', {
      viewBox: '0 0 ' + g.w + ' ' + g.h,
      width: '100%',
      preserveAspectRatio: 'xMidYMid meet',
      'aria-hidden': 'true',
      focusable: 'false'
    });
    svg.style.display = 'block';
    svg.style.width = '100%';
    svg.style.height = 'auto';
    // aspect-ratio — страховка для старых WebKit, где height:auto у inline SVG
    // иногда сводится к дефолтным 150px вместо пропорции из viewBox.
    svg.style.aspectRatio = g.w + ' / ' + g.h;
    svg.style.overflow = 'visible';

    // Градиент акцентной линии: тот же тон, только светлеет к концу недели.
    // Другого цвета не вводим — никакой оценочности «хуже/лучше».
    var gradId = uid('sn-lamp');
    var defs = el('defs');
    var grad = el('linearGradient', {
      id: gradId, x1: '0', y1: '0', x2: '1', y2: '0'
    });
    var stopA = el('stop', { offset: '0', 'stop-color': p.lamp, 'stop-opacity': '0.62' });
    var stopB = el('stop', { offset: '1', 'stop-color': p.lamp, 'stop-opacity': '1' });
    grad.appendChild(stopA);
    grad.appendChild(stopB);
    defs.appendChild(grad);
    svg.appendChild(defs);

    /* --- ось: две деликатные линии 0 и 10 + подписи Prata --- */
    var axis = el('g');
    [SCALE_MIN, SCALE_MAX].forEach(function (v) {
      var y = yAt(v);
      axis.appendChild(el('line', {
        x1: g.padLeft - 2, y1: round(y), x2: g.w - g.padRight + 6, y2: round(y),
        stroke: p.mist, 'stroke-opacity': '0.12', 'stroke-width': '1'
      }));
      axis.appendChild(el('circle', {
        cx: g.padLeft - 6, cy: round(y), r: 1.6, fill: p.mist, 'fill-opacity': '0.5'
      }));
      /* Цифры оси набираем Golos, а не Prata: в Prata единица читается как
         строчная «l», и верхняя граница шкалы выглядит как «l0». Prata
         остаётся на крупной строке «Было 4. Стало 7.» (§2.3). */
      var t = el('text', {
        x: g.padLeft - 12, y: round(y + g.axisFont * 0.35),
        'text-anchor': 'end', fill: p.mist, 'font-size': g.axisFont,
        'font-family': p.fontBody, 'font-weight': '500',
        'font-variant-numeric': 'tabular-nums'
      });
      t.textContent = String(v);
      axis.appendChild(t);
    });
    svg.appendChild(axis);

    /* --- семь фаз луны сверху --- */
    var moons = el('g');
    var moonNodes = [];
    for (var i = 0; i < HERO_BEFORE.length; i++) {
      var f = (i + 1) / HERO_BEFORE.length; // от тонкого серпа к полной луне
      var mg = el('g');
      mg.appendChild(el('circle', {
        cx: round(xAt(i)), cy: g.moonCy, r: g.moonR,
        fill: p.moon, 'fill-opacity': '0.08'
      }));
      mg.appendChild(el('path', {
        d: moonPath(xAt(i), g.moonCy, g.moonR, f),
        fill: p.moon, 'fill-opacity': '0.7'
      }));
      moons.appendChild(mg);
      moonNodes.push(mg);
    }
    svg.appendChild(moons);

    /* --- тёплая область разницы между линиями --- */
    var areaD = forwardPath(afterPts, afterSegs) +
      reversePath(beforePts, beforeSegs) + 'Z';
    var area = el('path', {
      d: areaD, fill: p.lamp, 'fill-opacity': '0.08', stroke: 'none'
    });
    svg.appendChild(area);

    /* --- линии --- */
    var beforeLine = el('path', {
      d: forwardPath(beforePts, beforeSegs),
      fill: 'none', stroke: p.before, 'stroke-opacity': '0.8',
      'stroke-width': g.compact ? 2.2 : 2.5,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round'
    });
    var afterLine = el('path', {
      d: forwardPath(afterPts, afterSegs),
      fill: 'none', stroke: 'url(#' + gradId + ')',
      'stroke-width': g.compact ? 3 : 3.4,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round'
    });
    svg.appendChild(beforeLine);
    svg.appendChild(afterLine);

    /* --- точки на узлах --- */
    var beforeDots = [];
    var afterDots = [];
    beforePts.forEach(function (pt) {
      var c = el('circle', {
        cx: round(pt.x), cy: round(pt.y), r: 2.5,
        fill: p.before, 'fill-opacity': '0.85'
      });
      svg.appendChild(c);
      beforeDots.push(c);
    });
    afterPts.forEach(function (pt) {
      var c = el('circle', {
        cx: round(pt.x), cy: round(pt.y), r: 3,
        fill: p.lamp, stroke: p.night, 'stroke-width': 1.5
      });
      svg.appendChild(c);
      afterDots.push(c);
    });

    /* --- подписи вечеров 1…7 --- */
    var nums = el('g');
    for (i = 0; i < HERO_BEFORE.length; i++) {
      var nt = el('text', {
        x: round(xAt(i)), y: g.numBaseline, 'text-anchor': 'middle',
        fill: p.mist, 'font-size': g.numFont, 'font-family': p.fontBody,
        'font-variant-numeric': 'tabular-nums'
      });
      nt.textContent = String(i + 1);
      nums.appendChild(nt);
    }
    svg.appendChild(nums);

    /* --- подписи линий прямо у последних точек, без коробки-легенды --- */
    var lastBefore = beforePts[beforePts.length - 1];
    var lastAfter = afterPts[afterPts.length - 1];
    var yBefore = lastBefore.y + g.labelFont * 0.34;
    var yAfter = lastAfter.y + g.labelFont * 0.34;
    // Если значения близко, подписи налезут друг на друга — разводим по вертикали.
    var minGap = g.labelFont + 5;
    if (yBefore - yAfter < minGap) {
      var mid = (yBefore + yAfter) / 2;
      yAfter = mid - minGap / 2;
      yBefore = mid + minGap / 2;
    }
    var labelX = round(lastAfter.x + 10);
    var beforeLabel = el('text', {
      x: labelX, y: round(yBefore), fill: p.before,
      'font-size': g.labelFont, 'font-family': p.fontBody, 'font-weight': '500'
    });
    beforeLabel.textContent = 'до';
    var afterLabel = el('text', {
      x: labelX, y: round(yAfter), fill: p.lamp,
      'font-size': g.labelFont, 'font-family': p.fontBody, 'font-weight': '600'
    });
    afterLabel.textContent = 'после';
    svg.appendChild(beforeLabel);
    svg.appendChild(afterLabel);

    node.textContent = '';
    node.appendChild(svg);

    /* Описание картинки ставим только теперь, когда картинка есть. Если модуль
       не выполнился, на слоте не должно быть role="img": скринридеру нечего
       описывать, а человек без JS видит пустое место, а не «график». */
    node.setAttribute('role', 'img');
    node.setAttribute('aria-label', HERO_ARIA_LABEL);

    /* --- анимация --- */
    var BEFORE_DELAY = 300;
    var AFTER_DELAY = 700;
    var LINE_DUR = 1200;
    var EASE = 'cubic-bezier(0.37, 0, 0.29, 1)';

    function later(fn, ms) {
      state.timers.push(setTimeout(fn, ms));
    }

    // Подготовка линии: длину меряем сразу, линию прячем пунктиром в её же длину.
    function primeLine(path) {
      var len;
      try {
        len = path.getTotalLength();
      } catch (e) {
        len = 0;
      }
      if (!len) return 0; // getTotalLength недоступен — линию просто оставляем видимой
      path.style.strokeDasharray = len + ' ' + len;
      path.style.strokeDashoffset = String(len);
      return len;
    }

    function releaseLine(path, len, delay) {
      if (!len) return;
      reflow(path);
      path.style.transition = 'stroke-dashoffset ' + LINE_DUR + 'ms ' + EASE + ' ' + delay + 'ms';
      path.style.strokeDashoffset = '0';
      // Пунктир после анимации убираем: иначе при ресайзе линия «рвётся».
      later(function () {
        path.style.transition = '';
        path.style.strokeDasharray = 'none';
      }, delay + LINE_DUR + 60);
    }

    function hide(target) {
      target.style.opacity = '0';
    }

    function show(target, delay, dur) {
      reflow(target);
      target.style.transition = 'opacity ' + dur + 'ms ease-out ' + delay + 'ms';
      target.style.opacity = '1';
    }

    if (!animate) {
      state.phase = 'done';
      state.play = null;
      return svg;
    }

    // Прячем всё, что будет проявляться. Важно: SVG уже в DOM и занимает
    // свою высоту — когда анимация начнётся, страница не дёрнется.
    var fadeTargets = moonNodes.concat(beforeDots, afterDots, [beforeLabel, afterLabel, area]);
    fadeTargets.forEach(hide);
    var beforeLen = primeLine(beforeLine);
    var afterLen = primeLine(afterLine);

    state.phase = 'idle';
    state.play = function () {
      state.phase = 'animating';
      // 1. Луны проявляются слева направо.
      moonNodes.forEach(function (mg, idx) {
        show(mg, idx * 50, 300);
      });
      // 2. Линии прочерчиваются; точки зажигаются там, где линия уже прошла.
      releaseLine(beforeLine, beforeLen, BEFORE_DELAY);
      releaseLine(afterLine, afterLen, AFTER_DELAY);
      beforeDots.forEach(function (c, idx) {
        show(c, BEFORE_DELAY + LINE_DUR * (idx / (beforeDots.length - 1)) * 0.95, 260);
      });
      afterDots.forEach(function (c, idx) {
        show(c, AFTER_DELAY + LINE_DUR * (idx / (afterDots.length - 1)) * 0.95, 260);
      });
      // 3. Подписи линий — каждая в момент, когда её линия дорисовалась.
      show(beforeLabel, BEFORE_DELAY + LINE_DUR - 150, 300);
      show(afterLabel, AFTER_DELAY + LINE_DUR - 150, 300);
      // 4. Заливка разницы — в самом конце.
      show(area, AFTER_DELAY + LINE_DUR, 500);

      later(function () {
        state.phase = 'done';
      }, AFTER_DELAY + LINE_DUR + 560);
    };

    // hold=false — проигрываем сразу (например, повторный вызов из консоли
    // или прямой вызов SevenNights.drawHeroChart).
    if (!opts.hold) {
      var play = state.play;
      state.play = null;
      play();
    }

    return svg;
  }

  /* ------------------------------------------------------------------ *
   * 6. drawDots — мотив семи точек
   * ------------------------------------------------------------------ */

  /**
   * Рисует data-dots точек, из них первые data-filled — акцентные.
   * Повторный вызов на том же элементе не пересобирает SVG, а меняет цвет
   * существующих кружков: так смена «2 из 7» → «3 из 7» проходит плавно.
   * Мотив декоративный, состояние дублируется текстом рядом, поэтому
   * aria-hidden.
   */
  function drawDots(node) {
    if (!node) return null;

    var p = palette();
    var total = parseInt(node.getAttribute('data-dots'), 10);
    if (!(total > 0)) total = 7;
    var filled = parseInt(node.getAttribute('data-filled'), 10);
    if (!(filled >= 0)) filled = 0;
    filled = clamp(filled, 0, total);

    var r = 3;
    var gap = 8;
    var w = total * r * 2 + (total - 1) * gap;
    var h = r * 2;

    var svg = node.firstElementChild;
    var reuse = svg && svg.tagName.toLowerCase() === 'svg' &&
      svg.getAttribute('data-total') === String(total);

    if (!reuse) {
      svg = el('svg', {
        viewBox: '0 0 ' + w + ' ' + h,
        width: w,
        height: h,
        'data-total': total,
        'aria-hidden': 'true',
        focusable: 'false'
      });
      svg.style.display = 'block';
      for (var i = 0; i < total; i++) {
        var c = el('circle', { cx: r + i * (r * 2 + gap), cy: r, r: r });
        c.style.transition = reducedMotion() ? '' : 'fill 220ms ease-out, fill-opacity 220ms ease-out';
        svg.appendChild(c);
      }
      node.textContent = '';
      node.appendChild(svg);
    }

    var dots = svg.childNodes;
    for (var j = 0; j < dots.length; j++) {
      var on = j < filled;
      dots[j].setAttribute('fill', on ? p.lamp : p.before);
      dots[j].setAttribute('fill-opacity', on ? '1' : '0.4');
    }
    return svg;
  }

  /* ------------------------------------------------------------------ *
   * 7. drawRing — кольцо-дуга результата теста
   * ------------------------------------------------------------------ */

  var RING_BOX = 120;
  var RING_R = 50;
  var RING_C = 2 * Math.PI * RING_R;

  /**
   * Кольцо с дугой от 0 до value/max.
   * Текст внутри кольца модуль не пишет: возвращает пустой элемент
   * .ring-center, в который цифру кладёт quiz.js.
   * Кольцо всегда одного цвета: низкий индекс не «красный», высокий не
   * «зелёный» — это состояние на сегодня, а не оценка.
   */
  function drawRing(node, value, max, animate) {
    if (!node) return null;

    var p = palette();
    var limit = max > 0 ? max : 100;
    var ratio = clamp((Number(value) || 0) / limit, 0, 1);
    var doAnimate = animate !== false && !reducedMotion();

    var wrap = node.querySelector('.ring-wrap');
    var arc, center;

    if (!wrap) {
      node.textContent = '';

      wrap = document.createElement('div');
      wrap.className = 'ring-wrap';
      wrap.style.position = 'relative';
      // Ширину задаёт quiz.css. Если он ничего не задал, ограничиваем сами,
      // чтобы кольцо не растянулось на всю колонку.
      var ownMax = '';
      try {
        ownMax = window.getComputedStyle(node).maxWidth;
      } catch (e) { /* доступ к стилям может быть закрыт — не страшно */ }
      if (!ownMax || ownMax === 'none') {
        wrap.style.maxWidth = '220px';
        wrap.style.marginLeft = 'auto';
        wrap.style.marginRight = 'auto';
      }

      var gradId = uid('sn-ring');
      var svg = el('svg', {
        viewBox: '0 0 ' + RING_BOX + ' ' + RING_BOX,
        width: '100%',
        'aria-hidden': 'true',
        focusable: 'false'
      });
      svg.style.display = 'block';
      svg.style.width = '100%';
      svg.style.height = 'auto';
      svg.style.aspectRatio = '1 / 1';

      var defs = el('defs');
      var grad = el('linearGradient', { id: gradId, x1: '0', y1: '0', x2: '1', y2: '1' });
      var s1 = el('stop', { offset: '0', 'stop-color': p.lamp, 'stop-opacity': '0.65' });
      var s2 = el('stop', { offset: '1', 'stop-color': p.lamp, 'stop-opacity': '1' });
      grad.appendChild(s1);
      grad.appendChild(s2);
      defs.appendChild(grad);
      svg.appendChild(defs);

      svg.appendChild(el('circle', {
        cx: RING_BOX / 2, cy: RING_BOX / 2, r: RING_R,
        fill: 'none', stroke: p.before, 'stroke-opacity': '0.22', 'stroke-width': 9
      }));

      arc = el('circle', {
        cx: RING_BOX / 2, cy: RING_BOX / 2, r: RING_R,
        fill: 'none', stroke: 'url(#' + gradId + ')',
        'stroke-width': 9, 'stroke-linecap': 'round',
        transform: 'rotate(-90 ' + RING_BOX / 2 + ' ' + RING_BOX / 2 + ')'
      });
      arc.setAttribute('class', 'ring-arc');
      arc.style.strokeDasharray = RING_C + ' ' + RING_C;
      arc.style.strokeDashoffset = String(RING_C);
      svg.appendChild(arc);

      center = document.createElement('div');
      center.className = 'ring-center';
      center.style.position = 'absolute';
      center.style.top = '0';
      center.style.right = '0';
      center.style.bottom = '0';
      center.style.left = '0';
      center.style.display = 'flex';
      center.style.flexDirection = 'column';
      center.style.alignItems = 'center';
      center.style.justifyContent = 'center';

      wrap.appendChild(svg);
      wrap.appendChild(center);
      node.appendChild(wrap);
    } else {
      arc = wrap.querySelector('.ring-arc');
      center = wrap.querySelector('.ring-center');
      // Цвета перечитываем — вдруг переменные изменились с прошлого раза.
      var track = wrap.querySelector('circle');
      if (track) track.setAttribute('stroke', p.before);
    }

    if (!arc) return center || null;

    var target = RING_C * (1 - ratio);
    if (doAnimate) {
      arc.style.transition = '';
      arc.style.strokeDashoffset = String(RING_C);
      reflow(arc);
      arc.style.transition = 'stroke-dashoffset 600ms cubic-bezier(0.22, 1, 0.36, 1)';
      arc.style.strokeDashoffset = String(round(target));
    } else {
      arc.style.transition = '';
      arc.style.strokeDashoffset = String(round(target));
    }

    return center;
  }

  /* ------------------------------------------------------------------ *
   * 8. Публичный API и автозапуск
   * ------------------------------------------------------------------ */

  window.SevenNights = {
    drawHeroChart: function (node) { return drawHeroChart(node, { animate: true }); },
    drawDots: drawDots,
    drawRing: drawRing
  };

  function initHero(node) {
    var reduce = reducedMotion();
    var animated = typeof IntersectionObserver === 'function' && !reduce;

    // Рисуем сразу в любом случае: место под график занято с первой отрисовки,
    // страница не дёргается, когда анимация стартует.
    drawHeroChart(node, { animate: animated, hold: true });

    if (animated) {
      var started = false;
      var start = function () {
        if (started) return;
        started = true;
        var st = heroStates.get(node);
        if (st && st.play) {
          var play = st.play;
          st.play = null;
          play();
        }
      };
      var io = new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].isIntersecting) {
            io.disconnect();
            start();
            return;
          }
        }
      }, { threshold: 0.3, rootMargin: '0px 0px -10% 0px' });
      io.observe(node);
      // Страховка для встроенных браузеров, где observer ведёт себя странно:
      // через 4 с график обязан быть виден в любом случае.
      setTimeout(function () {
        io.disconnect();
        start();
      }, 4000);
    }

    // Перерисовка по ширине: viewBox пересчитывается, чтобы подписи
    // оставались 12–14px при любой ширине, в том числе на 320px.
    var resizeTimer = null;
    var lastWidth = node.clientWidth;
    var onResize = function () {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        var w = node.clientWidth;
        if (!w || Math.abs(w - lastWidth) < 24) return;
        var st = heroStates.get(node);
        if (st && st.phase === 'animating') return; // не рвём идущую анимацию
        lastWidth = w;
        if (!st) return;
        if (st.phase === 'done') {
          drawHeroChart(node, { animate: false });
        } else {
          // Ещё не показывали: перерисовываем в спрятанном виде,
          // запуск остаётся за наблюдателем.
          drawHeroChart(node, { animate: animated, hold: true });
        }
      }, 160);
    };

    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(onResize).observe(node);
    } else {
      window.addEventListener('resize', onResize);
      window.addEventListener('orientationchange', onResize);
    }
  }

  function init() {
    var hero = document.getElementById('hero-chart');
    if (hero) initHero(hero);

    var slots = document.querySelectorAll('.dots[data-dots]');
    for (var i = 0; i < slots.length; i++) {
      drawDots(slots[i]);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
