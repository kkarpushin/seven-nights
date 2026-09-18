/**
 * Чтение и валидация окружения. §5.2 архитектуры.
 *
 * Правило: процесс не должен стартовать наполовину рабочим. Если нет токена или
 * пароля админки, лучше упасть на первой секунде с внятной строкой, чем через час
 * отдать 500 в ответ на логин. Поэтому проверки строгие, а сообщения — по-русски
 * и с именем переменной, которую надо дописать в .env.
 */

import { config as dotenvConfig } from 'dotenv'
import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type Env = {
  telegramBotToken: string
  adminPassword: string
  port: number
  bindHost: string
  adminTgIds: number[]
  dataDir: string
  dbPath: string
  contentDir: string
  schedulerTickMs: number
  demoDefault: boolean
  adminCookieSecure: boolean
  logLevel: LogLevel
  botUsername: string
  ttsVoice: string
  ttsStyle: string
}

/** Корень репозитория: env.ts лежит в src/, значит на уровень выше. */
export const PROJECT_ROOT = resolve(import.meta.dirname, '..')

export class EnvError extends Error {
  readonly variable: string
  constructor(variable: string, message: string) {
    super(message)
    this.name = 'EnvError'
    this.variable = variable
  }
}

let dotenvLoaded = false

/**
 * Подтягивает .env один раз за процесс. Вызывается точками входа (src/index.ts,
 * scripts/*), но НЕ тестами: тест собирает окружение руками, иначе локальный .env
 * начинает влиять на прогон и «у меня всё зелёное» перестаёт что-либо значить.
 */
export function loadDotenv(path?: string): void {
  if (dotenvLoaded) return
  dotenvLoaded = true
  const file = path ?? join(PROJECT_ROOT, '.env')
  if (existsSync(file)) dotenvConfig({ path: file, quiet: true })
}

function required(src: NodeJS.ProcessEnv, key: string, hint: string): string {
  const raw = (src[key] ?? '').trim()
  if (raw === '') throw new EnvError(key, `Не задана переменная ${key}. ${hint}`)
  return raw
}

function optional(src: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const raw = (src[key] ?? '').trim()
  return raw === '' ? fallback : raw
}

function intVar(src: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = (src[key] ?? '').trim()
  if (raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n)) throw new EnvError(key, `${key} должна быть целым числом, а не «${raw}».`)
  if (n < min || n > max) throw new EnvError(key, `${key} должна быть в диапазоне ${min}…${max}, а не ${n}.`)
  return n
}

/** Принимаем и 1/0, и true/false, и yes/no — чтобы не спотыкаться о вкус автора .env. */
function boolVar(src: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = (src[key] ?? '').trim().toLowerCase()
  if (raw === '') return fallback
  if (['1', 'true', 'yes', 'on', 'да'].includes(raw)) return true
  if (['0', 'false', 'no', 'off', 'нет'].includes(raw)) return false
  throw new EnvError(key, `${key} должна быть 1 или 0, а не «${raw}».`)
}

/** ADMIN_TG_IDS — «123, 456»; пустая строка это не ошибка, а «уведомления пока некому». */
export function parseTgIds(raw: string | undefined, variable = 'ADMIN_TG_IDS'): number[] {
  const out: number[] = []
  for (const part of (raw ?? '').split(/[,;\s]+/)) {
    const s = part.trim()
    if (s === '') continue
    const n = Number(s)
    if (!Number.isInteger(n) || n <= 0) {
      throw new EnvError(variable, `${variable}: «${s}» не похоже на telegram id (нужно целое положительное число).`)
    }
    if (!out.includes(n)) out.push(n)
  }
  return out
}

const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error']

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const telegramBotToken = required(
    source,
    'TELEGRAM_BOT_TOKEN',
    'Это токен от @BotFather, без него бот не сможет подключиться к Telegram.',
  )
  if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(telegramBotToken)) {
    throw new EnvError('TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN не похож на токен: ожидается «<цифры>:<буквы и цифры>».')
  }

  const adminPassword = required(
    source,
    'ADMIN_PASSWORD',
    'Это единственный пароль на вход в админку; пустой пароль означал бы открытую админку.',
  )
  if (adminPassword.length < 8) {
    throw new EnvError('ADMIN_PASSWORD', 'ADMIN_PASSWORD короче 8 символов — задайте длиннее.')
  }

  const dataDirRaw = optional(source, 'DATA_DIR', './data')
  const dataDir = isAbsolute(dataDirRaw) ? dataDirRaw : resolve(PROJECT_ROOT, dataDirRaw)
  const contentDirRaw = optional(source, 'CONTENT_DIR', './content')
  const contentDir = isAbsolute(contentDirRaw) ? contentDirRaw : resolve(PROJECT_ROOT, contentDirRaw)

  const logLevelRaw = optional(source, 'LOG_LEVEL', 'info') as LogLevel
  if (!LOG_LEVELS.includes(logLevelRaw)) {
    throw new EnvError('LOG_LEVEL', `LOG_LEVEL должен быть одним из ${LOG_LEVELS.join(', ')}, а не «${logLevelRaw}».`)
  }

  return {
    telegramBotToken,
    adminPassword,
    port: intVar(source, 'PORT', 3700, 1, 65535),
    bindHost: optional(source, 'BIND_HOST', '127.0.0.1'),
    adminTgIds: parseTgIds(source.ADMIN_TG_IDS),
    dataDir,
    dbPath: optional(source, 'DB_PATH', join(dataDir, 'seven-nights.db')),
    contentDir,
    schedulerTickMs: intVar(source, 'SCHEDULER_TICK_MS', 30_000, 1_000, 600_000),
    demoDefault: boolVar(source, 'DEMO_MODE_DEFAULT', false),
    adminCookieSecure: boolVar(source, 'ADMIN_COOKIE_SECURE', false),
    logLevel: logLevelRaw,
    botUsername: optional(source, 'BOT_USERNAME', 'ensoma_robot').replace(/^@/, ''),
    ttsVoice: optional(source, 'TTS_VOICE', 'ru-RU-SvetlanaNeural'),
    ttsStyle: optional(source, 'TTS_STYLE', ''),
  }
}

/** Точки входа: подтянуть .env и собрать Env одной строкой. */
export function loadEnvFromDotenv(path?: string): Env {
  loadDotenv(path)
  return loadEnv(process.env)
}
