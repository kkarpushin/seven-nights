/**
 * Статистика админки. §6.6 архитектуры.
 *
 * Сценарий один на весь файл: шесть настоящих участников с разными исходами плюс
 * один демо-участник с идеальными цифрами. Демо-участник здесь не для полноты —
 * он проверяет главное свойство этих запросов: приёмочный прогон «семь вечеров за
 * пятнадцать минут» не имеет права попасть ни в одну цифру на дашборде. На шести
 * живых людях один такой прогон сдвинул бы средний прирост в полтора раза.
 *
 * Четыре цифры ТЗ проверяются поимённо: начали, дошли до седьмого, средний прирост
 * первый→последний вечер, на каком вечере чаще всего останавливаются.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { createStatsRepo, type StatsRepo } from '../src/db/stats.ts'
import type { Db } from '../src/db/index.ts'
import { addEvent, makeSession, makeUser, seedTestPractices, testDb, T0 } from './helpers/db.ts'
import type { AfterSource, Category } from '../src/db/types.ts'

/** «Сейчас» теста — на десять суток позже точки отсчёта: так «7 дней без активности» уже наступило. */
const NOW = T0 + 10 * 86_400

type Ids = { u1: number; u2: number; u3: number; u4: number; u5: number; u6: number; demo: number }

let db: Db
let stats: StatsRepo
let ids: Ids

/** Ровный набор вечеров: before/after одинаковые, ритуальная дата уникальна на вечер. */
function evenings(
  userId: number,
  count: number,
  before: number,
  after: number | null,
  opts: { practiceId?: number; afterSourceOn?: Record<number, AfterSource> } = {},
): void {
  for (let n = 1; n <= count; n++) {
    makeSession(db, {
      userId,
      eveningNo: n,
      before,
      after,
      afterSource: opts.afterSourceOn?.[n] ?? (after === null ? null : 'button'),
      practiceId: opts.practiceId ?? null,
      createdAt: T0 + n * 86_400,
    })
  }
}

beforeEach(() => {
  db = testDb({ now: T0 })
  seedTestPractices(db, T0)
  stats = createStatsRepo(db)

  const landingId = (db.prepare(`SELECT id FROM practices WHERE slug = 'sleep-landing'`).get() as { id: number }).id

  // U1 — дошёл до конца. Было 4, стало 7 → прирост 3.
  const u1 = makeUser(db, {
    state: 'completed', current_evening: 7, last_seen_at: T0, completed_at: T0 + 7 * 86_400,
    quiz_sum: 42, quiz_index: 60, quiz_at: T0, quiz_sum_after: 52, quiz_index_after: 74,
    quiz_after_at: T0 + 7 * 86_400,
  }).id
  evenings(u1, 7, 4, 7, { practiceId: landingId })
  addEvent(db, u1, 'started', T0)
  addEvent(db, u1, 'finished', T0 + 7 * 86_400)
  // Внесчётная практика: в воронку вечеров не попадает, в «практику сейчас» — да.
  makeSession(db, { userId: u1, kind: 'now', category: 'sleep', createdAt: T0 + 3 * 86_400, before: 5, after: 8 })

  // U2 — тоже дошёл, но начал ниже: было 2, стало 7 → прирост 5.
  const u2 = makeUser(db, {
    state: 'completed', current_evening: 7, last_seen_at: T0, completed_at: T0 + 9 * 86_400,
    quiz_sum: 28, quiz_index: 40, quiz_at: T0, quiz_sum_after: 35, quiz_index_after: 50,
    quiz_after_at: T0 + 9 * 86_400,
  }).id
  makeSession(db, { userId: u2, eveningNo: 1, before: 2, after: 6, createdAt: T0 + 86_400 })
  for (let n = 2; n <= 6; n++) {
    makeSession(db, { userId: u2, eveningNo: n, before: 5, after: 6, createdAt: T0 + n * 86_400 })
  }
  makeSession(db, { userId: u2, eveningNo: 7, before: 5, after: 7, createdAt: T0 + 7 * 86_400 })
  addEvent(db, u2, 'started', T0)
  addEvent(db, u2, 'finished', T0 + 9 * 86_400)

  // U3 и U4 — остановились на третьем вечере и больше не появлялись.
  const u3 = makeUser(db, { state: 'idle', current_evening: 3, consecutive_skips: 3, last_seen_at: T0, quiz_sum: 21, quiz_index: 30, quiz_at: T0 }).id
  evenings(u3, 3, 3, 5)
  makeSession(db, { userId: u3, eveningNo: 4, before: 3, after: null, status: 'abandoned', practiceSentAt: null, createdAt: T0 + 4 * 86_400 })
  addEvent(db, u3, 'started', T0)
  addEvent(db, u3, 'autopaused', T0 + 6 * 86_400)

  const u4 = makeUser(db, { state: 'idle', current_evening: 3, consecutive_skips: 3, last_seen_at: T0 }).id
  evenings(u4, 3, 3, 5)
  addEvent(db, u4, 'started', T0)
  addEvent(db, u4, 'autopaused', T0 + 6 * 86_400)

  // U5 — остановился на пятом; на пятом вечере цифра пришла утренним догоном.
  const u5 = makeUser(db, { state: 'idle', current_evening: 5, last_seen_at: T0 }).id
  evenings(u5, 5, 6, 8, { afterSourceOn: { 5: 'morning' } })
  addEvent(db, u5, 'started', T0)

  // U6 — активен прямо сейчас, на втором вечере; на втором уснул и цифру не прислал.
  const u6 = makeUser(db, { state: 'idle', current_evening: 2, last_seen_at: NOW }).id
  makeSession(db, { userId: u6, eveningNo: 1, before: 5, after: 5, createdAt: T0 + 86_400 })
  makeSession(db, { userId: u6, eveningNo: 2, before: 5, after: null, createdAt: T0 + 2 * 86_400 })
  makeSession(db, { userId: u6, eveningNo: 3, before: null, after: null, status: 'declined', practiceSentAt: null, createdAt: T0 + 3 * 86_400 })
  makeSession(db, { userId: u6, kind: 'now', category: 'calm', createdAt: T0 + 4 * 86_400, before: 3, after: 6 })
  addEvent(db, u6, 'started', T0)

  // Демо — идеальный прогон, которого в цифрах быть не должно.
  const demo = makeUser(db, {
    demo: 1, state: 'completed', current_evening: 7, last_seen_at: NOW,
    quiz_sum: 0, quiz_index: 0, quiz_at: T0, quiz_sum_after: 70, quiz_index_after: 100, quiz_after_at: T0,
  }).id
  evenings(demo, 7, 0, 10)
  addEvent(db, demo, 'started', T0)
  addEvent(db, demo, 'finished', T0 + 86_400)

  ids = { u1, u2, u3, u4, u5, u6, demo }
})

