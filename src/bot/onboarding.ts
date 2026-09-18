/**
 * Онбординг из трёх вопросов и смена времени. §2.1, §2.9, §2.10 design-bot;
 * строки 1–7, 37–39 таблицы переходов §3.2.
 *
 * Приёмочный критерий простоты — пять касаний от /start до звучащей практики:
 * Start → час → «сколько на часах» → цифра → категория. Отсюда два решения,
 * которые легко случайно сломать:
 *
 * 1. Про часовой пояс НЕ спрашивают. Спрашивают, сколько сейчас на часах, и три
 *    кнопки с реальным временем закрывают вопрос одним тапом. Пояс вычисляется
 *    из разницы с UTC (§2.10).
 * 2. Если человек пришёл вечером, первый вечер начинается НЕМЕДЛЕННО, а не завтра.
 *    Программа должна ощущаться начавшейся, пока он ещё в чате.
 */

import type { Ctx } from '../ctx.ts'
import type { UserRow, UserState } from '../db/types.ts'
import { parseClock, parseHour, parseStartPayload } from '../parse.ts'
import { guessOffsetByLanguage, minutesToHm, offsetFromLocalClock } from '../time.ts'
import { notifyStarted } from './notify.ts'
import { commonVars, fresh, kbs, recomputeDue, setDue, timings } from './flow.ts'
import { startEvening } from './evening.ts'

/** Гипотеза пояса: язык клиента, а при смене времени — то, что уже известно про человека. */
function guessOffset(ctx: Ctx, u: UserRow, isChange: boolean): number {
  if (isChange) return u.tz_offset_min
  return guessOffsetByLanguage(u.language_code, ctx.settings.int('default_tz_offset_min', 180))
}

const CHANGE_STATES: readonly UserState[] = ['change_hour', 'change_clock']

// ───────────────────────────── /start у нового человека ─────────────────────────────

/** Строка 1 §3.2. */
export async function startOnboarding(
  ctx: Ctx,
  user: UserRow,
  payload: string | undefined,
  now: number,
): Promise<void> {
  const u = fresh(ctx, user)
  const parsed = parseStartPayload(payload)

  if (parsed.raw !== null && u.start_payload === null) {
    ctx.repo.users.update(u.id, { start_payload: parsed.raw })
  }
  if (parsed.quizSum !== null) {
    // Индекс с лендинга — точка отсчёта недели. Пишем до первого сообщения,
    // чтобы строка про индекс попала уже в это приветствие.
    if (ctx.repo.quiz.setIncoming(u.id, parsed.quizSum, now)) {
      ctx.repo.events.add(u.id, 'quiz_in', now, { sum: parsed.quizSum })
    }
  }

  setDue(ctx, u, 'onb_hour', null, null)

  const u2 = fresh(ctx, u)
  await ctx.send.text(u2, 'onb.welcome', commonVars(ctx, u2, now))

  // Полторы реплики подряд без паузы читаются как автоответчик. 1,2 секунды и
  // «печатает» превращают их в разговор.
  await ctx.clock.sleep(1200)
  await ctx.send.action(u2, 'typing')

  if (u2.quiz_index !== null) {
    await ctx.send.text(u2, 'onb.quiz_index', {
      quiz_index: u2.quiz_index,
      quiz_sum: u2.quiz_sum ?? '',
    })
  }

  await ctx.send.text(u2, 'onb.hour_ask', commonVars(ctx, u2, now), kbs(ctx).hoursKb())
}

// ───────────────────────────── вопрос 2: удобный час ─────────────────────────────

/** Строки 2–3 и 38 §3.2. Работает и для онбординга, и для «Поменять время». */
export async function acceptHour(ctx: Ctx, user: UserRow, raw: string, now: number): Promise<void> {
  const u = fresh(ctx, user)
  const isChange = CHANGE_STATES.includes(u.state)
  const hm = parseHour(raw)

  if (!hm) {
    await ctx.send.text(u, 'onb.hour_retry', commonVars(ctx, u, now), kbs(ctx).hoursKb())
    return
  }

  const time = minutesToHm(hm.h * 60 + hm.m)
  ctx.repo.users.update(u.id, { evening_time: time })
  setDue(ctx, u, isChange ? 'change_clock' : 'onb_clock', null, null)

  const u2 = fresh(ctx, u)
  await ctx.send.text(
    u2,
    isChange ? 'time.clock_ask' : 'onb.clock_ask',
    { ...commonVars(ctx, u2, now), time },
    kbs(ctx).clockKb(guessOffset(ctx, u2, isChange), now),
  )
}

