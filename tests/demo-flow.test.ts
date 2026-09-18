/**
 * Прогон всего пути человека по демо-боту: от /start до графика седьмого вечера.
 *
 * Это приёмочный критерий из технического задания («прохожу все семь вечеров в
 * ускоренном режиме»), только автоматический: апдейты подаются фейковые, исходящие
 * вызовы Telegram перехватываются, ничего никуда не отправляется.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const workDir = mkdtempSync(join(tmpdir(), 'sn-flow-'))
process.env.DEMO_DB = join(workDir, 'test.db')
process.env.SEVEN_NIGHTS_NO_POLL = '1'
process.env.DEMO_MODE_DEFAULT = '1'

const { bot, db, user, tick } = await import('../src/demo/bot.ts')

/** Перехваченные исходящие вызовы: метод и его полезная нагрузка. */
const sent: Array<{ method: string; payload: any }> = []

const TG_ID = 777001
let updateId = 1

beforeAll(async () => {
  bot.api.config.use(async (_prev, method, payload) => {
    sent.push({ method, payload })
    // Ответы ровно такие, каких ждёт код: id сообщения и file_id у аудио.
    const id = sent.length
    if (method === 'sendAudio') return { ok: true, result: { message_id: id, audio: { file_id: `fake-${id}` } } } as any
    return { ok: true, result: { message_id: id } } as any
  })
  await bot.init()
})

afterAll(() => {
  db.close()
  rmSync(workDir, { recursive: true, force: true })
})

const from = { id: TG_ID, is_bot: false, first_name: 'Т', language_code: 'ru' }
const chat = { id: TG_ID, type: 'private' as const, first_name: 'Т' }

/**
 * Telegram помечает команды разметкой entities, и grammY ищет команду именно по ней.
 * Без этого «/start» приходит как обычный текст — и тест падал бы на том, чего в
 * настоящем Telegram не бывает.
 */
const commandEntities = (t: string) =>
  t.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: t.split(' ')[0].length }] : undefined

const msg = (t: string, who = from, where = chat) => ({
  message_id: updateId, date: Math.floor(Date.now() / 1000), from: who, chat: where,
  text: t, entities: commandEntities(t),
})

const text = (t: string) => bot.handleUpdate({ update_id: updateId++, message: msg(t) } as any)

const tap = (data: string) =>
  bot.handleUpdate({
    update_id: updateId++,
    callback_query: {
      id: String(updateId), from, chat_instance: '1', data,
      message: { message_id: updateId, date: Math.floor(Date.now() / 1000), chat, text: '.' },
    },
  } as any)

/**
 * Демо-режим ставит следующий вечер через полторы минуты. Ждать их в тесте незачем:
 * двигаем срок в прошлое и дёргаем тик — ровно то же, что случится по таймеру.
 */
async function advanceToNextEvening(tgId = TG_ID) {
  db.prepare('UPDATE users SET due_at = ? WHERE tg_id = ? AND due_at IS NOT NULL')
    .run(Math.floor(Date.now() / 1000) - 1, tgId)
  await tick()
}

/** Всё, что бот сказал с прошлой проверки. */
function said(): string {
  return sent
    .filter((s) => s.method === 'sendMessage' || s.method === 'sendAudio' || s.method === 'sendPhoto')
    .map((s) => s.payload.text || s.payload.caption || '')
    .join('\n')
}

