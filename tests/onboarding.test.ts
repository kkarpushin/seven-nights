/**
 * Онбординг и смена времени. §2.1, §2.9, §2.10 design-bot; строки 1–7, 37–40 §3.2.
 *
 * Главная проверка файла — приёмочный критерий простоты: пять касаний от /start
 * до звучащей практики. Он держится на двух вещах: про часовой пояс не спрашивают
 * (спрашивают время на часах), и вечером первый вечер начинается сразу.
 */

import { describe, expect, it } from 'vitest'
import { localHm } from '../src/time.ts'
import { clockLabelFor, makeHarness, onboard, T0 } from './helpers/bot.ts'

/** Момент, когда вечернее окно уже открыто: 20:20 по местному времени (UTC+3). */
const EVENING_NOW = T0 + 12 * 3600

describe('первые три вопроса', () => {
  it('/start здоровается и спрашивает час; в меню команд нет', async () => {
    const h = await makeHarness()
    await h.say('/start')

    expect(h.texts()[0]).toContain('Это «Семь ночей»')
    expect(h.lastText()).toBe('Во сколько вечером тебе удобно получать практику?')
    expect(h.lastReplyRows()).toEqual([['21:00', '22:00', '23:00'], ['Другое время']])
    expect(h.user().state).toBe('onb_hour')
  })

  it('индекс с лендинга упоминается ровно один раз и становится точкой отсчёта', async () => {
    const h = await makeHarness()
    await h.say('/start q42')

    // 42 из 70 → индекс 60 (округление по сумме, §«Подсчёт» quiz-spec).
    expect(h.texts()[1]).toBe(
      'Твой индекс опоры сейчас 60 из ста. Это точка отсчёта, к ней вернёмся через семь вечеров.',
    )
    expect(h.user().quiz_sum).toBe(42)
    expect(h.user().quiz_index).toBe(60)
    expect(h.ctx.repo.events.listForUser(h.user().id).some((e) => e.type === 'quiz_in')).toBe(true)
  })

  it('невалидный payload игнорируется молча: про тест ни слова', async () => {
    const h = await makeHarness()
    await h.say('/start q71')

    expect(h.texts().some((t) => t.includes('индекс'))).toBe(false)
    expect(h.user().quiz_sum).toBeNull()
    expect(h.user().start_payload).toBe('q71')
  })

  it('нераспознанный час переспрашивают, состояние не двигается', async () => {
    const h = await makeHarness()
    await h.say('/start')
    h.clear()
    await h.say('когда-нибудь вечером')

    expect(h.lastText()).toBe('Напиши час как на часах, например 21:30.')
    expect(h.user().state).toBe('onb_hour')
  })

  it('«9 вечера» это 21:00, дальше спрашивают часы, а не часовой пояс', async () => {
    const h = await makeHarness()
    await h.say('/start')
    h.clear()
    await h.say('9 вечера')

    expect(h.user().evening_time).toBe('21:00')
    expect(h.lastText()).toContain('Поняла, 21:00')
    expect(h.lastText()).toContain('Сколько сейчас у тебя на часах?')
    expect(h.user().state).toBe('onb_clock')

    // Три кнопки: гипотеза и соседние пояса; минуты у всех одинаковые.
    const rows = h.lastReplyRows()
    expect(rows[0]).toHaveLength(3)
    expect(rows[1]).toEqual(['Другое'])
    const minutes = rows[0].map((t) => t.slice(3))
    expect(new Set(minutes).size).toBe(1)
  })

  it('гипотеза пояса берётся из языка клиента', async () => {
    const h = await makeHarness({ languageCode: 'kk' })
    await h.say('/start')
    await h.say('21:00')

    // kk → +5: первая кнопка показывает время в этом поясе.
    expect(h.lastReplyRows()[0][0]).toBe(clockLabelFor(h, 300))
  })
})

describe('развилка по вечернему окну (строки 5–6)', () => {
  it('днём: программа начинается вечером, до этого делать нечего', async () => {
    const h = await makeHarness()
    await onboard(h)

    const u = h.user()
    expect(h.lastText()).toBe(
      'Открыла тебе семь вечеров. Первая практика — сегодня в 21:00. До вечера можно ничего не делать, я напишу сама.',
    )
    expect(h.lastReplyRows()).toEqual([['Практика сейчас']])
    expect(u.state).toBe('idle')
    expect(u.due_kind).toBe('ping')
    expect(localHm(u, u.due_at ?? 0)).toEqual({ h: 21, m: 0 })
    expect(u.tz_offset_min).toBe(180)
  })

  it('вечером: первый вечер начинается сразу, пять касаний до практики', async () => {
    const h = await makeHarness({ now: EVENING_NOW })
    await onboard(h) // 3 касания: /start, час, часы

    expect(h.texts()).toContain('Открыла тебе семь вечеров. Первый можно начать прямо сейчас.')
    expect(h.lastText()).toContain('Первый вечер из семи')
    expect(h.lastReplyRows()[2]).toEqual(['Лучше в 21:00'])
    expect(h.user().state).toBe('awaiting_before')

    await h.say('4') // 4-е касание
    expect(h.lastText()).toContain('Записала: 4 ▰▰▰▰▱▱▱▱▱▱')

    await h.tap(`cat:${h.user().active_session_id}:sleep`) // 5-е касание
    expect(h.methods()).toContain('sendAudio')
    expect(h.user().current_evening).toBe(1)
    expect(h.user().state).toBe('practicing')
  })

  it('«Лучше в 21:00» переносит первый вечер и не оставляет следов', async () => {
    const h = await makeHarness({ now: EVENING_NOW })
    await onboard(h)
    h.clear()
    await h.say('Лучше в 21:00')

    expect(h.lastText()).toContain('Первая практика')
    expect(h.user().state).toBe('idle')
    expect(h.user().current_evening).toBe(0)
    expect(h.ctx.repo.sessions.listForUser(h.user().id)).toHaveLength(0)
  })

  it('уведомление владельцу о новом участнике уходит один раз', async () => {
    const h = await makeHarness()
    await onboard(h)

    const pending = h.ctx.repo.notifications.pending(10)
    expect(pending.map((n) => n.type)).toEqual(['started'])
    expect(pending[0].text).toBe('🟢 Новый участник #1. Вечер в 21:00, пояс UTC+3.')
  })
})

