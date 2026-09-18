/**
 * Синк content/practices/*.md + content/audio/manifest.json → таблица practices.
 * §5.9 архитектуры, §8.3 про идемпотентность.
 *
 * Запускается при каждом старте процесса, поэтому обязан быть дёшев и молчалив,
 * когда ничего не поменялось. Два правила, из которых всё остальное следует:
 *
 * 1. Правки владельца старше файлов. Как только практику тронули в админке
 *    (origin='admin'), файл на неё больше не влияет — ни текст, ни аудио.
 *    Иначе первый же рестарт молча вернул бы её к тому, что лежит в репозитории.
 *
 * 2. Сверяем по содержимому, а не по времени. `script_hash` — sha256 всего .md,
 *    `audio_sha256` — sha256 самого mp3. Совпали — не пишем НИЧЕГО, в том числе
 *    не двигаем updated_at: админка показывает «изменено» по updated_at, и
 *    ежестартовое «обновлено 9» сделало бы этот столбец бесполезным.
 *    mtime для этого не годится: git checkout ставит свежее время файлам,
 *    содержимое которых не менялось, и синк переписывал бы всё после каждого pull.
 *
 * Хешировать девять mp3 (~80 МБ) на старте стоит ~150 мс один раз за запуск —
 * дешевле, чем гадать по размеру файла и однажды не заметить перегенерацию.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { Ctx } from '../ctx.ts'
import { PROJECT_ROOT } from '../env.ts'
import type { Logger } from '../log.ts'
import type { PracticesRepo } from '../db/practices.ts'
import { parsePracticeFile, type ManifestEntry, type PracticeFile } from '../db/seed.ts'

export type SyncReport = {
  /** Создано новых строк. */
  added: number
  /** Обновлено: сменился сценарий или аудио. */
  updated: number
  /** Пропущено: всё совпало либо строка принадлежит админке. */
  skipped: number
  /** Сколько практик получили или подтвердили аудио. */
  withAudio: number
  /** Слаги без mp3 — им нечего отправить, пока не прогнали генерацию. */
  missingAudio: string[]
  /** Строки origin='file' в базе, у которых больше нет сценария на диске. */
  orphans: string[]
  errors: string[]
}

export type SyncOptions = {
  contentDir: string
  /** Корень, относительно которого хранится audio_path. */
  projectRoot?: string
  now: number
  log?: Logger
}

/** Одна практика считается ровно один раз: создана, обновлена или пропущена. */
function tally(report: SyncReport, created: boolean, touched: boolean): void {
  if (created) report.added++
  else if (touched) report.updated++
  else report.skipped++
}

function emptyReport(): SyncReport {
  return { added: 0, updated: 0, skipped: 0, withAudio: 0, missingAudio: [], orphans: [], errors: [] }
}

function readManifest(path: string, report: SyncReport): Record<string, ManifestEntry> {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, ManifestEntry>
  } catch (err) {
    report.errors.push(`manifest.json не читается: ${(err as Error).message}`)
    return {}
  }
}