describe('весь путь: семь вечеров', () => {
  it('онбординг спрашивает час, потом часы, и сразу начинает первый вечер', async () => {
    await text('/start q42')
    expect(said()).toContain('Это «Семь ночей»')
    // Пришёл с лендинга: индекс 42/70 → 60, упоминается один раз.
    expect(said()).toContain('индекс опоры сейчас 60')
    expect(said()).toContain('Во сколько вечером тебе удобно')

    await text('21:00')
    expect(said()).toContain('Сколько сейчас у тебя на часах')

    await text('18:42')
    expect(said()).toContain('Открыла тебе семь вечеров')
    expect(said()).toContain('Первый вечер из семи')
    expect(user(TG_ID).state).toBe('awaiting_before')
  })

  it('не-цифра не ломает шаг и не двигает программу', async () => {
    const before = user(TG_ID).evening_no
    await text('нормально вроде')
    expect(said()).toContain('нужна просто цифра от 0 до 10')
    await text('42')
    expect(said()).toContain('От 0 до 10 — какая ближе')
    expect(user(TG_ID).evening_no).toBe(before)
  })

  /** Один вечер целиком: цифра до → категория → аудио → «Готово» → цифра после. */
  async function evening(before: number, after: number, category = 'sleep') {
    await text(String(before))
    await tap(`cat:${category}`)
    await tap('done')
    await text(String(after))
  }

  it('первый вечер доходит до аудио и закрывается с дельтой', async () => {
    sent.length = 0
    await evening(4, 7)
    const audio = sent.find((s) => s.method === 'sendAudio')
    expect(audio, 'практика должна уйти как audio, а не voice').toBeTruthy()
    expect(audio!.payload.performer).toContain('Вечер 1')
    expect(said()).toContain('Записала: 4')
    expect(said()).toContain('Было 4, стало 7. На 3 деления легче.')
    expect(said()).toContain('Вечер 1 из 7')
    expect(user(TG_ID).evening_no).toBe(1)
  })

  it('вторая практика не повторяет первую', async () => {
    const first = (db.prepare('SELECT practice FROM evenings WHERE no = 1').get() as any).practice
    sent.length = 0
    await advanceToNextEvening()       // демо: следующий вечер наступает по таймеру
    await evening(5, 5)
    const second = (db.prepare('SELECT practice FROM evenings WHERE no = 2').get() as any).practice
    expect(second).not.toBe(first)
    expect(said()).toContain('Ровно. Тоже честный ответ.')
  })

  it('доходит до седьмого вечера и присылает картинку с итогом', async () => {
    for (const [b, a] of [[5, 7], [5, 6], [6, 8], [6, 7]] as const) {
      await advanceToNextEvening()
      await evening(b, a)
    }
    expect(user(TG_ID).evening_no).toBe(6)

    sent.length = 0
    await advanceToNextEvening()
    await evening(6, 9)

    expect(user(TG_ID).evening_no).toBe(7)
    const photo = sent.find((s) => s.method === 'sendPhoto')
    expect(photo, 'на седьмом вечере должна прийти картинка графика').toBeTruthy()
    expect(photo!.payload.caption).toContain('Было 4. Стало 9.')
    expect(said()).toContain('приходи на разговор')
    expect(user(TG_ID).state).toBe('completed')
  })

  it('все семь вечеров записаны с обеими цифрами', () => {
    const rows = db.prepare('SELECT no, before_v, after_v FROM evenings WHERE no > 0 ORDER BY no').all() as any[]
    expect(rows.map((r) => r.no)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(rows.every((r) => r.before_v !== null && r.after_v !== null)).toBe(true)
  })

  it('после программы «Практика сейчас» всё ещё работает и не двигает счётчик', async () => {
    sent.length = 0
    await text('Практика сейчас')
    await text('6')
    await tap('cat:calm')
    expect(sent.some((s) => s.method === 'sendAudio')).toBe(true)
    expect(user(TG_ID).evening_no).toBe(7)
  })
})

describe('цифра, присланная раньше вопроса', () => {
  const OTHER = 777002
  const from2 = { ...from, id: OTHER }
  const chat2 = { ...chat, id: OTHER }
  const say = (t: string) => bot.handleUpdate({ update_id: updateId++, message: msg(t, from2, chat2) } as any)
  const tap2 = (data: string) =>
    bot.handleUpdate({
      update_id: updateId++,
      callback_query: {
        id: String(updateId), from: from2, chat_instance: '1', data,
        message: { message_id: updateId, date: Math.floor(Date.now() / 1000), chat: chat2, text: '.' },
      },
    } as any)

  it('принимается как замер «после», вечер закрывается без лишнего вопроса', async () => {
    await say('/start')
    await say('22:00')
    await say('18:42')
    await say('3')
    await tap2('cat:sleep')
    sent.length = 0
    await say('8')                    // не дожидаясь «А сейчас как»
    const texts = sent.map((s) => s.payload.text || '').join('\n')
    expect(texts).not.toContain('А сейчас как')
    expect(texts).toContain('Было 3, стало 8')
    expect(user(OTHER).evening_no).toBe(1)
  })
})

describe('тяжёлое сообщение', () => {
  const ID = 777003
  const who = { ...from, id: ID }
  const where = { ...chat, id: ID }
  const say = (t: string) => bot.handleUpdate({ update_id: updateId++, message: msg(t, who, where) } as any)

  it('получает мягкий отклик, а не вопрос про цифру', async () => {
    await say('/start')
    await say('21:00')
    await say('18:42')          // бот ждёт цифру «до»
    sent.length = 0
    await say('я не хочу жить')
    const texts = sent.map((s) => s.payload.text || '').join('\n')
    expect(texts).toContain('это звучит тяжело')
    expect(texts).not.toContain('нужна просто цифра')
  })

  it('обычная грусть не вызывает кризисный текст', async () => {
    sent.length = 0
    await say('день был тяжёлый, устала очень')
    const texts = sent.map((s) => s.payload.text || '').join('\n')
    expect(texts).not.toContain('это звучит тяжело')
  })
})

describe('удаление истории', () => {
  const ID = 777004
  const who = { ...from, id: ID }
  const where = { ...chat, id: ID }
  const say = (t: string) => bot.handleUpdate({ update_id: updateId++, message: msg(t, who, where) } as any)
  const press = (data: string) =>
    bot.handleUpdate({
      update_id: updateId++,
      callback_query: {
        id: String(updateId), from: who, chat_instance: '1', data,
        message: { message_id: updateId, date: Math.floor(Date.now() / 1000), chat: where, text: '.' },
      },
    } as any)

  it('спрашивает подтверждение и стирает всё только после «да»', async () => {
    await say('/start')
    await say('21:00')
    await say('18:42')
    await say('5')
    expect((db.prepare('SELECT COUNT(*) c FROM users WHERE tg_id = ?').get(ID) as any).c).toBe(1)

    sent.length = 0
    await say('/delete')
    expect(sent.map((s) => s.payload.text || '').join()).toContain('Отменить это будет нельзя')

    await press('del:no')
    expect((db.prepare('SELECT COUNT(*) c FROM users WHERE tg_id = ?').get(ID) as any).c).toBe(1)

    await press('del:yes')
    expect((db.prepare('SELECT COUNT(*) c FROM users WHERE tg_id = ?').get(ID) as any).c).toBe(0)
    expect((db.prepare('SELECT COUNT(*) c FROM evenings WHERE tg_id = ?').get(ID) as any).c).toBe(0)
  })
})

describe('пропуск вечера', () => {
  const ID = 777005
  const who = { ...from, id: ID }
  const where = { ...chat, id: ID }
  const say = (t: string) => bot.handleUpdate({ update_id: updateId++, message: msg(t, who, where) } as any)
  const press = (data: string) =>
    bot.handleUpdate({
      update_id: updateId++,
      callback_query: {
        id: String(updateId), from: who, chat_instance: '1', data,
        message: { message_id: updateId, date: Math.floor(Date.now() / 1000), chat: where, text: '.' },
      },
    } as any)

  /** Сдвигает любой назначенный срок в прошлое и запускает тик планировщика. */
  const advance = async () => {
    db.prepare('UPDATE users SET due_at = ? WHERE tg_id = ? AND due_at IS NOT NULL')
      .run(Math.floor(Date.now() / 1000) - 1, ID)
    await tick()
  }

  it('программа сдвигается, а не пропадает: номер вечера не растёт', async () => {
    await say('/start')
    await say('21:00')
    await say('18:42')

    // Первый вечер проходим целиком.
    await say('4')
    await press('cat:sleep')
    await press('done')
    await say('6')
    expect(user(ID).evening_no).toBe(1)

    // Второй вечер приходит — и человек на него не отвечает.
    await advance()
    expect(user(ID).state).toBe('awaiting_before')
    sent.length = 0
    await advance()                       // наступил срок пропуска

    expect(user(ID).state).toBe('idle')
    expect(user(ID).evening_no, 'вечер не засчитан — номер остался прежним').toBe(1)
    expect(user(ID).skips).toBe(1)
    expect(sent, 'за пропуск бот не отчитывает и вообще молчит').toHaveLength(0)
  })

  it('следующий вечер начинается с «вчера не получилось» и это ТОТ ЖЕ вечер', async () => {
    sent.length = 0
    await advance()
    const texts = sent.map((s) => s.payload.text || '').join('\n')
    expect(texts).toContain('Вчера не получилось, это нормально')
    expect(texts).toContain('Вечер 2 из 7')      // не третий: программа сдвинулась
  })

  it('человек доходит до практики — серия пропусков обнуляется', async () => {
    await say('5')
    await press('cat:calm')
    expect(user(ID).evening_no).toBe(2)
    expect(user(ID).skips).toBe(0)
  })

  it('после двух пропусков подряд формулировка меняется', async () => {
    await press('done')
    await say('7')                        // закрыли второй вечер
    await advance()                       // пришёл третий
    await advance()                       // пропустил
    await advance()                       // пришёл снова
    await advance()                       // пропустил второй раз
    expect(user(ID).skips).toBe(2)
    sent.length = 0
    await advance()
    const texts = sent.map((s) => s.payload.text || '').join('\n')
    expect(texts).toContain('Несколько дней не получилось')
    expect(texts).toContain('Вечер 3 из 7')      // всё ещё третий
    expect(user(ID).evening_no).toBe(2)
  })
})
