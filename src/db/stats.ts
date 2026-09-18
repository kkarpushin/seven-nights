/**
 * Вся статистика админки. §6.6 архитектуры — формулы оттуда, дословно.
 *
 * Два правила, без которых цифры врут.
 *
 * 1. Демо-пользователи исключаются везде. Приёмочный прогон «семь вечеров за
 *    пятнадцать минут» даёт идеального участника с полным набором замеров, и один
 *    такой прогон заметно сдвигает средние на малых числах. Переключатель
 *    «показывать демо» в админке — единственный способ их увидеть.
 *
 * 2. «Люди» считаются по users.id, «вечера» — по sessions. Один человек может
 *    пройти программу дважды (run_no), и COUNT(*) по сессиям в вопросе «сколько
 *    начали» ответил бы не на тот вопрос.
 *
 * Окно [from, to] применяется там, где оно имеет смысл: к событиям и к сессиям по
 * времени создания. К срезам «сколько людей сейчас в каком состоянии» окно не
 * применяется — это снимок на сегодня, а не поток за период.
 */

import type { Db } from './index.ts'
import type { AfterSource, Category, UserState } from './types.ts'

export type StatsQuery = {
  from?: number
  to?: number
  /** «Сейчас» для «активных сегодня» и для определения «остановился». */
  now: number
  includeDemo?: boolean
}

export type Stats = {
  funnel: { started: number; finished: number; conversion: number }
  avgGain: number | null
  stuckAt: Array<{ evening: number; people: number }>
  reach: Array<{ evening: number; people: number }>
  byEvening: Array<{ evening: number; n: number; avg_before: number | null; avg_after: number | null; avg_delta: number | null }>
  today: { active: number; practices: number; new: number }
  now: { sessions: number; by_category: Array<{ category: Category; n: number }> }
  practices: Array<{ id: number; slug: string; title: string; plays: number; avg_delta: number | null }>
  afterSource: Array<{ source: AfterSource | 'none'; n: number }>
  quiz: { in_avg: number | null; out_avg: number | null; gain: number | null; both: number; in_avg_all: number | null }
  states: Array<{ state: UserState; n: number }>
  skips: { avg: number; abandoned: number; declined: number; autopaused: number }
}

export type StatsRepo = {
  overview(q: StatsQuery): Stats
  funnel(q: StatsQuery): Stats['funnel']
  avgGain(q: StatsQuery): number | null
  /** Средний прирост за вечер у одного человека — для {avg} в admin.finished и карточки. */
  avgGainForUser(userId: number, runNo: number): number | null
  stuckAt(q: StatsQuery): Stats['stuckAt']
  reach(q: StatsQuery): Stats['reach']
  byEvening(q: StatsQuery): Stats['byEvening']
  today(q: StatsQuery): Stats['today']
  nowSessions(q: StatsQuery): Stats['now']
  practices(q: StatsQuery): Stats['practices']
  afterSource(q: StatsQuery): Stats['afterSource']
  quiz(q: StatsQuery): Stats['quiz']
  states(q: StatsQuery): Stats['states']
  skips(q: StatsQuery): Stats['skips']
}

const FROM_DEFAULT = 0
const TO_DEFAULT = 9_999_999_999
const STUCK_AFTER_SEC = 7 * 86_400

