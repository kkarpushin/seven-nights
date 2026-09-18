/**
 * Сборка бота: grammY, разбор входящего, вызов ядра переходов. §3.1 архитектуры.
 *
 * Здесь НЕТ логики продукта. Всё, что делает этот файл, — приводит входящее
 * обновление к одному из триггеров §3.1 и отдаёт его в flow.handle. Логика живёт
 * в flow.*, потому что ровно те же переходы выполняет планировщик, который про
 * grammY ничего не знает.
 *
 * Приоритет разбора текста (§3.1, порядок важен):
 *   1) команда → 2) подпись активной кнопки → 3) слово паузы →
 *   4) цифра, если состояние её ждёт → 5) свободный текст.
 * Подписи кнопок берутся из таблицы texts, а не из кода: владелец правит их в
 * админке, и бот обязан узнавать нажатие по новой подписи в ту же секунду.
 */

import { Bot, type Api, type Context } from 'grammy'
import type { Ctx, Sender } from '../ctx.ts'
import type { UserRow, UserState } from '../db/types.ts'
import { CATEGORIES } from '../db/types.ts'
import { isPauseWord, parseCommand, parseNumber } from '../parse.ts'
import { createTexts } from '../texts.ts'
import { createSender } from './send.ts'
import { handle, type Trigger } from './flow.ts'
import { handleCommand } from './admin-cmds.ts'

/** Обновления старше суток Telegram и так не хранит; отвечать на них не надо. */
export const MAX_UPDATE_AGE_SEC = 24 * 3600

/** Состояния, в которых текст-цифра — это ответ на вопрос, а не свободный текст. */
const NUMBER_STATES = new Set<UserState>(['awaiting_before', 'awaiting_after', 'practicing'])

/**
 * Где слово «пауза» действительно означает паузу (§2.5: «в любом состоянии ожидания»).
 * В онбординге и внутри теста это обычный текст: ставить на паузу человека, который
 * ещё не начал, значит отвечать не на то, что он сказал.
 */
const PAUSABLE_STATES = new Set<UserState>([
  'idle', 'awaiting_before', 'awaiting_state', 'practicing', 'awaiting_after',
])

/** Текст → триггер. Чистая функция: её проверяют тесты разбора. */
export function classifyText(ctx: Ctx, u: UserRow, text: string): Trigger {
  const raw = text.trim()

  const buttonId = ctx.texts.buttonId(raw)
  if (buttonId) return { t: 'button', id: buttonId }

  if (isPauseWord(raw) && PAUSABLE_STATES.has(u.state)) return { t: 'button', id: 'pause' }

  if (NUMBER_STATES.has(u.state)) {
    const res = parseNumber(raw)
    if ('value' in res) return { t: 'number', value: res.value }
  }

  return { t: 'text', raw }
}

/** callback_data → триггер. Формат «<action>:<session_id>» из §2.9 design-bot. */
export function parseCallbackData(data: string, cbId: string, msgId?: number): Trigger | null {
  const [head, ...rest] = data.split(':')
  switch (head) {
    case 'cat': {
      const sessionId = Number(rest[0])
      const category = rest[1]
      if (!Number.isInteger(sessionId)) return null
      if (!(CATEGORIES as readonly string[]).includes(category)) return null
      return { t: 'cb', action: 'cat', sessionId, category: category as (typeof CATEGORIES)[number], cbId, msgId }
    }
    case 'done': {
      const sessionId = Number(rest[0])
      if (!Number.isInteger(sessionId)) return null
      return { t: 'cb', action: 'done', sessionId, cbId, msgId }
    }
    case 'chtime':
      return { t: 'cb', action: 'change_time', cbId, msgId }
    case 'qstart':
      return { t: 'cb', action: 'quiz_start', cbId, msgId }
    case 'qskip':
      return { t: 'cb', action: 'quiz_skip', cbId, msgId }
    case 'qresume':
      return { t: 'cb', action: 'quiz_resume', cbId, msgId }
    case 'qa': {
      const q = Number(rest[0])
      const value = Number(rest[1])
      if (!Number.isInteger(q) || !Number.isInteger(value)) return null
      return { t: 'cb', action: 'quiz_answer', q, value, cbId, msgId }
    }
    case 'qb': {
      const q = Number(rest[0])
      if (!Number.isInteger(q)) return null
      return { t: 'cb', action: 'quiz_back', q, cbId, msgId }
    }
    default:
      return null
  }
}

