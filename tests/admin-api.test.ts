/**
 * Админка: API целиком, без сети и без файла базы.
 *
 * Hono умеет `app.request()` — тот же путь, что у живого запроса, включая
 * middleware и куки, но в памяти. Поэтому здесь проверяется не «функция вернула
 * объект», а «браузер получил 401», что и есть предмет договорённости §6.
 *
 * Главное, ради чего этот файл существует: охрана. Один забытый маршрут без
 * requireAuth — это открытая наружу база с чужими замерами, и заметить это
 * глазами в списке из тридцати маршрутов нельзя.
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hono } from 'hono'
import { createApp } from '../src/http/server.ts'
import { validateText } from '../src/admin-api/routes/texts.ts'
import { estimateMp3Seconds, checkAudio } from '../src/admin-api/audio.ts'
import { csv, renderPreview, usedPlaceholders } from '../src/admin-api/util.ts'
import { safeJoin } from '../src/http/server.ts'
import { parsePlaceholders } from '../src/db/texts.ts'
import {
  addEvent, makeSession, makeUser, seedTestPractices, T0, testCtx, type TestCtx,
} from './helpers/db.ts'

const PASSWORD = 'test-password'

type Harness = { ctx: TestCtx; app: Hono; cookie: string }

/** Собранная админка со свежей базой; вход уже выполнен, кука лежит в harness. */
async function harness(opts: Parameters<typeof testCtx>[0] = {}): Promise<Harness> {
  const ctx = testCtx(opts)
  const app = createApp(ctx)
  const res = await app.request('/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  })
  expect(res.status).toBe(200)
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!
  return { ctx, app, cookie }
}

async function get(h: Harness, path: string): Promise<Response> {
  return await h.app.request(path, { headers: { cookie: h.cookie } })
}

async function send(h: Harness, path: string, method: string, body?: unknown): Promise<Response> {
  return await h.app.request(path, {
    method,
    headers: { cookie: h.cookie, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

describe('вход', () => {
  it('без куки любой маршрут данных отвечает 401', async () => {
    const ctx = testCtx()
    const app = createApp(ctx)
    for (const path of [
      '/api/admin/me', '/api/admin/stats', '/api/admin/users', '/api/admin/practices',
      '/api/admin/texts', '/api/admin/settings', '/api/admin/events', '/api/admin/notifications',
      '/api/admin/messages', '/api/admin/export/users.csv',
    ]) {
      const res = await app.request(path)
      expect(res.status, path).toBe(401)
    }
  })

  it('без куки закрыты и записывающие маршруты, а не только чтение', async () => {
    const ctx = testCtx()
    const app = createApp(ctx)
    const calls: Array<[string, string]> = [
      ['POST', '/api/admin/users/1/pause'],
      ['POST', '/api/admin/users/1/demo'],
      ['POST', '/api/admin/users/1/message'],
      ['DELETE', '/api/admin/users/1'],
      ['POST', '/api/admin/practices'],
      ['PATCH', '/api/admin/practices/1'],
      ['POST', '/api/admin/practices/1/audio'],
      ['POST', '/api/admin/practices/reorder'],
      ['PUT', '/api/admin/texts/onb.welcome'],
      ['POST', '/api/admin/texts/onb.welcome/reset'],
      ['PUT', '/api/admin/settings'],
      ['POST', '/api/admin/settings/test-notification'],
      ['POST', '/api/admin/notifications/1/retry'],
    ]
    for (const [method, path] of calls) {
      const res = await app.request(path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'DELETE' ? undefined : '{}',
      })
      expect(res.status, `${method} ${path}`).toBe(401)
    }
  })

  it('отказ после перебора говорит, сколько ждать — экран показывает это число', async () => {
    const ctx = testCtx()
    const app = createApp(ctx)
    const attempt = (password: string) =>
      app.request('/api/admin/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.9' },
        body: JSON.stringify({ password }),
      })
    for (let i = 0; i < 5; i++) await attempt('nope')
    const res = await attempt('nope')
    const body = await res.json()
    expect(res.status).toBe(429)
    expect(body.secondsLeft).toBeGreaterThan(0)
    expect(body.secondsLeft).toBeLessThanOrEqual(15 * 60)
  })

  it('неверный пароль — 401 с человеческой строкой, верный — кука', async () => {
    const ctx = testCtx()
    const app = createApp(ctx)
    const bad = await app.request('/api/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'nope' }),
    })
    expect(bad.status).toBe(401)
    expect((await bad.json()).message).toMatch(/Caps Lock/)
    expect(bad.headers.get('set-cookie')).toBeNull()

    const ok = await app.request('/api/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    })
    const cookie = ok.headers.get('set-cookie') ?? ''
    expect(cookie).toMatch(/HttpOnly/i)
    expect(cookie).toMatch(/SameSite=Lax/i)
    expect(cookie).not.toMatch(/Secure/i) // ADMIN_COOKIE_SECURE=0 в тестовом окружении
  })

  it('«не запоминать» даёт сессионную куку без Max-Age', async () => {
    const ctx = testCtx()
    const app = createApp(ctx)
    const res = await app.request('/api/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD, remember: false }),
    })
    expect(res.headers.get('set-cookie')).not.toMatch(/Max-Age/i)
  })

  it('пять промахов подряд — 429, и правильный пароль тоже ждёт', async () => {
    const ctx = testCtx()
    const app = createApp(ctx)
    const attempt = (password: string) =>
      app.request('/api/admin/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.7' },
        body: JSON.stringify({ password }),
      })
    for (let i = 0; i < 5; i++) expect((await attempt('nope')).status).toBe(401)
    expect((await attempt('nope')).status).toBe(429)
    expect((await attempt(PASSWORD)).status).toBe(429)
  })

  it('выход убивает сессию: та же кука больше не работает', async () => {
    const h = await harness()
    expect((await get(h, '/api/admin/me')).status).toBe(200)
    expect((await send(h, '/api/admin/logout', 'POST')).status).toBe(200)
    expect((await get(h, '/api/admin/me')).status).toBe(401)
  })

  it('протухшая сессия не воскресает', async () => {
    const h = await harness()
    h.ctx.clock.advance(31 * 24 * 3600)
    expect((await get(h, '/api/admin/me')).status).toBe(401)
  })
})

