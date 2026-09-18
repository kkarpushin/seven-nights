/**
 * Структурный логгер: одна строка JSON в stdout на запись. §1 архитектуры.
 *
 * Главное здесь не уровни, а вычищение секретов. Токен бота попадает в логи не
 * через наш код, а через чужой: grammY кладёт URL вида api.telegram.org/bot<токен>/…
 * в текст сетевой ошибки, и эта ошибка приезжает к нам уже строкой. Поэтому чистим
 * не поля, а весь готовый JSON перед записью — тогда неважно, из какого стека
 * или какого вложенного объекта токен пришёл.
 */

import type { LogLevel } from './env.ts'

export type LogFields = Record<string, unknown>

export type Logger = {
  readonly level: LogLevel
  debug(msg: string, fields?: LogFields): void
  info(msg: string, fields?: LogFields): void
  warn(msg: string, fields?: LogFields): void
  error(msg: string, fields?: LogFields): void
  /** Логгер с прилипшими полями: log.child({ user_id: 17 }). */
  child(fields: LogFields): Logger
  /** Добавить строку, которую нельзя пускать в лог (пароль админки, секрет демо). */
  addSecret(secret: string): void
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/** Токен бота узнаётся по форме, даже если его никто не регистрировал. */
const TOKEN_RE = /\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g

/** Экранирование для вставки произвольной строки в регулярку. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Чистит строку: сначала явно известные секреты, потом всё, что выглядит как токен.
 * Короткие секреты (< 6 символов) игнорируем — вырезать «123» из лога значит
 * испортить лог сильнее, чем его утечка.
 */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text
  for (const s of secrets) {
    if (!s || s.length < 6) continue
    out = out.replace(new RegExp(escapeRe(s), 'g'), '«скрыто»')
  }
  return out.replace(TOKEN_RE, (m) => `${m.slice(0, m.indexOf(':'))}:«скрыто»`)
}

/** Ошибки JSON.stringify не переваривает — раскладываем руками. */
function plain(value: unknown, depth = 0): unknown {
  if (value instanceof Error) {
    const e: LogFields = { name: value.name, message: value.message }
    if (value.stack) e.stack = value.stack
    if (value.cause !== undefined && depth < 3) e.cause = plain(value.cause, depth + 1)
    for (const k of Object.keys(value as object)) {
      if (k !== 'name' && k !== 'message' && k !== 'stack') e[k] = plain((value as never)[k], depth + 1)
    }
    return e
  }
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value) && depth < 5) return value.map((v) => plain(v, depth + 1))
  if (value && typeof value === 'object' && depth < 5) {
    const o: LogFields = {}
    for (const [k, v] of Object.entries(value as object)) o[k] = plain(v, depth + 1)
    return o
  }
  return value
}

export type LoggerOptions = {
  level?: LogLevel
  /** Куда писать. По умолчанию stdout; тесты подставляют накопитель. */
  write?: (line: string) => void
  /** Строки, которые нужно вырезать из любой записи. */
  secrets?: string[]
  /** Источник времени для поля ts; по умолчанию системные часы. */
  nowMs?: () => number
  base?: LogFields
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? 'info'
  const write = opts.write ?? ((line: string) => process.stdout.write(line + '\n'))
  const nowMs = opts.nowMs ?? Date.now
  // Список секретов общий для логгера и всех его детей: addSecret на любом из них
  // должен закрыть дыру везде, иначе child-логгер станет каналом утечки.
  const secrets: string[] = [...(opts.secrets ?? [])]

  function make(base: LogFields): Logger {
    const emit = (lvl: LogLevel, msg: string, fields?: LogFields): void => {
      if (ORDER[lvl] < ORDER[level]) return
      const record: LogFields = {
        ts: new Date(nowMs()).toISOString(),
        level: lvl,
        msg,
        ...base,
        ...(fields ? (plain(fields) as LogFields) : {}),
      }
      let line: string
      try {
        line = JSON.stringify(record)
      } catch {
        // Циклическая ссылка в полях не должна ронять процесс из-за логирования.
        line = JSON.stringify({ ts: record.ts, level: lvl, msg, log_error: 'unserializable_fields' })
      }
      write(redactSecrets(line, secrets))
    }
    return {
      level,
      debug: (m, f) => emit('debug', m, f),
      info: (m, f) => emit('info', m, f),
      warn: (m, f) => emit('warn', m, f),
      error: (m, f) => emit('error', m, f),
      child: (fields) => make({ ...base, ...(plain(fields) as LogFields) }),
      addSecret: (s) => {
        if (s && s.length >= 6 && !secrets.includes(s)) secrets.push(s)
      },
    }
  }

  return make(opts.base ?? {})
}

/** Логгер, который ничего не пишет — для тестов, которым логи только мешают. */
export function silentLogger(): Logger {
  return createLogger({ level: 'error', write: () => {} })
}
