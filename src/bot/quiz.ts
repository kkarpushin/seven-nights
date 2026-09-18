/**
 * Повторный тест «Индекс внутренней опоры» внутри бота.
 * docs/quiz-bot-integration.md §4, §7; строки 43–48 таблицы переходов §3.2.
 *
 * Тест предлагается ОДИН раз, по кнопке, после графика и приглашения на разговор,
 * и только тем, у кого есть входной замер с лендинга: без «было» сравнивать не с
 * чем, а тест ради теста здесь никому не нужен. «Не сейчас» закрывает предложение
 * навсегда.
 *
 * Семь вопросов идут по одному сообщению, ответ — inline-кнопками 0–10 двумя
 * рядами, с «Назад» на каждом шаге кроме первого. Ответы пишутся сразу, поэтому
 * брошенный на четвёртом вопросе тест можно продолжить с того же места.
 */

import type { Ctx } from '../ctx.ts'
import type { UserRow } from '../db/types.ts'
import { QUIZ_QUESTIONS } from '../db/quiz.ts'
import { quizIndex, quizResultKey } from '../db/defaultTexts.ts'
import { commonVars, fresh, homeKbFor, kbs } from './flow.ts'

/** Через сколько после брошенного теста уместно один раз напомнить (строка 48). */
export const RESUME_AFTER_SEC = 3600

/** Предлагать ли повторный тест этому человеку. §4 интеграции, §7 граничные случаи. */
export function quizAfterAvailable(ctx: Ctx, u: UserRow): boolean {
  if (u.quiz_sum === null) return false // пришёл без теста — сравнивать не с чем
  if (u.quiz_after_declined === 1) return false
  if (u.quiz_sum_after !== null) return false
  return ctx.settings.bool('quiz_after_enabled', true)
}

/** Шаг 5 финала (§3.5): отдельное сообщение с предложением. */
export async function offerQuizAfter(ctx: Ctx, user: UserRow, _now: number): Promise<void> {
  const u = fresh(ctx, user)
  if (!quizAfterAvailable(ctx, u)) return
  await ctx.send.text(u, 'quiz.offer', { quiz_index: u.quiz_index ?? 0 }, kbs(ctx).quizOfferKb())
}

/** Строка 43 §3.2: «Пройти семь вопросов». */
export async function quizStart(ctx: Ctx, user: UserRow, now: number): Promise<void> {
  const u = fresh(ctx, user)
  if (u.quiz_sum === null) return

  // Срок (день восьмой) НЕ гасим, хотя строка 43 велит due = NULL: иначе человек,
  // начавший тест вечером седьмого дня, никогда не получит последнее сообщение
  // программы. Диспетчер дня восьмого принимает и состояние quiz_after.
  ctx.repo.users.update(u.id, { state: 'quiz_after', quiz_step: 1 })
  await askQuestion(ctx, fresh(ctx, u), 1, now)
}

/** Строка 44 §3.2: «Не сейчас» — больше не предлагаем. */
export async function quizDecline(ctx: Ctx, user: UserRow, _now: number, msgId?: number): Promise<void> {
  const u = fresh(ctx, user)
  ctx.repo.quiz.decline(u.id)
  if (u.state === 'quiz_after') ctx.repo.users.update(u.id, { state: 'completed' })
  // Сообщения не шлём — только снимаем кнопки, чтобы предложение не осталось живым.
  if (msgId) await ctx.send.clearInline(u, msgId)
}

/** Вопрос {k} из семи. Формат — из ключа quiz.question, тексты — из quiz.qN. */
export async function askQuestion(ctx: Ctx, user: UserRow, q: number, _now: number): Promise<void> {
  const u = fresh(ctx, user)
  const text = ctx.texts.render('quiz.question', {
    k: q,
    text: ctx.texts.get(`quiz.q${q}`),
    low: ctx.texts.get(`quiz.q${q}.low`),
    high: ctx.texts.get(`quiz.q${q}.high`),
  })
  await ctx.send.raw(u, text, kbs(ctx).quizKb(q, q > 1))
}

