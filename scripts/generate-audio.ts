/**
 * Генерация аудиопрактик из сценариев.
 *
 *   npx tsx scripts/generate-audio.ts                 # всё, чего ещё нет или что изменилось
 *   npx tsx scripts/generate-audio.ts --only sleep-landing
 *   npx tsx scripts/generate-audio.ts --force         # перегенерировать всё
 *   npx tsx scripts/generate-audio.ts --dry-run       # только посчитать знаки и куски
 *   npx tsx scripts/generate-audio.ts --voice ru-RU-SvetlanaNeural --style ""
 *
 * Идемпотентность: в content/audio/manifest.json лежит хеш сценария и параметров
 * голоса. Совпал — файл не трогаем. Квота Azure F0 (≈500 000 знаков в месяц) при
 * 9 практиках по ~4 000 знаков позволяет перегенерировать серию десяток раз.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { honorsSsmlBreaks, leftoverMarkup, parseScript, planRequests, PROFILES, profileFor, synthesize, type VoiceParams } from './tts.ts'

const ROOT = resolve(import.meta.dirname, '..')
const SCRIPTS_DIR = join(ROOT, 'content', 'practices')
const AUDIO_DIR = join(ROOT, 'content', 'audio')
const MANIFEST = join(AUDIO_DIR, 'manifest.json')
const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg'
const FFPROBE = process.env.FFPROBE_BIN || 'ffprobe'

const DEFAULT_VOICE = process.env.TTS_VOICE || 'ru-RU-Masha:MAI-Voice-2'
const DEFAULT_STYLE = process.env.TTS_STYLE ?? 'caringempathy'

type Args = { only?: string; force: boolean; dryRun: boolean; voice: string; style: string }

function parseArgs(argv: string[]): Args {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? argv[i + 1] : undefined
  }
  return {
    only: get('only'),
    force: argv.includes('--force'),
    dryRun: argv.includes('--dry-run'),
    voice: get('voice') || DEFAULT_VOICE,
    style: get('style') ?? DEFAULT_STYLE,
  }
}

export type Practice = {
  slug: string
  title: string
  category: string
  intro: string[]
  body: string
  file: string
}

/** Разбор markdown-сценария: YAML-подобная шапка между --- и тело после неё. */
export function readPractice(file: string): Practice {
  const raw = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!m) throw new Error(`${file}: нет frontmatter между --- и ---`)
  const [, head, body] = m
  const field = (name: string) => head.match(new RegExp(`^${name}:\\s*(.*)$`, 'm'))?.[1]?.trim().replace(/^["']|["']$/g, '')

  // intro может быть строкой, YAML-списком или многострочным блоком |
  const intro: string[] = []
  const listMatch = head.match(/^intro:\s*\n((?:\s*-\s*.*\n?)+)/m)
  const blockMatch = head.match(/^intro:\s*[|>]-?\s*\n((?:[ \t]+.*\n?)+)/m)
  if (listMatch) {
    for (const line of listMatch[1].split('\n')) {
      const t = line.replace(/^\s*-\s*/, '').trim().replace(/^["']|["']$/g, '')
      if (t) intro.push(t)
    }
  } else if (blockMatch) {
    for (const line of blockMatch[1].split('\n')) {
      const t = line.trim()
      if (t) intro.push(t)
    }
  } else {
    const single = field('intro')
    if (single) intro.push(single)
  }

  const slug = field('slug') || file.split('/').pop()!.replace(/\.md$/, '')
  return { slug, title: field('title') || slug, category: field('category') || '', intro, body: body.trim(), file }
}

function ffprobeDuration(path: string): number {
  const out = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], {
    encoding: 'utf8',
  })
  return Number(out.trim())
}

function silenceWav(path: string, seconds: number) {
  execFileSync(FFMPEG, [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono',
    '-t', seconds.toFixed(3),
    '-c:a', 'pcm_s16le',
    path,
  ])
}

/**
 * Склейка кусков и тишины + постобработка.
 *
 * Порядок фильтров важен: сначала тишина в начале (adelay), потом мягкий срез
 * верха (lowpass — убирает «цифровой» звон синтеза), потом нормализация громкости,
 * потом затухание в конце и тишина в хвосте. loudnorm ставим после lowpass, чтобы
 * он считал громкость уже обработанного сигнала.
 */
function postprocess(joinedWav: string, outMp3: string, profile: (typeof PROFILES)[string]) {
  const duration = ffprobeDuration(joinedWav)
  const headSec = 1.5
  const fadeStart = Math.max(0, duration + headSec - profile.fadeOutSec)
  const filters = [
    `adelay=${Math.round(headSec * 1000)}`,
    'lowpass=f=12000',
    `loudnorm=I=${profile.lufs}:TP=-2.0:LRA=11`,
    `afade=t=out:st=${fadeStart.toFixed(3)}:d=${profile.fadeOutSec}`,
    `apad=pad_dur=${profile.tailSec}`,
  ].join(',')
  execFileSync(FFMPEG, [
    '-v', 'error', '-y',
    '-i', joinedWav,
    '-af', filters,
    '-ar', '44100', '-ac', '1',
    '-codec:a', 'libmp3lame', '-b:a', '128k',
    outMp3,
  ])
}

type Plan = ReturnType<typeof planRequests>

async function renderPractice(p: Practice, v: VoiceParams, plan: Plan, outMp3: string) {
  const work = mkdtempSync(join(tmpdir(), `sn-${p.slug}-`))
  try {
    const parts: string[] = []
    let spoken = 0
    const total = plan.filter((r) => r.kind === 'speak').length
    for (const [i, req] of plan.entries()) {
      const path = join(work, `${String(i).padStart(3, '0')}.wav`)
      if (req.kind === 'silence') {
        silenceWav(path, req.seconds)
      } else {
        spoken++
        process.stdout.write(`   кусок ${spoken}/${total} (${req.chars} зн.)   \r`)
        writeFileSync(path, await synthesize(req.parts, v))
      }
      parts.push(path)
    }
    // concat-демультиплексор склеивает PCM-WAV без перекодирования и без щелчков.
    const list = join(work, 'list.txt')
    writeFileSync(list, parts.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'))
    const joined = join(work, 'joined.wav')
    execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined])
    postprocess(joined, outMp3, PROFILES[profileFor(p.slug, p.category)])
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

type ManifestEntry = { slug: string; title: string; category: string; intro: string[]; duration: number; voice: string; style: string; hash: string; chars: number; generatedAt: string }

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!existsSync(SCRIPTS_DIR)) throw new Error(`Нет папки со сценариями: ${SCRIPTS_DIR}`)
  mkdirSync(AUDIO_DIR, { recursive: true })

  const manifest: Record<string, ManifestEntry> = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : {}

  const files = readdirSync(SCRIPTS_DIR).filter((f) => f.endsWith('.md')).sort()
  if (!files.length) {
    console.log('Сценариев пока нет — ждём content/practices/*.md')
    return
  }

  let totalChars = 0
  let generated = 0
  for (const f of files) {
    const p = readPractice(join(SCRIPTS_DIR, f))
    if (args.only && p.slug !== args.only) continue

    const prof = profileFor(p.slug, p.category)
    const voice: VoiceParams = { voice: args.voice, style: args.style || undefined, rate: PROFILES[prof].rate }
    leftoverMarkup.length = 0
    const segments = parseScript(p.body)
    if (leftoverMarkup.length) {
      // Разметка, которую не понял парсер, вырезана — но сценарий надо починить,
      // иначе задуманной паузы в практике не будет.
      console.warn(`   ⚠ вырезана нераспознанная разметка: ${[...new Set(leftoverMarkup)].join(' ')}`)
    }
    const plan = planRequests(segments, voice.voice)
    const chars = plan.reduce((n, r) => (r.kind === 'speak' ? n + r.chars : n), 0)
    const chunks = plan.filter((r) => r.kind === 'speak').length
    const pauseSec = segments.reduce((n, s) => (s.kind === 'pause' ? n + s.seconds : n), 0)
    totalChars += chars

    const hash = createHash('sha256')
      .update(JSON.stringify({ body: p.body, voice, inlineBreaks: honorsSsmlBreaks(voice.voice) }))
      .digest('hex')
      .slice(0, 16)
    const outMp3 = join(AUDIO_DIR, `${p.slug}.mp3`)
    const fresh = manifest[p.slug]?.hash === hash && existsSync(outMp3)

    console.log(
      `${p.slug.padEnd(16)} ${String(chars).padStart(5)} зн. · ${String(chunks).padStart(3)} запросов · пауз ${Math.round(pauseSec)}с · профиль ${prof}` +
        (fresh && !args.force ? ' · уже готово' : ''),
    )
    if (args.dryRun || (fresh && !args.force)) continue

    await renderPractice(p, voice, plan, outMp3)
    const duration = ffprobeDuration(outMp3)
    manifest[p.slug] = {
      slug: p.slug, title: p.title, category: p.category, intro: p.intro,
      duration: Math.round(duration), voice: voice.voice, style: voice.style || '',
      hash, chars, generatedAt: new Date().toISOString(),
    }
    generated++
    console.log(`   → ${p.slug}.mp3, ${Math.floor(duration / 60)}:${String(Math.round(duration % 60)).padStart(2, '0')}`)
    writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n')
  }

  console.log(`\nИтого знаков к синтезу: ${totalChars}. Сгенерировано файлов: ${generated}.`)
  if (!args.dryRun) console.log(`Манифест: ${MANIFEST}`)
}

// Файл одновременно и CLI, и модуль (readPractice импортирует voice-samples.ts),
// поэтому main() запускается только когда файл вызван напрямую.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
