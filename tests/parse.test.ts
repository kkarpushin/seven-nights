/**
 * Парсеры и тексты. §5.7–5.8 архитектуры, §2.1 и §2.6 design-bot.
 *
 * Это единственные функции продукта, которые человек «нажимает» словами. Всё, что
 * здесь проверяется, взято из примеров дизайна дословно: «9 вечера» → 21:00,
 * «где-то 6, устала» → 6, «6,5» → переспросить целое. Если пример из документа не
 * проходит — сломан продукт, а не тест.
 */

import { describe, expect, it } from 'vitest'
import { isPauseWord, parseClock, parseCommand, parseHour, parseNumber, parseStartPayload } from '../src/parse.ts'
import { bar, createTexts, dots, fill, placeholdersIn } from '../src/texts.ts'
import { createKeyboards, categoryOrder } from '../src/keyboards.ts'
import { createRepos } from '../src/ctx.ts'
import { fakeClock } from '../src/clock.ts'
import { T0, testDb } from './helpers/db.ts'

describe('parseHour — час вечерней практики (§2.1)', () => {
  it('принимает формы из дизайна', () => {
    expect(parseHour('21')).toEqual({ h: 21, m: 0 })
    expect(parseHour('21:00')).toEqual({ h: 21, m: 0 })
    expect(parseHour('21.00')).toEqual({ h: 21, m: 0 })
    expect(parseHour('21 30')).toEqual({ h: 21, m: 30 })
    expect(parseHour('в 21')).toEqual({ h: 21, m: 0 })
    expect(parseHour('9 вечера')).toEqual({ h: 21, m: 0 })
    expect(parseHour('7 утра')).toEqual({ h: 7, m: 0 })
  })

  it('без уточнения 4–11 считает вечерними, 0–3 оставляет как есть', () => {
    expect(parseHour('9')).toEqual({ h: 21, m: 0 })
    expect(parseHour('11')).toEqual({ h: 23, m: 0 })
    expect(parseHour('4')).toEqual({ h: 16, m: 0 })
    expect(parseHour('1')).toEqual({ h: 1, m: 0 })
    expect(parseHour('3')).toEqual({ h: 3, m: 0 })
    expect(parseHour('12')).toEqual({ h: 12, m: 0 })
  })

  it('«11 ночи» это 23:00, «2 ночи» — 02:00', () => {
    expect(parseHour('11 ночи')).toEqual({ h: 23, m: 0 })
    expect(parseHour('2 ночи')).toEqual({ h: 2, m: 0 })
  })

  it('минуты сохраняются, мусор отвергается', () => {
    expect(parseHour('21:45')).toEqual({ h: 21, m: 45 })
    expect(parseHour('2145')).toEqual({ h: 21, m: 45 })
    expect(parseHour('когда-нибудь')).toBeNull()
    expect(parseHour('25:00')).toBeNull()
    expect(parseHour('21:75')).toBeNull()
    expect(parseHour('')).toBeNull()
  })
})

describe('parseClock — сколько сейчас на часах (§2.10)', () => {
  it('принимает формы из дизайна, включая голый час', () => {
    expect(parseClock('18:42')).toEqual({ h: 18, m: 42 })
    expect(parseClock('18.42')).toEqual({ h: 18, m: 42 })
    expect(parseClock('1842')).toEqual({ h: 18, m: 42 })
    expect(parseClock('18 42')).toEqual({ h: 18, m: 42 })
    expect(parseClock('18')).toEqual({ h: 18, m: 0 })
  })

  it('не сдвигает час на +12: это время с экрана телефона, а не пожелание', () => {
    expect(parseClock('9')).toEqual({ h: 9, m: 0 })
    expect(parseClock('7')).toEqual({ h: 7, m: 0 })
  })

  it('отвергает нечисла и невозможное время', () => {
    expect(parseClock('вечер')).toBeNull()
    expect(parseClock('26:10')).toBeNull()
  })
})