/** Строки 45–46 §3.2: ответ на вопрос. */
export async function quizAnswer(
  ctx: Ctx,
  user: UserRow,
  q: number,
  value: number,
  now: number,
): Promise<void> {
  const u = fresh(ctx, user)
  // Кнопка из предыдущего сообщения: шаг уже пройден, второй ответ на него сдвинул
  // бы нумерацию и человек получил бы вопрос 3 дважды.
  if (q !== u.quiz_step) return
  if (value < 0 || value > 10) return

  ctx.repo.quiz.saveAnswer(u.id, u.run_no, 'after', q, value, now)

  if (q < QUIZ_QUESTIONS) {
    ctx.repo.users.update(u.id, { quiz_step: q + 1 })
    await askQuestion(ctx, fresh(ctx, u), q + 1, now)
    return
  }

  await finishQuiz(ctx, fresh(ctx, u), now)
}

/** Строка 47 §3.2: «Назад» — вернуться к предыдущему вопросу. */
export async function quizBack(ctx: Ctx, user: UserRow, q: number, now: number): Promise<void> {
  const u = fresh(ctx, user)
  if (q <= 1) return
  const prev = q - 1
  ctx.repo.quiz.deleteAnswer(u.id, u.run_no, 'after', prev)
  ctx.repo.users.update(u.id, { quiz_step: prev })
  await askQuestion(ctx, fresh(ctx, u), prev, now)
}

/** Результат: «Было 60. Стало 74.» + текст группы + обязательный дисклеймер. */
export async function finishQuiz(ctx: Ctx, user: UserRow, now: number): Promise<void> {
  const u = fresh(ctx, user)
  const sum = ctx.repo.quiz.sumOf(u.id, u.run_no, 'after')
  const index = quizIndex(sum)

  ctx.db.transaction(() => {
    ctx.repo.quiz.finishAfter(u.id, sum, now)
    ctx.repo.users.update(u.id, { state: 'completed', quiz_step: 0, quiz_resume_offered: 0 })
    ctx.repo.events.add(u.id, 'quiz_after_done', now, {
      sum,
      index,
      index_before: u.quiz_index,
    })
  })()

  const u2 = fresh(ctx, u)
  const parts = [
    ctx.texts.render('quiz.compare', { quiz_index: u.quiz_index ?? 0, quiz_index_after: index }),
    ctx.texts.get(quizResultKey(sum)),
    // Дисклеймер обязателен под любым результатом — и в боте тоже (§4 интеграции).
    ctx.texts.get('quiz.disclaimer'),
  ]
  await ctx.send.raw(u2, parts.join('\n\n'), homeKbFor(ctx, u2))
}

/** «Продолжить тест»: переспрашиваем текущий вопрос, а не предлагаем заново. */
export async function resumeQuiz(ctx: Ctx, user: UserRow, now: number): Promise<void> {
  const u = fresh(ctx, user)
  const q = Math.min(QUIZ_QUESTIONS, Math.max(1, u.quiz_step || 1))
  if (u.state !== 'quiz_after') ctx.repo.users.update(u.id, { state: 'quiz_after', quiz_step: q })
  await askQuestion(ctx, fresh(ctx, u), q, now)
}

/**
 * Строка 48 §3.2: человек бросил тест и написал что-то другое.
 * Мягко предлагаем продолжить — ровно один раз и не раньше чем через час, иначе
 * это превращается в преследование. Возвращает true, если предложение отправлено.
 */
export async function maybeOfferQuizResume(ctx: Ctx, user: UserRow, now: number): Promise<boolean> {
  const u = fresh(ctx, user)
  if (u.state !== 'quiz_after') return false
  if (u.quiz_resume_offered === 1) return false

  const rows = ctx.repo.quiz.rows(u.id, u.run_no, 'after')
  const lastAt = rows.reduce((max, r) => Math.max(max, r.created_at), 0)
  if (lastAt !== 0 && now - lastAt < RESUME_AFTER_SEC) return false

  const left = QUIZ_QUESTIONS - rows.length
  if (left <= 0) return false

  ctx.repo.users.update(u.id, { quiz_resume_offered: 1 })
  await ctx.send.text(
    fresh(ctx, u),
    'quiz.resume_offer',
    { ...commonVars(ctx, u, now), k: left },
    kbs(ctx).quizResumeKb(),
  )
  return true
}
