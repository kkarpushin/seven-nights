/**
 * «Практика сейчас» и правило слияния.
 * §2.3 design-bot; строки 11, 15, 25, 28–31 таблицы переходов §3.2.
 *
 * Правило слияния — самое дорогое место этого экрана: внутри вечернего окна кнопка
 * обязана запускать СЕГОДНЯШНИЙ вечер программы, а не дополнительную практику.
 * Иначе человек делает две практики за вечер и не понимает, засчиталось ли.
 */

import { describe, expect, it } from 'vitest'
import { makeHarness, onboard, passEvening, T0, type Harness } from './helpers/bot.ts'

const EVENING_NOW = T0 + 12 * 3600

/** Человек в idle днём: вечернее окно закрыто. */
async function idleAtNoon(): Promise<Harness> {
  const h = await makeHarness()
  await onboard(h)
  h.clear()
  return h
}

describe('внесчётная сессия (строка 30)', () => {
  it('днём кнопка даёт практику, но вечер не засчитывает', async () => {
    const h = await idleAtNoon()
    await h.say('Практика сейчас')

    expect(h.lastText()).toBe('Как ты сейчас, от 0 до 10?')
    expect(h.user().state).toBe('awaiting_before')
    expect(h.user().state_before_now).toBe('idle')
    expect(h.user().due_kind).toBe('now_timeout_before')

    await h.say('3')
    expect(h.lastText()).toBe('Записала: 3 ▰▰▰▱▱▱▱▱▱▱\nЧто сейчас ближе?')
    // До 14:00 порядок категорий другой, и третья подписана «на день».
    expect(h.lastInline().map((b) => b.text)).toEqual([
      '🌅 Настроиться на день',
      '🌿 Тревога и стресс',
      '😴 Сон и расслабление',
    ])

    await h.tap(`cat:${h.user().active_session_id}:calm`)
    expect(h.calls('sendAudio')).toHaveLength(1)
    expect(h.calls('sendAudio')[0].payload.performer).toBe('Семь ночей')
    expect(h.user().current_evening).toBe(0)

    await h.tap(`done:${h.user().active_session_id}`)
    await h.say('6')

    // Закрытие без полоски пути: вечер не двигался.
    expect(h.lastText()).toBe('Записала: 6 ▰▰▰▰▰▰▱▱▱▱\nБыло 3, стало 6. На 3 деления легче.')
    expect(h.user().state).toBe('idle')
    expect(h.user().current_evening).toBe(0)
    expect(h.user().due_kind).toBe('ping')
    expect(h.ctx.repo.events.listForUser(h.user().id).some((e) => e.type === 'now_done')).toBe(true)
  })

  it('подпись к практике «сейчас» без обещания утреннего вопроса', async () => {
    const h = await idleAtNoon()
    await h.say('Практика сейчас')
    await h.say('3')
    await h.tap(`cat:${h.user().active_session_id}:sleep`)

    const caption = String(h.calls('sendAudio')[0].payload.caption)
    expect(caption).toContain('Найди место, где тебя не потревожат')
    expect(caption).not.toContain('Утром спрошу')
  })
})

describe('правило слияния (строка 29)', () => {
  it('вечером кнопка запускает вечер программы, а не вторую практику', async () => {
    const h = await makeHarness({ now: EVENING_NOW })
    await onboard(h)
    await h.say('Лучше в 21:00') // ушли в idle внутри вечернего окна
    h.clear()

    await h.say('Практика сейчас')
    expect(h.lastText()).toContain('Первый вечер из семи')
    expect(h.user().state).toBe('awaiting_before')
    expect(h.user().state_before_now).toBeNull()

    await passEvening(h, { before: 4, after: 6 })
    expect(h.user().current_evening).toBe(1)
    expect(h.lastText()).toContain('Вечер 1 из 7')
  })

  it('второй раз за тот же вечер — уже внесчётная практика', async () => {
    const h = await makeHarness({ now: EVENING_NOW })
    await onboard(h)
    await passEvening(h, { before: 4, after: 6 })
    h.clear()

    await h.say('Практика сейчас')
    expect(h.lastText()).toBe('Как ты сейчас, от 0 до 10?')
    expect(h.user().current_evening).toBe(1)
  })

  it('на паузе кнопка работает, но паузу не снимает', async () => {
    const h = await idleAtNoon()
    await h.say('пауза')
    h.clear()

    await h.say('Практика сейчас')
    expect(h.user().state_before_now).toBe('paused')
    await h.say('4')
    await h.tap(`cat:${h.user().active_session_id}:calm`)
    await h.say('7')

    expect(h.user().state).toBe('paused')
    expect(h.user().due_at).toBeNull()
  })

  it('в ожидании цифры «после» кнопка просит сначала цифру (строка 31)', async () => {
    const h = await makeHarness({ now: EVENING_NOW })
    await onboard(h)
    await h.say('4')
    await h.tap(`cat:${h.user().active_session_id}:sleep`)
    await h.tap(`done:${h.user().active_session_id}`)
    h.clear()

    await h.say('Практика сейчас')
    expect(h.lastText()).toBe('Сначала цифра: как ты сейчас, от 0 до 10? Потом дам ещё практику.')
    expect(h.user().state).toBe('awaiting_after')
    expect(h.calls('sendAudio')).toHaveLength(0)
  })
})

describe('таймауты сессии «сейчас»', () => {
  it('не ответил на «до» — сессия удаляется целиком (строка 15)', async () => {
    const h = await idleAtNoon()
    const dueBefore = h.user().due_at
    await h.say('Практика сейчас')

    h.setNow(h.user().due_at ?? 0)
    h.clear()
    await h.due('now_timeout_before')

    expect(h.texts()).toHaveLength(0)
    expect(h.ctx.repo.sessions.listForUser(h.user().id)).toHaveLength(0)
    expect(h.user().state).toBe('idle')
    expect(h.user().state_before_now).toBeNull()
    expect(h.user().due_at).toBe(dueBefore)
  })

  it('не прислал «после» — закрываем молча, практика остаётся в истории (строка 28)', async () => {
    const h = await idleAtNoon()
    await h.say('Практика сейчас')
    await h.say('4')
    await h.tap(`cat:${h.user().active_session_id}:calm`)
    await h.tap(`done:${h.user().active_session_id}`)

    h.setNow(h.user().due_at ?? 0)
    h.clear()
    await h.due('now_timeout_after')

    expect(h.texts()).toHaveLength(0)
    const session = h.ctx.repo.sessions.listForUser(h.user().id)[0]
    expect(session.status).toBe('done')
    expect(session.after_value).toBeNull()
    expect(h.user().state).toBe('idle')
  })

  it('вечерний пинг ждёт, пока идёт «Практика сейчас» (строка 11)', async () => {
    const h = await idleAtNoon()
    await h.say('Практика сейчас')
    await h.say('4')

    const now = h.ctx.clock.now()
    h.clear()
    await h.due('ping')

    expect(h.texts()).toHaveLength(0)
    expect(h.user().due_kind).toBe('ping')
    expect(h.user().due_at).toBe(now + 60)
    expect(h.user().state).toBe('awaiting_state')
  })
})
