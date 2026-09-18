/**
 * Прогрев кэша Telegram: отправляет практики в служебный чат и запоминает file_id.
 * §8.4 архитектуры, шаг 4 из §8.5.
 *
 *   npm run audio:upload                 # чат — первый из ADMIN_TG_IDS
 *   npm run audio:upload -- 123456789    # или явный chat_id
 *   npm run audio:upload -- --only sleep-landing
 *   npm run audio:upload -- --force      # перезалить даже те, где file_id уже есть
 *   npm run audio:upload -- --dry-run
 *
 * Зачем: первая живая отправка практики без кэша — это загрузка 9 МБ в Telegram
 * прямо в момент, когда человек лёг и ждёт. С прогретым file_id она мгновенна.
 * Запускать после каждой генерации озвучки и после смены токена бота (file_id
 * привязан к боту и от чужого токена не работает).
 */

import { existsSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { Bot, InputFile } from 'grammy'
import { loadDotenv, loadEnv, PROJECT_ROOT } from '../src/env.ts'
import { createLogger } from '../src/log.ts'
import { systemClock } from '../src/clock.ts'
import { openDb } from '../src/db/index.ts'
import { createPracticesRepo } from '../src/db/practices.ts'
import { audioMeta, PRODUCT_NAME } from '../src/content/audio.ts'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const has = (name: string): boolean => process.argv.includes(`--${name}`)

/** Первый позиционный аргумент — chat_id; флаги и их значения пропускаем. */
function positionalChatId(): string | undefined {
  const rest = process.argv.slice(2)
  for (let i = 0; i < rest.length; i++) {
    const v = rest[i]
    if (v.startsWith('--')) {
      if (v === '--only' || v === '--db' || v === '--chat') i++
      continue
    }
    return v
  }
  return undefined
}

async function main(): Promise<void> {
  loadDotenv()
  const cfg = loadEnv()
  const log = createLogger({ level: cfg.logLevel, secrets: [cfg.telegramBotToken] })

  const chatRaw = arg('chat') ?? positionalChatId() ?? String(cfg.adminTgIds[0] ?? '')
  const chatId = Number(chatRaw)
  if (!Number.isFinite(chatId) || chatId === 0) {
    console.error('Не задан чат: передай chat_id аргументом или заполни ADMIN_TG_IDS в .env')
    process.exitCode = 1
    return
  }

  const dbArg = arg('db')
  const dbPath = dbArg ? (isAbsolute(dbArg) ? dbArg : resolve(PROJECT_ROOT, dbArg)) : cfg.dbPath
  const db = openDb(dbPath, { log })
  const practices = createPracticesRepo(db, systemClock)

  const only = arg('only')
  const force = has('force')
  const dryRun = has('dry-run')

  const rows = practices.listAll().filter((p) => {
    if (only !== undefined && p.slug !== only) return false
    if (p.audio_path === null) return false
    return force || p.tg_file_id === null
  })

  console.log('')
  console.log(`Чат:      ${chatId}`)
  console.log(`База:     ${dbPath}`)
  console.log(`К заливке: ${rows.length} из ${practices.listAll().length}${dryRun ? ' (--dry-run)' : ''}`)

  if (rows.length === 0) {
    console.log('Нечего заливать. Кэш уже прогрет — или запусти с --force.')
    db.close()
    return
  }

  const bot = new Bot(cfg.telegramBotToken)
  let ok = 0
  let failed = 0

  for (const p of rows) {
    const abs = isAbsolute(p.audio_path as string)
      ? (p.audio_path as string)
      : resolve(PROJECT_ROOT, p.audio_path as string)
    if (!existsSync(abs)) {
      console.log(`  ✕ ${p.slug}: нет файла ${abs}`)
      failed++
      continue
    }
    const mb = (statSync(abs).size / 1024 / 1024).toFixed(1)
    if (dryRun) {
      console.log(`  · ${p.slug}: ${mb} МБ → залилось бы`)
      continue
    }

    try {
      const meta = audioMeta(p, null)
      const msg = await bot.api.sendAudio(chatId, new InputFile(abs), {
        title: meta.title,
        // В прогреве нет сессии, поэтому и номера вечера нет: в служебном чате
        // важен сам file_id, а исполнителя вечера подставит отправка человеку.
        performer: PRODUCT_NAME,
        duration: p.duration_sec ?? undefined,
        caption: `${p.slug} · ${p.category}`,
        disable_notification: true,
      })
      const a = msg.audio
      if (a === undefined) {
        console.log(`  ✕ ${p.slug}: Telegram не вернул audio`)
        failed++
        continue
      }
      practices.setFileId(p.id, a.file_id, a.file_unique_id)
      console.log(`  ✓ ${p.slug}: ${mb} МБ, file_id записан`)
      ok++
    } catch (err) {
      console.log(`  ✕ ${p.slug}: ${(err as Error).message}`)
      failed++
    }

    // Telegram ограничивает частоту отправок в один чат; девять файлов подряд
    // без паузы легко ловят 429, а ретраить здесь нечем — скрипт одноразовый.
    await systemClock.sleep(1500)
  }

  console.log('')
  console.log(`Готово: ${ok} залито, ${failed} с ошибкой`)
  db.close()
  if (failed > 0) process.exitCode = 1
}

await main()
