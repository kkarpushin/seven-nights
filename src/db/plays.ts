/**
 * Репозиторий прослушиваний. §5.4 архитектуры.
 *
 * Единственный потребитель — правило выбора практики «меньше всего слушал» (§3.5
 * design-bot). Поэтому statsFor отдаёт сразу и счётчик, и время последнего раза:
 * при равном числе прослушиваний выбирается та, что звучала давнее.
 */

import type { Db } from './index.ts'
import type { Category, PlayRow } from './types.ts'

export type PlayStat = { practice_id: number; plays: number; last_at: number }

export type PlaysRepo = {
  add(userId: number, practiceId: number, sessionId: number | null, at: number): void
  statsFor(userId: number, category: Category): PlayStat[]
  countFor(userId: number): number
  listForUser(userId: number, limit?: number): PlayRow[]
}

export function createPlaysRepo(db: Db): PlaysRepo {
  const insert = db.prepare(
    'INSERT INTO plays (user_id, practice_id, session_id, played_at) VALUES (?, ?, ?, ?)',
  )

  // LEFT JOIN, а не JOIN: практика, которую человек ещё ни разу не слышал, обязана
  // попасть в выборку с plays = 0 — именно её правило и должно выбрать первой.
  const stats = db.prepare(`
    SELECT p.id AS practice_id,
           COUNT(pl.id)               AS plays,
           COALESCE(MAX(pl.played_at), 0) AS last_at
      FROM practices p
      LEFT JOIN plays pl ON pl.practice_id = p.id AND pl.user_id = ?
     WHERE p.active = 1 AND p.category = ?
     GROUP BY p.id
     ORDER BY plays ASC, last_at ASC, p.sort_order ASC, p.id ASC
  `)

  return {
    add: (userId, practiceId, sessionId, at) => void insert.run(userId, practiceId, sessionId, at),
    statsFor: (userId, category) => stats.all(userId, category) as PlayStat[],
    countFor: (userId) =>
      (db.prepare('SELECT COUNT(*) AS n FROM plays WHERE user_id = ?').get(userId) as { n: number }).n,
    listForUser: (userId, limit = 200) =>
      db.prepare('SELECT * FROM plays WHERE user_id = ? ORDER BY played_at DESC, id DESC LIMIT ?').all(
        userId, limit,
      ) as PlayRow[],
  }
}
