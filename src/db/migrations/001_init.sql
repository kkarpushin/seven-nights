-- 001_init.sql — первая схема «Семи ночей».
-- Дословно §2.2 docs/architecture.md. Откатов нет: правки только новыми файлами 002_*, 003_*.
-- Время везде — unix-секунды UTC (INTEGER). Исключения названы в комментариях к колонкам.

CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

-- ─────────────────────────────── ЛЮДИ ───────────────────────────────
-- Ни имени, ни username, ни телефона, ни почты. Только tg_id и цифры.
CREATE TABLE users (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id               INTEGER NOT NULL UNIQUE,
  language_code       TEXT,                       -- из message.from, только для гипотезы пояса
  tz_offset_min       INTEGER NOT NULL DEFAULT 180,   -- минуты, [-720, 840], кратно 15
  evening_time        TEXT    NOT NULL DEFAULT '21:00', -- 'HH:MM' локального времени

  state               TEXT    NOT NULL DEFAULT 'new',
  state_before_now    TEXT,                       -- куда вернуться после сессии «Практика сейчас»
  state_before_block  TEXT,                       -- куда вернуться после разблокировки
  due_at              INTEGER,                    -- unix UTC; NULL = таймера нет
  due_kind            TEXT,                       -- см. §4.2; NULL когда due_at IS NULL
  due_attempts        INTEGER NOT NULL DEFAULT 0, -- сколько раз подряд срабатывание падало
  active_session_id   INTEGER REFERENCES sessions(id) ON DELETE SET NULL,

  run_no              INTEGER NOT NULL DEFAULT 1, -- круг программы, растёт на «Ещё семь вечеров»
  current_evening     INTEGER NOT NULL DEFAULT 0, -- 0..7, засчитанных вечеров в текущем круге
  consecutive_skips   INTEGER NOT NULL DEFAULT 0, -- вечеров подряд без ответа; 3 → автопауза
  not_today_streak    INTEGER NOT NULL DEFAULT 0, -- «Не сегодня» подряд; 2 → предложить паузу
  day8_sent           INTEGER NOT NULL DEFAULT 0,

  demo                INTEGER NOT NULL DEFAULT 0,
  demo_day_counter    INTEGER NOT NULL DEFAULT 0, -- виртуальная «ритуальная дата» в демо

  quiz_sum            INTEGER,                    -- 0..70, замер с лендинга (?start=q42)
  quiz_index          INTEGER,                    -- 0..100 = round(sum/70*100)
  quiz_at             INTEGER,
  quiz_sum_after      INTEGER,                    -- повторный замер внутри бота
  quiz_index_after    INTEGER,
  quiz_after_at       INTEGER,
  quiz_after_declined INTEGER NOT NULL DEFAULT 0, -- нажал «Не сейчас» — больше не предлагаем
  quiz_step           INTEGER NOT NULL DEFAULT 0, -- 0..7, прогресс повторного теста
  quiz_resume_offered INTEGER NOT NULL DEFAULT 0, -- «Осталось три вопроса» предложено один раз

  start_payload       TEXT,                       -- сырой payload первого /start (landing, q42, …)
  last_seen_at        INTEGER,
  silent_notified_for INTEGER,                    -- last_seen_at, за который уже слали admin.silent
  paused_at           INTEGER,
  blocked_at          INTEGER,
  completed_at        INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,

  CHECK (state IN ('new','onb_hour','onb_clock','idle','awaiting_before','awaiting_state',
                   'practicing','awaiting_after','paused','completed','blocked',
                   'change_hour','change_clock','quiz_after')),
  CHECK (tz_offset_min BETWEEN -720 AND 840),
  CHECK (current_evening BETWEEN 0 AND 7),
  CHECK (quiz_sum IS NULL OR quiz_sum BETWEEN 0 AND 70),
  CHECK (quiz_sum_after IS NULL OR quiz_sum_after BETWEEN 0 AND 70)
);

CREATE INDEX users_due        ON users(due_at) WHERE due_at IS NOT NULL;
CREATE INDEX users_state      ON users(state);
CREATE INDEX users_last_seen  ON users(last_seen_at);

-- ───────────────────────────── СЕССИИ ─────────────────────────────
-- Одна сессия = один проход «цифра до → практика → цифра после».
CREATE TABLE sessions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_no          INTEGER NOT NULL,
  kind            TEXT    NOT NULL CHECK (kind IN ('evening','now')),
  evening_no      INTEGER,                     -- 1..7 для evening, NULL для now
  ritual_date     TEXT    NOT NULL,            -- 'YYYY-MM-DD' локально, или 'demo-<n>' в демо
  category        TEXT    CHECK (category IN ('sleep','stress','day')),
  practice_id     INTEGER REFERENCES practices(id) ON DELETE SET NULL,

  before_value    INTEGER CHECK (before_value BETWEEN 0 AND 10),
  before_at       INTEGER,
  after_value     INTEGER CHECK (after_value BETWEEN 0 AND 10),
  after_at        INTEGER,
  after_source    TEXT CHECK (after_source IN ('button','timer','early','morning')),
  nudged          INTEGER NOT NULL DEFAULT 0,  -- утренний догон уже отправлен

  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','done','abandoned','declined')),

  prompt_msg_id   INTEGER,   -- сообщение с вопросом «до»
  choice_msg_id   INTEGER,   -- сообщение с inline-категориями
  practice_msg_id INTEGER,   -- сообщение с аудио (под ним «Готово»)
  prompt_sent_at  INTEGER,   -- пишется ДО вызова Telegram (защита от дублей)
  practice_sent_at INTEGER,  -- момент засчитывания вечера
  closed_at       INTEGER,
  created_at      INTEGER NOT NULL,

  CHECK ((kind = 'evening' AND evening_no BETWEEN 1 AND 7) OR (kind = 'now' AND evening_no IS NULL))
);

