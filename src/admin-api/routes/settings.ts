/**
 * Настройки. §6.4 архитектуры, §3.6 design-admin.
 *
 * Автосохранения здесь нет — это единственный экран, где одна правка меняет
 * поведение бота сразу у всех. Поэтому валидируем строго и отвечаем целым
 * снимком: после сохранения экран показывает то, что реально лежит в базе, а не
 * то, что человек набрал в поле.
 *
 * Два ключа, которых нет в §2.4, заведены здесь: demo_default (переключатель
 * «демо для всех новых», раньше жил только в .env) и notify_types (какие
 * уведомления присылать). Оба читаются ботом и планировщиком по месту; пока это
 * не сделано, они просто хранятся — см. отчёт по зоне D.
 */

import { Hono } from 'hono'
import type { Ctx } from '../../ctx.ts'
import { normalizeOffsetMin } from '../../time.ts'
import { fail, jsonBody, noStore } from '../util.ts'

export const NOTIFY_TYPES = ['started', 'finished', 'silent', 'message', 'blocked', 'no_practices'] as const
export type NotifyType = (typeof NOTIFY_TYPES)[number]

const HM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

export type SettingsError = { field: string; message: string }

/** Ссылка либо пустая (кнопки не будет), либо настоящая https-ссылка. */
function checkUrl(value: string, field: string, errors: SettingsError[]): string {
  const v = value.trim()
  if (v === '') return ''
  if (!/^https:\/\/\S+$/.test(v)) {
    errors.push({ field, message: 'Похоже, это не ссылка. Она должна начинаться с https://' })
  }
  return v
}

function checkInt(
  raw: unknown, field: string, min: number, max: number, errors: SettingsError[],
): number | undefined {
  const n = Number(raw)
  if (!Number.isFinite(n)) {
    errors.push({ field, message: 'Здесь нужно число.' })
    return undefined
  }
  const v = Math.trunc(n)
  if (v < min || v > max) {
    errors.push({ field, message: `Значение должно быть от ${min} до ${max}.` })
    return undefined
  }
  return v
}

