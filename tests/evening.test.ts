/**
 * Вечерний ритуал и полный проход семи вечеров.
 * §2.2 design-bot; строки 8, 12, 16, 19, 22, 23, 49, 50 таблицы переходов §3.2.
 *
 * Самая важная проверка здесь — «вечер засчитан в момент отправки аудио». От неё
 * зависит всё остальное: и полоска пути, и график, и то, что уснувший под практику
 * человек считается прошедшим вечер, а не пропустившим его.
 */

import { describe, expect, it } from 'vitest'
import { makeHarness, onboard, passEvening, T0, type Harness } from './helpers/bot.ts'

const EVENING_NOW = T0 + 12 * 3600

/** Онбординг внутри вечернего окна: первый вечер уже открыт, ждём цифру «до». */
async function startedInEvening(opts: { payload?: string } = {}): Promise<Harness> {
  const h = await makeHarness({ now: EVENING_NOW })
  await onboard(h, { payload: opts.payload })
  return h
}

/** Перевести часы на следующий вечер и дать планировщику сработать. */
async function jumpToNextEvening(h: Harness): Promise<void> {
  const due = h.user().due_at
  expect(due).not.toBeNull()
  h.setNow(due ?? 0)
  await h.due()
}

describe('шаги вечера', () => {
  it('цифра «до» превращается в полоску и вопрос категории одним сообщением', async () => {
    const h = await startedInEvening()
    h.clear()
    await h.say('4')

    expect(h.lastText()).toBe('Записала: 4 ▰▰▰▰▱▱▱▱▱▱\nЧто сегодня ближе?')
    expect(h.lastInline().map((b) => b.text)).toEqual([
      '😴 Сон и расслабление',
      '🌿 Тревога и стресс',
      '🌅 Настроиться на завтра',
    ])
    expect(h.user().state).toBe('awaiting_state')
  })

  it('вечер засчитан в момент отправки аудио, а не по «Готово»', async () => {
    const h = await startedInEvening()
    await h.say('4')
    expect(h.user().current_evening).toBe(0)

    await h.tap(`cat:${h.user().active_session_id}:sleep`)
    expect(h.user().current_evening).toBe(1)
    expect(h.user().state).toBe('practicing')

    const audio = h.calls('sendAudio')[0]
    expect(audio.payload.performer).toBe('Семь ночей · Вечер 1')
    expect(String(audio.payload.caption)).toContain('Ложись, надень наушники и просто слушай.')
    // Разрешение уснуть выдано до практики — только для категории «сон».
    expect(String(audio.payload.caption)).toContain('Если уснёшь — хорошо. Утром спрошу, как ты.')
    expect(h.ctx.repo.plays.countFor(h.user().id)).toBe(1)
  })

  it('дабл-тап по категории не отправляет две практики', async () => {
    const h = await startedInEvening()
    await h.say('4')
    const sid = h.user().active_session_id
    h.clear()

    await Promise.all([h.tap(`cat:${sid}:sleep`), h.tap(`cat:${sid}:calm`)])

    expect(h.calls('sendAudio')).toHaveLength(1)
    expect(h.ctx.repo.plays.countFor(h.user().id)).toBe(1)
    expect(h.user().current_evening).toBe(1)
  })

  it('протухшая кнопка категории отвечает «Это уже прошло»', async () => {
    const h = await startedInEvening()
    await h.say('4')
    h.clear()
    await h.tap('cat:999:sleep')

    expect(h.calls('answerCallbackQuery')[0].payload.text).toBe('Это уже прошло')
    expect(h.calls('sendAudio')).toHaveLength(0)
  })

  it('цифра вместо «Готово» закрывает вечер сразу, без лишнего вопроса', async () => {
    const h = await startedInEvening()
    await h.say('4')
    await h.tap(`cat:${h.user().active_session_id}:sleep`)
    h.clear()

    await h.say('7')

    expect(h.texts().some((t) => t === 'А сейчас как, от 0 до 10?')).toBe(false)
    expect(h.lastText()).toContain('Было 4, стало 7. На 3 деления легче.')
    const session = h.ctx.repo.sessions.listForUser(h.user().id)[0]
    expect(session.after_source).toBe('early')
    expect(session.status).toBe('done')
  })

  it('закрытие вечера показывает полоску пути и «До завтра»', async () => {
    const h = await startedInEvening()
    await passEvening(h, { before: 4, after: 7 })

    expect(h.lastText()).toBe('Записала: 7 ▰▰▰▰▰▰▰▱▱▱\nБыло 4, стало 7. На 3 деления легче.\n●○○○○○○ Вечер 1 из 7. До завтра.')
    expect(h.lastReplyRows()).toEqual([['Практика сейчас']])
    expect(h.user().state).toBe('idle')
    expect(h.user().due_kind).toBe('ping')
  })

  it('разница названа словами во всех трёх случаях', async () => {
    const same = await startedInEvening()
    await passEvening(same, { before: 5, after: 5 })
    expect(same.lastText()).toContain('Ровно. Тоже честный ответ.')

    const down = await startedInEvening()
    await passEvening(down, { before: 6, after: 4 })
    expect(down.lastText()).toContain('Ниже на 2. Бывает, это тоже часть недели.')

    const one = await startedInEvening()
    await passEvening(one, { before: 6, after: 7 })
    expect(one.lastText()).toContain('На 1 деление легче.')
  })
})