describe('/healthz и статика', () => {
  it('healthz открыт и считает просроченные таймеры', async () => {
    const ctx = testCtx()
    makeUser(ctx.db, { due_at: T0 - 10, due_kind: 'ping' })
    makeUser(ctx.db, { due_at: T0 + 10_000, due_kind: 'ping' })
    const res = await createApp(ctx).request('/healthz')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.dueBacklog).toBe(1)
    expect(body.users).toBe(2)
  })

  it('лендинг отдаётся с корня', async () => {
    const res = await createApp(testCtx()).request('/')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    expect(await res.text()).toMatch(/Семь ночей/)
  })

  it('из статики нельзя выйти наверх по ../', async () => {
    expect(safeJoin('/srv/web', '../../etc/passwd')).toBeNull()
    expect(safeJoin('/srv/web', '%2e%2e/%2e%2e/etc/passwd')).toBeNull()
    expect(safeJoin('/srv/web', 'styles.css')).toBe('/srv/web/styles.css')
  })

  it('аудио для плеера закрыто куками', async () => {
    const ctx = testCtx()
    expect((await createApp(ctx).request('/media/practices/sleep-landing.mp3')).status).toBe(401)
  })
})

describe('люди', () => {
  async function withPeople(): Promise<Harness> {
    const h = await harness()
    seedTestPractices(h.ctx.db)
    const u = makeUser(h.ctx.db, { state: 'idle', current_evening: 2, last_seen_at: T0, quiz_sum: 42, quiz_index: 60 })
    makeSession(h.ctx.db, { userId: u.id, eveningNo: 1, before: 4, after: 7, practiceId: 1 })
    makeSession(h.ctx.db, { userId: u.id, eveningNo: 2, before: 5, after: 8, practiceId: 2 })
    addEvent(h.ctx.db, u.id, 'started', T0 - 100)
    h.ctx.repo.messages.add(u.id, 'Сегодня было тяжело', 'idle', null, T0 + 50)
    return h
  }

  it('список отдаёт номер, вечер, прирост и пояс', async () => {
    const h = await withPeople()
    const body = await (await get(h, '/api/admin/users')).json()
    expect(body.total).toBe(1)
    expect(body.rows[0].current_evening).toBe(2)
    expect(body.rows[0].delta).toBe(4) // 8 − 4
    expect(body.rows[0].tz).toBe('UTC+3')
  })

  it('демо-людей в списке не видно, пока не попросили', async () => {
    const h = await harness()
    makeUser(h.ctx.db, { demo: 1 })
    expect((await (await get(h, '/api/admin/users')).json()).total).toBe(0)
    expect((await (await get(h, '/api/admin/users?demo=1')).json()).total).toBe(1)
  })

  it('карточка собирает график, ленту и оба замера теста', async () => {
    const h = await withPeople()
    const card = await (await get(h, '/api/admin/users/1')).json()
    expect(card.user.id).toBe(1)
    expect(card.chart).toEqual([
      { evening: 1, before: 4, after: 7, date: '2025-09-11' },
      { evening: 2, before: 5, after: 8, date: '2025-09-12' },
    ])
    expect(card.quiz.before.index).toBe(60)
    expect(card.quiz.after.index).toBeNull()
    expect(card.quiz.after.answers).toHaveLength(7)

    // Лента: четыре карточки замеров, две практики, сообщение, событие «начал».
    const kinds = card.timeline.map((t: { kind: string }) => t.kind)
    expect(kinds.filter((k: string) => k === 'measure_before')).toHaveLength(2)
    expect(kinds.filter((k: string) => k === 'measure_after')).toHaveLength(2)
    expect(kinds.filter((k: string) => k === 'practice')).toHaveLength(2)
    expect(kinds).toContain('message')
    expect(kinds).toContain('event')
    // По убыванию времени — §6.2.
    const times = card.timeline.map((t: { at: number }) => t.at)
    expect([...times].sort((a: number, b: number) => b - a)).toEqual(times)
  })

  it('карточки несуществующего человека нет', async () => {
    const h = await harness()
    expect((await get(h, '/api/admin/users/777')).status).toBe(404)
  })

  it('пауза снимает таймер, а снятие с паузы его возвращает', async () => {
    const h = await harness()
    const u = makeUser(h.ctx.db, { state: 'idle', evening_time: '21:00', due_at: T0 + 100, due_kind: 'ping' })

    const paused = await (await send(h, `/api/admin/users/${u.id}/pause`, 'POST', { on: true })).json()
    expect(paused.user.state).toBe('paused')
    expect(paused.user.due_at).toBeNull()

    const resumed = await (await send(h, `/api/admin/users/${u.id}/pause`, 'POST', { on: false })).json()
    expect(resumed.user.state).toBe('idle')
    expect(resumed.user.due_kind).toBe('ping')
    // Следующий вечер — строго в будущем, иначе планировщик сработает мгновенно.
    expect(resumed.user.due_at).toBeGreaterThan(T0)
    const events = h.ctx.repo.events.listForUser(u.id).map((e) => e.type)
    expect(events).toContain('paused')
    expect(events).toContain('resumed')
  })

  it('демо-режим включается и пишет событие', async () => {
    const h = await harness()
    const u = makeUser(h.ctx.db)
    const on = await (await send(h, `/api/admin/users/${u.id}/demo`, 'POST', { on: true })).json()
    expect(on.user.demo).toBe(1)
    const off = await (await send(h, `/api/admin/users/${u.id}/demo`, 'POST', { on: false })).json()
    expect(off.user.demo).toBe(0)
    expect(h.ctx.repo.events.listForUser(u.id).map((e) => e.type)).toEqual(['demo_off', 'demo_on'])
  })

  it('сообщение уходит через бота и появляется в ленте', async () => {
    const sent: Array<{ text: string }> = []
    const h = await harness({
      send: {
        raw: async (_u: unknown, text: string) => {
          sent.push({ text })
          return 555
        },
      } as never,
    })
    const u = makeUser(h.ctx.db)
    const res = await send(h, `/api/admin/users/${u.id}/message`, 'POST', { text: 'Как ты сегодня?' })
    expect(res.status).toBe(200)
    expect(sent[0]!.text).toBe('Как ты сегодня?')
    const card = await (await get(h, `/api/admin/users/${u.id}`)).json()
    const mine = card.timeline.find((t: { kind: string }) => t.kind === 'admin_message')
    expect(mine.title).toBe('Как ты сегодня?')
  })

  it('пустое и слишком длинное сообщение не отправляются', async () => {
    const h = await harness()
    const u = makeUser(h.ctx.db)
    expect((await send(h, `/api/admin/users/${u.id}/message`, 'POST', { text: '   ' })).status).toBe(400)
    expect((await send(h, `/api/admin/users/${u.id}/message`, 'POST', { text: 'а'.repeat(1001) })).status).toBe(400)
  })

  it('человеку, который заблокировал бота, писать не даём', async () => {
    const h = await harness()
    const u = makeUser(h.ctx.db, { state: 'blocked' })
    const res = await send(h, `/api/admin/users/${u.id}/message`, 'POST', { text: 'привет' })
    expect(res.status).toBe(409)
  })

  it('удаление требует подтверждения номером Telegram', async () => {
    const h = await harness()
    const u = makeUser(h.ctx.db, { tg_id: 4242 })
    expect((await send(h, `/api/admin/users/${u.id}`, 'DELETE')).status).toBe(409)
    expect((await send(h, `/api/admin/users/${u.id}?confirm=1`, 'DELETE')).status).toBe(409)
    expect((await send(h, `/api/admin/users/${u.id}?confirm=4242`, 'DELETE')).status).toBe(200)
    expect(h.ctx.repo.users.byId(u.id)).toBeUndefined()
  })
})

