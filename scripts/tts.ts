/**
 * Синтез речи для практик «Семи ночей».
 *
 * Провайдер по умолчанию — Azure AI Speech (нативные русские голоса, бесплатный
 * тариф F0 ≈ 500 000 знаков в месяц). Почему не ElevenLabs — см. docs/tts-decision.md:
 * бесплатные аккаунты не могут синтезировать библиотечными голосами через API.
 *
 * Паузы: короткие (< 2,5 с) остаются тегом <break/> внутри запроса — но только у
 * голосов, которые теги уважают. Длинные, а у генеративного MAI-Voice-2 вообще все,
 * делаются СКЛЕЙКОЙ: сценарий режется на куски, каждый синтезируется отдельно, между
 * ними ffmpeg вставляет цифровую тишину точной длины. Так паузы не зависят от голоса
 * и не упираются в потолок 5 с, а интонация фразы не рвётся там, где резать не нужно.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type Segment = { kind: 'text'; text: string } | { kind: 'pause'; seconds: number }

/** Параметры голоса. Меняются из .env: TTS_VOICE / TTS_STYLE. */
export type VoiceParams = {
  voice: string
  style?: string
  /** Замедление речи, как в SSML prosody: "-15%". */
  rate: string
}

/** Профили подачи по категориям практик — из docs/tts-decision.md, п.2 и п.4. */
export const PROFILES: Record<string, { rate: string; lufs: number; fadeOutSec: number; tailSec: number }> = {
  sleep: { rate: '-15%', lufs: -19, fadeOutSec: 8, tailSec: 5 },
  calm: { rate: '-10%', lufs: -17, fadeOutSec: 3, tailSec: 2 },
  day: { rate: '-5%', lufs: -17, fadeOutSec: 2, tailSec: 2 },
}

/** Категорию берём из префикса slug (sleep-landing → sleep), с запасным вариантом по тексту категории. */
export function profileFor(slug: string, category = ''): keyof typeof PROFILES {
  const prefix = slug.split('-')[0]
  if (prefix in PROFILES) return prefix as keyof typeof PROFILES
  const c = category.toLowerCase()
  if (c.includes('сон') || c.includes('расслаб')) return 'sleep'
  if (c.includes('тревог') || c.includes('стресс')) return 'calm'
  return 'day'
}

/**
 * Режет тело сценария на озвучиваемые куски и паузы.
 *
 * Понимает оба синтаксиса, которыми написаны сценарии:
 *   [[pause:8]]                     — маркер на отдельной строке, секунды
 *   <break time="2.0s" />           — тег в стиле ElevenLabs
 *   <break time="2000ms" />         — он же в миллисекундах
 * Пустая строка между абзацами тоже даёт небольшую паузу — иначе синтез склеивает
 * абзацы в сплошной поток, а медитация так не читается.
 */
export function parseScript(body: string, paragraphPauseSec = 0.8): Segment[] {
  // Единица необязательна у обоих синтаксисов: [[pause:8]], [[pause:600ms]],
  // <break time="2.0s"/>, <break time="2000ms"/>. Без единицы считаем секунды.
  const PAUSE_RE = /\[\[\s*pause:\s*([\d.]+)\s*(ms|s)?\s*\]\]|<break\s+time=["']?([\d.]+)\s*(ms|s)?["']?\s*\/?>/gi
  const segments: Segment[] = []
  let cursor = 0

  const pushText = (raw: string) => {
    // Внутри куска пустая строка = маленькая пауза: режем и её.
    const paragraphs = raw.split(/\n\s*\n/).map((p) => normalize(p)).filter(Boolean)
    paragraphs.forEach((p, i) => {
      if (i > 0 && paragraphPauseSec > 0) segments.push({ kind: 'pause', seconds: paragraphPauseSec })
      segments.push({ kind: 'text', text: p })
    })
  }

  for (let m = PAUSE_RE.exec(body); m; m = PAUSE_RE.exec(body)) {
    pushText(body.slice(cursor, m.index))
    const [value, unit] = m[1] !== undefined ? [m[1], m[2]] : [m[3], m[4]]
    const seconds = unit?.toLowerCase() === 'ms' ? Number(value) / 1000 : Number(value)
    if (Number.isFinite(seconds) && seconds > 0) segments.push({ kind: 'pause', seconds })
    cursor = m.index + m[0].length
  }
  pushText(body.slice(cursor))

  // Схлопываем подряд идущие паузы и убираем паузы по краям — тишину в начале и
  // конце файла добавляет постобработка, здесь она только мешает считать длительность.
  const merged: Segment[] = []
  for (const s of segments) {
    const last = merged[merged.length - 1]
    if (s.kind === 'pause' && last && last.kind === 'pause') {
      last.seconds = Math.max(last.seconds, s.seconds)
      continue
    }
    merged.push({ ...s })
  }
  while (merged.length && merged[0].kind === 'pause') merged.shift()
  while (merged.length && merged[merged.length - 1].kind === 'pause') merged.pop()
  return merged
}

/**
 * Приводит кусок к одной строке: синтезу не нужны переносы, а лишние пробелы он
 * читает как заминки.
 *
 * Здесь же страховка: любая разметка, которую не разобрал парсер пауз, вырезается
 * и попадает в `leftoverMarkup`. Без неё опечатка вроде `[[pause:600мс]]` была бы
 * ПРОЧИТАНА ВСЛУХ посреди практики — ровно так и нашлось на первом же сценарии.
 */
const MARKUP_RE = /\[\[[^\]]*\]\]|<[^>]+>/g

export const leftoverMarkup: string[] = []

