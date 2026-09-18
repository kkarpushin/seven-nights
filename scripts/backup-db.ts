/**
 * Снимок базы: VACUUM INTO data/backups/<unix>.db, храним 14 последних. §2.5.5.
 *
 * VACUUM INTO, а не копирование файла: при WAL рядом с базой лежат -wal и -shm,
 * и `cp seven-nights.db` даёт файл без последних транзакций — восстановление из
 * такого бэкапа тихо теряет вчерашний вечер. VACUUM INTO безопасен на работающем
 * процессе и отдаёт уже сжатый, консистентный файл.
 *
 *   npm run backup
 *   npm run backup -- --keep 30
 */

import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { loadDotenv, loadEnv, PROJECT_ROOT } from '../src/env.ts'
import { openDb, vacuumInto } from '../src/db/index.ts'

const KEEP_DEFAULT = 14

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function main(): void {
  loadDotenv()
  const cfg = loadEnv({
    ...process.env,
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '000000:backup-only-placeholder-token',
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'backup-only-placeholder',
  })

  const dbArg = arg('db')
  const dbPath = dbArg ? (isAbsolute(dbArg) ? dbArg : resolve(PROJECT_ROOT, dbArg)) : cfg.dbPath
  const dir = arg('out') ? resolve(PROJECT_ROOT, arg('out')!) : join(cfg.dataDir, 'backups')
  const keep = Number(arg('keep') ?? KEEP_DEFAULT)

  mkdirSync(dir, { recursive: true })
  const target = join(dir, `${Math.floor(Date.now() / 1000)}.db`)

  // migrate: false — бэкап не должен менять схему базы, которую он снимает.
  const db = openDb(dbPath, { migrate: false })
  try {
    vacuumInto(db, target)
  } finally {
    db.close()
  }

  const size = statSync(target).size
  console.log(`Снимок: ${target} (${(size / 1024 / 1024).toFixed(2)} МБ)`)

  // Ротация: имя файла — unix-время, поэтому лексикографический порядок и есть
  // хронологический до 2286 года.
  const backups = readdirSync(dir)
    .filter((f) => /^\d+\.db$/.test(f))
    .sort()
  const extra = backups.slice(0, Math.max(0, backups.length - keep))
  for (const f of extra) {
    rmSync(join(dir, f))
    console.log(`Удалён старый снимок: ${f}`)
  }
  console.log(`Хранится снимков: ${Math.min(backups.length, keep)} из ${keep}`)
}

try {
  main()
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
}