describe('статистика', () => {
  it('считает четыре главные цифры и сравнение с прошлым отрезком', async () => {
    const h = await harness()
    const u1 = makeUser(h.ctx.db)
    const u2 = makeUser(h.ctx.db)
    addEvent(h.ctx.db, u1.id, 'started', T0 - 5 * 86_400)
    addEvent(h.ctx.db, u2.id, 'started', T0 - 5 * 86_400)
    addEvent(h.ctx.db, u1.id, 'finished', T0 - 86_400)
    makeSession(h.ctx.db, { userId: u1.id, eveningNo: 1, before: 3, after: 5, createdAt: T0 - 5 * 86_400 })
    makeSession(h.ctx.db, { userId: u1.id, eveningNo: 7, before: 4, after: 8, createdAt: T0 - 86_400 })

    const body = await (await get(h, '/api/admin/stats?period=30')).json()
    expect(body.stats.funnel.started).toBe(2)
    expect(body.stats.funnel.finished).toBe(1)
    expect(body.stats.funnel.conversion).toBe(0.5)
    expect(body.stats.avgGain).toBe(5) // 8 − 3
    expect(body.gainPeople).toBe(1)
    expect(body.previous.started).toBe(0)
    expect(body.byDay.map((d: { total: number }) => d.total)).toEqual([1, 1])
    expect(body.categories[0]).toEqual({ category: 'sleep', n: 2 })
  })

  it('«всё время» не сравнивает себя ни с чем', async () => {
    const h = await harness()
    const body = await (await get(h, '/api/admin/stats?period=all')).json()
    expect(body.previous).toBeNull()
    expect(body.period.days).toBeNull()
  })
})

