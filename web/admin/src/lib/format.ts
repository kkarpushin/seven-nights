/**
 * Форматирование по-русски. Одно место на всё приложение, потому что «19 августа»
 * и «19.08.2025» на соседних экранах — это уже две разные программы на вид.
 */

import type { AfterSource, Category, UserState } from '../types.ts'

const DATE = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' })
const DATE_FULL = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
const TIME = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' })
const WEEKDAY = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })
const RELATIVE = new Intl.RelativeTimeFormat('ru', { numeric: 'auto' })

export function fmtDate(sec: number | null | undefined): string {
  if (!sec) return '—'
  return DATE.format(new Date(sec * 1000))
}

export function fmtDateFull(sec: number | null | undefined): string {
  if (!sec) return '—'
  return DATE_FULL.format(new Date(sec * 1000))
}

export function fmtTime(sec: number | null | undefined): string {
  if (!sec) return ''
  return TIME.format(new Date(sec * 1000))
}

export function fmtWeekday(iso: string): string {
  return WEEKDAY.format(new Date(`${iso}T12:00:00Z`))
}

/** «12 минут назад», «2 дня назад». Всё, что новее минуты, — «только что». */
export function fmtAgo(sec: number | null | undefined, now: number): string {
  if (!sec) return 'ни разу'
  const diff = sec - now
  const abs = Math.abs(diff)
  if (abs < 60) return 'только что'
  if (abs < 3600) return RELATIVE.format(Math.round(diff / 60), 'minute')
  if (abs < 86_400) return RELATIVE.format(Math.round(diff / 3600), 'hour')
  if (abs < 2_592_000) return RELATIVE.format(Math.round(diff / 86_400), 'day')
  return RELATIVE.format(Math.round(diff / 2_592_000), 'month')
}

/** Десятичная запятая: «+2,4». Ноль остаётся нулём, а не «+0». */
export function fmtNum(n: number | null | undefined, digits = 1, sign = false): string {
  if (n === null || n === undefined) return '—'
  const rounded = Math.round(n * 10 ** digits) / 10 ** digits
  const text = rounded.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: digits })
  return sign && rounded > 0 ? `+${text}` : text
}

export function fmtPercent(part: number, whole: number): string {
  if (whole === 0) return '0%'
  return `${Math.round((part / whole) * 100)}%`
}

export function fmtDuration(sec: number | null | undefined): string {
  if (!sec) return '—'
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export function fmtBytes(bytes: number | null | undefined): string {
  if (!bytes) return ''
  const mb = bytes / (1024 * 1024)
  return mb >= 1 ? `${fmtNum(mb, 1)} МБ` : `${Math.round(bytes / 1024)} КБ`
}

export function plural(n: number, forms: [string, string, string]): string {
  const abs = Math.abs(Math.trunc(n))
  if (abs % 100 >= 11 && abs % 100 <= 14) return forms[2]
  if (abs % 10 === 1) return forms[0]
  if (abs % 10 >= 2 && abs % 10 <= 4) return forms[1]
  return forms[2]
}

export function fmtPeople(n: number): string {
  return `${n} ${plural(n, ['человек', 'человека', 'человек'])}`
}

export const dots = (n: number): string => '●'.repeat(Math.max(0, Math.min(7, n))) + '○'.repeat(Math.max(0, 7 - n))
export const bar = (v: number): string => '▰'.repeat(Math.max(0, Math.min(10, v))) + '▱'.repeat(Math.max(0, 10 - v))

// ─────────────────────────── словарь состояний ───────────────────────────

export type StatusKind = 'run' | 'pause' | 'done' | 'silent' | 'blocked' | 'new'

/** Статус для чипа: не состояние машины, а то, что видит специалист. */
export function statusOf(u: { state: UserState; last_seen_at: number | null }, now: number): StatusKind {
  if (u.state === 'blocked') return 'blocked'
  if (u.state === 'paused') return 'pause'
  if (u.state === 'completed') return 'done'
  if (u.state === 'new' || u.state === 'onb_hour' || u.state === 'onb_clock') return 'new'
  if (u.last_seen_at !== null && now - u.last_seen_at > 3 * 86_400) return 'silent'
  return 'run'
}

export const STATUS_LABEL: Record<StatusKind, string> = {
  run: 'Идёт',
  pause: 'Пауза',
  done: 'Финиш',
  silent: 'Молчит',
  blocked: 'Заблокировал бота',
  new: 'Знакомится',
}

export const STATUS_COLOR: Record<StatusKind, string> = {
  run: 'var(--color-st-run)',
  pause: 'var(--color-st-pause)',
  done: 'var(--color-st-done)',
  silent: 'var(--color-st-silent)',
  blocked: 'var(--color-st-blocked)',
  new: 'var(--color-ink3)',
}

/** Что бот прямо сейчас ждёт от человека — строка для списка «Сейчас в программе». */
export const WAITING_LABEL: Record<UserState, string> = {
  new: 'только пришёл',
  onb_hour: 'выбирает час',
  onb_clock: 'уточняет время',
  idle: 'ждёт вечера',
  awaiting_before: 'ждёт цифру «до»',
  awaiting_state: 'выбирает состояние',
  practicing: 'слушает практику',
  awaiting_after: 'ждёт цифру «после»',
  paused: 'на паузе',
  completed: 'прошёл семь вечеров',
  blocked: 'заблокировал бота',
  change_hour: 'меняет время',
  change_clock: 'меняет время',
  quiz_after: 'проходит тест',
}

export const CATEGORY_LABEL: Record<Category, string> = {
  sleep: '😴 Сон и расслабление',
  calm: '🌿 Тревога и стресс',
  day: '🌅 Настроиться на день',
}

export const CATEGORY_SHORT: Record<Category, string> = {
  sleep: 'сон и расслабление',
  calm: 'тревога и стресс',
  day: 'настроиться на день',
}

export const CATEGORY_COLOR: Record<Category, string> = {
  sleep: 'var(--color-s1)',
  calm: 'var(--color-s3)',
  day: 'var(--color-s2)',
}

export const AFTER_SOURCE_LABEL: Record<AfterSource | 'none', string> = {
  button: 'нажал «Готово» и ответил',
  timer: 'ответил после напоминания',
  early: 'прислал цифру сам',
  morning: 'ответил утром',
  none: 'не ответил',
}

export function afterSourceText(source: AfterSource | null, doneAfterSec: number | null): string {
  if (source === null) return 'не ответил'
  if (source === 'button' && doneAfterSec !== null) {
    const min = Math.round(doneAfterSec / 60)
    return `нажал «Готово» через ${min} ${plural(min, ['минуту', 'минуты', 'минут'])}`
  }
  return AFTER_SOURCE_LABEL[source]
}
