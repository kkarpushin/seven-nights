/**
 * Время. §4.3 архитектуры, §1 и §2.10 design-bot.
 *
 * Три правила, из которых следует весь файл:
 *
 * 1. В базе всё в unix-секундах UTC. «Локальное» — это UTC + tz_offset_min, и больше
 *    ничего: ни зоны, ни летнего времени, ни часового пояса сервера. Поэтому здесь
 *    нет ни одного getFullYear() — только getUTC*, применённые к сдвинутой метке.
 *    Сервер живёт в UTC (TZ=UTC в юните), но код не должен на это полагаться.
 *
 * 2. «Ритуальная дата» — локальная дата момента now − 4 часа. Из этого следует, что
 *    ритуальные сутки идут с 04:00 до 04:00 следующего дня, и ответ в 00:30 относится
 *    к вечеру вчерашнего календарного дня. Весь файл считает именно в этих сутках.
 *
 * 3. Вечерний час может быть ночным (человек выбрал 01:00). Тогда «вечер ритуальной
 *    даты D» наступает в 01:00 календарного дня D+1 — иначе он оказался бы в прошлом
 *    на сутки. Это единственная неочевидная арифметика здесь, она собрана в
 *    eveningAtForRitualDate и используется всеми остальными.
 */

import type { UserRow } from './db/types.ts'

/** Функциям времени нужны четыре поля, а не вся строка — так их проще звать из тестов. */
export type TimeUser = Pick<UserRow, 'tz_offset_min' | 'evening_time'> &
  Partial<Pick<UserRow, 'demo' | 'demo_day_counter'>>

export const DAY_SEC = 86_400

/** Граница ритуальных суток по умолчанию; переопределяется settings.ritual_day_start_hour. */
export const RITUAL_DAY_START_HOUR = 4

export const MIN_TZ_OFFSET_MIN = -720
export const MAX_TZ_OFFSET_MIN = 840

// ───────────────────────────── базовые преобразования ─────────────────────────────

export function localSec(u: TimeUser, utc: number): number {
  return utc + u.tz_offset_min * 60
}

export function utcFromLocal(u: TimeUser, local: number): number {
  return local - u.tz_offset_min * 60
}

export type LocalParts = { y: number; mo: number; d: number; h: number; mi: number; s: number }

/** Разбор «локальных секунд» как UTC-даты: смещение уже внутри числа. */
export function partsOf(local: number): LocalParts {
  const dt = new Date(local * 1000)
  return {
    y: dt.getUTCFullYear(),
    mo: dt.getUTCMonth() + 1,
    d: dt.getUTCDate(),
    h: dt.getUTCHours(),
    mi: dt.getUTCMinutes(),
    s: dt.getUTCSeconds(),
  }
}

const p2 = (n: number): string => String(n).padStart(2, '0')

export function toIsoDate(local: number): string {
  const p = partsOf(local)
  return `${p.y}-${p2(p.mo)}-${p2(p.d)}`
}

/** 'YYYY-MM-DD' → локальные секунды полуночи этой даты. */
export function isoDateToLocal(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) throw new Error(`Некорректная дата «${iso}», ожидается YYYY-MM-DD`)
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0) / 1000
}

export function addDaysIso(iso: string, days: number): string {
  return toIsoDate(isoDateToLocal(iso) + days * DAY_SEC)
}

/** 'HH:MM' → минуты от полуночи. Бросает: значение приходит из нашей же базы. */
export function hmToMinutes(hm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim())
  if (!m) throw new Error(`Некорректное время «${hm}», ожидается HH:MM`)
  const h = Number(m[1])
  const mi = Number(m[2])
  if (h > 23 || mi > 59) throw new Error(`Некорректное время «${hm}»`)
  return h * 60 + mi
}

export function minutesToHm(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440
  return `${p2(Math.floor(m / 60))}:${p2(m % 60)}`
}

/** Локальное время метки как «18:42». */
export function fmtHm(sec: number, offsetMin: number): string {
  const p = partsOf(sec + offsetMin * 60)
  return `${p2(p.h)}:${p2(p.mi)}`
}

