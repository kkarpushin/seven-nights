/**
 * Роутер /api/admin. §6 архитектуры.
 *
 * Порядок здесь важнее содержимого: сначала вход (без охраны), потом охрана на
 * всё остальное, и только потом сами маршруты. Если написать наоборот, один
 * забытый маршрут окажется открытым, и заметят это не сразу.
 */

import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Ctx } from '../ctx.ts'
import { dbSizeBytes } from '../db/index.ts'
import { PROJECT_ROOT } from '../env.ts'
import {
  clientIp, createAttempts, dropSession, issueSession, passwordMatches, requireAuth,
} from './auth.ts'
import { MAX_AUDIO_BYTES } from './audio.ts'
import { fail, jsonBody, noStore } from './util.ts'
import { eventsRoutes } from './routes/events.ts'
import { exportRoutes } from './routes/export.ts'
import { practicesRoutes } from './routes/practices.ts'
import { settingsRoutes } from './routes/settings.ts'
import { statsRoutes } from './routes/stats.ts'
import { textsRoutes } from './routes/texts.ts'
import { usersRoutes } from './routes/users.ts'

/** Версия из package.json — чтобы на экране «о программе» было видно, что запущено. */
export function appVersion(): string {
  try {
    const raw = readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')
    return String((JSON.parse(raw) as { version?: string }).version ?? '0.0.0')
  } catch {
    return '0.0.0'
  }
}

export function createAdminApi(ctx: Ctx): Hono {
  const app = new Hono()
  const attempts = createAttempts()
  const startedAt = ctx.clock.now()

  // ─────────────────────────────── вход ───────────────────────────────
  app.post('/login', async (c) => {
    noStore(c)
    const now = ctx.clock.now()
    const ip = clientIp(c)
    const lock = attempts.locked(ip, now)
    if (lock.locked) {
      return fail(c, 429, 'too_many', 'Слишком много попыток. Попробуй через минуту.', {
        secondsLeft: lock.secondsLeft,
      })
    }
    const body = await jsonBody(c)
    const password = typeof body?.password === 'string' ? body.password : ''
    if (password === '' || !passwordMatches(password, ctx.cfg.adminPassword)) {
      attempts.fail(ip, now)
      ctx.log.warn('admin login failed', { ip })
      return fail(c, 401, 'bad_password', 'Пароль не подошёл. Проверь раскладку и Caps Lock.')
    }
    attempts.reset(ip)
    issueSession(c, ctx, body?.remember !== false)
    ctx.repo.adminSessions.purgeExpired(now)
    ctx.log.info('admin login ok', { ip })
    return c.json({ ok: true })
  })

  app.post('/logout', (c) => {
    noStore(c)
    dropSession(c, ctx)
    return c.json({ ok: true })
  })

  // ─────────────────────── охрана на всё остальное ───────────────────────
  app.use('/*', requireAuth(ctx))

  app.get('/me', (c) => {
    noStore(c)
    return c.json({
      ok: true,
      botUsername: ctx.cfg.botUsername,
      version: appVersion(),
      dbSizeBytes: dbSizeBytes(ctx.db),
      uptimeSec: ctx.clock.now() - startedAt,
      demoDefault: ctx.settings.bool('demo_default', ctx.cfg.demoDefault),
      practicesActive: ctx.repo.practices.countActive(),
      adminsSet: ctx.settings.csvNumbers('admin_tg_ids').length > 0 || ctx.cfg.adminTgIds.length > 0,
    })
  })

  app.route('/stats', statsRoutes(ctx))
  app.route('/users', usersRoutes(ctx))
  // Лимит тела стоит только на загрузке аудио: остальные маршруты принимают JSON,
  // и общий лимит в 45 МБ на них был бы приглашением прислать 45 МБ JSON.
  app.use('/practices/:id/audio', bodyLimit({
    maxSize: MAX_AUDIO_BYTES,
    onError: (c) => fail(c, 413, 'too_big', 'Файл больше 45 МБ — Telegram его не примет.'),
  }))
  app.route('/practices', practicesRoutes(ctx))
  app.route('/texts', textsRoutes(ctx))
  app.route('/settings', settingsRoutes(ctx))
  app.route('/export', exportRoutes(ctx))
  app.route('/', eventsRoutes(ctx))

  app.all('/*', (c) => fail(c, 404, 'not_found', 'Такого раздела нет.'))

  return app
}
