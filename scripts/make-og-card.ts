/**
 * Пересборка карточки ссылки (og:image) для лендинга.
 *
 *   npx tsx scripts/make-og-card.ts
 *
 * Зачем скрипт, а не «нарисовали один раз»: карточка уходит в предпросмотр ссылки
 * в мессенджерах и соцсетях, то есть это публичное лицо продукта. Первая версия
 * ушла в PNG вместе с незаменённым плейсхолдером имени — именно поэтому генератор
 * должен жить в репозитории и пересобираться одной командой, а не быть картинкой
 * неизвестного происхождения.
 *
 * Имени специалиста на карточке НЕТ намеренно: оно пока не известно, а подставлять
 * туда заглушку — как раз тот случай, который мы чиним.
 *
 * ГЛАВНОЕ ПРАВИЛО (§2.4 design-landing.md): «один и тот же визуальный язык на
 * лендинге, в боте и в превью ссылки в Telegram». Поэтому карточка рисуется НЕ
 * своим кодом, а тем же самым `web/landing/chart.js` и теми же токенами палитры
 * из `web/landing/styles.css`. Отдельная реализация графика в этом файле
 * приводила к тому, что на карточке были две голые ломаные без осей, без лун и
 * без подписей, да ещё и на других данных, чем в hero.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const LANDING = join(ROOT, 'web', 'landing')
const OUT = join(LANDING, 'og-card.png')
const CHROME = process.env.CHROME_BIN || 'google-chrome'

const W = 1200
const H = 630

/** Ширина слота графика. viewBox chart.js — 860×300, SVG тянется по ширине. */
const CHART_W = 940

const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Prata&family=Golos+Text:wght@400;500;600&display=swap">
<!-- палитра и типографика — из боевого файла лендинга, чтобы не разъезжались -->
<link rel="stylesheet" href="${join(LANDING, 'styles.css')}">
<style>
  html, body { margin: 0; padding: 0; }
  body {
    width: ${W}px; height: ${H}px; overflow: hidden;
    background-image: none;
    background-color: var(--night);
    color: var(--moon);
    display: flex; flex-direction: column; justify-content: space-between;
    padding: 46px 64px 44px;
    box-sizing: border-box;
    position: relative;
  }
  /* та же «лампа», что и в hero (§2.2): единственное декоративное пятно */
  body::before {
    content: ""; position: absolute; top: -40px; right: -40px;
    width: 460px; height: 460px;
    background: radial-gradient(circle, rgba(var(--lamp-rgb), .10), rgba(var(--lamp-rgb), 0) 68%);
    filter: blur(80px); pointer-events: none;
  }
  .og-layer { position: relative; z-index: 1; }
  .hero-chart { width: ${CHART_W}px; margin: 0 auto; }
  .cap {
    margin: 10px 0 0; text-align: center;
    font-family: var(--font-body); font-size: 17px; font-weight: 500;
    letter-spacing: .04em; color: var(--mist);
  }
  .big {
    margin: 0; font-family: var(--font-display); font-weight: 400;
    font-size: 68px; line-height: 1.05; letter-spacing: -.01em;
  }
  .foot { margin: 14px 0 0; font-family: var(--font-body); font-size: 22px; color: var(--mist); }
  .foot b { color: var(--moon); font-weight: 500; }
</style></head>
<body>
  <div class="og-layer">
    <div id="hero-chart" class="hero-chart"></div>
    <p class="cap">Так выглядит график на седьмой вечер. Пример.</p>
  </div>

  <div class="og-layer">
    <p class="big">Было 4. Стало 7.</p>
    <p class="foot"><b>Семь ночей</b> · бот-компаньон в Telegram</p>
  </div>

  <script>
    /* Заставляем chart.js считать, что человек просил меньше движения:
       график рисуется сразу в конечном состоянии, и скриншот не поймает
       середину анимации. Никакой другой разницы между режимами нет. */
    (function (orig) {
      window.matchMedia = function (q) {
        if (/prefers-reduced-motion/.test(q)) {
          return { matches: true, media: q,
            addListener: function () {}, removeListener: function () {},
            addEventListener: function () {}, removeEventListener: function () {} };
        }
        return orig.call(window, q);
      };
    })(window.matchMedia);
  </script>
  <script src="${join(LANDING, 'chart.js')}"></script>
</body></html>`

const work = mkdtempSync(join(tmpdir(), 'sn-og-'))
try {
  const page = join(work, 'og.html')
  writeFileSync(page, html)
  execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    // локальные styles.css и chart.js лежат вне временной папки
    '--allow-file-access-from-files',
    // ждём загрузку шрифтов Google, иначе заголовок отрисуется запасной гарнитурой
    '--virtual-time-budget=6000',
    `--window-size=${W},${H}`,
    `--screenshot=${OUT}`,
    `file://${page}`,
  ], { stdio: 'ignore' })
  console.log(`Карточка пересобрана: ${OUT}`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
