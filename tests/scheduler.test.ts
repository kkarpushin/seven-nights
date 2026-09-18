/**
 * Планировщик: сроки, идемпотентность, самолечение, уведомления владельцу.
 * §9.2 архитектуры, строка `scheduler.test.ts`.
 *
 * Все часы фейковые, сеть не трогается ни разу: «прошло три часа» здесь стоит
 * один вызов advance(), а не три часа ожидания.
 */

import { describe, expect, it } from 'vitest'
import { DAY_SEC } from '../src/time.ts'
import { DEMO, REAL, timingsFor } from '../src/timings.ts'
import { adminTgIds, flushNotifications, MAX_DELIVERY_ATTEMPTS } from '../src/bot/notify.ts'
import { loadFlow, recoverOnStart, tick } from '../src/scheduler/index.ts'
import { handleDue, type SchedulerFlow } from '../src/scheduler/due.ts'
import { recompute } from '../src/scheduler/plan.ts'
import { reviveStuckPrompts, sweepSilence } from '../src/scheduler/sweeps.ts'
import { createRepos, type Ctx } from '../src/ctx.ts'
import { fakeClock } from '../src/clock.ts'
import { makeUser, seedTestPractices, T0, testDb } from './helpers/db.ts'
import {
  createFlowDouble,
  createSenderDouble,
  createTextsDouble,
  ctxWithDoubles,
  currentUser,
  type FlowDouble,
  type Outbox,
} from './helpers/flow-double.ts'
import type { UserRow } from '../src/db/types.ts'

/** Ctx + практики + человек в состоянии «ждёт вечера». Отправная точка почти всех тестов. */
function setup(patch: Partial<UserRow> = {}, opts: { day8?: boolean; failStartEvening?: boolean } = {}) {
  const ctx = ctxWithDoubles()
  seedTestPractices(ctx.db)
  const flow = createFlowDouble(opts)
  const user = makeUser(ctx.db, {
    state: 'idle',
    tz_offset_min: 180,
    evening_time: '21:00',
    last_seen_at: T0,
    ...patch,
  })
  return { ctx, flow, user }
}

/** Ключи текстов, ушедших человеку. */
function keys(outbox: Outbox): string[] {
  return outbox.filter((o) => o.kind === 'text').map((o) => o.key ?? '')
}

describe('тик планировщика', () => {
  it('сработавший срок выполняется ровно один раз, второй тик ничего не добавляет', async () => {
    const { ctx, flow, user } = setup({ due_at: T0 - 10, due_kind: 'ping' })

    const first = await tick(ctx, T0, flow)
    expect(first.claimed).toBe(1)
    expect(first.outcomes.handled).toBe(1)
    expect(keys(ctx.outbox)).toEqual(['ev.before_first'])

    const second = await tick(ctx, T0, flow)
    expect(second.seen).toBe(0)
    expect(keys(ctx.outbox)).toEqual(['ev.before_first'])

    const u = currentUser(ctx, user.id)
    expect(u.state).toBe('awaiting_before')
    expect(u.due_kind).toBe('skip_deadline')
    expect(u.due_attempts).toBe(0)
  })

  it('два тика внахлёст не отправляют вечер дважды (захват по значению due_at)', async () => {
    const { ctx, flow } = setup({ due_at: T0 - 10, due_kind: 'ping' })

    const [a, b] = await Promise.all([tick(ctx, T0, flow), tick(ctx, T0, flow)])

    expect(a.claimed + b.claimed).toBe(1)
    expect(flow.calls.filter((c) => c.startsWith('startEvening')).length).toBe(1)
    expect(ctx.outbox.filter((o) => o.kind === 'text').length).toBe(1)
  })

  it('перезапуск процесса не теряет и не дублирует срок', async () => {
    const { ctx, flow, user } = setup({ due_at: T0 - 10, due_kind: 'ping' })
    await tick(ctx, T0, flow)
    const outboxBefore = ctx.outbox.length

    // Новый Ctx над той же базой — как будто процесс перезапустили: ни таймеров
    // в памяти, ни кешей не осталось, есть только две колонки в users.
    const clock2 = fakeClock(T0 + 60)
    const outbox2: Outbox = []
    const repos2 = createRepos(ctx.db, clock2)
    const ctx2: Ctx = {
      db: ctx.db,
      cfg: ctx.cfg,
      clock: clock2,
      log: ctx.log,
      settings: ctx.settings,
      repo: repos2,
      texts: createTextsDouble(repos2.texts),
      send: createSenderDouble(outbox2, () => ctx2.texts),
    }

    const res = await tick(ctx2, T0 + 60, flow)
    expect(res.seen).toBe(0)
    expect(outbox2).toHaveLength(0)
    expect(ctx.outbox.length).toBe(outboxBefore)
    expect(currentUser(ctx2, user.id).state).toBe('awaiting_before')
  })

  it('упавший обработчик повторяется, после пяти неудач таймер гасится и владельцу уходит письмо', async () => {
    const { ctx, flow, user } = setup({ due_at: T0 - 10, due_kind: 'ping' }, { failStartEvening: true })

    let now = T0
    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i += 1) {
      const res = await tick(ctx, now, flow)
      expect(res.failed).toBe(1)
      now += 120 // парковка §4.4: следующая попытка через две минуты
    }
    expect(currentUser(ctx, user.id).due_attempts).toBe(5)

    const last = await tick(ctx, now, flow)
    expect(last.disabled).toBe(1)
    const u = currentUser(ctx, user.id)
    expect(u.due_at).toBeNull()

    const queued = ctx.repo.notifications.listForUser(u.id)
    expect(queued).toHaveLength(1)
    expect(queued[0].text).toContain('таймер')
  })

  it('due_kind не совпал с состоянием: пересчёт срока без единого сообщения', async () => {
    const { ctx, flow, user } = setup({ due_at: T0 - 10, due_kind: 'after_timeout' })

    const res = await tick(ctx, T0, flow)

    expect(res.outcomes.healed).toBe(1)
    expect(ctx.outbox).toHaveLength(0)
    const u = currentUser(ctx, user.id)
    expect(u.state).toBe('idle')
    expect(u.due_kind).toBe('ping')
    expect(u.due_at).toBe(timingsFor(ctx, u).nextEvening(u, T0))
  })
})