describe('четыре цифры ТЗ', () => {
  it('начали, дошли до седьмого, конверсия — без демо', () => {
    const f = stats.funnel({ now: NOW })
    expect(f.started).toBe(6)
    expect(f.finished).toBe(2)
    expect(f.conversion).toBeCloseTo(2 / 6, 3)
  })

  it('средний прирост первый вечер → последний считается по дошедшим', () => {
    // U1: 7 − 4 = 3, U2: 7 − 2 = 5. Демо (10 − 0) не участвует.
    expect(stats.avgGain({ now: NOW })).toBe(4)
  })

  it('чаще всего останавливаются на третьем вечере', () => {
    const stuck = stats.stuckAt({ now: NOW })
    expect(stuck[0]).toEqual({ evening: 3, people: 2 })
    expect(stuck).toEqual([
      { evening: 3, people: 2 },
      { evening: 5, people: 1 },
    ])
  })

  it('U6 активен на этой неделе и остановившимся не считается', () => {
    expect(stats.stuckAt({ now: NOW }).some((r) => r.evening === 2)).toBe(false)
  })

  it('воронка по вечерам: сколько человек дошло до каждого', () => {
    expect(stats.reach({ now: NOW })).toEqual([
      { evening: 1, people: 6 },
      { evening: 2, people: 6 },
      { evening: 3, people: 5 },
      { evening: 4, people: 3 },
      { evening: 5, people: 3 },
      { evening: 6, people: 2 },
      { evening: 7, people: 2 },
    ])
  })
})

describe('демо-участники исключены везде', () => {
  it('с включённым демо цифры другие', () => {
    const f = stats.funnel({ now: NOW, includeDemo: true })
    expect(f.started).toBe(7)
    expect(f.finished).toBe(3)
    // U1: +3, U2: +5, демо: +10 → 6
    expect(stats.avgGain({ now: NOW, includeDemo: true })).toBe(6)
  })

  it('демо не виден в состояниях, воронке и индексе теста', () => {
    const states = Object.fromEntries(stats.states({ now: NOW }).map((r) => [r.state, r.n]))
    expect(states).toEqual({ idle: 4, completed: 2 })
    expect(stats.reach({ now: NOW })[0].people).toBe(6)
    expect(stats.quiz({ now: NOW }).both).toBe(2)
  })
})

