/**
 * Люди: список, карточка, действия. §6.2 архитектуры, §3.3 design-admin.
 *
 * Карточка собирается на сервере целиком и намеренно не «таблицей событий»:
 * специалист должен увидеть разговор — цифру, практику, ответ, свободный текст, —
 * а не журнал базы. Поэтому лента склеивается из четырёх источников (сессии,
 * события, сообщения человека, сообщения специалиста) и раскладывается по типам,
 * которые фронтенд рисует пузырями.
 *
 * Имени, ника и телефона у нас нет и не будет: человек — это номер. Поэтому в
 * заголовках «Участник #17», а tg_id виден только там, где без него не обойтись
 * (отправить себе практику, найти человека по номеру Telegram).
 */

import { Hono } from 'hono'
import type { Ctx } from '../../ctx.ts'
import type {
  AdminUserQuery, AdminUserSegment, EventRow, MessageRow, PracticeRow, SessionRow, UserRow, UserState,
} from '../../db/types.ts'
import { USER_STATES } from '../../db/types.ts'
import { nextEveningAt } from '../../time.ts'
import { fail, intParam, jsonBody, noStore, wantsDemo } from '../util.ts'

/** Одна точка графика «его неделя» — форма совпадает с chart/data.ts (§5.9). */
export type ChartPoint = { evening: number; before: number | null; after: number | null; date: string }

export type TimelineKind =
  | 'measure_before' | 'measure_after' | 'practice' | 'message' | 'admin_message' | 'event'

export type TimelineItem = {
  at: number
  kind: TimelineKind
  title: string
  detail: Record<string, unknown>
}

/** Человеческие названия событий. Слева — закрытый список §2.3. */
const EVENT_TITLES: Record<string, string> = {
  started: 'Начал программу',
  evening_started: 'Пришёл вечерний вопрос',
  practice_sent: 'Отправлена практика',
  evening_done: 'Вечер закрыт',
  evening_skipped: 'Вечер пропущен',
  not_today: 'Ответил «Не сегодня»',
  now_done: 'Практика «сейчас» закрыта',
  paused: 'Поставлен на паузу',
  autopaused: 'Пауза после трёх пропусков',
  resumed: 'Вернулся к программе',
  finished: 'Дошёл до седьмого вечера',
  day8: 'Отправлено письмо восьмого дня',
  restarted: 'Начал семь вечеров заново',
  blocked: 'Заблокировал бота',
  unblocked: 'Разблокировал бота',
  quiz_in: 'Пришёл с результатом теста',
  quiz_after_done: 'Прошёл тест второй раз',
  hour_changed: 'Поменял время',
  demo_on: 'Включён демо-режим',
  demo_off: 'Выключен демо-режим',
  reset: 'Программа сброшена',
  no_practices: 'Практик не нашлось',
  admin_message: 'Сообщение от тебя',
}

/** События, которые в ленте дублируют карточку замера или практики. */
const NOISY_EVENTS = new Set(['evening_started', 'practice_sent', 'evening_done', 'now_done'])

export function eventTitle(type: string): string {
  return EVENT_TITLES[type] ?? type
}

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw)
    return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** График текущего круга: по одной точке на вечер, пропуск = разрыв линии. */
export function chartPoints(sessions: SessionRow[]): ChartPoint[] {
  return sessions
    .filter((s) => s.kind === 'evening' && s.evening_no !== null)
    .map((s) => ({
      evening: s.evening_no as number,
      before: s.before_value,
      after: s.after_value,
      date: s.ritual_date,
    }))
}

