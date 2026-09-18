/**
 * Планировщик. §4.1, §4.4, §4.5 архитектуры.
 *
 * Весь ход времени в продукте — это один setInterval на тридцать секунд и одна
 * выборка `users WHERE due_at <= now`. Никаких таймеров в памяти: у человека ровно
 * один срок и ровно один его вид, и живут они в SQLite. Отсюда главное свойство —
 * перезапуск процесса не теряет ни одного вечера и не дублирует ни одного
 * сообщения. Процесс может лежать час; вернувшись, он увидит те же две колонки.
 *
 * Защита от двойной отправки — четыре рубежа §4.4; первый из них здесь:
 * планировщик не «читает и делает», а сначала ЗАБИРАЕТ задачу условным UPDATE по
 * значению due_at. Если значение уже сменилось (человек ответил сам, второй тик
 * успел раньше), changes = 0 и работа просто не выполняется.
 */

import type { Ctx } from '../ctx.ts'
import type { DueKind, UserRow } from '../db/types.ts'
import { notifyRaw } from '../bot/notify.ts'
import { applyRecompute } from './plan.ts'
import { handleDue, settleDue, type DueOutcome, type SchedulerFlow } from './due.ts'
import { runSweeps, type SweepOptions, type SweepResult } from './sweeps.ts'

/** На сколько сдвигается срок при захвате: упавший обработчик повторится через это время. */
export const PARK_SEC = 120

/** После стольких неудач подряд таймер гасится, а владельцу уходит уведомление (§4.4). */
export const MAX_DUE_ATTEMPTS = 5

/** Сколько людей берём за один тик. Telegram всё равно принимает ~30 сообщений в секунду. */
export const TICK_BATCH = 200

/** Ритм фоновых проходов (§4.6). */
export const SWEEP_EVERY_MS = 5 * 60_000

export type TickResult = {
  /** Сколько строк вернула выборка. */
  seen: number
  /** Сколько задач удалось захватить. */
  claimed: number
  /** Не захвачено: значение due_at сменилось между чтением и захватом. */
  raced: number
  /** Обработчик бросил исключение — повтор через PARK_SEC. */
  failed: number
  /** Таймеров погашено после MAX_DUE_ATTEMPTS неудач. */
  disabled: number
  outcomes: Record<DueOutcome, number>
}

function emptyResult(): TickResult {
  return {
    seen: 0,
    claimed: 0,
    raced: 0,
    failed: 0,
    disabled: 0,
    outcomes: { handled: 0, silent: 0, healed: 0, postponed: 0, stopped: 0 },
  }
}

// ───────────────────────────── пер-пользовательский лок ─────────────────────────────

/**
 * Очередь на человека: две задачи одного пользователя не выполняются внахлёст.
 * Глобального лока нет намеренно — один медленный ответ Telegram не должен
 * задерживать чужие вечера.
 */
const userLocks = new Map<number, Promise<unknown>>()

export function withUserLock<T>(userId: number, fn: () => Promise<T>): Promise<T> {
  const prev = userLocks.get(userId) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  // В цепочку кладём «проглоченную» версию: иначе одна ошибка отравила бы очередь
  // этого человека навсегда, и он перестал бы получать вечера.
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  userLocks.set(userId, tail)
  void tail.then(() => {
    if (userLocks.get(userId) === tail) userLocks.delete(userId)
  })
  return run
}

// ───────────────────────────── тик ─────────────────────────────

/**
 * Один проход по просроченным срокам. Отделён от таймера, чтобы тесты могли
 * двигать фейковые часы и звать его руками, а восстановление после перезапуска —
 * выполнить ровно тот же код, что и обычная работа (§4.5.2).
 */
