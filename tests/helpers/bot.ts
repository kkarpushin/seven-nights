/**
 * Стенд для тестов диалога. §9 архитектуры.
 *
 * Собирается настоящий бот на grammY с настоящим Sender и настоящими текстами из
 * базы — подменены только две вещи: часы (фейковые) и транспорт (транформер
 * grammY перехватывает исходящие вызовы вместо сети). Это важно: подменять сам
 * Sender значило бы не проверять ни 403, ни клавиатуры, ни подписи к аудио, то
 * есть ровно те места, где ошибка видна человеку.
 *
 * Время двигается руками: clock.setNow(...). Сроки не ждут — тест вызывает
 * due(kind), как это сделал бы планировщик на своём тике.
 */

import { Bot } from 'grammy'
import type { Ctx } from '../../src/ctx.ts'
import type { DueKind, UserRow } from '../../src/db/types.ts'
import { createTexts } from '../../src/texts.ts'
import { createBot } from '../../src/bot/index.ts'
import { handle } from '../../src/bot/flow.ts'
import { seedTestPractices, T0, testCtx, type TestCtx } from './db.ts'

export { T0 } from './db.ts'

export type SentCall = { method: string; payload: Record<string, unknown> }

const BOT_INFO = {
  id: 42,
  is_bot: true,
  first_name: 'Семь ночей',
  username: 'ensoma_robot',
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
}

export type HarnessOptions = {
  now?: number
  tgId?: number
  languageCode?: string
  settings?: Record<string, string>
  /** Практики с аудио. false — библиотека пуста (проверка err.no_practices). */
  practices?: boolean
}

export type Harness = {
  ctx: TestCtx
  bot: Bot
  sent: SentCall[]
  tgId: number
  /** Свежая строка пользователя (её меняет почти каждый шаг). */
  user(): UserRow
  /** Текст от человека — как из Telegram. */
  say(text: string): Promise<void>
  /** Нажатие inline-кнопки по её callback_data. */
  tap(data: string): Promise<void>
  /** Нажатие inline-кнопки по подписи: так тест не знает про формат callback_data. */
  tapLabel(label: string): Promise<void>
  /** Сработавший срок — то же, что сделал бы планировщик. */
  due(kind?: DueKind): Promise<void>
  /** Двигает виртуальные часы. */
  setNow(sec: number): void
  advance(sec: number): void
  /** Всё, что бот отправил: тексты сообщений по порядку. */
  texts(): string[]
  lastText(): string
  /** Методы Telegram по порядку — проверять, что аудио ушло ровно один раз. */
  methods(): string[]
  calls(method: string): SentCall[]
  /** Забыть отправленное, чтобы следующая проверка смотрела только на новое. */
  clear(): void
  /** Заставить Telegram отвечать ошибкой — так проверяется Sender (403, 429). */
  fail(err: { error_code: number; description: string; parameters?: Record<string, number> } | null): void
  /** Клавиатура последнего сообщения. */
  lastReplyRows(): string[][]
  lastInline(): Array<{ text: string; data?: string; url?: string }>
}

