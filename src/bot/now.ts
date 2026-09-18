/**
 * «Практика сейчас» — внесчётная сессия. §2.3 design-bot, строки 15, 25, 28–31 §3.2.
 *
 * Отличие от вечера ровно одно, но важное: эта практика НЕ засчитывается в семь
 * вечеров. Номер вечера не двигается, полоски пути нет, утреннего догона нет,
 * сроки короче. Всё остальное — тот же ритуал, и тексты отличаются только префиксом
 * ключа (now.* вместо ev.*).
 *
 * Правило слияния живёт в flow.mergeRule: внутри вечернего окна эта кнопка
 * запускает СЕГОДНЯШНИЙ вечер, а не дополнительную практику. Сюда попадают только
 * те нажатия, которые действительно вне программы.
 */

import type { Ctx } from '../ctx.ts'
import type { SessionRow, UserRow } from '../db/types.ts'
import { commonVars, fresh, kbs, recomputeDue, setDue, timings } from './flow.ts'

/** Строка 30 §3.2: открыть внесчётную сессию. */
export async function startNow(ctx: Ctx, user: UserRow, now: number): Promise<void> {
  const u = fresh(ctx, user)
  const t = timings(ctx, u)

  // Куда вернуть человека после практики: пауза должна остаться паузой, а
  // завершённая программа — завершённой.
  const back = u.state

  const stale = ctx.repo.sessions.active(u.id)
  if (stale) {
    if (stale.practice_sent_at) ctx.repo.sessions.close(stale.id, 'done', now)
    else ctx.repo.sessions.deleteSession(stale.id)
  }

  const s = ctx.repo.sessions.open({
    userId: u.id,
    runNo: u.run_no,
    kind: 'now',
    eveningNo: null,
    ritualDate: t.ritualDate(u, now),
    now,
  })
  ctx.repo.sessions.setPromptSent(s.id, now)
  ctx.repo.users.update(u.id, { state_before_now: back })

  let msgId: number
  try {
    const u2 = fresh(ctx, u)
    msgId = await ctx.send.text(u2, 'now.before', commonVars(ctx, u2, now), kbs(ctx).numbersKb())
  } catch (err) {
    ctx.repo.sessions.deleteSession(s.id)
    ctx.repo.users.update(u.id, { state_before_now: null })
    throw err
  }

  ctx.repo.sessions.setPromptSent(s.id, now, msgId)
  setDue(ctx, fresh(ctx, u), 'awaiting_before', t.nowBeforeTimeout(now), 'now_timeout_before')
}

/**
 * Строка 15 §3.2: на вопрос «до» не ответили.
 * Сессию именно УДАЛЯЕМ, а не закрываем: пустая строка «Практика сейчас» в
 * статистике выглядела бы как состоявшаяся практика, которой не было.
 */
export async function dropNowSession(ctx: Ctx, user: UserRow, s: SessionRow, now: number): Promise<void> {
  const u = fresh(ctx, user)
  ctx.repo.sessions.deleteSession(s.id)
  restoreAfterNow(ctx, u, now)
}

/** Строка 28 §3.2: практику дослушали, цифру не прислали. Закрываем молча. */
export async function closeNowByTimeout(ctx: Ctx, user: UserRow, s: SessionRow, now: number): Promise<void> {
  const u = fresh(ctx, user)
  ctx.db.transaction(() => {
    ctx.repo.sessions.close(s.id, 'done', now)
    ctx.repo.events.add(u.id, 'now_done', now, { before: s.before_value, after: null, practice_id: s.practice_id }, s.id)
  })()
  restoreAfterNow(ctx, u, now)
}

/**
 * Вернуть человека туда, где его застала «Практика сейчас».
 * Срок пересчитываем, а не запоминаем: пока шла сессия, вечер мог наступить, и
 * сохранённый due_at оказался бы в прошлом.
 */
export function restoreAfterNow(ctx: Ctx, user: UserRow, now: number): void {
  const u = fresh(ctx, user)
  ctx.repo.users.update(u.id, { state: u.state_before_now ?? 'idle', state_before_now: null })
  recomputeDue(ctx, fresh(ctx, u), now)
}