describe('тексты', () => {
  it('список сгруппирован по разделам и помечает изменённые', async () => {
    const h = await harness()
    const body = await (await get(h, '/api/admin/texts')).json()
    expect(body.rows.length).toBeGreaterThan(100)
    expect(body.rows.every((r: { changed: boolean }) => r.changed === false)).toBe(true)
    expect(body.sections.find((s: { section: string }) => s.section === 'quiz').count).toBeGreaterThan(0)
  })

  it('правка сохраняется, «вернуть как было» возвращает исходный', async () => {
    const h = await harness()
    const before = h.ctx.repo.texts.row('onb.welcome')!.value
    const put = await send(h, '/api/admin/texts/onb.welcome', 'PUT', { value: 'Привет. Начнём с малого.' })
    expect(put.status).toBe(200)
    expect((await put.json()).row.value).toBe('Привет. Начнём с малого.')
    expect(h.ctx.repo.texts.listForAdmin().find((r) => r.key === 'onb.welcome')!.changed).toBe(true)

    const reset = await send(h, '/api/admin/texts/onb.welcome/reset', 'POST')
    expect((await reset.json()).row.value).toBe(before)
  })

  it('пустой текст и незнакомый плейсхолдер не сохраняются', async () => {
    const h = await harness()
    const empty = await send(h, '/api/admin/texts/onb.welcome', 'PUT', { value: '   ' })
    expect(empty.status).toBe(400)
    expect((await empty.json()).error).toBe('empty')

    const bad = await send(h, '/api/admin/texts/ev.close', 'PUT', { value: 'Записала: {tme}' })
    expect(bad.status).toBe(400)
    const body = await bad.json()
    expect(body.error).toBe('bad_placeholder')
    expect(body.unknown).toEqual(['{tme}'])
    // Ничего не записалось.
    expect(h.ctx.repo.texts.row('ev.close')!.value).not.toContain('{tme}')
  })

  it('две кнопки с одинаковой надписью не принимаются', async () => {
    const h = await harness()
    const pause = h.ctx.repo.texts.row('btn.pause')!.value
    const res = await send(h, '/api/admin/texts/btn.resume', 'PUT', { value: pause })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('label_taken')
  })

  it('восклицательный знак проходит, но с предупреждением', async () => {
    const h = await harness()
    const res = await send(h, '/api/admin/texts/onb.welcome', 'PUT', { value: 'Привет!' })
    expect(res.status).toBe(200)
    expect((await res.json()).warnings.join(' ')).toMatch(/восклицательных/)
  })

  it('предпросмотр подставляет примерные значения в ещё не сохранённый текст', async () => {
    const h = await harness()
    const res = await send(h, '/api/admin/texts/ev.close/preview', 'POST', {
      value: 'Записала: {after} {bar}\nВечер {n} из 7. Черновик.',
    })
    const body = await res.json()
    expect(body.text).toContain('Вечер 3 из 7. Черновик.')
    expect(body.text).toContain('▰▰▰▰▰▰▰▱▱▱')
    // Предпросмотр ничего не сохраняет: в базе по-прежнему прежний текст.
    expect(h.ctx.repo.texts.row('ev.close')!.value).not.toContain('Черновик')
  })

  it('каждый плейсхолдер из значения по умолчанию разрешён своим ключом', async () => {
    const h = await harness()
    for (const row of h.ctx.repo.texts.all()) {
      const allowed = parsePlaceholders(row.placeholders)
      const check = validateText(row.key, row.value, allowed, new Map())
      expect(check.ok, `${row.key}: ${check.ok ? '' : check.message}`).toBe(true)
    }
  })
})