describe('повторный /start и смена времени (§2.9)', () => {
  it('/start в idle не сбрасывает прогресс и даёт «Поменять время»', async () => {
    const h = await makeHarness()
    await onboard(h)
    h.ctx.repo.users.update(h.user().id, { current_evening: 3 })
    h.clear()

    await h.say('/start')
    expect(h.lastText()).toBe('Ты на вечере 4 из 7. сегодня в 21:00 пришлю практику.')
    expect(h.lastInline()).toEqual([{ text: 'Поменять время', data: 'chtime', url: undefined }])
    expect(h.user().current_evening).toBe(3)
  })

  it('/start с новым индексом не перезаписывает точку отсчёта', async () => {
    const h = await makeHarness()
    await onboard(h, { payload: 'q42' })
    await h.say('/start q70')

    expect(h.user().quiz_sum).toBe(42)
    expect(h.ctx.repo.events.listForUser(h.user().id).filter((e) => e.type === 'quiz_in')).toHaveLength(2)
  })

  it('«Поменять время» проходит два вопроса и пересчитывает срок', async () => {
    const h = await makeHarness()
    await onboard(h)
    h.clear()

    await h.tap('chtime')
    expect(h.lastText()).toBe('Во сколько удобно получать практику?')
    expect(h.user().state).toBe('change_hour')

    await h.say('22:30')
    expect(h.user().state).toBe('change_clock')

    await h.say(clockLabelFor(h, 180))
    expect(h.lastText()).toContain('Теперь буду писать в 22:30')
    expect(h.user().state).toBe('idle')
    expect(h.user().evening_time).toBe('22:30')
    expect(localHm(h.user(), h.user().due_at ?? 0)).toEqual({ h: 22, m: 30 })
    expect(h.ctx.repo.events.listForUser(h.user().id).some((e) => e.type === 'hour_changed')).toBe(true)
  })

  it('смена времени на паузе оставляет паузу паузой', async () => {
    const h = await makeHarness()
    await onboard(h)
    await h.say('пауза')
    expect(h.user().state).toBe('paused')

    await h.tap('chtime')
    await h.say('22:00')
    await h.say(clockLabelFor(h, 180))

    expect(h.user().state).toBe('paused')
    expect(h.user().due_at).toBeNull()
  })
})

describe('скрытые команды (строки 54–56)', () => {
  it('/whoami называет оба номера — чтобы вписать себя в ADMIN_TG_IDS', async () => {
    const h = await makeHarness()
    await onboard(h)
    h.clear()

    await h.say('/whoami')
    expect(h.lastText()).toBe(`Твой telegram id: ${h.tgId}. Номер участника: #1.`)
  })

  it('/demo с верным секретом ускоряет сроки и переставляет таймер', async () => {
    const h = await makeHarness()
    await onboard(h)
    h.clear()

    await h.say('/demo testsecret')

    expect(h.lastText()).toBe('Демо-режим: вечер длится пару минут.')
    expect(h.user().demo).toBe(1)
    // Вечер теперь через две минуты, а не завтра в 21:00.
    expect(h.user().due_at).toBe(h.ctx.clock.now() + 120)

    await h.say('/demo testsecret')
    expect(h.lastText()).toBe('Демо-режим выключен.')
    expect(h.user().demo).toBe(0)
  })

  it('неверный секрет не выдаёт существование команды', async () => {
    const h = await makeHarness()
    await onboard(h)
    h.clear()

    await h.say('/demo подобрал')

    expect(h.user().demo).toBe(0)
    expect(h.lastText()).toContain('Передала') // обычный свободный текст
  })

  it('/reset стирает человека: следующий /start — новый участник', async () => {
    const h = await makeHarness()
    await onboard(h)
    const firstId = h.user().id
    h.clear()

    await h.say('/reset testsecret')
    expect(h.lastText()).toBe('Готово.')
    expect(h.ctx.repo.users.byTgId(h.tgId)).toBeUndefined()

    await h.say('/start')
    expect(h.user().id).not.toBe(firstId)
    expect(h.user().state).toBe('onb_hour')
    expect(h.ctx.repo.sessions.listForUser(h.user().id)).toHaveLength(0)
  })
})

describe('демо-прогон целиком', () => {
  it('семь вечеров проходятся подряд на виртуальных сутках', async () => {
    const h = await makeHarness()
    await onboard(h)
    await h.say('/demo testsecret')

    for (let n = 1; n <= 7; n++) {
      h.setNow(h.user().due_at ?? 0)
      await h.due('ping')
      await h.say('4')
      await h.tap(`cat:${h.user().active_session_id}:sleep`)
      await h.tap(`done:${h.user().active_session_id}`)
      await h.say('8')
      expect(h.user().current_evening).toBe(n)
      expect(h.user().demo_day_counter).toBe(n)
    }

    expect(h.user().state).toBe('completed')
    // Инвариант «один вечер на дату» продолжает работать на виртуальных сутках.
    const dates = h.ctx.repo.sessions.runSessions(h.user().id, 1).map((s) => s.ritual_date)
    expect(new Set(dates).size).toBe(7)
  })
})
