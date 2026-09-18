/**
 * Часы проекта. §5.1 архитектуры.
 *
 * Никто в проекте не зовёт Date.now() напрямую: иначе тест «вечер наступил в 21:00»
 * пришлось бы ждать до девяти вечера. Единственный источник «сейчас» — этот интерфейс,
 * он же подменяется в тестах.
 */

export type Clock = {
  /** unix-секунды UTC, целое. */
  now(): number
  /** Паузы ради ритма диалога (typing, upload_voice). В тестах — мгновенно. */
  sleep(ms: number): Promise<void>
}

export const systemClock: Clock = {
  now: () => Math.floor(Date.now() / 1000),
  sleep: (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms))),
}

export type FakeClock = Clock & {
  advance(sec: number): void
  setNow(unixSec: number): void
  /** Сколько миллисекунд «проспали» — удобно проверять, что паузу вообще ставили. */
  readonly slept: number
}

export type FakeClockOptions = {
  /**
   * Сдвигать ли виртуальное время на длительность sleep(). По умолчанию НЕТ:
   * иначе пауза 1,2 с посреди онбординга уезжает в ожидаемый due_at, и тест
   * «следующий пинг ровно в T0 + сутки» начинает падать на 1,2 секунды.
   * Тем, кто проверяет именно ход времени, флаг можно включить.
   */
  advanceOnSleep?: boolean
}

export function fakeClock(startUnix: number, opts: FakeClockOptions = {}): FakeClock {
  let current = Math.floor(startUnix)
  let slept = 0
  return {
    now: () => current,
    sleep: async (ms) => {
      const d = Math.max(0, ms)
      slept += d
      if (opts.advanceOnSleep) current += Math.floor(d / 1000)
    },
    advance: (sec) => {
      current += Math.floor(sec)
    },
    setNow: (unixSec) => {
      current = Math.floor(unixSec)
    },
    get slept() {
      return slept
    },
  }
}
