/**
 * Формы ответов API. Повторяют то, что отдаёт src/admin-api, и ничего больше:
 * фронтенд не досчитывает статистику — иначе две реализации одной формулы
 * разъедутся, и никто не сможет сказать, какая цифра правильная.
 */

export type UserState =
  | 'new' | 'onb_hour' | 'onb_clock' | 'idle' | 'awaiting_before' | 'awaiting_state'
  | 'practicing' | 'awaiting_after' | 'paused' | 'completed' | 'blocked'
  | 'change_hour' | 'change_clock' | 'quiz_after'

export type Category = 'sleep' | 'calm' | 'day'
export type AfterSource = 'button' | 'timer' | 'early' | 'morning'

export type Me = {
  ok: true
  botUsername: string
  version: string
  dbSizeBytes: number
  uptimeSec: number
  demoDefault: boolean
  practicesActive: number
  adminsSet: boolean
}

export type UserRow = {
  id: number
  tg_id: number
  state: UserState
  run_no: number
  current_evening: number
  evening_time: string
  tz: string
  first_before: number | null
  last_after: number | null
  delta: number | null
  quiz_index: number | null
  quiz_index_after: number | null
  sessions_done: number
  skips: number
  demo: 0 | 1
  created_at: number
  last_seen_at: number | null
  completed_at: number | null
}

export type ChartPoint = { evening: number; before: number | null; after: number | null; date: string }

export type TimelineItem = {
  at: number
  kind: 'measure_before' | 'measure_after' | 'practice' | 'message' | 'admin_message' | 'event'
  title: string
  detail: Record<string, unknown>
}

export type SessionRow = {
  id: number
  user_id: number
  run_no: number
  kind: 'evening' | 'now'
  evening_no: number | null
  ritual_date: string
  category: Category | null
  before_value: number | null
  after_value: number | null
  after_source: AfterSource | null
  status: 'active' | 'done' | 'abandoned' | 'declined'
  practice_sent_at: number | null
  created_at: number
  practice_title: string | null
  practice_slug: string | null
  done_after_sec: number | null
}

export type UserCard = {
  user: Record<string, unknown> & {
    id: number
    tg_id: number
    state: UserState
    demo: 0 | 1
    run_no: number
    current_evening: number
    evening_time: string
    tz_offset_min: number
    created_at: number
    last_seen_at: number | null
    quiz_sum: number | null
  }
  timeline: TimelineItem[]
  sessions: SessionRow[]
  chart: ChartPoint[]
  nowCount: number
  avgGain: number | null
  quiz: {
    before: { sum: number | null; index: number | null; at: number | null; answers: Array<number | null> }
    after: { sum: number | null; index: number | null; at: number | null; answers: Array<number | null> }
  }
  messages: Array<{ id: number; text: string; at: number; state_at_moment: UserState }>
  notifications: Array<{ id: number; type: string; text: string; created_at: number; sent_at: number | null }>
  serverNow: number
}

export type Stats = {
  funnel: { started: number; finished: number; conversion: number }
  avgGain: number | null
  stuckAt: Array<{ evening: number; people: number }>
  reach: Array<{ evening: number; people: number }>
  byEvening: Array<{
    evening: number; n: number
    avg_before: number | null; avg_after: number | null; avg_delta: number | null
  }>
  today: { active: number; practices: number; new: number }
  now: { sessions: number; by_category: Array<{ category: Category; n: number }> }
  practices: Array<{ id: number; slug: string; title: string; plays: number; avg_delta: number | null }>
  afterSource: Array<{ source: AfterSource | 'none'; n: number }>
  quiz: {
    in_avg: number | null; out_avg: number | null; gain: number | null
    both: number; in_avg_all: number | null
  }
  states: Array<{ state: UserState; n: number }>
  skips: { avg: number; abandoned: number; declined: number; autopaused: number }
}

export type Dashboard = {
  period: { from: number; to: number; days: number | null; period: string }
  demo: boolean
  stats: Stats
  previous: { started: number; finished: number; conversion: number } | null
  gainPeople: number
  notFinished: number
  byDay: Array<{ date: string; evening: number; now: number; total: number }>
  categories: Array<{ category: Category; n: number }>
  nowInProgram: Array<{
    id: number; state: UserState; current_evening: number; last_seen_at: number | null; demo: 0 | 1
  }>
  totals: { users: number; practicesActive: number }
  serverNow: number
}

export type Practice = {
  id: number
  slug: string
  category: Category
  title: string
  line1: string
  line2: string
  audio_path: string | null
  audio_bytes: number | null
  duration_sec: number | null
  tg_file_id: string | null
  sort_order: number
  active: 0 | 1
  origin: 'file' | 'admin'
  updated_at: number
  plays: number
}

export type TextRow = {
  key: string
  value: string
  default_value: string
  placeholders: string
  placeholder_list: string[]
  section: string
  hint: string
  updated_at: number
  changed: boolean
}

export type TextsResponse = {
  rows: TextRow[]
  sections: Array<{ section: string; title: string; count: number }>
}

export type Settings = {
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
  notify_types: string[]
  demo_default: boolean
  bot_username: string
  sleep_practices: Array<{ slug: string; title: string; active: 0 | 1 }>
}

export type NotificationRow = {
  id: number
  user_id: number | null
  type: string
  text: string
  created_at: number
  sent_at: number | null
  attempts: number
  last_error: string | null
}
