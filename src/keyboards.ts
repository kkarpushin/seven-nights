/**
 * Клавиатуры. §4 design-bot, §5.8 архитектуры.
 *
 * Правило разделения одно, без исключений: ответ, который является содержанием
 * (цифра, категория, дом) — reply-клавиатура; кнопка, привязанная к конкретному
 * сообщению и обязанная уметь протухнуть («Готово» под аудио, категория под
 * вопросом) — inline; ссылка — всегда inline URL.
 *
 * Цифры никогда не делаем inline: сонному человеку нужна большая клавиатура внизу
 * экрана, а не мелкие кнопки в уехавшем вверх сообщении.
 *
 * Отступление от §5.8, осознанное: функции собраны в фабрику createKeyboards(texts)
 * вместо свободных функций модуля. Подписи кнопок редактируются в админке, то есть
 * приходят из Texts, а Texts живёт в Ctx — модульная функция без доступа к нему
 * могла бы работать только с зашитыми строками, чего §4 прямо запрещает. Имена и
 * аргументы самих функций — как в контракте.
 */

import type { Kb, Texts } from './ctx.ts'
import type { Category } from './db/types.ts'
import { clockOptions } from './time.ts'

/** Часы по умолчанию в первом вопросе онбординга. §4 design-bot. */
export const DEFAULT_HOUR_OPTIONS = ['21:00', '22:00', '23:00'] as const

/** Граница «утро или вечер» для порядка и подписи третьей категории. §2.2 design-bot. */
export const DAY_CATEGORY_SWITCH_HOUR = 14

export type NumbersExtra = {
  /** Третий ряд «Не сегодня» — только на вечернем пинге. */
  notToday?: boolean
  /** Третий ряд «Лучше в 21:00» — только в первом вечере из онбординга. */
  betterAt?: string
}

export type Keyboards = {
  numbersKb(extra?: NumbersExtra): Kb
  hoursKb(): Kb
  clockKb(guessOffsetMin: number, now: number): Kb
  categoriesKb(sessionId: number, localHour: number): Kb
  doneKb(sessionId: number): Kb
  homeKb(opts?: { resume?: boolean; restart?: boolean }): Kb
  pauseOfferKb(): Kb
  /** §5.8 обещает ButtonId, но «Записаться на разговор» и «Мой канал» — не reply-кнопки
   *  и в ButtonId не входят, поэтому принимаем ключ текста. */
  urlKb(labelKey: string, url: string): Kb
  quizKb(q: number, withBack: boolean): Kb
  quizOfferKb(): Kb
  quizResumeKb(): Kb
  changeTimeKb(): Kb
}

/** Порядок категорий и подпись «дневной» зависят от локального часа. §2.2 design-bot. */
export function categoryOrder(localHour: number): Array<{ category: Category; key: string }> {
  const dayKey = localHour < DAY_CATEGORY_SWITCH_HOUR ? 'btn.cat_day_morning' : 'btn.cat_day_evening'
  const day = { category: 'day' as Category, key: dayKey }
  const calm = { category: 'calm' as Category, key: 'btn.cat_calm' }
  const sleep = { category: 'sleep' as Category, key: 'btn.cat_sleep' }
  return localHour < DAY_CATEGORY_SWITCH_HOUR ? [day, calm, sleep] : [sleep, calm, day]
}

/**
 * Ключ подписи категории для текущего часа. Нужен не только клавиатуре: сообщение
 * «Сегодня: …» после выбора обязано назвать категорию теми же словами, что были на
 * кнопке, иначе человек решит, что нажал не туда.
 */
export function categoryLabelKey(category: Category, localHour: number): string {
  return categoryOrder(localHour).find((c) => c.category === category)?.key ?? 'btn.cat_sleep'
}

export function createKeyboards(t: Texts): Keyboards {
  return {
    numbersKb(extra = {}) {
      const rows = [
        ['0', '1', '2', '3', '4', '5'],
        ['6', '7', '8', '9', '10'],
      ]
      // Третий ряд взаимоисключающий: «Не сегодня» — это отказ от вечера программы,
      // «Лучше в {time}» — перенос первого вечера. Вместе они не встречаются никогда.
      if (extra.betterAt) rows.push([extra.betterAt])
      else if (extra.notToday) rows.push([t.label('not_today')])
      return { reply: rows, oneTime: true }
    },

    hoursKb: () => ({
      reply: [[...DEFAULT_HOUR_OPTIONS], [t.label('other_hour')]],
      oneTime: true,
    }),

    // Три реальных времени: гипотеза и соседние пояса ±1 час. Минуты у всех трёх
    // одинаковые — именно это делает нужную кнопку узнаваемой с одного взгляда.
    clockKb: (guessOffsetMin, now) => ({
      reply: [clockOptions(guessOffsetMin, now).map((o) => o.label), [t.label('other_clock')]],
      oneTime: true,
    }),

    categoriesKb: (sessionId, localHour) => ({
      inline: categoryOrder(localHour).map((c) => [
        { text: t.get(c.key), data: `cat:${sessionId}:${c.category}` },
      ]),
    }),

    doneKb: (sessionId) => ({ inline: [[{ text: t.get('btn.done'), data: `done:${sessionId}` }]] }),

    homeKb(opts = {}) {
      const rows: string[][] = []
      if (opts.resume) rows.push([t.label('resume')])
      rows.push([t.label('practice_now')])
      if (opts.restart) rows.push([t.label('restart')])
      return { reply: rows }
    },

    pauseOfferKb: () => ({ reply: [[t.label('pause')], [t.label('remind_tomorrow')]] }),

    urlKb: (labelKey, url) => ({ inline: [[{ text: t.get(labelKey), url }]] }),

    quizKb: (q, withBack) => {
      const row = (from: number, to: number) =>
        Array.from({ length: to - from + 1 }, (_, i) => ({ text: String(from + i), data: `qa:${q}:${from + i}` }))
      const rows = [row(0, 5), row(6, 10)]
      if (withBack) rows.push([{ text: t.get('btn.quiz_back'), data: `qb:${q}` }])
      return { inline: rows }
    },

    quizOfferKb: () => ({
      inline: [[{ text: t.get('btn.quiz_start'), data: 'qstart' }, { text: t.get('btn.quiz_skip'), data: 'qskip' }]],
    }),

    quizResumeKb: () => ({
      inline: [[{ text: t.get('btn.quiz_resume'), data: 'qresume' }, { text: t.get('btn.quiz_skip'), data: 'qskip' }]],
    }),

    changeTimeKb: () => ({ inline: [[{ text: t.get('btn.change_time'), data: 'chtime' }]] }),
  }
}
