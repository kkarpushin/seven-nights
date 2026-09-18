/**
 * Приёмочный прогон из ТЗ: «прохожу все семь вечеров в ускоренном режиме».
 * §9.2 и §9.3 архитектуры, §3.6 design-bot.
 *
 * Здесь не проверяются слова — они проверяются в зоне диалога. Здесь проверяется
 * время: что семь вечеров действительно проходятся за минуты, что вечер засчитывается
 * ровно один на виртуальные сутки, что пропуск сдвигает программу, а не съедает
 * вечер, и что финал наступает на седьмом, а не на шестом и не на восьмом.
 *
 * Часы фейковые, Telegram подменён. Человек в прогоне отвечает сам: функция-водитель
 * смотрит на состояние и делает то, что сделал бы живой — присылает цифру, выбирает
 * категорию, жмёт «Готово».
 */

import { describe, expect, it } from 'vitest'
import { DEMO } from '../src/timings.ts'
import { seedTestPractices, T0 } from './helpers/db.ts'
import { runVirtual, type ClockCtx } from './helpers/clock.ts'
import {
  answerAfter,
  answerBefore,
  chooseCategory,
  createFlowDouble,
  ctxWithDoubles,
  currentUser,
  onboard,
  pressDone,
  type FlowDouble,
  type Outbox,
} from './helpers/flow-double.ts'

const MINUTE = 60

/** Ключи сообщений, ушедших человеку. */
function keys(outbox: Outbox): string[] {
  return outbox.filter((o) => o.kind === 'text').map((o) => o.key ?? '')
}

/**
 * Человек, отвечающий на каждый шаг. Вызывается перед каждым тиком, делает не больше
 * одного действия за шаг — так между «пришла цифра» и «выбрана категория» проходит
 * время, как у живого.
 */
function driver(ctx: ClockCtx, flow: FlowDouble, userId: number, opts: { skipEveningNo?: number } = {}) {
  return async (now: number): Promise<void> => {
    const u = currentUser(ctx, userId)
    const s = ctx.repo.sessions.active(u.id)
    if (!s) return
    // Один вечер человек пропускает намеренно: молчит, пока не сработает срок.
    // После первого пропуска (consecutive_skips = 1) тот же вечер отвечается.
    if (opts.skipEveningNo !== undefined && s.evening_no === opts.skipEveningNo && u.consecutive_skips === 0) return

    switch (u.state) {
      case 'awaiting_before':
        await answerBefore(ctx, flow, userId, 4, now)
        return
      case 'awaiting_state':
        await chooseCategory(ctx, flow, userId, 'sleep', now)
        return
      case 'practicing':
        await pressDone(ctx, flow, userId, now)
        return
      case 'awaiting_after':
        await answerAfter(ctx, flow, userId, 7, now)
        return
      default:
        return
    }
  }
}

function demoSetup() {
  const ctx = ctxWithDoubles() as ClockCtx & { outbox: Outbox }
  seedTestPractices(ctx.db)
  const flow = createFlowDouble()
  ctx.clock.setNow(T0)
  return { ctx, flow }
}

/** Засчитанные вечера круга: те, у которых ушло аудио. */
function countedEvenings(ctx: ClockCtx, userId: number) {
  return ctx.repo.sessions
    .runSessions(userId, 1)
    .filter((s) => s.practice_sent_at !== null)
    .sort((a, b) => (a.evening_no ?? 0) - (b.evening_no ?? 0))
}

