/**
 * Картинка седьмого вечера: чистая функция данные → строка SVG. §7 архитектуры.
 *
 * Чистая — значит ни файловой системы, ни Ctx, ни текстов из базы. Всё, что нужно
 * нарисовать, приходит аргументами, и поэтому картинку можно проверить тестом
 * построчно, не запуская рендер. Личных данных в SVG нет вообще: ни имени, ни
 * tg_id, ни номера участника — картинку не страшно переслать (§2.7 design-bot).
 */

import type { ChartPoint } from './data.ts'
import { EVENINGS } from './data.ts'

export const WIDTH = 1200
export const HEIGHT = 1500

/** Поле графика, §7.1. */
export const PLOT = { left: 150, right: 1050, top: 330, bottom: 1010 } as const

export const COLORS = {
  bg: '#14110F',
  lamp: '#2A2119',
  title: '#F3EAE0',
  muted: '#8C8078',
  dim: '#6E645C',
  grid: '#2B2521',
  axis: '#3A322C',
  before: '#7C6A58',
  after: '#E9B368',
  /** Обводка пустого кружка «этот вечер был, замера нет» (§7.2). */
  empty: '#3A322C',
} as const

/**
 * Полоса «нет замера» — под подписями оси, за пределами поля значений.
 * Рисовать такой кружок внутри поля нельзя: на любой высоте он читался бы как
 * число, а на нуле — как «стало совсем плохо». Под осью он честно значит
 * «замера не было». Левый кружок — пропущенное «до», правый — пропущенное
 * «после»; пара кружков = вечера не было вовсе.
 */
const EMPTY_ROW_Y = 1105
const EMPTY_DX = 11
const EMPTY_R = 7

/** Базовая линия итоговой строки, §7.1. */
const SUMMARY_Y = 1250

export const X = (evening: number): number => PLOT.left + (evening - 1) * 150
export const Y = (value: number): number => PLOT.bottom - (value / 10) * (PLOT.bottom - PLOT.top)

export type ChartOpts = {
  firstBefore: number | null
  lastAfter: number | null
  /** Ритуальные даты первого и последнего вечера: 'YYYY-MM-DD' (или 'demo-1' — тогда без подзаголовка). */
  fromDate: string
  toDate: string
  /** '@ensoma_robot' или 'ensoma_robot' — собачка ставится сама. */
  botName: string
}

/** Только то, что ломает XML. Подставляются числа и даты, но подпись бота приходит из настроек. */
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const MONTHS_GENITIVE = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
]

/**
 * '2026-09-18' → '18 сентября'. Для демо-дат ('demo-3') и мусора — пустая строка:
 * подзаголовок тогда просто не рисуется, а не показывает «demo-3 — demo-9».
 */
export function formatRuDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return ''
  const month = Number(m[2])
  if (month < 1 || month > 12) return ''
  return `${Number(m[3])} ${MONTHS_GENITIVE[month - 1]}`
}

/** «18 сентября — 24 сентября», одна дата, если вечер был один, или '' — если дат нет. */
export function formatDateRange(fromIso: string, toIso: string): string {
  const a = formatRuDate(fromIso)
  const b = formatRuDate(toIso)
  if (a === '' && b === '') return ''
  if (a === '' || b === '' || a === b) return a || b
  return `${a} — ${b}`
}

/**
 * Ломаная по непустым точкам. null не превращается в ноль и не «перепрыгивается»:
 * линия обрывается и начинается заново с первой следующей непустой точки.
 */
export function segments(points: readonly ChartPoint[], key: 'before' | 'after'): string[] {
  const out: string[] = []
  let cur: string[] = []
  for (const p of points) {
    const v = p[key]
    if (v === null) {
      if (cur.length > 1) out.push(cur.join(' '))
      cur = []
      continue
    }
    cur.push(`${cur.length === 0 ? 'M' : 'L'}${X(p.evening)},${Y(v)}`)
  }
  if (cur.length > 1) out.push(cur.join(' '))
  return out
}

