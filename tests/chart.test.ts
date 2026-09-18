/**
 * График седьмого вечера: данные, SVG и настоящий рендер в PNG.
 *
 * SVG проверяется как строка — это чистая функция, и именно так §7.3 её и
 * задумывал. Плюс один тест действительно гоняет resvg: без него молча
 * ломается всё, что не видно в разметке — отсутствующий шрифт, чужой cwd,
 * глиф, которого в шрифте нет.
 */

import { describe, expect, it } from 'vitest'
import { chartData, chartSummary, pointsFromSessions, type ChartPoint } from '../src/chart/data.ts'
import {
  buildChartSvg, formatDateRange, formatRuDate, segments, summaryParts, X, Y,
} from '../src/chart/svg.ts'
import { fontsReady, renderPng } from '../src/chart/render.ts'
import { makeSession, makeUser, T0, testCtx, testDb } from './helpers/db.ts'

const pt = (evening: number, before: number | null, after: number | null, date = ''): ChartPoint => ({
  evening, before, after, date,
})

const week = (): ChartPoint[] => [
  pt(1, 4, 6, '2026-09-18'), pt(2, 3, 6, '2026-09-19'), pt(3, 5, 7, '2026-09-20'),
  pt(4, 4, 8, '2026-09-21'), pt(5, 6, 8, '2026-09-22'), pt(6, 5, 9, '2026-09-23'),
  pt(7, 6, 9, '2026-09-24'),
]

const opts = (o: Partial<Parameters<typeof buildChartSvg>[1]> = {}) => ({
  firstBefore: 4, lastAfter: 9, fromDate: '2026-09-18', toDate: '2026-09-24',
  botName: 'ensoma_robot', ...o,
})

describe('геометрия', () => {
  it('ось X — семь точек с шагом 150', () => {
    expect(X(1)).toBe(150)
    expect(X(7)).toBe(1050)
  })

  it('ноль внизу, десятка наверху', () => {
    expect(Y(0)).toBe(1010)
    expect(Y(10)).toBe(330)
    expect(Y(5)).toBe(670)
  })
})

