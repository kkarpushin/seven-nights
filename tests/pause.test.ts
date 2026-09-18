/**
 * Пауза, возвращение, блокировка. §2.5, §2.9 design-bot; строки 32–34, 41–42 §3.2.
 *
 * Постоянной кнопки «Пауза» в продукте нет намеренно: приглашение бросить не должно
 * висеть на экране каждый вечер. Поэтому пауза ставится словом — и слово обязано
 * работать в любой момент ожидания, в том числе посреди сессии.
 */

import { describe, expect, it } from 'vitest'
import { markBlocked } from '../src/bot/send.ts'
import { makeHarness, onboard, T0, type Harness } from './helpers/bot.ts'

const EVENING_NOW = T0 + 12 * 3600

async function idleAtNoon(): Promise<Harness> {
  const h = await makeHarness()
  await onboard(h)
  h.clear()
  return h
}

describe('пауза словом (строка 32)', () => {
  it('«пауза» из ожидания цифры закрывает сессию как отказ', async () => {
    const h = await makeHarness({ now: EVENING_NOW })
    await onboard(h)
    h.clear()

    await h.say('пауза')

    expect(h.lastText()).toBe('Поставила на паузу. Ничего не сгорает. Когда захочешь — нажми «Продолжить».')
    expect(h.lastReplyRows()).toEqual([['Продолжить'], ['Практика сейчас']])
    expect(h.user().state).toBe('paused')
    expect(h.user().due_at).toBeNull()
    expect(h.user().paused_at).toBe(h.ctx.clock.now())
    expect(h.ctx.repo.sessions.listForUser(h.user().id)[0].status).toBe('declined')
  })

  it('«стоп» во время практики закрывает вечер как состоявшийся', async () => {
    const h = await makeHarness({ now: EVENING_NOW })
    await onboard(h)
    await h.say('4')
    await h.tap(`cat:${h.user().active_session_id}:sleep`)
    h.clear()

    await h.say('стоп')

    expect(h.user().state).toBe('paused')
    // Аудио ушло — вечер засчитан, и пауза этого не отменяет.
    expect(h.user().current_evening).toBe(1)
    const session = h.ctx.repo.sessions.listForUser(h.user().id)[0]
    expect(session.status).toBe('done')
    expect(session.after_value).toBeNull()
  })

  it('«хватит» из idle тоже пауза, а внутри длинной фразы — нет', async () => {
    const h = await idleAtNoon()
    await h.say('хватит')
    expect(h.user().state).toBe('paused')

    const other = await idleAtNoon()
    await other.say('я не могу остановиться и это тяжело')
    expect(other.user().state).toBe('idle')
  })

  it('в онбординге слово паузы — обычный текст, а не пауза', async () => {
    const h = await makeHarness()
    await h.say('/start')
    h.clear()
    await h.say('стоп')

    expect(h.user().state).toBe('onb_hour')
    expect(h.lastText()).toBe('Напиши час как на часах, например 21:30.')
  })

  it('свободный текст и /start на паузе отвечают по-своему', async () => {
    const h = await idleAtNoon()
    await h.say('пауза')
    h.clear()

    await h.say('мне сегодня тяжело')
    expect(h.lastText()).toBe('Сейчас пауза. Передала твоё сообщение. Нажми «Продолжить», и вечером спрошу.')
    expect(h.ctx.repo.messages.countForUser(h.user().id)).toBe(1)

    await h.say('/start')
    expect(h.lastText()).toBe('Сейчас пауза. Вечер 1 из 7 ждёт.')
    expect(h.lastInline().map((b) => b.data)).toEqual(['chtime'])
  })
})