describe('настройки', () => {
  it('снимок отдаёт ссылки, маршрут сна и список практик для него', async () => {
    const h = await harness()
    seedTestPractices(h.ctx.db)
    const body = await (await get(h, '/api/admin/settings')).json()
    expect(body.sleep_route).toHaveLength(7)
    expect(body.notify_types).toContain('started')
    expect(body.sleep_practices.map((p: { slug: string }) => p.slug)).toContain('sleep-landing')
  })

  it('ссылка без https не сохраняется', async () => {
    const h = await harness()
    const res = await send(h, '/api/admin/settings', 'PUT', { talk_url: 'example.com/zapis' })
    expect(res.status).toBe(400)
    expect((await res.json()).errors[0].field).toBe('talk_url')
    expect(h.ctx.settings.str('talk_url', '')).toBe('')
  })

  it('пустая ссылка — это «кнопки не будет», а не ошибка', async () => {
    const h = await harness()
    expect((await send(h, '/api/admin/settings', 'PUT', { talk_url: '' })).status).toBe(200)
  })

  it('маршрут сна проверяется по числу вечеров и по существованию практик', async () => {
    const h = await harness()
    seedTestPractices(h.ctx.db)
    const short = await send(h, '/api/admin/settings', 'PUT', { sleep_route: ['sleep-landing'] })
    expect(short.status).toBe(400)

    const unknown = await send(h, '/api/admin/settings', 'PUT', {
      sleep_route: ['sleep-landing', 'sleep-landing', 'sleep-landing', 'sleep-landing', 'sleep-landing', 'sleep-landing', 'нет-такой'],
    })
    expect(unknown.status).toBe(400)
    expect((await unknown.json()).message).toMatch(/нет в библиотеке/)

    const good = ['sleep-landing', 'sleep-warmth', 'sleep-release', 'sleep-shuffle', 'sleep-warmth', 'sleep-release', 'sleep-landing']
    const ok = await send(h, '/api/admin/settings', 'PUT', { sleep_route: good })
    expect(ok.status).toBe(200)
    expect(h.ctx.settings.json<string[]>('sleep_route', [])).toEqual(good)
  })

  it('телеграм-номера чистятся, мусор отклоняется', async () => {
    const h = await harness()
    const bad = await send(h, '/api/admin/settings', 'PUT', { admin_tg_ids: '123, вася' })
    expect(bad.status).toBe(400)
    const ok = await send(h, '/api/admin/settings', 'PUT', { admin_tg_ids: ' 123, 456 , 123 ' })
    expect(ok.status).toBe(200)
    expect(h.ctx.settings.csvNumbers('admin_tg_ids')).toEqual([123, 456])
  })

  it('числа проверяются по границам', async () => {
    const h = await harness()
    expect((await send(h, '/api/admin/settings', 'PUT', { autopause_after_skips: 0 })).status).toBe(400)
    expect((await send(h, '/api/admin/settings', 'PUT', { autopause_after_skips: 4 })).status).toBe(200)
    expect(h.ctx.settings.int('autopause_after_skips', 3)).toBe(4)
    expect((await send(h, '/api/admin/settings', 'PUT', { morning_hour: '25:00' })).status).toBe(400)
    expect((await send(h, '/api/admin/settings', 'PUT', { morning_hour: '09:30' })).status).toBe(200)
  })
})

