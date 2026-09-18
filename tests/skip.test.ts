/**
 * Пропуск вечера, «Не сегодня», автопауза.
 * §2.4 design-bot; строки 9, 10, 13, 14 таблицы переходов §3.2.
 *
 * Правило, ради которого написан весь файл: **программа сдвигается, а не теряется**.
 * Номер вечера при пропуске не растёт — был третий, завтра снова третий. Человек
 * услышит все семь практик, просто календарных дней уйдёт больше. И ни одного
 * слова упрёка: следующим текстом будет «Вчера не получилось, это нормально».
 */

import { describe, expect, it } from 'vitest'
import { makeHarness, onboard, T0, type Harness } from './helpers/bot.ts'

const EVENING_NOW = T0 + 12 * 3600

async function startedInEvening(): Promise<Harness> {
  const h = await makeHarness({ now: EVENING_NOW })
  await onboard(h)
  return h
}

/** Вечер открыт, человек молчит до 04:00. */
async function letEveningExpire(h: Harness): Promise<void> {
  h.setNow(h.user().due_at ?? 0)
  await h.due('skip_deadline')
}

/** Дождаться следующего вечернего пинга. */
async function nextPing(h: Harness): Promise<void> {
  h.setNow(h.user().due_at ?? 0)
  await h.due('ping')
}

describe('молчание до 04:00 (строка 14)', () => {
  it('вечер помечается пропущенным молча, кнопки снимаются', async () => {
    const h = await startedInEvening()
    h.clear()
    await letEveningExpire(h)

    expect(h.texts()).toHaveLength(0) // ни одного сообщения — это и есть «без упрёка»
    expect(h.methods()).toContain('editMessageReplyMarkup')

    const session = h.ctx.repo.sessions.listForUser(h.user().id)[0]
    expect(session.status).toBe('abandoned')
    expect(h.user().consecutive_skips).toBe(1)
    expect(h.user().current_evening).toBe(0)
    expect(h.user().state).toBe('idle')
    expect(h.user().due_kind).toBe('ping')
  })

  it('введённая цифра «до» сохраняется даже у брошенного вечера', async () => {
    const h = await startedInEvening()
    await h.say('4')
    await letEveningExpire(h)

    const session = h.ctx.repo.sessions.listForUser(h.user().id)[0]
    expect(session.before_value).toBe(4)
    expect(session.status).toBe('abandoned')
  })

  it('номер вечера не растёт: пропущенный первый остаётся первым', async () => {
    const h = await startedInEvening()
    await letEveningExpire(h)
    h.clear()
    await nextPing(h)

    expect(h.lastText()).toBe(
      'Вчера не получилось, это нормально. Продолжим с того места, где остановились. Вечер 1 из 7. Как ты сейчас, от 0 до 10?',
    )

    // И этот вечер проходится как первый — программа сдвинулась, а не потерялась.
    await h.say('5')
    await h.tap(`cat:${h.user().active_session_id}:sleep`)
    expect(h.user().current_evening).toBe(1)
    expect(h.user().consecutive_skips).toBe(0)
  })

  it('после двух пропусков преамбула другая', async () => {
    const h = await startedInEvening()
    await letEveningExpire(h)
    await nextPing(h)
    await letEveningExpire(h)
    h.clear()
    await nextPing(h)

    expect(h.lastText()).toContain('Несколько дней не получилось, это нормально')
    expect(h.user().consecutive_skips).toBe(2)
  })

  it('третий пропуск — пауза вместо четвёртого пинга (строка 10)', async () => {
    const h = await startedInEvening()
    await letEveningExpire(h)
    await nextPing(h)
    await letEveningExpire(h)
    await nextPing(h)
    await letEveningExpire(h)
    h.clear()
    await nextPing(h)

    expect(h.lastText()).toBe(
      'Три вечера без практики. Поставила на паузу, чтобы не дёргать тебя. Когда захочешь — нажми «Продолжить».',
    )
    expect(h.lastReplyRows()).toEqual([['Продолжить'], ['Практика сейчас']])
    expect(h.user().state).toBe('paused')
    expect(h.user().due_at).toBeNull()
    expect(h.ctx.repo.events.listForUser(h.user().id).some((e) => e.type === 'autopaused')).toBe(true)
  })

  it('протухший пинг (сервер лежал сутки) считается пропуском без сообщения', async () => {
    const h = await makeHarness()
    await onboard(h)
    // Пинг ждал 21:00, а процесс поднялся в полдень следующего дня.
    h.setNow((h.user().due_at ?? 0) + 15 * 3600)
    h.clear()
    await h.due('ping')

    expect(h.texts()).toHaveLength(0)
    expect(h.user().consecutive_skips).toBe(1)
    expect(h.user().state).toBe('idle')
  })
})

describe('«Не сегодня» (строка 13)', () => {
  it('отказ не считается пропуском и обещает написать завтра', async () => {
    const h = await startedInEvening()
    h.clear()
    await h.say('Не сегодня')

    expect(h.lastText()).toBe('Хорошо. Напишу завтра в 21:00.')
    expect(h.lastReplyRows()).toEqual([['Практика сейчас']])
    expect(h.ctx.repo.sessions.listForUser(h.user().id)[0].status).toBe('declined')
    // Сознательный отказ — не молчание: до автопаузы он не приближает.
    expect(h.user().consecutive_skips).toBe(0)
    expect(h.user().not_today_streak).toBe(1)
    expect(h.user().due_kind).toBe('ping')
  })

  it('второе «Не сегодня» подряд предлагает паузу', async () => {
    const h = await startedInEvening()
    await h.say('Не сегодня')
    await nextPing(h)
    h.clear()
    await h.say('Не сегодня')

    expect(h.lastText()).toBe('Хорошо. Хочешь, поставлю на паузу? Практики никуда не денутся.')
    expect(h.lastReplyRows()).toEqual([['Пауза'], ['Завтра напомни']])
    expect(h.user().not_today_streak).toBe(2)
    expect(h.user().state).toBe('idle')
  })

  it('«Завтра напомни» оставляет программу идти', async () => {
    const h = await startedInEvening()
    await h.say('Не сегодня')
    await nextPing(h)
    await h.say('Не сегодня')
    h.clear()
    await h.say('Завтра напомни')

    expect(h.lastText()).toBe('Хорошо. Напишу завтра в 21:00.')
    expect(h.user().state).toBe('idle')
    expect(h.user().due_kind).toBe('ping')
  })

  it('«Пауза» из предложения ставит на паузу', async () => {
    const h = await startedInEvening()
    await h.say('Не сегодня')
    await nextPing(h)
    await h.say('Не сегодня')
    h.clear()
    await h.say('Пауза')

    expect(h.lastText()).toContain('Поставила на паузу')
    expect(h.user().state).toBe('paused')
  })
})