describe('parseNumber — цифра замера (§2.6)', () => {
  it('целое 0–10', () => {
    expect(parseNumber('0')).toEqual({ value: 0 })
    expect(parseNumber('7')).toEqual({ value: 7 })
    expect(parseNumber('10')).toEqual({ value: 10 })
  })

  it('«7/10» и «7 из 10»', () => {
    expect(parseNumber('7/10')).toEqual({ value: 7 })
    expect(parseNumber('7 из 10')).toEqual({ value: 7 })
  })

  it('словами', () => {
    expect(parseNumber('ноль')).toEqual({ value: 0 })
    expect(parseNumber('семь')).toEqual({ value: 7 })
    expect(parseNumber('десять')).toEqual({ value: 10 })
  })

  it('одно число внутри короткой фразы', () => {
    expect(parseNumber('где-то 6, устала')).toEqual({ value: 6 })
  })

  it('дробь просит целое и предлагает соседние', () => {
    expect(parseNumber('6,5')).toEqual({ error: 'fraction', a: 6, b: 7 })
    expect(parseNumber('6.5')).toEqual({ error: 'fraction', a: 6, b: 7 })
  })

  it('вне диапазона и два числа — «от 0 до 10, какая ближе»', () => {
    expect(parseNumber('11')).toEqual({ error: 'range' })
    expect(parseNumber('-1')).toEqual({ error: 'range' })
    expect(parseNumber('100')).toEqual({ error: 'range' })
    expect(parseNumber('5 или 6')).toEqual({ error: 'range' })
  })

  it('без числа вовсе', () => {
    expect(parseNumber('не знаю')).toEqual({ error: 'none' })
    expect(parseNumber('')).toEqual({ error: 'none' })
  })
})

describe('parseStartPayload — deep link теста (§1–2 quiz-bot-integration)', () => {
  it('валидная сумма 0…70', () => {
    expect(parseStartPayload('q42')).toEqual({ quizSum: 42, raw: 'q42' })
    expect(parseStartPayload('q0')).toEqual({ quizSum: 0, raw: 'q0' })
    expect(parseStartPayload('q70')).toEqual({ quizSum: 70, raw: 'q70' })
  })

  it('невалидное игнорируется молча, но остаётся в журнале', () => {
    expect(parseStartPayload('q71').quizSum).toBeNull()
    expect(parseStartPayload('qabc').quizSum).toBeNull()
    expect(parseStartPayload('landing')).toEqual({ quizSum: null, raw: 'landing' })
    expect(parseStartPayload(undefined)).toEqual({ quizSum: null, raw: null })
  })
})

describe('isPauseWord и parseCommand', () => {
  it('только слово целиком', () => {
    expect(isPauseWord('пауза')).toBe(true)
    expect(isPauseWord('Стоп')).toBe(true)
    expect(isPauseWord('хватит.')).toBe(true)
    expect(isPauseWord('не сейчас')).toBe(true)
    expect(isPauseWord('я не могу остановиться')).toBe(false)
    expect(isPauseWord('паузу бы')).toBe(false)
  })

  it('команда и её аргумент', () => {
    expect(parseCommand('/start')).toEqual({ cmd: 'start', arg: '' })
    expect(parseCommand('/start q42')).toEqual({ cmd: 'start', arg: 'q42' })
    expect(parseCommand('/demo@ensoma_robot secret')).toEqual({ cmd: 'demo', arg: 'secret' })
    expect(parseCommand('не команда')).toBeNull()
  })
})