describe('практики', () => {
  it('список отдаёт число прослушиваний', async () => {
    const h = await harness()
    seedTestPractices(h.ctx.db)
    const u = makeUser(h.ctx.db)
    h.ctx.repo.plays.add(u.id, 1, null, T0)
    const body = await (await get(h, '/api/admin/practices')).json()
    expect(body.rows).toHaveLength(9)
    expect(body.rows.find((p: { id: number }) => p.id === 1).plays).toBe(1)
  })

  it('создание проверяет короткое имя, название и категорию', async () => {
    const h = await harness()
    expect((await send(h, '/api/admin/practices', 'POST', { slug: 'Ой', title: 'т', category: 'sleep' })).status).toBe(400)
    expect((await send(h, '/api/admin/practices', 'POST', { slug: 'new-one', title: '', category: 'sleep' })).status).toBe(400)
    expect((await send(h, '/api/admin/practices', 'POST', { slug: 'new-one', title: 'Новая', category: 'ночь' })).status).toBe(400)

    const ok = await send(h, '/api/admin/practices', 'POST', {
      slug: 'new-one', title: 'Новая', category: 'sleep', line1: 'Первая', line2: 'Вторая',
    })
    expect(ok.status).toBe(201)
    const created = (await ok.json()).practice
    expect(created.origin).toBe('admin')
    expect(created.active).toBe(1)
    expect((await send(h, '/api/admin/practices', 'POST', { slug: 'new-one', title: 'Ещё', category: 'sleep' })).status).toBe(409)
  })

  it('новая практика встаёт последней в своей категории', async () => {
    const h = await harness()
    seedTestPractices(h.ctx.db)
    const res = await send(h, '/api/admin/practices', 'POST', { slug: 'calm-new', title: 'Новая', category: 'calm' })
    expect((await res.json()).practice.sort_order).toBe(240) // последняя calm — 230
  })

  it('слишком длинная подпись под аудио не принимается', async () => {
    const h = await harness()
    seedTestPractices(h.ctx.db)
    const res = await send(h, '/api/admin/practices/1', 'PATCH', { line1: 'а'.repeat(500), line2: 'б'.repeat(401) })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('lines_too_long')
    const ok = await send(h, '/api/admin/practices/1', 'PATCH', { line1: 'а'.repeat(500), line2: 'б'.repeat(400) })
    expect(ok.status).toBe(200)
  })

  it('правка помечает практику как «правил человек»', async () => {
    const h = await harness()
    seedTestPractices(h.ctx.db)
    await send(h, '/api/admin/practices/1', 'PATCH', { title: 'Другое название' })
    expect(h.ctx.repo.practices.byId(1)!.origin).toBe('admin')
    expect(h.ctx.repo.practices.byId(1)!.title).toBe('Другое название')
  })

  it('удаления нет — есть выключатель', async () => {
    const h = await harness()
    seedTestPractices(h.ctx.db)
    const res = await send(h, '/api/admin/practices/1', 'DELETE')
    expect(res.status).toBe(200)
    expect(h.ctx.repo.practices.byId(1)!.active).toBe(0)
    expect(h.ctx.repo.practices.listAll()).toHaveLength(9)
  })

  it('порядок меняется одним запросом', async () => {
    const h = await harness()
    seedTestPractices(h.ctx.db)
    const res = await send(h, '/api/admin/practices/reorder', 'POST', {
      order: [{ id: 1, sort_order: 130 }, { id: 3, sort_order: 100 }],
    })
    expect(res.status).toBe(200)
    expect(h.ctx.repo.practices.byId(1)!.sort_order).toBe(130)
    expect(h.ctx.repo.practices.byId(3)!.sort_order).toBe(100)
    expect((await send(h, '/api/admin/practices/reorder', 'POST', { order: [{ id: 'ой' }] })).status).toBe(400)
  })

  it('загруженный mp3 ложится на диск, считается хеш и длительность, file_id сбрасывается', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'seven-nights-audio-'))
    const h = await harness({ env: { contentDir: dir } })
    seedTestPractices(h.ctx.db)
    h.ctx.repo.practices.setFileId(1, 'СТАРЫЙ_FILE_ID', 'uniq')

    // Настоящий кадр MPEG-1 Layer III, 128 кбит/с, 44100 Гц — по нему считается длительность.
    const frame = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(32_000, 0)])
    const form = new FormData()
    form.append('file', new File([frame], 'praktika.mp3', { type: 'audio/mpeg' }))
    const res = await h.app.request('/api/admin/practices/1/audio', {
      method: 'POST', headers: { cookie: h.cookie }, body: form,
    })
    expect(res.status).toBe(200)

    const p = h.ctx.repo.practices.byId(1)!
    expect(p.audio_path).toBe('content/audio/sleep-landing.mp3')
    expect(p.audio_bytes).toBe(frame.length)
    expect(p.audio_sha256).toHaveLength(64)
    expect(p.tg_file_id).toBeNull() // сменился файл — старый номер Telegram недействителен
    // Имя из формы игнорируется: файл лежит под слагом практики.
    expect(readFileSync(join(dir, 'audio', 'sleep-landing.mp3')).length).toBe(frame.length)
  })

  it('не-mp3 и пустой файл отклоняются словами, понятными человеку', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'seven-nights-audio-'))
    const h = await harness({ env: { contentDir: dir } })
    seedTestPractices(h.ctx.db)

    const wrong = new FormData()
    wrong.append('file', new File([Buffer.alloc(4096)], 'praktika.wav', { type: 'audio/wav' }))
    const res1 = await h.app.request('/api/admin/practices/1/audio', {
      method: 'POST', headers: { cookie: h.cookie }, body: wrong,
    })
    expect(res1.status).toBe(400)
    expect((await res1.json()).message).toMatch(/расширением \.mp3/)

    const tiny = new FormData()
    tiny.append('file', new File([Buffer.alloc(10)], 'praktika.mp3', { type: 'audio/mpeg' }))
    const res2 = await h.app.request('/api/admin/practices/1/audio', {
      method: 'POST', headers: { cookie: h.cookie }, body: tiny,
    })
    expect(res2.status).toBe(400)
  })
})

