/**
 * Ctx — единственный способ получить зависимости. §5.1 архитектуры.
 *
 * Ни один модуль не импортирует базу, бота или часы напрямую: всё приходит первым
 * аргументом. Это то, что делает тесты возможными — подменив clock и send, можно
 * прогнать семь вечеров за миллисекунды и ни разу не сходить в сеть.
 *
 * Интерфейсы Texts и Sender описаны здесь, а не в src/texts.ts и src/bot/send.ts,
 * по одной причине: Ctx обязан собираться раньше, чем существуют их реализации —
 * им он и передаётся. Реализации импортируют типы отсюда; определение остаётся
 * одно, дублей нет.
 */

import { systemClock, type Clock } from './clock.ts'
import { loadEnv, type Env } from './env.ts'
import { createLogger, type Logger } from './log.ts'
import { openDb, type Db } from './db/index.ts'
import { createAdminSessionsRepo, type AdminSessionsRepo } from './db/adminSessions.ts'
import { createEventsRepo, type EventsRepo } from './db/events.ts'
import { createMessagesRepo, type MessagesRepo } from './db/messages.ts'
import { createNotificationsRepo, type NotificationsRepo } from './db/notifications.ts'
import { createPlaysRepo, type PlaysRepo } from './db/plays.ts'
import { createPracticesRepo, type PracticesRepo } from './db/practices.ts'
import { createQuizRepo, type QuizRepo } from './db/quiz.ts'
import { createSessionsRepo, type SessionsRepo } from './db/sessions.ts'
import { createSettingsStore, type SettingsStore } from './db/settings.ts'
import { createStatsRepo, type StatsRepo } from './db/stats.ts'
import { createTextsRepo, type TextsRepo } from './db/texts.ts'
import { createUsersRepo, type UsersRepo } from './db/users.ts'
import type { PracticeRow, UserRow } from './db/types.ts'

/** Идентификаторы кнопок: сопоставление подписи и действия (§3.1). */
export type ButtonId =
  | 'practice_now' | 'not_today' | 'better_at' | 'pause' | 'remind_tomorrow'
  | 'resume' | 'restart' | 'other_hour' | 'other_clock'

/** Описание клавиатуры, §5.5. */
export type Kb = {
  reply?: string[][]
  inline?: Array<Array<{ text: string; data?: string; url?: string }>>
  removeReply?: boolean
  oneTime?: boolean
}

/** Реестр текстов, §5.8. Реализация — src/texts.ts (инженер B). */
export type Texts = {
  get(key: string): string
  render(key: string, vars?: Record<string, string | number>): string
  buttonId(label: string): ButtonId | null
  label(id: ButtonId, vars?: Record<string, string | number>): string
  reload(): void
  validate(key: string, value: string): { ok: true } | { ok: false; error: string; unknown?: string[] }
}

/** Единственная дверь в Telegram API, §5.5. Реализация — src/bot/send.ts (инженер B). */
export type Sender = {
  text(user: UserRow, key: string, vars?: Record<string, string | number>, kb?: Kb): Promise<number>
  raw(user: UserRow, text: string, kb?: Kb): Promise<number>
  audio(user: UserRow, p: PracticeRow, caption: string, kb?: Kb): Promise<{ msgId: number; fileId: string }>
  photo(user: UserRow, png: Buffer, caption: string, kb?: Kb): Promise<number>
  editText(user: UserRow, msgId: number, text: string, kb?: Kb): Promise<void>
  clearInline(user: UserRow, msgId: number): Promise<void>
  action(user: UserRow, a: 'typing' | 'upload_voice' | 'upload_photo'): Promise<void>
  answerCallback(cbId: string, textKey?: string): Promise<void>
  toAdmins(text: string): Promise<void>
}

export type Repos = {
  users: UsersRepo
  sessions: SessionsRepo
  practices: PracticesRepo
  plays: PlaysRepo
  texts: TextsRepo
  events: EventsRepo
  messages: MessagesRepo
  quiz: QuizRepo
  notifications: NotificationsRepo
  adminSessions: AdminSessionsRepo
  stats: StatsRepo
}

export type Ctx = {
  db: Db
  cfg: Env
  clock: Clock
  log: Logger
  texts: Texts
  send: Sender
  settings: SettingsStore
  repo: Repos
}

export function createRepos(db: Db, clock: Clock): Repos {
  return {
    users: createUsersRepo(db, clock),
    sessions: createSessionsRepo(db, clock),
    practices: createPracticesRepo(db, clock),
    plays: createPlaysRepo(db),
    texts: createTextsRepo(db, clock),
    events: createEventsRepo(db),
    messages: createMessagesRepo(db),
    quiz: createQuizRepo(db),
    notifications: createNotificationsRepo(db),
    adminSessions: createAdminSessionsRepo(db),
    stats: createStatsRepo(db),
  }
}

/**
 * Заглушка до того, как соответствующий модуль подключён к Ctx. Молча-пустой
 * объект здесь был бы хуже ошибки: «практика отправлена» без отправки выглядит
 * как рабочий сценарий и всплывает уже у человека в чате.
 */
function notWired<T extends object>(moduleName: string): T {
  return new Proxy({} as T, {
    get(_t, prop) {
      return () => {
        throw new Error(`${moduleName} не подключён к Ctx: вызван ${String(prop)}()`)
      }
    },
  })
}

export type CreateCtxOptions = Partial<Ctx> & {
  /** Путь к базе, если db не передан. По умолчанию — из окружения. */
  dbPath?: string
  /** false — не применять миграции при открытии (скрипт бэкапа). */
  migrate?: boolean
}

export function createCtx(opts: CreateCtxOptions = {}): Ctx {
  const cfg = opts.cfg ?? loadEnv()
  const clock = opts.clock ?? systemClock
  const log =
    opts.log ??
    createLogger({ level: cfg.logLevel, secrets: [cfg.telegramBotToken, cfg.adminPassword] })
  const db = opts.db ?? openDb(opts.dbPath ?? cfg.dbPath, { migrate: opts.migrate !== false, log })

  return {
    db,
    cfg,
    clock,
    log,
    settings: opts.settings ?? createSettingsStore(db, clock),
    repo: opts.repo ?? createRepos(db, clock),
    texts: opts.texts ?? notWired<Texts>('src/texts.ts'),
    send: opts.send ?? notWired<Sender>('src/bot/send.ts'),
  }
}
