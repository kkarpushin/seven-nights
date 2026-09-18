/**
 * Репозиторий людей. §5.4 архитектуры.
 *
 * Здесь живёт единственная операция, от которой зависит, не придёт ли человеку
 * две практики за вечер, — claimDue(). Планировщик не «читает и делает», а сначала
 * забирает задачу условным UPDATE по значению due_at: если значение уже сменилось
 * (пользователь ответил сам, второй процесс успел раньше), changes = 0 и работа
 * не выполняется вовсе.
 */

import type { Clock } from '../clock.ts'
import { fmtTz } from '../time.ts'
import { setClause, type Db } from './index.ts'
import type { AdminUserQuery, AdminUserRow, DueKind, UserRow, UserState } from './types.ts'

/** Колонки, которые разрешено менять патчем. id/tg_id/created_at — не разрешено. */
const PATCHABLE: readonly (keyof UserRow & string)[] = [
  'language_code', 'tz_offset_min', 'evening_time', 'state', 'state_before_now', 'state_before_block',
  'due_at', 'due_kind', 'due_attempts', 'active_session_id', 'run_no', 'current_evening',
  'consecutive_skips', 'not_today_streak', 'day8_sent', 'demo', 'demo_day_counter',
  'quiz_sum', 'quiz_index', 'quiz_at', 'quiz_sum_after', 'quiz_index_after', 'quiz_after_at',
  'quiz_after_declined', 'quiz_step', 'quiz_resume_offered', 'start_payload', 'last_seen_at',
  'silent_notified_for', 'paused_at', 'blocked_at', 'completed_at',
]

export type Due = { at: number | null; kind: DueKind | null }

export type UsersRepo = {
  byTgId(tgId: number): UserRow | undefined
  byId(id: number): UserRow | undefined
  create(tgId: number, langCode: string | null, now: number, init?: Partial<UserRow>): UserRow
  update(id: number, patch: Partial<UserRow>): void
  setState(id: number, state: UserState, due: Due): void
  /** Оптимистичный захват таймера планировщиком: true, если due_at совпал и сдвинут. */
  claimDue(id: number, seenDueAt: number, parkUntil: number): boolean
  clearDue(id: number): void
  setDue(id: number, due: Due): void
  due(now: number, limit: number): UserRow[]
  touchSeen(id: number, now: number): void
  listForAdmin(q: AdminUserQuery): { rows: AdminUserRow[]; total: number; page: number; per: number }
  deleteCascade(id: number): void
  countAll(includeDemo?: boolean): number
  /** Все активные сессии рассинхронизировались — recovery-проход §4.5. */
  withActiveSession(): UserRow[]
}

