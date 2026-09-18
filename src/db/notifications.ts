/**
 * Очередь уведомлений владельцу. §2.2, §4.6 архитектуры.
 *
 * Уведомления вынесены из диалога в очередь по двум причинам. Первая: отправка
 * владельцу не должна задерживать ответ человеку и тем более ронять его шаг, если
 * у владельца что-то не так с чатом. Вторая: dedup_key с UNIQUE делает повтор
 * физически невозможным — «участник начал» не придёт дважды даже после рестарта
 * посреди транзакции.
 */

import type { Db } from './index.ts'
import type { NotificationRow } from './types.ts'

export type NotificationType = 'started' | 'finished' | 'silent' | 'blocked' | 'message' | 'no_practices'

export type EnqueueInput = {
  userId: number | null
  type: NotificationType | string
  dedupKey: string
  text: string
  now: number
}

export type NotificationsRepo = {
  /** false — такой dedup_key уже в очереди или отправлен. */
  enqueue(n: EnqueueInput): boolean
  pending(limit: number, maxAttempts?: number): NotificationRow[]
  markSent(id: number, at: number): void
  markFailed(id: number, error: string): void
  byId(id: number): NotificationRow | undefined
  listForUser(userId: number, limit?: number): NotificationRow[]
  countPending(): number
}

export function createNotificationsRepo(db: Db): NotificationsRepo {
  // INSERT OR IGNORE вместо «сначала SELECT, потом INSERT»: проверка и вставка в
  // одном операторе, без окна, в которое проскочит второй вызов.
  const insert = db.prepare(`
    INSERT OR IGNORE INTO notifications (user_id, type, dedup_key, text, created_at)
    VALUES (?, ?, ?, ?, ?)
  `)

  return {
    enqueue: (n) => insert.run(n.userId, n.type, n.dedupKey, n.text, n.now).changes > 0,

    pending: (limit, maxAttempts = 5) =>
      db
        .prepare(`
          SELECT * FROM notifications
           WHERE sent_at IS NULL AND attempts < ?
           ORDER BY created_at, id
           LIMIT ?
        `)
        .all(maxAttempts, limit) as NotificationRow[],

    markSent: (id, at) => void db.prepare('UPDATE notifications SET sent_at = ? WHERE id = ?').run(at, id),

    markFailed: (id, error) =>
      void db
        .prepare('UPDATE notifications SET attempts = attempts + 1, last_error = ? WHERE id = ?')
        .run(error.slice(0, 500), id),

    byId: (id) => db.prepare('SELECT * FROM notifications WHERE id = ?').get(id) as NotificationRow | undefined,

    listForUser: (userId, limit = 100) =>
      db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(
        userId, limit,
      ) as NotificationRow[],

    countPending: () =>
      (db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE sent_at IS NULL').get() as { n: number }).n,
  }
}
