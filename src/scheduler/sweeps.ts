/**
 * Фоновые проходы раз в пять минут. §4.6 архитектуры.
 *
 * Здесь всё, что не привязано к конкретному due_at: молчание, доставка очереди
 * уведомлений, уборка протухших сессий админки, суточный бэкап. Отдельный ритм —
 * потому что тик раз в тридцать секунд должен оставаться дешёвым: он касается
 * людей, у которых прямо сейчас наступил срок, и ничего больше.
 *
 * Ни один проход не имеет права уронить остальные, поэтому каждый обёрнут в
 * try/catch: сломанный бэкап не должен останавливать уведомления владельцу.
 */

import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Ctx } from '../ctx.ts'
import type { UserRow } from '../db/types.ts'
import { vacuumInto } from '../db/index.ts'
import { flushNotifications, notifySilent, type FlushResult } from '../bot/notify.ts'

/** Сколько снимков базы держим. Столько же, сколько у ручного scripts/backup-db.ts. */
const BACKUP_KEEP = 14
const DAY_SEC = 86_400

/** Ключ служебной настройки: когда последний раз делали снимок базы. */
export const LAST_BACKUP_KEY = 'last_backup_at'

/** Состояния, в которых молчание человека — это действительно потеря, а не норма. */
const LIVE_STATES = "('idle','awaiting_before','awaiting_state','practicing','awaiting_after')"

export type SweepResult = {
  silent: number
  notifications: FlushResult
  adminSessions: number
  backup: boolean
}

export type SweepOptions = {
  /** Подменяется в тестах; по умолчанию — ctx.send.toAdmins. */
  deliver?: (text: string) => Promise<void>
  /** false — не делать снимок базы (тесты, база в памяти). */
  backup?: boolean
}

export async function runSweeps(ctx: Ctx, now: number, opts: SweepOptions = {}): Promise<SweepResult> {
  const out: SweepResult = {
    silent: 0,
    notifications: { sent: 0, failed: 0, skipped: 0 },
    adminSessions: 0,
    backup: false,
  }

  try {
    out.silent = sweepSilence(ctx, now)
  } catch (err) {
    ctx.log.error('проход по молчащим не удался', { err })
  }

  try {
    out.notifications = await flushNotifications(ctx, now, { deliver: opts.deliver })
  } catch (err) {
    ctx.log.error('доставка уведомлений владельцу не удалась', { err })
  }

  try {
    out.adminSessions = ctx.repo.adminSessions.purgeExpired(now)
  } catch (err) {
    ctx.log.error('чистка сессий админки не удалась', { err })
  }

  if (opts.backup !== false) {
    try {
      out.backup = maybeBackup(ctx, now)
    } catch (err) {
      ctx.log.error('снимок базы не сделан', { err })
    }
  }

  return out
}

/**
 * Молчание дольше settings.silence_hours. §4.6.
 *
 * Уведомление уходит один раз на одну серию: ключ дедупа и колонка
 * silent_notified_for хранят то самое last_seen_at, за которое уже сообщили.
 * Человек вернулся (touchSeen обнуляет silent_notified_for) и снова пропал —
 * придёт новое, и это правильно: это новая история, а не та же самая.
 *
 * Демо-пользователей не трогаем вовсе: в ускоренном прогоне «не открывал три дня»
 * не значит ничего.
 */
export function sweepSilence(ctx: Ctx, now: number): number {
  const hours = ctx.settings.int('silence_hours', 72)
  if (hours <= 0) return 0
  const threshold = now - hours * 3600

  // Запрос читающий и ровно такой, как в §4.6; отдельного метода репозитория под
  // него нет — заводить его ради одного места значило бы размазать правило по двум
  // файлам. Все ЗАПИСИ ниже идут через репозиторий, как требует §2.5.3.
  const rows = ctx.db
    .prepare(`
      SELECT * FROM users
       WHERE state IN ${LIVE_STATES}
         AND demo = 0
         AND last_seen_at IS NOT NULL
         AND last_seen_at < ?
         AND (silent_notified_for IS NULL OR silent_notified_for <> last_seen_at)
       ORDER BY last_seen_at
       LIMIT 200
    `)
    .all(threshold) as UserRow[]

  let n = 0
  for (const u of rows) {
    try {
      const queued = notifySilent(ctx, u, now)
      ctx.repo.users.update(u.id, { silent_notified_for: u.last_seen_at })
      if (queued) n += 1
    } catch (err) {
      ctx.log.error('не смогли поставить уведомление о молчании', { user_id: u.id, err })
    }
  }
  return n
}

/**
 * Снимок базы раз в сутки. VACUUM INTO, а не копирование файла: при WAL рядом
 * лежат -wal и -shm, и простая копия молча теряет последние транзакции.
 *
 * Момент последнего снимка живёт в settings, а не в памяти процесса: рестарт раз
 * в час не должен приводить ни к бэкапу каждый час, ни к пропущенному дню.
 */
export function maybeBackup(ctx: Ctx, now: number): boolean {
  if (ctx.cfg.dbPath === ':memory:') return false
  const last = ctx.settings.int(LAST_BACKUP_KEY, 0)
  if (now - last < DAY_SEC) return false

  const dir = join(ctx.cfg.dataDir, 'backups')
  mkdirSync(dir, { recursive: true })
  const target = join(dir, `${now}.db`)
  vacuumInto(ctx.db, target)
  ctx.settings.set(LAST_BACKUP_KEY, now)

  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.db'))
    .map((f) => ({ f, at: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.at - a.at)
  for (const old of files.slice(BACKUP_KEEP)) rmSync(join(dir, old.f), { force: true })

  ctx.log.info('снимок базы сделан', { target, kept: Math.min(files.length, BACKUP_KEEP) })
  return true
}
