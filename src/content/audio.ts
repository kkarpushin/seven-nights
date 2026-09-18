/**
 * Отправка практики. §5.9 и §8.4 архитектуры.
 *
 * Сам вызов Telegram живёт в Sender (§5.5) — там же ретраи, 403 и перезаливка
 * протухшего file_id. Здесь — то, что знает только контент: как собрать подпись
 * из двух строк практики и что написать в плеере.
 *
 * Про плеер отдельно: без title/performer/duration Telegram показывает практику
 * безымянным файлом, а «красивый плеер с названием» — прямо заявленный вау-момент
 * (§8.4). Sender принимает PracticeRow и про сессию ничего не знает, поэтому
 * номер вечера приезжает к нему полем audio_meta: это НЕ колонка таблицы, а
 * довесок к строке на время отправки (см. PracticeForSend).
 */

import type { Ctx, Kb } from '../ctx.ts'
import type { PracticeRow, SessionRow, UserRow } from '../db/types.ts'

/** Название продукта в плеере и на картинке. В texts его нет: это не реплика бота. */
export const PRODUCT_NAME = 'Семь ночей'

/** Лимит подписи к медиа в Bot API. */
export const CAPTION_LIMIT = 1024

export type AudioMeta = {
  title: string
  performer: string
  duration: number | null
}

/** PracticeRow с довеском для Sender. Поля audio_meta в таблице нет. */
export type PracticeForSend = PracticeRow & { audio_meta: AudioMeta }

export function audioMeta(p: PracticeRow, s: SessionRow | null): AudioMeta {
  const performer =
    s !== null && s.kind === 'evening' && s.evening_no !== null
      ? `${PRODUCT_NAME} · Вечер ${s.evening_no}`
      : PRODUCT_NAME
  return { title: p.title, performer, duration: p.duration_sec }
}

export function withAudioMeta(p: PracticeRow, s: SessionRow | null): PracticeForSend {
  return { ...p, audio_meta: audioMeta(p, s) }
}

/** Практику есть чем отправить: либо кэш Telegram, либо файл на диске. */
export function hasAudio(p: PracticeRow): boolean {
  return p.tg_file_id !== null || p.audio_path !== null
}

/**
 * Необязательный текст (подсказка про сон): отсутствующий ключ не должен ронять
 * вечер. Основную подпись, наоборот, берём обычным render — если её нет, это
 * поломка засева, и молчать о ней нельзя.
 */
function optionalText(ctx: Ctx, key: string): string {
  try {
    return ctx.texts.get(key) ?? ''
  } catch {
    return ''
  }
}

export function buildCaption(
  ctx: Ctx,
  p: PracticeRow,
  s: SessionRow | null,
  captionKey: string,
  vars: Record<string, string | number> = {},
): string {
  let caption = ctx.texts.render(captionKey, {
    line1: p.line1,
    line2: p.line2,
    title: p.title,
    ...vars,
  })

  // «Если уснёшь — хорошо. Утром спрошу, как ты» — только для вечера: в сессии
  // «Практика сейчас» утреннего вопроса не будет, и обещание оказалось бы ложью.
  if (p.category === 'sleep' && (s === null || s.kind === 'evening')) {
    const hint = optionalText(ctx, 'ev.practice_sleep_hint')
    if (hint !== '') caption = `${caption}\n\n${hint}`
  }

  if (caption.length > CAPTION_LIMIT) {
    ctx.log.warn('Подпись к аудио обрезана', { key: captionKey, length: caption.length })
    caption = `${caption.slice(0, CAPTION_LIMIT - 1)}…`
  }
  return caption
}

/** Кнопка «Готово» под аудио. §4 design-bot: callback_data = 'done:<session_id>'. */
export function doneKb(ctx: Ctx, sessionId: number): Kb {
  return { inline: [[{ text: optionalText(ctx, 'btn.done') || 'Готово', data: `done:${sessionId}` }]] }
}

export class NoAudioError extends Error {
  constructor(public readonly slug: string) {
    super(`Практика «${slug}» без аудио: нет ни tg_file_id, ни файла на диске`)
    this.name = 'NoAudioError'
  }
}

/**
 * Отправить практику и вернуть message_id её сообщения.
 * Клавиатуру можно передать свою (её собирает src/keyboards.ts), иначе ставится
 * одна кнопка «Готово» — сообщение с практикой без неё не закроешь.
 */
export async function sendPractice(
  ctx: Ctx,
  u: UserRow,
  s: SessionRow,
  p: PracticeRow,
  captionKey: string,
  vars: Record<string, string | number> = {},
  kb?: Kb,
): Promise<number> {
  if (!hasAudio(p)) throw new NoAudioError(p.slug)

  const caption = buildCaption(ctx, p, s, captionKey, vars)
  const { msgId, fileId } = await ctx.send.audio(u, withAudioMeta(p, s), caption, kb ?? doneKb(ctx, s.id))

  // Кэш file_id — забота Sender (§5.5). Здесь страховка на случай, когда практику
  // отправили первый раз, а Sender закэшировать не успел: вторая заливка 9 МБ
  // стоит человеку минуты ожидания перед сном.
  if (fileId !== '' && p.tg_file_id === null) {
    ctx.repo.practices.setFileId(p.id, fileId, null)
  }
  return msgId
}
