/**
 * Дашборд одним запросом. §6.6 архитектуры + §3.2 design-admin.
 *
 * Один запрос на экран — сознательно: на телефоне шесть параллельных запросов
 * заметны, а все цифры всё равно считаются по одной и той же базе за миллисекунды.
 *
 * Основная часть приходит из src/db/stats.ts (зона инженера A) без изменений.
 * Три среза, которых там нет, посчитаны здесь и только на чтение: активность по
 * дням, распределение категорий и «кто сейчас в программе». Их место — в stats.ts,
 * если они понадобятся кому-то ещё; пока их потребитель один, дашборд.
 */

import { Hono } from 'hono'
import type { Ctx } from '../../ctx.ts'
import type { Category } from '../../db/types.ts'
import { noStore, parseWindow, wantsDemo, type Window } from '../util.ts'

export type DayPoint = { date: string; evening: number; now: number; total: number }
export type CategorySlice = { category: Category; n: number }
export type NowInProgram = {
  id: number
  state: string
  current_evening: number
  last_seen_at: number | null
  demo: 0 | 1
}

/** Хвост SQL, исключающий демо-людей. Пустой, когда демо просят показать. */
function noDemo(alias: string, includeDemo: boolean): string {
  return includeDemo ? '' : ` AND ${alias} NOT IN (SELECT id FROM users WHERE demo = 1)`
}

export function byDay(ctx: Ctx, w: Window, includeDemo: boolean): DayPoint[] {
  return ctx.db
    .prepare(`
      SELECT date(practice_sent_at, 'unixepoch') AS date,
             SUM(CASE WHEN kind = 'evening' THEN 1 ELSE 0 END) AS evening,
             SUM(CASE WHEN kind = 'now'     THEN 1 ELSE 0 END) AS now,
             COUNT(*) AS total
        FROM sessions
       WHERE practice_sent_at IS NOT NULL
         AND practice_sent_at BETWEEN ? AND ?${noDemo('user_id', includeDemo)}
       GROUP BY date ORDER BY date
    `)
    .all(w.from, w.to) as DayPoint[]
}

export function categories(ctx: Ctx, w: Window, includeDemo: boolean): CategorySlice[] {
  return ctx.db
    .prepare(`
      SELECT category, COUNT(*) AS n
        FROM sessions
       WHERE practice_sent_at IS NOT NULL AND category IS NOT NULL
         AND practice_sent_at BETWEEN ? AND ?${noDemo('user_id', includeDemo)}
       GROUP BY category ORDER BY n DESC
    `)
    .all(w.from, w.to) as CategorySlice[]
}

export function nowInProgram(ctx: Ctx, includeDemo: boolean, limit = 5): NowInProgram[] {
  return ctx.db
    .prepare(`
      SELECT id, state, current_evening, last_seen_at, demo
        FROM users
       WHERE state IN ('awaiting_before','awaiting_state','practicing','awaiting_after','idle')
         ${includeDemo ? '' : 'AND demo = 0'}
       ORDER BY last_seen_at DESC NULLS LAST, id DESC
       LIMIT ?
    `)
    .all(limit) as NowInProgram[]
}

/** «Считаю по 18 людям, у кого есть обе цифры» — число под цифрой прироста. */
export function gainPeople(ctx: Ctx, w: Window, includeDemo: boolean): number {
  const row = ctx.db
    .prepare(`
      WITH fb AS (
        SELECT user_id, run_no, before_value,
               ROW_NUMBER() OVER (PARTITION BY user_id, run_no ORDER BY evening_no) AS rn
          FROM sessions WHERE kind = 'evening' AND before_value IS NOT NULL),
      la AS (
        SELECT user_id, run_no, after_value,
               ROW_NUMBER() OVER (PARTITION BY user_id, run_no ORDER BY evening_no DESC) AS rn
          FROM sessions WHERE kind = 'evening' AND after_value IS NOT NULL)
      SELECT COUNT(*) AS n
        FROM fb JOIN la ON la.user_id = fb.user_id AND la.run_no = fb.run_no
       WHERE fb.rn = 1 AND la.rn = 1
         AND fb.user_id IN (SELECT user_id FROM events WHERE type = 'finished' AND at BETWEEN ? AND ?)
         ${noDemo('fb.user_id', includeDemo)}
    `)
    .get(w.from, w.to) as { n: number }
  return row.n
}

/** Знаменатель для «7 человек из 24 недошедших». */
export function notFinished(ctx: Ctx, now: number, includeDemo: boolean): number {
  return (
    ctx.db
      .prepare(`
        SELECT COUNT(*) AS n FROM users
         WHERE current_evening BETWEEN 1 AND 6
           AND state <> 'completed'
           AND (last_seen_at IS NULL OR last_seen_at < ?)
           ${includeDemo ? '' : 'AND demo = 0'}
      `)
      .get(now - 7 * 86_400) as { n: number }
  ).n
}

export function statsRoutes(ctx: Ctx): Hono {
  const app = new Hono()

  app.get('/', (c) => {
    noStore(c)
    const now = ctx.clock.now()
    const w = parseWindow(c, now)
    const includeDemo = wantsDemo(c)
    const q = { from: w.from, to: w.to, now, includeDemo }

    const stats = ctx.repo.stats.overview(q)

    // Предыдущий отрезок той же длины — строка «за предыдущие 30 дней — 31».
    // Для «всё время» сравнивать не с чем, и мы честно отдаём null.
    const previous =
      w.days === null
        ? null
        : ctx.repo.stats.funnel({ from: w.from - w.days * 86_400, to: w.from, now, includeDemo })

    return c.json({
      period: { from: w.from, to: w.to, days: w.days, period: w.period },
      demo: includeDemo,
      stats,
      previous,
      gainPeople: gainPeople(ctx, w, includeDemo),
      notFinished: notFinished(ctx, now, includeDemo),
      byDay: byDay(ctx, w, includeDemo),
      categories: categories(ctx, w, includeDemo),
      nowInProgram: nowInProgram(ctx, includeDemo),
      totals: {
        users: ctx.repo.users.countAll(includeDemo),
        practicesActive: ctx.repo.practices.countActive(),
      },
      serverNow: now,
    })
  })

  return app
}