describe('полоски и подстановка', () => {
  it('bar и dots', () => {
    expect(bar(0)).toBe('▱▱▱▱▱▱▱▱▱▱')
    expect(bar(4)).toBe('▰▰▰▰▱▱▱▱▱▱')
    expect(bar(10)).toBe('▰▰▰▰▰▰▰▰▰▰')
    expect(dots(0)).toBe('○○○○○○○')
    expect(dots(3)).toBe('●●●○○○○')
    expect(dots(7)).toBe('●●●●●●●')
  })

  it('служебное склонение {деление} считает бот', () => {
    expect(fill('На {d} {деление} легче.', { d: 1 })).toBe('На 1 деление легче.')
    expect(fill('На {d} {деление} легче.', { d: 3 })).toBe('На 3 деления легче.')
    expect(fill('На {d} {деление} легче.', { d: 5 })).toBe('На 5 делений легче.')
  })

  it('служебное склонение {вопрос} в предложении продолжить тест', () => {
    expect(fill('Осталось {k} {вопрос}. Продолжим?', { k: 1 })).toBe('Осталось 1 вопрос. Продолжим?')
    expect(fill('Осталось {k} {вопрос}. Продолжим?', { k: 3 })).toBe('Осталось 3 вопроса. Продолжим?')
    expect(fill('Осталось {k} {вопрос}. Продолжим?', { k: 5 })).toBe('Осталось 5 вопросов. Продолжим?')
  })

  it('неизвестный плейсхолдер не роняет отправку, а остаётся текстом', () => {
    expect(fill('Привет, {кто}', {})).toBe('Привет, {кто}')
    expect(placeholdersIn('Записала: {after} {bar}\n{delta}')).toEqual(['{after}', '{bar}', '{delta}'])
  })
})

describe('Texts: подписи кнопок редактируются в админке', () => {
  const build = () => {
    const db = testDb()
    const repo = createRepos(db, fakeClock(T0))
    return { db, repo, texts: createTexts(repo.texts) }
  }

  it('нажатие узнаётся по значению из texts, а не по зашитой строке', () => {
    const { repo, texts } = build()
    expect(texts.buttonId('Практика сейчас')).toBe('practice_now')
    expect(texts.buttonId('Не сегодня')).toBe('not_today')
    expect(texts.buttonId('что-то другое')).toBeNull()

    repo.texts.set('btn.practice_now', 'Дай практику', T0)
    texts.reload()
    expect(texts.buttonId('Дай практику')).toBe('practice_now')
    expect(texts.buttonId('Практика сейчас')).toBeNull()
  })

  it('подпись с плейсхолдером узнаётся с подставленным значением', () => {
    const { texts } = build()
    expect(texts.label('better_at', { time: '21:00' })).toBe('Лучше в 21:00')
    expect(texts.buttonId('Лучше в 21:00')).toBe('better_at')
  })

  it('валидация текста запрещает чужие плейсхолдеры и пустоту', () => {
    const { texts } = build()
    expect(texts.validate('ev.close', 'Записала: {after} {bar}')).toEqual({ ok: true })
    expect(texts.validate('ev.close', '')).toMatchObject({ ok: false })
    const bad = texts.validate('ev.close', 'Записала: {имя}')
    expect(bad.ok).toBe(false)
    expect(bad.ok === false && bad.unknown).toEqual(['{имя}'])
  })
})

describe('категории: порядок и подпись зависят от времени суток (§2.2)', () => {
  it('до 14:00 — день первым и «на день»', () => {
    const order = categoryOrder(11)
    expect(order.map((c) => c.category)).toEqual(['day', 'calm', 'sleep'])
    expect(order[0].key).toBe('btn.cat_day_morning')
  })

  it('после 14:00 — сон первым и «на завтра»', () => {
    const order = categoryOrder(21)
    expect(order.map((c) => c.category)).toEqual(['sleep', 'calm', 'day'])
    expect(order[2].key).toBe('btn.cat_day_evening')
  })

  it('клавиатура цифр: два ряда и третий по месту', () => {
    const db = testDb()
    const K = createKeyboards(createTexts(createRepos(db, fakeClock(T0)).texts))
    expect(K.numbersKb().reply).toEqual([
      ['0', '1', '2', '3', '4', '5'],
      ['6', '7', '8', '9', '10'],
    ])
    expect(K.numbersKb({ notToday: true }).reply?.[2]).toEqual(['Не сегодня'])
    expect(K.numbersKb({ betterAt: 'Лучше в 21:00' }).reply?.[2]).toEqual(['Лучше в 21:00'])
    // «Не сегодня» и «Лучше в …» вместе не встречаются никогда.
    expect(K.numbersKb({ notToday: true, betterAt: 'Лучше в 21:00' }).reply).toHaveLength(3)
  })
})