/** Человек, от которого пришло обновление. Новый — создаётся здесь (строка 1 §3.2). */
function ensureUser(ctx: Ctx, tgId: number, languageCode: string | undefined, now: number): UserRow {
  const existing = ctx.repo.users.byTgId(tgId)
  if (existing) return existing
  return ctx.repo.users.create(tgId, languageCode ?? null, now)
}

export type CreateBotOptions = {
  /** Тесты и превью подставляют свой Sender; по умолчанию — настоящий поверх bot.api. */
  sender?: Sender
}

export function createBot(ctx: Ctx, opts: CreateBotOptions = {}): Bot {
  const bot = new Bot(ctx.cfg.telegramBotToken)

  // Ctx собирается раньше текстов и бота (§5.1) и держит на их местах заглушки,
  // которые бросают при первом вызове. Реестр текстов подключаем здесь, если его
  // ещё не подключили: иначе первая же отправка падает не там, где причина.
  try {
    ctx.texts.get('btn.done')
  } catch {
    ctx.texts = createTexts(ctx.repo.texts, { log: ctx.log })
  }

  // Sender — единственная дверь в Telegram (§5.5): появляется вместе с api бота.
  ctx.send = opts.sender ?? createSender(ctx, bot.api)

  bot.catch((err) => {
    ctx.log.error('необработанная ошибка обновления', {
      update_id: err.ctx?.update?.update_id,
      err: err.error,
    })
  })

  bot.on('callback_query:data', async (c) => {
    const from = c.from
    const now = ctx.clock.now()
    const user = ensureUser(ctx, from.id, from.language_code, now)
    const trg = parseCallbackData(c.callbackQuery.data, c.callbackQuery.id, c.callbackQuery.message?.message_id)
    if (!trg) {
      await ctx.send.answerCallback(c.callbackQuery.id, 'cb.expired')
      return
    }
    await handle(ctx, user, trg, now)
  })

  bot.on('message', async (c) => {
    const from = c.from
    if (!from || from.is_bot) return
    const now = ctx.clock.now()

    // Накопившееся за простой обрабатываем (человек мог прислать цифру, пока сервер
    // лежал), но вчерашние сообщения — уже нет: ответ на них выглядит как сбой.
    if (c.message.date && now - c.message.date > MAX_UPDATE_AGE_SEC) {
      ctx.log.info('старое обновление пропущено', { age_sec: now - c.message.date })
      return
    }

    const user = ensureUser(ctx, from.id, from.language_code, now)
    const text = c.message.text ?? c.message.caption ?? ''

    if (text.startsWith('/')) {
      const cmd = parseCommand(text)
      if (cmd?.cmd === 'start') {
        await handle(ctx, user, { t: 'start', payload: cmd.arg || undefined }, now)
        return
      }
      if (cmd) {
        // Секрет не подошёл — молчим о том, что команда существует, и обрабатываем
        // строку как обычный текст.
        const res = await handleCommand(ctx, user, cmd.cmd, cmd.arg, now)
        if (res === 'handled') return
      }
    }

    if (text === '') {
      await handle(ctx, user, { t: 'text', raw: '', isMedia: true }, now)
      return
    }

    await handle(ctx, user, classifyText(ctx, user, text), now)
  })

  return bot
}

/**
 * Ноль меню: команд в списке Telegram нет, кнопка меню ничего не открывает.
 * Единственное, что человек должен уметь, — нажать кнопку внизу экрана (§1.3 design-bot).
 */
export async function configureBotProfile(api: Api): Promise<void> {
  await api.setMyCommands([])
  await api.setChatMenuButton({ menu_button: { type: 'commands' } })
}

export type { Context }