export async function tick(
  ctx: Ctx,
  now: number,
  flow: SchedulerFlow,
  /** 'flow' — отдать разбор due_kind ядру (flow.handle), см. SchedulerDeps.dispatch. */
  dispatch: DispatchMode = 'scheduler',
): Promise<TickResult> {
  const res = emptyResult()
  const rows = ctx.repo.users.due(now, TICK_BATCH)
  res.seen = rows.length

  for (const u of rows) {
    const seenDueAt = u.due_at
    if (seenDueAt === null) continue

    // Срок есть, а вида нет — чинить наугад нечего, пересчитываем по состоянию.
    if (u.due_kind === null) {
      applyRecompute(ctx, u, now)
      res.outcomes.healed += 1
      continue
    }

    if (u.due_attempts >= MAX_DUE_ATTEMPTS) {
      disableDue(ctx, u, now)
      res.disabled += 1
      continue
    }

    const parkUntil = now + PARK_SEC
    if (!ctx.repo.users.claimDue(u.id, seenDueAt, parkUntil)) {
      res.raced += 1
      continue
    }
    res.claimed += 1

    const kind: DueKind = u.due_kind
    const lock = flow.withUserLock ?? withUserLock
    await lock(u.id, async () => {
      try {
        const outcome = await dispatchDue(ctx, u, kind, now, flow, { seenDueAt, parkUntil }, dispatch)
        res.outcomes[outcome] += 1
      } catch (err) {
        // Срок остался парковочным, вид сохранён захватом — через две минуты
        // попробуем снова. Ошибка одного человека не прерывает тик остальных.
        res.failed += 1
        ctx.log.error('обработчик срока упал', {
          user_id: u.id,
          state: u.state,
          due_kind: kind,
          attempts: u.due_attempts + 1,
          err,
        })
      }
    })
  }

  return res
}

export type DispatchMode = 'scheduler' | 'flow'

/**
 * Куда уходит разбор due_kind.
 *
 * По умолчанию — в scheduler/due.ts (§4.2 закрепляет диспетчер за планировщиком).
 * Режим 'flow' существует потому, что ядро умеет разбирать триггер `due` и само
 * (§5.6, Trigger.t = 'due'): если в проекте решат оставить одну реализацию — ту,
 * что живёт рядом с текстами и клавиатурами, — переключение стоит одного флага.
 * Страховка по сроку (settleDue) работает в обоих режимах: захват припарковал
 * due_at, и кто-то обязан поставить настоящий.
 */
async function dispatchDue(
  ctx: Ctx,
  u: UserRow,
  kind: DueKind,
  now: number,
  flow: SchedulerFlow,
  d: { seenDueAt: number; parkUntil: number },
  mode: DispatchMode,
): Promise<DueOutcome> {
  if (mode === 'flow' && flow.handle) {
    await flow.handle(ctx, u, { t: 'due', kind }, now)
    settleDue(ctx, u, now, d)
    return 'handled'
  }
  return await handleDue(ctx, u, kind, now, flow, d)
}

/**
 * Пятая неудача подряд. Дальше повторять бессмысленно: скорее всего сломан не
 * Telegram, а наши данные. Гасим таймер и говорим владельцу — молча оставленный
 * человек без вечеров хуже, чем одно техническое сообщение.
 *
 * Текст собирается здесь, а не в таблице texts: он служебный, владельцу, и его
 * незачем давать в админку на правку.
 */
function disableDue(ctx: Ctx, u: UserRow, now: number): void {
  ctx.repo.users.clearDue(u.id)
  ctx.log.error('таймер отключён после пяти неудач', {
    user_id: u.id,
    state: u.state,
    due_kind: u.due_kind,
    due_at: u.due_at,
    attempts: u.due_attempts,
  })
  notifyRaw(ctx, {
    user: u,
    dedupKey: `due_failed:${u.id}:${u.due_kind}:${u.due_at}`,
    text:
      `⚠️ Участник #${u.id}: таймер «${u.due_kind}» отключён после ${u.due_attempts} неудачных попыток. ` +
      `Состояние: ${u.state}. Нужен ручной разбор в админке.`,
    now,
  })
}

// ───────────────────────────── восстановление после перезапуска ─────────────────────────────

export type RecoveryResult = { closedSessions: number; fixedUsers: number }

/**
 * Проход §4.5.3: сверка активных сессий с users.active_session_id.
 *
 * Расхождение чинится в пользу самой свежей сессии, остальные закрываются как
 * abandoned. Две активные сессии у одного человека означали бы два «Готово» под
 * разными аудио и непредсказуемый выбор в шаговых апдейтах.
 */