describe('вечерний пинг', () => {
  it('протухший пинг (ритуальные сутки сменились) считается пропуском молча', async () => {
    // Пинг стоял на вчерашние 21:00, процесс лежал; сейчас девять утра следующего дня.
    const eveningYesterday = T0 - 12 * 3600
    const { ctx, flow, user } = setup({ due_at: eveningYesterday, due_kind: 'ping', current_evening: 2 })

    const res = await tick(ctx, T0, flow)

    expect(res.outcomes.silent).toBe(1)
    expect(ctx.outbox).toHaveLength(0)
    const u = currentUser(ctx, user.id)
    expect(u.consecutive_skips).toBe(1)
    expect(u.current_evening).toBe(2)
    expect(u.due_kind).toBe('ping')
    expect(u.due_at).toBeGreaterThan(T0)
    expect(ctx.repo.events.listForUser(u.id).some((e) => e.type === 'evening_skipped')).toBe(true)
  })

  it('пинг с опозданием внутри тех же ритуальных суток всё равно доходит', async () => {
    // Вечер был назначен на 21:00 локально, процесс ожил в 23:30 — сутки те же.
    const u0 = setup({ current_evening: 1 })
    const evening = timingsFor(u0.ctx, u0.user).nextEvening(u0.user, T0)
    u0.ctx.repo.users.setDue(u0.user.id, { at: evening, kind: 'ping' })

    const res = await tick(u0.ctx, evening + 2.5 * 3600, u0.flow)

    expect(res.outcomes.handled).toBe(1)
    expect(keys(u0.ctx.outbox)).toEqual(['ev.before'])
    expect(currentUser(u0.ctx, u0.user.id).state).toBe('awaiting_before')
  })

  it('три пропуска подряд — автопауза вместо четвёртого пинга', async () => {
    const { ctx, flow, user } = setup({ due_at: T0 - 10, due_kind: 'ping', consecutive_skips: 3, current_evening: 2 })

    await tick(ctx, T0, flow)

    const u = currentUser(ctx, user.id)
    expect(u.state).toBe('paused')
    expect(u.due_at).toBeNull()
    expect(keys(ctx.outbox)).toEqual(['ev.autopause'])
    expect(ctx.repo.events.listForUser(u.id).some((e) => e.type === 'autopaused')).toBe(true)

    // Четвёртого пинга нет и не будет: сроков у паузы не бывает.
    expect((await tick(ctx, T0 + DAY_SEC, flow)).seen).toBe(0)
  })

  it('вечер на эту ритуальную дату уже засчитан — пинг молча переносится', async () => {
    const { ctx, flow, user } = setup({ due_at: T0 - 10, due_kind: 'ping', current_evening: 1 })
    const t = timingsFor(ctx, user)
    const s = ctx.repo.sessions.open({
      userId: user.id,
      runNo: 1,
      kind: 'evening',
      eveningNo: 1,
      ritualDate: t.ritualDate(user, T0),
      now: T0 - 3600,
    })
    ctx.repo.sessions.markPracticeSent(s.id, 1, T0 - 3600)
    ctx.repo.sessions.close(s.id, 'done', T0 - 100)

    const res = await tick(ctx, T0, flow)

    expect(res.outcomes.silent).toBe(1)
    expect(ctx.outbox).toHaveLength(0)
    expect(currentUser(ctx, user.id).due_at).toBe(t.nextEvening(user, T0))
  })

  it('внутри сессии «Практика сейчас» вечерний пинг откладывается на минуту', async () => {
    const { ctx, flow, user } = setup({ due_at: T0 - 10, due_kind: 'ping' })
    ctx.repo.sessions.open({
      userId: user.id,
      runNo: 1,
      kind: 'now',
      eveningNo: null,
      ritualDate: '2025-09-16',
      now: T0 - 300,
    })

    const res = await tick(ctx, T0, flow)

    expect(res.outcomes.postponed).toBe(1)
    expect(ctx.outbox).toHaveLength(0)
    expect(currentUser(ctx, user.id).due_at).toBe(T0 + 60)
  })
})

