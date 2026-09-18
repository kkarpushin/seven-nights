/**
 * Типы строк таблиц. §5.3 архитектуры.
 *
 * Одно правило на весь файл: имена полей совпадают с колонками SQLite буква в букву,
 * включая snake_case. Любая «красивая» перекладка в camelCase заставила бы держать
 * в голове два словаря и рано или поздно потерять поле в SELECT *.
 *
 * 0 | 1 вместо boolean — потому что SQLite хранит именно числа, а better-sqlite3
 * отдаёт их как есть. Тип напоминает, что `if (row.demo)` работает, а `=== true` нет.
 */

export type UserState =
  | 'new'
  | 'onb_hour'
  | 'onb_clock'
  | 'idle'
  | 'awaiting_before'
  | 'awaiting_state'
  | 'practicing'
  | 'awaiting_after'
  | 'paused'
  | 'completed'
  | 'blocked'
  | 'change_hour'
  | 'change_clock'
  | 'quiz_after'

export const USER_STATES: readonly UserState[] = [
  'new', 'onb_hour', 'onb_clock', 'idle', 'awaiting_before', 'awaiting_state',
  'practicing', 'awaiting_after', 'paused', 'completed', 'blocked',
  'change_hour', 'change_clock', 'quiz_after',
]

export type DueKind =
  | 'ping'
  | 'skip_deadline'
  | 'after_timeout'
  | 'morning'
  | 'ping_or_close'
  | 'now_timeout_before'
  | 'now_timeout_after'
  | 'day8'
  | 'retry'

export const DUE_KINDS: readonly DueKind[] = [
  'ping', 'skip_deadline', 'after_timeout', 'morning', 'ping_or_close',
  'now_timeout_before', 'now_timeout_after', 'day8', 'retry',
]

export type Category = 'sleep' | 'calm' | 'day'
export const CATEGORIES: readonly Category[] = ['sleep', 'calm', 'day']

export type SessionKind = 'evening' | 'now'
export type SessionStatus = 'active' | 'done' | 'abandoned' | 'declined'
export type AfterSource = 'button' | 'timer' | 'early' | 'morning'
export type QuizPhase = 'before' | 'after'
export type PracticeOrigin = 'file' | 'admin'

export type UserRow = {
  id: number
  tg_id: number
  language_code: string | null
  tz_offset_min: number
  evening_time: string
  state: UserState
  state_before_now: UserState | null
  state_before_block: UserState | null
  due_at: number | null
  due_kind: DueKind | null
  due_attempts: number
  active_session_id: number | null
  run_no: number
  current_evening: number
  consecutive_skips: number
  not_today_streak: number
  day8_sent: 0 | 1
  demo: 0 | 1
  demo_day_counter: number
  quiz_sum: number | null
  quiz_index: number | null
  quiz_at: number | null
  quiz_sum_after: number | null
  quiz_index_after: number | null
  quiz_after_at: number | null
  quiz_after_declined: 0 | 1
  quiz_step: number
  quiz_resume_offered: 0 | 1
  start_payload: string | null
  last_seen_at: number | null
  silent_notified_for: number | null
  paused_at: number | null
  blocked_at: number | null
  completed_at: number | null
  created_at: number
  updated_at: number
}

export type SessionRow = {
  id: number
  user_id: number
  run_no: number
  kind: SessionKind
  evening_no: number | null
  ritual_date: string
  category: Category | null
  practice_id: number | null
  before_value: number | null
  before_at: number | null
  after_value: number | null
  after_at: number | null
  after_source: AfterSource | null
  nudged: 0 | 1
  status: SessionStatus
  prompt_msg_id: number | null
  choice_msg_id: number | null
  practice_msg_id: number | null
  prompt_sent_at: number | null
  practice_sent_at: number | null
  closed_at: number | null
  created_at: number
}

export type PracticeRow = {
  id: number
  slug: string
  category: Category
  title: string
  line1: string
  line2: string
  audio_path: string | null
  audio_sha256: string | null
  audio_bytes: number | null
  duration_sec: number | null
  tg_file_id: string | null
  tg_file_unique_id: string | null
  sort_order: number
  active: 0 | 1
  origin: PracticeOrigin
  script_hash: string | null
  created_at: number
  updated_at: number
}

export type PlayRow = {
  id: number
  user_id: number
  practice_id: number
  session_id: number | null
  played_at: number
}

export type TextRow = {
  key: string
  value: string
  default_value: string
  /** В базе — JSON-массив строкой; разбирает src/db/texts.ts. */
  placeholders: string
  section: string
  hint: string
  updated_at: number
}

export type SettingRow = {
  key: string
  value: string
  updated_at: number
}

export type EventRow = {
  id: number
  user_id: number | null
  type: string
  at: number
  session_id: number | null
  payload: string
}

export type MessageRow = {
  id: number
  user_id: number
  text: string
  at: number
  state_at_moment: UserState
  session_id: number | null
  notified: 0 | 1
}

export type QuizAnswerRow = {
  id: number
  user_id: number
  run_no: number
  phase: QuizPhase
  q: number
  value: number
  created_at: number
}

export type NotificationRow = {
  id: number
  user_id: number | null
  type: string
  dedup_key: string
  text: string
  created_at: number
  sent_at: number | null
  attempts: number
  last_error: string | null
}

export type AdminSessionRow = {
  token: string
  created_at: number
  expires_at: number
  last_seen: number
  user_agent: string | null
}

/** §6.2: одна строка таблицы людей в админке. */
export type AdminUserRow = {
  id: number
  tg_id: number
  state: UserState
  run_no: number
  current_evening: number
  evening_time: string
  /** Уже отформатированный пояс, «UTC+3». */
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

export type AdminUserSegment = 'active' | 'finished' | 'paused' | 'stuck' | 'blocked'

export type AdminUserQuery = {
  q?: string
  state?: UserState
  segment?: AdminUserSegment
  sort?: 'last_seen' | 'created' | 'evening'
  dir?: 'asc' | 'desc'
  page?: number
  per?: number
  includeDemo?: boolean
  /** «Сейчас» для сегмента stuck (7 дней без активности). */
  now?: number
}
