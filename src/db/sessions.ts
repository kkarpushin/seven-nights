/**
 * Репозиторий сессий. §5.4 архитектуры.
 *
 * Все «шаговые» методы (setBefore, setCategory, markPracticeSent, setAfter) — условные
 * UPDATE с проверкой шага прямо в WHERE, и возвращают false, если шаг уже сделан.
 * Это четвёртый рубеж защиты из §4.4: дабл-тап по категории физически не может
 * выдать две практики, потому что второй UPDATE не найдёт строку с category IS NULL.
 *
 * Указатель users.active_session_id ведётся здесь же: open() ставит, close() и
 * deleteSession() снимают. Если бы это делал вызывающий код, рано или поздно
 * какая-нибудь ветка про него забыла бы, и у человека осталась бы «висящая» сессия.
 */

import type { Clock } from '../clock.ts'
import type { Db } from './index.ts'
import type { AfterSource, Category, SessionKind, SessionRow, SessionStatus } from './types.ts'

export type OpenSessionInput = {
  userId: number
  runNo: number
  kind: SessionKind
  eveningNo: number | null
  ritualDate: string
  now: number
}

export type SessionsRepo = {
  active(userId: number): SessionRow | undefined
  byId(id: number): SessionRow | undefined
  open(input: OpenSessionInput): SessionRow
  setBefore(id: number, value: number, at: number): boolean
  setCategory(id: number, category: Category, practiceId: number): boolean
  markPracticeSent(id: number, msgId: number, at: number): boolean
  setAfter(id: number, value: number, source: AfterSource, at: number): boolean
  close(id: number, status: SessionStatus, at: number): void
  setPromptSent(id: number, at: number | null, msgId?: number | null): void
  setChoiceMsg(id: number, msgId: number): void
  setNudged(id: number): void
  countedOn(userId: number, ritualDate: string): boolean
  runSessions(userId: number, runNo: number): SessionRow[]
  listForUser(userId: number, limit?: number): SessionRow[]
  deleteSession(id: number): void
  /** Recovery-проход §4.5: все сессии в статусе active. */
  allActive(): SessionRow[]
}

export function createSessionsRepo(db: Db, clock: Clock): SessionsRepo {
  const selById = db.prepare('SELECT * FROM sessions WHERE id = ?')
  const selActive = db.prepare(`SELECT * FROM sessions WHERE user_id = ? AND status = 'active'`)

  const insert = db.prepare(`
    INSERT INTO sessions (user_id, run_no, kind, evening_no, ritual_date, status, created_at)
    VALUES (@userId, @runNo, @kind, @eveningNo, @ritualDate, 'active', @now)
  `)

  const stmtBefore = db.prepare(`
    UPDATE sessions SET before_value = ?, before_at = ?
     WHERE id = ? AND before_value IS NULL AND status = 'active'
  `)

  const stmtCategory = db.prepare(`
    UPDATE sessions SET category = ?, practice_id = ?
     WHERE id = ? AND category IS NULL AND status = 'active'
  `)

  const stmtPracticeSent = db.prepare(`
    UPDATE sessions SET practice_msg_id = ?, practice_sent_at = ?
     WHERE id = ? AND practice_sent_at IS NULL
  `)

  const stmtAfter = db.prepare(`
    UPDATE sessions SET after_value = ?, after_source = ?, after_at = ?
     WHERE id = ? AND after_value IS NULL
  `)

  const stmtClose = db.prepare('UPDATE sessions SET status = ?, closed_at = ? WHERE id = ?')
  const stmtUnlink = db.prepare('UPDATE users SET active_session_id = NULL, updated_at = ? WHERE active_session_id = ?')

  const repo: SessionsRepo = {
    active: (userId) => selActive.get(userId) as SessionRow | undefined,
    byId: (id) => selById.get(id) as SessionRow | undefined,

    open(input) {
      return db.transaction(() => {
        const info = insert.run(input)
        const id = Number(info.lastInsertRowid)
        db.prepare('UPDATE users SET active_session_id = ?, updated_at = ? WHERE id = ?').run(
          id,
          input.now,
          input.userId,
        )
        return selById.get(id) as SessionRow
      })()
    },

    setBefore: (id, value, at) => stmtBefore.run(value, at, id).changes > 0,
    setCategory: (id, category, practiceId) => stmtCategory.run(category, practiceId, id).changes > 0,
    markPracticeSent: (id, msgId, at) => stmtPracticeSent.run(msgId, at, id).changes > 0,
    setAfter: (id, value, source, at) => stmtAfter.run(value, source, at, id).changes > 0,

    close(id, status, at) {
      db.transaction(() => {
        stmtClose.run(status, at, id)
        stmtUnlink.run(clock.now(), id)
      })()
    },

    // prompt_sent_at пишется ДО вызова Telegram и сбрасывается в NULL при сетевой
    // ошибке — второй рубеж §4.4. Поэтому метод обязан уметь писать и NULL.
    setPromptSent(id, at, msgId) {
      if (msgId === undefined) {
        db.prepare('UPDATE sessions SET prompt_sent_at = ? WHERE id = ?').run(at, id)
      } else {
        db.prepare('UPDATE sessions SET prompt_sent_at = ?, prompt_msg_id = ? WHERE id = ?').run(at, msgId, id)
      }
    },

    setChoiceMsg(id, msgId) {
      db.prepare('UPDATE sessions SET choice_msg_id = ? WHERE id = ?').run(msgId, id)
    },

    setNudged(id) {
      db.prepare('UPDATE sessions SET nudged = 1 WHERE id = ?').run(id)
    },

    countedOn(userId, ritualDate) {
      const row = db
        .prepare(`
          SELECT 1 FROM sessions
           WHERE user_id = ? AND ritual_date = ? AND kind = 'evening' AND practice_sent_at IS NOT NULL
           LIMIT 1
        `)
        .get(userId, ritualDate)
      return row !== undefined
    },

    runSessions: (userId, runNo) =>
      db
        .prepare(`
          SELECT * FROM sessions
           WHERE user_id = ? AND run_no = ? AND kind = 'evening'
           ORDER BY evening_no, id
        `)
        .all(userId, runNo) as SessionRow[],

    listForUser: (userId, limit = 200) =>
      db.prepare('SELECT * FROM sessions WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(
        userId,
        limit,
      ) as SessionRow[],

    // Удаляем только сессии kind='now', протухшие по таймауту: пустая сессия «сейчас»
    // в статистике «практик сейчас» выглядела бы как состоявшаяся.
    deleteSession(id) {
      db.transaction(() => {
        stmtUnlink.run(clock.now(), id)
        db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
      })()
    },

    allActive: () => db.prepare(`SELECT * FROM sessions WHERE status = 'active' ORDER BY id`).all() as SessionRow[],
  }

  return repo
}