describe('таймер «после» практики', () => {
  /** Человек в состоянии practicing: аудио отправлено sentAt секунд назад. */
  function practicing(sentAt: number) {
    const { ctx, flow, user } = setup({ state: 'practicing', current_evening: 3 })
    const s = ctx.repo.sessions.open({
      userId: user.id,
      runNo: 1,
      kind: 'evening',
      eveningNo: 3,
      ritualDate: '2025-09-16',
      now: sentAt - 60,
    })
    ctx.repo.sessions.setBefore(s.id, 4, sentAt - 30)
    ctx.repo.sessions.setCategory(s.id, 'sleep', ctx.repo.practices.bySlug('sleep-landing')!.id)
    ctx.repo.sessions.markPracticeSent(s.id, 42, sentAt)
    return { ctx, flow, user, session: ctx.repo.sessions.byId(s.id)! }
  }

  it('вовремя: задаём вопрос «после» и ждём цифру до утра', async () => {
    const sentAt = T0 - REAL.afterMinSec
    const { ctx, flow, user } = practicing(sentAt)
    ctx.repo.users.setDue(user.id, { at: sentAt + 780, kind: 'after_timeout' })

    await tick(ctx, sentAt + 780, flow)

    expect(keys(ctx.outbox)).toEqual(['ev.after'])
    const u = currentUser(ctx, user.id)
    expect(u.state).toBe('awaiting_after')
    expect(u.due_kind).toBe('morning')
  })

  it('просрочка больше трёх часов: ночной вопрос не задаём вовсе', async () => {
    const sentAt = T0 - 6 * 3600
    const { ctx, flow, user } = practicing(sentAt)
    const dueAt = sentAt + 780
    ctx.repo.users.setDue(user.id, { at: dueAt, kind: 'after_timeout' })

    const res = await tick(ctx, dueAt + 4 * 3600, flow)

    expect(res.outcomes.silent).toBe(1)
    expect(ctx.outbox).toHaveLength(0)
    const u = currentUser(ctx, user.id)
    expect(u.state).toBe('awaiting_after')
    expect(u.due_kind === 'morning' || u.due_kind === 'ping_or_close').toBe(true)
  })
})

