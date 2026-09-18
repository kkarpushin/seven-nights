/**
 * Данные для картинки седьмого вечера. §5.9 и §7 архитектуры.
 *
 * Здесь нет ни одного обращения к Telegram и ни одной строки SVG: задача файла —
 * превратить сессии круга в семь точек и посчитать «было → стало». Разделение
 * нужно затем, что подпись под картинкой (§2.7 design-bot) считается по тем же
 * правилам, что и сама картинка, и расходиться им нельзя.
 */

import type { Ctx } from '../ctx.ts'
import type { SessionRow } from '../db/types.ts'

/** Ось X всегда 1…7, даже если человек прошёл меньше (§7.2). */
export const EVENINGS = 7

export type ChartPoint = {
  evening: number
  before: number | null
  after: number | null
  /** Ритуальная дата вечера: 'YYYY-MM-DD', 'demo-<n>' или '' — вечера ещё не было. */
  date: string
}

export type ChartSummary = {
  /** «Было»: вечер 1, иначе первый непустой замер «до». */
  firstBefore: number | null
  /** «Стало»: вечер 7, иначе последний непустой замер «после». */
  lastAfter: number | null
  /** Ритуальная дата первого и последнего засчитанного вечера ('' — вечеров нет). */
  fromDate: string
  toDate: string
  /** Сколько вечеров засчитано — для админки и логов. */
  counted: number
}

/**
 * Сессии круга → семь точек.
 *
 * На график попадает только ЗАСЧИТАННЫЙ вечер, то есть тот, где аудио ушло
 * (`practice_sent_at`, §3.4 design-bot). Отказ «Не сегодня» и брошенная сессия
 * занимают тот же `evening_no`, который следующий пинг переиспользует, — покажи
 * мы их, за один вечер получилось бы две точки, одна из них с пустым «после».
 */
export function pointsFromSessions(sessions: readonly SessionRow[]): ChartPoint[] {
  const points: ChartPoint[] = []
  for (let e = 1; e <= EVENINGS; e++) points.push({ evening: e, before: null, after: null, date: '' })

  for (const s of sessions) {
    if (s.practice_sent_at === null) continue
    const e = s.evening_no
    if (e === null || e < 1 || e > EVENINGS) continue
    points[e - 1] = {
      evening: e,
      before: s.before_value,
      after: s.after_value,
      date: s.ritual_date,
    }
  }
  return points
}

/** Точки текущего круга. Прошлые круги остаются в админке и на график не лезут. */
export function chartData(ctx: Ctx, userId: number, runNo: number): ChartPoint[] {
  return pointsFromSessions(ctx.repo.sessions.runSessions(userId, runNo))
}

/**
 * «Было {first_before}. Стало {last_after}.» — правила §2.7 design-bot дословно:
 * берём вечер 1 и вечер 7, а если там пусто — ближайший непустой с того же края.
 */
export function chartSummary(points: readonly ChartPoint[]): ChartSummary {
  const counted = points.filter((p) => p.date !== '')

  let firstBefore = points[0]?.before ?? null
  if (firstBefore === null) {
    for (const p of points) {
      if (p.before !== null) {
        firstBefore = p.before
        break
      }
    }
  }

  let lastAfter = points[EVENINGS - 1]?.after ?? null
  if (lastAfter === null) {
    for (let i = points.length - 1; i >= 0; i--) {
      const v = points[i].after
      if (v !== null) {
        lastAfter = v
        break
      }
    }
  }

  return {
    firstBefore,
    lastAfter,
    fromDate: counted[0]?.date ?? '',
    toDate: counted[counted.length - 1]?.date ?? '',
    counted: counted.length,
  }
}