function normalize(s: string): string {
  const cleaned = s.replace(MARKUP_RE, (found) => {
    leftoverMarkup.push(found)
    return ' '
  })
  return cleaned
    .replace(/\r/g, '')
    .replace(/[ \t]*\n[ \t]*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** Считает знаки, которые уйдут в биллинг провайдера (только озвучиваемый текст). */
export function billableChars(segments: Segment[]): number {
  return segments.reduce((n, s) => (s.kind === 'text' ? n + s.text.length : n), 0)
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Уважает ли голос теги `<break/>` и `prosody rate`.
 *
 * Замерено 2026-09-18 (docs/tts-decision.md): классические Neural-голоса держат
 * паузы с точностью до долей секунды, а генеративный MAI-Voice-2 их игнорирует
 * вместе с замедлением — там паузы приходится делать только склейкой.
 */
export function honorsSsmlBreaks(voice: string): boolean {
  return !voice.includes('MAI-Voice-2')
}

/**
 * Кусок для одного запроса синтеза: текст вперемешку с короткими паузами.
 * Длинные паузы сюда не попадают — они становятся границей между кусками.
 */
export type SsmlPart = { text: string } | { breakSec: number }

export function buildSsml(parts: SsmlPart[] | string, v: VoiceParams): string {
  const list: SsmlPart[] = typeof parts === 'string' ? [{ text: parts }] : parts
  const body = list
    .map((p) =>
      'text' in p
        ? escapeXml(p.text)
        : // Azure принимает максимум 5 секунд на тег; больше — только склейкой.
          `<break time="${Math.round(Math.min(p.breakSec, 5) * 1000)}ms"/>`,
    )
    .join('')
  const inner = `<prosody rate="${v.rate}">${body}</prosody>`
  const styled = v.style ? `<mstts:express-as style="${v.style}">${inner}</mstts:express-as>` : inner
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" ` +
    `xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="ru-RU">` +
    `<voice name="${v.voice}">${styled}</voice></speak>`
  )
}

/**
 * Группирует сегменты в запросы синтеза.
 *
 * Голос, уважающий SSML: короткие паузы (< порога) остаются внутри куска тегом
 * `<break/>` — так интонация фразы не рвётся, а число запросов падает с полусотни
 * до единиц. Длинные паузы всё равно режут, потому что тег ограничен пятью секундами.
 *
 * Голос, игнорирующий SSML: режем по каждой паузе — иначе их не будет вовсе.
 */
export function planRequests(
  segments: Segment[],
  voice: string,
  inlineThresholdSec = 2.5,
): Array<{ kind: 'speak'; parts: SsmlPart[]; chars: number } | { kind: 'silence'; seconds: number }> {
  const inlineOk = honorsSsmlBreaks(voice)
  const out: Array<{ kind: 'speak'; parts: SsmlPart[]; chars: number } | { kind: 'silence'; seconds: number }> = []
  let current: SsmlPart[] = []

  const flush = () => {
    // Висящая пауза в хвосте куска ничего не даёт — режем её в отдельную тишину.
    while (current.length && !('text' in current[current.length - 1])) current.pop()
    if (!current.length) return
    const chars = current.reduce((n, p) => ('text' in p ? n + p.text.length : n), 0)
    out.push({ kind: 'speak', parts: current, chars })
    current = []
  }

  for (const s of segments) {
    if (s.kind === 'text') {
      if (current.length) current.push({ text: ' ' })
      current.push({ text: s.text })
      continue
    }
    if (inlineOk && s.seconds < inlineThresholdSec && current.length) {
      current.push({ breakSec: s.seconds })
    } else {
      flush()
      out.push({ kind: 'silence', seconds: s.seconds })
    }
  }
  flush()
  return out
}

type AzureCreds = { key: string; region: string }

let cachedCreds: AzureCreds | null = null

/** Ключ живёт в ~/.claude/secrets/azure-speech.env и в репозиторий не попадает. */
export function azureCreds(): AzureCreds {
  if (cachedCreds) return cachedCreds
  const fromEnv = process.env.AZURE_SPEECH_KEY
  const regionFromEnv = process.env.AZURE_SPEECH_REGION
  if (fromEnv && regionFromEnv) {
    cachedCreds = { key: fromEnv, region: regionFromEnv }
    return cachedCreds
  }
  const path = process.env.AZURE_SPEECH_ENV_FILE || join(homedir(), '.claude', 'secrets', 'azure-speech.env')
  const raw = readFileSync(path, 'utf8')
  const get = (name: string) => raw.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim()
  const key = get('AZURE_SPEECH_KEY')
  const region = get('AZURE_SPEECH_REGION')
  if (!key || !region) throw new Error(`Не нашёл AZURE_SPEECH_KEY/REGION в ${path}`)
  cachedCreds = { key, region }
  return cachedCreds
}

/**
 * Синтезирует один кусок. Возвращает сырой PCM-WAV 48 кГц моно — так между
 * кусками и тишиной нет перекодирования, и склейка получается без щелчков.
 */
export async function synthesize(text: SsmlPart[] | string, v: VoiceParams, attempt = 1): Promise<Buffer> {
  const { key, region } = azureCreds()
  const res = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': key,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'riff-48khz-16bit-mono-pcm',
      'User-Agent': 'seven-nights',
    },
    body: buildSsml(text, v),
  })
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300)
    // 429 — троттлинг бесплатного тарифа, он частый и лечится ожиданием.
    if ((res.status === 429 || res.status >= 500) && attempt <= 5) {
      const waitMs = 2000 * attempt
      await new Promise((r) => setTimeout(r, waitMs))
      return synthesize(text, v, attempt + 1)
    }
    throw new Error(`Azure TTS ${res.status}: ${detail}`)
  }
  return Buffer.from(await res.arrayBuffer())
}
