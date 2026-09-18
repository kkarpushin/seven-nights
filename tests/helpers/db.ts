/**
 * Фабрика базы для тестов: SQLite в памяти, миграции применены, тексты и настройки
 * засеяны. §9.1 архитектуры.
 *
 * Тесты не читают .env и не трогают data/: и то и другое означало бы, что зелёный
 * прогон на одной машине ничего не говорит про другую. Окружение собирается здесь
 * руками, часы — фейковые, логгер молчит.
 *
 * Этим файлом пользуются все инженеры: testCtx() отдаёт готовый Ctx, в который
 * остаётся подставить свои texts/send.
 */

import Database from 'better-sqlite3'
import { fakeClock, type FakeClock } from '../../src/clock.ts'
import { silentLogger } from '../../src/log.ts'
import type { Env } from '../../src/env.ts'
import { applyMigrations, applyPragmas, MIGRATIONS_DIR, type Db } from '../../src/db/index.ts'
import { createRepos, type Ctx, type Repos } from '../../src/ctx.ts'
import { createSettingsStore, type SettingsStore } from '../../src/db/settings.ts'
import { seedSettings, seedTexts } from '../../src/db/seed.ts'
import type {
  AfterSource, Category, SessionKind, SessionRow, SessionStatus, UserRow, UserState,
} from '../../src/db/types.ts'

/** Точка отсчёта тестов: 2025-09-16 06:40 UTC. Любое «сейчас» в тестах — от неё. */
export const T0 = 1_758_000_000

export type TestDbOptions = {
  /** Засевать ли тексты и настройки. По умолчанию да. */
  seed?: boolean
  now?: number
  /** Переопределения настроек (например, demo_secret для предсказуемого теста). */
  settings?: Record<string, string>
}

export function testDb(opts: TestDbOptions = {}): Db {
  const db = new Database(':memory:') as Db
  // journal_mode = WAL на базе в памяти молча игнорируется, остальные PRAGMA важны:
  // без foreign_keys = ON каскадное удаление в тестах «работает», а в бою нет.
  applyPragmas(db)
  applyMigrations(db, MIGRATIONS_DIR)
  if (opts.seed !== false) {
    const now = opts.now ?? T0
    const clock = fakeClock(now)
    seedTexts(createRepos(db, clock).texts, now)
    seedSettings(createSettingsStore(db, clock), now, { demo_secret: 'testsecret', ...opts.settings })
  }
  return db
}

export type TestCtx = Ctx & { clock: FakeClock; repo: Repos; settings: SettingsStore }

export function testEnv(patch: Partial<Env> = {}): Env {
  return {
    telegramBotToken: '123456:TEST-TOKEN-FOR-TESTS-ONLY-000',
    adminPassword: 'test-password',
    port: 3700,
    bindHost: '127.0.0.1',
    adminTgIds: [999],
    dataDir: '/tmp/seven-nights-test',
    dbPath: ':memory:',
    contentDir: 'content',
    schedulerTickMs: 30_000,
    demoDefault: false,
    adminCookieSecure: false,
    logLevel: 'error',
    botUsername: 'ensoma_robot',
    ttsVoice: 'ru-RU-SvetlanaNeural',
    ttsStyle: '',
    ...patch,
  }
}

export type TestCtxOptions = TestDbOptions & { db?: Db; env?: Partial<Env> } & Partial<Pick<Ctx, 'texts' | 'send'>>

/**
 * Ctx для тестов. texts и send остаются незаполненными, пока их не передали:
 * каждый инженер подставляет свои заглушки, а попытка вызвать неподставленное
 * падает с внятной ошибкой вместо тихой работы «вхолостую» (см. src/ctx.ts).
 */
export function testCtx(opts: TestCtxOptions = {}): TestCtx {
  const now = opts.now ?? T0
  const db = opts.db ?? testDb(opts)
  const clock = fakeClock(now)
  const ctx: TestCtx = {
    db,
    cfg: testEnv(opts.env),
    clock,
    log: silentLogger(),
    settings: createSettingsStore(db, clock),
    repo: createRepos(db, clock),
    texts: opts.texts as Ctx['texts'],
    send: opts.send as Ctx['send'],
  }
  return ctx
}

// ───────────────────────────── фикстуры ─────────────────────────────

export type UserFixture = Partial<UserRow> & { tg_id?: number }

let nextTgId = 100_000