export function settingsRoutes(ctx: Ctx): Hono {
  const app = new Hono()

  const notifyTypes = (): string[] => {
    const raw = ctx.settings.raw('notify_types')
    if (raw === undefined) return [...NOTIFY_TYPES]
    return raw
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter((s): s is NotifyType => (NOTIFY_TYPES as readonly string[]).includes(s))
  }

  const snapshot = () => ({
    ...ctx.settings.snapshot(),
    notify_types: notifyTypes(),
    demo_default: ctx.settings.bool('demo_default', ctx.cfg.demoDefault),
    bot_username: ctx.cfg.botUsername,
    /** Для выпадающего списка маршрута сна: что вообще можно туда поставить. */
    sleep_practices: ctx.repo.practices
      .listAll()
      .filter((p) => p.category === 'sleep')
      .map((p) => ({ slug: p.slug, title: p.title, active: p.active })),
  })

  app.get('/', (c) => {
    noStore(c)
    return c.json(snapshot())
  })

  app.put('/', async (c) => {
    noStore(c)
    const body = await jsonBody(c)
    if (!body) return fail(c, 400, 'bad_json', 'Не получилось разобрать запрос.')

    const errors: SettingsError[] = []
    const warnings: string[] = []
    const patch: Record<string, string | number | boolean | object> = {}

    if (body.talk_url !== undefined) patch.talk_url = checkUrl(String(body.talk_url), 'talk_url', errors)
    if (body.channel_url !== undefined) patch.channel_url = checkUrl(String(body.channel_url), 'channel_url', errors)

    if (body.admin_tg_ids !== undefined) {
      const raw = Array.isArray(body.admin_tg_ids) ? body.admin_tg_ids.join(',') : String(body.admin_tg_ids)
      const ids: number[] = []
      for (const part of raw.split(/[,;\s]+/)) {
        if (part.trim() === '') continue
        const n = Number(part.trim())
        if (!Number.isInteger(n) || n <= 0) {
          errors.push({ field: 'admin_tg_ids', message: `«${part.trim()}» не похоже на Telegram ID — там только цифры.` })
        } else if (!ids.includes(n)) ids.push(n)
      }
      patch.admin_tg_ids = ids.join(',')
    }

    if (body.sleep_route !== undefined) {
      const route = Array.isArray(body.sleep_route) ? body.sleep_route.map((s: unknown) => String(s)) : null
      if (!route || route.length !== 7) {
        errors.push({ field: 'sleep_route', message: 'В маршруте ровно семь вечеров.' })
      } else {
        for (const slug of route) {
          const p = ctx.repo.practices.bySlug(slug)
          if (!p) errors.push({ field: 'sleep_route', message: `Практики «${slug}» нет в библиотеке.` })
          else if (!p.active) warnings.push(`Практика «${p.title}» выключена — бот возьмёт другую.`)
        }
        if (errors.length === 0) patch.sleep_route = JSON.stringify(route)
      }
    }

    if (body.allow_restart !== undefined) patch.allow_restart = body.allow_restart ? 1 : 0
    if (body.quiz_after_enabled !== undefined) patch.quiz_after_enabled = body.quiz_after_enabled ? 1 : 0
    if (body.demo_default !== undefined) patch.demo_default = body.demo_default ? 1 : 0

    if (body.default_tz_offset_min !== undefined) {
      const n = Number(body.default_tz_offset_min)
      const norm = Number.isFinite(n) ? normalizeOffsetMin(n) : null
      if (norm === null) errors.push({ field: 'default_tz_offset_min', message: 'Такого часового пояса не бывает.' })
      else patch.default_tz_offset_min = norm
    }

    if (body.morning_hour !== undefined) {
      const hm = String(body.morning_hour).trim()
      if (!HM_RE.test(hm)) errors.push({ field: 'morning_hour', message: 'Время в виде 10:00.' })
      else patch.morning_hour = hm
    }

    if (body.demo_secret !== undefined) {
      const s = String(body.demo_secret).trim()
      if (s.length < 4 || s.length > 64) {
        errors.push({ field: 'demo_secret', message: 'Секрет от 4 до 64 знаков.' })
      } else patch.demo_secret = s
    }

    const ints: Array<[string, number, number]> = [
      ['autopause_after_skips', 1, 10],
      ['silence_hours', 1, 336],
      ['ritual_day_start_hour', 0, 12],
      ['evening_window_lead_min', 0, 240],
      ['long_text_threshold', 10, 1000],
    ]
    for (const [field, min, max] of ints) {
      if (body[field] === undefined) continue
      const v = checkInt(body[field], field, min, max, errors)
      if (v !== undefined) patch[field] = v
    }

    if (body.notify_types !== undefined) {
      const raw = Array.isArray(body.notify_types) ? body.notify_types : String(body.notify_types).split(',')
      const list = raw
        .map((s: unknown) => String(s).trim())
        .filter((s: string) => (NOTIFY_TYPES as readonly string[]).includes(s))
      patch.notify_types = list.join(',')
    }

    if (errors.length > 0) {
      return fail(c, 400, 'validation', errors[0]!.message, { errors })
    }

    ctx.settings.setMany(patch)
    // Настройки тоже участвуют в текстах (ссылки в кнопках) — бот перечитывает всё разом.
    try {
      ctx.texts.reload()
    } catch (err) {
      ctx.log.warn('texts.reload недоступен', { err })
    }
    ctx.log.info('settings updated from admin', { keys: Object.keys(patch) })
    return c.json({ ok: true, settings: snapshot(), warnings })
  })

  /** «Отправить себе тестовое»: проверка, что ID верный и бот может писать владельцу. */
  app.post('/test-notification', async (c) => {
    noStore(c)
    const ids = ctx.settings.csvNumbers('admin_tg_ids')
    if (ids.length === 0 && ctx.cfg.adminTgIds.length === 0) {
      return fail(c, 409, 'no_admins', 'Некому отправлять: сначала укажи свой Telegram ID.')
    }
    try {
      await ctx.send.toAdmins('Проверка связи. Уведомления настроены верно.')
      return c.json({ ok: true })
    } catch (err) {
      ctx.log.error('test notification failed', { err })
      return fail(c, 502, 'send_failed', 'Telegram говорит, что такого адресата нет. Проверь число.')
    }
  })

  return app
}
