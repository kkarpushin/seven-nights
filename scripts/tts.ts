/**
 * Синтез речи для практик «Семи ночей».
 *
 * Провайдер по умолчанию — Azure AI Speech (нативные русские голоса, бесплатный
 * тариф F0 ≈ 500 000 знаков в месяц). Почему не ElevenLabs — см. docs/tts-decision.md:
 * бесплатные аккаунты не могут синтезировать библиотечными голосами через API.
 *
 * Паузы делаются НЕ тегами SSML, а склейкой: сценарий режется на куски, каждый
 * кусок синтезируется отдельно, между ними ffmpeg вставляет цифровую тишину точной
 * длины. Так паузы не зависят от того, уважает ли конкретный голос <break/>
 * (генеративный ru-RU-Masha:MAI-Voice-2 его игнорирует), и не упираются в потолок 5 с.
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
  const PAUSE_RE = /\[\[pause:\s*([\d.]+)\s*\]\]|<break\s+time=["']?([\d.]+)(ms|s)["']?\s*\/?>/gi
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
    const seconds = m[1] !== undefined ? Number(m[1]) : m[3]?.toLowerCase() === 'ms' ? Number(m[2]) / 1000 : Number(m[2])
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

/** Приводит кусок к одной строке: синтезу не нужны переносы, а лишние пробелы он читает как заминки. */
function normalize(s: string): string {
  return s
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

export function buildSsml(text: string, v: VoiceParams): string {
  const inner = `<prosody rate="${v.rate}">${escapeXml(text)}</prosody>`
  const styled = v.style ? `<mstts:express-as style="${v.style}">${inner}</mstts:express-as>` : inner
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" ` +
    `xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="ru-RU">` +
    `<voice name="${v.voice}">${styled}</voice></speak>`
  )
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
export async function synthesize(text: string, v: VoiceParams, attempt = 1): Promise<Buffer> {
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