describe('pointsFromSessions', () => {
  it('всегда семь точек, даже если вечеров меньше', () => {
    const points = pointsFromSessions([])
    expect(points).toHaveLength(7)
    expect(points.map((p) => p.evening)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(points.every((p) => p.before === null && p.after === null && p.date === '')).toBe(true)
  })

  it('незасчитанный вечер на график не попадает', () => {
    const db = testDb()
    const u = makeUser(db)
    // Отказ «Не сегодня» занимает тот же evening_no, что и настоящая попытка.
    makeSession(db, { userId: u.id, eveningNo: 1, before: 8, after: null, status: 'declined',
      practiceSentAt: null, ritualDate: '2026-09-18' })
    makeSession(db, { userId: u.id, eveningNo: 1, before: 4, after: 7, ritualDate: '2026-09-19' })

    const ctx = testCtx({ db })
    const points = chartData(ctx, u.id, 1)
    expect(points[0].before).toBe(4)
    expect(points[0].after).toBe(7)
    expect(points[0].date).toBe('2026-09-19')
  })

  it('чужой круг не смешивается с текущим', () => {
    const db = testDb()
    const u = makeUser(db)
    makeSession(db, { userId: u.id, runNo: 1, eveningNo: 1, before: 2, after: 3, ritualDate: '2026-09-01' })
    makeSession(db, { userId: u.id, runNo: 2, eveningNo: 1, before: 9, after: 10, ritualDate: '2026-09-18' })

    const ctx = testCtx({ db })
    expect(chartData(ctx, u.id, 2)[0].before).toBe(9)
    expect(chartData(ctx, u.id, 1)[0].before).toBe(2)
  })

  it('сессии «Практика сейчас» на график не идут', () => {
    const db = testDb()
    const u = makeUser(db)
    makeSession(db, { userId: u.id, kind: 'now', before: 1, after: 10, ritualDate: '2026-09-18' })
    const ctx = testCtx({ db })
    expect(chartData(ctx, u.id, 1).every((p) => p.date === '')).toBe(true)
  })
})

describe('chartSummary', () => {
  it('берёт вечер 1 и вечер 7', () => {
    const s = chartSummary(week())
    expect(s).toMatchObject({ firstBefore: 4, lastAfter: 9, fromDate: '2026-09-18', toDate: '2026-09-24', counted: 7 })
  })

  it('пустой вечер 1 — берётся первый непустой «до»', () => {
    const p = week()
    p[0] = pt(1, null, null, '')
    expect(chartSummary(p).firstBefore).toBe(3)
  })

  it('пустой вечер 7 — берётся последний непустой «после»', () => {
    const p = week()
    p[6] = pt(7, 6, null, '2026-09-24')
    p[5] = pt(6, 5, null, '2026-09-23')
    expect(chartSummary(p).lastAfter).toBe(8)
  })

  it('ни одного «после» — lastAfter остаётся null (подпись final.no_after)', () => {
    const p = week().map((x) => ({ ...x, after: null }))
    expect(chartSummary(p).lastAfter).toBeNull()
  })

  it('даты — первого и последнего засчитанного вечера', () => {
    const p = [pt(1, 4, 5, '2026-09-18'), pt(2, 4, 5, '2026-09-19'), pt(3, null, null, ''),
      pt(4, null, null, ''), pt(5, null, null, ''), pt(6, null, null, ''), pt(7, null, null, '')]
    expect(chartSummary(p)).toMatchObject({ fromDate: '2026-09-18', toDate: '2026-09-19', counted: 2 })
  })
})

describe('segments — null это разрыв, а не ноль', () => {
  it('целая неделя — одна ломаная', () => {
    const s = segments(week(), 'after')
    expect(s).toHaveLength(1)
    expect(s[0]).toBe('M150,602 L300,602 L450,534 L600,466 L750,466 L900,398 L1050,398')
  })

  it('дырка посередине разрывает линию на два куска', () => {
    const p = week()
    p[3] = pt(4, 4, null, '2026-09-21')
    const s = segments(p, 'after')
    expect(s).toHaveLength(2)
    expect(s[0].startsWith('M150,')).toBe(true)
    expect(s[1].startsWith('M750,')).toBe(true)
  })

  it('одиночная точка между двумя null линией не рисуется', () => {
    const p = [pt(1, 1, null), pt(2, 2, 7), pt(3, 3, null), pt(4, 4, null), pt(5, 5, null),
      pt(6, 6, null), pt(7, 7, null)]
    expect(segments(p, 'after')).toEqual([])
    // но сама точка на картинке есть
    expect(buildChartSvg(p, opts())).toContain(`<circle cx="300" cy="${Y(7)}" r="11"`)
  })

  it('ноль рисуется как ноль, а не как пропуск', () => {
    const p = [pt(1, 0, 0), pt(2, 0, 0), pt(3, null, null), pt(4, null, null), pt(5, null, null),
      pt(6, null, null), pt(7, null, null)]
    expect(segments(p, 'before')).toEqual(['M150,1010 L300,1010'])
  })
})

describe('даты', () => {
  it('ISO → «18 сентября»', () => {
    expect(formatRuDate('2026-09-18')).toBe('18 сентября')
    expect(formatRuDate('2026-01-01')).toBe('1 января')
    expect(formatRuDate('2026-12-31')).toBe('31 декабря')
  })

  it('демо-даты и мусор не превращаются в подзаголовок', () => {
    expect(formatRuDate('demo-3')).toBe('')
    expect(formatRuDate('')).toBe('')
    expect(formatRuDate('2026-13-01')).toBe('')
    expect(formatDateRange('demo-1', 'demo-7')).toBe('')
  })

  it('диапазон и один день', () => {
    expect(formatDateRange('2026-09-18', '2026-09-24')).toBe('18 сентября — 24 сентября')
    expect(formatDateRange('2026-09-18', '2026-09-18')).toBe('18 сентября')
  })
})

describe('итоговая строка', () => {
  it('было → стало', () => {
    expect(summaryParts(opts())).toEqual({ left: 'Было 4', right: 'стало 9' })
  })

  it('ни одного «после» — стрелка никуда не ведёт', () => {
    expect(summaryParts(opts({ lastAfter: null }))).toEqual({ left: 'Было 4', right: null })
  })

  it('совсем нет замеров — строки нет', () => {
    expect(summaryParts(opts({ firstBefore: null, lastAfter: null }))).toBeNull()
  })
})

describe('buildChartSvg', () => {
  const svg = buildChartSvg(week(), opts())

  it('холст 1200×1500', () => {
    expect(svg).toContain('width="1200" height="1500"')
    expect(svg).toContain('viewBox="0 0 1200 1500"')
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true)
  })

  it('заголовок, даты, ось 1…7 и подпись бота', () => {
    expect(svg).toContain('>Семь ночей<')
    expect(svg).toContain('>18 сентября — 24 сентября<')
    for (let e = 1; e <= 7; e++) expect(svg).toContain(`<text x="${X(e)}" y="1060"`)
    expect(svg).toContain('>@ensoma_robot<')
  })

  it('собачка ставится сама и не удваивается', () => {
    expect(buildChartSvg(week(), opts({ botName: '@ensoma_robot' }))).toContain('>@ensoma_robot<')
  })

  it('в картинке нет ничего, кроме разрешённых надписей', () => {
    const db = testDb()
    const u = makeUser(db, { tg_id: 555_123_456 })
    makeSession(db, { userId: u.id, eveningNo: 1, before: 4, after: 7, ritualDate: '2026-09-18' })
    const ctx = testCtx({ db })
    const points = chartData(ctx, u.id, 1)
    const out = buildChartSvg(points, { ...chartSummary(points), botName: 'ensoma_robot' })

    // Картинку пересылают друзьям и кладут в сторис: проверяем не «нет tg_id»,
    // а весь список надписей целиком — так новое поле не протечёт незаметно.
    const labels = [...out.matchAll(/>([^<>]+)</g)].map((m) => m[1].trim()).filter((l) => l !== '')
    const allowed = new Set([
      'Семь ночей', '18 сентября', 'Было 4', 'стало 7', '@ensoma_robot',
      '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'до', 'после',
    ])
    expect(labels.filter((l) => !allowed.has(l))).toEqual([])
    expect(out).not.toContain('555123456')
  })

  it('стрелка нарисована линиями: символа → в шрифтах нет', () => {
    expect(svg).not.toContain('→')
    expect(svg).toContain('>Было 4<')
    expect(svg).toContain('>стало 9<')
    expect(svg).toContain('text-anchor="end" font-size="92"')
    expect(svg).toContain('text-anchor="start" font-size="92"')
  })

  it('пустых кружков ровно по числу пропусков', () => {
    const p = week()
    p[3] = pt(4, null, null, '')
    p[5] = pt(6, 5, null, '2026-09-23')
    const out = buildChartSvg(p, opts())
    const empties = out.match(/<circle cx="\d+" cy="1105"/g) ?? []
    expect(empties).toHaveLength(3)
  })

  it('пустые кружки стоят вне поля значений — их нельзя прочесть как ноль', () => {
    const p = week().map((x) => ({ ...x, after: null }))
    const out = buildChartSvg(p, opts({ lastAfter: null }))
    expect(out).not.toContain(`cy="${Y(0)}" r="7"`)
    expect(out).toContain('cy="1105" r="7"')
  })

  it('сетка из шести линий и подписи 0…10', () => {
    for (const v of [0, 2, 4, 6, 8, 10]) {
      expect(svg).toContain(`<text x="120" y="${Y(v) + 9}" text-anchor="end" font-size="26"`)
    }
  })

  it('экранирует то, что ломает XML', () => {
    const out = buildChartSvg(week(), opts({ botName: 'a&b<c>' }))
    expect(out).toContain('@a&amp;b&lt;c&gt;')
    expect(out).not.toContain('<c>')
  })

  it('подзаголовка нет, когда дат нет (демо или пустой круг)', () => {
    const out = buildChartSvg(pointsFromSessions([]), opts({ fromDate: 'demo-1', toDate: 'demo-7' }))
    expect(out).not.toContain('y="200"')
  })
})

