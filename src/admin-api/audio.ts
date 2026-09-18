/**
 * Приём mp3 из админки: проверка, сохранение, длительность, хеш.
 *
 * Длительность считаем сами, потому что она видна человеку в плеере Telegram и
 * попадает в срок «сколько ждать до вопроса после» (§3.4). Основной способ —
 * ffprobe: он один знает правду про VBR. Если ffprobe нет (машина без ffmpeg),
 * оцениваем по битрейту первого кадра — это хуже на несколько секунд и лучше, чем
 * отказаться принять файл: без длительности практика всё равно работает.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'

export const MAX_AUDIO_BYTES = 45 * 1024 * 1024

export function sha256Of(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

function ffprobeBin(): string {
  return process.env.FFPROBE_BIN && process.env.FFPROBE_BIN.trim() !== ''
    ? process.env.FFPROBE_BIN.trim()
    : 'ffprobe'
}

export function probeWithFfprobe(path: string): number | null {
  const bin = ffprobeBin()
  if (bin.includes('/') && !existsSync(bin)) return null
  try {
    const r = spawnSync(
      bin,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path],
      { encoding: 'utf8', timeout: 20_000 },
    )
    if (r.status !== 0) return null
    const sec = Number(String(r.stdout).trim())
    return Number.isFinite(sec) && sec > 0 ? Math.round(sec) : null
  } catch {
    return null
  }
}

const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
const SAMPLE_RATES_V1 = [44100, 48000, 32000, 0]

/** Грубая оценка по первому найденному кадру MPEG-1 Layer III. */
export function estimateMp3Seconds(buf: Buffer): number | null {
  // ID3v2 в начале файла — кадры идут после него.
  let i = 0
  if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'ID3') {
    const size = ((buf[6]! & 0x7f) << 21) | ((buf[7]! & 0x7f) << 14) | ((buf[8]! & 0x7f) << 7) | (buf[9]! & 0x7f)
    i = 10 + size
  }
  for (; i + 4 < buf.length && i < 1_000_000; i++) {
    if (buf[i] !== 0xff || (buf[i + 1]! & 0xe0) !== 0xe0) continue
    const versionBits = (buf[i + 1]! >> 3) & 0x03
    const layerBits = (buf[i + 1]! >> 1) & 0x03
    if (versionBits !== 3 || layerBits !== 1) continue // только MPEG-1 Layer III
    const bitrate = BITRATES_V1_L3[(buf[i + 2]! >> 4) & 0x0f]!
    const sampleRate = SAMPLE_RATES_V1[(buf[i + 2]! >> 2) & 0x03]!
    if (bitrate === 0 || sampleRate === 0) continue
    return Math.round(((buf.length - i) * 8) / (bitrate * 1000))
  }
  return null
}

export function audioDuration(path: string, buf: Buffer): number | null {
  return probeWithFfprobe(path) ?? estimateMp3Seconds(buf)
}

export type AudioCheck = { ok: true } | { ok: false; error: string; message: string }

/** Проверки ровно те, о которых написано на экране загрузки (§3.4 design-admin). */
export function checkAudio(filename: string, size: number): AudioCheck {
  if (!/\.mp3$/i.test(filename)) {
    return { ok: false, error: 'not_mp3', message: 'Это не mp3. Нужен файл с расширением .mp3.' }
  }
  if (size > MAX_AUDIO_BYTES) {
    return {
      ok: false,
      error: 'too_big',
      message: 'Файл больше 45 МБ — Telegram его не примет. Попробуй сжать или записать короче.',
    }
  }
  if (size < 1024) {
    return { ok: false, error: 'too_small', message: 'Файл почти пустой. Похоже, загрузка прервалась.' }
  }
  return { ok: true }
}
