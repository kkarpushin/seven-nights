/**
 * Уведомления владельцу. §4.6 архитектуры, раздел «Уведомления владельцу» Приложения А.
 *
 * Уведомление никогда не отправляется прямо из перехода. Оно кладётся в очередь
 * (таблица notifications) одним синхронным INSERT внутри той же транзакции, что и
 * сам переход, а доставкой занимается sweep раз в пять минут. Причины две.
 *
 * Первая: у владельца может быть что угодно — заблокированный бот, сетевая ошибка,
 * 429. Ни одна из этих бед не имеет права задержать или уронить шаг человека,
 * который сейчас лежит в темноте и ждёт практику.
 *
 * Вторая: UNIQUE на dedup_key делает повтор физически невозможным. «Новый участник
 * #17» не придёт дважды ни при ретрае, ни при перезапуске процесса посреди
 * онбординга — INSERT OR IGNORE просто ничего не сделает.
 *
 * Тексты берутся из таблицы texts по ключам admin.* — владелец правит их в админке,
 * как и всё остальное.
 */

import type { Ctx } from '../ctx.ts'
import type { UserRow } from '../db/types.ts'
import { fmtTz } from '../time.ts'

/** Типы из §2.2 DDL. Колонка type свободная, но список закрыт здесь. */
export type NotifyType = 'started' | 'finished' | 'silent' | 'blocked' | 'message' | 'no_practices'

/** Сколько раз пробуем доставить одно уведомление, прежде чем сдаться (§4.6). */
export const MAX_DELIVERY_ATTEMPTS = 5

/** Сколько уведомлений отправляем за один проход. Больше — и sweep станет длинным. */
const FLUSH_LIMIT = 20

/**
 * Кому слать: ADMIN_TG_IDS из .env плюс settings.admin_tg_ids из админки.
 * Именно объединение, а не «одно вместо другого» (§2.4): .env — то, что нельзя
 * потерять правкой в интерфейсе, настройка — то, что можно добавить без деплоя.
 */
export function adminTgIds(ctx: Ctx): number[] {
  const out = [...ctx.cfg.adminTgIds]
  for (const id of ctx.settings.csvNumbers('admin_tg_ids')) {
    if (!out.includes(id)) out.push(id)
  }
  return out
}

/** Число для владельца: 2.5 → «2,5», null → «—». */
function num(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  return String(v).replace('.', ',')
}

/**
 * Общая часть всех уведомлений: отрендерить текст и положить в очередь.
 * false — такое уведомление уже есть (сработал dedup_key).
 */
export function enqueue(
  ctx: Ctx,
  n: { user: UserRow | null; type: NotifyType; key: string; dedupKey: string; vars: Record<string, string | number>; now: number },
): boolean {
  const text = ctx.texts.render(n.key, n.vars)
  return ctx.repo.notifications.enqueue({
    userId: n.user?.id ?? null,
    type: n.type,
    dedupKey: n.dedupKey,
    text,
    now: n.now,
  })
}

/** 🟢 Новый участник: онбординг закончен, программа началась (строка 4 §3.2). */
export function notifyStarted(ctx: Ctx, u: UserRow, now: number): boolean {
  return enqueue(ctx, {
    user: u,
    type: 'started',
    key: 'admin.started',
    // Круг в ключе: «Ещё семь вечеров» — это не новый участник, но если когда-нибудь
    // решим слать и на перезапуск, дедуп не помешает.
    dedupKey: `started:${u.id}:${u.run_no}`,
    vars: { id: u.id, time: u.evening_time, tz: fmtTz(u.tz_offset_min) },
    now,
  })
}

/**
 * 🏁 Дошёл до седьмого вечера. «Было/стало» считаем по кругу: первый непустой замер
 * «до» и последний непустой «после» — те же числа, что человек видит на своей картинке.
 */
export function notifyFinished(ctx: Ctx, u: UserRow, now: number): boolean {
  const sessions = ctx.repo.sessions.runSessions(u.id, u.run_no)
  const firstBefore = sessions.find((s) => s.before_value !== null)?.before_value ?? null
  let lastAfter: number | null = null
  for (const s of sessions) if (s.after_value !== null) lastAfter = s.after_value

  return enqueue(ctx, {
    user: u,
    type: 'finished',
    key: 'admin.finished',
    dedupKey: `finished:${u.id}:${u.run_no}`,
    vars: {
      id: u.id,
      first_before: num(firstBefore),
      last_after: num(lastAfter),
      avg: num(ctx.repo.stats.avgGainForUser(u.id, u.run_no)),
    },
    now,
  })
}

/**
 * 🔕 Молчит третьи сутки. Ключ дедупа включает last_seen_at, поэтому уведомление
 * приходит один раз на одну серию молчания: вернулся, снова пропал — придёт снова,
 * а вот каждые пять минут одно и то же — нет.
 */
