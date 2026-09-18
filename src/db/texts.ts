/**
 * Репозиторий текстов. Таблица texts — единственный источник слов, которые видит
 * человек: в коде допустимы только ключи (§1 архитектуры).
 *
 * Пара value / default_value расходится ровно в момент первой правки в админке.
 * value — то, что отправляется; default_value — «как было», кнопка возврата.
 * Поэтому seed НЕ переписывает value у уже существующих ключей: иначе обновление
 * кода откатывало бы формулировки, которые владелец правил под себя.
 */

import type { Clock } from '../clock.ts'
import type { Db } from './index.ts'
import type { TextRow } from './types.ts'

export type TextAdminRow = TextRow & {
  /** Текст правили в админке — значит, кнопка «вернуть как было» имеет смысл. */
  changed: boolean
  placeholder_list: string[]
}

export type TextUpsert = {
  key: string
  value: string
  placeholders: string[]
  section: string
  hint: string
}

export type TextsRepo = {
  get(key: string): string | undefined
  row(key: string): TextRow | undefined
  all(): TextRow[]
  /** Карта ключ → значение: бот держит её в памяти и перечитывает по reload(). */
  map(): Map<string, string>
  listForAdmin(): TextAdminRow[]
  set(key: string, value: string, now: number): TextRow | undefined
  reset(key: string, now: number): TextRow | undefined
  /**
   * Засев одного ключа. Значение по умолчанию всегда актуализируется, а value
   * ставится только при создании строки — см. комментарий в шапке файла.
   */
  seedDefault(t: TextUpsert, now: number): 'created' | 'updated'
  count(): number
}

/** Разбор JSON-колонки placeholders. Битый JSON не должен ронять админку. */
export function parsePlaceholders(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function createTextsRepo(db: Db, clock: Clock): TextsRepo {
  const selOne = db.prepare('SELECT * FROM texts WHERE key = ?')
  const selAll = db.prepare('SELECT * FROM texts ORDER BY section, key')

  const insert = db.prepare(`
    INSERT INTO texts (key, value, default_value, placeholders, section, hint, updated_at)
    VALUES (@key, @value, @default_value, @placeholders, @section, @hint, @updated_at)
  `)

  const updDefault = db.prepare(`
    UPDATE texts SET default_value = ?, placeholders = ?, section = ?, hint = ?, updated_at = ?
     WHERE key = ?
  `)

  const repo: TextsRepo = {
    get: (key) => (selOne.get(key) as TextRow | undefined)?.value,
    row: (key) => selOne.get(key) as TextRow | undefined,
    all: () => selAll.all() as TextRow[],

    map() {
      const m = new Map<string, string>()
      for (const r of selAll.all() as TextRow[]) m.set(r.key, r.value)
      return m
    },

    listForAdmin: () =>
      (selAll.all() as TextRow[]).map((r) => ({
        ...r,
        changed: r.value !== r.default_value,
        placeholder_list: parsePlaceholders(r.placeholders),
      })),

    set(key, value, now) {
      db.prepare('UPDATE texts SET value = ?, updated_at = ? WHERE key = ?').run(value, now, key)
      return selOne.get(key) as TextRow | undefined
    },

    reset(key, now) {
      db.prepare('UPDATE texts SET value = default_value, updated_at = ? WHERE key = ?').run(now, key)
      return selOne.get(key) as TextRow | undefined
    },

    seedDefault(t, now) {
      const placeholders = JSON.stringify(t.placeholders)
      const existing = selOne.get(t.key) as TextRow | undefined
      if (!existing) {
        insert.run({
          key: t.key, value: t.value, default_value: t.value,
          placeholders, section: t.section, hint: t.hint, updated_at: now,
        })
        return 'created'
      }
      updDefault.run(t.value, placeholders, t.section, t.hint, now, t.key)
      return 'updated'
    },

    count: () => (db.prepare('SELECT COUNT(*) AS n FROM texts').get() as { n: number }).n,
  }

  return repo
}
