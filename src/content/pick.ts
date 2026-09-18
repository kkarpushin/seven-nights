/**
 * Выбор практики из библиотеки. §5.9 архитектуры, §3.5 design-bot, §0 решение 2.
 *
 * Правил два, и они спорят между собой — поэтому порядок здесь важнее кода:
 *
 * 1. Маршрут сна (`settings.sleep_route`) старше. Вечера 1–7 категории «сон» идут
 *    по заданному владельцем списку, где седьмой вечер — та же практика, что и
 *    первый: «та же запись, а ты другой» — это вау-момент недели, и правило
 *    «меньше всего слушал» его бы сломало ровно на вечерах 5–7.
 * 2. Везде остальное — «меньше всего слушал»: непрослушанные вперёд, при равенстве
 *    самая давняя, потом sort_order, потом id. Сортировка живёт в SQL
 *    (plays.statsFor), здесь — только выбор первой строки и запасные ветки.
 */

import type { Ctx } from '../ctx.ts'
import type { Category, PracticeRow, SessionRow, UserRow } from '../db/types.ts'

/** Порядок обхода, когда в запрошенной категории пусто: сон важнее всего (§3.5, п.5). */
export const CATEGORY_FALLBACK: readonly Category[] = ['sleep', 'calm', 'day']

/**
 * Лучшая практика категории по правилу «меньше всего слушал».
 * Порядок задаёт запрос в plays.statsFor: plays ASC, last_at ASC, sort_order, id.
 */
export function leastPlayedIn(ctx: Ctx, userId: number, category: Category): PracticeRow | null {
  const stats = ctx.repo.plays.statsFor(userId, category)
  const first = stats[0]
  if (first === undefined) return null
  return ctx.repo.practices.byId(first.practice_id) ?? null
}

/**
 * Практика вечера по маршруту сна. null — маршрут не задан, короче вечера,
 * ссылается на несуществующий слаг, на выключенную практику или на практику,
 * которую в админке перенесли в другую категорию. Во всех этих случаях спокойно
 * уходим на общее правило: человек не должен получить «нет практики» из-за того,
 * что владелец переименовал файл.
 */
export function routePractice(ctx: Ctx, s: SessionRow, category: Category): PracticeRow | null {
  if (s.kind !== 'evening' || category !== 'sleep') return null
  const eveningNo = s.evening_no
  if (eveningNo === null || eveningNo < 1) return null

  const route = ctx.settings.json<string[]>('sleep_route', [])
  const slug = route[eveningNo - 1]
  if (typeof slug !== 'string' || slug === '') return null

  const row = ctx.repo.practices.bySlug(slug)
  if (row === undefined) {
    ctx.log.warn('Маршрут сна ссылается на несуществующую практику', { slug, evening_no: eveningNo })
    return null
  }
  if (row.active !== 1 || row.category !== 'sleep') return null
  return row
}

export function pickPractice(
  ctx: Ctx,
  u: UserRow,
  s: SessionRow,
  category: Category,
): PracticeRow | null {
  const picked = routePractice(ctx, s, category) ?? leastPlayedIn(ctx, u.id, category) ?? fallback(ctx, u, category)

  // Практика без аудио отправиться не сможет. Отсеивать такие здесь нельзя —
  // тогда единственная практика категории молча превратилась бы в «библиотека
  // пуста», — но заметить это владелец должен раньше, чем человек в чате.
  if (picked !== null && picked.audio_path === null && picked.tg_file_id === null) {
    ctx.log.warn('Выбрана практика без аудио', { slug: picked.slug, practice_id: picked.id })
  }
  return picked
}

/** Категория пуста — берём по тому же правилу из любой другой, приоритет sleep. */
function fallback(ctx: Ctx, u: UserRow, requested: Category): PracticeRow | null {
  for (const c of CATEGORY_FALLBACK) {
    if (c === requested) continue
    const row = leastPlayedIn(ctx, u.id, c)
    if (row !== null) {
      ctx.log.info('Категория пуста, практика взята из соседней', { requested, used: c, slug: row.slug })
      return row
    }
  }
  return null
}