describe('возвращение (строки 33–34)', () => {
  it('днём «Продолжить» возвращает в ожидание вечера и обнуляет пропуски', async () => {
    const h = await idleAtNoon()
    h.ctx.repo.users.update(h.user().id, { consecutive_skips: 2, current_evening: 2 })
    await h.say('пауза')
    h.clear()

    await h.say('Продолжить')

    expect(h.lastText()).toBe('Продолжаем. Вечер 3 из 7 — сегодня в 21:00.')
    expect(h.user().state).toBe('idle')
    expect(h.user().consecutive_skips).toBe(0)
    expect(h.user().due_kind).toBe('ping')
    expect(h.ctx.repo.events.listForUser(h.user().id).some((e) => e.type === 'resumed')).toBe(true)
  })

  it('вечером «Продолжить» сразу открывает вечер', async () => {
    const h = await makeHarness({ now: EVENING_NOW })
    await onboard(h)
    await h.say('пауза')
    h.clear()

    await h.say('Продолжить')

    expect(h.lastText()).toContain('Первый вечер из семи')
    expect(h.user().state).toBe('awaiting_before')
    expect(h.user().due_kind).toBe('skip_deadline')
  })

  it('вечер, уже пройденный сегодня, второй раз не открывается', async () => {
    const h = await makeHarness({ now: EVENING_NOW })
    await onboard(h)
    await h.say('4')
    await h.tap(`cat:${h.user().active_session_id}:sleep`)
    await h.say('7')
    await h.say('пауза')
    h.clear()

    await h.say('Продолжить')

    expect(h.lastText()).toContain('Продолжаем. Вечер 2 из 7')
    expect(h.user().state).toBe('idle')
    expect(h.user().current_evening).toBe(1)
  })
})

describe('блокировка (строки 41–42)', () => {
  it('403 переводит в blocked, гасит таймер и уведомляет владельца', async () => {
    const h = await makeHarness({ now: EVENING_NOW })
    await onboard(h)
    const before = h.user()
    expect(before.state).toBe('awaiting_before')

    markBlocked(h.ctx, before, h.ctx.clock.now())

    const u = h.user()
    expect(u.state).toBe('blocked')
    expect(u.state_before_block).toBe('awaiting_before')
    expect(u.due_at).toBeNull()
    expect(h.ctx.repo.sessions.listForUser(u.id)[0].status).toBe('declined')
    expect(h.ctx.repo.notifications.pending(10).some((n) => n.type === 'blocked')).toBe(true)
  })

  it('вернулся — состояние и срок восстанавливаются, не сессия', async () => {
    const h = await makeHarness({ now: EVENING_NOW })
    await onboard(h)
    markBlocked(h.ctx, h.user(), h.ctx.clock.now())
    h.clear()

    await h.say('/start')

    const u = h.user()
    // Внутрь незакрытой сессии не возвращаем: вопроса на экране уже нет.
    expect(u.state).toBe('idle')
    expect(u.blocked_at).toBeNull()
    expect(u.due_kind).toBe('ping')
    expect(h.ctx.repo.events.listForUser(u.id).some((e) => e.type === 'unblocked')).toBe(true)
    expect(h.lastText()).toContain('Ты на вечере 1 из 7')
  })
})

describe('403 приходит настоящим путём, через Sender', () => {
  it('человек заблокировал бота — переход происходит на первой же отправке', async () => {
    const h = await makeHarness()
    await onboard(h)
    h.fail({ error_code: 403, description: 'Forbidden: bot was blocked by the user' })

    // Исключение наружу не выходит: обработчик обновления не должен падать.
    await h.say('привет')

    const u = h.user()
    expect(u.state).toBe('blocked')
    expect(u.state_before_block).toBe('idle')
    expect(u.due_at).toBeNull()
    expect(h.ctx.repo.notifications.pending(10).some((n) => n.type === 'blocked')).toBe(true)
  })

  it('пинг тому, кто заблокировал, гасит таймер, а не копит попытки', async () => {
    const h = await makeHarness()
    await onboard(h)
    h.setNow(h.user().due_at ?? 0)
    h.fail({ error_code: 403, description: 'Forbidden: bot was blocked by the user' })

    await h.due('ping')

    expect(h.user().state).toBe('blocked')
    // Сессия, открытая под неотправленный пинг, не должна остаться висеть.
    expect(h.ctx.repo.sessions.active(h.user().id)).toBeUndefined()
  })
})
