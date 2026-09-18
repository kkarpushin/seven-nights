/**
 * Седьмой вечер, день восьмой, новый круг и повторный тест.
 * §2.7, §2.8 design-bot; §3.5 архитектуры; строки 24, 35, 36, 43–48 §3.2.
 *
 * У седьмого вечера один призыв — разговор. Поэтому здесь проверяется не только
 * то, что финал пришёл, но и то, что лишнего сообщения в этот вечер нет, а тест
 * предлагается отдельно и только по кнопке.
 */

import { describe, expect, it } from 'vitest'
import { makeSession } from './helpers/db.ts'
import { makeHarness, onboard, T0, type Harness } from './helpers/bot.ts'

const EVENING_NOW = T0 + 12 * 3600

const TALK_URL = 'https://cal.com/seven-nights'
const CHANNEL_URL = 'https://t.me/seven_nights'

/**
 * Шесть вечеров позади (фикстурами), седьмой открывается по-настоящему.
 * Даты первых шести выбраны заведомо раньше «сегодня», иначе сработает инвариант
 * «один засчитанный вечер на ритуальную дату».
 */
async function atSeventhEvening(opts: { payload?: string } = {}): Promise<Harness> {
  const h = await makeHarness({
    now: EVENING_NOW,
    settings: { talk_url: TALK_URL, channel_url: CHANNEL_URL },
  })
  await onboard(h, { payload: opts.payload })
  await h.say('Лучше в 21:00')

  const u = h.user()
  for (let n = 1; n <= 6; n++) {
    makeSession(h.ctx.db, {
      userId: u.id,
      eveningNo: n,
      ritualDate: `2025-09-0${n}`,
      before: 4,
      after: 4 + n > 10 ? 10 : 4 + n,
      createdAt: T0 - (7 - n) * 86400,
    })
  }
  h.ctx.repo.users.update(u.id, { current_evening: 6 })
  h.clear()

  await h.say('Практика сейчас') // правило слияния открывает седьмой вечер
  return h
}

describe('финал седьмого вечера (§2.7)', () => {
  it('закрытие, картинка недели и приглашение на разговор', async () => {
    const h = await atSeventhEvening()
    expect(h.lastText()).toContain('Седьмой вечер, последний')

    await h.say('5')
    await h.tap(`cat:${h.user().active_session_id}:sleep`)
    await h.tap(`done:${h.user().active_session_id}`)
    h.clear()
    await h.say('9')

    const texts = h.texts()
    expect(texts[0]).toBe('Записала: 9 ▰▰▰▰▰▰▰▰▰▱\nБыло 5, стало 9. На 4 деления легче.')
    expect(texts[0]).not.toContain('Вечер 7 из 7') // «До завтра» на седьмом вечере нет

    // Картинка: настоящий PNG от resvg, с подписью «было → стало».
    const photo = h.calls('sendPhoto')[0]
    expect(photo).toBeDefined()
    expect(String(photo.payload.caption)).toBe(
      'Смотри, где всё началось и где ты сейчас.\n\nБыло 4. Стало 9.',
    )

    expect(texts[texts.length - 1]).toBe(
      'Если захочешь разобрать своё, приходи на разговор. Тридцать минут, вдвоём.',
    )
    expect(h.lastInline()).toEqual([{ text: 'Записаться на разговор', data: undefined, url: TALK_URL }])

    const u = h.user()
    expect(u.state).toBe('completed')
    expect(u.completed_at).toBe(h.ctx.clock.now())
    expect(u.due_kind).toBe('day8')
    expect(h.ctx.repo.events.listForUser(u.id).some((e) => e.type === 'finished')).toBe(true)
    expect(h.ctx.repo.notifications.pending(10).some((n) => n.type === 'finished')).toBe(true)
  })

  it('без теста на входе повторный тест не предлагается', async () => {
    const h = await atSeventhEvening()
    await h.say('5')
    await h.tap(`cat:${h.user().active_session_id}:sleep`)
    await h.say('9')

    expect(h.texts().some((t) => t.includes('Хочешь посмотреть'))).toBe(false)
    // Единственный призыв седьмого вечера — разговор.
    expect(h.lastText()).toContain('приходи на разговор')
  })

  it('день восьмой приходит один раз, дальше бот молчит', async () => {
    const h = await atSeventhEvening()
    await h.say('5')
    await h.tap(`cat:${h.user().active_session_id}:sleep`)
    await h.say('9')

    h.setNow(h.user().due_at ?? 0)
    h.clear()
    await h.due('day8')

    expect(h.lastText()).toBe(
      'Семь ночей позади. Практики остаются с тобой: кнопка «Практика сейчас» никуда не денется. Спасибо за эту неделю.',
    )
    expect(h.lastInline()).toEqual([{ text: 'Мой канал', data: undefined, url: CHANNEL_URL }])
    expect(h.user().day8_sent).toBe(1)
    expect(h.user().due_at).toBeNull()

    h.clear()
    await h.due('day8')
    expect(h.texts()).toHaveLength(0)
  })

  it('«Ещё семь вечеров» открывает новый круг, прошлый остаётся в истории', async () => {
    const h = await atSeventhEvening()
    await h.say('5')
    await h.tap(`cat:${h.user().active_session_id}:sleep`)
    await h.say('9')
    h.clear()

    await h.say('Ещё семь вечеров')

    const u = h.user()
    expect(h.texts()[0]).toContain('Открыла тебе семь вечеров заново')
    expect(u.run_no).toBe(2)
    expect(u.current_evening).toBe(0)
    expect(u.day8_sent).toBe(0)
    expect(u.completed_at).toBeNull()
    expect(h.ctx.repo.sessions.runSessions(u.id, 1)).toHaveLength(7)
    expect(h.ctx.repo.events.listForUser(u.id).some((e) => e.type === 'restarted')).toBe(true)
  })
})

