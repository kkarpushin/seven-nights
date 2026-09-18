/**
 * Журнал событий. §2.3 архитектуры — закрытый список типов.
 *
 * События это не логи: по ним считается вся статистика ТЗ («сколько начали»,
 * «сколько дошли»), поэтому писать их надо в той же транзакции, что и изменение
 * состояния. Событие, записанное «потом», рано или поздно потеряется на падении
 * процесса — и цифра на дашборде разъедется с реальностью.
 */

import type { Db } from './index.ts'
import type { EventRow } from './types.ts'

export type EventType =
  | 'started' | 'evening_started' | 'practice_sent' | 'evening_done' | 'evening_skipped'
  | 'not_today' | 'now_done' | 'paused' | 'autopaused' | 'resumed' | 'finished' | 'day8'
  | 'restarted' | 'blocked' | 'unblocked' | 'quiz_in' | 'quiz_after_done' | 'hour_changed'
  | 'demo_on' | 'demo_off' | 'reset' | 'no_practices' | 'admin_message'

export const EVENT_TYPES: readonly EventType[] = [
  'started', 'evening_started', 'practice_sent', 'evening_done', 'evening_skipped',
  'not_today', 'now_done', 'paused', 'autopaused', 'resumed', 'finished', 'day8',
  'restarted', 'blocked', 'unblocked', 'quiz_in', 'quiz_after_done', 'hour_changed',
  'demo_on', 'demo_off', 'reset', 'no_practices', 'admin_message',
]

export type EventQuery = {
  type?: string
  userId?: number
  from?: number
  to?: number
  limit: number
  offset: number
}

export type EventsRepo = {
  add(userId: number | null, type: EventType | string, at: number, payload?: object, sessionId?: number | null): number
  listForUser(userId: number, limit?: number): EventRow[]
  list(q: EventQuery): EventRow[]
  recent(limit: number): EventRow[]
  countByType(type: string, from?: number, to?: number): number
}

export function createEventsRepo(db: Db): EventsRepo {
  const insert = db.prepare(
    'INSERT INTO events (user_id, type, at, session_id, payload) VALUES (?, ?, ?, ?, ?)',
  )

  return {
    add(userId, type, at, payload, sessionId = null) {
      const info = insert.run(userId, type, at, sessionId, JSON.stringify(payload ?? {}))
      return Number(info.lastInsertRowid)
    },

    listForUser: (userId, limit = 500) =>
      db.prepare('SELECT * FROM events WHERE user_id = ? ORDER BY at DESC, id DESC LIMIT ?').all(
        userId, limit,
      ) as EventRow[],

    list(q) {
      const where: string[] = []
      const args: unknown[] = []
      if (q.type) {
        where.push('type = ?')
        args.push(q.type)
      }
      if (q.userId !== undefined) {
        where.push('user_id = ?')
        args.push(q.userId)
      }
      if (q.from !== undefined) {
        where.push('at >= ?')
        args.push(q.from)
      }
      if (q.to !== undefined) {
        where.push('at <= ?')
        args.push(q.to)
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
      return db
        .prepare(`SELECT * FROM events ${whereSql} ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`)
        .all(...args, q.limit, q.offset) as EventRow[]
    },

    recent: (limit) =>
      db.prepare('SELECT * FROM events ORDER BY at DESC, id DESC LIMIT ?').all(limit) as EventRow[],

    countByType: (type, from = 0, to = Number.MAX_SAFE_INTEGER) =>
      (
        db.prepare('SELECT COUNT(*) AS n FROM events WHERE type = ? AND at BETWEEN ? AND ?').get(type, from, to) as {
          n: number
        }
      ).n,
  }
}