describe('утро и закрытие вечера без ответа', () => {
  /** Вечер n: практика отправлена, вопрос «после» задан, цифры нет. */
  function awaitingAfter(eveningNo: number, nudged = false) {
    const { ctx, flow, user } = setup({ state: 'awaiting_after', current_evening: eveningNo })
    const s = ctx.repo.sessions.open({
      userId: user.id,
      runNo: 1,
      kind: 'evening',
      eveningNo,
      ritualDate: '2025-09-16',
      now: T0 - 3600,
    })
    ctx.repo.sessions.setBefore(s.id, 4, T0 - 3500)
    ctx.repo.sessions.setCategory(s.id, 'sleep', ctx.repo.practices.bySlug('sleep-landing')!.id)
    ctx.repo.sessions.markPracticeSent(s.id, 7, T0 - 3000)
    if (nudged) ctx.repo.sessions.setNudged(s.id)
    return { ctx, flow, user, session: ctx.repo.sessions.byId(s.id)! }
  }

  it('утренний догон уходит один раз и передаёт срок следующему вечеру', async () => {
    const { ctx, flow, user, session } = awaitingAfter(3)
    ctx.repo.users.setDue(user.id, { at: T0 - 10, kind: 'morning' })

    await tick(ctx, T0, flow)

    expect(keys(ctx.outbox)).toEqual(['ev.morning'])
    expect(ctx.repo.sessions.byId(session.id)!.nudged).toBe(1)
    expect(currentUser(ctx, user.id).due_kind).toBe('ping_or_close')

    // Второй догон невозможен даже при ручной подстановке срока.
    ctx.repo.users.setDue(user.id, { at: T0 + 100, kind: 'morning' })
    const res = await tick(ctx, T0 + 200, flow)
    expect(res.outcomes.silent).toBe(1)
    expect(keys(ctx.outbox)).toEqual(['ev.morning'])
  })

  it('пришёл следующий вечер: сессия закрывается без замера, вечер остаётся засчитанным', async () => {
    const { ctx, flow, user, session } = awaitingAfter(3, true)
    ctx.repo.users.setDue(user.id, { at: T0 - 10, kind: 'ping_or_close' })

    await tick(ctx, T0, flow)

    const closed = ctx.repo.sessions.byId(session.id)!
    expect(closed.status).toBe('done')
    expect(closed.after_value).toBeNull()
    const u = currentUser(ctx, user.id)
    // Следующий вечер открылся сразу, отдельного пинга не будет.
    expect(u.state).toBe('awaiting_before')
    expect(keys(ctx.outbox)).toEqual(['ev.before_half']) // §3.3: четвёртый вечер — свой текст
    expect(ctx.repo.sessions.active(u.id)!.evening_no).toBe(4)
  })

  it('седьмой вечер без замера всё равно даёт финал', async () => {
    const { ctx, flow, user } = awaitingAfter(7, true)
    ctx.repo.users.setDue(user.id, { at: T0 - 10, kind: 'ping_or_close' })

    await tick(ctx, T0, flow)

    const u = currentUser(ctx, user.id)
    expect(u.state).toBe('completed')
    expect(u.due_kind).toBe('day8')
    expect(flow.calls).toContain('finale')
    expect(ctx.outbox.some((o) => o.kind === 'photo')).toBe(true)
  })
})

describe('сессия «Практика сейчас»', () => {
  function nowSession(state: 'awaiting_before' | 'awaiting_after') {
    const { ctx, flow, user } = setup({ state, state_before_now: 'idle', current_evening: 2 })
    const s = ctx.repo.sessions.open({
      userId: user.id,
      runNo: 1,
      kind: 'now',
      eveningNo: null,
      ritualDate: '2025-09-16',
      now: T0 - 600,
    })
    return { ctx, flow, user, session: ctx.repo.sessions.byId(s.id)! }
  }

  it('не ответил на «до» — сессия удаляется, состояние возвращается', async () => {
    const { ctx, flow, user, session } = nowSession('awaiting_before')
    ctx.repo.users.setDue(user.id, { at: T0 - 10, kind: 'now_timeout_before' })

    await tick(ctx, T0, flow)

    expect(ctx.repo.sessions.byId(session.id)).toBeUndefined()
    const u = currentUser(ctx, user.id)
    expect(u.state).toBe('idle')
    expect(u.state_before_now).toBeNull()
    expect(u.due_kind).toBe('ping')
    expect(ctx.outbox).toHaveLength(0)
  })

  it('не ответил на «после» — закрываем молча, вечер программы не трогаем', async () => {
    const { ctx, flow, user, session } = nowSession('awaiting_after')
    ctx.repo.users.setDue(user.id, { at: T0 - 10, kind: 'now_timeout_after' })

    await tick(ctx, T0, flow)

    const closed = ctx.repo.sessions.byId(session.id)!
    expect(closed.status).toBe('done')
    expect(closed.after_value).toBeNull()
    const u = currentUser(ctx, user.id)
    expect(u.state).toBe('idle')
    expect(u.current_evening).toBe(2)
    expect(ctx.outbox).toHaveLength(0)
  })
})