describe('не цифра вместо цифры (§2.6)', () => {
  it('короткий текст — просто просят цифру, клавиатура остаётся', async () => {
    const h = await startedInEvening()
    h.clear()
    await h.say('не знаю')

    expect(h.lastText()).toBe('Мне нужна просто цифра от 0 до 10. Можно нажать на клавиатуре.')
    expect(h.lastReplyRows()[0]).toEqual(['0', '1', '2', '3', '4', '5'])
    expect(h.user().state).toBe('awaiting_before')
  })

  it('дробь и выход за диапазон отвечают по-разному', async () => {
    const h = await startedInEvening()
    h.clear()
    await h.say('6,5')
    expect(h.lastText()).toBe('Только целое. 6 или 7?')

    await h.say('15')
    expect(h.lastText()).toBe('От 0 до 10 — какая ближе?')
  })

  it('длинный текст доходит до специалиста и ждёт цифру', async () => {
    const h = await startedInEvening()
    h.clear()
    const story = 'Сегодня был очень тяжёлый день, я поссорилась с сестрой и до сих пор не могу успокоиться'
    await h.say(story)

    expect(h.lastText()).toBe('Слышу тебя. Передала. Чтобы я могла это записать — одной цифрой, от 0 до 10.')
    const messages = h.ctx.repo.messages.listForUser(h.user().id)
    expect(messages[0].text).toBe(story)
    expect(messages[0].state_at_moment).toBe('awaiting_before')
    expect(h.ctx.repo.notifications.pending(10).some((n) => n.type === 'message')).toBe(true)
  })

  it('в ожидании категории повторяется вопрос о категории, а не о цифре', async () => {
    const h = await startedInEvening()
    await h.say('4')
    h.clear()
    await h.say('что-то не то')

    expect(h.lastText()).toContain('Что сегодня ближе?')
    expect(h.lastInline()).toHaveLength(3)
    expect(h.user().state).toBe('awaiting_state')
  })

  it('во время практики бот зовёт к «Готово» и не шлёт второе аудио', async () => {
    const h = await startedInEvening()
    await h.say('4')
    await h.tap(`cat:${h.user().active_session_id}:sleep`)
    h.clear()
    await h.say('спасибо')

    expect(h.lastText()).toBe('Практика у тебя выше. Когда дослушаешь, нажми «Готово».')
    expect(h.calls('sendAudio')).toHaveLength(0)
  })
})

describe('полный проход семи вечеров', () => {
  it('семь вечеров подряд доходят до финала', async () => {
    const h = await startedInEvening({ payload: 'q42' })

    const prompts: string[] = []
    const closes: string[] = []
    const practices: string[] = []

    for (let n = 1; n <= 7; n++) {
      if (n > 1) await jumpToNextEvening(h)
      prompts.push(h.lastText())
      h.clear()

      await h.say(String(3 + n <= 10 ? 3 + n : 10))
      await h.tap(`cat:${h.user().active_session_id}:sleep`)
      practices.push(String(h.calls('sendAudio')[0].payload.title))
      await h.tap(`done:${h.user().active_session_id}`)
      await h.say('8')

      expect(h.user().current_evening).toBe(n)
      closes.push(h.texts().filter((t) => t.startsWith('Записала: 8')).slice(-1)[0] ?? '')
    }

    // Преамбула помнит, где человек: первый, половина пути, последний.
    expect(prompts[0]).toContain('Первый вечер из семи')
    expect(prompts[1]).toContain('Вечер 2 из 7')
    expect(prompts[3]).toContain('Четвёртый вечер, половина пути')
    expect(prompts[6]).toContain('Седьмой вечер, последний')

    // Полоска пути растёт ровно на один кружок за вечер.
    expect(closes[0]).toContain('●○○○○○○ Вечер 1 из 7')
    expect(closes[3]).toContain('●●●●○○○ Вечер 4 из 7')

    // Маршрут сна: седьмой вечер — та же практика, что и первый (§0, решение 2).
    expect(practices[6]).toBe(practices[0])
    expect(new Set(practices).size).toBe(4)

    expect(h.user().state).toBe('completed')
    expect(h.user().current_evening).toBe(7)
    expect(h.ctx.repo.sessions.runSessions(h.user().id, 1).filter((s) => s.status === 'done')).toHaveLength(7)
  })
})