export function notifySilent(ctx: Ctx, u: UserRow, now: number): boolean {
  return enqueue(ctx, {
    user: u,
    type: 'silent',
    key: 'admin.silent',
    dedupKey: `silent:${u.id}:${u.last_seen_at ?? 0}`,
    vars: { id: u.id, n: u.current_evening },
    now,
  })
}

/** ⛔ Заблокировал бота (строка 41 §3.2). */
export function notifyBlocked(ctx: Ctx, u: UserRow, now: number): boolean {
  return enqueue(ctx, {
    user: u,
    type: 'blocked',
    key: 'admin.blocked',
    dedupKey: `blocked:${u.id}:${u.blocked_at ?? now}`,
    vars: { id: u.id, n: u.current_evening },
    now,
  })
}

/**
 * ✉️ Человек написал словами. messageId — id строки в messages: он и есть ключ
 * дедупа, потому что два разных сообщения с одинаковым текстом — это два события,
 * а одно и то же сообщение, доехавшее дважды, — нет.
 */
export function notifyMessage(ctx: Ctx, u: UserRow, text: string, messageId: number, now: number): boolean {
  return enqueue(ctx, {
    user: u,
    type: 'message',
    key: 'admin.message',
    dedupKey: `message:${messageId}`,
    vars: { id: u.id, n: u.current_evening, text },
    now,
  })
}

/** ⚠️ Библиотека практик пуста — человек остался без практики (строка 18 §3.2). */
export function notifyNoPractices(ctx: Ctx, u: UserRow, now: number): boolean {
  // Час в ключе: библиотека пуста для всех сразу, и без огрубления владелец получил бы
  // столько сообщений, сколько людей нажало категорию.
  return enqueue(ctx, {
    user: u,
    type: 'no_practices',
    key: 'admin.no_practices',
    dedupKey: `no_practices:${u.id}:${Math.floor(now / 3600)}`,
    vars: { id: u.id },
    now,
  })
}

/**
 * Служебное сообщение владельцу готовой строкой, без ключа текста: им отчитываются
 * о том, чего в продуктовых текстах нет и быть не должно — «таймер отключён после
 * пяти неудач», «финал прошёл без картинки». Тип message, чтобы не плодить типы.
 */
export function notifyRaw(
  ctx: Ctx,
  n: { user: UserRow | null; dedupKey: string; text: string; now: number },
): boolean {
  return ctx.repo.notifications.enqueue({
    userId: n.user?.id ?? null,
    type: 'message',
    dedupKey: n.dedupKey,
    text: n.text,
    now: n.now,
  })
}

export type FlushResult = { sent: number; failed: number; skipped: number }

export type FlushOptions = {
  limit?: number
  /** Подменяется в тестах; по умолчанию — единственная дверь в Telegram. */
  deliver?: (text: string) => Promise<void>
}

/**
 * Разослать всё, что накопилось. Вызывается из sweeps раз в пять минут.
 *
 * Если получателей нет вовсе (ни в .env, ни в настройках) — очередь не трогаем:
 * попытки «в никуда» сожгли бы счётчик attempts, и уведомления, накопленные до
 * того, как владелец вписал свой id, никогда бы не доехали.
 */
export async function flushNotifications(ctx: Ctx, now: number, opts: FlushOptions = {}): Promise<FlushResult> {
  const out: FlushResult = { sent: 0, failed: 0, skipped: 0 }
  const pending = ctx.repo.notifications.pending(opts.limit ?? FLUSH_LIMIT, MAX_DELIVERY_ATTEMPTS)
  if (pending.length === 0) return out

  if (adminTgIds(ctx).length === 0) {
    out.skipped = pending.length
    ctx.log.debug('notifications: получателей нет, очередь ждёт', { pending: pending.length })
    return out
  }

  const deliver = opts.deliver ?? ((text: string) => ctx.send.toAdmins(text))

  for (const row of pending) {
    try {
      await deliver(row.text)
      ctx.repo.notifications.markSent(row.id, ctx.clock.now())
      out.sent += 1
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      ctx.repo.notifications.markFailed(row.id, message)
      out.failed += 1
      const attempts = (ctx.repo.notifications.byId(row.id)?.attempts ?? 0)
      // После пятой попытки уведомление выпадает из выборки pending() навсегда.
      // Отдельная запись в лог — единственный след, по которому это можно заметить.
      const fields = { notification_id: row.id, type: row.type, attempts, err: message }
      if (attempts >= MAX_DELIVERY_ATTEMPTS) ctx.log.error('уведомление владельцу не доставлено', fields)
      else ctx.log.warn('уведомление владельцу не ушло, попробуем позже', fields)
    }
  }
  return out
}