describe('повторный тест внутри бота (§4 quiz-bot-integration)', () => {
  /** Финал у человека, пришедшего с индексом 60 (сумма 42). */
  async function finishedWithQuiz(): Promise<Harness> {
    const h = await atSeventhEvening({ payload: 'q42' })
    await h.say('5')
    await h.tap(`cat:${h.user().active_session_id}:sleep`)
    await h.say('9')
    return h
  }

  it('после приглашения приходит отдельное предложение с двумя кнопками', async () => {
    const h = await finishedWithQuiz()

    expect(h.lastText()).toBe(
      'Семь вечеров назад твой индекс опоры был 60. Хочешь посмотреть, что с ним сейчас?',
    )
    expect(h.lastInline().map((b) => b.text)).toEqual(['Пройти семь вопросов', 'Не сейчас'])
  })

  it('семь вопросов подряд и результат с обязательным дисклеймером', async () => {
    const h = await finishedWithQuiz()
    await h.tapLabel('Пройти семь вопросов')

    expect(h.lastText()).toBe(
      '1 / 7\n\nКогда что-то идёт не по плану, насколько быстро ты можешь вернуться в нормальное состояние?\n\n0 — меня надолго выбивает\n10 — довольно быстро возвращаюсь к себе',
    )
    // Кнопки 0–10 двумя рядами; «Назад» на первом вопросе нет.
    expect(h.lastInline()).toHaveLength(11)
    expect(h.user().state).toBe('quiz_after')

    for (let q = 1; q <= 7; q++) {
      expect(h.lastText()).toContain(`${q} / 7`)
      await h.tap(`qa:${q}:9`)
    }

    // 63 из 70 → индекс 90, группа «сумма 60–70».
    expect(h.lastText()).toBe(
      'Было 60. Стало 90.\n\nСейчас ты ощущаешь высокую внутреннюю устойчивость. Но это не «уровень навсегда»: состояние меняется, поэтому внутреннюю опору продолжают поддерживать.\n\nЭто не диагноз и не оценка твоей личности. Это фотография твоего состояния сегодня.',
    )
    const u = h.user()
    expect(u.quiz_sum_after).toBe(63)
    expect(u.quiz_index_after).toBe(90)
    expect(u.state).toBe('completed')
    expect(h.ctx.repo.quiz.answers(u.id, u.run_no, 'after')).toEqual([9, 9, 9, 9, 9, 9, 9])
    expect(h.ctx.repo.events.listForUser(u.id).some((e) => e.type === 'quiz_after_done')).toBe(true)
  })

  it('«Назад» стирает предыдущий ответ и переспрашивает', async () => {
    const h = await finishedWithQuiz()
    await h.tapLabel('Пройти семь вопросов')
    await h.tap('qa:1:3')
    await h.tap('qa:2:4')
    h.clear()

    await h.tap('qb:3')

    expect(h.lastText()).toContain('2 / 7')
    expect(h.user().quiz_step).toBe(2)
    expect(h.ctx.repo.quiz.answers(h.user().id, h.user().run_no, 'after')).toEqual([3, null, null, null, null, null, null])
  })

  it('кнопка предыдущего вопроса не сдвигает нумерацию', async () => {
    const h = await finishedWithQuiz()
    await h.tapLabel('Пройти семь вопросов')
    await h.tap('qa:1:3')
    h.clear()

    await h.tap('qa:1:8') // старая кнопка первого вопроса

    expect(h.texts()).toHaveLength(0)
    expect(h.user().quiz_step).toBe(2)
    expect(h.ctx.repo.quiz.answers(h.user().id, h.user().run_no, 'after')[0]).toBe(3)
  })

  it('«Не сейчас» закрывает предложение навсегда', async () => {
    const h = await finishedWithQuiz()
    const said = h.texts().length
    await h.tapLabel('Не сейчас')

    // Ответного сообщения нет — только снятая клавиатура.
    expect(h.texts()).toHaveLength(said)
    expect(h.methods()).toContain('editMessageReplyMarkup')
    expect(h.user().quiz_after_declined).toBe(1)
  })

  it('брошенный тест напоминает о себе один раз и не чаще', async () => {
    const h = await finishedWithQuiz()
    await h.tapLabel('Пройти семь вопросов')
    await h.tap('qa:1:5')
    await h.tap('qa:2:5')
    await h.tap('qa:3:5')
    await h.tap('qa:4:5')

    // Через час человек написал что-то своё.
    h.advance(3700)
    h.clear()
    await h.say('привет')
    expect(h.lastText()).toBe('Осталось 3 вопроса. Продолжим?')

    // Второй раз — уже нет.
    h.advance(3700)
    h.clear()
    await h.say('и ещё раз')
    expect(h.lastText()).not.toContain('Осталось')

    // Кнопка «Продолжить тест» возвращает к тому же вопросу.
    h.clear()
    await h.tap('qresume')
    expect(h.lastText()).toContain('5 / 7')
  })

  it('сразу после ответа напоминание не приходит', async () => {
    const h = await finishedWithQuiz()
    await h.tapLabel('Пройти семь вопросов')
    await h.tap('qa:1:5')
    h.clear()

    await h.say('минутку')
    expect(h.lastText()).not.toContain('Осталось')
  })
})

