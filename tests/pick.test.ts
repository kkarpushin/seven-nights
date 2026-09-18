/**
 * Выбор практики (§3.5 design-bot, §0 решение 2) и синк контента (§5.9, §8.3).
 *
 * Оба файла из src/content, поэтому лежат в одном тесте: синк наполняет таблицу,
 * из которой выбирает pick, и ломаются они обычно вместе.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeClock } from '../src/clock.ts'
import { createPracticesRepo } from '../src/db/practices.ts'
import { leastPlayedIn, pickPractice, routePractice } from '../src/content/pick.ts'
import { syncPractices } from '../src/content/practices.ts'
import type { Category, SessionRow } from '../src/db/types.ts'
import { makeSession, makeUser, seedTestPractices, T0, testCtx, testDb } from './helpers/db.ts'

// ───────────────────────────── выбор практики ─────────────────────────────

function setup(opts: { route?: string[] } = {}) {
  const db = testDb()
  seedTestPractices(db)
  const ctx = testCtx({ db })
  if (opts.route !== undefined) ctx.settings.set('sleep_route', JSON.stringify(opts.route))
  const user = makeUser(db, { state: 'awaiting_state' })
  return { db, ctx, user }
}

/**
 * Сессия-заготовка: вечер n или «практика сейчас». Статус можно задать: активная
 * сессия у человека по индексу sessions_one_active ровно одна, а тесту иногда
 * нужны два вечера подряд. На выбор практики статус не влияет.
 */
function session(
  db: ReturnType<typeof testDb>, userId: number, kind: 'evening' | 'now', eveningNo = 1,
  status: 'active' | 'done' = 'active',
): SessionRow {
  return makeSession(db, {
    userId, kind, eveningNo: kind === 'now' ? null : eveningNo, status,
    before: 5, after: null, practiceSentAt: null, ritualDate: `2026-09-${String(10 + eveningNo).padStart(2, '0')}`,
  })
}

const slug = (p: { slug: string } | null): string | null => p?.slug ?? null

describe('маршрут сна старше правила «меньше всего слушал»', () => {
  it('вечер 1 — первая практика маршрута', () => {
    const { db, ctx, user } = setup()
    const s = session(db, user.id, 'evening', 1)
    expect(slug(pickPractice(ctx, user, s, 'sleep'))).toBe('sleep-landing')
  })

  it('вечер 7 повторяет вечер 1 — та же запись, а человек другой', () => {
    const { db, ctx, user } = setup()
    const s = session(db, user.id, 'evening', 7)
    expect(slug(pickPractice(ctx, user, s, 'sleep'))).toBe('sleep-landing')
  })

  it('маршрут выигрывает даже у практики, которую не слушали ни разу', () => {
    const { db, ctx, user } = setup()
    const landing = ctx.repo.practices.bySlug('sleep-landing')!
    ctx.repo.plays.add(user.id, landing.id, null, T0)
    ctx.repo.plays.add(user.id, landing.id, null, T0 + 10)
    const s = session(db, user.id, 'evening', 1)
    expect(slug(pickPractice(ctx, user, s, 'sleep'))).toBe('sleep-landing')
  })

  it('«Практика сейчас» маршруту не подчиняется', () => {
    const { db, ctx, user } = setup()
    const s = session(db, user.id, 'now')
    expect(routePractice(ctx, s, 'sleep')).toBeNull()
    expect(slug(pickPractice(ctx, user, s, 'sleep'))).toBe('sleep-landing') // по sort_order, а не по маршруту
  })

  it('маршрут не действует на другие категории', () => {
    const { db, ctx, user } = setup()
    const s = session(db, user.id, 'evening', 2)
    expect(routePractice(ctx, s, 'calm')).toBeNull()
    expect(slug(pickPractice(ctx, user, s, 'calm'))).toBe('calm-sigh')
  })

  it('практика маршрута выключена — тихо уходим на общее правило', () => {
    const { db, ctx, user } = setup()
    const landing = ctx.repo.practices.bySlug('sleep-landing')!
    ctx.repo.practices.updateFromAdmin(landing.id, { active: 0 })
    const s = session(db, user.id, 'evening', 1)
    expect(slug(pickPractice(ctx, user, s, 'sleep'))).toBe('sleep-warmth')
  })

  it('в маршруте несуществующий слаг — не падаем', () => {
    const { db, ctx, user } = setup({ route: ['sleep-nope', 'sleep-warmth'] })
    const s = session(db, user.id, 'evening', 1)
    expect(slug(pickPractice(ctx, user, s, 'sleep'))).toBe('sleep-landing')
  })

  it('маршрут короче семи вечеров — хвост недели по общему правилу', () => {
    const { db, ctx, user } = setup({ route: ['sleep-shuffle'] })
    const s1 = session(db, user.id, 'evening', 1, 'done')
    expect(slug(pickPractice(ctx, user, s1, 'sleep'))).toBe('sleep-shuffle')
    const s2 = session(db, user.id, 'evening', 2)
    expect(slug(pickPractice(ctx, user, s2, 'sleep'))).toBe('sleep-landing')
  })

  it('маршрут пуст — всю неделю работает общее правило', () => {
    const { db, ctx, user } = setup({ route: [] })
    const s = session(db, user.id, 'evening', 1)
    expect(slug(pickPractice(ctx, user, s, 'sleep'))).toBe('sleep-landing')
  })

  it('практику маршрута перенесли в другую категорию — маршрут больше не применяется', () => {
    const { db, ctx, user } = setup()
    const landing = ctx.repo.practices.bySlug('sleep-landing')!
    ctx.repo.practices.updateFromAdmin(landing.id, { category: 'day' })
    const s = session(db, user.id, 'evening', 1)
    expect(routePractice(ctx, s, 'sleep')).toBeNull()
    expect(slug(pickPractice(ctx, user, s, 'sleep'))).toBe('sleep-warmth')
  })
})

