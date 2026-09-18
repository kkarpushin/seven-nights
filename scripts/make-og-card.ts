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
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const LANDING = join(ROOT, 'web', 'landing')
const OUT = join(LANDING, 'og-card.png')
const CHROME = process.env.CHROME_BIN || 'google-chrome'

/** Те же данные примера, что и в hero-графике лендинга: скромные, честные. */
const BEFORE = [4, 4, 5, 5, 6, 6, 6]
const AFTER = [5, 6, 6, 7, 7, 7, 8]

/** Линия графика со сглаживанием: те же координаты, что рисует chart.js на странице. */
function path(values: number[], w: number, h: number, pad: number): string {
  const x = (i: number) => pad + (i * (w - pad * 2)) / (values.length - 1)
  const y = (v: number) => h - pad - (v / 10) * (h - pad * 2)
  return values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
}

function dots(values: number[], w: number, h: number, pad: number, color: string): string {
  const x = (i: number) => pad + (i * (w - pad * 2)) / (values.length - 1)
  const y = (v: number) => h - pad - (v / 10) * (h - pad * 2)
  return values
    .map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="4" fill="${color}"/>`)
    .join('')
}

const W = 1200
const H = 630
const CW = 1040
const CH = 250
const PAD = 16

const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Prata&family=Golos+Text:wght@400;500&display=swap">
<style>
  :root {
    --night: #0F1233; --dusk: #1A1E4A; --dawn-deep: #2A2456;
    --moon: #F3EEE3; --mist: #A9ACC8; --lamp: #F2B56B; --before: #8A93D6;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: ${W}px; height: ${H}px; overflow: hidden;
    background: radial-gradient(120% 90% at 78% 8%, var(--dawn-deep) 0%, var(--night) 62%);
    color: var(--moon); font-family: "Golos Text", sans-serif;
    display: flex; flex-direction: column; justify-content: space-between;
    padding: 56px 64px 52px;
  }
  .eyebrow { font-size: 22px; color: var(--mist); letter-spacing: .01em; }
  .chart { margin: 4px 0 0; }
  .big { font-family: "Prata", serif; font-size: 78px; line-height: 1.05; letter-spacing: -.01em; }
  .foot { font-size: 22px; color: var(--mist); }
  .foot b { color: var(--moon); font-weight: 500; }
</style></head>
<body>
  <div class="eyebrow">Семь вечеров подряд · одна аудиопрактика в вечер</div>

  <svg class="chart" width="${CW}" height="${CH}" viewBox="0 0 ${CW} ${CH}" fill="none">
    <path d="${path(BEFORE, CW, CH, PAD)}" stroke="var(--before)" stroke-width="3"
          stroke-linecap="round" stroke-linejoin="round" opacity=".85"/>
    <path d="${path(AFTER, CW, CH, PAD)}" stroke="var(--lamp)" stroke-width="4"
          stroke-linecap="round" stroke-linejoin="round"/>
    ${dots(BEFORE, CW, CH, PAD, 'var(--before)')}
    ${dots(AFTER, CW, CH, PAD, 'var(--lamp)')}
  </svg>

  <div>
    <div class="big">Было 4. Стало 7.</div>
    <div class="foot" style="margin-top:18px"><b>Семь ночей</b> · бот-компаньон в Telegram</div>
  </div>
</body></html>`

const work = mkdtempSync(join(tmpdir(), 'sn-og-'))
try {
  const page = join(work, 'og.html')
  writeFileSync(page, html)
  execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
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
