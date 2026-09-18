/**
 * Мелочи, общие для всех маршрутов админки: ответы об ошибках, разбор окна дат,
 * CSV и предпросмотр текстов.
 *
 * Главное здесь — формат ошибки. Админкой пользуется не инженер, а психолог, и
 * строка `message` попадает к ней на экран как есть. Поэтому код (`error`) —
 * для фронтенда, а `message` всегда законченное русское предложение.
 */

import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { fmtHm, partsOf } from '../time.ts'

export type ApiError = { error: string; message: string; [k: string]: unknown }

export function fail(
  c: Context,
  status: ContentfulStatusCode,
  error: string,
  message: string,
  extra: Record<string, unknown> = {},
) {
  return c.json({ error, message, ...extra } satisfies ApiError, status)
}

/** Ни один ответ админки не должен осесть в кеше браузера: данные живые. */
export function noStore(c: Context): void {
  c.header('Cache-Control', 'no-store')
}

// ─────────────────────────────── время ───────────────────────────────

export const DAY = 86_400

export type Window = { from: number; to: number; days: number | null; period: string }

/**
 * Окно дашборда. `period=7|30|all` — то, что стоит в переключателе; `from`/`to`
 * в секундах остаются для ссылок и экспорта.
 */
export function parseWindow(c: Context, now: number): Window {
  const period = (c.req.query('period') ?? '30').toLowerCase()
  const fromQ = Number(c.req.query('from'))
  const toQ = Number(c.req.query('to'))
  if (Number.isFinite(fromQ) && fromQ > 0) {
    const to = Number.isFinite(toQ) && toQ > 0 ? toQ : now
    return { from: Math.trunc(fromQ), to: Math.trunc(to), days: Math.round((to - fromQ) / DAY), period: 'custom' }
  }
  if (period === 'all') return { from: 0, to: now, days: null, period: 'all' }
  const days = period === '7' ? 7 : 30
  return { from: now - days * DAY, to: now, days, period: String(days) }
}

/** Переключатель «показывать демо» — один параметр на все запросы статистики. */
export function wantsDemo(c: Context): boolean {
  const v = (c.req.query('demo') ?? '').toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}

/** 'YYYY-MM-DD HH:MM' в UTC — формат дат во всех выгрузках. */
export function fmtUtc(sec: number | null): string {
  if (sec === null || sec === undefined) return ''
  const p = partsOf(sec)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${p.y}-${two(p.mo)}-${two(p.d)} ${two(p.h)}:${two(p.mi)}`
}

/** То же время глазами человека: сдвиг его пояса уже применён. */
export function fmtUserLocal(sec: number | null, offsetMin: number): string {
  if (sec === null || sec === undefined) return ''
  return fmtUtc(sec + offsetMin * 60)
}

export { fmtHm }

// ─────────────────────────────── CSV ───────────────────────────────

/**
 * Файл открывают в Excel, поэтому: BOM (иначе кириллица превратится в кракозябры),
 * разделитель «;» (русская локаль Excel не понимает запятую) и CRLF.
 */
export function csv(rows: Array<Array<string | number | null | undefined>>): string {
  const cell = (v: string | number | null | undefined): string => {
    if (v === null || v === undefined) return ''
    const s = String(v)
    return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return '﻿' + rows.map((r) => r.map(cell).join(';')).join('\r\n') + '\r\n'
}

export function csvResponse(c: Context, filename: string, rows: Array<Array<string | number | null | undefined>>) {
  c.header('Content-Type', 'text/csv; charset=utf-8')
  c.header('Content-Disposition', `attachment; filename="${filename}"`)
  c.header('Cache-Control', 'no-store')
  return c.body(csv(rows))
}

// ────────────────────────── предпросмотр текстов ──────────────────────────

export function bar(v: number): string {
  const n = Math.max(0, Math.min(10, Math.trunc(v)))
  return '▰'.repeat(n) + '▱'.repeat(10 - n)
}

export function dots(n: number): string {
  const k = Math.max(0, Math.min(7, Math.trunc(n)))
  return '●'.repeat(k) + '○'.repeat(7 - k)
}

/**
 * Значения-образцы для предпросмотра. Это НЕ рендер бота (он в src/texts.ts):
 * админке нужно показать, как формулировка сядет на живые числа, и показать это
 * до того, как текст сохранён, — то есть по строке из поля, а не по строке из базы.
 */
export const PREVIEW_VARS: Record<string, string> = {
  '{n}': '3',
  '{time}': '21:00',
  '{when}': 'сегодня',
  '{before}': '4',
  '{after}': '7',
  '{d}': '3',
  '{bar}': bar(7),
  '{dots}': dots(3),
  '{delta}': 'На 3 деления легче.',
  '{line1}': 'Ложись удобно и закрой глаза.',
  '{line2}': 'Я рядом, дыши как дышится.',
  '{title}': 'Отпустить день',
  '{category}': '😴 Сон и расслабление',
  '{clock}': '21:15',
  '{id}': '42',
  '{tz}': 'UTC+3',
  '{quiz_index}': '58',
  '{quiz_sum}': '41',
  '{quiz_index_after}': '71',
  '{first_before}': '4',
  '{last_after}': '7',
  '{avg}': '2,4',
  '{a}': '3',
  '{b}': '7',
  '{k}': '3',
  '{деление}': 'деления',
  '{вопрос}': 'вопроса',
  '{text}': 'Сегодня было тяжело, но я послушала.',
  '{q}': '3',
  '{value}': '7',
}

/** Подстановка образцов. Незнакомый плейсхолдер остаётся как есть — он и есть ошибка, которую надо увидеть. */
export function renderPreview(template: string, extra: Record<string, string> = {}): string {
  const vars = { ...PREVIEW_VARS, ...extra }
  return template.replace(/\{[^{}\s]{1,40}\}/g, (m) => vars[m] ?? m)
}

/** Все плейсхолдеры, встречающиеся в строке. */
export function usedPlaceholders(value: string): string[] {
  const out: string[] = []
  for (const m of value.matchAll(/\{[^{}\s]{1,40}\}/g)) {
    if (!out.includes(m[0])) out.push(m[0])
  }
  return out
}

// ─────────────────────────── разбор параметров ───────────────────────────

export function intParam(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

/** Тело запроса как объект. Кривой JSON — это 400, а не 500. */
export async function jsonBody(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json()
    return body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : null
  } catch {
    return null
  }
}