/** Смещение как «UTC+3», «UTC+5:30», «UTC-4» — для админки и уведомления admin.started. */
export function fmtTz(offsetMin: number): string {
  const sign = offsetMin < 0 ? '-' : '+'
  const abs = Math.abs(offsetMin)
  const h = Math.floor(abs / 60)
  const m = abs % 60
  return m === 0 ? `UTC${sign}${h}` : `UTC${sign}${h}:${p2(m)}`
}

export function localHm(u: TimeUser, utc: number): { h: number; m: number } {
  const p = partsOf(localSec(u, utc))
  return { h: p.h, m: p.mi }
}

/** Локальная календарная дата момента. */
export function localDate(u: TimeUser, utc: number): string {
  return toIsoDate(localSec(u, utc))
}

// ───────────────────────────── ритуальные сутки ─────────────────────────────

/** Календарная ритуальная дата: локальная дата момента now − 4 ч. Без демо-подмены. */
export function ritualDateCalendar(u: TimeUser, utc: number, startHour = RITUAL_DAY_START_HOUR): string {
  return toIsoDate(localSec(u, utc) - startHour * 3600)
}

/**
 * Ритуальная дата в том виде, в каком она ложится в sessions.ritual_date.
 * В демо календарь не при чём: «сутки» — это счётчик, который двигает закрытие вечера,
 * иначе уникальный индекс «один вечер на дату» запретил бы семь вечеров за полчаса.
 */
export function ritualDate(u: TimeUser, utc: number, startHour = RITUAL_DAY_START_HOUR): string {
  if (u.demo) return `demo-${u.demo_day_counter ?? 0}`
  return ritualDateCalendar(u, utc, startHour)
}

/** Локальные «HH:MM» указанной календарной даты → UTC. */
export function atLocalHm(u: TimeUser, dateIso: string, hm: string): number {
  return utcFromLocal(u, isoDateToLocal(dateIso) + hmToMinutes(hm) * 60)
}

/**
 * Момент вечера для ритуальной даты D.
 * Вечерний час ≥ 04:00 — это тот же календарный день; час 00:00–03:59 принадлежит
 * ритуальным суткам D, но лежит уже в календарном дне D+1.
 */
export function eveningAtForRitualDate(
  u: TimeUser,
  ritualIso: string,
  startHour = RITUAL_DAY_START_HOUR,
): number {
  const minutes = hmToMinutes(u.evening_time)
  const dayIso = minutes < startHour * 60 ? addDaysIso(ritualIso, 1) : ritualIso
  return atLocalHm(u, dayIso, u.evening_time)
}

/** Конец текущих ритуальных суток: ближайшие локальные 04:00 строго после from. */
export function endOfRitualDay(u: TimeUser, from: number, startHour = RITUAL_DAY_START_HOUR): number {
  const today = ritualDateCalendar(u, from, startHour)
  return atLocalHm(u, addDaysIso(today, 1), minutesToHm(startHour * 60))
}

/** Ближайшее наступление вечернего часа строго после from. */
export function nextEveningAt(u: TimeUser, from: number, startHour = RITUAL_DAY_START_HOUR): number {
  const today = ritualDateCalendar(u, from, startHour)
  const cand = eveningAtForRitualDate(u, today, startHour)
  return cand > from ? cand : eveningAtForRitualDate(u, addDaysIso(today, 1), startHour)
}

/** Ближайшее наступление HH:MM по календарным суткам, строго после from (утро, день 8). */
export function nextMorningAt(u: TimeUser, from: number, hm: string): number {
  const today = localDate(u, from)
  const cand = atLocalHm(u, today, hm)
  return cand > from ? cand : atLocalHm(u, addDaysIso(today, 1), hm)
}

/**
 * Вечернее окно: [{time} − leadMin; 03:59 конца ритуальных суток] локально.
 * Внутри него «Практика сейчас» сливается с вечером программы (строка 29 §3.2).
 */
