/**
 * Засев базы: тексты, настройки, практики из файлов. §8.5 архитектуры, шаг 3.
 *
 * Операция идемпотентна — её запускают и при первой установке, и после каждой
 * генерации озвучки, и после `git pull`. Поэтому ни одна её часть не затирает
 * правки владельца: тексты обновляют только default_value, настройки ставятся
 * через INSERT OR IGNORE, практики с origin='admin' пропускаются целиком.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { DEFAULT_SETTINGS, DEFAULT_TEXTS } from './defaultTexts.ts'
import type { PracticesRepo } from './practices.ts'
import type { SettingsStore } from './settings.ts'
import type { TextsRepo } from './texts.ts'
import type { Category } from './types.ts'

export type SeedCounts = { created: number; updated: number }

export function seedTexts(repo: TextsRepo, now: number): SeedCounts {
  let created = 0
  let updated = 0
  for (const t of DEFAULT_TEXTS) {
    if (repo.seedDefault(t, now) === 'created') created++
    else updated++
  }
  return { created, updated }
}

/**
 * Секрет команд /demo и /reset. Генерируется один раз при первом засеве: писать
 * его в репозиторий нельзя, а требовать от владельца придумать — лишний шаг на
 * установке, про который он забудет и оставит «1234».
 */
export function randomSecret(len = 8): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789' // без похожих символов: 0/o, 1/l/i
  const bytes = createHash('sha256').update(String(Math.random()) + String(Date.now())).digest()
  let out = ''
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length]
  return out
}

export function seedSettings(store: SettingsStore, now: number, overrides: Record<string, string> = {}): number {
  let created = 0
  for (const s of DEFAULT_SETTINGS) {
    const value = overrides[s.key] ?? (s.key === 'demo_secret' && s.value === '' ? randomSecret() : s.value)
    if (store.seedDefault(s.key, value, now)) created++
  }
  return created
}

// ─────────────────────────────── практики ───────────────────────────────

/**
 * Как в сценариях могут назвать категорию. Канон — `calm`; `stress` и `anxiety`
 * оставлены синонимами: так назывался этот же набор в ранних документах, и файл,
 * написанный по ним, не должен падать на синке.
 */
const CATEGORY_ALIASES: Record<string, Category> = {
  sleep: 'sleep',
  calm: 'calm',
  stress: 'calm',
  anxiety: 'calm',
  day: 'day',
}

const CATEGORY_RANK: Record<Category, number> = { sleep: 1, calm: 2, day: 3 }

export type PracticeFile = {
  slug: string
  title: string
  category: Category
  line1: string
  line2: string
  scriptHash: string
  path: string
}

export type ManifestEntry = { duration?: number; bytes?: number; hash?: string }

/**
 * Разбор frontmatter сценария. Полноценный YAML-парсер сюда не нужен и вреден:
 * формат этих девяти файлов фиксирован (§8.1), а лишняя зависимость ради пяти
 * полей — лишняя поверхность отказа.
 */
export function parsePracticeFile(path: string): PracticeFile | { error: string } {
  const raw = readFileSync(path, 'utf8')
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(raw)
  if (!m) return { error: `${basename(path)}: нет frontmatter между --- и ---` }

  const head = m[1]
  const field = (name: string): string | null => {
    const r = new RegExp(`^${name}:[ \\t]*(.*)$`, 'm').exec(head)
    return r ? r[1].trim() : null
  }

  const slug = field('slug') ?? basename(path, '.md')
  const title = field('title')
  const categoryRaw = field('category')
  if (!title) return { error: `${basename(path)}: нет поля title` }
  if (!categoryRaw) return { error: `${basename(path)}: нет поля category` }
  const category = CATEGORY_ALIASES[categoryRaw]
  if (!category) return { error: `${basename(path)}: неизвестная категория «${categoryRaw}»` }

  // intro — список из двух строк; они становятся line1/line2 под аудио.
  const introBlock = /^intro:[ \t]*\r?\n((?:[ \t]+-[ \t]*.*\r?\n?)+)/m.exec(head)
  const intro = introBlock
    ? introBlock[1]
        .split(/\r?\n/)
        .map((l) => l.replace(/^[ \t]*-[ \t]*/, '').trim())
        .filter((l) => l !== '')
    : []

  return {
    slug,
    title,
    category,
    line1: intro[0] ?? '',
    line2: intro[1] ?? '',
    scriptHash: createHash('sha256').update(raw).digest('hex'),
    path,
  }
}

export type SyncResult = {
  added: number
  updated: number
  withAudio: number
  missingAudio: string[]
  errors: string[]
}

export type SyncOptions = {
  /** Корень контента; внутри ожидаются practices/ и audio/. */
  contentDir: string
  /** Корень, относительно которого пишется audio_path (обычно корень репозитория). */
  projectRoot: string
  now: number
}

/**
 * Синк content/practices/*.md + content/audio/manifest.json → таблица practices.
 * Длительность берётся из манифеста (он же источник для генератора), хеш mp3 —
 * из самого файла: сменился файл, значит tg_file_id в Telegram больше не тот.
 */
export function syncPracticesFromDisk(repo: PracticesRepo, o: SyncOptions): SyncResult {
  const result: SyncResult = { added: 0, updated: 0, withAudio: 0, missingAudio: [], errors: [] }
  const practicesDir = join(o.contentDir, 'practices')
  const audioDir = join(o.contentDir, 'audio')
  if (!existsSync(practicesDir)) {
    result.errors.push(`Нет каталога сценариев: ${practicesDir}`)
    return result
  }

  let manifest: Record<string, ManifestEntry> = {}
  const manifestPath = join(audioDir, 'manifest.json')
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, ManifestEntry>
    } catch (err) {
      result.errors.push(`manifest.json не читается: ${(err as Error).message}`)
    }
  }

  const files = readdirSync(practicesDir).filter((f) => f.endsWith('.md')).sort()
  const parsed: PracticeFile[] = []
  for (const f of files) {
    const p = parsePracticeFile(join(practicesDir, f))
    if ('error' in p) result.errors.push(p.error)
    else parsed.push(p)
  }

  // Порядок по умолчанию: сначала сон, потом тревога, потом день — тот же порядок,
  // в котором категории стоят в кнопках вечером. Ставится только при создании.
  const positions = new Map<string, number>()
  for (const rank of [1, 2, 3]) {
    const group = parsed.filter((p) => CATEGORY_RANK[p.category] === rank)
    group.forEach((p, i) => positions.set(p.slug, rank * 100 + i * 10))
  }

  for (const p of parsed) {
    const created = repo.upsertFromFile({
      slug: p.slug,
      category: p.category,
      title: p.title,
      line1: p.line1,
      line2: p.line2,
      scriptHash: p.scriptHash,
      now: o.now,
      sortOrder: positions.get(p.slug) ?? 100,
    })
    if (created) result.added++
    else result.updated++

    const row = repo.bySlug(p.slug)
    if (!row) continue

    const audioPath = join(audioDir, `${p.slug}.mp3`)
    if (!existsSync(audioPath)) {
      result.missingAudio.push(p.slug)
      continue
    }
    const bytes = readFileSync(audioPath)
    const durationFromManifest = manifest[p.slug]?.duration
    repo.setAudio(row.id, {
      path: relative(o.projectRoot, audioPath),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: statSync(audioPath).size,
      durationSec: Math.round(durationFromManifest ?? 0),
    })
    result.withAudio++
  }

  return result
}