describe('журнал и выгрузки', () => {
  it('уведомления фильтруются и пересылаются новой записью', async () => {
    const h = await harness()
    const u = makeUser(h.ctx.db)
    h.ctx.repo.notifications.enqueue({ userId: u.id, type: 'started', dedupKey: 'started:1', text: '🟢 Новый участник #1', now: T0 })
    h.ctx.repo.notifications.enqueue({ userId: u.id, type: 'silent', dedupKey: 'silent:1', text: '🔕 Молчит', now: T0 + 10 })

    expect((await (await get(h, '/api/admin/notifications')).json()).rows).toHaveLength(2)
    const started = await (await get(h, '/api/admin/notifications?filter=started')).json()
    expect(started.rows).toHaveLength(1)
    expect(started.pending).toBe(2)

    const retry = await send(h, '/api/admin/notifications/1/retry', 'POST')
    expect((await retry.json()).ok).toBe(true)
    expect(h.ctx.repo.notifications.countPending()).toBe(3)
  })

  it('выгрузка людей — с BOM, точкой с запятой и русскими заголовками', async () => {
    const h = await harness()
    makeUser(h.ctx.db, { tg_id: 777, state: 'completed', current_evening: 7 })
    const res = await get(h, '/api/admin/export/users.csv')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/csv/)
    // BOM проверяем в байтах: TextDecoder при res.text() его съедает, а Excel — нет.
    const bytes = new Uint8Array(await res.clone().arrayBuffer())
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf])
    const text = await res.text()
    expect(text.split('\r\n')[0]).toContain('номер;telegram id;создан;состояние')
    expect(text).toContain('прошёл семь вечеров')
    expect(text).toContain('777')
  })

  it('история одного человека выгружается по времени', async () => {
    const h = await harness()
    seedTestPractices(h.ctx.db)
    const u = makeUser(h.ctx.db)
    makeSession(h.ctx.db, { userId: u.id, eveningNo: 1, before: 4, after: 7, practiceId: 1 })
    h.ctx.repo.messages.add(u.id, 'спасибо', 'idle', null, T0 + 3600)
    const text = await (await get(h, `/api/admin/export/user/${u.id}/history.csv`)).text()
    expect(text).toContain('замер до (вечер 1)')
    expect(text).toContain('Приземление')
    expect(text).toContain('спасибо')
  })

  it('точка с запятой внутри значения не ломает колонки', () => {
    const line = csv([['а;б', 'в"г', 'д']]).replace('﻿', '').trim()
    expect(line).toBe('"а;б";"в""г";д')
  })
})

describe('чистые функции', () => {
  it('плейсхолдеры находятся все и по одному разу', () => {
    expect(usedPlaceholders('Вечер {n} из 7, {n} {bar}')).toEqual(['{n}', '{bar}'])
    expect(usedPlaceholders('без подстановок')).toEqual([])
  })

  it('предпросмотр оставляет незнакомое как есть — чтобы ошибку было видно', () => {
    expect(renderPreview('{n} и {tme}')).toBe('3 и {tme}')
  })

  it('длительность mp3 оценивается по кадру, если ffprobe недоступен', () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(16_000 - 4, 0)])
    expect(estimateMp3Seconds(buf)).toBe(1) // 16 КБ при 128 кбит/с ≈ 1 с
    expect(estimateMp3Seconds(Buffer.alloc(4096))).toBeNull()
  })

  it('проверка файла говорит человеческим языком', () => {
    expect(checkAudio('a.wav', 5000)).toMatchObject({ ok: false, error: 'not_mp3' })
    expect(checkAudio('a.mp3', 50 * 1024 * 1024)).toMatchObject({ ok: false, error: 'too_big' })
    expect(checkAudio('a.mp3', 5000)).toEqual({ ok: true })
  })
})
