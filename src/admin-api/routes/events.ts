/**
 * Журнал: что бот присылал владельцу и что вообще происходило. §3.7 design-admin.
 *
 * Уведомления и события — разные вещи, и их не надо смешивать. Уведомление это
 * письмо специалисту (могло не дойти, его можно переслать), событие — факт в
 * истории человека (дошло или нет, не спрашивается). Поэтому два списка.
 */

import { Hono } from 'hono'
import type { Ctx } from '../../ctx.ts'
import { fail, intParam, noStore } from '../util.ts'
import { eventTitle } from './users.ts'

/** Чипы фильтра «Все · Начали · Финиш · Молчат · Написали · Проблемы». */
const NOTIFY_FILTERS: Record<string, string[]> = {
  started: ['started'],
  finished: ['finished'],
  silent: ['silent'],
  message: ['message'],
  problems: ['blocked', 'no_practices'],
}

export function eventsRoutes(ctx: Ctx): Hono {
  const app = new Hono()

  app.get('/events', (c) => {
    noStore(c)
    const userIdRaw = Number(c.req.query('user_id'))
    const rows = ctx.repo.events.list({
      type: c.req.query('type') || undefined,
      userId: Number.isInteger(userIdRaw) && userIdRaw > 0 ? userIdRaw : undefined,
      limit: intParam(c.req.query('limit'), 50, 1, 500),
      offset: intParam(c.req.query('offset'), 0, 0, 100_000),
    })
    return c.json({ rows: rows.map((r) => ({ ...r, title: eventTitle(r.type) })) })
  })

  app.get('/notifications', (c) => {
    noStore(c)
    const filter = c.req.query('filter') ?? 'all'
    const types = NOTIFY_FILTERS[filter]
    const limit = intParam(c.req.query('limit'), 100, 1, 500)
    const where = types ? `WHERE type IN (${types.map(() => '?').join(',')})` : ''
    const rows = ctx.db
      .prepare(`SELECT * FROM notifications ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...(types ?? []), limit)
    return c.json({ rows, pending: ctx.repo.notifications.countPending() })
  })

  /**
   * «Отправить снова» — это новая запись в очереди, а не правка старой: dedup_key
   * с UNIQUE и есть гарантия, что одно и то же не уйдёт дважды, и трогать его
   * задним числом значит эту гарантию отменить.
   */
  app.post('/notifications/:id{[0-9]+}/retry', (c) => {
    noStore(c)
    const id = Number(c.req.param('id'))
    const row = ctx.repo.notifications.byId(id)
    if (!row) return fail(c, 404, 'not_found', 'Такого уведомления нет.')
    const now = ctx.clock.now()
    const queued = ctx.repo.notifications.enqueue({
      userId: row.user_id,
      type: row.type,
      dedupKey: `${row.dedup_key}:retry:${now}`,
      text: row.text,
      now,
    })
    return c.json({ ok: queued })
  })

  /** Свободные сообщения людей одним списком — чтобы ни одно не потерялось. */
  app.get('/messages', (c) => {
    noStore(c)
    return c.json({ rows: ctx.repo.messages.recent(intParam(c.req.query('limit'), 100, 1, 500)) })
  })

  return app
}
