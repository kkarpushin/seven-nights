/**
 * Практики. §6.3 архитектуры, §3.4 design-admin.
 *
 * Два правила, которые видно в коде.
 *
 * 1. Удаления нет — есть выключатель. На практику ссылаются сессии, и физическое
 *    удаление стёрло бы чужую историю: у человека в графике осталась бы дыра там,
 *    где он слушал.
 * 2. tg_file_id в API не принимается ни в каком виде. Он появляется сам после
 *    первой отправки и обнуляется при замене файла (это делает practices.setAudio).
 *    Если бы его можно было ввести руками, однажды ввели бы чужой — и человек
 *    получил бы не ту запись.
 */

import { Hono } from 'hono'
import { writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Ctx } from '../../ctx.ts'
import { CATEGORIES, type Category, type PracticeRow } from '../../db/types.ts'
import { audioDuration, checkAudio, MAX_AUDIO_BYTES, sha256Of } from '../audio.ts'
import { fail, jsonBody, noStore } from '../util.ts'

const SLUG_RE = /^[a-z0-9-]{3,40}$/
/** Подпись под аудио: предел Telegram 1024, запас на шаблон — §6.3. */
export const MAX_LINES_TOTAL = 900

function isCategory(v: unknown): v is Category {
  return typeof v === 'string' && (CATEGORIES as readonly string[]).includes(v)
}

export function linesTooLong(line1: string, line2: string): boolean {
  return line1.length + line2.length > MAX_LINES_TOTAL
}