export function createUsersRepo(db: Db, clock: Clock): UsersRepo {
  const selById = db.prepare('SELECT * FROM users WHERE id = ?')
  const selByTg = db.prepare('SELECT * FROM users WHERE tg_id = ?')

  const insert = db.prepare(`
    INSERT INTO users (tg_id, language_code, created_at, updated_at, last_seen_at)
    VALUES (@tg_id, @language_code, @now, @now, @now)
  `)

  const selDue = db.prepare(`
    SELECT * FROM users
     WHERE due_at IS NOT NULL AND due_at <= ? AND state <> 'blocked'
     ORDER BY due_at
     LIMIT ?
  `)

  const stmtSetState = db.prepare(`
    UPDATE users
       SET state = ?, due_at = ?, due_kind = ?, due_attempts = 0, updated_at = ?
     WHERE id = ?
  `)

  const stmtClaim = db.prepare(`
    UPDATE users
       SET due_at = ?, due_attempts = due_attempts + 1, updated_at = ?
     WHERE id = ? AND due_at = ?
  `)

  const stmtSetDue = db.prepare(`
    UPDATE users SET due_at = ?, due_kind = ?, due_attempts = 0, updated_at = ? WHERE id = ?
  `)

  const stmtTouch = db.prepare(`
    UPDATE users SET last_seen_at = ?, silent_notified_for = NULL, updated_at = ? WHERE id = ?
  `)

  const repo: UsersRepo = {
    byTgId: (tgId) => selByTg.get(tgId) as UserRow | undefined,
    byId: (id) => selById.get(id) as UserRow | undefined,

    create(tgId, langCode, now, init) {
      const info = insert.run({ tg_id: tgId, language_code: langCode, now })
      const id = Number(info.lastInsertRowid)
      if (init && Object.keys(init).length > 0) repo.update(id, init)
      return selById.get(id) as UserRow
    },

    update(id, patch) {
      const { sql, values } = setClause(patch, PATCHABLE)
      if (sql === '') return
      db.prepare(`UPDATE users SET ${sql}, updated_at = ? WHERE id = ?`).run(...values, clock.now(), id)
    },

    // Смена состояния всегда сбрасывает due_attempts: раз мы дошли до записи нового
    // состояния, предыдущая задача отработала, и счётчик неудач больше не про неё.
    setState(id, state, due) {
      stmtSetState.run(state, due.at, due.kind, clock.now(), id)
    },

    claimDue(id, seenDueAt, parkUntil) {
      return stmtClaim.run(parkUntil, clock.now(), id, seenDueAt).changes > 0
    },

    clearDue(id) {
      stmtSetDue.run(null, null, clock.now(), id)
    },

    setDue(id, due) {
      stmtSetDue.run(due.at, due.kind, clock.now(), id)
    },

    due: (now, limit) => selDue.all(now, limit) as UserRow[],

    // Сброс silent_notified_for — часть «человек вернулся»: следующая серия
    // молчания должна уметь дать уведомление заново (§4.6).
    touchSeen(id, now) {
      stmtTouch.run(now, now, id)
    },

    listForAdmin(q) {
      const page = Math.max(1, q.page ?? 1)
      const per = Math.min(200, Math.max(1, q.per ?? 50))
      const now = q.now ?? clock.now()
      const where: string[] = []
      const args: unknown[] = []

      if (!q.includeDemo) where.push('u.demo = 0')
      if (q.state) {
        where.push('u.state = ?')
        args.push(q.state)
      }
      const needle = (q.q ?? '').trim()
      if (needle !== '') {
        const digits = needle.replace(/^#/, '')
        if (/^\d+$/.test(digits)) {
          where.push(needle.startsWith('#') ? 'u.id = ?' : '(u.tg_id = ? OR u.id = ?)')
          args.push(Number(digits))
          if (!needle.startsWith('#')) args.push(Number(digits))
        } else {
          where.push('1 = 0') // не число — искать нечего: имён мы не храним
        }
      }
      switch (q.segment) {
        case 'active':
          where.push("u.state IN ('idle','awaiting_before','awaiting_state','practicing','awaiting_after')")
          break
        case 'finished':
          where.push("u.state = 'completed'")
          break
        case 'paused':
          where.push("u.state = 'paused'")
          break
        case 'blocked':
          where.push("u.state = 'blocked'")
          break
        case 'stuck':
          where.push(
            "u.current_evening BETWEEN 1 AND 6 AND u.state <> 'completed' " +
              'AND (u.last_seen_at IS NULL OR u.last_seen_at < ?)',
          )
          args.push(now - 7 * 86400)
          break
        default:
          break
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

      const sortCol =
        q.sort === 'created' ? 'u.created_at' : q.sort === 'evening' ? 'u.current_evening' : 'u.last_seen_at'
      const dir = q.dir === 'asc' ? 'ASC' : 'DESC'

      const total = (
        db.prepare(`SELECT COUNT(*) AS n FROM users u ${whereSql}`).get(...args) as { n: number }
      ).n

      const rows = db
        .prepare(`
          SELECT u.id, u.tg_id, u.state, u.run_no, u.current_evening, u.evening_time, u.tz_offset_min,
                 u.quiz_index, u.quiz_index_after, u.demo, u.created_at, u.last_seen_at, u.completed_at,
                 (SELECT s.before_value FROM sessions s
                   WHERE s.user_id = u.id AND s.run_no = u.run_no AND s.kind = 'evening'
                     AND s.before_value IS NOT NULL
                   ORDER BY s.evening_no ASC LIMIT 1)                                   AS first_before,
                 (SELECT s.after_value FROM sessions s
                   WHERE s.user_id = u.id AND s.run_no = u.run_no AND s.kind = 'evening'
                     AND s.after_value IS NOT NULL
                   ORDER BY s.evening_no DESC LIMIT 1)                                  AS last_after,
                 (SELECT COUNT(*) FROM sessions s
                   WHERE s.user_id = u.id AND s.run_no = u.run_no AND s.kind = 'evening'
                     AND s.status = 'done')                                             AS sessions_done,
                 (SELECT COUNT(*) FROM sessions s
                   WHERE s.user_id = u.id AND s.run_no = u.run_no AND s.kind = 'evening'
                     AND s.status IN ('abandoned','declined'))                          AS skips
            FROM users u
            ${whereSql}
           ORDER BY ${sortCol} ${dir} NULLS LAST, u.id DESC
           LIMIT ? OFFSET ?
        `)
        .all(...args, per, (page - 1) * per) as Array<
        Omit<AdminUserRow, 'tz' | 'delta'> & { tz_offset_min: number }
      >

      return {
        rows: rows.map((r) => {
          const { tz_offset_min, ...rest } = r
          return {
            ...rest,
            tz: fmtTz(tz_offset_min),
            delta: r.first_before !== null && r.last_after !== null ? r.last_after - r.first_before : null,
          }
        }),
        total,
        page,
        per,
      }
    },

    // users.active_session_id ссылается на sessions, а sessions.user_id — обратно на
    // users с CASCADE. Обнуляем указатель первым, чтобы удаление не упёрлось в ссылку.
    deleteCascade(id) {
      db.transaction(() => {
        db.prepare('UPDATE users SET active_session_id = NULL WHERE id = ?').run(id)
        db.prepare('DELETE FROM users WHERE id = ?').run(id)
      })()
    },

    countAll(includeDemo = false) {
      const sql = includeDemo ? 'SELECT COUNT(*) AS n FROM users' : 'SELECT COUNT(*) AS n FROM users WHERE demo = 0'
      return (db.prepare(sql).get() as { n: number }).n
    },

    withActiveSession: () => db.prepare('SELECT * FROM users WHERE active_session_id IS NOT NULL').all() as UserRow[],
  }

  return repo
}