describe('замер «после» утром', () => {
  it('уснул — утром догон, закрытие с «До вечера»', async () => {
    const h = await startedInEvening()
    await h.say('4')
    await h.tap(`cat:${h.user().active_session_id}:sleep`)

    // Таймер «после» сработал ночью, человек уже спит и не отвечает.
    h.setNow(h.user().due_at ?? 0)
    await h.due('after_timeout')
    expect(h.user().state).toBe('awaiting_after')
    expect(h.user().due_kind).toBe('morning')

    h.setNow(h.user().due_at ?? 0)
    h.clear()
    await h.due('morning')
    expect(h.lastText()).toContain('Вчера сон, похоже, пришёл раньше моего вопроса')

    await h.say('8')
    expect(h.lastText()).toContain('Вечером было 4, утром 8.')
    expect(h.lastText()).toContain('До вечера.')
    expect(h.lastText()).not.toContain('До завтра.')
    expect(h.ctx.repo.sessions.listForUser(h.user().id)[0].after_source).toBe('morning')
  })

  it('не ответил и утром — вечер остаётся засчитанным, на графике разрыв', async () => {
    const h = await startedInEvening()
    await h.say('4')
    await h.tap(`cat:${h.user().active_session_id}:sleep`)
    h.setNow(h.user().due_at ?? 0)
    await h.due('after_timeout')
    h.setNow(h.user().due_at ?? 0)
    await h.due('morning')

    // Наступил следующий вечер, цифры «после» так и нет.
    h.setNow(h.user().due_at ?? 0)
    await h.due('ping_or_close')

    const first = h.ctx.repo.sessions.runSessions(h.user().id, 1)[0]
    expect(first.status).toBe('done')
    expect(first.after_value).toBeNull()
    expect(h.user().current_evening).toBe(1)
    // И сразу открылся второй вечер — двух пингов человек не получит.
    expect(h.user().state).toBe('awaiting_before')
    expect(h.lastText()).toContain('Вечер 2 из 7')
  })
})

describe('граничные случаи вечера', () => {
  it('пустая библиотека: человек не зависает, владелец узнаёт первым', async () => {
    const h = await makeHarness({ now: EVENING_NOW, practices: false })
    await onboard(h)
    await h.say('4')
    h.clear()

    await h.tap(`cat:${h.user().active_session_id}:sleep`)

    expect(h.lastText()).toBe('Практики ещё загружаются. Загляни чуть позже.')
    expect(h.calls('sendAudio')).toHaveLength(0)
    expect(h.user().state).toBe('idle')
    expect(h.user().current_evening).toBe(0)
    expect(h.ctx.repo.sessions.listForUser(h.user().id)).toHaveLength(0)
    expect(h.ctx.repo.notifications.pending(10).some((n) => n.type === 'no_practices')).toBe(true)
  })

  it('/start внутри сессии повторяет вопрос, а не начинает заново', async () => {
    const h = await startedInEvening()
    h.clear()

    await h.say('/start')
    expect(h.lastText()).toContain('Первый вечер из семи')
    expect(h.lastReplyRows()[0]).toEqual(['0', '1', '2', '3', '4', '5'])
    expect(h.user().state).toBe('awaiting_before')

    await h.say('4')
    h.clear()
    await h.say('/start')
    expect(h.lastText()).toContain('Что сегодня ближе?')
    expect(h.user().state).toBe('awaiting_state')
    expect(h.ctx.repo.sessions.listForUser(h.user().id)[0].before_value).toBe(4)
  })

  it('подпись «Сегодня: …» повторяет ту же формулировку, что была на кнопке', async () => {
    const h = await makeHarness() // день, до 14:00
    await onboard(h)
    await h.say('Практика сейчас')
    await h.say('5')
    h.clear()
    await h.tap(`cat:${h.user().active_session_id}:day`)

    expect(String(h.calls('editMessageText')[0].payload.text)).toBe('Сегодня: 🌅 Настроиться на день.')
  })
})