export async function makeHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const now = opts.now ?? T0
  const tgId = opts.tgId ?? 777_777
  const ctx = testCtx({ now, settings: opts.settings }) as TestCtx
  ctx.texts = createTexts(ctx.repo.texts, { log: ctx.log })

  if (opts.practices !== false) {
    seedTestPractices(ctx.db, now)
    // Без аудио практика не отправится; file_id избавляет тест от похода на диск.
    ctx.db.prepare("UPDATE practices SET tg_file_id = 'file-' || slug, audio_path = 'content/audio/' || slug || '.mp3'").run()
  }

  const sent: SentCall[] = []
  let messageId = 1000
  let failure: { error_code: number; description: string; parameters?: Record<string, number> } | null = null

  const bot = createBot(ctx as Ctx)
  // Транформер возвращает сырой ответ Bot API ({ok, result}) — тот самый конверт,
  // который grammY распаковывает сам. Без него любой вызов выглядит как отказ сети.
  bot.api.config.use(async (_prev, method, payload) => {
    if (method === 'getMe') return { ok: true, result: BOT_INFO } as never
    sent.push({ method, payload: payload as Record<string, unknown> })
    // Ответ «не ok» grammY сам превращает в GrammyError — ровно тот путь, по
    // которому 403 приходит в Sender в бою.
    if (failure) return { ok: false, ...failure } as never
    messageId += 1
    if (method === 'sendAudio') {
      return {
        ok: true,
        result: {
          message_id: messageId,
          audio: { file_id: `tgfile-${messageId}`, file_unique_id: `u-${messageId}` },
        },
      } as never
    }
    if (method === 'sendMessage' || method === 'sendPhoto') {
      return { ok: true, result: { message_id: messageId } } as never
    }
    return { ok: true, result: true } as never
  })
  await bot.init()

  let updateId = 1
  let incomingId = 1

  const from = { id: tgId, is_bot: false, first_name: 'Т', language_code: opts.languageCode ?? 'ru' }
  const chat = { id: tgId, type: 'private' as const, first_name: 'Т' }

  const user = (): UserRow => {
    const row = ctx.repo.users.byTgId(tgId)
    if (!row) throw new Error('Пользователь ещё не создан: сначала /start')
    return row
  }

  const outgoing = (m: SentCall): string => String(m.payload.text ?? m.payload.caption ?? '')

  const lastWithMarkup = (): SentCall | undefined => {
    for (let i = sent.length - 1; i >= 0; i--) {
      if (sent[i].payload.reply_markup) return sent[i]
    }
    return undefined
  }

  const harness: Harness = {
    ctx,
    bot,
    sent,
    tgId,

    user,

    async say(text) {
      updateId += 1
      incomingId += 1
      await bot.handleUpdate({
        update_id: updateId,
        message: { message_id: incomingId, date: ctx.clock.now(), from, chat, text },
      } as never)
    },

    async tap(data) {
      updateId += 1
      await bot.handleUpdate({
        update_id: updateId,
        callback_query: {
          id: `cb-${updateId}`,
          from,
          chat_instance: '1',
          data,
          message: { message_id: messageId, date: ctx.clock.now(), chat, text: '.' },
        },
      } as never)
    },

    async tapLabel(label) {
      for (let i = sent.length - 1; i >= 0; i--) {
        const markup = sent[i].payload.reply_markup as
          | { inline_keyboard?: Array<Array<{ text: string; callback_data?: string }>> }
          | undefined
        const button = markup?.inline_keyboard?.flat().find((b) => b.text === label)
        if (button?.callback_data) return harness.tap(button.callback_data)
      }
      throw new Error(`Кнопки «${label}» нет среди отправленных: ${harness.texts().join(' | ')}`)
    },

    async due(kind) {
      const u = user()
      await handle(ctx as Ctx, u, { t: 'due', kind: kind ?? (u.due_kind ?? 'ping') }, ctx.clock.now())
    },

    setNow: (sec) => ctx.clock.setNow(sec),
    advance: (sec) => ctx.clock.advance(sec),

    texts: () => sent.filter((m) => m.payload.text !== undefined || m.payload.caption !== undefined).map(outgoing),
    lastText: () => {
      const all = harness.texts()
      return all[all.length - 1] ?? ''
    },
    methods: () => sent.map((m) => m.method),
    calls: (method) => sent.filter((m) => m.method === method),
    clear: () => {
      sent.length = 0
    },
    fail: (err) => {
      failure = err
    },

    lastReplyRows() {
      const markup = lastWithMarkup()?.payload.reply_markup as
        | { keyboard?: Array<Array<{ text: string }>> }
        | undefined
      return (markup?.keyboard ?? []).map((row) => row.map((b) => b.text))
    },

    lastInline() {
      const markup = lastWithMarkup()?.payload.reply_markup as
        | { inline_keyboard?: Array<Array<{ text: string; callback_data?: string; url?: string }>> }
        | undefined
      return (markup?.inline_keyboard ?? []).flat().map((b) => ({ text: b.text, data: b.callback_data, url: b.url }))
    },
  }

  return harness
}

/** Онбординг целиком: /start → час → «сколько на часах». Возвращает стенд. */
export async function onboard(
  h: Harness,
  opts: { payload?: string; hour?: string; clock?: string } = {},
): Promise<void> {
  await h.say(opts.payload ? `/start ${opts.payload}` : '/start')
  await h.say(opts.hour ?? '21:00')
  await h.say(opts.clock ?? clockLabelFor(h, 180))
}

/** Строка «сколько сейчас на часах» для заданного смещения — как на кнопке. */
export function clockLabelFor(h: Harness, offsetMin: number): string {
  const local = h.ctx.clock.now() + offsetMin * 60
  const d = new Date(local * 1000)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

/**
 * Один вечер целиком: цифра «до» → категория → «Готово» → цифра «после».
 * Возвращает номер вечера, который в этот момент прошёл.
 */
export async function passEvening(
  h: Harness,
  opts: { before?: number; after?: number; category?: string; done?: boolean } = {},
): Promise<number> {
  await h.say(String(opts.before ?? 4))
  await h.tap(`cat:${h.user().active_session_id}:${opts.category ?? 'sleep'}`)
  const eveningNo = h.user().current_evening
  if (opts.done !== false) await h.tap(`done:${h.user().active_session_id}`)
  await h.say(String(opts.after ?? 7))
  return eveningNo
}