describe('«меньше всего слушал»', () => {
  it('непрослушанные всегда вперёд, между ними — sort_order', () => {
    const { ctx, user } = setup()
    expect(slug(leastPlayedIn(ctx, user.id, 'calm'))).toBe('calm-sigh')
  })

  it('прослушанная уступает место непрослушанной', () => {
    const { ctx, user } = setup()
    const sigh = ctx.repo.practices.bySlug('calm-sigh')!
    ctx.repo.plays.add(user.id, sigh.id, null, T0)
    expect(slug(leastPlayedIn(ctx, user.id, 'calm'))).toBe('calm-ground')

    const ground = ctx.repo.practices.bySlug('calm-ground')!
    ctx.repo.plays.add(user.id, ground.id, null, T0 + 60)
    expect(slug(leastPlayedIn(ctx, user.id, 'calm'))).toBe('calm-kind')
  })

  it('второй круг: все слышали по разу — берём самую давнюю', () => {
    const { ctx, user } = setup()
    const at = (s: string, t: number) => ctx.repo.plays.add(user.id, ctx.repo.practices.bySlug(s)!.id, null, t)
    at('calm-sigh', T0 + 300)
    at('calm-ground', T0 + 100) // давнее всех
    at('calm-kind', T0 + 200)
    expect(slug(leastPlayedIn(ctx, user.id, 'calm'))).toBe('calm-ground')
  })

  it('равное число прослушиваний и одинаковое время — решает sort_order', () => {
    const { ctx, user } = setup()
    for (const s of ['calm-sigh', 'calm-ground', 'calm-kind']) {
      ctx.repo.plays.add(user.id, ctx.repo.practices.bySlug(s)!.id, null, T0)
    }
    expect(slug(leastPlayedIn(ctx, user.id, 'calm'))).toBe('calm-sigh')
  })

  it('чужие прослушивания не влияют', () => {
    const { db, ctx, user } = setup()
    const other = makeUser(db)
    ctx.repo.plays.add(other.id, ctx.repo.practices.bySlug('calm-sigh')!.id, null, T0)
    expect(slug(leastPlayedIn(ctx, user.id, 'calm'))).toBe('calm-sigh')
  })

  it('выключенные практики не кандидаты', () => {
    const { ctx, user } = setup()
    ctx.repo.practices.updateFromAdmin(ctx.repo.practices.bySlug('calm-sigh')!.id, { active: 0 })
    expect(slug(leastPlayedIn(ctx, user.id, 'calm'))).toBe('calm-ground')
  })
})