export function recoverOnStart(ctx: Ctx): RecoveryResult {
  const out: RecoveryResult = { closedSessions: 0, fixedUsers: 0 }
  const now = ctx.clock.now()
  const byUser = new Map<number, number[]>()
  for (const s of ctx.repo.sessions.allActive()) {
    const list = byUser.get(s.user_id) ?? []
    list.push(s.id)
    byUser.set(s.user_id, list)
  }

  for (const [userId, ids] of byUser) {
    const keep = Math.max(...ids)
    for (const id of ids) {
      if (id === keep) continue
      ctx.repo.sessions.close(id, 'abandoned', now)
      out.closedSessions += 1
    }
    const u = ctx.repo.users.byId(userId)
    if (u && u.active_session_id !== keep) {
      ctx.repo.users.update(userId, { active_session_id: keep })
      out.fixedUsers += 1
    }
  }

  // Указатель на сессию, которая давно закрыта, — не ошибка данных, но мешает
  // читать карточку в админке и сбивает active() при отладке.
  for (const u of ctx.repo.users.withActiveSession()) {
    if (byUser.has(u.id)) continue
    ctx.repo.users.update(u.id, { active_session_id: null })
    out.fixedUsers += 1
  }

  if (out.closedSessions > 0 || out.fixedUsers > 0) ctx.log.warn('восстановление сессий', out)
  return out
}

// ───────────────────────────── запуск ─────────────────────────────

export type SchedulerDeps = {
  /** Ядро переходов: `import * as flow from './bot/flow.ts'` (§5.6). */
  flow: SchedulerFlow
  sweeps?: SweepOptions
  /** Кто разбирает due_kind: планировщик (по умолчанию) или ядро через flow.handle. */
  dispatch?: DispatchMode
  /** Переопределение ритма тика; по умолчанию cfg.schedulerTickMs. */
  tickMs?: number
  sweepMs?: number
}

export type SchedulerHandle = {
  stop(): void
  /** Прогнать тик немедленно — для recovery-прохода при старте и для отладки. */
  tickNow(): Promise<TickResult>
  sweepNow(): Promise<SweepResult>
}

export function startScheduler(ctx: Ctx, deps: SchedulerDeps): SchedulerHandle {
  const tickMs = deps.tickMs ?? ctx.cfg.schedulerTickMs
  const sweepMs = deps.sweepMs ?? SWEEP_EVERY_MS

  // Тики не наслаиваются: при медленном Telegram второй тик увидел бы те же строки
  // и, не будь захвата, отправил бы всё дважды. Захват и так это ловит, но лишняя
  // работа в сети нам ни к чему.
  let tickRunning = false
  let sweepRunning = false

  const runTick = async (): Promise<TickResult> => {
    if (tickRunning) return emptyResult()
    tickRunning = true
    try {
      return await tick(ctx, ctx.clock.now(), deps.flow, deps.dispatch ?? 'scheduler')
    } catch (err) {
      ctx.log.error('тик планировщика упал целиком', { err })
      return emptyResult()
    } finally {
      tickRunning = false
    }
  }

  const runSweep = async (): Promise<SweepResult> => {
    if (sweepRunning) {
      return { silent: 0, notifications: { sent: 0, failed: 0, skipped: 0 }, adminSessions: 0, backup: false }
    }
    sweepRunning = true
    try {
      return await runSweeps(ctx, ctx.clock.now(), deps.sweeps ?? {})
    } finally {
      sweepRunning = false
    }
  }

  const tickTimer = setInterval(() => void runTick(), tickMs)
  const sweepTimer = setInterval(() => void runSweep(), sweepMs)
  ctx.log.info('планировщик запущен', { tick_ms: tickMs, sweep_ms: sweepMs })

  return {
    stop() {
      clearInterval(tickTimer)
      clearInterval(sweepTimer)
      ctx.log.info('планировщик остановлен')
    },
    tickNow: runTick,
    sweepNow: runSweep,
  }
}

/**
 * Достать ядро переходов, не импортируя его статически.
 *
 * Обычный путь — передать `flow` в startScheduler явно (`import * as flow from
 * './bot/flow.ts'`). Этот помощник существует для точки входа, которая собирается
 * раньше, чем ядро: специфер лежит в переменной, поэтому модуль ищется в момент
 * вызова, а не при разборе файла.
 */
export async function loadFlow(specifier = '../bot/flow.ts'): Promise<SchedulerFlow> {
  const mod = (await import(specifier)) as Partial<SchedulerFlow>
  const missing = (['startEvening', 'askAfter', 'skipEvening', 'finale', 'pause'] as const).filter(
    (k) => typeof mod[k] !== 'function',
  )
  if (missing.length > 0) {
    throw new Error(`Модуль «${specifier}» не даёт функций §5.6: ${missing.join(', ')}`)
  }
  return mod as SchedulerFlow
}

export { handleDue, settleDue, type SchedulerFlow, type DueOutcome } from './due.ts'
export { runSweeps, sweepSilence, maybeBackup } from './sweeps.ts'
export * as plan from './plan.ts'
