/* ==========================================================================
   Тест «Индекс внутренней опоры» — интерактивный блок лендинга «Семь ночей».
   Рисует всё содержимое секции #quiz: приглашение → семь вопросов → результат.

   Зависимостей нет, сетевых запросов нет, аналитики нет.
   Единственный внешний контракт — необязательный window.SevenNights
   (drawDots, drawRing) из chart.js: если его нет, рисуем сами.

   ВНИМАНИЕ: тексты вопросов, подписей и результатов дословны по
   docs/quiz-spec.md. Менять, сокращать и перефразировать их нельзя.
   ========================================================================== */

(function () {
  'use strict';

  /* ----------------------------------------------------------------------
     Данные теста. Дословно из docs/quiz-spec.md.
     ---------------------------------------------------------------------- */

  var QUESTIONS = [
    {
      text: 'Когда что-то идёт не по плану, насколько быстро ты можешь вернуться в нормальное состояние?',
      min: 'меня надолго выбивает',
      max: 'довольно быстро возвращаюсь к себе'
    },
    {
      text: 'Насколько ты можешь принимать решения, даже если близкие с тобой не согласны?',
      min: 'чужое мнение сильно определяет мой выбор',
      max: 'могу услышать других, но решение остаётся моим'
    },
    {
      text: 'Насколько легко ты можешь сказать «нет», когда внутри действительно не хочешь?',
      min: 'почти всегда соглашаюсь через себя',
      max: 'могу спокойно отказать без долгого чувства вины'
    },
    {
      text: 'Когда тебе тревожно, обидно или тяжело, насколько ты умеешь помочь себе вернуться в более спокойное состояние?',
      min: 'мне обязательно нужен кто-то или что-то извне',
      max: 'у меня есть способы помочь себе'
    },
    {
      text: 'Насколько хорошо ты умеешь оставлять чужие проблемы, работу и конфликты там, где они произошли?',
      min: 'долго ношу всё это с собой',
      max: 'умею переключаться и возвращаться в свою жизнь'
    },
    {
      text: 'Когда ты не можешь контролировать происходящее, насколько тебе удаётся сохранять ощущение, что ты справишься?',
      min: 'неопределённость выбивает почву из-под ног',
      max: 'даже без всех ответов чувствую: разберусь по ходу'
    },
    {
      text: 'Если из твоей жизни временно убрать одобрение, помощь и поддержку других людей, насколько внутри остаётся ощущение: «Я у себя есть»?',
      min: 'почти не чувствую этого',
      max: 'очень хорошо чувствую'
    }
  ];

  /* Границы — по СУММЕ ответов, а не по округлённому индексу:
     так на границе не бывает расхождения из-за округления. */
  var RESULTS = [
    {
      maxSum: 21,
      text: 'Сейчас значительная часть твоего чувства устойчивости зависит от того, что происходит вокруг. Это точка, с которой можно начинать.'
    },
    {
      maxSum: 35,
      text: 'Опора уже есть, но в сложных ситуациях её легко потерять, особенно в отношениях, конфликтах или неопределённости.'
    },
    {
      maxSum: 49,
      text: 'Во многих ситуациях ты умеешь возвращаться к себе, но есть обстоятельства, которые всё ещё сильно выбивают.'
    },
    {
      maxSum: 59,
      text: 'Внутренняя опора достаточно устойчива. Ты чаще можешь оставаться собой, даже когда внешнее меняется.'
    },
    {
      maxSum: 70,
      text: 'Сейчас ты ощущаешь высокую внутреннюю устойчивость. Но это не «уровень навсегда»: состояние меняется, поэтому внутреннюю опору продолжают поддерживать.'
    }
  ];

  var DISCLAIMER = 'Это не диагноз и не оценка твоей личности. Это фотография твоего состояния сегодня.';
  var HINT = 'Отвечай не «как правильно», а как было у тебя последние две-четыре недели.';
  var TITLE = 'Где сейчас твоя опора';
  var NOTE = 'Семь вопросов. Две минуты. Результат покажем здесь же.';

  /* ----------------------------------------------------------------------
     Константы
     ---------------------------------------------------------------------- */

  var BOT_URL = 'https://t.me/ensoma_robot';
  var STORAGE_KEY = 'seven-nights-quiz';
  var STORAGE_MAX_AGE = 30 * 24 * 60 * 60 * 1000; /* 30 дней */
  var AUTO_ADVANCE_MS = 450;
  var SLIDE_MS = 300;
  var COUNT_MS = 600;
  var TOTAL = QUESTIONS.length;
  var MAX_SUM = TOTAL * 10;

  /* ----------------------------------------------------------------------
     Мелкие утилиты
     ---------------------------------------------------------------------- */

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) { node.className = className; }
    if (text !== undefined && text !== null) { node.textContent = text; }
    return node;
  }

  function prefersReducedMotion() {
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (e) {
      return false;
    }
  }

  /* Лёгкая тактильная отдача на каждое целое деление. Есть не везде.
     Без состоявшегося касания браузер вызов всё равно блокирует и пишет
     ругань в консоль, поэтому сначала спрашиваем про активацию. */
  function vibrate() {
    try {
      if (!navigator || typeof navigator.vibrate !== 'function') { return; }
      var act = navigator.userActivation;
      if (act && act.hasBeenActive === false) { return; }
      navigator.vibrate(8);
    } catch (e) { /* молча: вибрация — украшение, а не функция */ }
  }

  function readStored() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) { return null; }
      var data = JSON.parse(raw);
      if (!data || !Array.isArray(data.answers) || data.answers.length !== TOTAL) { return null; }
      if (typeof data.sum !== 'number' || data.sum < 0 || data.sum > MAX_SUM) { return null; }
      if (typeof data.ts !== 'number' || (Date.now() - data.ts) > STORAGE_MAX_AGE) { return null; }
      for (var i = 0; i < TOTAL; i++) {
        var v = data.answers[i];
        if (typeof v !== 'number' || v < 0 || v > 10) { return null; }
      }
      return data;
    } catch (e) {
      return null; /* приватный режим или встроенный браузер без хранилища */
    }
  }

  function writeStored(answers, sum) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        answers: answers,
        sum: sum,
        ts: Date.now()
      }));
    } catch (e) { /* без сохранения тест всё равно работает */ }
  }

  function clearStored() {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch (e) { /* ничего */ }
  }

  function resultTextFor(sum) {
    for (var i = 0; i < RESULTS.length; i++) {
      if (sum <= RESULTS[i].maxSum) { return RESULTS[i].text; }
    }
    return RESULTS[RESULTS.length - 1].text;
  }

  function indexFor(sum) {
    return Math.round(sum / MAX_SUM * 100);
  }

  /* Подсчёт вынесен наружу только для проверки: границы результата и индекс
     должны быть воспроизводимы без клика по семи ползункам.
     Страница этим объектом не пользуется — внутри всё зовётся напрямую. */
  window.SevenNightsQuiz = {
    maxSum: MAX_SUM,
    total: TOTAL,
    indexFor: indexFor,
    resultTextFor: resultTextFor,
    sumOf: function (answers) {
      var sum = 0;
      for (var i = 0; i < answers.length; i++) { sum += Number(answers[i]) || 0; }
      return sum;
    }
  };

  /* Семь точек: сначала пробуем API из chart.js, иначе рисуем сами. */
  function paintDots(node, filled) {
    node.setAttribute('data-dots', String(TOTAL));
    node.setAttribute('data-filled', String(filled));
    var api = window.SevenNights;
    if (api && typeof api.drawDots === 'function') {
      try {
        api.drawDots(node);
        return;
      } catch (e) { /* падаем на свою отрисовку */ }
    }
    node.textContent = '';
    for (var i = 0; i < TOTAL; i++) {
      node.appendChild(el('span', i < filled ? 'quiz-dot is-filled' : 'quiz-dot'));
    }
  }

  /* Кольцо-дуга результата: тоже через chart.js, со своим запасным вариантом. */
  function paintRing(node, value, max, animate) {
    var api = window.SevenNights;
    if (api && typeof api.drawRing === 'function') {
      try {
        api.drawRing(node, value, max, animate);
        return;
      } catch (e) { /* падаем на свою отрисовку */ }
    }
    drawRingFallback(node, value, max, animate);
  }

  /* Запасная дуга: один цвет при любом результате — это состояние, а не оценка. */
  function drawRingFallback(node, value, max, animate) {
    var NS = 'http://www.w3.org/2000/svg';
    var r = 54;
    var circumference = 2 * Math.PI * r;
    var portion = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;

    node.textContent = '';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 120 120');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');

    var base = document.createElementNS(NS, 'circle');
    base.setAttribute('cx', '60');
    base.setAttribute('cy', '60');
    base.setAttribute('r', String(r));
    base.setAttribute('fill', 'none');
    base.setAttribute('stroke', 'var(--night)');
    base.setAttribute('stroke-width', '8');

    var arc = document.createElementNS(NS, 'circle');
    arc.setAttribute('cx', '60');
    arc.setAttribute('cy', '60');
    arc.setAttribute('r', String(r));
    arc.setAttribute('fill', 'none');
    arc.setAttribute('stroke', 'var(--lamp)');
    arc.setAttribute('stroke-width', '8');
    arc.setAttribute('stroke-linecap', 'round');
    arc.setAttribute('transform', 'rotate(-90 60 60)');
    arc.setAttribute('stroke-dasharray', String(circumference));

    var target = circumference * (1 - portion);
    if (animate) {
      arc.setAttribute('stroke-dashoffset', String(circumference));
      arc.style.transition = 'stroke-dashoffset ' + COUNT_MS + 'ms cubic-bezier(0.22, 1, 0.36, 1)';
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          arc.setAttribute('stroke-dashoffset', String(target));
        });
      });
    } else {
      arc.setAttribute('stroke-dashoffset', String(target));
    }

    svg.appendChild(base);
    svg.appendChild(arc);
    node.appendChild(svg);
  }

  /* Счёт цифры вверх от нуля. */
  function countUp(node, to, animate) {
    if (!animate) {
      node.textContent = String(to);
      return;
    }
    var start = 0;
    var t0 = 0;
    node.textContent = '0';
    function step(now) {
      if (!t0) { t0 = now; }
      var p = Math.min(1, (now - t0) / COUNT_MS);
      var eased = 1 - Math.pow(1 - p, 3); /* ease-out */
      node.textContent = String(Math.round(start + (to - start) * eased));
      if (p < 1) { requestAnimationFrame(step); }
    }
    requestAnimationFrame(step);
  }

  /* ----------------------------------------------------------------------
     Глобальные кнопки страницы: deep link и липкая кнопка
     ---------------------------------------------------------------------- */

  function applyDeepLink(sum) {
    var href = BOT_URL + '?start=q' + sum;
    var links = document.querySelectorAll('.js-bot-link');
    for (var i = 0; i < links.length; i++) {
      links[i].setAttribute('href', href);
    }
    var sticky = document.querySelector('.js-sticky-cta');
    if (sticky) {
      sticky.setAttribute('href', href);
      sticky.textContent = 'Открыть в Telegram';
    }
    /* Финальный призыв: до теста ведёт к тесту, после — сразу в бота (§A дизайна). */
    var final = document.querySelector('.js-final-cta');
    if (final) {
      final.setAttribute('href', href);
      final.textContent = 'Открыть семь вечеров в Telegram';
    }
  }

  function resetDeepLink() {
    var links = document.querySelectorAll('.js-bot-link');
    for (var i = 0; i < links.length; i++) {
      links[i].setAttribute('href', BOT_URL);
    }
    var sticky = document.querySelector('.js-sticky-cta');
    if (sticky) {
      sticky.setAttribute('href', '#quiz');
      sticky.textContent = 'Пройти тест';
    }
    var final = document.querySelector('.js-final-cta');
    if (final) {
      final.setAttribute('href', '#quiz');
      final.textContent = 'Пройти тест · 2 минуты';
    }
  }

  /* Пока секция теста на экране, липкая кнопка спрятана: она перекрывает ползунок. */
  function watchSticky(section) {
    var sticky = document.querySelector('.js-sticky-cta');
    if (!sticky || typeof window.IntersectionObserver !== 'function') { return; }
    /* Порог по площади не годится: секция теста выше экрана, и «видно 12 процентов»
       может не случиться никогда. Поэтому сужаем область наблюдения полями. */
    var observer = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isIntersecting) {
          sticky.classList.add('is-hidden');
        } else {
          sticky.classList.remove('is-hidden');
        }
      }
    }, { threshold: 0, rootMargin: '-96px 0px -96px 0px' });
    observer.observe(section);
  }

  /* ----------------------------------------------------------------------
     Сборка разметки блока
     ---------------------------------------------------------------------- */

  function build(section) {
    var inner = el('div', 'quiz-inner');

    var title = el('h2', 'quiz-title', TITLE);
    title.id = 'quiz-title';
    inner.appendChild(title);
    inner.appendChild(el('p', 'quiz-lead', HINT));
    inner.appendChild(el('p', 'quiz-note', NOTE));

    var card = el('div', 'quiz-card');
    card.setAttribute('data-state', 'intro');

    /* --- состояние 1: приглашение --- */
    var intro = el('div', 'quiz-stage quiz-intro');
    var startBtn = el('button', 'btn btn--primary quiz-btn quiz-start', 'Начать');
    startBtn.type = 'button';
    var introDots = el('div', 'dots');
    intro.appendChild(startBtn);
    intro.appendChild(introDots);

    /* --- состояние 2: вопрос --- */
    var question = el('div', 'quiz-stage quiz-question');
    question.hidden = true;

    var progress = el('div', 'quiz-progress');
    var counter = el('span', 'quiz-counter', '1 / ' + TOTAL);
    counter.setAttribute('aria-live', 'polite');
    var progressDots = el('div', 'dots');
    progressDots.setAttribute('aria-hidden', 'true');
    progress.appendChild(counter);
    progress.appendChild(progressDots);

    var slide = el('div', 'quiz-slide');
    var questionText = el('p', 'quiz-question-text', QUESTIONS[0].text);
    questionText.id = 'quiz-question-text';

    var valueBox = el('div', 'quiz-value is-empty', '—');
    valueBox.setAttribute('aria-hidden', 'true');

    var sliderBox = el('div', 'quiz-slider is-untouched');
    var ticks = el('div', 'quiz-ticks');
    ticks.setAttribute('aria-hidden', 'true');
    for (var t = 0; t <= 10; t++) {
      ticks.appendChild(el('span', 'quiz-tick'));
    }
    var range = document.createElement('input');
    range.type = 'range';
    range.min = '0';
    range.max = '10';
    range.step = '1';
    range.value = '5';
    range.className = 'quiz-range';
    range.setAttribute('aria-label', QUESTIONS[0].text);
    range.setAttribute('aria-valuetext', 'ответ пока не выбран');
    sliderBox.appendChild(ticks);
    sliderBox.appendChild(range);

    var legend = el('div', 'quiz-legend');
    var legendMin = el('span', 'quiz-legend-min', QUESTIONS[0].min);
    var legendMax = el('span', 'quiz-legend-max', QUESTIONS[0].max);
    legend.appendChild(legendMin);
    legend.appendChild(legendMax);

    slide.appendChild(questionText);
    slide.appendChild(valueBox);
    slide.appendChild(sliderBox);
    slide.appendChild(legend);

    var nav = el('div', 'quiz-nav');
    var backBtn = el('button', 'quiz-btn quiz-btn-ghost quiz-back is-invisible', 'назад');
    backBtn.type = 'button';
    var nextBtn = el('button', 'btn btn--primary quiz-btn quiz-next', 'Дальше');
    nextBtn.type = 'button';
    nextBtn.disabled = true;
    nav.appendChild(backBtn);
    nav.appendChild(nextBtn);

    question.appendChild(progress);
    question.appendChild(slide);
    question.appendChild(nav);

    /* --- состояние 3: результат --- */
    var result = el('div', 'quiz-stage quiz-result');
    result.hidden = true;

    var ring = el('div', 'quiz-ring');
    var ringArc = el('div', 'quiz-ring-arc');
    var ringFace = el('div', 'quiz-ring-face');
    var ringNumber = el('div', 'quiz-ring-number', '0');
    var ringCaption = el('div', 'quiz-ring-caption', 'индекс из 100');
    ringFace.appendChild(ringNumber);
    ringFace.appendChild(ringCaption);
    ring.appendChild(ringArc);
    ring.appendChild(ringFace);

    var sumLine = el('p', 'quiz-sum', '');
    var verdict = el('p', 'quiz-verdict', '');
    verdict.setAttribute('aria-live', 'polite');
    var disclaimer = el('p', 'quiz-disclaimer', DISCLAIMER);

    var botLink = el('a', 'btn btn--primary quiz-btn js-bot-link', 'Открыть семь вечеров в Telegram');
    botLink.setAttribute('href', BOT_URL);
    botLink.setAttribute('rel', 'noopener');

    var after = el('p', 'quiz-after', 'Начнём сегодня вечером. Бот спросит только, во сколько тебе удобно.');
    var restart = el('button', 'quiz-link quiz-restart', 'пройти заново');
    restart.type = 'button';

    result.appendChild(ring);
    result.appendChild(sumLine);
    result.appendChild(verdict);
    result.appendChild(disclaimer);
    result.appendChild(botLink);
    result.appendChild(after);
    result.appendChild(restart);

    card.appendChild(intro);
    card.appendChild(question);
    card.appendChild(result);
    inner.appendChild(card);
    section.appendChild(inner);

    return {
      card: card,
      intro: intro,
      introDots: introDots,
      startBtn: startBtn,
      question: question,
      counter: counter,
      progressDots: progressDots,
      slide: slide,
      questionText: questionText,
      valueBox: valueBox,
      sliderBox: sliderBox,
      range: range,
      legendMin: legendMin,
      legendMax: legendMax,
      backBtn: backBtn,
      nextBtn: nextBtn,
      result: result,
      ringArc: ringArc,
      ringNumber: ringNumber,
      sumLine: sumLine,
      verdict: verdict
    };
  }

  /* ----------------------------------------------------------------------
     Логика
     ---------------------------------------------------------------------- */

  function init() {
    var section = document.getElementById('quiz');
    if (!section) { return; }

    var ui = build(section);
    var reduced = prefersReducedMotion();

    var answers = new Array(TOTAL);
    for (var i = 0; i < TOTAL; i++) { answers[i] = null; }
    var current = 0;
    var autoTimer = null;
    var slideTimer = null;
    var busy = false;

    paintDots(ui.introDots, 0);
    paintDots(ui.progressDots, 0);

    /* --- отрисовка текущего вопроса --- */

    function setFill(value, touched) {
      /* Центр бегунка ходит от 22px до (ширина − 22px): зона касания 44px. */
      var ratio = touched ? value / 10 : 0;
      ui.range.style.setProperty('--fill', touched
        ? 'calc(22px + (100% - 44px) * ' + ratio + ')'
        : '0px');
    }

    function paintQuestion() {
      var q = QUESTIONS[current];
      var answer = answers[current];
      var touched = answer !== null;

      ui.questionText.textContent = q.text;
      ui.legendMin.textContent = q.min;
      ui.legendMax.textContent = q.max;
      ui.counter.textContent = (current + 1) + ' / ' + TOTAL;
      paintDots(ui.progressDots, current);

      ui.range.setAttribute('aria-label', q.text);
      ui.range.value = String(touched ? answer : 5);
      ui.range.setAttribute('aria-valuetext', touched ? (answer + ' из 10') : 'ответ пока не выбран');

      ui.valueBox.textContent = touched ? String(answer) : '—';
      ui.valueBox.className = touched ? 'quiz-value' : 'quiz-value is-empty';
      ui.sliderBox.className = touched ? 'quiz-slider' : 'quiz-slider is-untouched';
      setFill(touched ? answer : 5, touched);

      ui.backBtn.className = 'quiz-btn quiz-btn-ghost quiz-back' + (current === 0 ? ' is-invisible' : '');
      ui.nextBtn.textContent = (current === TOTAL - 1) ? 'Показать результат' : 'Дальше';
      ui.nextBtn.disabled = !touched;
    }

    function cancelAuto() {
      if (autoTimer) {
        clearTimeout(autoTimer);
        autoTimer = null;
      }
    }

    function scheduleAuto() {
      cancelAuto();
      /* На последнем вопросе автоперехода нет: этот шаг человек делает сам. */
      if (current === TOTAL - 1) { return; }
      if (answers[current] === null) { return; }
      autoTimer = setTimeout(function () {
        autoTimer = null;
        goNext();
      }, AUTO_ADVANCE_MS);
    }

    /* Показать выбранное значение. Сюда НЕ пишем ui.range.value:
       во время перетаскивания этим распоряжается сам браузер. */
    function reflect(value) {
      ui.valueBox.textContent = String(value);
      ui.valueBox.className = 'quiz-value';
      ui.sliderBox.className = 'quiz-slider';
      ui.range.setAttribute('aria-valuetext', value + ' из 10');
      ui.nextBtn.disabled = false;
      setFill(value, true);
    }

    /* Первое касание включает ответ: до него значения нет. */
    function markTouched() {
      cancelAuto();
      if (answers[current] === null) {
        answers[current] = parseInt(ui.range.value, 10);
        reflect(answers[current]);
      }
    }

    function onRangeInput() {
      cancelAuto();
      var value = parseInt(ui.range.value, 10);
      if (answers[current] !== value) {
        answers[current] = value;
        vibrate(); /* отдача на каждое целое деление */
      }
      reflect(value);
    }

    /* --- смена карточек --- */

    function swap(nextIndex, back) {
      if (busy) { return; }
      cancelAuto();
      if (reduced) {
        current = nextIndex;
        paintQuestion();
        focusRange();
        return;
      }
      busy = true;
      ui.slide.className = 'quiz-slide is-out' + (back ? ' is-back' : '');
      slideTimer = setTimeout(function () {
        current = nextIndex;
        paintQuestion();
        ui.slide.className = 'quiz-slide is-in' + (back ? ' is-back' : '');
        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            ui.slide.className = 'quiz-slide';
            busy = false;
            focusRange();
          });
        });
      }, SLIDE_MS);
    }

    function focusRange() {
      try {
        ui.range.focus({ preventScroll: true });
      } catch (e) {
        /* старые движки без preventScroll — фокус не критичен */
      }
    }

    function goNext() {
      if (answers[current] === null) { return; }
      if (current === TOTAL - 1) {
        finish();
        return;
      }
      swap(current + 1, false);
    }

    function goBack() {
      if (current === 0) { return; }
      swap(current - 1, true);
    }

    /* --- состояния блока --- */

    function showStage(name) {
      ui.intro.hidden = (name !== 'intro');
      ui.question.hidden = (name !== 'question');
      ui.result.hidden = (name !== 'result');
      ui.card.setAttribute('data-state', name);
    }

    function start() {
      current = 0;
      showStage('question');
      paintQuestion();
      focusRange();
    }

    function finish() {
      var sum = 0;
      for (var i = 0; i < TOTAL; i++) {
        if (answers[i] === null) { return; } /* страховка: без всех семи ответов результата нет */
        sum += answers[i];
      }
      writeStored(answers.slice(), sum);
      showResult(sum, !reduced);
    }

    function showResult(sum, animate) {
      var index = indexFor(sum);
      showStage('result');
      paintDots(ui.progressDots, TOTAL);
      ui.sumLine.textContent = 'сумма ответов: ' + sum + ' из ' + MAX_SUM;
      ui.verdict.textContent = resultTextFor(sum);
      paintRing(ui.ringArc, index, 100, animate);
      countUp(ui.ringNumber, index, animate);
      if (animate) {
        /* Текст результата проявляется через 200 мс после того, как цифра досчитала. */
        ui.verdict.classList.add('is-hidden');
        setTimeout(function () {
          ui.verdict.classList.remove('is-hidden');
        }, COUNT_MS + 200);
      } else {
        ui.verdict.classList.remove('is-hidden');
      }
      applyDeepLink(sum);
    }

    function restart() {
      cancelAuto();
      if (slideTimer) { clearTimeout(slideTimer); slideTimer = null; }
      busy = false;
      clearStored();
      resetDeepLink();
      for (var i = 0; i < TOTAL; i++) { answers[i] = null; }
      current = 0;
      ui.slide.className = 'quiz-slide';
      paintDots(ui.progressDots, 0);
      paintQuestion();
      showStage('question');
      focusRange();
    }

    /* --- события --- */

    ui.startBtn.addEventListener('click', start);
    ui.nextBtn.addEventListener('click', function () {
      cancelAuto();
      goNext();
    });
    ui.backBtn.addEventListener('click', function () {
      cancelAuto();
      goBack();
    });
    ui.result.querySelector('.quiz-restart').addEventListener('click', restart);

    ui.range.addEventListener('pointerdown', markTouched);
    ui.range.addEventListener('touchstart', markTouched, { passive: true });
    ui.range.addEventListener('input', onRangeInput);

    ui.range.addEventListener('keydown', function (event) {
      var keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'];
      if (keys.indexOf(event.key) !== -1) { markTouched(); }
    });

    /* Автопереход — через 450 мс после того, как ползунок отпустили. */
    ui.range.addEventListener('pointerup', scheduleAuto);
    ui.range.addEventListener('touchend', scheduleAuto);
    ui.range.addEventListener('keyup', scheduleAuto);
    ui.range.addEventListener('change', scheduleAuto);
    ui.range.addEventListener('blur', cancelAuto);

    /* --- старт --- */

    var stored = readStored();
    if (stored) {
      for (var j = 0; j < TOTAL; j++) { answers[j] = stored.answers[j]; }
      current = TOTAL - 1;
      showResult(stored.sum, false); /* результат моложе 30 дней — сразу, без анимации */
    } else {
      showStage('intro');
    }

    watchSticky(section);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
