/**
 * Sender — единственная дверь в Telegram API. §5.5 архитектуры.
 *
 * Зачем одна дверь: правила «что делать, когда Telegram ответил плохо» должны
 * существовать в одном экземпляре. 403 («бот заблокирован») встречается в проекте
 * двенадцать раз — по разу на каждое место, где бот что-то отправляет, — и если бы
 * перевод человека в blocked писался в каждом из них, один забытый случай означал
 * бы вечные попытки писать тому, кто ушёл, и таймер, который никогда не гаснет.
 *
 * Здесь же и единственное место, где известен file_id: успешная отправка аудио
 * кэширует его, и вторая отправка той же практики другому человеку идёт строкой,
 * а не десятью мегабайтами с диска.
 *
 * Тексты уходят БЕЗ parse_mode. В текстах есть кавычки-ёлочки, тире и эмодзи;
 * любая разметка рано или поздно сломает отправку на формулировке, которую владелец
 * только что поправил в админке, — и сломает именно вечером.
 */

import { GrammyError, InputFile, type Api } from 'grammy'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Ctx, Kb, Sender } from '../ctx.ts'
import { PROJECT_ROOT } from '../env.ts'
import type { PracticeRow, UserRow } from '../db/types.ts'
import { audioMeta, type AudioMeta } from '../content/audio.ts'
import { notifyBlocked } from './notify.ts'

/** Бросается после перевода человека в blocked: вызывающий код выходит молча. */
export class BlockedError extends Error {
  readonly userId: number
  constructor(userId: number) {
    super(`Пользователь ${userId} заблокировал бота`)
    this.name = 'BlockedError'
    this.userId = userId
  }
}

/** Обложка трека, если она положена в assets. Проверяем один раз за процесс. */
const COVER_PATH = join(PROJECT_ROOT, 'assets', 'cover.jpg')
const HAS_COVER = existsSync(COVER_PATH)

const RETRY_DELAYS_MS = [1000, 3000, 9000]

function isBlockedError(err: unknown): boolean {
  if (!(err instanceof GrammyError)) return false
  if (err.error_code === 403) return true
  const d = err.description.toLowerCase()
  return d.includes('bot was blocked') || d.includes('user is deactivated') || d.includes('bot was kicked')
}

function retryAfter(err: unknown): number | null {
  if (!(err instanceof GrammyError)) return null
  if (err.error_code !== 429) return null
  return err.parameters?.retry_after ?? 1
}

/** Протухший file_id: Telegram иногда теряет ссылку, файл на диске остаётся. */
function isStaleFileId(err: unknown): boolean {
  if (!(err instanceof GrammyError)) return false
  const d = err.description.toLowerCase()
  return d.includes('wrong file identifier') || d.includes('file reference') || d.includes('wrong remote file')
}

/** «Сообщение не изменилось» — не ошибка: мы просто сняли клавиатуру, которой уже нет. */
function isHarmlessEditError(err: unknown): boolean {
  if (!(err instanceof GrammyError)) return false
  const d = err.description.toLowerCase()
  return (
    d.includes('message is not modified') ||
    d.includes('message to edit not found') ||
    d.includes("message can't be edited") ||
    d.includes('query is too old')
  )
}

/** Kb → reply_markup Telegram. Единственное место, где живёт эта раскладка. */
export function toReplyMarkup(kb: Kb | undefined): Record<string, unknown> | undefined {
  if (!kb) return undefined
  if (kb.removeReply) return { remove_keyboard: true }
  if (kb.inline) {
    return {
      inline_keyboard: kb.inline.map((row) =>
        row.map((b) => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data ?? '' })),
      ),
    }
  }
  if (kb.reply) {
    return {
      keyboard: kb.reply.map((row) => row.map((text) => ({ text }))),
      resize_keyboard: true,
      one_time_keyboard: kb.oneTime === true,
      is_persistent: kb.oneTime !== true,
    }
  }
  return undefined
}

/**
 * Переход строки 41 §3.2: человек заблокировал бота.
 * Живёт здесь, потому что узнаёт об этом только Sender, и узнаёт в любой из
 * дюжины точек отправки.
 */
export function markBlocked(ctx: Ctx, user: UserRow, now: number): void {
  const fresh = ctx.repo.users.byId(user.id) ?? user
  if (fresh.state === 'blocked') return

  const active = ctx.repo.sessions.active(user.id)
  ctx.db.transaction(() => {
    if (active) {
      // Практику уже слышали — вечер засчитан, сессия закрывается как состоявшаяся;
      // до практики не дошли — как отказ, чтобы не портить статистику доходимости.
      ctx.repo.sessions.close(active.id, active.practice_sent_at ? 'done' : 'declined', now)
    }
    ctx.repo.users.update(user.id, {
      state_before_block: fresh.state,
      state: 'blocked',
      blocked_at: now,
      due_at: null,
      due_kind: null,
      active_session_id: null,
    })
    ctx.repo.events.add(user.id, 'blocked', now, { evening_no: fresh.current_evening })
  })()

  // Уведомление собираем по УЖЕ обновлённой строке: ключ дедупликации включает
  // blocked_at, и по старой копии он был бы другим при каждой попытке.
  notifyBlocked(ctx, ctx.repo.users.byId(user.id) ?? fresh, now)
  ctx.log.info('пользователь заблокировал бота', { user_id: user.id, state_before: fresh.state })
}

export type SenderOptions = {
  /** Сколько раз пробовать при сетевой ошибке. Тестам удобно поставить 1. */
  attempts?: number
}

