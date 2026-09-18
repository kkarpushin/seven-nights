/**
 * Сроки: обычный режим против демо. §3.4 архитектуры, §3.6 design-bot.
 *
 * Весь файл существует ради одного свойства: ни одна цифра срока не должна
 * встречаться в коде переходов. Иначе демо-режим («вечер длится пару минут»)
 * пришлось бы протаскивать if-ами через каждое место, где ставится due_at, и
 * первый же забытый if дал бы приёмочный прогон, который на шестом вечере
 * внезапно ждёт до завтрашнего вечера.
 *
 * Поэтому здесь: обычные и демо-сроки — две реализации одного интерфейса, а
 * вызывающий код знает только timingsFor(ctx, user).
 *
 * Все функции возвращают unix-секунды UTC, кроме afterTimeout — она отдаёт
 * ДЛИТЕЛЬНОСТЬ в секундах, которую прибавляют к practice_sent_at (§3.4
 * design-bot: due_at = practice_sent_at + max(12 мин, duration_sec + 3 мин)).
 */

import type { Ctx } from './ctx.ts'
import type { UserRow } from './db/types.ts'
import {
  endOfRitualDay,
  isEveningWindow,
  nextEveningAt,
  nextMorningAt,
  ritualDate as ritualDateOf,
  RITUAL_DAY_START_HOUR,
  type TimeUser,
} from './time.ts'

const MIN = 60
const HOUR = 3600

/** Обычный режим. Числа — из §3.4 design-bot, менять только вместе с ним. */
export const REAL = {
  /** Нижняя граница таймера «после»: короткая практика не обрывает паузу после неё. */
  afterMinSec: 12 * MIN,
  /** Хвост после конца записи: человек ещё лежит, вопрос сразу в ухо — грубо. */
  afterTailSec: 3 * MIN,
  nowBeforeSec: 30 * MIN,
  nowAfterSec: 3 * HOUR,
  day8Hm: '10:00',
} as const

/** Демо. Семь вечеров должны проходиться примерно за пятнадцать минут. */
export const DEMO = {
  afterSec: 1 * MIN,
  skipDeadlineSec: 5 * MIN,
  nextEveningSec: 2 * MIN,
  nowBeforeSec: 2 * MIN,
  nowAfterSec: 3 * MIN,
  day8Sec: 2 * MIN,
} as const

/**
 * Порог «процесс лежал». Таймер «после» сработал позже этого — вопрос про вчерашнюю
 * практику уже бессмысленный и даже неприятный (строка 21 §3.2). Живёт здесь, а не
 * в планировщике, потому что это такой же срок, как остальные.
 */
export const LATE_AFTER_SEC = 3 * HOUR

/**
 * Разрешённое опоздание пинга внутри тех же ритуальных суток не ограничиваем
 * отдельным числом: границей служит сама ритуальная дата (строка 9 §3.2).
 */

export type Timings = {
  readonly demo: boolean
  /** Сколько ждать после отправки аудио. Прибавляется к practice_sent_at. */
  afterTimeout(durationSec: number | null): number
  /** Когда вечер считается пропущенным, если человек не ответил. */
  skipDeadline(u: TimeUser, now: number): number
  /** Когда откроется следующий вечер. */
  nextEvening(u: TimeUser, now: number): number
  nowBeforeTimeout(now: number): number
  nowAfterTimeout(now: number): number
  /** Утренний догон; null — в демо его нет вовсе. */
  morningAt(u: TimeUser, now: number): number | null
  day8At(u: TimeUser, now: number): number
  eveningWindow(u: TimeUser, now: number): boolean
  ritualDate(u: TimeUser, now: number): string
  /** Порог уведомления владельцу о молчании; null — в демо не шлём. */
  silenceSec(): number | null
  /** Сколько пропусков подряд до автопаузы. */
  readonly autopauseAfterSkips: number
  /** Просрочка таймера «после», после которой ночной вопрос не задаём. */
  readonly lateAfterSec: number
}

/** Настройки, от которых зависят сроки. Снимаются один раз на пользователя. */
export type TimingsConfig = {
  ritualDayStartHour: number
  eveningWindowLeadMin: number
  morningHour: string
  autopauseAfterSkips: number
  silenceHours: number
}

export function timingsConfig(ctx: Ctx): TimingsConfig {
  return {
    ritualDayStartHour: ctx.settings.int('ritual_day_start_hour', RITUAL_DAY_START_HOUR),
    eveningWindowLeadMin: ctx.settings.int('evening_window_lead_min', 60),
    morningHour: ctx.settings.str('morning_hour', '10:00'),
    autopauseAfterSkips: ctx.settings.int('autopause_after_skips', 3),
    silenceHours: ctx.settings.int('silence_hours', 72),
  }
}

export function makeTimings(cfg: TimingsConfig, demo: boolean): Timings {
  const startHour = cfg.ritualDayStartHour

  if (demo) {
    return {
      demo: true,
      afterTimeout: () => DEMO.afterSec,
      skipDeadline: (_u, now) => now + DEMO.skipDeadlineSec,
      nextEvening: (_u, now) => now + DEMO.nextEveningSec,
      nowBeforeTimeout: (now) => now + DEMO.nowBeforeSec,
      nowAfterTimeout: (now) => now + DEMO.nowAfterSec,
      // Утреннего догона в демо нет: он ждал бы настоящего утра, и прогон встал бы
      // на первом же вечере, где человек не прислал цифру «после».
      morningAt: () => null,
      day8At: (_u, now) => now + DEMO.day8Sec,
      eveningWindow: () => true,
      ritualDate: (u, now) => ritualDateOf(u, now, startHour),
      silenceSec: () => null,
      autopauseAfterSkips: cfg.autopauseAfterSkips,
      lateAfterSec: LATE_AFTER_SEC,
    }
  }

  return {
    demo: false,
    afterTimeout: (durationSec) =>
      Math.max(REAL.afterMinSec, (durationSec ?? 0) + REAL.afterTailSec),
    skipDeadline: (u, now) => endOfRitualDay(u, now, startHour),
    nextEvening: (u, now) => nextEveningAt(u, now, startHour),
    nowBeforeTimeout: (now) => now + REAL.nowBeforeSec,
    nowAfterTimeout: (now) => now + REAL.nowAfterSec,
    morningAt: (u, now) => nextMorningAt(u, now, cfg.morningHour),
    day8At: (u, now) => nextMorningAt(u, now, REAL.day8Hm),
    eveningWindow: (u, now) => isEveningWindow(u, now, cfg.eveningWindowLeadMin, startHour),
    ritualDate: (u, now) => ritualDateOf(u, now, startHour),
    silenceSec: () => cfg.silenceHours * HOUR,
    autopauseAfterSkips: cfg.autopauseAfterSkips,
    lateAfterSec: LATE_AFTER_SEC,
  }
}

/**
 * Сроки для конкретного человека. Демо — свойство пользователя, а не процесса:
 * владелец включает себе /demo, пока остальные идут обычным темпом.
 */
export function timingsFor(ctx: Ctx, u: Pick<UserRow, 'demo'>): Timings {
  return makeTimings(timingsConfig(ctx), u.demo === 1)
}