describe('запасные ветки', () => {
  function disable(ctx: ReturnType<typeof testCtx>, category: Category): void {
    for (const p of ctx.repo.practices.listActive(category)) {
      ctx.repo.practices.updateFromAdmin(p.id, { active: 0 })
    }
  }

  it('в категории пусто — берём из любой активной, приоритет sleep', () => {
    const { db, ctx, user } = setup()
    disable(ctx, 'calm')
    const s = session(db, user.id, 'now')
    expect(slug(pickPractice(ctx, user, s, 'calm'))).toBe('sleep-landing')
  })

  it('если и сна нет — идём в day, а не в null', () => {
    const { db, ctx, user } = setup()
    disable(ctx, 'calm')
    disable(ctx, 'sleep')
    const s = session(db, user.id, 'now')
    expect(slug(pickPractice(ctx, user, s, 'calm'))).toBe('day-tune')
  })

  it('библиотека пуста целиком — null, дальше err.no_practices', () => {
    const { db, ctx, user } = setup()
    for (const c of ['sleep', 'calm', 'day'] as Category[]) disable(ctx, c)
    const s = session(db, user.id, 'evening', 1)
    expect(pickPractice(ctx, user, s, 'sleep')).toBeNull()
  })

  it('в базе вообще нет практик — тоже null', () => {
    const db = testDb()
    const ctx = testCtx({ db })
    const user = makeUser(db)
    const s = session(db, user.id, 'evening', 1)
    expect(pickPractice(ctx, user, s, 'sleep')).toBeNull()
  })
})

// ───────────────────────────── синк контента ─────────────────────────────

