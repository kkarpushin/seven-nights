/**
 * Репозиторий практик. §5.4 архитектуры.
 *
 * Ключевое правило здесь одно: синк из файлов не имеет права затирать то, что
 * владелец поправил через админку. Поэтому upsertFromFile обновляет только строки
 * с origin='file'; как только практику тронули в админке, origin становится 'admin'
 * и файл на неё больше не влияет. Иначе один `npm run seed` молча откатил бы
 * загруженное специалистом аудио и переписанные две строки.
 */

import type { Clock } from '../clock.ts'
import { setClause, type Db } from './index.ts'
import type { Category, PracticeRow } from './types.ts'

const PATCHABLE: readonly (keyof PracticeRow & string)[] = [
  'category', 'title', 'line1', 'line2', 'audio_path', 'audio_sha256', 'audio_bytes',
  'duration_sec', 'tg_file_id', 'tg_file_unique_id', 'sort_order', 'active', 'script_hash',
]

export type UpsertFromFile = {
  slug: string
  category: Category
  title: string
  line1: string
  line2: string
  scriptHash: string
  now: number
  /** Используется только при создании строки: порядок, который уже задали, не трогаем. */
  sortOrder?: number
}

export type AudioInfo = { path: string; sha256: string; bytes: number; durationSec: number }

export type PracticesRepo = {
  byId(id: number): PracticeRow | undefined
  bySlug(slug: string): PracticeRow | undefined
  listActive(category?: Category): PracticeRow[]
  listAll(): PracticeRow[]
  /** true — строка создана, false — обновлена или пропущена как origin='admin'. */
  upsertFromFile(p: UpsertFromFile): boolean
  setAudio(id: number, a: AudioInfo): void
  setFileId(id: number, fileId: string, uniqueId: string | null): void
  clearFileId(id: number): void
  updateFromAdmin(id: number, patch: Partial<PracticeRow>): void
  create(p: Omit<PracticeRow, 'id' | 'created_at' | 'updated_at'>): PracticeRow
  reorder(order: Array<{ id: number; sort_order: number }>): void
  /** Для админки: сколько раз практику слушали. */
  listWithPlays(): Array<PracticeRow & { plays: number }>
  countActive(): number
}