/** Итоговая строка, разрезанная стрелкой. null — замеров не было вовсе. */
export type SummaryParts = { left: string; right: string | null } | null

export function summaryParts(o: ChartOpts): SummaryParts {
  // «Стало» может не случиться ни разу — тогда стрелка вела бы в пустоту.
  if (o.firstBefore === null) return null
  if (o.lastAfter === null) return { left: `Было ${o.firstBefore}`, right: null }
  return { left: `Было ${o.firstBefore}`, right: `стало ${o.lastAfter}` }
}

/**
 * Стрелка нарисована линиями, а не символом «→».
 *
 * Это не эстетика: U+2192 нет ни в NotoSans-Regular, ни в NotoSans-Bold из
 * assets/fonts (проверено по cmap), а системные шрифты в рендере выключены —
 * вместо стрелки в картинке седьмого вечера получался бы пустой прямоугольник.
 * Первый раз это увидели бы уже в чате у человека.
 *
 * Заодно это решает центровку: измерить ширину текста в чистой функции нечем,
 * поэтому левая половина прижимается концом к центру, правая — началом от центра,
 * а стрелка стоит ровно посередине холста.
 */
function arrowSvg(cx: number, midY: number, color: string): string[] {
  const half = 30
  const head = 14
  return [
    `<path d="M${cx - half},${midY} L${cx + half},${midY}" fill="none" stroke="${color}" ` +
      'stroke-width="7" stroke-linecap="round"/>',
    `<path d="M${cx + half - head},${midY - head} L${cx + half},${midY} L${cx + half - head},${midY + head}" ` +
      `fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>`,
  ]
}