/** Ядро синка без Ctx — чтобы его можно было прогнать на временном каталоге в тесте. */
export function syncPractices(repo: PracticesRepo, o: SyncOptions): SyncReport {
  const report = emptyReport()
  const projectRoot = o.projectRoot ?? PROJECT_ROOT
  const practicesDir = join(o.contentDir, 'practices')
  const audioDir = join(o.contentDir, 'audio')

  if (!existsSync(practicesDir)) {
    report.errors.push(`Нет каталога сценариев: ${practicesDir}`)
    return report
  }

  const manifest = readManifest(join(audioDir, 'manifest.json'), report)

  const parsed: PracticeFile[] = []
  for (const f of readdirSync(practicesDir).filter((n) => n.endsWith('.md')).sort()) {
    const p = parsePracticeFile(join(practicesDir, f))
    if ('error' in p) report.errors.push(p.error)
    else parsed.push(p)
  }

  for (const p of parsed) {
    const existing = repo.bySlug(p.slug)

    // Практику забрала админка — файл ей больше не указ, включая аудио.
    if (existing !== undefined && existing.origin === 'admin') {
      report.skipped++
      continue
    }

    let created = false
    let touched = false
    if (existing === undefined) {
      repo.upsertFromFile({
        slug: p.slug,
        category: p.category,
        title: p.title,
        line1: p.line1,
        line2: p.line2,
        scriptHash: p.scriptHash,
        now: o.now,
        sortOrder: sortOrderFor(p, parsed),
      })
      created = true
    } else if (existing.script_hash !== p.scriptHash) {
      repo.upsertFromFile({
        slug: p.slug,
        category: p.category,
        title: p.title,
        line1: p.line1,
        line2: p.line2,
        scriptHash: p.scriptHash,
        now: o.now,
      })
      touched = true
    }

    const row = repo.bySlug(p.slug)
    if (row === undefined) {
      report.errors.push(`${p.slug}: строка не создалась`)
      continue
    }

    const audioPath = join(audioDir, `${p.slug}.mp3`)
    if (!existsSync(audioPath)) {
      // Файл мог пропасть (в .gitignore он есть, в репозитории — нет), а tg_file_id
      // в базе при этом рабочий. Обнулять аудио здесь значило бы сломать отправку
      // там, где она работает. Просто сообщаем.
      report.missingAudio.push(p.slug)
      tally(report, created, touched)
      continue
    }

    const bytes = readFileSync(audioPath)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const durationSec = Math.round(manifest[p.slug]?.duration ?? 0)
    const rel = relative(projectRoot, audioPath)
    const same =
      row.audio_sha256 === sha256 &&
      row.audio_path === rel &&
      row.audio_bytes === bytes.length &&
      row.duration_sec === durationSec

    if (!same) {
      // setAudio сам сбросит tg_file_id при смене sha256 — Telegram по старому
      // идентификатору продолжал бы отдавать прежнюю запись.
      repo.setAudio(row.id, { path: rel, sha256, bytes: bytes.length, durationSec })
      touched = true
    }
    report.withAudio++
    tally(report, created, touched)
  }

  const onDisk = new Set(parsed.map((p) => p.slug))
  for (const row of repo.listAll()) {
    if (row.origin === 'file' && !onDisk.has(row.slug)) report.orphans.push(row.slug)
  }

  // Осиротевшие не выключаем сами: практика может быть в settings.sleep_route и
  // уже звучать у людей, а сценарий — просто временно не выгружен на эту машину.
  if (report.orphans.length > 0) {
    o.log?.warn('Практики без сценария на диске', { slugs: report.orphans })
  }
  for (const e of report.errors) o.log?.error('Синк практик', { error: e })

  return report
}

/**
 * Порядок по умолчанию — сон, тревога, день: тот же, в котором категории стоят
 * в кнопках вечером. Ставится только при создании строки; дальше порядок живёт
 * в админке, и синк его не трогает.
 */
const CATEGORY_RANK = { sleep: 1, calm: 2, day: 3 } as const

function sortOrderFor(p: PracticeFile, all: readonly PracticeFile[]): number {
  const group = all.filter((x) => x.category === p.category)
  const i = group.findIndex((x) => x.slug === p.slug)
  return CATEGORY_RANK[p.category] * 100 + Math.max(0, i) * 10
}

/** То, что зовёт src/index.ts на старте. §5.9. */
export function syncPracticesFromFiles(ctx: Ctx): SyncReport {
  const report = syncPractices(ctx.repo.practices, {
    contentDir: ctx.cfg.contentDir,
    projectRoot: PROJECT_ROOT,
    now: ctx.clock.now(),
    log: ctx.log,
  })
  if (report.added > 0 || report.updated > 0) {
    ctx.log.info('Практики синхронизированы', {
      added: report.added,
      updated: report.updated,
      skipped: report.skipped,
      missing_audio: report.missingAudio.length,
    })
  }
  return report
}