describe('день восьмой', () => {
  it('приходит один раз, после него бот молчит навсегда', async () => {
    const { ctx, flow, user } = setup({
      state: 'completed',
      current_evening: 7,
      completed_at: T0 - 3600,
      due_at: T0 - 10,
      due_kind: 'day8',
    })

    await tick(ctx, T0, flow)

    const u = currentUser(ctx, user.id)
    expect(u.day8_sent).toBe(1)
    expect(u.due_at).toBeNull()
    expect(keys(ctx.outbox)).toEqual(['final.day8'])

    const res = await tick(ctx, T0 + 30 * DAY_SEC, flow)
    expect(res.seen).toBe(0)
    expect(ctx.outbox).toHaveLength(1)
  })

  it('брошенный посреди теста человек всё равно получает день восьмой', async () => {
    // Строка 43 §3.2 уводит в quiz_after с пустым сроком. Если считать это состояние
    // «бот молчит», то начатый и брошенный ночью тест отменил бы утро восьмого дня.
    const { ctx, flow, user } = setup({
      state: 'quiz_after',
      current_evening: 7,
      quiz_step: 3,
      due_at: T0 - 10,
      due_kind: 'day8',
    })

    await tick(ctx, T0, flow)

    expect(keys(ctx.outbox)).toEqual(['final.day8'])
    expect(currentUser(ctx, user.id).day8_sent).toBe(1)
  })

  it('без реализации в ядре планировщик отправляет final.day8 сам', async () => {
    const { ctx, flow, user } = setup(
      { state: 'completed', current_evening: 7, due_at: T0 - 10, due_kind: 'day8' },
      { day8: false },
    )
    ctx.settings.set('channel_url', 'https://t.me/example')

    await tick(ctx, T0, flow)

    expect(keys(ctx.outbox)).toEqual(['final.day8'])
    expect(ctx.outbox[0].kb?.inline?.[0][0].url).toBe('https://t.me/example')
    expect(currentUser(ctx, user.id).day8_sent).toBe(1)
  })
})

describe('пересчёт срока (plan.recompute)', () => {
  it('каждое состояние получает свой вид срока', () => {
    const ctx = ctxWithDoubles()
    seedTestPractices(ctx.db)

    const idle = makeUser(ctx.db, { state: 'idle' })
    expect(recompute(ctx, idle, T0).kind).toBe('ping')

    const paused = makeUser(ctx.db, { state: 'paused' })
    expect(recompute(ctx, paused, T0)).toEqual({ at: null, kind: null })

    const done = makeUser(ctx.db, { state: 'completed', day8_sent: 1 })
    expect(recompute(ctx, done, T0)).toEqual({ at: null, kind: null })

    const beforeDay8 = makeUser(ctx.db, { state: 'completed' })
    expect(recompute(ctx, beforeDay8, T0).kind).toBe('day8')

    const waiting = makeUser(ctx.db, { state: 'awaiting_before' })
    ctx.repo.sessions.open({
      userId: waiting.id,
      runNo: 1,
      kind: 'evening',
      eveningNo: 1,
      ritualDate: '2025-09-16',
      now: T0,
    })
    expect(recompute(ctx, waiting, T0).kind).toBe('skip_deadline')
  })

  it('в демо сроки короткие и не зависят от календаря', () => {
    const ctx = ctxWithDoubles()
    const demo = makeUser(ctx.db, { state: 'idle', demo: 1 })
    const t = timingsFor(ctx, demo)

    expect(t.nextEvening(demo, T0)).toBe(T0 + DEMO.nextEveningSec)
    expect(t.afterTimeout(600)).toBe(DEMO.afterSec)
    expect(t.morningAt(demo, T0)).toBeNull()
    expect(t.eveningWindow(demo, T0 + 7 * 3600)).toBe(true)
    expect(t.silenceSec()).toBeNull()
    expect(t.ritualDate({ ...demo, demo_day_counter: 3 }, T0)).toBe('demo-3')
  })
})