// ───────────────────────────── вопрос 3: сколько на часах ─────────────────────────────

/** Строки 4–6 и 39 §3.2. */
export async function acceptClock(ctx: Ctx, user: UserRow, raw: string, now: number): Promise<void> {
  const u = fresh(ctx, user)
  const isChange = CHANGE_STATES.includes(u.state)
  const hm = parseClock(raw)
  const offset = hm ? offsetFromLocalClock(hm, now, guessOffset(ctx, u, isChange)) : null

  if (offset === null) {
    await ctx.send.text(
      u,
      'onb.clock_retry',
      commonVars(ctx, u, now),
      kbs(ctx).clockKb(guessOffset(ctx, u, isChange), now),
    )
    return
  }

  ctx.repo.users.update(u.id, { tz_offset_min: offset })

  if (isChange) return finishTimeChange(ctx, fresh(ctx, u), now)
  return finishOnboarding(ctx, fresh(ctx, u), now)
}

/**
 * Строки 5–6 §3.2: развилка по вечернему окну.
 * В окне и вечера на эту ритуальную дату ещё не было — начинаем прямо сейчас.
 */
export async function finishOnboarding(ctx: Ctx, user: UserRow, now: number): Promise<void> {
  const u = fresh(ctx, user)
  const t = timings(ctx, u)

  ctx.repo.events.add(u.id, 'started', now, { time: u.evening_time, tz_offset_min: u.tz_offset_min })
  notifyStarted(ctx, u, now)

  const canStartNow = t.eveningWindow(u, now) && !ctx.repo.sessions.countedOn(u.id, t.ritualDate(u, now))

  if (canStartNow) {
    setDue(ctx, u, 'idle', null, null)
    await ctx.send.text(u, 'onb.done_now', commonVars(ctx, u, now))
    await startEvening(ctx, fresh(ctx, u), u.current_evening + 1, now, { fromOnboarding: true })
    return
  }

  setDue(ctx, u, 'idle', t.nextEvening(u, now), 'ping')
  const u2 = fresh(ctx, u)
  await ctx.send.text(u2, 'onb.done_later', commonVars(ctx, u2, now), kbs(ctx).homeKb())
}

/**
 * Строка 39 §3.2: время изменено.
 *
 * Контракт велит уйти в idle, но это подняло бы с паузы того, кто на паузе, и
 * разбудило бы завершившего программу. Возвращаем туда, откуда пришли (состояние
 * сохранено в state_before_now при нажатии «Поменять время»), а срок пересчитываем.
 */
export async function finishTimeChange(ctx: Ctx, user: UserRow, now: number): Promise<void> {
  const u = fresh(ctx, user)
  const back: UserState = u.state_before_now ?? 'idle'

  ctx.repo.users.update(u.id, { state: back, state_before_now: null })
  ctx.repo.events.add(u.id, 'hour_changed', now, { time: u.evening_time, tz_offset_min: u.tz_offset_min })
  recomputeDue(ctx, fresh(ctx, u), now)

  const u2 = fresh(ctx, u)
  await ctx.send.text(u2, 'time.done', commonVars(ctx, u2, now), kbs(ctx).homeKb())
}

// ───────────────────────────── повтор вопроса (§3.6) ─────────────────────────────

/** Канонический вопрос состояний онбординга и смены времени. */
export async function reprompt(ctx: Ctx, user: UserRow, now: number): Promise<void> {
  const u = fresh(ctx, user)
  const K = kbs(ctx)
  const vars = commonVars(ctx, u, now)

  switch (u.state) {
    case 'onb_hour':
      await ctx.send.text(u, 'onb.hour_ask', vars, K.hoursKb())
      return
    case 'change_hour':
      await ctx.send.text(u, 'time.hour_ask', vars, K.hoursKb())
      return
    case 'onb_clock':
      await ctx.send.text(u, 'onb.clock_ask', vars, K.clockKb(guessOffset(ctx, u, false), now))
      return
    case 'change_clock':
      await ctx.send.text(u, 'time.clock_ask', vars, K.clockKb(guessOffset(ctx, u, true), now))
      return
    default:
      return
  }
}
