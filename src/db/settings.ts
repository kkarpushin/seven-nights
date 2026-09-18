/**
 * Настройки. Колонка value текстовая (§2.2), типизация — здесь.
 *
 * Значения читаются на каждом обращении, без кеша в памяти: правка в админке
 * должна действовать сразу, а запрос по первичному ключу в SQLite дешевле, чем
 * инвалидация кеша, про которую однажды забудут.
 */

import type { Clock } from '../clock.ts'
import type { Db } from './index.ts'
import type { Category, SettingRow } from './types.ts'

export type SettingsStore = {
  raw(key: string): string | undefined
  str(key: string, fallback: string): string
  int(key: string, fallback: number): number
  bool(key: string, fallback: boolean): boolean
  json<T>(key: string, fallback: T): T
  csvNumbers(key: string): number[]
  set(key: string, value: string | number | boolean | object): void
  setMany(patch: Record<string, string | number | boolean | object>): void
  all(): Record<string, string>
  /** Типизированный снимок всех известных настроек — для GET /api/admin/settings. */
  snapshot(): SettingsSnapshot
}

export type SettingsSnapshot = {
  talk_url: string
  channel_url: string
  admin_tg_ids: number[]
  default_tz_offset_min: number
  allow_restart: boolean
  demo_secret: string
  sleep_route: string[]
  autopause_after_skips: number
  silence_hours: number
  morning_hour: string
  ritual_day_start_hour: number
  evening_window_lead_min: number
  long_text_threshold: number
  quiz_after_enabled: boolean
}

/** Значение настройки в строку: в базе колонка одна и текстовая. */
function toText(value: string | number | boolean | object): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? '1' : '0'
  return JSON.stringify(value)
}

export const CATEGORY_LABEL_KEY: Record<Category, string> = {
  sleep: 'btn.cat_sleep',
  stress: 'btn.cat_stress',
  day: 'btn.cat_day_evening',
}

export function createSettingsStore(db: Db, clock: Clock): SettingsStore {
  const selOne = db.prepare('SELECT value FROM settings WHERE key = ?')
  const selAll = db.prepare('SELECT * FROM settings ORDER BY key')
  const upsert = db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `)

  const raw = (key: string): string | undefined => (selOne.get(key) as { value: string } | undefined)?.value

  const store: SettingsStore = {
    raw,
    str: (key, fallback) => {
      const v = raw(key)
      return v === undefined || v === '' ? fallback : v
    },
    int: (key, fallback) => {
      const v = raw(key)
      if (v === undefined || v.trim() === '') return fallback
      const n = Number(v)
      return Number.isFinite(n) ? Math.trunc(n) : fallback
    },
    bool: (key, fallback) => {
      const v = raw(key)
      if (v === undefined || v.trim() === '') return fallback
      return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase())
    },
    json: <T,>(key: string, fallback: T): T => {
      const v = raw(key)
      if (v === undefined || v.trim() === '') return fallback
      try {
        return JSON.parse(v) as T
      } catch {
        return fallback
      }
    },
    csvNumbers: (key) => {
      const v = raw(key) ?? ''
      const out: number[] = []
      for (const part of v.split(/[,;\s]+/)) {
        const n = Number(part.trim())
        if (part.trim() !== '' && Number.isInteger(n) && !out.includes(n)) out.push(n)
      }
      return out
    },
    set: (key, value) => void upsert.run(key, toText(value), clock.now()),
    setMany(patch) {
      const now = clock.now()
      db.transaction(() => {
        for (const [k, v] of Object.entries(patch)) upsert.run(k, toText(v), now)
      })()
    },
    all() {
      const out: Record<string, string> = {}
      for (const r of selAll.all() as SettingRow[]) out[r.key] = r.value
      return out
    },
    snapshot: () => ({
      talk_url: store.str('talk_url', ''),
      channel_url: store.str('channel_url', ''),
      admin_tg_ids: store.csvNumbers('admin_tg_ids'),
      default_tz_offset_min: store.int('default_tz_offset_min', 180),
      allow_restart: store.bool('allow_restart', true),
      demo_secret: store.str('demo_secret', ''),
      sleep_route: store.json<string[]>('sleep_route', []),
      autopause_after_skips: store.int('autopause_after_skips', 3),
      silence_hours: store.int('silence_hours', 72),
      morning_hour: store.str('morning_hour', '10:00'),
      ritual_day_start_hour: store.int('ritual_day_start_hour', 4),
      evening_window_lead_min: store.int('evening_window_lead_min', 60),
      long_text_threshold: store.int('long_text_threshold', 60),
      quiz_after_enabled: store.bool('quiz_after_enabled', true),
    }),
  }

  return store
}