-- Главный инвариант: на одну ритуальную дату — максимум один ЗАСЧИТАННЫЙ вечер.
CREATE UNIQUE INDEX sessions_one_evening_per_ritual_date
  ON sessions(user_id, ritual_date)
  WHERE kind = 'evening' AND practice_sent_at IS NOT NULL;

-- Активная сессия у человека тоже одна.
CREATE UNIQUE INDEX sessions_one_active
  ON sessions(user_id) WHERE status = 'active';

CREATE INDEX sessions_user_run ON sessions(user_id, run_no, evening_no);
CREATE INDEX sessions_created  ON sessions(created_at);
CREATE INDEX sessions_practice ON sessions(practice_id);

-- ──────────────────────────── ПРАКТИКИ ────────────────────────────
CREATE TABLE practices (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT NOT NULL UNIQUE,
  category      TEXT NOT NULL CHECK (category IN ('sleep','stress','day')),
  title         TEXT NOT NULL,
  line1         TEXT NOT NULL DEFAULT '',     -- две строки под аудио, ≤ 400 символов каждая
  line2         TEXT NOT NULL DEFAULT '',
  audio_path    TEXT,                          -- относительный путь: content/audio/<slug>.mp3
  audio_sha256  TEXT,                          -- хеш файла; сменился → tg_file_id сбрасывается
  audio_bytes   INTEGER,
  duration_sec  INTEGER,
  tg_file_id    TEXT,                          -- кэш Telegram, NULL = зальём при первой отправке
  tg_file_unique_id TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 100,
  active        INTEGER NOT NULL DEFAULT 1,
  origin        TEXT NOT NULL DEFAULT 'file' CHECK (origin IN ('file','admin')),
  script_hash   TEXT,                          -- хеш content/practices/<slug>.md на момент синка
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX practices_pick ON practices(category, active, sort_order);

-- Кто что слушал — основа правила выбора практики.
CREATE TABLE plays (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  practice_id INTEGER NOT NULL REFERENCES practices(id) ON DELETE CASCADE,
  session_id  INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  played_at   INTEGER NOT NULL
);
CREATE INDEX plays_user ON plays(user_id, practice_id, played_at);

-- ───────────────────────── ТЕКСТЫ И НАСТРОЙКИ ─────────────────────────
CREATE TABLE texts (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL,
  default_value TEXT NOT NULL,          -- для кнопки «вернуть как было»
  placeholders  TEXT NOT NULL DEFAULT '[]',   -- JSON-массив разрешённых, напр. ["{n}","{time}"]
  section       TEXT NOT NULL,          -- onboarding|evening|now|pause|numbers|final|buttons|admin|quiz
  hint          TEXT NOT NULL DEFAULT '',     -- «где это видно» — подсказка в админке
  updated_at    INTEGER NOT NULL
);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,            -- всегда строка; типизация — в src/db/settings.ts
  updated_at INTEGER NOT NULL
);

-- ──────────────────────── ИСТОРИЯ И СТАТИСТИКА ────────────────────────
CREATE TABLE events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
  type      TEXT NOT NULL,   -- см. список ниже
  at        INTEGER NOT NULL,
  session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  payload   TEXT NOT NULL DEFAULT '{}'  -- JSON: {"evening_no":3,"before":4,"after":7,…}
);
CREATE INDEX events_user ON events(user_id, at);
CREATE INDEX events_type ON events(type, at);

-- Свободный текст человека — специалисту.
CREATE TABLE messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text            TEXT NOT NULL,
  at              INTEGER NOT NULL,
  state_at_moment TEXT NOT NULL,
  session_id      INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  notified        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX messages_user ON messages(user_id, at);

-- Поответные данные теста (phase='before' появляется только если тест проходили в боте).
CREATE TABLE quiz_answers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_no     INTEGER NOT NULL DEFAULT 1,
  phase      TEXT NOT NULL CHECK (phase IN ('before','after')),
  q          INTEGER NOT NULL CHECK (q BETWEEN 1 AND 7),
  value      INTEGER NOT NULL CHECK (value BETWEEN 0 AND 10),
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, run_no, phase, q)
);

-- Очередь уведомлений владельцу: отправка и дедупликация вынесены из диалога.
CREATE TABLE notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,       -- started|finished|silent|blocked|message|no_practices
  dedup_key  TEXT NOT NULL UNIQUE,
  text       TEXT NOT NULL,       -- уже отрендеренный текст
  created_at INTEGER NOT NULL,
  sent_at    INTEGER,
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX notifications_pending ON notifications(sent_at, created_at) WHERE sent_at IS NULL;

-- Cookie-сессии админки.
CREATE TABLE admin_sessions (
  token      TEXT PRIMARY KEY,     -- 32 случайных байта в hex
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  user_agent TEXT
);
CREATE INDEX admin_sessions_exp ON admin_sessions(expires_at);