export function createStatsRepo(db: Db): StatsRepo {
  /** Подзапрос-исключение демо. Пустая строка, когда демо просят показать. */
  const noDemo = (alias: string, includeDemo?: boolean): string =>
    includeDemo ? '' : ` AND ${alias} NOT IN (SELECT id FROM users WHERE demo = 1)`

  const window = (q: StatsQuery): [number, number] => [q.from ?? FROM_DEFAULT, q.to ?? TO_DEFAULT]

  const repo: StatsRepo = {
    // 1. Начали / дошли / конверсия.
    funnel(q) {
      const [from, to] = window(q)
      const row = db
        .prepare(`
          SELECT
            (SELECT COUNT(DISTINCT user_id) FROM events
              WHERE type = 'started' AND at BETWEEN ? AND ?${noDemo('user_id', q.includeDemo)})  AS started,
            (SELECT COUNT(DISTINCT user_id) FROM events
              WHERE type = 'finished' AND at BETWEEN ? AND ?${noDemo('user_id', q.includeDemo)}) AS finished
        `)
        .get(from, to, from, to) as { started: number; finished: number }
      return {
        started: row.started,
        finished: row.finished,
        conversion: row.started === 0 ? 0 : Math.round((row.finished / row.started) * 1000) / 1000,
      }
    },

    // 2. Средний прирост «первый вечер → последний вечер» в пределах круга.
    // Первый непустой before и последний непустой after ищутся по evening_no, а не
    // по времени: вечер 3, пройденный после пропуска, всё равно третий.
    avgGain(q) {
      const [from, to] = window(q)
      const row = db
        .prepare(`
          WITH fb AS (
            SELECT user_id, run_no, before_value,
                   ROW_NUMBER() OVER (PARTITION BY user_id, run_no ORDER BY evening_no) AS rn
              FROM sessions
             WHERE kind = 'evening' AND before_value IS NOT NULL),
          la AS (
            SELECT user_id, run_no, after_value,
                   ROW_NUMBER() OVER (PARTITION BY user_id, run_no ORDER BY evening_no DESC) AS rn
              FROM sessions
             WHERE kind = 'evening' AND after_value IS NOT NULL)
          SELECT ROUND(AVG(la.after_value - fb.before_value), 2) AS avg_gain
            FROM fb JOIN la ON la.user_id = fb.user_id AND la.run_no = fb.run_no
           WHERE fb.rn = 1 AND la.rn = 1
             AND fb.user_id IN (SELECT user_id FROM events
                                 WHERE type = 'finished' AND at BETWEEN ? AND ?)
             ${noDemo('fb.user_id', q.includeDemo)}
        `)
        .get(from, to) as { avg_gain: number | null }
      return row.avg_gain
    },

    avgGainForUser(userId, runNo) {
      const row = db
        .prepare(`
          SELECT ROUND(AVG(after_value - before_value), 2) AS avg_delta
            FROM sessions
           WHERE user_id = ? AND run_no = ? AND kind = 'evening'
             AND before_value IS NOT NULL AND after_value IS NOT NULL
        `)
        .get(userId, runNo) as { avg_delta: number | null }
      return row.avg_delta
    },

    // 3. На каком вечере чаще всего останавливаются.
    // «Остановился» = 7 дней без активности и программа не закончена.
    stuckAt(q) {
      return db
        .prepare(`
          SELECT current_evening AS evening, COUNT(*) AS people
            FROM users
           WHERE ${q.includeDemo ? '1 = 1' : 'demo = 0'}
             AND current_evening BETWEEN 1 AND 6
             AND state NOT IN ('completed')
             AND (last_seen_at IS NULL OR last_seen_at < ?)
           GROUP BY current_evening
           ORDER BY people DESC, evening ASC
        `)
        .all(q.now - STUCK_AFTER_SEC) as Stats['stuckAt']
    },

    // 4. Доходимость по вечерам (воронка). Вечер засчитан = аудио отправлено.
    reach(q) {
      const [from, to] = window(q)
      return db
        .prepare(`
          SELECT evening_no AS evening, COUNT(DISTINCT user_id) AS people
            FROM sessions
           WHERE kind = 'evening' AND practice_sent_at IS NOT NULL
             AND created_at BETWEEN ? AND ?${noDemo('user_id', q.includeDemo)}
           GROUP BY evening_no ORDER BY evening_no
        `)
        .all(from, to) as Stats['reach']
    },

    // 5. Распределение «до/после» по вечерам.
    byEvening(q) {
      const [from, to] = window(q)
      return db
        .prepare(`
          SELECT evening_no AS evening, COUNT(*) AS n,
                 ROUND(AVG(before_value), 2) AS avg_before,
                 ROUND(AVG(after_value), 2)  AS avg_after,
                 ROUND(AVG(CASE WHEN before_value IS NOT NULL AND after_value IS NOT NULL
                                THEN after_value - before_value END), 2) AS avg_delta
            FROM sessions
           WHERE kind = 'evening' AND status = 'done'
             AND created_at BETWEEN ? AND ?${noDemo('user_id', q.includeDemo)}
           GROUP BY evening_no ORDER BY evening_no
        `)
        .all(from, to) as Stats['byEvening']
    },

    // 6. Активные сегодня. day_start — 00:00 UTC текущих суток, в UI подписано «по серверу».
    today(q) {
      const dayStart = Math.floor(q.now / 86_400) * 86_400
      return db
        .prepare(`
          SELECT
            (SELECT COUNT(*) FROM users WHERE last_seen_at >= ?${q.includeDemo ? '' : ' AND demo = 0'}) AS active,
            (SELECT COUNT(*) FROM sessions WHERE practice_sent_at >= ?${noDemo('user_id', q.includeDemo)}) AS practices,
            (SELECT COUNT(*) FROM users WHERE created_at >= ?${q.includeDemo ? '' : ' AND demo = 0'})     AS new
        `)
        .get(dayStart, dayStart, dayStart) as Stats['today']
    },

    // 7. «Практика сейчас».
    nowSessions(q) {
      const [from, to] = window(q)
      const total = (
        db
          .prepare(`
            SELECT COUNT(*) AS n FROM sessions
             WHERE kind = 'now' AND practice_sent_at IS NOT NULL
               AND created_at BETWEEN ? AND ?${noDemo('user_id', q.includeDemo)}
          `)
          .get(from, to) as { n: number }
      ).n
      const byCategory = db
        .prepare(`
          SELECT category, COUNT(*) AS n FROM sessions
           WHERE kind = 'now' AND practice_sent_at IS NOT NULL AND category IS NOT NULL
             AND created_at BETWEEN ? AND ?${noDemo('user_id', q.includeDemo)}
           GROUP BY category ORDER BY n DESC
        `)
        .all(from, to) as Array<{ category: Category; n: number }>
      return { sessions: total, by_category: byCategory }
    },

    // 8. Практики: сколько слушали и какой средний сдвиг.
    practices(q) {
      const [from, to] = window(q)
      return db
        .prepare(`
          SELECT p.id, p.slug, p.title,
                 COUNT(s.id) AS plays,
                 ROUND(AVG(CASE WHEN s.before_value IS NOT NULL AND s.after_value IS NOT NULL
                                THEN s.after_value - s.before_value END), 2) AS avg_delta
            FROM practices p
            LEFT JOIN sessions s
              ON s.practice_id = p.id AND s.practice_sent_at IS NOT NULL
             AND s.created_at BETWEEN ? AND ?${noDemo('s.user_id', q.includeDemo)}
           GROUP BY p.id ORDER BY plays DESC, p.sort_order, p.id
        `)
        .all(from, to) as Stats['practices']
    },

    // 9. Качество замера «после»: сколько цифр пришло по кнопке, а сколько догоном.
    afterSource(q) {
      const [from, to] = window(q)
      return db
        .prepare(`
          SELECT COALESCE(after_source, 'none') AS source, COUNT(*) AS n
            FROM sessions
           WHERE kind = 'evening' AND practice_sent_at IS NOT NULL
             AND created_at BETWEEN ? AND ?${noDemo('user_id', q.includeDemo)}
           GROUP BY 1 ORDER BY n DESC
        `)
        .all(from, to) as Stats['afterSource']
    },

    // 10. Тест: средние индексы. Прирост — только по тем, у кого оба замера.
    quiz(q) {
      const both = db
        .prepare(`
          SELECT COUNT(*) AS both,
                 ROUND(AVG(quiz_index), 1)       AS in_avg,
                 ROUND(AVG(quiz_index_after), 1) AS out_avg,
                 ROUND(AVG(quiz_index_after - quiz_index), 1) AS gain
            FROM users
           WHERE quiz_index IS NOT NULL AND quiz_index_after IS NOT NULL
             ${q.includeDemo ? '' : 'AND demo = 0'}
        `)
        .get() as { both: number; in_avg: number | null; out_avg: number | null; gain: number | null }
      const all = db
        .prepare(`
          SELECT ROUND(AVG(quiz_index), 1) AS in_avg_all FROM users
           WHERE quiz_index IS NOT NULL ${q.includeDemo ? '' : 'AND demo = 0'}
        `)
        .get() as { in_avg_all: number | null }
      return { ...both, in_avg_all: all.in_avg_all }
    },

    // 11. Состояния и пропуски — снимок на сейчас.
    states: (q) =>
      db
        .prepare(`
          SELECT state, COUNT(*) AS n FROM users
           WHERE ${q.includeDemo ? '1 = 1' : 'demo = 0'}
           GROUP BY state ORDER BY n DESC
        `)
        .all() as Stats['states'],

    skips(q) {
      const avg = (
        db
          .prepare(`
            SELECT COALESCE(ROUND(AVG(consecutive_skips), 2), 0) AS avg FROM users
             WHERE ${q.includeDemo ? '1 = 1' : 'demo = 0'}
          `)
          .get() as { avg: number }
      ).avg
      const byStatus = db
        .prepare(`
          SELECT status, COUNT(*) AS n FROM sessions
           WHERE kind = 'evening'${noDemo('user_id', q.includeDemo)}
           GROUP BY status
        `)
        .all() as Array<{ status: string; n: number }>
      const autopaused = (
        db
          .prepare(`
            SELECT COUNT(*) AS n FROM events
             WHERE type = 'autopaused'${noDemo('user_id', q.includeDemo)}
          `)
          .get() as { n: number }
      ).n
      const find = (s: string) => byStatus.find((r) => r.status === s)?.n ?? 0
      return { avg, abandoned: find('abandoned'), declined: find('declined'), autopaused }
    },

    overview(q) {
      return {
        funnel: repo.funnel(q),
        avgGain: repo.avgGain(q),
        stuckAt: repo.stuckAt(q),
        reach: repo.reach(q),
        byEvening: repo.byEvening(q),
        today: repo.today(q),
        now: repo.nowSessions(q),
        practices: repo.practices(q),
        afterSource: repo.afterSource(q),
        quiz: repo.quiz(q),
        states: repo.states(q),
        skips: repo.skips(q),
      }
    },
  }

  return repo
}
