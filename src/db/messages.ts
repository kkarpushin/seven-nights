/**
 * Свободные сообщения человека — то, что он написал словами вместо цифры.
 *
 * Это единственное место, где бот хранит человеческий текст, и именно ради него
 * в продукте есть специалист. Состояние на момент сообщения сохраняется рядом:
 * «написал в practicing» и «написал в paused» — два разных сигнала.
 */

import type { Db } from './index.ts'
import type { MessageRow, UserState } from './types.ts'

export type MessagesRepo = {
  add(userId: number, text: string, state: UserState, sessionId: number | null, at: number): number
  listForUser(userId: number, limit?: number): MessageRow[]
  recent(limit: number): MessageRow[]
  markNotified(id: number): void
  countForUser(userId: number): number
}

export function createMessagesRepo(db: Db): MessagesRepo {
  const insert = db.prepare(
    'INSERT INTO messages (user_id, text, at, state_at_moment, session_id) VALUES (?, ?, ?, ?, ?)',
  )

  return {
    add(userId, text, state, sessionId, at) {
      return Number(insert.run(userId, text, at, state, sessionId).lastInsertRowid)
    },
    listForUser: (userId, limit = 200) =>
      db.prepare('SELECT * FROM messages WHERE user_id = ? ORDER BY at DESC, id DESC LIMIT ?').all(
        userId, limit,
      ) as MessageRow[],
    recent: (limit) =>
      db.prepare('SELECT * FROM messages ORDER BY at DESC, id DESC LIMIT ?').all(limit) as MessageRow[],
    markNotified: (id) => void db.prepare('UPDATE messages SET notified = 1 WHERE id = ?').run(id),
    countForUser: (userId) =>
      (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE user_id = ?').get(userId) as { n: number }).n,
  }
}