describe('фоновые проходы', () => {
  it('молчание 72 часа: одно уведомление на одну серию', () => {
    const ctx = ctxWithDoubles()
    const u = makeUser(ctx.db, { state: 'idle', current_evening: 3, last_seen_at: T0 - 80 * 3600 })

    expect(sweepSilence(ctx, T0)).toBe(1)
    expect(sweepSilence(ctx, T0 + 600)).toBe(0)

    const queued = ctx.repo.notifications.listForUser(u.id)
    expect(queued).toHaveLength(1)
    expect(queued[0].type).toBe('silent')
    expect(queued[0].text).toContain(`#${u.id}`)

    // Человек вернулся и снова пропал — это новая история, уведомление положено.
    ctx.repo.users.touchSeen(u.id, T0 + 600)
    expect(sweepSilence(ctx, T0 + 600 + 80 * 3600)).toBe(1)
  })

  it('демо-пользователи в проход по молчанию не попадают', () => {
    const ctx = ctxWithDoubles()
    makeUser(ctx.db, { state: 'idle', demo: 1, last_seen_at: T0 - 200 * 3600 })
    expect(sweepSilence(ctx, T0)).toBe(0)
  })

  it('доставка уведомлений: успех помечает, ошибка копит попытки', async () => {
    const ctx = ctxWithDoubles()
    const u = makeUser(ctx.db, { state: 'idle', last_seen_at: T0 - 80 * 3600 })
    sweepSilence(ctx, T0)

    let fail = true
    const deliver = async (): Promise<void> => {
      if (fail) throw new Error('Telegram недоступен')
    }

    const bad = await flushNotifications(ctx, T0, { deliver })
    expect(bad.failed).toBe(1)
    expect(ctx.repo.notifications.countPending()).toBe(1)
    expect(ctx.repo.notifications.listForUser(u.id)[0].attempts).toBe(1)

    fail = false
    const good = await flushNotifications(ctx, T0 + 300, { deliver })
    expect(good.sent).toBe(1)
    expect(ctx.repo.notifications.countPending()).toBe(0)
  })

  it('получателей нет — очередь не сжигается', async () => {
    const ctx = ctxWithDoubles({ env: { adminTgIds: [] } })
    makeUser(ctx.db, { state: 'idle', last_seen_at: T0 - 80 * 3600 })
    sweepSilence(ctx, T0)

    const res = await flushNotifications(ctx, T0, { deliver: async () => {} })
    expect(res.skipped).toBe(1)
    expect(ctx.repo.notifications.countPending()).toBe(1)
  })

  it('адресаты уведомлений — объединение .env и настроек', () => {
    const ctx = ctxWithDoubles({ env: { adminTgIds: [999] } })
    ctx.settings.set('admin_tg_ids', '777, 999, 888')
    expect(adminTgIds(ctx)).toEqual([999, 777, 888])
  })
})

describe('пинг, записанный но не отправленный (§4.4, рубеж 2)', () => {
  /** Сессия, у которой prompt_sent_at есть, а message_id нет: процесс умер между ними. */
  function stuck(minutesAgo: number, ritual = '2025-09-16') {
    const { ctx, flow, user } = setup({ state: 'awaiting_before', current_evening: 2 })
    const at = T0 - minutesAgo * 60
    const s = ctx.repo.sessions.open({
      userId: user.id, runNo: 1, kind: 'evening', eveningNo: 3, ritualDate: ritual, now: at,
    })
    ctx.repo.sessions.setPromptSent(s.id, at)
    ctx.repo.users.setDue(user.id, { at: T0 + 3600, kind: 'skip_deadline' })
    return { ctx, flow, user, session: s, promptAt: at }
  }

  it('через десять минут пустая сессия снимается и вечер планируется заново', async () => {
    const { ctx, flow, user, session, promptAt } = stuck(15)

    expect(reviveStuckPrompts(ctx, T0)).toBe(1)

    expect(ctx.repo.sessions.byId(session.id)).toBeUndefined()
    const u = currentUser(ctx, user.id)
    expect(u.state).toBe('idle')
    expect(u.due_kind).toBe('ping')
    expect(u.due_at).toBe(promptAt)

    // Обычный тик доводит дело до конца: вечер уходит человеку с опозданием.
    await tick(ctx, T0, flow)
    expect(keys(ctx.outbox)).toEqual(['ev.before'])
    expect(currentUser(ctx, user.id).state).toBe('awaiting_before')
  })

  it('свежий пинг не трогаем: Telegram бывает медленным', () => {
    const { ctx, session } = stuck(3)
    expect(reviveStuckPrompts(ctx, T0)).toBe(0)
    expect(ctx.repo.sessions.byId(session.id)).toBeDefined()
  })

  it('если ритуальные сутки уже сменились, вечер засчитывается пропуском, а не шлётся утром', async () => {
    const { ctx, flow, user } = stuck(15 * 60, '2025-09-15') // пинг был вчера вечером
    reviveStuckPrompts(ctx, T0)

    const res = await tick(ctx, T0, flow)

    expect(res.outcomes.silent).toBe(1)
    expect(ctx.outbox).toHaveLength(0)
    expect(currentUser(ctx, user.id).consecutive_skips).toBe(1)
  })

  it('сессию с уже полученной цифрой «до» проход не трогает', () => {
    const { ctx, session } = stuck(30)
    ctx.repo.sessions.setBefore(session.id, 5, T0 - 1700)
    expect(reviveStuckPrompts(ctx, T0)).toBe(0)
    expect(ctx.repo.sessions.byId(session.id)).toBeDefined()
  })
})