describe('демо-режим: семь вечеров за пятнадцать минут', () => {
  it('от /start до финальной картинки и дня восьмого — без единого рассинхрона', async () => {
    const { ctx, flow } = demoSetup()
    const user = await onboard(ctx, flow, T0, { demo: true })

    const run = await runVirtual(ctx, flow, {
      stepSec: 5,
      maxSec: 40 * MINUTE,
      onStep: driver(ctx, flow, user.id),
      until: () => currentUser(ctx, user.id).day8_sent === 1,
    })

    expect(run.reached).toBe(true)
    // Ни одного упавшего обработчика и ни одного самолечения: если бы состояние и
    // вид срока хоть раз разошлись, здесь был бы ненулевой healed.
    expect(run.total.failed).toBe(0)
    expect(run.total.outcomes.healed).toBe(0)

    const u = currentUser(ctx, user.id)
    expect(u.state).toBe('completed')
    expect(u.current_evening).toBe(7)

    // Приёмка ТЗ: семь вечеров занимают минуты, а не неделю.
    const toFinale = (u.completed_at ?? 0) - T0
    expect(toFinale).toBeGreaterThan(0)
    expect(toFinale).toBeLessThanOrEqual(15 * MINUTE)
    expect(run.elapsedSec).toBeLessThanOrEqual(20 * MINUTE)

    // Один засчитанный вечер на одни виртуальные сутки.
    const evenings = countedEvenings(ctx, u.id)
    expect(evenings.map((s) => s.evening_no)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(new Set(evenings.map((s) => s.ritual_date)).size).toBe(7)
    expect(evenings[0].ritual_date).toBe('demo-0')
    expect(evenings[6].ritual_date).toBe('demo-6')

    // События: по одному на каждый вечер, финал один, день восьмой один.
    const types = ctx.repo.events.listForUser(u.id).map((e) => e.type)
    expect(types.filter((t) => t === 'practice_sent')).toHaveLength(7)
    expect(types.filter((t) => t === 'evening_done')).toHaveLength(7)
    expect(types.filter((t) => t === 'finished')).toHaveLength(1)
    expect(types.filter((t) => t === 'day8')).toHaveLength(1)

    // Картинка ушла ровно одна, и после дня восьмого бот молчит.
    expect(ctx.outbox.filter((o) => o.kind === 'photo')).toHaveLength(1)
    expect(keys(ctx.outbox).filter((k) => k === 'final.day8')).toHaveLength(1)

    const sentByDay8 = ctx.outbox.length
    const after = await runVirtual(ctx, flow, {
      stepSec: 30,
      maxSec: 10 * MINUTE,
      onStep: driver(ctx, flow, user.id),
    })
    expect(after.total.seen).toBe(0)
    expect(ctx.outbox.length).toBe(sentByDay8)
    expect(currentUser(ctx, user.id).due_at).toBeNull()

    // Владельцу ушли оба ключевых уведомления — начал и дошёл.
    const notes = ctx.repo.notifications.listForUser(u.id).map((n) => n.type)
    expect(notes).toContain('started')
    expect(notes).toContain('finished')
  })

  it('пропуск сдвигает программу: тот же вечер приходит снова и с другим текстом', async () => {
    const { ctx, flow } = demoSetup()
    const user = await onboard(ctx, flow, T0, { demo: true })

    const run = await runVirtual(ctx, flow, {
      stepSec: 5,
      maxSec: 60 * MINUTE,
      onStep: driver(ctx, flow, user.id, { skipEveningNo: 3 }),
      until: () => currentUser(ctx, user.id).day8_sent === 1,
    })

    expect(run.reached).toBe(true)
    const u = currentUser(ctx, user.id)

    // Пропущенный вечер не съеден: засчитанных всё равно семь, по порядку.
    const evenings = countedEvenings(ctx, u.id)
    expect(evenings.map((s) => s.evening_no)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(u.current_evening).toBe(7)

    // Сессия пропущенного вечера осталась в истории как abandoned и без аудио.
    const abandoned = ctx.repo.sessions.runSessions(u.id, 1).filter((s) => s.status === 'abandoned')
    expect(abandoned).toHaveLength(1)
    expect(abandoned[0].evening_no).toBe(3)
    expect(abandoned[0].practice_sent_at).toBeNull()

    // Виртуальные сутки пропуск тоже потратил: у повторного третьего вечера своя дата.
    expect(abandoned[0].ritual_date).toBe('demo-2')
    expect(evenings[2].ritual_date).toBe('demo-3')

    // Текст пинга после пропуска — свой (§3.3).
    const pings = keys(ctx.outbox).filter((k) => k.startsWith('ev.before_'))
    expect(pings).toContain('ev.before_after_skip')
    // Пропуск молчалив: между «не ответил» и следующим пингом человеку не пришло ничего.
    expect(ctx.repo.events.listForUser(u.id).filter((e) => e.type === 'evening_skipped')).toHaveLength(1)
  })

  it('финал наступает ровно на седьмом вечере, не раньше', async () => {
    const { ctx, flow } = demoSetup()
    const user = await onboard(ctx, flow, T0, { demo: true })

    // Останавливаемся, как только закрыт шестой вечер.
    await runVirtual(ctx, flow, {
      stepSec: 5,
      maxSec: 40 * MINUTE,
      onStep: driver(ctx, flow, user.id),
      until: () => currentUser(ctx, user.id).current_evening === 6 && currentUser(ctx, user.id).state === 'idle',
    })

    const afterSix = currentUser(ctx, user.id)
    expect(afterSix.state).toBe('idle')
    expect(afterSix.completed_at).toBeNull()
    expect(flow.calls.filter((c) => c === 'finale')).toHaveLength(0)
    expect(ctx.outbox.filter((o) => o.kind === 'photo')).toHaveLength(0)
    // Следующий вечер уже назначен — и он седьмой.
    expect(afterSix.due_kind).toBe('ping')
    expect(afterSix.due_at).toBe(ctx.clock.now() + DEMO.nextEveningSec)

    await runVirtual(ctx, flow, {
      stepSec: 5,
      maxSec: 10 * MINUTE,
      onStep: driver(ctx, flow, user.id),
      until: () => currentUser(ctx, user.id).state === 'completed',
    })

    expect(flow.calls.filter((c) => c === 'finale')).toHaveLength(1)
    expect(countedEvenings(ctx, user.id)).toHaveLength(7)
  })
})

describe('демо-режим: сроки между вечерами', () => {
  it('следующий вечер приходит через две минуты после закрытия, а не завтра', async () => {
    const { ctx, flow } = demoSetup()
    const user = await onboard(ctx, flow, T0, { demo: true })

    await runVirtual(ctx, flow, {
      stepSec: 5,
      maxSec: 5 * MINUTE,
      onStep: driver(ctx, flow, user.id),
      until: () => currentUser(ctx, user.id).state === 'idle' && currentUser(ctx, user.id).current_evening === 1,
    })

    const closedAt = ctx.clock.now()
    const u = currentUser(ctx, user.id)
    expect(u.due_kind).toBe('ping')
    expect(u.due_at).toBe(closedAt + DEMO.nextEveningSec)
  })

  it('таймер «после» в демо равен минуте: не ответил на «Готово» — вопрос придёт сам', async () => {
    const { ctx, flow } = demoSetup()
    const user = await onboard(ctx, flow, T0, { demo: true })

    // Водитель доводит до практики и там замолкает: «Готово» не жмём.
    await runVirtual(ctx, flow, {
      stepSec: 5,
      maxSec: 2 * MINUTE,
      onStep: async (now) => {
        const u = currentUser(ctx, user.id)
        if (u.state === 'awaiting_before') await answerBefore(ctx, flow, user.id, 4, now)
        else if (u.state === 'awaiting_state') await chooseCategory(ctx, flow, user.id, 'sleep', now)
      },
      until: () => currentUser(ctx, user.id).state === 'awaiting_after',
    })

    const s = ctx.repo.sessions.active(user.id)!
    expect(ctx.clock.now() - (s.practice_sent_at ?? 0)).toBeLessThanOrEqual(DEMO.afterSec + 5)
    expect(keys(ctx.outbox)).toContain('ev.after')
    // Утреннего догона в демо нет — ждём сразу следующего вечера.
    expect(currentUser(ctx, user.id).due_kind).toBe('ping_or_close')
  })
})
