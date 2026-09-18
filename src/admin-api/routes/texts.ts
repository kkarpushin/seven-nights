/**
 * Тексты бота. §6.4 архитектуры, §3.5 design-admin.
 *
 * Правка текста — единственное действие в админке, которым можно сломать бота, и
 * ровно в одном месте: подписи кнопок. Бот узнаёт нажатие по подписи (§3.1), поэтому
 * две кнопки с одинаковой надписью — это не «некрасиво», а «одна из них перестанет
 * работать». Такую правку мы не принимаем вовсе.
 *
 * Плейсхолдеры проверяются по белому списку самой строки (колонка placeholders):
 * ключ знает, какие значения бот умеет подставить именно в него. Неизвестное имя
 * дошло бы до человека как «{tme}» в чате.
 */

import { Hono } from 'hono'
import type { Ctx } from '../../ctx.ts'
import { SECTION_TITLES, TEXT_SECTIONS } from '../../db/defaultTexts.ts'
import { parsePlaceholders } from '../../db/texts.ts'
import { fail, jsonBody, noStore, renderPreview, usedPlaceholders } from '../util.ts'

export const MAX_BUTTON_LABEL = 30

export type TextValidation =
  | { ok: true; warnings: string[] }
  | { ok: false; error: string; message: string; unknown?: string[] }

/** Проверка ровно теми словами, которые увидит специалист (§3.5). */
export function validateText(
  key: string,
  value: string,
  allowed: string[],
  otherButtonLabels: Map<string, string>,
): TextValidation {
  if (value.trim() === '') {
    return {
      ok: false,
      error: 'empty',
      message: 'Текст не может быть пустым. Если сообщение не нужно — скажи разработчику, он его выключит.',
    }
  }
  const unknown = usedPlaceholders(value).filter((p) => !allowed.includes(p))
  if (unknown.length > 0) {
    const list = allowed.length > 0 ? allowed.join(', ') : 'никаких'
    return {
      ok: false,
      error: 'bad_placeholder',
      message: `Такого значения бот не знает: ${unknown.join(', ')}. Доступны: ${list}.`,
      unknown,
    }
  }
  const warnings: string[] = []
  if (key.startsWith('btn.')) {
    if (value.length > MAX_BUTTON_LABEL) {
      return {
        ok: false,
        error: 'label_too_long',
        message: `Надпись на кнопке длиннее ${MAX_BUTTON_LABEL} знаков — она не поместится.`,
      }
    }
    const clash = otherButtonLabels.get(value.trim().toLowerCase())
    if (clash !== undefined) {
      return {
        ok: false,
        error: 'label_taken',
        message: 'Такая надпись уже есть у другой кнопки — бот перестанет различать нажатия.',
      }
    }
    warnings.push('Это надпись на кнопке. Бот узнаёт нажатие по этой надписи, поэтому проверь бота на себе.')
  }
  if (value.includes('!')) {
    warnings.push('В программе нет восклицательных знаков — проверь, точно ли он тут нужен.')
  }
  return { ok: true, warnings }
}

export function textsRoutes(ctx: Ctx): Hono {
  const app = new Hono()

  /** Подписи всех прочих кнопок — чтобы поймать столкновение до сохранения. */
  const otherLabels = (key: string): Map<string, string> => {
    const m = new Map<string, string>()
    for (const r of ctx.repo.texts.all()) {
      if (r.key.startsWith('btn.') && r.key !== key) m.set(r.value.trim().toLowerCase(), r.key)
    }
    return m
  }

  /**
   * Бот держит тексты в памяти и перечитывает по reload(). Пока src/texts.ts не
   * подключён к Ctx (соседняя зона), вызов бросает — это не повод не сохранить
   * текст: в базе он уже лежит, а бот подхватит его при старте.
   */
  const reload = (): void => {
    try {
      ctx.texts.reload()
    } catch (err) {
      ctx.log.warn('texts.reload недоступен', { err })
    }
  }

  app.get('/', (c) => {
    noStore(c)
    const rows = ctx.repo.texts.listForAdmin()
    return c.json({
      rows,
      sections: TEXT_SECTIONS.map((s) => ({
        section: s,
        title: SECTION_TITLES[s],
        count: rows.filter((r) => r.section === s).length,
      })),
    })
  })

  app.put('/:key{[a-z0-9_.]+}', async (c) => {
    noStore(c)
    const key = c.req.param('key')
    const row = ctx.repo.texts.row(key)
    if (!row) return fail(c, 404, 'not_found', 'Такого текста нет.')
    const body = await jsonBody(c)
    const value = typeof body?.value === 'string' ? body.value : null
    if (value === null) return fail(c, 400, 'bad_json', 'Не получилось разобрать запрос.')

    const check = validateText(key, value, parsePlaceholders(row.placeholders), otherLabels(key))
    if (!check.ok) {
      return fail(c, 400, check.error, check.message, check.unknown ? { unknown: check.unknown } : {})
    }

    const saved = ctx.repo.texts.set(key, value, ctx.clock.now())
    reload()
    return c.json({ ok: true, row: saved, warnings: check.warnings })
  })

  app.post('/:key{[a-z0-9_.]+}/reset', (c) => {
    noStore(c)
    const key = c.req.param('key')
    if (!ctx.repo.texts.row(key)) return fail(c, 404, 'not_found', 'Такого текста нет.')
    const row = ctx.repo.texts.reset(key, ctx.clock.now())
    reload()
    return c.json({ ok: true, row })
  })

  /**
   * Предпросмотр считается по строке из тела запроса, а не по строке из базы:
   * специалист должен видеть, как сядут числа, ДО сохранения.
   */
  app.post('/:key{[a-z0-9_.]+}/preview', async (c) => {
    noStore(c)
    const key = c.req.param('key')
    const row = ctx.repo.texts.row(key)
    if (!row) return fail(c, 404, 'not_found', 'Такого текста нет.')
    const body = await jsonBody(c)
    const value = typeof body?.value === 'string' ? body.value : row.value
    return c.json({ ok: true, key, text: renderPreview(value) })
  })

  return app
}
