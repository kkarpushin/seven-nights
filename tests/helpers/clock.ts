/**
 * Управление временем в тестах планировщика. §9.1 архитектуры.
 *
 * Весь продукт держится на том, что «сейчас» приходит из Clock, а не из Date.now().
 * Здесь это свойство обналичивается: семь вечеров, три дня молчания и утро
 * следующего дня проживаются за миллисекунды, причём тем же кодом, что и в бою —
 * тик планировщика ничего не знает про фейковые часы.
 *
 * Шаг по умолчанию — те же тридцать секунд, что у настоящего тика: тест, который
 * двигает время сутками за один прыжок, не заметил бы, что обработчик срабатывает
 * дважды или не срабатывает вовсе.
 */

import { fakeClock, type FakeClock } from '../../src/clock.ts'
import type { Ctx } from '../../src/ctx.ts'
import { tick, type TickResult } from '../../src/scheduler/index.ts'
import type { SchedulerFlow } from '../../src/scheduler/due.ts'
import { T0 } from './db.ts'

export { T0 }

export const TICK_SEC = 30

export function clockAt(unix: number = T0): FakeClock {
  return fakeClock(unix)
}

/** Ctx с фейковыми часами — тесты подменяют clock после сборки. */
export type ClockCtx = Ctx & { clock: FakeClock }

export type RunOptions = {
  /** Шаг виртуальных часов, секунды. */
  stepSec?: number
  /** Предел прогона, секунды виртуального времени. */
  maxSec: number
  /** Что делать перед каждым тиком — действия «человека» в нужный момент. */
  onStep?: (now: number) => Promise<void> | void
  /** Прогон останавливается, как только вернёт true (проверяется после тика). */
  until?: (now: number) => boolean
}

export type RunResult = {
  /** Сколько виртуальных секунд прошло. */
  elapsedSec: number
  ticks: number
  /** Суммарный итог тиков — удобно проверять, что ничего не падало. */
  total: TickResult
  /** Сработало ли условие остановки (false = упёрлись в maxSec). */
  reached: boolean
}

/**
 * Крутить время шагами и после каждого шага прогонять тик, пока не сбудется until.
 *
 * Именно так проверяется приёмка «семь вечеров за пятнадцать минут»: тест не знает
 * заранее, в какую секунду наступит седьмой вечер, и не должен знать — иначе он
 * проверял бы собственную арифметику, а не поведение планировщика.
 */
export async function runVirtual(
  ctx: ClockCtx,
  flow: SchedulerFlow,
  opts: RunOptions,
): Promise<RunResult> {
  const step = opts.stepSec ?? TICK_SEC
  const started = ctx.clock.now()
  const total: TickResult = {
    seen: 0,
    claimed: 0,
    raced: 0,
    failed: 0,
    disabled: 0,
    outcomes: { handled: 0, silent: 0, healed: 0, postponed: 0, stopped: 0 },
  }
  let ticks = 0

  // Условие может быть выполнено ещё до первого шага — проверяем сразу.
  if (opts.until?.(ctx.clock.now()) === true) {
    return { elapsedSec: 0, ticks: 0, total, reached: true }
  }

  while (ctx.clock.now() - started < opts.maxSec) {
    ctx.clock.advance(step)
    const now = ctx.clock.now()
    if (opts.onStep) await opts.onStep(now)
    const res = await tick(ctx, now, flow)
    ticks += 1
    total.seen += res.seen
    total.claimed += res.claimed
    total.raced += res.raced
    total.failed += res.failed
    total.disabled += res.disabled
    for (const k of Object.keys(res.outcomes) as Array<keyof TickResult['outcomes']>) {
      total.outcomes[k] += res.outcomes[k]
    }
    if (opts.until?.(now) === true) {
      return { elapsedSec: now - started, ticks, total, reached: true }
    }
  }

  return { elapsedSec: ctx.clock.now() - started, ticks, total, reached: opts.until === undefined }
}

/** Сдвинуть часы и прогнать ровно один тик — для точечных проверок. */
export async function advanceTo(ctx: ClockCtx, at: number, flow: SchedulerFlow): Promise<TickResult> {
  ctx.clock.setNow(at)
  return await tick(ctx, at, flow)
}

/** Прогнать тик, не трогая часы. */
export async function tickNow(ctx: ClockCtx, flow: SchedulerFlow): Promise<TickResult> {
  return await tick(ctx, ctx.clock.now(), flow)
}
