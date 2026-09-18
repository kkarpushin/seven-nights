/**
 * Выгрузки. §6.5 архитектуры.
 *
 * Файл открывают в Excel, а не читают программой, поэтому заголовки по-русски,
 * состояния словами, а каждая дата — двумя колонками: по серверу (UTC, чтобы
 * строки разных людей можно было сравнить) и «по часам человека» (чтобы понять,
 * что значит «21:04» для того, кто живёт в UTC+7).
 */

import { Hono } from 'hono'
import type { Ctx } from '../../ctx.ts'
import type { AfterSource, SessionRow, UserState } from '../../db/types.ts'
import { csvResponse, fmtUserLocal, fmtUtc, noStore } from '../util.ts'
import { eventTitle } from './users.ts'

export const STATE_LABEL: Record<UserState, string> = {
  new: 'только пришёл',
  onb_hour: 'выбирает час',
  onb_clock: 'уточняет время',
  idle: 'ждёт вечера',
  awaiting_before: 'ждёт цифру до',
  awaiting_state: 'выбирает состояние',
  practicing: 'слушает практику',
  awaiting_after: 'ждёт цифру после',
  paused: 'на паузе',
  completed: 'прошёл семь вечеров',
  blocked: 'заблокировал бота',
  change_hour: 'меняет время',
  change_clock: 'меняет время',
  quiz_after: 'проходит тест',
}

export const AFTER_SOURCE_LABEL: Record<AfterSource | 'none', string> = {
  button: 'нажал «Готово» и ответил',
  timer: 'ответил после напоминания',
  early: 'прислал цифру сам',
  morning: 'ответил утром',
  none: 'не ответил',
}

const SESSION_KIND_LABEL: Record<string, string> = { evening: 'вечер программы', now: 'практика сейчас' }
const STATUS_LABEL: Record<string, string> = {
  active: 'идёт',
  done: 'закрыт',
  abandoned: 'брошен',
  declined: 'не сегодня',
}
const CATEGORY_LABEL: Record<string, string> = {
  sleep: 'сон и расслабление',
  calm: 'тревога и стресс',
  day: 'настроиться на день',
}

export function exportRoutes(ctx: Ctx): Hono {
  const app = new Hono()

  app.get('/users.csv', (c) => {
    noStore(c)
    const { rows } = ctx.repo.users.listForAdmin({ per: 200, page: 1, includeDemo: true, now: ctx.clock.now() })
    const out: Array<Array<string | number | null>> = [[
      'номер', 'telegram id', 'создан', 'состояние', 'вечер', 'время вечера', 'часовой пояс',
      'до первого вечера', 'после последнего', 'прирост', 'индекс до', 'индекс после',
      'пропусков', 'последняя активность', 'демо',
    ]]
    for (const r of rows) {
      out.push([
        `#${r.id}`, r.tg_id, fmtUtc(r.created_at), STATE_LABEL[r.state] ?? r.state,
        `${r.current_evening} из 7`, r.evening_time, r.tz,
        r.first_before, r.last_after, r.delta, r.quiz_index, r.quiz_index_after,
        r.skips, fmtUtc(r.last_seen_at), r.demo ? 'да' : '',
      ])
    }
    return csvResponse(c, 'uchastniki.csv', out)
  })

  app.get('/sessions.csv', (c) => {
    noStore(c)
    const rows = ctx.db
      .prepare(`
        SELECT s.*, u.tz_offset_min, p.title AS practice_title
          FROM sessions s
          JOIN users u ON u.id = s.user_id
          LEFT JOIN practices p ON p.id = s.practice_id
         ORDER BY s.created_at DESC, s.id DESC
         LIMIT 20000
      `)
      .all() as Array<SessionRow & { tz_offset_min: number; practice_title: string | null }>

    const out: Array<Array<string | number | null>> = [[
      'номер участника', 'круг', 'тип', 'вечер', 'дата ритуала', 'состояние', 'практика',
      'до', 'после', 'откуда «после»', 'статус', 'начало', 'аудио отправлено',
      'аудио отправлено по часам человека', 'закрыто',
    ]]
    for (const s of rows) {
      out.push([
        `#${s.user_id}`, s.run_no, SESSION_KIND_LABEL[s.kind] ?? s.kind, s.evening_no, s.ritual_date,
        s.category ? (CATEGORY_LABEL[s.category] ?? s.category) : '', s.practice_title,
        s.before_value, s.after_value, AFTER_SOURCE_LABEL[s.after_source ?? 'none'],
        STATUS_LABEL[s.status] ?? s.status,
        fmtUtc(s.created_at), fmtUtc(s.practice_sent_at),
        fmtUserLocal(s.practice_sent_at, s.tz_offset_min), fmtUtc(s.closed_at),
      ])
    }
    return csvResponse(c, 'vechera.csv', out)
  })

  app.get('/events.csv', (c) => {
    noStore(c)
    const rows = ctx.repo.events.list({ limit: 20_000, offset: 0 })
    const out: Array<Array<string | number | null>> = [['дата', 'номер участника', 'событие', 'подробности']]
    for (const e of rows) {
      out.push([fmtUtc(e.at), e.user_id === null ? '' : `#${e.user_id}`, eventTitle(e.type), e.payload])
    }
    return csvResponse(c, 'sobytiya.csv', out)
  })

  /** «Скачать его историю файлом» из карточки человека. */
  app.get('/user/:id{[0-9]+}/history.csv', (c) => {
    noStore(c)
    const id = Number(c.req.param('id'))
    const user = ctx.repo.users.byId(id)
    if (!user) return c.json({ error: 'not_found', message: 'Такого участника нет.' }, 404)

    const out: Array<Array<string | number | null>> = [[
      'время по серверу', 'время участника', 'что произошло', 'подробности',
    ]]
    const add = (at: number, what: string, detail: string) =>
      out.push([fmtUtc(at), fmtUserLocal(at, user.tz_offset_min), what, detail])

    for (const s of ctx.repo.sessions.listForUser(id, 1000)) {
      const where = s.kind === 'evening' ? `вечер ${s.evening_no}` : 'практика сейчас'
      if (s.before_at !== null) add(s.before_at, `замер до (${where})`, String(s.before_value ?? ''))
      if (s.practice_sent_at !== null) {
        const p = s.practice_id === null ? null : ctx.repo.practices.byId(s.practice_id)
        add(s.practice_sent_at, `практика (${where})`, p?.title ?? '')
      }
      if (s.after_at !== null) {
        add(s.after_at, `замер после (${where})`, `${s.after_value ?? ''} · ${AFTER_SOURCE_LABEL[s.after_source ?? 'none']}`)
      }
    }
    for (const e of ctx.repo.events.listForUser(id, 1000)) add(e.at, eventTitle(e.type), e.payload)
    for (const m of ctx.repo.messages.listForUser(id, 500)) add(m.at, 'написал словами', m.text)

    const header = out[0]!
    const body = out.slice(1).sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    return csvResponse(c, `uchastnik-${id}.csv`, [header, ...body])
  })

  return app
}
