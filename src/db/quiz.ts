/**
 * Тест «Индекс внутренней опоры». docs/quiz-bot-integration.md.
 *
 * Входной замер приходит одной суммой в deep link (`?start=q42`) — поответных
 * данных с лендинга нет, он ничего не отправляет на сервер. Поэтому строки
 * quiz_answers с phase='before' появляются только у тех, кто проходил тест внутри
 * бота; админка обязана это учитывать и не показывать пустоту как ноль.
 *
 * Индекс считается из суммы, а не наоборот: границы результата в спецификации
 * заданы по сумме именно для того, чтобы округление не сдвигало группу.
 */

import type { Db } from './index.ts'
import { quizIndex } from './defaultTexts.ts'
import type { QuizAnswerRow, QuizPhase } from './types.ts'

export const QUIZ_QUESTIONS = 7
export const QUIZ_MAX_SUM = 70

export type QuizRepo = {
  /** Входной замер с лендинга. Не перезаписывает уже существующий (§2 интеграции). */
  setIncoming(userId: number, sum: number, at: number): boolean
  /** Новый круг программы: входным замером становится свежий индекс. */
  resetIncoming(userId: number, sum: number, at: number): void
  saveAnswer(userId: number, runNo: number, phase: QuizPhase, q: number, v: number, at: number): void
  deleteAnswer(userId: number, runNo: number, phase: QuizPhase, q: number): void
  /** Массив из 7 значений, индекс 0 = вопрос 1; не отвеченные — null. */
  answers(userId: number, runNo: number, phase: QuizPhase): Array<number | null>
  answeredCount(userId: number, runNo: number, phase: QuizPhase): number
  rows(userId: number, runNo: number, phase: QuizPhase): QuizAnswerRow[]
  sumOf(userId: number, runNo: number, phase: QuizPhase): number
  finishAfter(userId: number, sum: number, at: number): void
  decline(userId: number): void
}

export function createQuizRepo(db: Db): QuizRepo {
  const upsertAnswer = db.prepare(`
    INSERT INTO quiz_answers (user_id, run_no, phase, q, value, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, run_no, phase, q) DO UPDATE
      SET value = excluded.value, created_at = excluded.created_at
  `)

  const selAnswers = db.prepare(
    'SELECT * FROM quiz_answers WHERE user_id = ? AND run_no = ? AND phase = ? ORDER BY q',
  )

  return {
    // WHERE quiz_sum IS NULL — первый замер это точка отсчёта, и второй /start
    // с другим параметром не имеет права её сдвинуть.
    setIncoming(userId, sum, at) {
      return (
        db
          .prepare(`
            UPDATE users SET quiz_sum = ?, quiz_index = ?, quiz_at = ?, updated_at = ?
             WHERE id = ? AND quiz_sum IS NULL
          `)
          .run(sum, quizIndex(sum), at, at, userId).changes > 0
      )
    },

    resetIncoming(userId, sum, at) {
      db.prepare(`
        UPDATE users
           SET quiz_sum = ?, quiz_index = ?, quiz_at = ?,
               quiz_sum_after = NULL, quiz_index_after = NULL, quiz_after_at = NULL,
               quiz_after_declined = 0, quiz_step = 0, quiz_resume_offered = 0,
               updated_at = ?
         WHERE id = ?
      `).run(sum, quizIndex(sum), at, at, userId)
    },

    saveAnswer: (userId, runNo, phase, q, v, at) => void upsertAnswer.run(userId, runNo, phase, q, v, at),

    deleteAnswer: (userId, runNo, phase, q) =>
      void db
        .prepare('DELETE FROM quiz_answers WHERE user_id = ? AND run_no = ? AND phase = ? AND q = ?')
        .run(userId, runNo, phase, q),

    answers(userId, runNo, phase) {
      const out: Array<number | null> = new Array(QUIZ_QUESTIONS).fill(null)
      for (const r of selAnswers.all(userId, runNo, phase) as QuizAnswerRow[]) out[r.q - 1] = r.value
      return out
    },

    answeredCount: (userId, runNo, phase) =>
      (
        db
          .prepare('SELECT COUNT(*) AS n FROM quiz_answers WHERE user_id = ? AND run_no = ? AND phase = ?')
          .get(userId, runNo, phase) as { n: number }
      ).n,

    rows: (userId, runNo, phase) => selAnswers.all(userId, runNo, phase) as QuizAnswerRow[],

    sumOf: (userId, runNo, phase) =>
      (
        db
          .prepare(
            'SELECT COALESCE(SUM(value), 0) AS s FROM quiz_answers WHERE user_id = ? AND run_no = ? AND phase = ?',
          )
          .get(userId, runNo, phase) as { s: number }
      ).s,

    finishAfter(userId, sum, at) {
      db.prepare(`
        UPDATE users SET quiz_sum_after = ?, quiz_index_after = ?, quiz_after_at = ?, updated_at = ?
         WHERE id = ?
      `).run(sum, quizIndex(sum), at, at, userId)
    },

    decline: (userId) =>
      void db.prepare('UPDATE users SET quiz_after_declined = 1 WHERE id = ?').run(userId),
  }
}
