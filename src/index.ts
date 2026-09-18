/**
 * Точка входа. §1 и §10.3 архитектуры.
 *
 * Один процесс делает три вещи сразу: держит long polling Telegram, тикает
 * планировщиком раз в тридцать секунд и отдаёт HTTP (лендинг, админка, /healthz).
 * Разделять их не на чем и незачем: состояние целиком в SQLite, а long polling
 * обязан быть ровно один — два экземпляра получают от Telegram 409 Conflict.
 *
 * Порядок сборки жёсткий, каждый шаг зависит от предыдущего:
 *   окружение → логгер → база и миграции → тексты, настройки, контент →
 *   бот (он же подключает к Ctx texts и send) → HTTP → восстановление →
 *   планировщик → long polling.
 * Бот собирается раньше планировщика потому, что планировщик отправляет сообщения
 * через ctx.send, а его на место ставит createBot (§5.1). HTTP поднимается раньше
 * планировщика и polling потому, что занятый порт — это замок от второго экземпляра
 * (§10.4): проигравший должен уйти, не отправив никому ни одного сообщения.
 *
 * Остановка — по SIGTERM (systemd) и SIGINT (запуск руками). Порядок обратный:
 * сначала перестаём принимать новое, потом дорабатываем начатое, потом закрываем базу.
 */

import { loadDotenv, loadEnv } from './env.ts'
import { createLogger } from './log.ts'
import { systemClock } from './clock.ts'
import { createCtx } from './ctx.ts'
import { schemaVersion } from './db/index.ts'
import { seedSettings, seedTexts } from './db/seed.ts'
import { createTexts } from './texts.ts'
import { syncPracticesFromFiles } from './content/practices.ts'
import { configureBotProfile, createBot } from './bot/index.ts'
import * as flow from './bot/flow.ts'
import { recoverOnStart, startScheduler, type SchedulerHandle } from './scheduler/index.ts'
import { startHttp } from './http/server.ts'

/**
 * Имя процесса задаём сами. `pgrep -f index.ts` находит половину машины — по этому
 * имени сервис ищется и останавливается точно. Значение приходит из юнита
 * (Environment=PROCESS_TITLE), чтобы запуск руками не путали с systemd-сервисом.
 */
process.title = process.env.PROCESS_TITLE?.trim() || 'seven-nights'

/** Сколько ждём корректной остановки, прежде чем выйти силой (в юните TimeoutStopSec=20). */
const SHUTDOWN_TIMEOUT_MS = 15_000