export function buildTimeline(
  sessions: SessionRow[],
  events: EventRow[],
  messages: MessageRow[],
  practiceById: Map<number, PracticeRow>,
): TimelineItem[] {
  const items: TimelineItem[] = []

  for (const s of sessions) {
    const where = s.kind === 'evening' ? `Вечер ${s.evening_no}` : 'Практика сейчас'
    if (s.before_value !== null && s.before_at !== null) {
      items.push({
        at: s.before_at,
        kind: 'measure_before',
        title: `Замер до: ${s.before_value}`,
        detail: { value: s.before_value, where, session_id: s.id, evening_no: s.evening_no },
      })
    }
    if (s.practice_sent_at !== null) {
      const p = s.practice_id === null ? undefined : practiceById.get(s.practice_id)
      items.push({
        at: s.practice_sent_at,
        kind: 'practice',
        title: p ? p.title : 'Практика',
        detail: {
          where,
          session_id: s.id,
          evening_no: s.evening_no,
          category: s.category,
          slug: p?.slug ?? null,
          duration_sec: p?.duration_sec ?? null,
          line1: p?.line1 ?? '',
          line2: p?.line2 ?? '',
        },
      })
    }
    if (s.after_value !== null && s.after_at !== null) {
      items.push({
        at: s.after_at,
        kind: 'measure_after',
        title: `Замер после: ${s.after_value}`,
        detail: {
          value: s.after_value,
          where,
          session_id: s.id,
          evening_no: s.evening_no,
          source: s.after_source,
          before: s.before_value,
          // «нажал Готово через 18 минут» — качество замера, а не просто цифра.
          done_after_sec:
            s.after_source === 'button' && s.practice_sent_at !== null ? s.after_at - s.practice_sent_at : null,
        },
      })
    }
  }

  for (const e of events) {
    const payload = parsePayload(e.payload)
    if (e.type === 'admin_message') {
      items.push({
        at: e.at,
        kind: 'admin_message',
        title: String(payload.text ?? ''),
        detail: { ...payload, event_id: e.id },
      })
      continue
    }
    // Событие «отправлена практика» уже нарисовано карточкой практики — в ленте
    // это была бы вторая строка про то же самое.
    if (NOISY_EVENTS.has(e.type)) continue
    items.push({ at: e.at, kind: 'event', title: eventTitle(e.type), detail: { ...payload, type: e.type } })
  }

  for (const m of messages) {
    items.push({
      at: m.at,
      kind: 'message',
      title: m.text,
      detail: { state: m.state_at_moment, message_id: m.id },
    })
  }

  // По убыванию времени — как в §6.2; лента разговора разворачивает порядок сама.
  return items.sort((a, b) => b.at - a.at || b.kind.localeCompare(a.kind))
}