describe('syncPractices', () => {
  let root: string
  let contentDir: string

  const md = (o: { slug: string; title: string; category: string; intro?: [string, string]; body?: string }): string =>
    [
      '---',
      `slug: ${o.slug}`,
      `title: ${o.title}`,
      `category: ${o.category}`,
      'intro:',
      `  - ${o.intro?.[0] ?? 'Первая строка.'}`,
      `  - ${o.intro?.[1] ?? 'Вторая строка.'}`,
      '---',
      o.body ?? 'Текст практики.',
      '',
    ].join('\n')

  const write = (o: Parameters<typeof md>[0]): void =>
    writeFileSync(join(contentDir, 'practices', `${o.slug}.md`), md(o), 'utf8')

  const writeAudio = (slugName: string, content: string): void =>
    writeFileSync(join(contentDir, 'audio', `${slugName}.mp3`), content, 'utf8')

  const manifest = (m: Record<string, { duration: number }>): void =>
    writeFileSync(join(contentDir, 'audio', 'manifest.json'), JSON.stringify(m), 'utf8')

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'seven-nights-sync-'))
    contentDir = join(root, 'content')
    mkdirSync(join(contentDir, 'practices'), { recursive: true })
    mkdirSync(join(contentDir, 'audio'), { recursive: true })
    write({ slug: 'sleep-a', title: 'Первая', category: 'sleep' })
    write({ slug: 'calm-b', title: 'Вторая', category: 'calm' })
    writeAudio('sleep-a', 'audio-a')
    writeAudio('calm-b', 'audio-b')
    manifest({ 'sleep-a': { duration: 589.4 }, 'calm-b': { duration: 540 } })
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  function repoOf(db = testDb()) {
    return { db, repo: createPracticesRepo(db, fakeClock(T0)) }
  }
  const run = (repo: ReturnType<typeof createPracticesRepo>, now = T0) =>
    syncPractices(repo, { contentDir, projectRoot: root, now })

  it('первый прогон создаёт практики с длительностью и хешем аудио', () => {
    const { repo } = repoOf()
    const r = run(repo)
    expect(r).toMatchObject({ added: 2, updated: 0, skipped: 0, withAudio: 2, errors: [] })

    const a = repo.bySlug('sleep-a')!
    expect(a.title).toBe('Первая')
    expect(a.line1).toBe('Первая строка.')
    expect(a.duration_sec).toBe(589) // округлили 589.4
    expect(a.audio_path).toBe('content/audio/sleep-a.mp3')
    expect(a.audio_sha256).toHaveLength(64)
    expect(a.script_hash).toHaveLength(64)
    expect(a.category).toBe('sleep')
    expect(repo.bySlug('calm-b')!.sort_order).toBe(200)
  })

  it('второй прогон не пишет ничего и не двигает updated_at', () => {
    const { repo } = repoOf()
    run(repo)
    const before = repo.bySlug('sleep-a')!

    // Время ушло вперёд на сутки: если синк тронет строку, это будет видно.
    const r = run(repo, T0 + 86_400)
    expect(r).toMatchObject({ added: 0, updated: 0, skipped: 2 })
    expect(repo.bySlug('sleep-a')!.updated_at).toBe(before.updated_at)
  })

  it('поменялся сценарий — обновляется текст, аудио не трогается', () => {
    const { repo } = repoOf()
    run(repo)
    const before = repo.bySlug('sleep-a')!
    repo.setFileId(before.id, 'CACHED', 'UNIQ')

    write({ slug: 'sleep-a', title: 'Первая, но иначе', category: 'sleep', body: 'Другой текст.' })
    const r = run(repo, T0 + 100)
    expect(r).toMatchObject({ added: 0, updated: 1, skipped: 1 })

    const after = repo.bySlug('sleep-a')!
    expect(after.title).toBe('Первая, но иначе')
    expect(after.script_hash).not.toBe(before.script_hash)
    // Кэш Telegram живёт: сам mp3 не менялся, перезаливать нечего.
    expect(after.tg_file_id).toBe('CACHED')
  })

  it('поменялся mp3 — сбрасывается tg_file_id', () => {
    const { repo } = repoOf()
    run(repo)
    const before = repo.bySlug('sleep-a')!
    repo.setFileId(before.id, 'CACHED', 'UNIQ')

    writeAudio('sleep-a', 'audio-a-перегенерировали')
    const r = run(repo, T0 + 100)
    expect(r).toMatchObject({ added: 0, updated: 1, skipped: 1 })

    const after = repo.bySlug('sleep-a')!
    expect(after.audio_sha256).not.toBe(before.audio_sha256)
    expect(after.tg_file_id).toBeNull()
    expect(after.tg_file_unique_id).toBeNull()
  })

  it('поменялась только длительность в манифесте — она доезжает до базы', () => {
    const { repo } = repoOf()
    run(repo)
    manifest({ 'sleep-a': { duration: 601 }, 'calm-b': { duration: 540 } })
    const r = run(repo, T0 + 100)
    expect(r).toMatchObject({ updated: 1, skipped: 1 })
    expect(repo.bySlug('sleep-a')!.duration_sec).toBe(601)
  })

  it('правки из админки синк не затирает — ни текст, ни аудио', () => {
    const { repo } = repoOf()
    run(repo)
    const row = repo.bySlug('sleep-a')!
    repo.updateFromAdmin(row.id, { title: 'Голос специалиста', line1: 'Своя строка' })
    repo.setFileId(row.id, 'ADMIN-FILE', 'ADMIN-UNIQ')

    write({ slug: 'sleep-a', title: 'Из файла', category: 'sleep', body: 'Совсем другой текст.' })
    writeAudio('sleep-a', 'ещё один вариант')
    const r = run(repo, T0 + 200)

    expect(r).toMatchObject({ added: 0, updated: 0, skipped: 2 })
    const after = repo.bySlug('sleep-a')!
    expect(after.title).toBe('Голос специалиста')
    expect(after.line1).toBe('Своя строка')
    expect(after.tg_file_id).toBe('ADMIN-FILE')
    expect(after.origin).toBe('admin')
  })

  it('нет mp3 — практика заводится без аудио и попадает в missingAudio', () => {
    const { repo } = repoOf()
    write({ slug: 'day-c', title: 'Третья', category: 'day' })
    const r = run(repo)
    expect(r.missingAudio).toEqual(['day-c'])
    expect(r).toMatchObject({ added: 3, withAudio: 2 })
    expect(repo.bySlug('day-c')!.audio_path).toBeNull()
  })

  it('mp3 пропал с диска — кэш file_id остаётся рабочим', () => {
    const { repo } = repoOf()
    run(repo)
    const row = repo.bySlug('sleep-a')!
    repo.setFileId(row.id, 'CACHED', 'UNIQ')
    rmSync(join(contentDir, 'audio', 'sleep-a.mp3'))

    const r = run(repo, T0 + 300)
    expect(r.missingAudio).toEqual(['sleep-a'])
    const after = repo.bySlug('sleep-a')!
    expect(after.tg_file_id).toBe('CACHED')
    expect(after.audio_path).toBe('content/audio/sleep-a.mp3')
  })

  it('сценарий удалили — практику не выключаем, но говорим о ней вслух', () => {
    const { repo } = repoOf()
    run(repo)
    rmSync(join(contentDir, 'practices', 'calm-b.md'))
    const r = run(repo, T0 + 400)
    expect(r.orphans).toEqual(['calm-b'])
    expect(repo.bySlug('calm-b')!.active).toBe(1)
  })

  it('битый frontmatter не роняет остальные практики', () => {
    const { repo } = repoOf()
    writeFileSync(join(contentDir, 'practices', 'broken.md'), 'нет никакого frontmatter', 'utf8')
    const r = run(repo)
    expect(r.added).toBe(2)
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toContain('broken.md')
  })

  it('манифест сломан — практики всё равно синкаются, ошибка видна', () => {
    const { repo } = repoOf()
    writeFileSync(join(contentDir, 'audio', 'manifest.json'), '{не json', 'utf8')
    const r = run(repo)
    expect(r.added).toBe(2)
    expect(r.errors[0]).toContain('manifest.json')
    expect(repo.bySlug('sleep-a')!.duration_sec).toBe(0)
  })

  it('нет каталога сценариев — внятная ошибка, а не исключение', () => {
    const { repo } = repoOf()
    const r = syncPractices(repo, { contentDir: join(root, 'нет-такого'), projectRoot: root, now: T0 })
    expect(r.errors[0]).toContain('Нет каталога сценариев')
    expect(r.added).toBe(0)
  })

  it('категория stress из старых документов ложится в calm', () => {
    const { repo } = repoOf()
    write({ slug: 'calm-old', title: 'Старая', category: 'stress' })
    run(repo)
    expect(repo.bySlug('calm-old')!.category).toBe('calm')
  })
})

// ───────────────────── синк и выбор вместе, на живом контенте ─────────────────────

describe('живой контент проекта', () => {
  it('девять сценариев синкаются и маршрут сна целиком существует', () => {
    const db = testDb()
    const ctx = testCtx({ db })
    const r = syncPractices(ctx.repo.practices, { contentDir: ctx.cfg.contentDir, now: T0 })

    expect(r.errors).toEqual([])
    expect(r.added).toBe(9)
    const route = ctx.settings.json<string[]>('sleep_route', [])
    expect(route).toHaveLength(7)
    for (const s of route) {
      const row = ctx.repo.practices.bySlug(s)
      expect(row, `в маршруте сна нет практики ${s}`).toBeDefined()
      expect(row!.active).toBe(1)
      expect(row!.category).toBe('sleep')
    }
  })
})
