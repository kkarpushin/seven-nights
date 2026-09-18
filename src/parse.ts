/**
 * Парсеры входящего текста. §5.7 архитектуры, §2.1 и §2.6 design-bot.
 *
 * Все функции чистые: ни базы, ни часов, ни Ctx. Это сделано ради тестов — разбор
 * «где-то 6, устала» не должен требовать поднятой базы, — но выигрыш шире: человек
 * пишет цифру семь вечеров подряд, и любая ошибка здесь видна ему семь раз.
 *
 * Общий принцип разбора: мы НЕ пытаемся угадать больше, чем сказано. Там, где
 * входные данные двусмысленны («6» это шесть утра или шесть вечера?), выбор описан
 * в дизайне явно, и код повторяет его дословно, а не «по здравому смыслу».
 */

export { round15 } from './time.ts'
export { plural, pluralize } from './plural.ts'

/** Убирает то, что человек дописывает вокруг ответа: точки, кавычки, эмодзи-пробелы. */
function normalize(input: string): string {
  return input
    .toLowerCase()
    .replace(/ /g, ' ')
    .replace(/[«»"'`]/g, ' ')
    .trim()
}

// ───────────────────────────── час вечерней практики ─────────────────────────────

export type Hm = { h: number; m: number }

/** Часть суток, названная словом: она сильнее правила «4–11 значит вечер». */
type DayPart = 'morning' | 'day' | 'evening' | 'night' | null

function dayPartOf(s: string): DayPart {
  // Границы слова заданы просмотрами, а не \b: в JS \b считает буквой только
  // латиницу, поэтому «\bутра\b» в строке «7 утра» не совпадает ни с чем, и
  // уточнение времени суток молча перестаёт работать.
  if (/(?<![а-яё])утр(о|а|ом)?(?![а-яё])/.test(s)) return 'morning'
  if (/(?<![а-яё])(дня|днем|днём|полдень)(?![а-яё])/.test(s)) return 'day'
  if (/(?<![а-яё])вечер(а|ом)?(?![а-яё])/.test(s)) return 'evening'
  if (/(?<![а-яё])ноч(и|ью)(?![а-яё])/.test(s)) return 'night'
  return null
}

/** Первые «часы и минуты» в строке: 21, 21:30, 21.30, 21 30, 2130. */
function firstTime(s: string): Hm | null {
  const withSep = /(\d{1,2})\s*[:.\-\s]\s*(\d{2})(?!\d)/.exec(s)
  if (withSep) return { h: Number(withSep[1]), m: Number(withSep[2]) }
  const compact = /(?<!\d)(\d{3,4})(?!\d)/.exec(s)
  if (compact) {
    const raw = compact[1].padStart(4, '0')
    return { h: Number(raw.slice(0, 2)), m: Number(raw.slice(2)) }
  }
  const bare = /(?<!\d)(\d{1,2})(?!\d)/.exec(s)
  if (bare) return { h: Number(bare[1]), m: 0 }
  return null
}

function validHm(t: Hm | null): Hm | null {
  if (!t) return null
  return t.h >= 0 && t.h <= 23 && t.m >= 0 && t.m <= 59 ? t : null
}

/**
 * Час вечерней практики. §2.1 design-bot.
 *
 * «21», «21:00», «21.00», «21 30», «в 21», «9 вечера» → 21:00, «7 утра» → 07:00.
 * Без уточнения 4–11 считаем вечерними (+12), 0–3 оставляем как есть: человека
 * спросили, когда ему удобно ВЕЧЕРОМ, и «9» почти наверняка значит девять вечера.
 */
export function parseHour(input: string): Hm | null {
  const s = normalize(input)
  if (s === '') return null
  const part = dayPartOf(s)
  const t = validHm(firstTime(s))
  if (!t) return null

  let h = t.h
  switch (part) {
    case 'morning':
      // «12 утра» — это полночь; всё остальное утро уже записано как есть.
      if (h === 12) h = 0
      break
    case 'day':
      if (h < 5) h += 12
      break
    case 'evening':
      if (h < 12) h += 12
      break
    case 'night':
      // «11 ночи» — 23:00, «2 ночи» — 02:00.
      if (h >= 5 && h < 12) h += 12
      break
    default:
      if (h >= 4 && h <= 11) h += 12
      break
  }
  if (h > 23) return null
  return { h, m: t.m }
}

/**
 * «Сколько сейчас на часах». §2.1, §2.10 design-bot.
 *
 * Здесь никаких +12: человек называет то, что видит на экране телефона, и любая
 * догадка про «утро или вечер» уводила бы часовой пояс на двенадцать часов.
 */
export function parseClock(input: string): Hm | null {
  const s = normalize(input).replace(/^в\s+/, '')
  if (s === '') return null
  if (!/\d/.test(s)) return null
  return validHm(firstTime(s))
}

// ───────────────────────────── цифра замера 0–10 ─────────────────────────────

const NUMBER_WORDS: Record<string, number> = {
  ноль: 0, нуль: 0,
  один: 1, одна: 1, единица: 1,
  два: 2, две: 2, двойка: 2,
  три: 3, тройка: 3,
  четыре: 4, четвёрка: 4, четверка: 4,
  пять: 5, пятёрка: 5, пятерка: 5,
  шесть: 6, шестёрка: 6, шестерка: 6,
  семь: 7, семёрка: 7, семерка: 7,
  восемь: 8, восьмёрка: 8, восьмерка: 8,
  девять: 9, девятка: 9,
  десять: 10, десятка: 10,
}

export type NumberResult = { value: number } | { error: 'fraction' | 'range' | 'none'; a?: number; b?: number }

/**
 * Цифра замера. §2.6 design-bot.
 *
 * Возвращает либо значение, либо причину отказа — причина нужна вызывающему, чтобы
 * ответить нужным текстом (`num.fraction` / `num.range` / `num.not_number`), а не
 * одним «не понял» на все случаи.
 */
export function parseNumber(input: string): NumberResult {
  const s = normalize(input).replace(/,/g, '.')
  if (s === '') return { error: 'none' }

  // «7/10» и «7 из 10» — самая частая форма ответа словами, и она не должна
  // читаться как «два числа» и превращаться в «от 0 до 10 — какая ближе?».
  const outOfTen = /(?<!\d)(\d{1,2})\s*(?:\/|из)\s*10(?!\d)/.exec(s)
  if (outOfTen) {
    const v = Number(outOfTen[1])
    return v >= 0 && v <= 10 ? { value: v } : { error: 'range' }
  }

  const numbers = s.match(/-?\d+(?:\.\d+)?/g) ?? []

  if (numbers.length === 0) {
    const words = Object.keys(NUMBER_WORDS).filter((w) => new RegExp(`(^|[^а-яё])${w}([^а-яё]|$)`).test(s))
    if (words.length === 1) return { value: NUMBER_WORDS[words[0]] }
    return { error: 'none' }
  }

  if (numbers.length > 1) return { error: 'range' }

  const raw = numbers[0]
  const n = Number(raw)
  if (!Number.isFinite(n)) return { error: 'none' }

  if (!Number.isInteger(n)) {
    const a = Math.floor(n)
    const b = Math.ceil(n)
    // Дробь вне диапазона («11,5») — это всё-таки «не та шкала», а не «целое или дробное».
    if (a < 0 || b > 10) return { error: 'range' }
    return { error: 'fraction', a, b }
  }

  if (n < 0 || n > 10) return { error: 'range' }
  return { value: n }
}

// ───────────────────────────── payload /start ─────────────────────────────

export type StartPayload = { quizSum: number | null; raw: string | null }

/**
 * Разбор `?start=q42`. §1–§2, §7 docs/quiz-bot-integration.md.
 *
 * Всё, что не подошло под `^q(\d{1,2})$` с числом 0…70, игнорируется МОЛЧА: бот
 * никогда не просит «сначала пройди тест» и вообще не показывает, что чего-то ждал.
 */
export function parseStartPayload(payload: string | undefined | null): StartPayload {
  const raw = (payload ?? '').trim()
  if (raw === '') return { quizSum: null, raw: null }
  const m = /^q(\d{1,2})$/.exec(raw)
  if (!m) return { quizSum: null, raw }
  const sum = Number(m[1])
  return { quizSum: sum >= 0 && sum <= 70 ? sum : null, raw }
}

// ───────────────────────────── слово паузы ─────────────────────────────

const PAUSE_WORDS = ['пауза', 'стоп', 'хватит', 'не сейчас'] as const

/**
 * Слово паузы. §2.5 design-bot: только целиком, регистронезависимо.
 *
 * Именно целиком: «стоп» внутри «я не могу остановиться» — не просьба о паузе, и
 * поставить человека на паузу за такое было бы грубее, чем не понять его.
 */
export function isPauseWord(input: string): boolean {
  const s = normalize(input).replace(/[.!?…]+$/g, '').trim()
  return (PAUSE_WORDS as readonly string[]).includes(s)
}

/** Команда и её аргумент: «/demo qcgmjed3» → { cmd: 'demo', arg: 'qcgmjed3' }. */
export function parseCommand(input: string): { cmd: string; arg: string } | null {
  const m = /^\/([a-z_]+)(?:@[\w_]+)?(?:\s+(.*))?$/i.exec(input.trim())
  if (!m) return null
  return { cmd: m[1].toLowerCase(), arg: (m[2] ?? '').trim() }
}
