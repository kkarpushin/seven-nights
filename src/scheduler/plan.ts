/**
 * Вычисление следующего срока. §4.2, §4.4 архитектуры.
 *
 * Здесь два разных дела, и их важно не путать.
 *
 * Первое — планировщики переходов (planPing, planAfterTimeout, …): «мы только что
 * сделали X, когда просыпаться дальше». Их зовут и переходы бота, и обработчики
 * планировщика, чтобы срок считался в одном месте, а не в двадцати.
 *
 * Второе — recompute(): «состояние такое, а срок непонятный — каким он ДОЛЖЕН быть».
 * Это самолечение из §4.2: рассинхрон due_kind и состояния (ручная правка в админке,
 * баг, перезапуск посреди перехода) не должен приводить ни к действию невпопад, ни
 * к застывшему навсегда пользователю. Планировщик в таком случае ничего не шлёт,
 * а ставит правильный срок и ждёт его.
 *
 * Правило, из которого всё выведено: у человека ровно один due_at и ровно один
 * due_kind. Никаких очередей, никаких таймеров в памяти — только эта пара полей,
 * которую переживает перезапуск процесса.
 */

import type { Ctx } from '../ctx.ts'
import type { DueKind, SessionRow, UserRow } from '../db/types.ts'
import { timingsFor, type Timings } from '../timings.ts'
import type { TimeUser } from '../time.ts'

export type Plan = { at: number | null; kind: DueKind | null }

/** Срока нет: бот молчит, пока человек сам не напишет. */
export const NO_DUE: Plan = { at: null, kind: null }

// ───────────────────────────── переходы ─────────────────────────────

/** Следующий вечерний пинг (строки 6, 9, 13, 23, 34, 39 §3.2). */
export function planPing(t: Timings, u: TimeUser, now: number): Plan {
  return { at: t.nextEvening(u, now), kind: 'ping' }
}

/** Срок, до которого человек должен ответить на вопрос «до» (строки 5, 8, 29, 33). */
export function planSkipDeadline(t: Timings, u: TimeUser, now: number): Plan {
  return { at: t.skipDeadline(u, now), kind: 'skip_deadline' }
}

/**
 * Таймер «после» практики (строка 16). Считается от момента отправки аудио, а не от
 * «сейчас»: если процесс тормозил между отправкой и записью, человек не должен
 * получить вопрос на минуту позже положенного.
 */
export function planAfterTimeout(t: Timings, practiceSentAt: number, durationSec: number | null): Plan {
  return { at: practiceSentAt + t.afterTimeout(durationSec), kind: 'after_timeout' }
}

/**
 * Куда ставить таймер, когда вопрос «после» уже задан (строки 19–21).
 * Утренний догон — только один раз на сессию (nudged) и только если утро реально
 * наступит раньше следующего вечера; иначе сразу ждём следующего вечера, который
 * закроет сессию без ответа (строка 27).
 */
export function planAfterAsked(t: Timings, u: TimeUser, s: SessionRow, now: number): Plan {
  if (s.kind === 'now') return { at: t.nowAfterTimeout(now), kind: 'now_timeout_after' }
  const nextEvening = t.nextEvening(u, now)
  const morning = s.nudged === 1 ? null : t.morningAt(u, now)
  if (morning !== null && morning > now && morning < nextEvening) return { at: morning, kind: 'morning' }
  return { at: nextEvening, kind: 'ping_or_close' }
}

/** Таймаут сессии «Практика сейчас» на вопросе «до» (строка 30). */
export function planNowBefore(t: Timings, now: number): Plan {
  return { at: t.nowBeforeTimeout(now), kind: 'now_timeout_before' }
}

/** Сообщение дня восьмого (строка 24 → 35). */
export function planDay8(t: Timings, u: TimeUser, now: number): Plan {
  return { at: t.day8At(u, now), kind: 'day8' }
}

// ───────────────────────────── самолечение ─────────────────────────────

/**
 * Каким должен быть срок при текущем состоянии. Возвращает NO_DUE там, где бот
 * обязан молчать: онбординг и смена времени ждут ответа человека, пауза — кнопки,
 * блокировка — разблокировки, повторный тест — нажатия.
 *
 * Отдельно про `completed`: срок есть ровно до дня восьмого. После него бот молчит
 * навсегда (строка 35) — это продуктовое решение, а не забытая ветка.
 */
export function recompute(ctx: Ctx, u: UserRow, now: number): Plan {
  const t = timingsFor(ctx, u)
  const s = ctx.repo.sessions.active(u.id)

  switch (u.state) {
    case 'idle':
      return planPing(t, u, now)

    case 'awaiting_before':
    case 'awaiting_state':
      // Сессии нет, а состояние ждёт цифру — чинить нечем: возвращаем человека
      // в ожидание вечера, следующий пинг откроет сессию заново.
      if (!s) return planPing(t, u, now)
      return s.kind === 'now' ? planNowBefore(t, now) : planSkipDeadline(t, u, now)

    case 'practicing': {
      if (!s) return planPing(t, u, now)
      const duration = s.practice_id === null ? null : (ctx.repo.practices.byId(s.practice_id)?.duration_sec ?? null)
      return planAfterTimeout(t, s.practice_sent_at ?? now, duration)
    }

    case 'awaiting_after':
      if (!s) return planPing(t, u, now)
      return planAfterAsked(t, u, s, now)

    case 'completed':
      return u.day8_sent === 1 ? NO_DUE : planDay8(t, u, now)

    case 'new':
    case 'onb_hour':
    case 'onb_clock':
    case 'change_hour':
    case 'change_clock':
    case 'quiz_after':
    case 'paused':
    case 'blocked':
      return NO_DUE

    default:
      return NO_DUE
  }
}

/**
 * Пересчитать и записать срок. Возвращает то, что записали.
 * Пишем даже NO_DUE: «срок должен быть пустым» — такой же результат, как любой другой,
 * и именно он гасит таймер, который иначе будил бы процесс каждые две минуты.
 */
export function applyRecompute(ctx: Ctx, u: UserRow, now: number): Plan {
  const plan = recompute(ctx, u, now)
  ctx.repo.users.setDue(u.id, plan)
  return plan
}