describe('renderPng — настоящий resvg', () => {
  it('шрифты лежат там, где их ищет рендер', () => {
    expect(fontsReady()).toMatchObject({ ok: true })
  })

  it('отдаёт PNG 1200×1500', () => {
    const png = renderPng(buildChartSvg(week(), opts()))
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    // IHDR: ширина и высота лежат сразу за сигнатурой и заголовком чанка.
    expect(png.readUInt32BE(16)).toBe(1200)
    expect(png.readUInt32BE(20)).toBe(1500)
    // Пустой холст весил бы килобайты: проверяем, что на картинке что-то есть.
    expect(png.length).toBeGreaterThan(50_000)
  })

  it('картинка пустого круга тоже рендерится, а не падает', () => {
    const points = pointsFromSessions([])
    const png = renderPng(buildChartSvg(points, { ...chartSummary(points), botName: 'ensoma_robot' }))
    expect(png.length).toBeGreaterThan(1000)
  })
})

describe('chartData на живой неделе', () => {
  it('семь вечеров подряд собираются по порядку', () => {
    const db = testDb()
    const u = makeUser(db)
    for (let e = 1; e <= 7; e++) {
      makeSession(db, {
        userId: u.id, eveningNo: e, before: e, after: e + 2,
        ritualDate: `2026-09-${String(17 + e).padStart(2, '0')}`, createdAt: T0 + e * 86_400,
      })
    }
    const ctx = testCtx({ db })
    const points = chartData(ctx, u.id, 1)
    expect(points.map((p) => p.before)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(points.map((p) => p.after)).toEqual([3, 4, 5, 6, 7, 8, 9])
    expect(chartSummary(points)).toMatchObject({ firstBefore: 1, lastAfter: 9, counted: 7 })
  })
})
