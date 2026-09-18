/**
 * Соединение с SQLite и миграции. §2.1, §2.5 архитектуры.
 *
 * better-sqlite3 синхронен: внутри db.transaction(...) не может быть ни одного await.
 * Это не ограничение библиотеки, а свойство, на котором держится вся защита от
 * дублей (§4.4): «проверить шаг и записать» выполняется целиком, без окна, в котором
 * второй тап успел бы проскочить.
 */

import Database from 'better-sqlite3'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Logger } from '../log.ts'

export type Db = Database.Database

export const MIGRATIONS_DIR = join(import.meta.dirname, 'migrations')

/**
 * PRAGMA по §2.1. Ставятся на КАЖДОМ соединении: journal_mode живёт в файле,
 * а foreign_keys — нет, и про это забывают. Без него ON DELETE CASCADE просто
 * не работает, и удаление человека оставляет сироты в sessions.
 */
export function applyPragmas(db: Db): void {
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  db.pragma('temp_store = MEMORY')
}

export type OpenDbOptions = {
  migrationsDir?: string
  /** false — открыть как есть (для backup-скрипта и тестов на «сырой» базе). */
  migrate?: boolean
  log?: Logger
  readonly?: boolean
}

export function openDb(path: string, opts: OpenDbOptions = {}): Db {
  if (path !== ':memory:' && !path.startsWith('file:')) {
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }
  const db = new Database(path, { readonly: opts.readonly ?? false })
  applyPragmas(db)
  if (opts.migrate !== false) applyMigrations(db, opts.migrationsDir ?? MIGRATIONS_DIR, opts.log)
  return db
}

export type Migration = { version: number; name: string; file: string }

/** Файлы вида 001_init.sql; номер в имени и есть версия. */
export function listMigrations(dir: string): Migration[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => {
      const m = /^(\d+)[_-](.+)\.sql$/.exec(f)
      if (!m) throw new Error(`Файл миграции «${f}» назван не по правилу <номер>_<имя>.sql`)
      return { version: Number(m[1]), name: m[2], file: join(dir, f) }
    })
    .sort((a, b) => a.version - b.version)
}

function appliedVersions(db: Db): Set<number> {
  // Таблицу schema_migrations создаёт сама первая миграция (она есть в §2.2 DDL
  // дословно). Поэтому до первого применения её просто нет — это не ошибка.
  const exists = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'`)
    .get()
  if (!exists) return new Set()
  const rows = db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>
  return new Set(rows.map((r) => r.version))
}

/** Применяет недостающие миграции по возрастанию номера. Возвращает применённые версии. */
export function applyMigrations(db: Db, dir: string = MIGRATIONS_DIR, log?: Logger): number[] {
  const done = appliedVersions(db)
  const applied: number[] = []
  for (const m of listMigrations(dir)) {
    if (done.has(m.version)) continue
    const sql = readFileSync(m.file, 'utf8')
    // Каждая миграция — одна транзакция: либо схема шагнула целиком, либо не шагнула.
    // exec() умеет несколько операторов, поэтому BEGIN/COMMIT пишем руками.
    db.exec('BEGIN')
    try {
      db.exec(sql)
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        m.version,
        Math.floor(Date.now() / 1000),
      )
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw new Error(`Миграция ${m.version} (${m.name}) не применилась: ${(err as Error).message}`, { cause: err })
    }
    applied.push(m.version)
    log?.info('migration applied', { version: m.version, name: m.name })
  }
  return applied
}

export function schemaVersion(db: Db): number {
  const versions = appliedVersions(db)
  return versions.size === 0 ? 0 : Math.max(...versions)
}

/**
 * Транзакция вокруг синхронного куска. Внутри fn не должно быть await — better-sqlite3
 * его не увидит и закоммитит раньше, чем закончится работа.
 * Вложенные вызовы безопасны: better-sqlite3 сам разворачивает их в SAVEPOINT.
 */
export function tx<T>(db: Db, fn: () => T): T {
  return db.transaction(fn)()
}

/**
 * Сборка частичного UPDATE из объекта-патча.
 * Белый список колонок обязателен: патч приходит в том числе из админки, и без
 * него PATCH с полем `id` или `created_at` переписал бы то, что переписывать нельзя.
 */
export function setClause<T extends object>(
  patch: Partial<T>,
  allowed: readonly (keyof T & string)[],
): { sql: string; values: unknown[] } {
  const parts: string[] = []
  const values: unknown[] = []
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue
    const v = (patch as Record<string, unknown>)[key]
    if (v === undefined) continue
    parts.push(`${key} = ?`)
    values.push(v === null ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v)
  }
  return { sql: parts.join(', '), values }
}

/** VACUUM INTO — снимок базы без остановки процесса, безопасен при WAL. */
export function vacuumInto(db: Db, targetPath: string): void {
  db.prepare('VACUUM INTO ?').run(targetPath)
}

/** Размер базы в байтах по служебным PRAGMA (для /api/admin/me). */
export function dbSizeBytes(db: Db): number {
  const pageCount = db.pragma('page_count', { simple: true }) as number
  const pageSize = db.pragma('page_size', { simple: true }) as number
  return pageCount * pageSize
}