describe('распределение «до/после» по вечерам', () => {
  it('первый вечер: шесть закрытых сессий, средние по ним', () => {
    const e1 = stats.byEvening({ now: NOW }).find((r) => r.evening === 1)!
    expect(e1.n).toBe(6)
    // before: 4 + 2 + 3 + 3 + 6 + 5 = 23 → 3.83; after: 7 + 6 + 5 + 5 + 8 + 5 = 36 → 6
    expect(e1.avg_before).toBe(3.83)
    expect(e1.avg_after).toBe(6)
    expect(e1.avg_delta).toBe(2.17)
  })

  it('вечер без цифры «после» считается в n, но не в среднем «после»', () => {
    const e2 = stats.byEvening({ now: NOW }).find((r) => r.evening === 2)!
    // U1(7), U2(6), U3(5), U4(5), U5(8), U6(нет) → n = 6, среднее по пяти = 6.2
    expect(e2.n).toBe(6)
    expect(e2.avg_after).toBe(6.2)
  })
})

describe('качество замера «после»', () => {
  it('кнопка, утренний догон и молчание считаются отдельно', () => {
    const by = Object.fromEntries(stats.afterSource({ now: NOW }).map((r) => [r.source, r.n]))
    expect(by.morning).toBe(1)   // U5, пятый вечер
    expect(by.none).toBe(1)      // U6, второй вечер: уснул и утром не ответил
    expect(by.button).toBe(25)   // все остальные засчитанные вечера
  })
})

describe('практики', () => {
  it('прослушивания и средний сдвиг считаются по засчитанным сессиям', () => {
    const rows = stats.practices({ now: NOW })
    const landing = rows.find((r) => r.slug === 'sleep-landing')!
    expect(landing.plays).toBe(7)
    expect(landing.avg_delta).toBe(3)
    // Практика, которую никто не слушал, всё равно в списке — это видно в админке.
    const untouched = rows.find((r) => r.slug === 'day-talk')!
    expect(untouched.plays).toBe(0)
    expect(untouched.avg_delta).toBeNull()
  })
})

describe('«Практика сейчас»', () => {
  it('считается отдельно от вечеров и разложена по категориям', () => {
    const now = stats.nowSessions({ now: NOW })
    expect(now.sessions).toBe(2)
    const byCat = Object.fromEntries(now.by_category.map((r) => [r.category as Category, r.n]))
    expect(byCat).toEqual({ sleep: 1, calm: 1 })
  })
})

describe('тест «Индекс внутренней опоры»', () => {
  it('средние считаются только по тем, у кого оба замера', () => {
    const q = stats.quiz({ now: NOW })
    expect(q.both).toBe(2)
    expect(q.in_avg).toBe(50)    // (60 + 40) / 2
    expect(q.out_avg).toBe(62)   // (74 + 50) / 2
    expect(q.gain).toBe(12)      // (14 + 10) / 2
    // Входной индекс по всем пришедшим с лендинга — включая тех, кто не дошёл.
    expect(q.in_avg_all).toBe(43.3) // (60 + 40 + 30) / 3
  })
})

describe('состояния и пропуски', () => {
  it('брошенные, отклонённые и автопаузы считаются раздельно', () => {
    const s = stats.skips({ now: NOW })
    expect(s.abandoned).toBe(1)  // U3, четвёртый вечер
    expect(s.declined).toBe(1)   // U6, «Не сегодня»
    expect(s.autopaused).toBe(2) // U3 и U4
    expect(s.avg).toBe(1)        // (3 + 3) / 6 участников
  })
})

describe('активные сегодня', () => {
  it('считаются по последнему касанию, демо не в счёт', () => {
    const t = stats.today({ now: NOW })
    expect(t.active).toBe(1) // только U6; демо с тем же last_seen_at исключён
    expect(t.new).toBe(0)
    expect(t.practices).toBe(0)
  })
})

describe('средний прирост за вечер у одного человека', () => {
  it('идёт в {avg} уведомления admin.finished', () => {
    expect(stats.avgGainForUser(ids.u1, 1)).toBe(3)
    // У U6 один вечер с обеими цифрами (5 → 5) и один без «после».
    expect(stats.avgGainForUser(ids.u6, 1)).toBe(0)
  })

  it('без единой пары цифр — null, а не ноль', () => {
    const lonely = makeUser(db, { state: 'idle' }).id
    expect(stats.avgGainForUser(lonely, 1)).toBeNull()
  })
})

describe('обзор целиком', () => {
  it('overview собирает все разделы', () => {
    const o = stats.overview({ now: NOW })
    expect(o.funnel.started).toBe(6)
    expect(o.avgGain).toBe(4)
    expect(o.stuckAt[0].evening).toBe(3)
    expect(o.reach).toHaveLength(7)
    expect(o.byEvening).toHaveLength(7)
    expect(o.practices).toHaveLength(9)
    expect(o.states).toHaveLength(2)
  })
})