async function main(): Promise<void> {
  loadDotenv()

  // Вся арифметика дат идёт от tz_offset_min пользователя (§4.3). Пояс машины не
  // должен участвовать нигде: на сервере в другом поясе иначе поедет ритуальная
  // дата, и человек получит вечер не в свой день — молча, без единой ошибки в логе.
  if (!process.env.TZ) process.env.TZ = 'UTC'

  const cfg = loadEnv()
  const log = createLogger({
    level: cfg.logLevel,
    secrets: [cfg.telegramBotToken, cfg.adminPassword],
  })

  // createCtx открывает базу и применяет миграции; репозитории готовы сразу,
  // texts и send пока заглушки, которые бросают при вызове (§5.1).
  const ctx = createCtx({ cfg, clock: systemClock, log })
  log.info('база открыта', { path: cfg.dbPath, schema: schemaVersion(ctx.db) })

  const now = ctx.clock.now()

  // Засев идемпотентен: правки владельца переживают перезапуск. seedDefault у
  // текстов обновляет только default_value, у настроек — INSERT OR IGNORE.
  const texts = seedTexts(ctx.repo.texts, now)
  const settingsCreated = seedSettings(
    ctx.settings,
    now,
    cfg.adminTgIds.length > 0 ? { admin_tg_ids: cfg.adminTgIds.join(',') } : {},
  )
  log.info('засев', {
    texts_created: texts.created,
    texts_checked: texts.updated,
    settings_created: settingsCreated,
  })

  // Секрет /demo и /reset живёт в настройках и не должен попасть в лог ни через
  // наш код, ни через чужую строку ошибки.
  ctx.log.addSecret(ctx.settings.str('demo_secret', ''))

  ctx.texts = createTexts(ctx.repo.texts, { log })

  const sync = syncPracticesFromFiles(ctx)
  log.info('контент синхронизирован', {
    practices: ctx.repo.practices.listAll().length,
    active: ctx.repo.practices.countActive(),
    added: sync.added,
    updated: sync.updated,
    with_audio: sync.withAudio,
  })
  if (sync.missingAudio.length > 0) {
    log.warn('практики без аудио', { slugs: sync.missingAudio })
  }
  for (const err of sync.errors) log.error('синк контента', { err })
  if (ctx.repo.practices.countActive() === 0) {
    log.warn('активных практик нет: боту нечего отправить, вечера пойдут в err.no_practices')
  }

  // createBot подключает к Ctx настоящие texts и send поверх bot.api.
  const bot = createBot(ctx)

  // init() — это getMe. Делаем его явно и до polling: плохой токен должен убить
  // процесс на первой секунде, а не оставить сервис живым и немым.
  await bot.init()
  log.info('telegram getMe', {
    bot_id: bot.botInfo.id,
    username: bot.botInfo.username,
    can_read_all_group_messages: bot.botInfo.can_read_all_group_messages,
  })
  if (bot.botInfo.username.toLowerCase() !== cfg.botUsername.toLowerCase()) {
    // Не падаем: бот работает, но ссылки в админке и на лендинге ведут не туда.
    log.warn('BOT_USERNAME расходится с getMe', {
      env: cfg.botUsername,
      real: bot.botInfo.username,
    })
  }

  // Порт занимаем ПЕРЕД планировщиком и polling. Два экземпляра на одном токене —
  // это 409 Conflict и, что хуже, два тика по одной базе (§10.4, §11.2). Захват
  // порта и есть тот замок, по которому второй экземпляр понимает, что он лишний,
  // и уходит, не отправив никому ни одного сообщения.
  let scheduler: SchedulerHandle | null = null
  // Флаг объявлен здесь, а не рядом с shutdown: его читает обработчик ошибки polling,
  // который создаётся раньше.
  let stopping = false
  const http = startHttp(ctx, { lastTickAt: () => scheduler?.lastTickAt() ?? null })
  try {
    await http.ready
  } catch (err) {
    const busy = (err as NodeJS.ErrnoException).code === 'EADDRINUSE'
    log.error(busy ? 'порт занят — «Семь ночей» уже запущены' : 'http не поднялся', {
      host: cfg.bindHost,
      port: cfg.port,
      err: String(err),
      hint: busy ? 'systemctl --user status seven-nights; останавливать только им, не сигналом по имени' : undefined,
    })
    ctx.db.close()
    process.exit(1)
  }

  try {
    await configureBotProfile(bot.api)
  } catch (err) {
    log.warn('не удалось убрать меню команд', { err: String(err) })
  }

  // §4.5: сверка активных сессий и оживление пингов, записанных перед падением.
  // Делается до первого тика, иначе тик увидит рассинхрон и начнёт лечить его сам.
  recoverOnStart(ctx)

  scheduler = startScheduler(ctx, { flow, dispatch: 'scheduler' })

  // Просроченное за время простоя разбираем сразу, не дожидаясь первого интервала:
  // тридцать секунд роли не играют, но после долгого простоя очередь может быть
  // большой, и начать её разбирать лучше сейчас.
  void scheduler.tickNow()

  // drop_pending_updates НЕ ставим (docs/wiring-todo.md): человек мог ответить
  // ровно в секунду перезапуска, и его цифра — единственное, чего бот ждёт.
  void bot
    .start({
      drop_pending_updates: false,
      onStart: (info) => log.info('long polling запущен', { username: info.username }),
    })
    .catch((err) => {
      // При остановке grammY обрывает свою паузу между запросами («Aborted delay») —
      // это штатная часть bot.stop(), и пугать ею в логе нечем.
      if (stopping) {
        log.debug('polling прерван при остановке', { err: String(err) })
        return
      }
      // Всё остальное — то, от чего grammY отказался оправляться (например, 409
      // Conflict: второй экземпляр на том же токене). Немой сервис хуже упавшего:
      // systemd поднимет упавший, а немого никто не заметит.
      log.error('long polling остановлен с ошибкой', { err: String(err) })
      process.exitCode = 1
      void shutdown('polling-error')
    })

  log.info('сервис запущен', {
    title: process.title,
    pid: process.pid,
    url: `http://${cfg.bindHost}:${cfg.port}/`,
    admin: `http://${cfg.bindHost}:${cfg.port}/admin/`,
    tick_ms: cfg.schedulerTickMs,
    demo_default: cfg.demoDefault,
    tz: process.env.TZ,
  })

  async function shutdown(signal: string): Promise<void> {
    if (stopping) return
    stopping = true
    log.info('остановка', { signal })

    // Страховка от зависшего сетевого вызова: systemd ждёт 20 секунд и потом
    // всё равно пришлёт SIGKILL — лучше выйти самим и оставить строку в логе.
    const hard = setTimeout(() => {
      log.error('остановка затянулась, выходим принудительно')
      process.exit(process.exitCode === undefined ? 1 : Number(process.exitCode))
    }, SHUTDOWN_TIMEOUT_MS)
    hard.unref()

    try {
      // bot.stop() дожидается текущего getUpdates и не забирает новых обновлений:
      // апдейт, который мы не подтвердили, Telegram отдаст следующему запуску.
      await bot.stop()
    } catch (err) {
      log.warn('polling не остановился штатно', { err: String(err) })
    }

    scheduler?.stop()
    await scheduler?.drain()
    await http.close()
    ctx.db.close()

    clearTimeout(hard)
    log.info('остановлен')
    process.exit(process.exitCode === undefined ? 0 : Number(process.exitCode))
  }

  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.once('SIGINT', () => void shutdown('SIGINT'))

  // Одно упавшее обещание не повод ронять сервис: у людей идут вечера. А вот
  // uncaughtException означает, что состояние процесса уже неизвестно — выходим
  // и отдаём перезапуск systemd (Restart=always).
  process.on('unhandledRejection', (err) => {
    log.error('необработанное отклонение промиса', { err: String(err) })
  })
  process.on('uncaughtException', (err) => {
    log.error('необработанное исключение', { err: String(err), stack: err?.stack })
    process.exitCode = 1
    void shutdown('uncaughtException')
  })
}

main().catch((err) => {
  // Логгера на этом этапе может ещё не быть (упал loadEnv) — пишем в stderr как есть.
  console.error(err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err))
  process.exit(1)
})