export function isEveningWindow(u: TimeUser, at: number, leadMin: number, startHour = RITUAL_DAY_START_HOUR): boolean {
  if (u.demo) return true
  const today = ritualDateCalendar(u, at, startHour)
  const start = eveningAtForRitualDate(u, today, startHour) - leadMin * 60
  const end = endOfRitualDay(u, at, startHour)
  return at >= start && at < end
}

/** «сегодня» / «завтра» — по локальной календарной дате, как в design-bot §2.1. */
export function whenWord(u: TimeUser, target: number, now: number): 'сегодня' | 'завтра' {
  return localDate(u, target) === localDate(u, now) ? 'сегодня' : 'завтра'
}

// ───────────────────────────── часовой пояс ─────────────────────────────

/** Округление до 15 минут: покрывает +5:30 (Индия) и +5:45 (Непал). */
export function round15(minutes: number): number {
  return Math.round(minutes / 15) * 15
}

/** Нормализация смещения: округлить до 15 минут и проверить диапазон [−720, +840]. */
export function normalizeOffsetMin(minutes: number): number | null {
  if (!Number.isFinite(minutes)) return null
  const r = round15(minutes)
  return r >= MIN_TZ_OFFSET_MIN && r <= MAX_TZ_OFFSET_MIN ? r : null
}

/**
 * Смещение из ответа «сколько сейчас на часах». §2.10 design-bot, пункт 3.
 *
 * Человек назвал время суток, мы знаем момент отправки в UTC — разница и есть пояс.
 * Тонкость: разница определена с точностью до суток, поэтому кандидатов три, и у
 * диапазона [−12, +14] ширина 26 часов, то есть ровно на ±12:00 подходят сразу два.
 * Берём ближайшего к подсказке (кнопка знает свой пояс) или к нулю.
 */
export function offsetFromLocalClock(
  local: { h: number; m: number },
  messageDateUtc: number,
  hintOffsetMin?: number,
): number | null {
  const localMinOfDay = local.h * 60 + local.m
  const utcMinOfDay = Math.floor((((messageDateUtc % DAY_SEC) + DAY_SEC) % DAY_SEC) / 60)
  const base = localMinOfDay - utcMinOfDay
  const anchor = hintOffsetMin ?? 0
  let best: number | null = null
  for (const cand of [base - 1440, base, base + 1440]) {
    const norm = normalizeOffsetMin(cand)
    if (norm === null) continue
    if (best === null || Math.abs(norm - anchor) < Math.abs(best - anchor)) best = norm
  }
  return best
}

/** Гипотеза пояса по language_code (§2.10 design-bot, пункт 1). */
export function guessOffsetByLanguage(languageCode: string | null | undefined, fallbackMin: number): number {
  const lang = (languageCode ?? '').toLowerCase().split(/[-_]/)[0]
  switch (lang) {
    case 'ru':
    case 'uk':
    case 'be':
      return 180
    case 'kk':
    case 'uz':
    case 'tg':
    case 'tk':
      return 300
    case 'ky':
      return 360
    case 'ka':
    case 'hy':
    case 'az':
      return 240
    case 'de':
    case 'pl':
    case 'cs':
    case 'sk':
    case 'hu':
    case 'sr':
    case 'hr':
      return 120
    case 'he':
    case 'tr':
    case 'ro':
    case 'bg':
    case 'el':
    case 'fi':
    case 'lt':
    case 'lv':
    case 'et':
    case 'md':
      return 180
    default:
      return fallbackMin
  }
}

export type ClockOption = { label: string; offsetMin: number }

/**
 * Три кнопки «сколько сейчас на часах»: гипотеза, час назад, час вперёд.
 * Минуты у всех трёх одинаковые — именно это делает нужную кнопку узнаваемой
 * с одного взгляда («у меня 18:42, вот же оно»).
 */
export function clockOptions(guessOffsetMin: number, nowUtc: number): ClockOption[] {
  const out: ClockOption[] = []
  for (const delta of [0, -60, 60]) {
    const off = normalizeOffsetMin(guessOffsetMin + delta)
    if (off === null || out.some((o) => o.offsetMin === off)) continue
    out.push({ label: fmtHm(nowUtc, off), offsetMin: off })
  }
  return out
}