describe('финал без цифры «после» (§2.7)', () => {
  it('картинка подписана «Стало — ты знаешь лучше меня»', async () => {
    const h = await makeHarness({ now: EVENING_NOW, settings: { talk_url: '' } })
    await onboard(h)
    await h.say('Лучше в 21:00')

    const u = h.user()
    makeSession(h.ctx.db, { userId: u.id, eveningNo: 1, ritualDate: '2025-09-01', before: 4, after: null })
    h.ctx.repo.users.update(u.id, { current_evening: 6 })
    await h.say('Практика сейчас')
    await h.say('5')
    await h.tap(`cat:${h.user().active_session_id}:sleep`)
    h.clear()

    // Ни ночью, ни утром цифра не пришла — финал уходит вместо следующего пинга.
    h.setNow(h.user().due_at ?? 0)
    await h.due('after_timeout')
    h.setNow(h.user().due_at ?? 0)
    await h.due('morning')
    h.setNow(h.user().due_at ?? 0)
    await h.due('ping_or_close')

    expect(String(h.calls('sendPhoto')[0].payload.caption)).toBe('Было 4. Стало — ты знаешь лучше меня.')
    expect(h.texts().some((t) => t.startsWith('Записала:'))).toBe(false)
    expect(h.lastText()).toContain('приходи на разговор')
    // Ссылки нет — кнопки тоже нет, а текст остался.
    expect(h.lastInline()).toHaveLength(0)
    expect(h.user().state).toBe('completed')
  })
})
