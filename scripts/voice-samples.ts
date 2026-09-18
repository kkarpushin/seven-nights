/**
 * Образцы голосов для выбора владельцем.
 *
 *   npx tsx scripts/voice-samples.ts
 *
 * Берёт один и тот же кусок настоящего сценария и озвучивает его всеми кандидатами,
 * складывает mp3 в content/audio/samples/ и собирает страницу сравнения samples.html.
 * Слушать: http://100.91.124.2:3701/samples/ (превью-сервер) или http://100.91.124.2:3700/samples (сервис отдаёт эту папку) или открыть файл локально.
 *
 * Квота Azure F0 ≈ 500 000 знаков в месяц, один прогон стоит ~2 500 — можно гонять
 * сколько угодно.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseScript, synthesize, type VoiceParams } from './tts.ts'
import { readPractice } from './generate-audio.ts'

const ROOT = resolve(import.meta.dirname, '..')
const OUT = join(ROOT, 'content', 'audio', 'samples')
const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg'

/** Кандидаты из docs/tts-decision.md. */
const CANDIDATES: Array<{ id: string; label: string; note: string; v: VoiceParams }> = [
  {
    id: 'masha-hd-caring',
    label: 'Маша (HD), стиль «забота»',
    note: 'Генеративный голос нового поколения: живее и теплее всех. Но он сам разыгрывает текст — на каждую точку ставит свою паузу, поверх пауз автора. Практика от этого длиннее примерно вдвое, и ритмом распоряжается модель, а не сценарий.',
    v: { voice: 'ru-RU-Masha:MAI-Voice-2', style: 'caringempathy', rate: '-15%' },
  },
  {
    id: 'masha-hd-reflective',
    label: 'Маша (HD), стиль «размышление»',
    note: 'Тот же генеративный голос, более отстранённая подача, и те же собственные паузы. Вариант, если «забота» покажется слишком мягкой.',
    v: { voice: 'ru-RU-Masha:MAI-Voice-2', style: 'reflective', rate: '-15%' },
  },
  {
    id: 'svetlana',
    label: 'Светлана',
    note: 'ГОЛОС ПО УМОЛЧАНИЮ. Читает ровно так, как написано: паузы — авторские, длительность предсказуемая. Спокойный и ровный, но менее «живой», чем генеративный.',
    v: { voice: 'ru-RU-SvetlanaNeural', rate: '-15%' },
  },
  {
    id: 'dariya',
    label: 'Дарья',
    note: 'Мягче Светланы, чуть выше тембр. Паузы тоже держит точно.',
    v: { voice: 'ru-RU-DariyaNeural', rate: '-15%' },
  },
  {
    id: 'masha-flash-caring',
    label: 'Маша (Flash), стиль «забота»',
    note: 'Быстрая версия генеративного голоса. Паузы держит частично — среднее между двумя подходами.',
    v: { voice: 'ru-RU-Masha:MAI-Voice-2-Flash', style: 'caringempathy', rate: '-15%' },
  },
]

/** Запасной текст, если сценариев ещё нет. */
const FALLBACK = [
  'Я рядом. Сейчас можно ничего не делать.',
  '[[pause:3]]',
  'Просто заметь, как тело лежит — где оно касается кровати, где тяжелее, где легче.',
  '[[pause:4]]',
  'Пусть плечи опустятся. Пусть челюсть станет мягче.',
  '[[pause:3]]',
  'Дыши как дышится. Я буду говорить тихо.',
].join('\n\n')

/** Берём первые ~600 знаков настоящего сценария сна — чтобы слышать реальную интонацию, а не рекламную фразу. */
function sampleText(): { text: string; source: string } {
  const dir = join(ROOT, 'content', 'practices')
  if (existsSync(dir)) {
    const files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort()
    const sleep = files.find((f) => f.startsWith('sleep')) || files[0]
    if (sleep) {
      const p = readPractice(join(dir, sleep))
      const segs = parseScript(p.body)
      const picked: string[] = []
      let chars = 0
      for (const s of segs) {
        if (s.kind === 'pause') picked.push(`[[pause:${Math.min(s.seconds, 4)}]]`)
        else {
          if (chars + s.text.length > 700 && chars > 0) break
          picked.push(s.text)
          chars += s.text.length
        }
      }
      return { text: picked.join('\n\n'), source: `${p.slug} — «${p.title}»` }
    }
  }
  return { text: FALLBACK, source: 'запасной текст (сценариев ещё нет)' }
}