export function usersRoutes(ctx: Ctx): Hono {
  const app = new Hono()

  // ─────────────────────────────── список ───────────────────────────────
  app.get('/', (c) => {
    noStore(c)
    const stateRaw = c.req.query('state')
    const q: AdminUserQuery = {
      q: c.req.query('q') ?? undefined,
      state: stateRaw && (USER_STATES as readonly string[]).includes(stateRaw) ? (stateRaw as UserState) : undefined,
      segment: (c.req.query('segment') as AdminUserSegment | undefined) || undefined,
      sort: (c.req.query('sort') as AdminUserQuery['sort']) || 'last_seen',
      dir: c.req.query('dir') === 'asc' ? 'asc' : 'desc',
      page: intParam(c.req.query('page'), 1, 1, 10_000),
      per: intParam(c.req.query('per'), 50, 1, 200),
      includeDemo: wantsDemo(c),
      now: ctx.clock.now(),
    }
    return c.json(ctx.repo.users.listForAdmin(q))
  })

  // ─────────────────────────────── карточка ───────────────────────────────
  app.get('/:id{[0-9]+}', (c) => {
    noStore(c)
    const id = Number(c.req.param('id'))
    const user = ctx.repo.users.byId(id)
    if (!user) return fail(c, 404, 'not_found', 'Такого участника нет.')

    const sessions = ctx.repo.sessions.listForUser(id, 500)
    const events = ctx.repo.events.listForUser(id, 500)
    const messages = ctx.repo.messages.listForUser(id, 200)

    const practiceById = new Map<number, PracticeRow>()
    for (const p of ctx.repo.practices.listAll()) practiceById.set(p.id, p)

    const runSessions = sessions.filter((s) => s.run_no === user.run_no)
    const evenings = runSessions
      .filter((s) => s.kind === 'evening')
      .sort((a, b) => (a.evening_no ?? 0) - (b.evening_no ?? 0))

    return c.json({
      user,
      timeline: buildTimeline(sessions, events, messages, practiceById),
      sessions: sessions.map((s) => {
        const p = s.practice_id === null ? undefined : practiceById.get(s.practice_id)
        return {
          ...s,
          practice_title: p?.title ?? null,
          practice_slug: p?.slug ?? null,
          done_after_sec:
            s.after_source === 'button' && s.after_at !== null && s.practice_sent_at !== null
              ? s.after_at - s.practice_sent_at
              : null,
        }
      }),
      chart: chartPoints(evenings),
      nowCount: sessions.filter((s) => s.kind === 'now' && s.practice_sent_at !== null).length,
      avgGain: ctx.repo.stats.avgGainForUser(id, user.run_no),
      quiz: {
        before: {
          sum: user.quiz_sum,
          index: user.quiz_index,
          at: user.quiz_at,
          answers: ctx.repo.quiz.answers(id, user.run_no, 'before'),
        },
        after: {
          sum: user.quiz_sum_after,
          index: user.quiz_index_after,
          at: user.quiz_after_at,
          answers: ctx.repo.quiz.answers(id, user.run_no, 'after'),
        },
      },
      messages,
      notifications: ctx.repo.notifications.listForUser(id, 50),
      serverNow: ctx.clock.now(),
    })
  })

  // ─────────────────────────────── действия ───────────────────────────────

  /**
   * Демо-режим одному человеку. due_at намеренно не пересчитываем: сроки считает
   * планировщик (§4.2 — при несовпадении due_kind он сам вызывает recompute), а
   * гадать здесь означало бы иметь вторую копию таблицы сроков.
   */
  app.post('/:id{[0-9]+}/demo', async (c) => {
    noStore(c)
    const id = Number(c.req.param('id'))
    const user = ctx.repo.users.byId(id)
    if (!user) return fail(c, 404, 'not_found', 'Такого участника нет.')
    const body = await jsonBody(c)
    const on = body?.on === true
    const now = ctx.clock.now()

    ctx.repo.users.update(id, on ? { demo: 1, demo_day_counter: 0 } : { demo: 0 })
    ctx.repo.events.add(id, on ? 'demo_on' : 'demo_off', now, { by: 'admin' })
    return c.json({ ok: true, user: ctx.repo.users.byId(id) })
  })

  /**
   * Пауза руками. Снятие с паузы обязано вернуть человеку таймер, иначе бот
   * замолчит навсегда: due_at = NULL и никто его больше не поставит.
   */
  app.post('/:id{[0-9]+}/pause', async (c) => {
    noStore(c)
    const id = Number(c.req.param('id'))
    const user = ctx.repo.users.byId(id)
    if (!user) return fail(c, 404, 'not_found', 'Такого участника нет.')
    const body = await jsonBody(c)
    const on = body?.on === true
    const now = ctx.clock.now()

    if (on) {
      ctx.repo.users.update(id, { paused_at: now })
      ctx.repo.users.setState(id, 'paused', { at: null, kind: null })
      ctx.repo.events.add(id, 'paused', now, { by: 'admin' })
    } else {
      const at = user.demo ? now + 120 : nextEveningAt(user, now)
      ctx.repo.users.update(id, { paused_at: null, consecutive_skips: 0 })
      ctx.repo.users.setState(id, 'idle', { at, kind: 'ping' })
      ctx.repo.events.add(id, 'resumed', now, { by: 'admin' })
    }
    return c.json({ ok: true, user: ctx.repo.users.byId(id) })
  })

  /** Специалист пишет человеку от имени бота. Событие пишем только после отправки. */
  app.post('/:id{[0-9]+}/message', async (c) => {
    noStore(c)
    const id = Number(c.req.param('id'))
    const user = ctx.repo.users.byId(id)
    if (!user) return fail(c, 404, 'not_found', 'Такого участника нет.')
    const body = await jsonBody(c)
    const text = typeof body?.text === 'string' ? body.text.trim() : ''
    if (text === '') return fail(c, 400, 'empty_text', 'Сообщение пустое.')
    if (text.length > 1000) return fail(c, 400, 'too_long', 'Слишком длинно: не больше 1000 знаков.')
    if (user.state === 'blocked') {
      return fail(c, 409, 'blocked', 'Этот человек заблокировал бота — сообщение не дойдёт.')
    }

    try {
      const msgId = await ctx.send.raw(user as UserRow, text)
      ctx.repo.events.add(id, 'admin_message', ctx.clock.now(), { text, msg_id: msgId })
      return c.json({ ok: true, msgId })
    } catch (err) {
      ctx.log.error('admin message failed', { user_id: id, err })
      return fail(c, 502, 'send_failed', 'Не отправилось: Telegram не ответил. Попробуй ещё раз.')
    }
  })

  /** Право на забвение. ?confirm=<tg_id> — чтобы удаление нельзя было нажать мимо. */
  app.delete('/:id{[0-9]+}', (c) => {
    noStore(c)
    const id = Number(c.req.param('id'))
    const user = ctx.repo.users.byId(id)
    if (!user) return fail(c, 404, 'not_found', 'Такого участника нет.')
    if (String(user.tg_id) !== (c.req.query('confirm') ?? '')) {
      return fail(c, 409, 'confirm_required', 'Удаление не подтверждено.')
    }
    ctx.repo.users.deleteCascade(id)
    ctx.log.warn('user deleted from admin', { user_id: id })
    return c.json({ ok: true })
  })

  return app
}