/** Человек с любым набором полей. tg_id выдаётся сам, если не задан. */
export function makeUser(db: Db, patch: UserFixture = {}): UserRow {
  const now = patch.created_at ?? T0
  const tgId = patch.tg_id ?? nextTgId++
  db.prepare('INSERT INTO users (tg_id, created_at, updated_at) VALUES (?, ?, ?)').run(tgId, now, now)
  const id = Number(
    (db.prepare('SELECT id FROM users WHERE tg_id = ?').get(tgId) as { id: number }).id,
  )
  const cols = Object.keys(patch).filter((k) => k !== 'id' && k !== 'tg_id' && k !== 'created_at')
  if (cols.length > 0) {
    db.prepare(`UPDATE users SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(
      ...cols.map((c) => (patch as Record<string, unknown>)[c]),
      id,
    )
  }
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow
}

export type SessionFixture = {
  userId: number
  runNo?: number
  kind?: SessionKind
  eveningNo?: number | null
  ritualDate?: string
  category?: Category | null
  practiceId?: number | null
  before?: number | null
  after?: number | null
  afterSource?: AfterSource | null
  status?: SessionStatus
  practiceSentAt?: number | null
  createdAt?: number
}

/** Сессия целиком, одним INSERT: тестам статистики нужен результат, а не путь к нему. */
export function makeSession(db: Db, f: SessionFixture): SessionRow {
  const createdAt = f.createdAt ?? T0
  const eveningNo = f.kind === 'now' ? null : (f.eveningNo ?? 1)
  const info = db
    .prepare(`
      INSERT INTO sessions (user_id, run_no, kind, evening_no, ritual_date, category, practice_id,
                            before_value, before_at, after_value, after_at, after_source,
                            status, practice_sent_at, closed_at, created_at)
      VALUES (@user_id, @run_no, @kind, @evening_no, @ritual_date, @category, @practice_id,
              @before_value, @before_at, @after_value, @after_at, @after_source,
              @status, @practice_sent_at, @closed_at, @created_at)
    `)
    .run({
      user_id: f.userId,
      run_no: f.runNo ?? 1,
      kind: f.kind ?? 'evening',
      evening_no: eveningNo,
      // Ритуальная дата по умолчанию уникальна на вечер: без этого сработал бы
      // индекс «один засчитанный вечер на дату» и фикстура упала бы на втором вечере.
      ritual_date: f.ritualDate ?? `2025-09-${String(10 + (eveningNo ?? 0)).padStart(2, '0')}`,
      category: f.category ?? 'sleep',
      practice_id: f.practiceId ?? null,
      before_value: f.before ?? null,
      before_at: f.before === null || f.before === undefined ? null : createdAt,
      after_value: f.after ?? null,
      after_at: f.after === null || f.after === undefined ? null : createdAt + 1200,
      after_source: f.afterSource ?? (f.after === null || f.after === undefined ? null : 'button'),
      status: f.status ?? 'done',
      practice_sent_at: f.practiceSentAt === undefined ? createdAt + 60 : f.practiceSentAt,
      closed_at: createdAt + 1800,
      created_at: createdAt,
    })
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(Number(info.lastInsertRowid)) as SessionRow
}

export function addEvent(db: Db, userId: number | null, type: string, at: number, payload: object = {}): void {
  db.prepare('INSERT INTO events (user_id, type, at, payload) VALUES (?, ?, ?, ?)').run(
    userId, type, at, JSON.stringify(payload),
  )
}

/** Практики без похода на диск: тестам не нужны ни mp3, ни манифест. */
export function seedTestPractices(db: Db, now = T0): void {
  const rows: Array<[string, Category, string, number]> = [
    ['sleep-landing', 'sleep', 'Приземление', 110],
    ['sleep-warmth', 'sleep', 'Тепло по телу', 120],
    ['sleep-release', 'sleep', 'Отпустить день', 130],
    ['sleep-shuffle', 'sleep', 'Случайные картинки', 140],
    ['calm-sigh', 'calm', 'Два вдоха и выдох', 210],
    ['calm-ground', 'calm', 'Пять вещей вокруг', 220],
    ['calm-kind', 'calm', 'Рука на сердце', 230],
    ['day-tune', 'day', 'Настроить день', 310],
    ['day-talk', 'day', 'Перед разговором', 320],
  ]
  const stmt = db.prepare(`
    INSERT INTO practices (slug, category, title, line1, line2, duration_sec, sort_order,
                           active, origin, created_at, updated_at)
    VALUES (?, ?, ?, '', '', 600, ?, 1, 'file', ?, ?)
  `)
  db.transaction(() => {
    for (const [slug, category, title, order] of rows) stmt.run(slug, category, title, order, now, now)
  })()
}

/** Состояние «человек ждёт вечера» — самая частая отправная точка тестов диалога. */
export function idleUser(db: Db, patch: UserFixture = {}): UserRow {
  return makeUser(db, {
    state: 'idle' as UserState,
    tz_offset_min: 180,
    evening_time: '21:00',
    last_seen_at: T0,
    ...patch,
  })
}