export function createSender(ctx: Ctx, api: Api, opts: SenderOptions = {}): Sender {
  const maxAttempts = opts.attempts ?? RETRY_DELAYS_MS.length

  /**
   * Одна попытка отправки с полной обработкой ошибок Telegram.
   * 403 — не «ошибка сети», а факт о человеке: он обрабатывается сразу и повторять
   * нечего. 429 — ждём ровно столько, сколько сказали, и пробуем один раз.
   */
  async function call<T>(user: UserRow | null, fn: () => Promise<T>): Promise<T> {
    let lastErr: unknown
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await fn()
      } catch (err) {
        lastErr = err
        if (user && isBlockedError(err)) {
          markBlocked(ctx, user, ctx.clock.now())
          throw new BlockedError(user.id)
        }
        const wait = retryAfter(err)
        if (wait !== null) {
          await ctx.clock.sleep((wait + 1) * 1000)
          continue
        }
        if (err instanceof GrammyError && err.error_code >= 400 && err.error_code < 500) throw err
        if (attempt === maxAttempts - 1) break
        await ctx.clock.sleep(RETRY_DELAYS_MS[attempt] ?? 1000)
      }
    }
    throw lastErr
  }

  async function sendText(user: UserRow, text: string, kb?: Kb): Promise<number> {
    const msg = await call(user, () =>
      api.sendMessage(user.tg_id, text, { reply_markup: toReplyMarkup(kb) as never }),
    )
    return msg.message_id
  }

  const sender: Sender = {
    text: (user, key, vars, kb) => sendText(user, ctx.texts.render(key, vars), kb),

    raw: (user, text, kb) => sendText(user, text, kb),

    async audio(user, p, caption, kb) {
      // Шапку плеера собирает src/content/audio.ts и передаёт полем audio_meta
      // (это довесок к строке, а не колонка таблицы). Если её нет — собираем сами
      // по активной сессии: «Вечер 0» в плеере выглядел бы поломкой.
      const meta: AudioMeta =
        (p as PracticeRow & { audio_meta?: AudioMeta }).audio_meta ??
        audioMeta(p, ctx.repo.sessions.active(user.id) ?? null)

      const fromDisk = (): InputFile => {
        if (!p.audio_path) throw new Error(`У практики «${p.slug}» нет ни tg_file_id, ни файла на диске`)
        return new InputFile(resolve(PROJECT_ROOT, p.audio_path))
      }

      const send = (payload: string | InputFile) =>
        call(user, () =>
          api.sendAudio(user.tg_id, payload as never, {
            caption,
            title: meta.title,
            performer: meta.performer,
            duration: meta.duration ?? undefined,
            thumbnail: HAS_COVER ? new InputFile(COVER_PATH) : undefined,
            reply_markup: toReplyMarkup(kb) as never,
          }),
        )

      let msg
      if (p.tg_file_id) {
        try {
          msg = await send(p.tg_file_id)
        } catch (err) {
          if (!isStaleFileId(err)) throw err
          // Кэш протух (сменили токен, файл удалён на стороне Telegram) — забываем
          // его навсегда и грузим файл заново, иначе практика больше не отправится.
          ctx.log.warn('tg_file_id протух, перезаливаем', { slug: p.slug })
          ctx.repo.practices.clearFileId(p.id)
          msg = await send(fromDisk())
        }
      } else {
        msg = await send(fromDisk())
      }

      const fileId = msg.audio?.file_id ?? ''
      if (fileId && fileId !== p.tg_file_id) {
        ctx.repo.practices.setFileId(p.id, fileId, msg.audio?.file_unique_id ?? null)
      }
      return { msgId: msg.message_id, fileId }
    },

    async photo(user, png, caption, kb) {
      const msg = await call(user, () =>
        api.sendPhoto(user.tg_id, new InputFile(png), {
          caption,
          reply_markup: toReplyMarkup(kb) as never,
        }),
      )
      return msg.message_id
    },

    async editText(user, msgId, text, kb) {
      try {
        await call(user, () =>
          api.editMessageText(user.tg_id, msgId, text, { reply_markup: toReplyMarkup(kb) as never }),
        )
      } catch (err) {
        if (err instanceof BlockedError || !isHarmlessEditError(err)) throw err
      }
    },

    async clearInline(user, msgId) {
      try {
        await call(user, () => api.editMessageReplyMarkup(user.tg_id, msgId, { reply_markup: undefined }))
      } catch (err) {
        if (err instanceof BlockedError || !isHarmlessEditError(err)) throw err
      }
    },

    async action(user, a) {
      // Индикатор «печатает» — украшение ритма, а не сообщение: если он не ушёл,
      // вечер всё равно должен состояться.
      try {
        await api.sendChatAction(user.tg_id, a)
      } catch (err) {
        if (isBlockedError(err)) {
          markBlocked(ctx, user, ctx.clock.now())
          throw new BlockedError(user.id)
        }
        ctx.log.debug('chat action не ушёл', { user_id: user.id, action: a })
      }
    },

    async answerCallback(cbId, textKey) {
      try {
        await api.answerCallbackQuery(cbId, textKey ? { text: ctx.texts.get(textKey) } : undefined)
      } catch (err) {
        // «query is too old» — человек нажал и ушёл; отвечать уже некуда и незачем.
        if (!isHarmlessEditError(err)) ctx.log.debug('answerCallbackQuery не прошёл', { err })
      }
    },

    async toAdmins(text) {
      // Владельцы — не участники программы: их 403 не должен переводить чей-то
      // state в blocked, поэтому здесь никакого call() с пользователем.
      const ids = [...new Set([...ctx.cfg.adminTgIds, ...ctx.settings.csvNumbers('admin_tg_ids')])]
      for (const id of ids) {
        try {
          await api.sendMessage(id, text)
        } catch (err) {
          ctx.log.warn('уведомление владельцу не ушло', { admin_tg_id: id, err })
        }
      }
    },
  }

  return sender
}
