/**
 * Не цифра и свободный текст. §2.6 design-bot; строки 49–53 таблицы переходов §3.2.
 *
 * Здесь продукт делает то, ради чего в нём вообще есть специалист: человеческий
 * текст сохраняется и доходит до живого человека. Бот при этом ничего не лечит и
 * ничего не обещает — «Слышу тебя. Передала» и всё.
 *
 * Второе правило: ни один ответ на «не то» не отбирает у человека клавиатуру и не
 * сбрасывает прогресс. Прислал стикер вместо цифры — вопрос остаётся на экране с
 * теми же кнопками.
 */

import type { Ctx } from '../ctx.ts'
import type { UserRow } from '../db/types.ts'
import { parseNumber } from '../parse.ts'
import { notifyMessage } from './notify.ts'
import { commonVars, fresh, homeKbFor, kbs } from './flow.ts'
import { repeatCategoryQuestion } from './evening.ts'
import { maybeOfferQuizResume } from './quiz.ts'

/** Состояния, в которых бот ждёт цифру. */
const NUMBER_STATES = new Set(['awaiting_before', 'awaiting_after'])

/**
 * Записать сказанное словами. Длинный текст дополнительно уходит владельцу:
 * «человек делится» — это сигнал специалисту, а не строка в логе.
 */
export function recordMessage(ctx: Ctx, user: UserRow, raw: string, now: number): { id: number; long: boolean } {
  const u = fresh(ctx, user)
  const s = ctx.repo.sessions.active(u.id)
  const id = ctx.repo.messages.add(u.id, raw, u.state, s?.id ?? null, now)
  const long = raw.length > ctx.settings.int('long_text_threshold', 60)
  if (long) {
    notifyMessage(ctx, u, raw, id, now)
    ctx.repo.messages.markNotified(id)
  }
  return { id, long }
}

/**
 * Единственный ответ на всё, что не разобралось в цифру, кнопку или команду.
 * isMedia — стикер, фото, голосовое: текста нет, сохранять нечего.
 */
export async function handleFreeText(
  ctx: Ctx,
  user: UserRow,
  raw: string,
  now: number,
  isMedia = false,
): Promise<void> {
  const u = fresh(ctx, user)
  const K = kbs(ctx)
  const vars = commonVars(ctx, u, now)

  // Цифра уже записана, ждём категорию: повторяем вопрос о ней (строка 50).
  if (u.state === 'awaiting_state') {
    const s = ctx.repo.sessions.active(u.id)
    if (s) {
      if (!isMedia && raw !== '') recordMessage(ctx, u, raw, now)
      await repeatCategoryQuestion(ctx, u, s, now)
      return
    }
  }

  const saved = !isMedia && raw !== '' ? recordMessage(ctx, u, raw, now) : { id: 0, long: false }

  if (NUMBER_STATES.has(u.state)) {
    await ctx.send.text(u, numberRetryKey(raw, isMedia, saved.long), numberRetryVars(raw, vars), K.numbersKb())
    return
  }

  switch (u.state) {
    case 'practicing':
      // Аудио выше в чате; переотправлять его нельзя, а звать к «Готово» — можно.
      await ctx.send.text(u, 'free.practicing', vars)
      return

    case 'paused':
      await ctx.send.text(u, 'free.paused', vars, K.homeKb({ resume: true }))
      return

    case 'completed':
      await ctx.send.text(u, 'free.completed', vars, homeKbFor(ctx, u))
      return

    case 'quiz_after': {
      // Тест брошен на середине: один раз мягко предлагаем продолжить (строка 48).
      if (await maybeOfferQuizResume(ctx, u, now)) return
      await ctx.send.text(u, 'free.completed', vars, homeKbFor(ctx, u))
      return
    }

    default:
      await ctx.send.text(u, 'free.idle', vars, K.homeKb())
  }
}

/** §2.6: у каждого вида «не цифры» свой ответ — это и есть разница между ботом и формой. */
function numberRetryKey(raw: string, isMedia: boolean, long: boolean): string {
  if (long) return 'num.long_text'
  if (isMedia || raw.trim() === '') return 'num.not_number'
  const res = parseNumber(raw)
  if ('value' in res) return 'num.not_number' // сюда цифра не доходит, но пусть будет безопасно
  if (res.error === 'fraction') return 'num.fraction'
  if (res.error === 'range') return 'num.range'
  return 'num.not_number'
}

function numberRetryVars(raw: string, base: Record<string, string | number>): Record<string, string | number> {
  const res = parseNumber(raw)
  if ('value' in res || res.error !== 'fraction') return base
  return { ...base, a: res.a ?? 0, b: res.b ?? 0 }
}