describe('восстановление после перезапуска', () => {
  it('указатель разошёлся с активной сессией — чинится в пользу сессии', () => {
    const ctx = ctxWithDoubles()
    const u = makeUser(ctx.db, { state: 'awaiting_before' })
    const s = ctx.repo.sessions.open({
      userId: u.id,
      runNo: 1,
      kind: 'evening',
      eveningNo: 2,
      ritualDate: '2025-09-16',
      now: T0,
    })
    // Процесс упал между INSERT сессии и записью указателя.
    ctx.db.prepare('UPDATE users SET active_session_id = NULL WHERE id = ?').run(u.id)

    const res = recoverOnStart(ctx)

    expect(res.fixedUsers).toBe(1)
    expect(currentUser(ctx, u.id).active_session_id).toBe(s.id)
  })

  it('вторую активную сессию у человека не даёт завести сама схема', () => {
    const ctx = ctxWithDoubles()
    const u = makeUser(ctx.db, { state: 'awaiting_before' })
    ctx.repo.sessions.open({
      userId: u.id, runNo: 1, kind: 'evening', eveningNo: 1, ritualDate: '2025-09-16', now: T0,
    })
    expect(() =>
      ctx.repo.sessions.open({
        userId: u.id, runNo: 1, kind: 'now', eveningNo: null, ritualDate: '2025-09-16', now: T0 + 60,
      }),
    ).toThrow(/UNIQUE/)
  })

  it('указатель на давно закрытую сессию обнуляется', () => {
    const ctx = ctxWithDoubles()
    const u = makeUser(ctx.db, { state: 'idle' })
    const s = ctx.repo.sessions.open({
      userId: u.id,
      runNo: 1,
      kind: 'evening',
      eveningNo: 1,
      ritualDate: '2025-09-16',
      now: T0,
    })
    ctx.db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run('done', s.id)
    ctx.db.prepare('UPDATE users SET active_session_id = ? WHERE id = ?').run(s.id, u.id)

    recoverOnStart(ctx)

    expect(currentUser(ctx, u.id).active_session_id).toBeNull()
  })
})

describe('страховка по сроку', () => {
  it('переход не поставил срок — планировщик ставит его сам', async () => {
    const ctx = ctxWithDoubles()
    seedTestPractices(ctx.db)
    const user = makeUser(ctx.db, { state: 'idle', due_at: T0 - 10, due_kind: 'ping' })

    // Ядро-молчун: открыло вечер, но про due_at забыло. Так выглядит любой
    // недописанный переход — и именно из-за него человек может застыть навсегда.
    const forgetful: FlowDouble = createFlowDouble()
    forgetful.startEvening = async (c, u, n, now) => {
      c.repo.sessions.open({
        userId: u.id,
        runNo: u.run_no,
        kind: 'evening',
        eveningNo: n,
        ritualDate: '2025-09-16',
        now,
      })
      c.repo.users.update(u.id, { state: 'awaiting_before' })
    }

    await tick(ctx, T0, forgetful)

    const u = currentUser(ctx, user.id)
    expect(u.state).toBe('awaiting_before')
    expect(u.due_kind).toBe('skip_deadline')
    expect(u.due_at).toBeGreaterThan(T0)
  })

  it('handleDue возвращает исход и не трогает чужие состояния', async () => {
    const ctx = ctxWithDoubles()
    seedTestPractices(ctx.db)
    const flow = createFlowDouble()
    const u = makeUser(ctx.db, { state: 'paused', due_at: T0 - 10, due_kind: 'ping' })

    const outcome = await handleDue(ctx, u, 'ping', T0, flow, { seenDueAt: T0 - 10, parkUntil: T0 + 120 })

    expect(outcome).toBe('healed')
    expect(currentUser(ctx, u.id).state).toBe('paused')
    expect(currentUser(ctx, u.id).due_at).toBeNull()
    expect(ctx.outbox).toHaveLength(0)
  })
})