export function buildChartSvg(points: readonly ChartPoint[], o: ChartOpts): string {
  const s: string[] = []

  s.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" ` +
      `viewBox="0 0 ${WIDTH} ${HEIGHT}" font-family="Noto Sans">`,
  )

  // Тёплая «лампа» над заголовком: тёмный прямоугольник без неё выглядит выключенным экраном.
  s.push('<defs>')
  s.push('<radialGradient id="lamp" gradientUnits="userSpaceOnUse" cx="600" cy="300" r="820">')
  s.push(`<stop offset="0" stop-color="${COLORS.lamp}" stop-opacity="0.3"/>`)
  s.push(`<stop offset="1" stop-color="${COLORS.lamp}" stop-opacity="0"/>`)
  s.push('</radialGradient>')
  s.push('</defs>')

  s.push(`<rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="${COLORS.bg}"/>`)
  s.push(`<rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="url(#lamp)"/>`)

  // ── заголовок и даты ──
  s.push(
    `<text x="600" y="150" text-anchor="middle" font-size="64" font-weight="bold" ` +
      `fill="${COLORS.title}">Семь ночей</text>`,
  )
  const range = formatDateRange(o.fromDate, o.toDate)
  if (range !== '') {
    s.push(`<text x="600" y="200" text-anchor="middle" font-size="32" fill="${COLORS.muted}">${esc(range)}</text>`)
  }

  // ── легенда ──
  // Подписи ставятся по фиксированным координатам, а не «по ширине текста»:
  // измерить текст в чистой функции нечем, а слова «до» и «после» не меняются.
  const legendY = 266
  s.push(`<line x1="790" y1="${legendY - 9}" x2="830" y2="${legendY - 9}" stroke="${COLORS.before}" stroke-width="6" stroke-linecap="round"/>`)
  s.push(`<text x="842" y="${legendY}" font-size="28" fill="${COLORS.before}">до</text>`)
  s.push(`<line x1="912" y1="${legendY - 9}" x2="952" y2="${legendY - 9}" stroke="${COLORS.after}" stroke-width="8" stroke-linecap="round"/>`)
  s.push(`<text x="964" y="${legendY}" font-size="28" fill="${COLORS.after}">после</text>`)

  // ── сетка и шкала ──
  for (const v of [0, 2, 4, 6, 8, 10]) {
    const y = Y(v)
    const isAxis = v === 0
    s.push(
      `<line x1="${PLOT.left}" y1="${y}" x2="${PLOT.right}" y2="${y}" ` +
        `stroke="${isAxis ? COLORS.axis : COLORS.grid}" stroke-width="1"/>`,
    )
    // +9 — грубая полуприводка 26-го кегля к середине строки: dominant-baseline
    // поддерживается рендерами неодинаково, а сдвиг числом одинаков везде.
    s.push(`<text x="120" y="${y + 9}" text-anchor="end" font-size="26" fill="${COLORS.dim}">${v}</text>`)
  }

  // ── ось вечеров ──
  for (let e = 1; e <= EVENINGS; e++) {
    s.push(`<text x="${X(e)}" y="1060" text-anchor="middle" font-size="30" fill="${COLORS.muted}">${e}</text>`)
  }

  // ── линии ──
  for (const d of segments(points, 'before')) {
    s.push(`<path d="${d}" fill="none" stroke="${COLORS.before}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>`)
  }
  for (const d of segments(points, 'after')) {
    // Свечение — та же ломаная толще и почти прозрачная: на тёмном фоне яркая
    // линия без него выглядит наклейкой, а не светом.
    s.push(`<path d="${d}" fill="none" stroke="${COLORS.after}" stroke-width="18" stroke-linecap="round" stroke-linejoin="round" opacity="0.12"/>`)
    s.push(`<path d="${d}" fill="none" stroke="${COLORS.after}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>`)
  }

  // ── точки ──
  for (const p of points) {
    const x = X(p.evening)
    if (p.before === null) {
      s.push(`<circle cx="${x - EMPTY_DX}" cy="${EMPTY_ROW_Y}" r="${EMPTY_R}" fill="none" stroke="${COLORS.empty}" stroke-width="2"/>`)
    } else {
      s.push(`<circle cx="${x}" cy="${Y(p.before)}" r="9" fill="${COLORS.bg}" stroke="${COLORS.before}" stroke-width="3"/>`)
    }
    if (p.after === null) {
      s.push(`<circle cx="${x + EMPTY_DX}" cy="${EMPTY_ROW_Y}" r="${EMPTY_R}" fill="none" stroke="${COLORS.empty}" stroke-width="2"/>`)
    } else {
      s.push(`<circle cx="${x}" cy="${Y(p.after)}" r="11" fill="${COLORS.after}"/>`)
    }
  }

  // ── итог и подпись ──
  const summary = summaryParts(o)
  if (summary !== null && summary.right === null) {
    s.push(
      `<text x="600" y="${SUMMARY_Y}" text-anchor="middle" font-size="92" font-weight="bold" ` +
        `fill="${COLORS.title}">${esc(summary.left)}</text>`,
    )
  } else if (summary !== null && summary.right !== null) {
    const right = summary.right
    const gap = 66
    s.push(
      `<text x="${600 - gap}" y="${SUMMARY_Y}" text-anchor="end" font-size="92" font-weight="bold" ` +
        `fill="${COLORS.title}">${esc(summary.left)}</text>`,
    )
    // −30 от базовой линии: оптическая середина прописных, стрелка не съезжает вниз.
    s.push(...arrowSvg(600, SUMMARY_Y - 30, COLORS.after))
    s.push(
      `<text x="${600 + gap}" y="${SUMMARY_Y}" text-anchor="start" font-size="92" font-weight="bold" ` +
        `fill="${COLORS.title}">${esc(right)}</text>`,
    )
  }
  const bot = o.botName.startsWith('@') ? o.botName : `@${o.botName}`
  s.push(`<text x="600" y="1420" text-anchor="middle" font-size="28" fill="${COLORS.dim}">${esc(bot)}</text>`)

  s.push('</svg>')
  return s.join('\n')
}