async function render(id: string, v: VoiceParams, text: string) {
  const segs = parseScript(text)
  const parts: Buffer[] = []
  for (const s of segs) {
    if (s.kind === 'pause') {
      // Тишина как сырой PCM той же частоты — склеиваем буферы напрямую, без временных файлов.
      parts.push(Buffer.alloc(Math.round(48000 * 2 * s.seconds)))
    } else {
      const wav = await synthesize(s.text, v)
      parts.push(wav.subarray(44))
    }
  }
  const pcm = Buffer.concat(parts)
  const raw = join(OUT, `${id}.raw`)
  writeFileSync(raw, pcm)
  execFileSync(FFMPEG, [
    '-v', 'error', '-y',
    '-f', 's16le', '-ar', '48000', '-ac', '1', '-i', raw,
    '-af', 'lowpass=f=12000,loudnorm=I=-19:TP=-2.0:LRA=11',
    '-ar', '44100', '-ac', '1', '-codec:a', 'libmp3lame', '-b:a', '128k',
    join(OUT, `${id}.mp3`),
  ])
  execFileSync('rm', ['-f', raw])
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const { text, source } = sampleText()
  console.log(`Текст образца: ${source}, ${text.length} знаков\n`)

  const force = process.argv.includes('--force')
  for (const c of CANDIDATES) {
    process.stdout.write(`${c.id.padEnd(22)} … `)
    try {
      // Страницу пересобираем всегда, а звук — только если попросили: описания
      // голосов меняются чаще, чем сами записи.
      if (!force && existsSync(join(OUT, `${c.id}.mp3`))) console.log('уже есть')
      else { await render(c.id, c.v, text); console.log('готово') }
    } catch (e) {
      console.log(`ошибка: ${e instanceof Error ? e.message : e}`)
    }
  }

  const rows = CANDIDATES.filter((c) => existsSync(join(OUT, `${c.id}.mp3`)))
    .map(
      (c) => `    <li>
      <h2>${c.label}</h2>
      <p>${c.note}</p>
      <audio controls preload="none" src="${c.id}.mp3"></audio>
      <code>${c.v.voice}${c.v.style ? ` · ${c.v.style}` : ''}</code>
    </li>`,
    )
    .join('\n')

  writeFileSync(
    join(OUT, 'index.html'),
    `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Голоса для «Семи ночей»</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 32px 20px 64px; background: #10131c; color: #e8e6f0;
         font: 16px/1.6 ui-sans-serif, system-ui, "Noto Sans", sans-serif; }
  main { max-width: 640px; margin: 0 auto; }
  h1 { font-size: 24px; font-weight: 600; margin: 0 0 8px; }
  .lead { color: #9a98ad; margin: 0 0 32px; }
  ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 20px; }
  li { background: #171b27; border: 1px solid #262c3d; border-radius: 16px; padding: 20px; }
  h2 { font-size: 18px; font-weight: 600; margin: 0 0 6px; }
  li p { color: #9a98ad; margin: 0 0 14px; font-size: 15px; }
  audio { width: 100%; }
  code { display: block; margin-top: 10px; color: #6f6c85; font-size: 13px; }
</style>
</head>
<body>
<main>
  <h1>Какой голос у «Семи ночей»</h1>
  <p class="lead">Один и тот же кусок практики, пять голосов. Выбери один — его слышит человек все семь вечеров.<br>
  Обрати внимание на длину записей: генеративные голоса на том же тексте звучат заметно дольше, потому что расставляют свои паузы поверх авторских.<br>
  Текст образца: ${source}. Смена голоса после выбора занимает одну строку и одну перегенерацию.</p>
  <ul>
${rows}
  </ul>
</main>
</body>
</html>
`,
  )
  console.log(`\nСтраница сравнения: ${join(OUT, 'index.html')}`)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
