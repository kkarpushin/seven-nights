/**
 * Вход в админку. §6.1 архитектуры.
 *
 * Пароль один, логина нет: это рабочий стол двух человек внутри tailnet, а не
 * публичный сервис. Отсюда три решения.
 *
 * 1. Сравнение пароля — timingSafeEqual по sha256. Не потому, что кто-то будет
 *    мерить время через tailscale, а потому, что «==» в проверке пароля рано или
 *    поздно копируют в проект, где это важно.
 * 2. Токен живёт в таблице admin_sessions, а не в подписанной куке: сессию можно
 *    увидеть и оборвать, а при утечке базы подписанная кука всё равно не спасает.
 * 3. Счётчик неудач — в памяти процесса. Он переживает ровно то, что нужно пережить
 *    (перебор в течение минут), и умирает вместе с процессом, чего достаточно.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Context, MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { Ctx } from '../ctx.ts'
import { fail } from './util.ts'

export const COOKIE_NAME = 'sn_admin'
export const SESSION_TTL_SEC = 30 * 24 * 3600

/** §6.1: 5 неудач с одного адреса за 15 минут → отдых 15 минут. */
export const MAX_ATTEMPTS = 5
export const LOCK_WINDOW_SEC = 15 * 60

function sha256(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest()
}

/** Длины одинаковые всегда (32 байта), поэтому timingSafeEqual не бросит. */
export function passwordMatches(input: string, expected: string): boolean {
  return timingSafeEqual(sha256(input), sha256(expected))
}

export function newToken(): string {
  return randomBytes(32).toString('hex')
}

export type Attempts = {
  /** true — адресу сейчас нельзя пробовать; secondsLeft для обратного отсчёта на экране. */
  locked(ip: string, now: number): { locked: boolean; secondsLeft: number }
  fail(ip: string, now: number): void
  reset(ip: string): void
}

export function createAttempts(): Attempts {
  const byIp = new Map<string, { count: number; first: number }>()
  return {
    locked(ip, now) {
      const rec = byIp.get(ip)
      if (!rec) return { locked: false, secondsLeft: 0 }
      if (now - rec.first >= LOCK_WINDOW_SEC) {
        byIp.delete(ip)
        return { locked: false, secondsLeft: 0 }
      }
      if (rec.count < MAX_ATTEMPTS) return { locked: false, secondsLeft: 0 }
      return { locked: true, secondsLeft: LOCK_WINDOW_SEC - (now - rec.first) }
    },
    fail(ip, now) {
      const rec = byIp.get(ip)
      if (!rec || now - rec.first >= LOCK_WINDOW_SEC) byIp.set(ip, { count: 1, first: now })
      else rec.count += 1
    },
    reset: (ip) => void byIp.delete(ip),
  }
}

/** Адрес запроса: за прокси (Caddy появится позже) реальный адрес приходит заголовком. */
export function clientIp(c: Context): string {
  const fwd = c.req.header('x-forwarded-for')
  if (fwd) return fwd.split(',')[0]!.trim()
  return c.req.header('x-real-ip') ?? 'local'
}

export type AuthDeps = { ctx: Ctx; attempts: Attempts }

/**
 * Сторож всех /api/admin/*, кроме входа. SPA по /admin отдаётся без него — там
 * только код; данные без куки не отдаются никогда.
 */
export function requireAuth(ctx: Ctx): MiddlewareHandler {
  return async (c, next) => {
    const token = getCookie(c, COOKIE_NAME)
    if (!token || !ctx.repo.adminSessions.touch(token, ctx.clock.now())) {
      // Протухшую куку стираем сразу: иначе браузер будет слать её ещё месяц.
      if (token) deleteCookie(c, COOKIE_NAME, { path: '/' })
      return fail(c, 401, 'unauthorized', 'Нужно войти заново.')
    }
    await next()
  }
}

export function issueSession(c: Context, ctx: Ctx, remember: boolean): string {
  const token = newToken()
  const now = ctx.clock.now()
  ctx.repo.adminSessions.create(token, now, c.req.header('user-agent') ?? null, SESSION_TTL_SEC)
  setCookie(c, COOKIE_NAME, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure: ctx.cfg.adminCookieSecure,
    // «Не запоминать» = сессионная кука: закрыла браузер — вышла.
    ...(remember ? { maxAge: SESSION_TTL_SEC } : {}),
  })
  return token
}

export function dropSession(c: Context, ctx: Ctx): void {
  const token = getCookie(c, COOKIE_NAME)
  if (token) ctx.repo.adminSessions.destroy(token)
  deleteCookie(c, COOKIE_NAME, { path: '/' })
}
