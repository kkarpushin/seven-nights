/**
 * Cookie-сессии админки. §6.1 архитектуры.
 *
 * Логина нет, пароль один — это инструмент для двух человек в tailnet. Токен
 * (32 случайных байта) и есть вся авторизация, поэтому он живёт только в базе:
 * список сессий можно посмотреть и оборвать, чего не даёт подписанная кука.
 *
 * last_seen обновляется не чаще раза в час — иначе каждый запрос дашборда стал бы
 * записью в базу, а WAL-файл рос бы от одного открытого окна админки.
 */

import type { Db } from './index.ts'
import type { AdminSessionRow } from './types.ts'

export const ADMIN_SESSION_TTL_SEC = 30 * 24 * 3600
const LAST_SEEN_THROTTLE_SEC = 3600

export type AdminSessionsRepo = {
  create(token: string, now: number, userAgent: string | null, ttlSec?: number): AdminSessionRow
  /** Возвращает сессию, только если она не истекла; заодно двигает last_seen. */
  touch(token: string, now: number): AdminSessionRow | undefined
  get(token: string): AdminSessionRow | undefined
  destroy(token: string): void
  purgeExpired(now: number): number
  list(): AdminSessionRow[]
}

export function createAdminSessionsRepo(db: Db): AdminSessionsRepo {
  const selOne = db.prepare('SELECT * FROM admin_sessions WHERE token = ?')

  return {
    create(token, now, userAgent, ttlSec = ADMIN_SESSION_TTL_SEC) {
      db.prepare(`
        INSERT INTO admin_sessions (token, created_at, expires_at, last_seen, user_agent)
        VALUES (?, ?, ?, ?, ?)
      `).run(token, now, now + ttlSec, now, userAgent)
      return selOne.get(token) as AdminSessionRow
    },

    touch(token, now) {
      const row = selOne.get(token) as AdminSessionRow | undefined
      if (!row || row.expires_at <= now) return undefined
      if (now - row.last_seen >= LAST_SEEN_THROTTLE_SEC) {
        db.prepare('UPDATE admin_sessions SET last_seen = ? WHERE token = ?').run(now, token)
      }
      return row
    },

    get: (token) => selOne.get(token) as AdminSessionRow | undefined,
    destroy: (token) => void db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(token),
    purgeExpired: (now) => db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').run(now).changes,
    list: () => db.prepare('SELECT * FROM admin_sessions ORDER BY last_seen DESC').all() as AdminSessionRow[],
  }
}