export function practicesRoutes(ctx: Ctx): Hono {
  const app = new Hono()

  app.get('/', (c) => {
    noStore(c)
    return c.json({ rows: ctx.repo.practices.listWithPlays() })
  })

  app.post('/', async (c) => {
    noStore(c)
    const body = await jsonBody(c)
    if (!body) return fail(c, 400, 'bad_json', 'Не получилось разобрать запрос.')

    const slug = String(body.slug ?? '').trim()
    const title = String(body.title ?? '').trim()
    const line1 = String(body.line1 ?? '')
    const line2 = String(body.line2 ?? '')
    if (!SLUG_RE.test(slug)) {
      return fail(c, 400, 'bad_slug', 'Короткое имя: от 3 до 40 знаков, только латиница, цифры и дефис.')
    }
    if (ctx.repo.practices.bySlug(slug)) {
      return fail(c, 409, 'slug_taken', 'Практика с таким коротким именем уже есть.')
    }
    if (title === '') return fail(c, 400, 'empty_title', 'У практики должно быть название.')
    if (!isCategory(body.category)) return fail(c, 400, 'bad_category', 'Выбери категорию.')
    if (linesTooLong(line1, line2)) {
      return fail(c, 400, 'lines_too_long', 'Слишком длинно, Telegram не примет подпись.')
    }

    // Новая практика встаёт последней в своей категории: у порядка внутри
    // категории есть смысл (маршрут сна), и новая запись не должна его сдвигать.
    const last = ctx.repo.practices
      .listAll()
      .filter((p) => p.category === body.category)
      .reduce((max, p) => Math.max(max, p.sort_order), 0)

    const created = ctx.repo.practices.create({
      slug,
      category: body.category,
      title,
      line1,
      line2,
      audio_path: null,
      audio_sha256: null,
      audio_bytes: null,
      duration_sec: null,
      tg_file_id: null,
      tg_file_unique_id: null,
      sort_order: last === 0 ? 100 : last + 10,
      active: body.active === false ? 0 : 1,
      origin: 'admin',
      script_hash: null,
    })
    return c.json({ ok: true, practice: created }, 201)
  })

  app.patch('/:id{[0-9]+}', async (c) => {
    noStore(c)
    const id = Number(c.req.param('id'))
    const practice = ctx.repo.practices.byId(id)
    if (!practice) return fail(c, 404, 'not_found', 'Такой практики нет.')
    const body = await jsonBody(c)
    if (!body) return fail(c, 400, 'bad_json', 'Не получилось разобрать запрос.')

    const patch: Partial<PracticeRow> = {}
    if (body.title !== undefined) {
      const title = String(body.title).trim()
      if (title === '') return fail(c, 400, 'empty_title', 'У практики должно быть название.')
      patch.title = title
    }
    if (body.category !== undefined) {
      if (!isCategory(body.category)) return fail(c, 400, 'bad_category', 'Такой категории нет.')
      patch.category = body.category
    }
    if (body.line1 !== undefined) patch.line1 = String(body.line1)
    if (body.line2 !== undefined) patch.line2 = String(body.line2)
    if (
      linesTooLong(
        patch.line1 ?? practice.line1,
        patch.line2 ?? practice.line2,
      )
    ) {
      return fail(c, 400, 'lines_too_long', 'Слишком длинно, Telegram не примет подпись.')
    }
    if (body.active !== undefined) patch.active = body.active ? 1 : 0
    if (body.sort_order !== undefined) {
      const n = Number(body.sort_order)
      if (!Number.isFinite(n)) return fail(c, 400, 'bad_sort', 'Порядок должен быть числом.')
      patch.sort_order = Math.trunc(n)
    }

    ctx.repo.practices.updateFromAdmin(id, patch)
    return c.json({ ok: true, practice: ctx.repo.practices.byId(id) })
  })

  /** Мягкое выключение: карточка остаётся, бот её больше не предлагает. */
  app.delete('/:id{[0-9]+}', (c) => {
    noStore(c)
    const id = Number(c.req.param('id'))
    if (!ctx.repo.practices.byId(id)) return fail(c, 404, 'not_found', 'Такой практики нет.')
    ctx.repo.practices.updateFromAdmin(id, { active: 0 })
    return c.json({ ok: true, practice: ctx.repo.practices.byId(id) })
  })

  app.post('/reorder', async (c) => {
    noStore(c)
    const body = await jsonBody(c)
    const order = Array.isArray(body?.order) ? body.order : null
    if (!order) return fail(c, 400, 'bad_order', 'Не получилось разобрать новый порядок.')
    const clean: Array<{ id: number; sort_order: number }> = []
    for (const raw of order) {
      const o = raw as { id?: unknown; sort_order?: unknown }
      const id = Number(o.id)
      const sort = Number(o.sort_order)
      if (!Number.isInteger(id) || !Number.isFinite(sort)) {
        return fail(c, 400, 'bad_order', 'Не получилось разобрать новый порядок.')
      }
      clean.push({ id, sort_order: Math.trunc(sort) })
    }
    ctx.repo.practices.reorder(clean)
    return c.json({ ok: true, rows: ctx.repo.practices.listWithPlays() })
  })

  /**
   * Загрузка mp3. Имя файла из формы игнорируем целиком и берём slug: так в пути
   * физически не может появиться «../», сколько бы его туда ни писали.
   */
  app.post('/:id{[0-9]+}/audio', async (c) => {
    noStore(c)
    const id = Number(c.req.param('id'))
    const practice = ctx.repo.practices.byId(id)
    if (!practice) return fail(c, 404, 'not_found', 'Такой практики нет.')

    let form: Record<string, unknown>
    try {
      form = (await c.req.parseBody()) as Record<string, unknown>
    } catch {
      return fail(c, 400, 'bad_upload', 'Загрузка прервалась. Файл цел, попробуй ещё раз.')
    }
    const file = form.file
    if (!(file instanceof File)) return fail(c, 400, 'no_file', 'Файл не пришёл. Выбери mp3 и попробуй снова.')

    const check = checkAudio(file.name, file.size)
    if (!check.ok) return fail(c, check.error === 'too_big' ? 413 : 400, check.error, check.message)

    const buf = Buffer.from(await file.arrayBuffer())
    if (buf.length > MAX_AUDIO_BYTES) {
      return fail(c, 413, 'too_big', 'Файл больше 45 МБ — Telegram его не примет.')
    }

    const dir = join(ctx.cfg.contentDir, 'audio')
    await mkdir(dir, { recursive: true })
    const path = join(dir, `${practice.slug}.mp3`)
    writeFileSync(path, buf)

    const duration = audioDuration(path, buf)
    // setAudio сам обнулит tg_file_id, если сменился sha256: Telegram по старому
    // номеру продолжил бы отдавать прежнюю запись.
    ctx.repo.practices.setAudio(id, {
      path: `content/audio/${practice.slug}.mp3`,
      sha256: sha256Of(buf),
      bytes: buf.length,
      durationSec: duration ?? 0,
    })
    ctx.log.info('practice audio uploaded', { practice_id: id, bytes: buf.length, duration })
    return c.json({ ok: true, practice: ctx.repo.practices.byId(id), duration })
  })

  /** «Отправить себе в Telegram» — заодно прогрев file_id: после неё статус меняется. */
  app.post('/:id{[0-9]+}/preview', async (c) => {
    noStore(c)
    const id = Number(c.req.param('id'))
    const practice = ctx.repo.practices.byId(id)
    if (!practice) return fail(c, 404, 'not_found', 'Такой практики нет.')
    if (!practice.audio_path) return fail(c, 409, 'no_audio', 'У этой практики ещё нет аудио.')

    const body = await jsonBody(c)
    const tgId = Number(body?.tg_id)
    if (!Number.isInteger(tgId) || tgId <= 0) {
      return fail(c, 400, 'bad_tg_id', 'Не знаю, кому отправить: укажи свой Telegram ID в настройках.')
    }
    const user = ctx.repo.users.byTgId(tgId)
    if (!user) {
      return fail(c, 404, 'no_such_user', 'Этот человек ещё ни разу не писал боту — сначала напиши ему /start.')
    }

    const caption = [practice.line1, practice.line2].filter((s) => s !== '').join('\n')
    try {
      const sent = await ctx.send.audio(user, practice, caption)
      return c.json({ ok: true, practice: ctx.repo.practices.byId(id), msgId: sent.msgId })
    } catch (err) {
      ctx.log.error('practice preview failed', { practice_id: id, err })
      return fail(c, 502, 'send_failed', 'Telegram не принял файл. Попробуй ещё раз.')
    }
  })

  return app
}
