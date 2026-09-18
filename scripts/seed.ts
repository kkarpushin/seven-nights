/**
 * Засев базы: миграции + тексты + настройки + практики из файлов.
 *
 *   npm run seed
 *   npm run seed -- --db data/other.db
 *   npm run seed -- --reset-texts     # вернуть ВСЕ тексты к значениям по умолчанию
 *
 * Запускается сколько угодно раз. Правки владельца переживают запуск: тексты
 * возвращаются к умолчанию только по явному флагу, настройки — никогда, практики
 * с origin='admin' не трогаются вовсе.
 */

import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { loadDotenv, loadEnv, PROJECT_ROOT } from '../src/env.ts'
import { createLogger } from '../src/log.ts'
import { systemClock } from '../src/clock.ts'
import { openDb, schemaVersion } from '../src/db/index.ts'
import { createRepos } from '../src/ctx.ts'
import { createSettingsStore } from '../src/db/settings.ts'
import { seedSettings, seedTexts, syncPracticesFromDisk } from '../src/db/seed.ts'
import { DEFAULT_TEXTS } from '../src/db/defaultTexts.ts'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const has = (name: string): boolean => process.argv.includes(`--${name}`)

async function main(): Promise<void> {
  loadDotenv()
  // Токен и пароль засеву не нужны, но loadEnv на них ругается. Подставляем
  // безопасные значения только для отсутствующих: на живой машине .env полный,
  // а на чистой установке засев обязан работать до того, как заведён бот.
  const env = {
    ...process.env,
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '000000:seed-only-placeholder-token',
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'seed-only-placeholder',
  }
  const cfg = loadEnv(env)
  const log = createLogger({ level: cfg.logLevel })

  const dbArg = arg('db')
  const dbPath = dbArg ? (isAbsolute(dbArg) ? dbArg : resolve(PROJECT_ROOT, dbArg)) : cfg.dbPath
  const fresh = !existsSync(dbPath)

  const db = openDb(dbPath, { log })
  const repo = createRepos(db, systemClock)
  const settings = createSettingsStore(db, systemClock)
  const now = systemClock.now()

  const texts = seedTexts(repo.texts, now)
  if (has('reset-texts')) {
    for (const t of DEFAULT_TEXTS) repo.texts.reset(t.key, now)
  }
  const settingsCreated = seedSettings(settings, now, {
    // Список администраторов из .env попадает в настройки один раз; дальше он
    // правится в админке и объединяется с env при отправке (§2.4).
    ...(cfg.adminTgIds.length > 0 ? { admin_tg_ids: cfg.adminTgIds.join(',') } : {}),
  })

  const sync = syncPracticesFromDisk(repo.practices, {
    contentDir: cfg.contentDir,
    projectRoot: PROJECT_ROOT,
    now,
  })

  console.log('')
  console.log(`База:        ${dbPath}${fresh ? ' (создана заново)' : ''}`)
  console.log(`Схема:       версия ${schemaVersion(db)}`)
  console.log(`Тексты:      ${repo.texts.count()} ключей (новых ${texts.created}, сверено ${texts.updated})`)
  console.log(`Настройки:   ${Object.keys(settings.all()).length} ключей (новых ${settingsCreated})`)
  console.log(`Секрет демо: ${settings.str('demo_secret', '—')}  (команды /demo и /reset)`)
  console.log(
    `Практики:    ${repo.practices.listAll().length} (новых ${sync.added}, обновлено ${sync.updated}, с аудио ${sync.withAudio})`,
  )
  if (sync.missingAudio.length > 0) {
    console.log(`  без аудио: ${sync.missingAudio.join(', ')} — запусти npm run audio:generate`)
  }
  for (const e of sync.errors) console.log(`  ОШИБКА: ${e}`)
  console.log('')

  db.close()
  if (sync.errors.length > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