describe('режим dispatch = flow', () => {
  it('разбор срока можно целиком отдать ядру, страховка по due_at всё равно работает', async () => {
    const { ctx, flow, user } = setup({ due_at: T0 - 10, due_kind: 'ping' })
    const seen: string[] = []

    // Ядро разбирает due само (§5.6, Trigger.t = 'due'), но про срок «забывает» —
    // ровно тот случай, ради которого планировщик перепроверяет поле после вызова.
    flow.handle = async (c, u, trg, now) => {
      seen.push(trg.kind)
      c.repo.sessions.open({
        userId: u.id, runNo: 1, kind: 'evening', eveningNo: 1, ritualDate: '2025-09-16', now,
      })
      await c.send.text(u, 'ev.before_first')
      c.repo.users.update(u.id, { state: 'awaiting_before' })
    }

    await tick(ctx, T0, flow, 'flow')

    expect(seen).toEqual(['ping'])
    expect(flow.calls).toHaveLength(0) // гранулярные переходы не звались
    const u = currentUser(ctx, user.id)
    expect(u.state).toBe('awaiting_before')
    expect(u.due_kind).toBe('skip_deadline')
    expect(u.due_at).toBeGreaterThan(T0)
  })
})

describe('контракт с ядром переходов', () => {
  /**
   * Планировщик зовёт flow.* по сигнатурам §5.6. Эта проверка ловит расхождение
   * на компиляции и на импорте — раньше, чем оно проявится в бою тем, что вечер
   * не пришёл. Импорт динамический: тесту планировщика незачем тащить grammY,
   * пока он не проверяет именно этот стык.
   */
  it('src/bot/flow.ts даёт всё, что нужно планировщику (§5.6)', async () => {
    const mod = await import('../src/bot/flow.ts')
    const contract: SchedulerFlow = mod

    for (const key of ['startEvening', 'askAfter', 'skipEvening', 'finale', 'pause'] as const) {
      expect(typeof contract[key]).toBe('function')
    }
    // День восьмой и лок ядра — необязательные точки: если они есть, берём их.
    expect(typeof (contract.sendDay8 ?? contract.day8)).toBe('function')
    expect(typeof contract.withUserLock).toBe('function')
  })

  it('loadFlow находит ядро и проверяет состав экспортов', async () => {
    const loaded = await loadFlow('../bot/flow.ts')
    expect(typeof loaded.startEvening).toBe('function')
    await expect(loadFlow('../db/users.ts')).rejects.toThrow(/§5.6/)
  })
})

describe('таблица сроков §3.4', () => {
  it('обычный режим: таймер «после» не короче двенадцати минут и длиннее записи на три', () => {
    const db = testDb()
    const ctx = ctxWithDoubles({ db })
    const u = makeUser(db, { state: 'idle' })
    const t = timingsFor(ctx, u)

    expect(t.afterTimeout(null)).toBe(REAL.afterMinSec)
    expect(t.afterTimeout(300)).toBe(REAL.afterMinSec)
    expect(t.afterTimeout(600)).toBe(600 + REAL.afterTailSec)
    expect(t.nowBeforeTimeout(T0)).toBe(T0 + REAL.nowBeforeSec)
    expect(t.nowAfterTimeout(T0)).toBe(T0 + REAL.nowAfterSec)
    expect(t.silenceSec()).toBe(72 * 3600)
  })

  it('вечернее окно открыто за час до вечернего часа и закрывается в 04:00', () => {
    const ctx = ctxWithDoubles()
    const u = makeUser(ctx.db, { state: 'idle', tz_offset_min: 180, evening_time: '21:00' })
    const t = timingsFor(ctx, u)
    const evening = t.nextEvening(u, T0)

    expect(t.eveningWindow(u, evening - 61 * 60)).toBe(false)
    expect(t.eveningWindow(u, evening - 59 * 60)).toBe(true)
    expect(t.eveningWindow(u, evening + 6 * 3600)).toBe(true) // 03:00 — те же ритуальные сутки
    expect(t.eveningWindow(u, evening + 8 * 3600)).toBe(false) // 05:00 — уже следующие
  })
})