export function createPracticesRepo(db: Db, clock: Clock): PracticesRepo {
  const selById = db.prepare('SELECT * FROM practices WHERE id = ?')
  const selBySlug = db.prepare('SELECT * FROM practices WHERE slug = ?')

  const insert = db.prepare(`
    INSERT INTO practices (slug, category, title, line1, line2, sort_order, active, origin,
                           script_hash, audio_path, audio_sha256, audio_bytes, duration_sec,
                           tg_file_id, tg_file_unique_id, created_at, updated_at)
    VALUES (@slug, @category, @title, @line1, @line2, @sort_order, @active, @origin,
            @script_hash, @audio_path, @audio_sha256, @audio_bytes, @duration_sec,
            @tg_file_id, @tg_file_unique_id, @created_at, @updated_at)
  `)

  // WHERE origin = 'file' — тот самый барьер, который защищает правки владельца.
  const updFromFile = db.prepare(`
    UPDATE practices
       SET category = ?, title = ?, line1 = ?, line2 = ?, script_hash = ?, updated_at = ?
     WHERE id = ? AND origin = 'file'
  `)

  const repo: PracticesRepo = {
    byId: (id) => selById.get(id) as PracticeRow | undefined,
    bySlug: (slug) => selBySlug.get(slug) as PracticeRow | undefined,

    listActive: (category) =>
      category === undefined
        ? (db.prepare('SELECT * FROM practices WHERE active = 1 ORDER BY sort_order, id').all() as PracticeRow[])
        : (db
            .prepare('SELECT * FROM practices WHERE active = 1 AND category = ? ORDER BY sort_order, id')
            .all(category) as PracticeRow[]),

    listAll: () => db.prepare('SELECT * FROM practices ORDER BY sort_order, id').all() as PracticeRow[],

    upsertFromFile(p) {
      const existing = selBySlug.get(p.slug) as PracticeRow | undefined
      if (!existing) {
        insert.run({
          slug: p.slug, category: p.category, title: p.title, line1: p.line1, line2: p.line2,
          sort_order: p.sortOrder ?? 100, active: 1, origin: 'file', script_hash: p.scriptHash,
          audio_path: null, audio_sha256: null, audio_bytes: null, duration_sec: null,
          tg_file_id: null, tg_file_unique_id: null, created_at: p.now, updated_at: p.now,
        })
        return true
      }
      updFromFile.run(p.category, p.title, p.line1, p.line2, p.scriptHash, p.now, existing.id)
      return false
    },

    // Сменился файл — сменился и tg_file_id: Telegram продолжил бы отдавать
    // старую запись по прежнему идентификатору, и человек услышал бы не то.
    setAudio(id, a) {
      const prev = selById.get(id) as PracticeRow | undefined
      const changed = prev?.audio_sha256 !== a.sha256
      db.prepare(`
        UPDATE practices
           SET audio_path = ?, audio_sha256 = ?, audio_bytes = ?, duration_sec = ?,
               tg_file_id = CASE WHEN ? THEN NULL ELSE tg_file_id END,
               tg_file_unique_id = CASE WHEN ? THEN NULL ELSE tg_file_unique_id END,
               updated_at = ?
         WHERE id = ?
      `).run(a.path, a.sha256, a.bytes, a.durationSec, changed ? 1 : 0, changed ? 1 : 0, clock.now(), id)
    },

    setFileId(id, fileId, uniqueId) {
      db.prepare('UPDATE practices SET tg_file_id = ?, tg_file_unique_id = ?, updated_at = ? WHERE id = ?').run(
        fileId, uniqueId, clock.now(), id,
      )
    },

    clearFileId(id) {
      db.prepare('UPDATE practices SET tg_file_id = NULL, tg_file_unique_id = NULL, updated_at = ? WHERE id = ?').run(
        clock.now(), id,
      )
    },

    updateFromAdmin(id, patch) {
      const { sql, values } = setClause(patch, PATCHABLE)
      if (sql === '') return
      db.prepare(`UPDATE practices SET ${sql}, origin = 'admin', updated_at = ? WHERE id = ?`).run(
        ...values, clock.now(), id,
      )
    },

    create(p) {
      const now = clock.now()
      const info = insert.run({
        slug: p.slug, category: p.category, title: p.title, line1: p.line1, line2: p.line2,
        sort_order: p.sort_order, active: p.active, origin: p.origin, script_hash: p.script_hash,
        audio_path: p.audio_path, audio_sha256: p.audio_sha256, audio_bytes: p.audio_bytes,
        duration_sec: p.duration_sec, tg_file_id: p.tg_file_id, tg_file_unique_id: p.tg_file_unique_id,
        created_at: now, updated_at: now,
      })
      return selById.get(Number(info.lastInsertRowid)) as PracticeRow
    },

    reorder(order) {
      const stmt = db.prepare('UPDATE practices SET sort_order = ?, updated_at = ? WHERE id = ?')
      const now = clock.now()
      db.transaction(() => {
        for (const o of order) stmt.run(o.sort_order, now, o.id)
      })()
    },

    listWithPlays: () =>
      db.prepare(`
        SELECT p.*, (SELECT COUNT(*) FROM plays pl WHERE pl.practice_id = p.id) AS plays
          FROM practices p
         ORDER BY p.sort_order, p.id
      `).all() as Array<PracticeRow & { plays: number }>,

    countActive: () => (db.prepare('SELECT COUNT(*) AS n FROM practices WHERE active = 1').get() as { n: number }).n,
  }

  return repo
}
