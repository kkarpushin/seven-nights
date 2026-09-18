# «Семь ночей» — архитектура и контракт реализации

Дата: 2026-09-18. Автор: backend/TypeScript-архитектор (Claude).
Источники истины, в порядке старшинства: `docs/brief.md` → `docs/design-bot.md` (поведение бота) → `docs/quiz-bot-integration.md` + `docs/quiz-spec.md` (тест) → `docs/content-plan.md` (контент) → `docs/tts-decision.md` (озвучка, **отменяет** разделы 2–3 content-plan в части провайдера) → `docs/design-landing.md`.

Этот документ — **контракт**: по нему пять инженеров пишут код параллельно, не видя кода друг друга. Всё, что здесь названо (имена файлов, колонок, типов, функций, маршрутов, ключей), считается зафиксированным. Если инженеру нужно отступить — правка вносится сюда, а потом в код.

Язык интерфейса — русский, идентификаторы кода — английские. Тон текстов и сами тексты — из `design-bot.md`, Приложение А; в коде их дублировать нельзя, только ключи.

---

## 0. Решения, принятые этим документом (разбор расхождений источников)

| # | Расхождение | Решение |
|---|---|---|
| 1 | `design-bot.md` §3.3: `users.tg_id` — PK. `quiz-bot-integration.md` §6: `quiz_answers.user_id REFERENCES users(id)`. | У `users` суррогатный `id INTEGER PRIMARY KEY AUTOINCREMENT` + `tg_id INTEGER NOT NULL UNIQUE`. Все внешние ключи и админка — на `users.id`. Плейсхолдер `{id}` в уведомлениях владельцу = `users.id` («участник #17»), tg_id владельцу не показываем. |
| 2 | `design-bot.md` §3.5: практика выбирается по «меньше всего слушал». `content-plan.md` §6: жёсткий маршрут сна 1→A, 2→B, 3→C, 4→D, 5→B, 6→C, 7→A, где 7-й вечер = 1-й (вау-момент «та же практика, а ты другой»). Правила несовместимы на вечерах 5–7. | **Маршрут старше.** Для `kind='evening' AND category='sleep'` практика берётся из `settings.sleep_route[evening_no]`, если она активна. Во всех остальных случаях (другие категории, `kind='now'`, маршрут пуст/практика выключена) — правило §3.5 «меньше всего слушал». Маршрут редактируется в админке. |
| 3 | Задание оркестратора: озвучка ElevenLabs с ротацией `KEY_2..6`. `docs/tts-decision.md` (позже): бесплатный ElevenLabs не даёт русских голосов через API (HTTP 402), провайдер — **Azure AI Speech**. | Провайдер по умолчанию — Azure (`ru-RU-Masha:MAI-Voice-2`, стиль `caringempathy`). Ротация ключей ElevenLabs не реализуется. Генератор пишется за интерфейсом `TtsProvider`, ElevenLabs остаётся вторым провайдером «на потом» (§8.6). Скрипты `scripts/tts.ts` и `scripts/generate-audio.ts` уже написаны по этому решению — их не переписывать. |
| 4 | Задание: картинка 1200×800 или 1080×1350. `design-bot.md` §2.7: PNG 1200×1500, 4:5. | **1200×1500**, как в финальном дизайне (вертикаль для сторис). |
| 5 | `design-bot.md` §2.1 упоминает ключ `onb.quiz_index`, `quiz-bot-integration.md` §3 — `onboarding.quiz_index`. | Канонический ключ — **`onb.quiz_index`**. Все ключи текстов приводятся к префиксам из Приложения А design-bot. |
| 6 | Колонки `before` / `after` из §3.3. | В SQL называются `before_value` / `after_value` (в грамматике SQLite `BEFORE`/`AFTER` участвуют в триггерах; плюс так не нужны кавычки в запросах). В коде и в API — те же `before_value` / `after_value`, в UI админки — «до» / «после». |
| 7 | Время в БД. | **Везде unix-секунды UTC (`INTEGER`)**. Исключения, где формат другой, названы явно: `users.evening_time` — `'HH:MM'` локально, `sessions.ritual_date` — `'YYYY-MM-DD'` (или `'demo-<n>'`). Никаких `DATETIME`, никаких строковых дат в сравнениях. |

---

## 1. Структура репозитория

Каркас уже существует (`package.json`, `tsconfig.json`, `vitest.config.ts`, `web/landing/`, `scripts/tts.ts`, `scripts/generate-audio.ts`, `content/practices/*.md`, `deploy/seven-nights.service`, `assets/fonts/`). Ниже — целевое состояние; ✅ = файл уже есть и переписывать его не надо.

```
7days/
├── .env                      # секреты, в .gitignore ✅
├── .env.example              # ✅ (дополняется, см. §10.1)
├── package.json              # ✅
├── tsconfig.json             # ✅
├── vitest.config.ts          # ✅
├── data/
│   └── seven-nights.db       # SQLite (WAL), в .gitignore ✅
├── assets/fonts/             # NotoSans-Regular.ttf, NotoSans-Bold.ttf ✅ — шрифт для resvg
├── content/
│   ├── practices/<slug>.md   # 9 сценариев с frontmatter ✅ — источник практик
│   └── audio/
│       ├── <slug>.mp3        # результат генерации, в .gitignore
│       └── manifest.json     # slug → duration, voice, style, hash
├── deploy/seven-nights.service  # systemd --user unit ✅
├── docs/                     # brief, tz-original, design-*, content-plan, quiz-*, tts-decision, architecture ✅
├── scripts/
│   ├── tts.ts                # ✅ Azure TTS: парсер сценария, SSML, планировщик запросов
│   ├── generate-audio.ts     # ✅ сценарий → mp3 + manifest.json, идемпотентно
│   ├── voice-samples.ts      # ✅ образцы голосов для выбора владельцем
│   ├── preview-server.ts     # ✅ локальный просмотр образцов
│   ├── upload-audio.ts       # НОВЫЙ: прогрев tg_file_id через sendAudio в служебный чат
│   ├── seed.ts               # НОВЫЙ: миграции + тексты по умолчанию + практики из файлов
│   └── backup-db.ts          # НОВЫЙ: VACUUM INTO data/backups/<ts>.db, ротация 14 копий
├── src/
│   ├── index.ts              # точка входа: env → db → content sync → bot → scheduler → http
│   ├── env.ts                # чтение и валидация .env, тип Env
│   ├── ctx.ts                # сборка Ctx (см. §5.1) — единственный способ получить зависимости
│   ├── log.ts                # структурный логгер (JSON в stdout), уровни, redact токена
│   ├── clock.ts              # Clock: now(), sleep() — подменяется в тестах
│   ├── time.ts               # локальное время, ритуальная дата, вечернее окно, следующие сроки
│   ├── parse.ts              # парсеры: час, «сколько на часах», цифра 0–10, payload /start
│   ├── texts.ts              # реестр текстов: get/render/склонения, сопоставление подписей кнопок
│   ├── keyboards.ts          # сборка reply/inline-клавиатур по §4 design-bot
│   ├── timings.ts            # таблица сроков: обычный режим vs демо (§3.6 design-bot)
│   ├── db/
│   │   ├── index.ts          # openDb(), PRAGMA, миграции, tx()
│   │   ├── migrations/001_init.sql, 002_*.sql …
│   │   ├── types.ts          # типы строк (UserRow, SessionRow, …)
│   │   ├── users.ts sessions.ts practices.ts plays.ts texts.ts settings.ts
│   │   ├── events.ts messages.ts quiz.ts notifications.ts adminSessions.ts
│   │   └── stats.ts          # все запросы статистики админки (§6.6)
│   ├── bot/
│   │   ├── index.ts          # createBot(ctx): grammY Bot, регистрация хендлеров
│   │   ├── send.ts           # Sender: единственная точка вызова Telegram API (403 → blocked)
│   │   ├── flow.ts           # ЯДРО: переходы состояний; вызывается и ботом, и планировщиком
│   │   ├── evening.ts        # startEvening / closeEvening / finale
│   │   ├── now.ts            # сессия «Практика сейчас», слияние с вечером
│   │   ├── onboarding.ts     # /start, час, часы, tz, повторный /start, смена времени
│   │   ├── quiz.ts           # повторный тест внутри бота (7 вопросов, inline 0–10)
│   │   ├── freetext.ts       # не-цифра, длинный текст, «пауза»
│   │   ├── admin-cmds.ts     # /whoami, /demo <secret>, /reset <secret>
│   │   └── notify.ts         # постановка уведомлений владельцу в очередь
│   ├── scheduler/
│   │   ├── index.ts          # startScheduler(ctx): setInterval, тик 30 с
│   │   ├── due.ts            # обработка просроченных due_at по due_kind
│   │   ├── sweeps.ts         # молчание 72 ч, отправка очереди notifications, ретраи
│   │   └── plan.ts           # вычисление следующего due_at (обычный/демо)
│   ├── content/
│   │   ├── practices.ts      # синк content/practices/*.md + manifest.json → таблица practices
│   │   ├── pick.ts           # выбор практики (маршрут сна + «меньше всего слушал»)
│   │   └── audio.ts          # отправка практики, кэш tg_file_id, перезаливка при протухании
│   ├── chart/
│   │   ├── data.ts           # выборка точек графика для run_no
│   │   ├── svg.ts            # чистая функция: данные → строка SVG (§7)
│   │   └── render.ts         # resvg: SVG → PNG Buffer, шрифт из assets/fonts
│   ├── admin-api/
│   │   ├── index.ts          # Hono-роутер /api/admin
│   │   ├── auth.ts           # пароль из env + cookie-сессия
│   │   └── routes/{stats,users,practices,texts,settings,events,export}.ts
│   └── http/
│       └── server.ts         # Hono: /api/admin, /admin SPA, / лендинг, /healthz, /media
├── tests/
│   ├── helpers/{db.ts,bot.ts,clock.ts,fixtures.ts}
│   ├── tts.test.ts ✅  quiz.test.ts ✅
│   ├── onboarding.test.ts evening.test.ts skip.test.ts finale.test.ts
│   ├── now.test.ts pause.test.ts scheduler.test.ts demo-run.test.ts
│   ├── parse.test.ts pick.test.ts chart.test.ts stats.test.ts admin-api.test.ts
└── web/
    ├── admin/                # Vite + React + Tailwind + Recharts (SPA, base '/admin/')
    │   ├── vite.config.ts index.html
    │   └── src/{main.tsx,App.tsx,api.ts,components/…,pages/{Login,Dashboard,Users,User,Practices,Texts,Settings}.tsx}
    └── landing/              # ✅ статика, отдаётся с GET /
```

### 1.1 Разделение работ (кто что пишет параллельно)

| Инженер | Зона | Файлы | От кого зависит |
|---|---|---|---|
| **A. Данные** | схема, репозитории, статистика | `src/db/**`, `scripts/seed.ts`, `scripts/backup-db.ts`, `tests/stats.test.ts` | ни от кого (пишется первым, §2 — полный контракт) |
| **B. Бот** | состояния и диалог | `src/bot/**`, `src/texts.ts`, `src/keyboards.ts`, `src/parse.ts`, тесты диалога | типы из A (§5.3), Sender (§5.5) |
| **C. Время** | планировщик, сроки, демо, уведомления | `src/scheduler/**`, `src/time.ts`, `src/timings.ts`, `src/clock.ts`, `src/bot/notify.ts` | A; вызывает `flow.*` из B по сигнатурам §5.6 |
| **D. Админка** | API + SPA | `src/admin-api/**`, `src/http/server.ts`, `web/admin/**` | A (`stats.ts`), контракт §6 |
| **E. Медиа** | график, аудио, контент | `src/chart/**`, `src/content/**`, `scripts/upload-audio.ts`, генерация озвучки | A; отдаёт B функции §5.8–5.9 |

Пока модуль соседа не готов, каждый работает против сигнатур из §5 (заглушка `throw new Error('not implemented')` допустима только в ветке, которую тесты этого инженера не трогают).

---

## 2. Схема SQLite (полный DDL)

Файл `src/db/migrations/001_init.sql` — дословно то, что ниже. Миграции применяются по номеру файла, версия хранится в `schema_migrations`; откат не предусмотрен, только новые файлы `002_…`, `003_…`.

### 2.1 Настройки соединения

```sql
PRAGMA journal_mode = WAL;      -- один процесс пишет, админка читает параллельно
PRAGMA synchronous = NORMAL;    -- при WAL достаточно, потеря максимум последних мс
PRAGMA foreign_keys = ON;       -- ставится на КАЖДОМ соединении, не сохраняется в файле
PRAGMA busy_timeout = 5000;
PRAGMA temp_store = MEMORY;
```

### 2.2 DDL

```sql
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
```

### 2.3 Значения `events.type` (закрытый список)

`started` (онбординг завершён, программа началась) · `evening_started` (пинг открыт, цифра «до» получена) · `practice_sent` (вечер засчитан) · `evening_done` (получена цифра «после») · `evening_skipped` (04:00 без практики) · `not_today` · `now_done` · `paused` · `autopaused` · `resumed` · `finished` (седьмой вечер закрыт) · `day8` · `restarted` · `blocked` · `unblocked` · `quiz_in` (payload с лендинга) · `quiz_after_done` · `hour_changed` · `demo_on` · `demo_off` · `reset` · `no_practices`.

`payload` — JSON; обязательные поля по типам: `evening_done` → `{evening_no, before, after, after_source, practice_id}`, `practice_sent` → `{evening_no|null, kind, practice_id, category}`, `finished` → `{first_before, last_after, avg_delta}`, `quiz_in` → `{sum, index}`, `quiz_after_done` → `{sum, index, index_before}`.

### 2.4 Ключи `settings` (значения по умолчанию ставит `scripts/seed.ts`)

| Ключ | Тип | По умолчанию | Смысл |
|---|---|---|---|
| `talk_url` | string | `''` | Ссылка «Записаться на разговор»; пусто → inline-кнопки нет, текст остаётся |
| `channel_url` | string | `''` | Ссылка «Мой канал» в сообщении дня 8 |
| `admin_tg_ids` | csv | из `ADMIN_TG_IDS` | Кому шлём уведомления; правится в админке, объединяется с env |
| `default_tz_offset_min` | int | `180` | Гипотеза пояса для неизвестного `language_code` |
| `allow_restart` | bool | `1` | Показывать ли «Ещё семь вечеров» |
| `demo_secret` | string | случайные 8 символов | Пароль команд `/demo` и `/reset` |
| `sleep_route` | json | `["sleep-landing","sleep-warmth","sleep-release","sleep-shuffle","sleep-warmth","sleep-release","sleep-landing"]` | Маршрут вечеров 1–7 для категории `sleep` (§0, решение 2) |
| `autopause_after_skips` | int | `3` | Порог автопаузы |
| `silence_hours` | int | `72` | Порог уведомления о молчании |
| `morning_hour` | string | `'10:00'` | Утренний догон и день 8 |
| `ritual_day_start_hour` | int | `4` | Граница ритуальной даты (04:00) |
| `evening_window_lead_min` | int | `60` | Насколько раньше `{time}` открывается вечернее окно |
| `long_text_threshold` | int | `60` | Длина «человек делится» |
| `quiz_after_enabled` | bool | `1` | Предлагать ли повторный тест после 7-го вечера |

### 2.5 Правила работы с БД (обязательные для всех)

1. **`better-sqlite3` синхронен. Внутри `db.transaction(...)` не может быть ни одного `await`.** Паттерн любого шага диалога — три такта: (1) транзакция «проверить шаг + записать состояние + `prompt_sent_at`», (2) `await` вызовов Telegram, (3) транзакция «записать `*_msg_id`, `practice_sent_at`, `plays`, событие». Если между (1) и (2) процесс упал — сообщение не ушло, но состояние сохранено; повторное срабатывание таймера (§4.4) доотправит.
2. Каждое входящее обновление обрабатывается **последовательно для одного пользователя**: `Sender`/`flow` берут пер-пользовательский мьютекс (`Map<userId, Promise>`), иначе два быстрых тапа дадут две практики. Глобального мьютекса нет.
3. Все `INSERT`/`UPDATE` пишут `updated_at`. Ни один модуль не пишет в чужие таблицы напрямую — только через репозиторий из `src/db/`.
4. `PRAGMA foreign_keys = ON` ставится на соединении; про это забывают.
5. Бэкап: `scripts/backup-db.ts` делает `VACUUM INTO 'data/backups/<unix>.db'` (безопасно при WAL и работающем процессе), хранит 14 последних. Вызывается из systemd-таймера или вручную.

---

## 3. State-машина

### 3.1 Словарь событий

Всё, что приходит в `flow`, приводится к одному из событий. Разбор — в `src/bot/index.ts`, сама логика — в `src/bot/flow.ts`, и планировщик вызывает те же функции.

| Событие | Откуда | Данные |
|---|---|---|
| `start` | `/start [payload]` | `payload?: string` |
| `number` | текст распознан парсером как 0–10 | `value: 0..10` |
| `text` | любой другой текст/медиа | `raw: string`, `kind: 'text'\|'media'` |
| `btn.<id>` | нажата reply-кнопка (сопоставление по актуальной подписи из `texts`) | `id`: `practice_now\|not_today\|better_at\|pause\|remind_tomorrow\|resume\|restart\|other_hour\|other_clock` |
| `cb.cat` | inline `cat:<session_id>:<category>` | `sessionId`, `category` |
| `cb.done` | inline `done:<session_id>` | `sessionId` |
| `cb.change_time` | inline `chtime` | — |
| `cb.quiz.start` / `cb.quiz.skip` | inline `qstart` / `qskip` | — |
| `cb.quiz.answer` / `cb.quiz.back` | inline `qa:<q>:<v>` / `qb:<q>` | `q`, `value` |
| `due.<kind>` | планировщик | `kind` см. §4.2 |
| `blocked403` | Telegram вернул 403 на любой отправке | — |

Правило приоритета для входящего текста: (1) команда → (2) подпись активной кнопки → (3) слово паузы (`пауза|стоп|хватит|не сейчас`, регистронезависимо, целиком) → (4) цифра, если состояние её ждёт → (5) свободный текст.

### 3.2 Таблица переходов (полная)

`D:` — что записывается в `due_at`/`due_kind`. Всё локальное время считается через `tz_offset_min`. Значения сроков в демо — §3.4 и `src/timings.ts`.

| # | Состояние | Событие | Условие | Действие | Новое состояние | D: |
|---|---|---|---|---|---|---|
| 1 | `new` | `start` / любое | — | создать пользователя; payload `^q(\d{1,2})$` и 0≤n≤70 → `quiz_sum/quiz_index/quiz_at`, событие `quiz_in`; `onb.welcome` → пауза 1,2 с + `typing` → `onb.quiz_index` (если индекс есть) → `onb.hour_ask` [R: часы] | `onb_hour` | — |
| 2 | `onb_hour` | `text`/`btn.other_hour` | час распознан | `evening_time`; `onb.clock_ask` [R: три времени] | `onb_clock` | — |
| 3 | `onb_hour` | `text` | не распознан | `onb.hour_retry` | `onb_hour` | — |
| 4 | `onb_clock` | `text` | время распознано, смещение ∈ [−720,840] | `tz_offset_min = round15(t_local − message.date)`; событие `started`; уведомление `admin.started` | ↓ см. 5/6 | ↓ |
| 5 | ↳ | | вечернее окно открыто **и** вечер на текущую ритуальную дату не засчитан | `onb.done_now` + шаг 0 ритуала (строки 12–13), клавиатура цифр + ряд «Лучше в {time}» | `awaiting_before` | 04:00 локально, `skip_deadline` |
| 6 | ↳ | | иначе | `onb.done_later` [R: «Практика сейчас»] | `idle` | ближайшее `{time}`, `ping` |
| 7 | `awaiting_before` (первый вечер из онбординга) | `btn.better_at` | — | `onb.done_later`; сессия удаляется | `idle` | ближайшее `{time}`, `ping` |
| 8 | `idle` | `due.ping` | ритуальная дата пинга ещё актуальна, `consecutive_skips < autopause_after_skips` | открыть `session{kind:'evening', evening_no: current_evening+1, ritual_date}`; выбрать текст `ev.before*` по §3.3; `prompt_sent_at` до отправки | `awaiting_before` | 04:00 локально, `skip_deadline` |
| 9 | `idle` | `due.ping` | ритуальная дата уже сменилась (сервер лежал) | `consecutive_skips++`, событие `evening_skipped`, **молча** | `idle` | следующее `{time}`, `ping` |
| 10 | `idle` | `due.ping` | `consecutive_skips == autopause_after_skips` | `ev.autopause` [R: «Продолжить»/«Практика сейчас»], событие `autopaused` | `paused` | NULL |
| 11 | `idle` | `due.ping` | внутри активной сессии `kind='now'` | ничего не делать, отложить | `idle` | `now + 60 с`, `ping` |
| 12 | `awaiting_before` | `number` | — | `before_value`, `before_at`; `{ev\|now}.before_ack` (одно сообщение: «Записала: N {bar}» + вопрос категории) [I: 3 категории, порядок по локальному часу: до 14:00 день/тревога/сон, после — сон/тревога/день] | `awaiting_state` | не меняется |
| 13 | `awaiting_before` | `btn.not_today` | `kind='evening'` | сессия `declined`, `not_today_streak++`; `ev.not_today`; при `not_today_streak ≥ 2` вместо него `ev.pause_offer` [R: «Пауза»/«Завтра напомни»] | `idle` | следующее `{time}`, `ping` |
| 14 | `awaiting_before`/`awaiting_state` | `due.skip_deadline` | `kind='evening'` | сессия `abandoned` (введённое «до» сохраняется), `consecutive_skips++`, событие `evening_skipped`, снять inline-кнопки, **ничего не отправлять** | `idle` | сегодняшнее `{time}`, `ping` |
| 15 | `awaiting_before`/`awaiting_state` | `due.now_timeout_before` | `kind='now'` | сессия удаляется (`DELETE`, чтобы не мусорить статистику), восстановить `state_before_now` | прежнее | восстановленный `due_at` |
| 16 | `awaiting_state` | `cb.cat` | `sessionId` совпал с активной, `category IS NULL` (проверка и запись — в одной транзакции) | выбрать практику (§5.9); `edit` сообщения выбора → `ev.state_ack`, кнопки убраны; `sendChatAction upload_voice` 1,5 с; `sendAudio`; в транзакции: `practice_sent_at`, `practice_msg_id`, `plays`, для `evening` — `current_evening = evening_no`, `consecutive_skips = 0`, `not_today_streak = 0`, события `practice_sent` | `practicing` | `practice_sent_at + max(20 мин, duration+2 мин)`, `after_timeout` |
| 17 | `awaiting_state` | `cb.cat` | шаг не совпал / категория уже выбрана | `answerCallbackQuery(cb.expired)`, снять клавиатуру | без изменений | — |
| 18 | `awaiting_state` | `cb.cat` | активных практик нет вовсе | `err.no_practices`, сессия удаляется, уведомление `admin.no_practices`, событие `no_practices` | `state_before_now` / `idle` | прежний |
| 19 | `practicing` | `cb.done` | `sessionId` активен | снять inline «Готово» (`editMessageReplyMarkup`), `{ev\|now}.after` [R: цифры] | `awaiting_after` | 10:00 след. утра (`morning`) / `now`: +3 ч (`now_timeout_after`) |
| 20 | `practicing` | `due.after_timeout` | просрочка < 3 ч | то же, что 19, `after_source` будет `timer` | `awaiting_after` | то же |
| 21 | `practicing` | `due.after_timeout` | просрочка ≥ 3 ч (процесс лежал ночью) | вопрос «после» **не задаём** | `awaiting_after` | 10:00 локально, `morning` |
| 22 | `practicing` | `number` | — | сразу `after_value`, `after_source='early'`, вопрос не задаём → закрытие (строка 23) | как в 23 | как в 23 |
| 23 | `awaiting_after` | `number` | `kind='evening'`, `evening_no < 7` | `after_value`, `after_at`, `after_source`, сессия `done`, событие `evening_done`; `ev.close` = «Записала: {after} {bar}» + `{delta}` + «{dots} Вечер {n} из 7. До завтра.»; при `after_source='morning'` — `ev.delta_morning` и хвост `ev.close_morning_tail` | `idle` | следующее `{time}`, `ping` |
| 24 | `awaiting_after` | `number` | `kind='evening'`, `evening_no = 7` | то же + финал (§3.5) | `completed` | 10:00 след. утра, `day8` |
| 25 | `awaiting_after` | `number` | `kind='now'` | `now.close`, сессия `done`, событие `now_done`, восстановить `state_before_now` | прежнее | восстановленный |
| 26 | `awaiting_after` | `due.morning` | `kind='evening'`, `nudged = 0`, не демо | `ev.morning` [R: цифры], `nudged = 1` | `awaiting_after` | следующее `{time}`, `ping_or_close` |
| 27 | `awaiting_after` | `due.ping_or_close` | пришёл следующий вечер, ответа нет | закрыть сессию `done` с `after_value = NULL` (вечер засчитан, на графике разрыв); если `evening_no = 7` → финал с `final.no_after`; иначе сразу выполнить строку 8 | `awaiting_before`/`completed` | по строке 8 |
| 28 | `awaiting_after` | `due.now_timeout_after` | `kind='now'` | закрыть `done`, `after_value = NULL`, **молча**, восстановить состояние | прежнее | восстановленный |
| 29 | `idle`/`paused`/`completed` | `btn.practice_now` | вечернее окно, вечер на эту ритуальную дату не засчитан, не `paused`, не `completed` (**правило слияния**) | открыть вечернюю сессию как в строке 8, плановый пинг не шлётся | `awaiting_before` | 04:00, `skip_deadline` |
| 30 | `idle`/`paused`/`completed` | `btn.practice_now` | иначе | `state_before_now = state`, открыть `session{kind:'now'}`, `now.before` | `awaiting_before` | +30 мин, `now_timeout_before` |
| 31 | `awaiting_after` | `btn.practice_now` | — | `now.finish_first` | без изменений | — |
| 32 | любое ожидание | `text` = слово паузы | — | закрыть сессию (`awaiting_before`/`awaiting_state` → `declined`; `practicing`/`awaiting_after` → `done` с `after_value = NULL`); `pause.on`, `paused_at`, событие `paused` | `paused` | NULL |
| 33 | `paused` | `btn.resume` | вечернее окно и вечер не засчитан | `consecutive_skips = 0`; шаг 0 ритуала | `awaiting_before` | 04:00, `skip_deadline` |
| 34 | `paused` | `btn.resume` | иначе | `consecutive_skips = 0`; `pause.off`, событие `resumed` | `idle` | следующее `{time}`, `ping` |
| 35 | `completed` | `due.day8` | `day8_sent = 0` | `final.day8` [I URL: «Мой канал», если задан] [R: «Практика сейчас»/«Ещё семь вечеров»], `day8_sent = 1`, событие `day8` | `completed` | **NULL** (дальше бот молчит навсегда) |
| 36 | `completed` | `btn.restart` | `settings.allow_restart` | `run_no++`, `current_evening = 0`, `consecutive_skips = 0`, `not_today_streak = 0`, `day8_sent = 0`, `quiz_after_declined = 0`, `completed_at = NULL`, событие `restarted`; `restart.done`; дальше как строки 5/6 | `idle`/`awaiting_before` | как 5/6 |
| 37 | `idle`/`paused`/`completed` | `cb.change_time` | — | `time.hour_ask` [R: часы] | `change_hour` | сохраняется |
| 38 | `change_hour` | `text` | час распознан | `time.clock_ask` [R: три времени] | `change_clock` | — |
| 39 | `change_clock` | `text` | время распознано | `tz_offset_min`, `time.done`, событие `hour_changed`, пересчёт `due_at` | `idle` | ближайшее `{time}`, `ping` |
| 40 | любое | `start` | состояние ≠ `new` | `reprompt` (§3.6): в `idle`/`paused`/`completed` — `start.*` [I: «Поменять время»]; внутри сессии — повтор канонического вопроса. Прогресс не сбрасывается, payload с индексом не перезаписывает `quiz_sum` (пишем событие `quiz_in`) | без изменений | без изменений |
| 41 | любое | `blocked403` | — | `state_before_block = state`, `blocked_at`, активная сессия → `done`/`declined`, уведомление `admin.blocked`, событие `blocked` | `blocked` | NULL |
| 42 | `blocked` | любое входящее | — | восстановить `state_before_block`, событие `unblocked`, пересчитать `due_at` как при «Продолжить» | прежнее | по правилу 33/34 |
| 43 | `completed` | `cb.quiz.start` | `quiz_sum IS NOT NULL`, `quiz_after_enabled` | `quiz_step = 1`, задать вопрос 1 [I: 0–5 / 6–10] | `quiz_after` | NULL |
| 44 | `completed` | `cb.quiz.skip` | — | `quiz_after_declined = 1`, сообщение не шлём, клавиатуру снять | `completed` | без изменений |
| 45 | `quiz_after` | `cb.quiz.answer` | `q == quiz_step` | записать `quiz_answers(phase='after')`, `quiz_step++`; `q < 7` → следующий вопрос [I: цифры] [I: «Назад»] | `quiz_after` | NULL |
| 46 | `quiz_after` | `cb.quiz.answer` | `q == 7` | посчитать сумму и индекс, `quiz_sum_after/quiz_index_after/quiz_after_at`, событие `quiz_after_done`; «Было {quiz_index}. Стало {quiz_index_after}.» + текст результата + `quiz.disclaimer` | `completed` | без изменений |
| 47 | `quiz_after` | `cb.quiz.back` | `q > 1` | `quiz_step = q − 1`, удалить ответ на `q−1`, переспросить | `quiz_after` | — |
| 48 | `quiz_after` | любое входящее (не кнопка теста) | `quiz_resume_offered = 0`, прошло ≥ 1 ч | один раз: «Осталось {k} вопроса. Продолжим?» [I: «Продолжить тест»/«Не сейчас»], `quiz_resume_offered = 1` | `quiz_after` | — |
| 49 | `awaiting_before`/`awaiting_after` | `text`, не цифра | — | `num.fraction` / `num.range` / `num.not_number` / `num.long_text` по §2.6 design-bot; клавиатура цифр остаётся; текст пишется в `messages` | без изменений | без изменений |
| 50 | `awaiting_state` | `text`/`number` | — | повторить `*.before_ack` с кнопками категорий | `awaiting_state` | — |
| 51 | `practicing` | `text` | — | `free.practicing` | `practicing` | — |
| 52 | `idle`/`paused`/`completed` | `text` | — | `free.idle` / `free.paused` / `free.completed`; в `messages`; длина > `long_text_threshold` → уведомление `admin.message` | без изменений | — |
| 53 | любое | `text` длиной > `long_text_threshold` в ожидании цифры | — | `num.long_text`, запись в `messages`, уведомление `admin.message` | без изменений | — |
| 54 | любое | `/whoami` | — | ответить своим `tg_id` и `users.id` | без изменений | — |
| 55 | любое | `/demo <secret>` | секрет совпал | `demo = 1`, `demo_day_counter = 0`, `demo.on`, событие `demo_on`; `due_at` пересчитывается по демо-срокам | без изменений | пересчёт |
| 56 | любое | `/reset <secret>` | секрет совпал | удалить пользователя каскадом, ответить «Готово», следующий `/start` = новый человек | `new` | NULL |

### 3.3 Выбор текста пинга (строка 8)

```
evening_no == 1                     → ev.before_first
evening_no == 4                     → ev.before_half
evening_no == 7                     → ev.before_last
consecutive_skips == 1              → ev.before_after_skip
consecutive_skips >= 2              → ev.before_after_skips
иначе                               → ev.before
```
Приоритет: пропуски старше «номерных» вариантов, кроме `evening_no == 7` (последний вечер важнее).

### 3.4 Сроки: обычный режим против демо (`src/timings.ts`)

| Параметр | Обычный | Демо |
|---|---|---|
| `afterTimeout(duration)` | `max(20 мин, duration + 2 мин)` | 60 с |
| `skipDeadline` | ближайшие 04:00 локально | `now + 5 мин` |
| `nextEvening` | ближайшее `{time}` следующей ритуальной даты | `now + 2 мин` |
| `nowBeforeTimeout` | 30 мин | 2 мин |
| `nowAfterTimeout` | 3 ч | 3 мин |
| `morningAt` | ближайшие `settings.morning_hour` локально | `null` (утреннего догона нет) |
| `day8At` | 10:00 следующего утра | `now + 2 мин` |
| `silenceHours` | 72 | не шлём |
| `eveningWindow(at)` | `[{time} − 60 мин; 03:59]` локально | всегда `true` |
| `ritualDate(at)` | локальная дата `at − 4 ч` | `'demo-' + demo_day_counter` |

`demo_day_counter` увеличивается на 1 при каждом закрытии вечера (строки 23/24) и при пропуске (строка 14). Инвариант «один засчитанный вечер на ритуальную дату» продолжает работать благодаря тому же уникальному индексу.

### 3.5 Финал седьмого вечера (строка 24, развёрнуто)

1. `final.close` — «Записала: {after} {bar}» + `{delta}`.
2. `sendChatAction: upload_photo`, пауза 2 с.
3. `chart.data.chartData(userId, run_no)` → `chart.svg.buildChartSvg` → `chart.render.renderPng` → `sendPhoto(buffer, caption = final.chart_caption)`. `{first_before}` = `before_value` вечера 1, иначе первый непустой; `{last_after}` = `after_value` вечера 7, иначе последний непустой; если непустых `after` нет вовсе — подпись `final.no_after`.
4. Пауза 3 с → `final.invite` [I URL: «Записаться на разговор», только если `settings.talk_url` не пуст].
5. Если `quiz_sum IS NOT NULL` и `quiz_after_enabled` и `quiz_after_declined = 0` — **отдельным** сообщением предложение повторить тест [I: «Пройти семь вопросов»/«Не сейчас»].
6. `state = 'completed'`, `completed_at`, событие `finished`, уведомление `admin.finished`, `due_at` = 10:00 следующего утра, `due_kind = 'day8'`.

Если график не отрендерился (исключение resvg) — шаги 1, 4, 5 всё равно выполняются, вместо картинки уходит текст `final.chart_caption` без вложения, в лог — `error`, владельцу — уведомление `message` с пометкой. Финал не должен падать целиком из-за картинки.

### 3.6 `reprompt(user)` — канонический вопрос состояния

| Состояние | Что переотправляем |
|---|---|
| `onb_hour` | `onb.hour_ask` + клавиатура часов |
| `onb_clock` | `onb.clock_ask` + три кнопки времени (пересчитанные на сейчас) |
| `awaiting_before` | текст пинга по §3.3 (или `now.before`) + цифры |
| `awaiting_state` | `*.before_ack` + inline-категории (новое сообщение, старое чистим) |
| `practicing` | `free.practicing` (аудио не переотправляем — оно выше в чате) |
| `awaiting_after` | `*.after` + цифры |
| `paused` | `start.paused` |
| `completed` | `start.completed` |
| `idle` | `start.idle` [I: «Поменять время»] |

`reprompt` — единственный способ ответить на `/start` внутри сессии, на «нажал старую кнопку», и на восстановление после сбоя. Отдельной логики для этих случаев не пишем.

---

## 4. Планировщик

### 4.1 Цикл

```
startScheduler(ctx):
  каждые SCHEDULER_TICK_MS (по умолчанию 30_000):
    if (tickRunning) return           // тики не наслаиваются
    tickRunning = true
    try { await tick(ctx, ctx.clock.now()) } finally { tickRunning = false }
  каждые 5 минут: await sweeps(ctx)   // молчание + очередь уведомлений + чистка admin_sessions
```

`tick(ctx, now)`:

```
rows = SELECT * FROM users
       WHERE due_at IS NOT NULL AND due_at <= :now AND state <> 'blocked'
       ORDER BY due_at LIMIT 200
for (user of rows):
   claimed = claim(user)      // см. 4.4; транзакция
   if (!claimed) continue
   await withUserLock(user.id, () => handleDue(ctx, user, claimed.due_kind, now))
```

Обработка одного пользователя не должна блокировать остальных дольше, чем нужно: `handleDue` вызывается последовательно (Telegram всё равно ограничивает ~30 сообщений/с), но ошибка одного пользователя не прерывает цикл — она логируется и уходит в `due_attempts`.

### 4.2 Значения `due_kind` и диспетчер

| `due_kind` | Ожидаемое состояние | Обработчик |
|---|---|---|
| `ping` | `idle` | строки 8–11 |
| `skip_deadline` | `awaiting_before`, `awaiting_state` | строка 14 |
| `after_timeout` | `practicing` | строки 20–21 |
| `morning` | `awaiting_after` | строка 26 |
| `ping_or_close` | `awaiting_after` | строка 27 |
| `now_timeout_before` | `awaiting_before`/`awaiting_state` (`kind='now'`) | строка 15 |
| `now_timeout_after` | `awaiting_after` (`kind='now'`) | строка 28 |
| `day8` | `completed` | строка 35 |
| `retry` | любое | повторить то, что не удалось (см. 4.4) |

**Если `due_kind` не соответствует текущему состоянию** (рассинхрон после ручной правки в админке или бага) — планировщик не выполняет действие, а **самолечится**: пишет `warn`, вызывает `plan.recompute(user)` и ставит корректный `due_at`/`due_kind`. Диспетчер идёт по `due_kind`, состояние — сторож.

### 4.3 Как считается локальное время

```ts
localSec(user, utcSec)  = utcSec + user.tz_offset_min * 60
localParts(user, utcSec)= разбор localSec как UTC-даты (getUTC*) — никакого Date-с-часовым-поясом машины
ritualDate(user, utcSec)= toISODate(localSec(user, utcSec) − 4*3600)   // 'YYYY-MM-DD'
atLocalHm(user, dayIso, 'HH:MM') = обратное преобразование в UTC
nextEveningAt(user, from):
   cand = atLocalHm(user, ritualDateOf(from), evening_time)
   if (cand <= from) cand = cand + 86400   // на следующую ритуальную дату
   return cand
```
Ни одна функция в проекте не использует локальный часовой пояс сервера. Сервер живёт в UTC, `TZ=UTC` прописан в юните. Все вычисления — из `tz_offset_min` пользователя. Летнее время не отслеживается (осознанное ограничение, §6 design-bot).

### 4.4 Идемпотентность и защита от двойной отправки

Четыре независимых рубежа:

1. **Claim в транзакции.** Планировщик не «читает и делает», а сначала забирает задачу:
   ```sql
   UPDATE users
      SET due_at = :now + 120, due_attempts = due_attempts + 1
    WHERE id = :id AND due_at = :seen_due_at;     -- optimistic lock по значению
   ```
   Если `changes = 0` — задачу уже забрал кто-то другой (или пользователь только что сам ответил и переставил таймер) → пропускаем. Успешный обработчик в конце ставит настоящий `due_at`/`due_kind` и обнуляет `due_attempts`. Упавший — оставляет `now + 120`, и через 2 минуты попытка повторится (`due_kind` сохраняется). После `due_attempts >= 5` таймер гасится (`due_at = NULL`), пишется `error`, владельцу уходит уведомление `message` с пометкой «таймер отключён».
2. **`prompt_sent_at` до вызова Telegram.** Перед `sendMessage` в транзакции пишется `sessions.prompt_sent_at = now`. Если Telegram ответил сетевой ошибкой (не 403) — `prompt_sent_at` сбрасывается в `NULL` и срабатывает пункт 1. Если процесс упал между записью и отправкой — при повторе увидим `prompt_sent_at IS NOT NULL`, но состояние `awaiting_before` и сообщения у человека нет; поэтому повтор пинга разрешён, но **только если `prompt_sent_at` старше 10 минут** — иначе считаем, что сообщение ушло.
3. **Уникальный индекс `sessions_one_evening_per_ritual_date`.** Две параллельные попытки отправить практику на одну дату физически не пройдут: вторая транзакция получит `SQLITE_CONSTRAINT`, обработчик поймает и ответит `cb.expired`.
4. **Проверка шага в `UPDATE ... WHERE`.** Любой переход, который «тратит» шаг, пишется условным апдейтом (`WHERE id = ? AND category IS NULL`, `WHERE id = ? AND status = 'active'`, `WHERE id = ? AND state = ?`). `changes = 0` → шаг уже сделан, ответ — `cb.expired`. Это закрывает дабл-тап по категории и по «Готово».

### 4.5 Перезапуск процесса

При старте `src/index.ts` выполняет **recovery-проход** до запуска long polling:

1. Миграции, синк практик, загрузка текстов.
2. `SELECT * FROM users WHERE due_at IS NOT NULL AND due_at <= now` — просроченное не выполняется пачкой «как будто вовремя», а проходит через обычный `handleDue`, где действуют правила строк 9 (дата сменилась → молча пропуск) и 21 (просрочка ≥ 3 ч → не задавать ночной вопрос утром).
3. `SELECT * FROM sessions WHERE status='active'` — у каждой активной сессии сверяется `users.active_session_id`; расхождение чинится в пользу самой свежей сессии, остальные закрываются как `abandoned`.
4. `grammy` запускается с `drop_pending_updates: false` — накопленные за простой ответы обрабатываются (человек мог прислать цифру, пока сервер лежал), но `dropOldUpdates`: обновления старше 24 ч игнорируются на уровне middleware (Telegram и так хранит 24 ч).
5. Long polling — ровно один экземпляр. Второй получит `409 Conflict`; при `409` процесс **завершается с кодом 1** вместо бесконечных ретраев, чтобы systemd не держал два бота (`Restart=always` поднимет заново уже после того, как первый умрёт).

### 4.6 Sweeps (раз в 5 минут)

```sql
-- молчание: один раз на одну серию
SELECT id, tg_id, current_evening, last_seen_at FROM users
 WHERE state IN ('idle','awaiting_before','awaiting_state','practicing','awaiting_after')
   AND demo = 0
   AND last_seen_at IS NOT NULL
   AND last_seen_at < :now - :silence_hours * 3600
   AND (silent_notified_for IS NULL OR silent_notified_for <> last_seen_at);
-- на каждого: enqueueNotification('silent', dedup_key = 'silent:<id>:<last_seen_at>')
--             UPDATE users SET silent_notified_for = last_seen_at WHERE id = ?
```
Плюс: отправка `notifications WHERE sent_at IS NULL` всем `admin_tg_ids` (успех → `sent_at`, ошибка → `attempts++`, `last_error`; после 5 попыток — только лог); удаление `admin_sessions WHERE expires_at < now`; раз в сутки — `backup-db`.

---

## 5. Интерфейсы модулей (TypeScript)

Сигнатуры ниже — контракт. Их можно дополнять новыми функциями, но нельзя менять имена и порядок аргументов существующих без правки этого документа. Все функции синхронные, кроме тех, что ходят в сеть (`Promise<…>`).

### 5.1 `src/ctx.ts` — единственный источник зависимостей

```ts
export type Ctx = {
  db: Database                 // better-sqlite3
  cfg: Env                     // src/env.ts
  clock: Clock                 // src/clock.ts
  log: Logger                  // src/log.ts
  texts: Texts                 // src/texts.ts
  send: Sender                 // src/bot/send.ts
  settings: SettingsStore      // src/db/settings.ts
  repo: Repos                  // все репозитории одним объектом
}

export type Repos = {
  users: UsersRepo; sessions: SessionsRepo; practices: PracticesRepo; plays: PlaysRepo
  events: EventsRepo; messages: MessagesRepo; quiz: QuizRepo
  notifications: NotificationsRepo; adminSessions: AdminSessionsRepo; stats: StatsRepo
}

export function createCtx(opts?: Partial<Ctx>): Ctx   // тесты подменяют clock и send
```
**Ни один модуль не импортирует БД или бота напрямую** — только `Ctx` первым аргументом. Это то, что делает тесты возможными.

```ts
// src/clock.ts
export type Clock = {
  now(): number                        // unix-секунды UTC
  sleep(ms: number): Promise<void>     // в тестах — мгновенно
}
export const systemClock: Clock
export function fakeClock(startUnix: number): Clock & { advance(sec: number): void; setNow(s: number): void }
```

### 5.2 `src/env.ts`

```ts
export type Env = {
  telegramBotToken: string
  adminPassword: string
  port: number                 // 3700
  bindHost: string             // '100.91.124.2'
  adminTgIds: number[]         // из ADMIN_TG_IDS
  dataDir: string              // './data'
  dbPath: string               // `${dataDir}/seven-nights.db`
  contentDir: string           // './content'
  schedulerTickMs: number      // 30000
  demoDefault: boolean
  adminCookieSecure: boolean
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  botUsername: string          // 'ensoma_robot' — для ссылок в админке
}
export function loadEnv(source?: NodeJS.ProcessEnv): Env   // бросает на отсутствующем токене/пароле
```

### 5.3 `src/db/types.ts` — строки таблиц

```ts
export type UserState =
  | 'new' | 'onb_hour' | 'onb_clock' | 'idle' | 'awaiting_before' | 'awaiting_state'
  | 'practicing' | 'awaiting_after' | 'paused' | 'completed' | 'blocked'
  | 'change_hour' | 'change_clock' | 'quiz_after'

export type DueKind =
  | 'ping' | 'skip_deadline' | 'after_timeout' | 'morning' | 'ping_or_close'
  | 'now_timeout_before' | 'now_timeout_after' | 'day8' | 'retry'

export type Category = 'sleep' | 'stress' | 'day'
export type SessionKind = 'evening' | 'now'
export type SessionStatus = 'active' | 'done' | 'abandoned' | 'declined'
export type AfterSource = 'button' | 'timer' | 'early' | 'morning'

export type UserRow = { id: number; tg_id: number; language_code: string | null
  tz_offset_min: number; evening_time: string; state: UserState
  state_before_now: UserState | null; state_before_block: UserState | null
  due_at: number | null; due_kind: DueKind | null; due_attempts: number
  active_session_id: number | null; run_no: number; current_evening: number
  consecutive_skips: number; not_today_streak: number; day8_sent: 0 | 1
  demo: 0 | 1; demo_day_counter: number
  quiz_sum: number | null; quiz_index: number | null; quiz_at: number | null
  quiz_sum_after: number | null; quiz_index_after: number | null; quiz_after_at: number | null
  quiz_after_declined: 0 | 1; quiz_step: number; quiz_resume_offered: 0 | 1
  start_payload: string | null; last_seen_at: number | null; silent_notified_for: number | null
  paused_at: number | null; blocked_at: number | null; completed_at: number | null
  created_at: number; updated_at: number }

export type SessionRow = { id: number; user_id: number; run_no: number; kind: SessionKind
  evening_no: number | null; ritual_date: string; category: Category | null
  practice_id: number | null; before_value: number | null; before_at: number | null
  after_value: number | null; after_at: number | null; after_source: AfterSource | null
  nudged: 0 | 1; status: SessionStatus; prompt_msg_id: number | null
  choice_msg_id: number | null; practice_msg_id: number | null
  prompt_sent_at: number | null; practice_sent_at: number | null
  closed_at: number | null; created_at: number }

export type PracticeRow = { id: number; slug: string; category: Category; title: string
  line1: string; line2: string; audio_path: string | null; audio_sha256: string | null
  audio_bytes: number | null; duration_sec: number | null; tg_file_id: string | null
  tg_file_unique_id: string | null; sort_order: number; active: 0 | 1
  origin: 'file' | 'admin'; script_hash: string | null; created_at: number; updated_at: number }
```

### 5.4 Репозитории (`src/db/*.ts`)

```ts
// users.ts
export type UsersRepo = {
  byTgId(tgId: number): UserRow | undefined
  byId(id: number): UserRow | undefined
  create(tgId: number, langCode: string | null, now: number): UserRow
  update(id: number, patch: Partial<UserRow>): void            // всегда дописывает updated_at
  setState(id: number, state: UserState, due: { at: number | null; kind: DueKind | null }): void
  /** Оптимистичный захват таймера планировщиком: true, если due_at совпал и сдвинут. */
  claimDue(id: number, seenDueAt: number, parkUntil: number): boolean
  clearDue(id: number): void
  due(now: number, limit: number): UserRow[]
  touchSeen(id: number, now: number): void                     // last_seen_at + сброс silent_notified_for
  listForAdmin(q: AdminUserQuery): { rows: AdminUserRow[]; total: number }
  deleteCascade(id: number): void                              // /reset
}

// sessions.ts
export type SessionsRepo = {
  active(userId: number): SessionRow | undefined
  byId(id: number): SessionRow | undefined
  open(input: { userId: number; runNo: number; kind: SessionKind; eveningNo: number | null
                ritualDate: string; now: number }): SessionRow
  /** Все «шаговые» апдейты — условные; false = шаг уже сделан кем-то другим. */
  setBefore(id: number, value: number, at: number): boolean            // WHERE before_value IS NULL
  setCategory(id: number, category: Category, practiceId: number): boolean  // WHERE category IS NULL
  markPracticeSent(id: number, msgId: number, at: number): boolean     // WHERE practice_sent_at IS NULL
  setAfter(id: number, value: number, source: AfterSource, at: number): boolean
  close(id: number, status: SessionStatus, at: number): void
  setPromptSent(id: number, at: number | null, msgId?: number | null): void
  setChoiceMsg(id: number, msgId: number): void
  setNudged(id: number): void
  countedOn(userId: number, ritualDate: string): boolean               // вечер на эту дату засчитан?
  runSessions(userId: number, runNo: number): SessionRow[]             // для графика и карточки
  listForUser(userId: number, limit?: number): SessionRow[]
  deleteSession(id: number): void                                      // только для kind='now' по таймауту
}

// practices.ts / plays.ts
export type PracticesRepo = {
  byId(id: number): PracticeRow | undefined
  bySlug(slug: string): PracticeRow | undefined
  listActive(category?: Category): PracticeRow[]
  listAll(): PracticeRow[]
  upsertFromFile(p: { slug: string; category: Category; title: string; line1: string
                      line2: string; scriptHash: string; now: number }): void  // не трогает origin='admin'
  setAudio(id: number, a: { path: string; sha256: string; bytes: number; durationSec: number }): void
  setFileId(id: number, fileId: string, uniqueId: string | null): void
  clearFileId(id: number): void
  updateFromAdmin(id: number, patch: Partial<PracticeRow>): void       // ставит origin='admin'
  create(p: Omit<PracticeRow, 'id' | 'created_at' | 'updated_at'>): PracticeRow
  reorder(order: Array<{ id: number; sort_order: number }>): void
}
export type PlaysRepo = {
  add(userId: number, practiceId: number, sessionId: number | null, at: number): void
  statsFor(userId: number, category: Category): Array<{ practice_id: number; plays: number; last_at: number }>
}

// events.ts / messages.ts / quiz.ts / notifications.ts
export type EventsRepo = {
  add(userId: number | null, type: string, payload?: object, sessionId?: number | null): void
  listForUser(userId: number, limit?: number): EventRow[]
  list(q: { type?: string; from?: number; to?: number; limit: number; offset: number }): EventRow[]
}
export type MessagesRepo = {
  add(userId: number, text: string, state: UserState, sessionId: number | null, at: number): number
  listForUser(userId: number, limit?: number): MessageRow[]
  recent(limit: number): Array<MessageRow & { user_id: number }>
}
export type QuizRepo = {
  setIncoming(userId: number, sum: number, at: number): void
  saveAnswer(userId: number, runNo: number, phase: 'before' | 'after', q: number, v: number, at: number): void
  deleteAnswer(userId: number, runNo: number, phase: 'after', q: number): void
  answers(userId: number, runNo: number, phase: 'before' | 'after'): number[]   // индекс 0 = вопрос 1
  finishAfter(userId: number, sum: number, at: number): void
}
export type NotificationsRepo = {
  enqueue(n: { userId: number | null; type: string; dedupKey: string; text: string; now: number }): boolean // false = дубль
  pending(limit: number): NotificationRow[]
  markSent(id: number, at: number): void
  markFailed(id: number, error: string): void
}
```

### 5.5 `src/bot/send.ts` — единственная дверь в Telegram API

```ts
export type Kb = { reply?: string[][]; inline?: Array<Array<{ text: string; data?: string; url?: string }>>
                   removeReply?: boolean; oneTime?: boolean }

export type Sender = {
  /** Рендерит текст по ключу из texts и отправляет. Возвращает message_id. */
  text(user: UserRow, key: string, vars?: Record<string, string | number>, kb?: Kb): Promise<number>
  /** Готовая строка (тест, результат квиза — там текст собирается из нескольких ключей). */
  raw(user: UserRow, text: string, kb?: Kb): Promise<number>
  audio(user: UserRow, p: PracticeRow, caption: string, kb?: Kb): Promise<{ msgId: number; fileId: string }>
  photo(user: UserRow, png: Buffer, caption: string, kb?: Kb): Promise<number>
  editText(user: UserRow, msgId: number, text: string, kb?: Kb): Promise<void>
  clearInline(user: UserRow, msgId: number): Promise<void>       // ошибки «message is not modified» глотаются
  action(user: UserRow, a: 'typing' | 'upload_voice' | 'upload_photo'): Promise<void>
  answerCallback(cbId: string, textKey?: string): Promise<void>
  toAdmins(text: string): Promise<void>
}
export function createSender(ctx: Ctx, api: Api): Sender
```
Правила внутри `Sender`, которые больше нигде не дублируются:
- **403 / «bot was blocked» / «user is deactivated»** → выполняет переход строки 41 и бросает `BlockedError`; вызывающий код ловит и выходит молча.
- **429** → ждёт `retry_after + 1` и повторяет один раз.
- Прочие ошибки сети → до 3 попыток с задержками 1/3/9 с, потом бросает.
- Любая успешная отправка `audio` кэширует `file_id`; ошибка с текстом про `wrong file identifier`/`file reference expired` → `clearFileId` и одна повторная отправка файлом с диска.
- Экранирование: тексты отправляются **без** `parse_mode` (никакого Markdown — в текстах есть кавычки-ёлочки и тире, любая разметка когда-нибудь сломает отправку).

### 5.6 `src/bot/flow.ts` — ядро (то, что зовут и бот, и планировщик)

```ts
export type Trigger =
  | { t: 'start'; payload?: string }
  | { t: 'number'; value: number }
  | { t: 'text'; raw: string; isMedia?: boolean }
  | { t: 'button'; id: ButtonId }
  | { t: 'cb'; action: 'cat' | 'done' | 'change_time' | 'quiz_start' | 'quiz_skip'
                       | 'quiz_answer' | 'quiz_back' | 'quiz_resume'
      sessionId?: number; category?: Category; q?: number; value?: number; cbId: string }
  | { t: 'due'; kind: DueKind }

/** Единственная точка входа. Внутри: пер-пользовательский лок, try/catch BlockedError, лог перехода. */
export async function handle(ctx: Ctx, user: UserRow, trg: Trigger, now: number): Promise<void>

// Строительные блоки, которые handle вызывает (экспортируются для тестов и для планировщика):
export async function startEvening(ctx: Ctx, u: UserRow, eveningNo: number, now: number,
                                   opts?: { fromOnboarding?: boolean }): Promise<void>
export async function startNow(ctx: Ctx, u: UserRow, now: number): Promise<void>
export async function acceptBefore(ctx: Ctx, u: UserRow, s: SessionRow, v: number, now: number): Promise<void>
export async function deliverPractice(ctx: Ctx, u: UserRow, s: SessionRow, c: Category, now: number): Promise<void>
export async function askAfter(ctx: Ctx, u: UserRow, s: SessionRow, now: number): Promise<void>
export async function acceptAfter(ctx: Ctx, u: UserRow, s: SessionRow, v: number,
                                  src: AfterSource, now: number): Promise<void>
export async function finale(ctx: Ctx, u: UserRow, s: SessionRow, now: number): Promise<void>
export async function skipEvening(ctx: Ctx, u: UserRow, s: SessionRow | null, now: number): Promise<void>
export async function pause(ctx: Ctx, u: UserRow, reason: 'button'|'text'|'auto', now: number): Promise<void>
export async function resume(ctx: Ctx, u: UserRow, now: number): Promise<void>
export async function reprompt(ctx: Ctx, u: UserRow, now: number): Promise<void>
export function mergeRule(ctx: Ctx, u: UserRow, now: number): 'evening' | 'now'   // §2.3 design-bot
```

### 5.7 Время, сроки, парсеры

```ts
// src/time.ts
export function localSec(u: UserRow, utc: number): number
export function localHm(u: UserRow, utc: number): { h: number; m: number }
export function ritualDate(u: UserRow, utc: number): string           // 'YYYY-MM-DD' | 'demo-<n>'
export function atLocalHm(u: UserRow, dateIso: string, hm: string): number
export function nextEveningAt(u: UserRow, from: number): number
export function endOfRitualDay(u: UserRow, from: number): number      // ближайшие 04:00 локально
export function nextMorningAt(u: UserRow, from: number, hm: string): number
export function isEveningWindow(u: UserRow, at: number, leadMin: number): boolean
export function whenWord(u: UserRow, target: number, now: number): 'сегодня' | 'завтра'
export function fmtHm(sec: number, offsetMin: number): string         // '18:42'

// src/timings.ts
export type Timings = {
  afterTimeout(durationSec: number | null): number
  skipDeadline(u: UserRow, now: number): number
  nextEvening(u: UserRow, now: number): number
  nowBeforeTimeout(now: number): number
  nowAfterTimeout(now: number): number
  morningAt(u: UserRow, now: number): number | null
  day8At(u: UserRow, now: number): number
  eveningWindow(u: UserRow, now: number): boolean
  ritualDate(u: UserRow, now: number): string
}
export function timingsFor(ctx: Ctx, u: UserRow): Timings    // обычные или демо

// src/parse.ts — чистые функции, покрыты tests/parse.test.ts
export function parseHour(input: string): { h: number; m: number } | null
export function parseClock(input: string): { h: number; m: number } | null
export function parseNumber(input: string): { value: number } | { error: 'fraction'|'range'|'none'; a?: number; b?: number }
export function parseStartPayload(p: string | undefined): { quizSum: number | null; raw: string | null }
export function isPauseWord(s: string): boolean
export function round15(min: number): number
export function plural(n: number, forms: [string, string, string]): string   // деление/деления/делений
```
`parseHour` принимает `21`, `21:00`, `21.00`, `21 30`, `в 21`, `9 вечера`, `7 утра`; 4–11 без уточнения → +12; 0–3 — как есть. `parseClock` принимает `18:42`, `18.42`, `1842`, `18 42`, `18` (→ 18:00). `parseNumber` понимает `7/10`, `7 из 10`, слова «ноль»…«десять», одно число внутри короткой фразы.

### 5.8 Тексты и клавиатуры

```ts
// src/texts.ts
export type Texts = {
  get(key: string): string
  render(key: string, vars?: Record<string, string | number>): string
  /** По подписи входящего сообщения находит id кнопки (подписи правятся в админке). */
  buttonId(label: string): ButtonId | null
  label(id: ButtonId, vars?: Record<string, string | number>): string
  reload(): void                        // админка сохранила текст → бот подхватывает без рестарта
  validate(key: string, value: string): { ok: true } | { ok: false; error: string; unknown?: string[] }
}
export const DEFAULT_TEXTS: Array<{ key: string; value: string; placeholders: string[]
                                    section: string; hint: string }>   // Приложение А design-bot, дословно
```
`render` подставляет `{n} {time} {when} {before} {after} {d} {bar} {dots} {delta} {line1} {line2} {title} {category} {clock} {id} {tz} {quiz_index} {quiz_sum} {first_before} {last_after} {avg} {a} {b} {деление} {text}`. Неизвестный плейсхолдер в шаблоне при рендере **не падает**, а остаётся как есть и пишется `warn` (валидация — на входе в админке).

```ts
// src/keyboards.ts
export function numbersKb(extra?: { notToday?: boolean; betterAt?: string }): Kb
export function hoursKb(): Kb
export function clockKb(guessOffsetMin: number, now: number): Kb     // три реальных времени ±1 ч
export function categoriesKb(sessionId: number, localHour: number): Kb
export function doneKb(sessionId: number): Kb
export function homeKb(opts?: { resume?: boolean; restart?: boolean }): Kb
export function pauseOfferKb(): Kb
export function urlKb(labelId: ButtonId, url: string): Kb
export function quizKb(q: number, withBack: boolean): Kb             // 0–5 / 6–10 + «Назад»
export function changeTimeKb(): Kb
```
Полоски: `bar(v)` = `'▰'.repeat(v) + '▱'.repeat(10 - v)`; `dots(n)` = `'●'.repeat(n) + '○'.repeat(7 - n)` — в `src/texts.ts`, экспортируются.

### 5.9 Контент и медиа

```ts
// src/content/practices.ts
export function syncPracticesFromFiles(ctx: Ctx): { added: number; updated: number; skipped: number }
// читает content/practices/*.md (frontmatter: slug, title, category, intro[2], duration_hint)
// + content/audio/manifest.json (duration, hash) → practices; строки intro → line1/line2;
// записи с origin='admin' не трогает; отсутствующий mp3 → audio_path = NULL, active не меняем.

// src/content/pick.ts
export function pickPractice(ctx: Ctx, u: UserRow, s: SessionRow, category: Category): PracticeRow | null
// 1) kind='evening' && category='sleep' && settings.sleep_route[evening_no-1] активна → она;
// 2) иначе: min(plays) → min(last_played_at) → sort_order → id;
// 3) категория пуста → любая активная, приоритет sleep; совсем пусто → null.

// src/content/audio.ts
export async function sendPractice(ctx: Ctx, u: UserRow, s: SessionRow, p: PracticeRow,
                                   captionKey: string, vars: Record<string, string|number>): Promise<number>
// title = p.title, performer = «Семь ночей · Вечер {n}» (для now — «Семь ночей»),
// duration = p.duration_sec, thumbnail = assets/cover.jpg (если есть), кнопка «Готово».

// src/chart/*
export type ChartPoint = { evening: number; before: number | null; after: number | null; date: string }
export function chartData(ctx: Ctx, userId: number, runNo: number): ChartPoint[]
export function buildChartSvg(points: ChartPoint[], o: { firstBefore: number | null
  lastAfter: number | null; fromDate: string; toDate: string; botName: string }): string
export function renderPng(svg: string): Buffer         // resvg, шрифты из assets/fonts, loadSystemFonts: false
```

---

## 6. API админки

База — `/api/admin`. Формат — JSON (`Content-Type: application/json; charset=utf-8`), кроме загрузки аудио (multipart) и экспорта (CSV). Ошибки: `{ "error": "<код>", "message": "<по-русски>" }` со статусами 400/401/404/409/413/500. Все ответы `Cache-Control: no-store`.

### 6.1 Авторизация

Пароль один (`ADMIN_PASSWORD` из `.env`), логина нет — это инструмент для двух человек в tailnet.

| Метод | Путь | Тело | Ответ |
|---|---|---|---|
| POST | `/api/admin/login` | `{ "password": "…" }` | 200 `{ ok: true }` + `Set-Cookie: sn_admin=<token>; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000` (+`Secure`, если `ADMIN_COOKIE_SECURE=1`); 401 `{error:'bad_password'}` |
| POST | `/api/admin/logout` | — | 200, удаление строки в `admin_sessions` и куки |
| GET | `/api/admin/me` | — | 200 `{ ok: true, botUsername, version, dbSizeBytes, uptimeSec }` / 401 |

- Токен — `crypto.randomBytes(32).toString('hex')`, живёт 30 дней, `last_seen` обновляется не чаще раза в час.
- Сравнение пароля — `crypto.timingSafeEqual(sha256(input), sha256(expected))`.
- Ограничение попыток: **5 неудач с одного IP за 15 минут** → 429 на 15 минут (счётчик в памяти процесса, этого достаточно).
- Middleware `requireAuth` стоит на всех маршрутах `/api/admin/*`, кроме `login`. SPA по `/admin/*` отдаётся без авторизации (там только код), данные — нет.

### 6.2 Люди и история

| Метод | Путь | Параметры | Ответ |
|---|---|---|---|
| GET | `/api/admin/users` | `?q=<tg_id или #id>&state=&segment=active\|finished\|paused\|stuck\|blocked&sort=last_seen\|created\|evening&dir=asc\|desc&page=1&per=50` | `{ rows: AdminUserRow[], total, page, per }` |
| GET | `/api/admin/users/:id` | — | карточка (ниже) |
| POST | `/api/admin/users/:id/demo` | `{ "on": true }` | `{ ok: true, user }` |
| POST | `/api/admin/users/:id/pause` | `{ "on": true }` | `{ ok: true, user }` — ручная пауза/снятие |
| POST | `/api/admin/users/:id/message` | `{ "text": "…" }` | `{ ok: true, msgId }` — специалист пишет человеку как бот (лимит 1000 симв., пишется в `events` с типом `admin_message`) |
| DELETE | `/api/admin/users/:id` | — | `{ ok: true }` — полное удаление каскадом (право на забвение); требует `?confirm=<tg_id>` |

```ts
type AdminUserRow = {
  id: number; tg_id: number; state: UserState; run_no: number; current_evening: number
  evening_time: string; tz: string                 // 'UTC+3'
  first_before: number | null; last_after: number | null; delta: number | null
  quiz_index: number | null; quiz_index_after: number | null
  sessions_done: number; skips: number; demo: 0|1
  created_at: number; last_seen_at: number | null; completed_at: number | null
}

type AdminUserCard = {
  user: UserRow
  timeline: Array<{                                 // вся история одним списком, по убыванию времени
    at: number
    kind: 'session' | 'event' | 'message' | 'notification'
    title: string                                   // «Вечер 3: 4 → 7», «Пауза», «Написал(а)»
    detail: Record<string, unknown>
  }>
  sessions: Array<SessionRow & { practice_title: string | null; practice_slug: string | null
                                 done_after_sec: number | null }>  // «нажал Готово через N секунд»
  chart: ChartPoint[]                               // текущий круг
  quiz: { before: { sum: number|null; index: number|null; at: number|null; answers: number[] }
          after:  { sum: number|null; index: number|null; at: number|null; answers: number[] } }
  messages: MessageRow[]
}
```
`done_after_sec` = `after_at − practice_sent_at` при `after_source='button'`, иначе `null`.

### 6.3 Практики

| Метод | Путь | Тело | Примечание |
|---|---|---|---|
| GET | `/api/admin/practices` | — | `{ rows: PracticeRow[] & { plays: number } }` |
| POST | `/api/admin/practices` | `{ slug, category, title, line1, line2, sort_order?, active? }` | `slug` — `^[a-z0-9-]{3,40}$`, уникален |
| PATCH | `/api/admin/practices/:id` | любые из `{ category, title, line1, line2, active, sort_order }` | ставит `origin='admin'`; `line1+line2` ≤ 900 символов вместе (подпись к аудио — лимит Telegram 1024, оставляем запас на шаблон) |
| POST | `/api/admin/practices/:id/audio` | `multipart/form-data`, поле `file` | mp3/m4a/ogg, ≤ 50 МБ; сохраняем в `content/audio/<slug>.<ext>`, считаем sha256 и длительность (`ffprobe`), **сбрасываем `tg_file_id`**, пишем `audio_*`. Ответ `{ ok: true, practice }` |
| DELETE | `/api/admin/practices/:id` | — | мягко: `active = 0` (жёсткое удаление запрещено — на практику ссылаются сессии) |
| POST | `/api/admin/practices/reorder` | `{ order: [{id, sort_order}] }` | |
| POST | `/api/admin/practices/:id/preview` | `{ "tg_id": 123 }` | отправить практику себе в Telegram, чтобы услышать, как это выглядит у человека |
| GET | `/media/practices/:slug.mp3` | — | отдача файла для плеера в админке (требует куки) |

Загрузка: `const body = await c.req.parseBody()`; лимит тела — 50 МБ (`bodyLimit` middleware Hono), на превышении 413. Имя файла из формы игнорируется, используем `slug` — так не бывает путей с `../`.

### 6.4 Тексты и настройки

| Метод | Путь | Тело / ответ |
|---|---|---|
| GET | `/api/admin/texts` | `{ rows: [{ key, value, default_value, placeholders, section, hint, updated_at, changed }] }`, сгруппировано по `section` |
| PUT | `/api/admin/texts/:key` | `{ "value": "…" }` → 200 `{ ok, row }`; 400 `{error:'bad_placeholder', unknown:['{foo}']}`; пустая строка запрещена |
| POST | `/api/admin/texts/:key/reset` | вернуть `default_value` |
| GET | `/api/admin/settings` | `{ talk_url, channel_url, admin_tg_ids, allow_restart, sleep_route, demo_secret, … }` |
| PUT | `/api/admin/settings` | частичный объект; валидация: URL начинается с `https://`, `admin_tg_ids` — числа через запятую, `sleep_route` — массив из 7 существующих слагов |

После любого успешного `PUT` текстов/настроек сервер вызывает `ctx.texts.reload()` — бот подхватывает правку мгновенно, рестарт не нужен.

### 6.5 Экспорт

| Путь | Что |
|---|---|
| `GET /api/admin/export/users.csv` | по одной строке на человека: `#id;tg_id;создан;состояние;вечер;время;пояс;до1;после7;прирост;индекс_до;индекс_после;пропусков;последняя_активность` |
| `GET /api/admin/export/sessions.csv` | `#id_участника;круг;тип;вечер;дата;категория;практика;до;после;источник_после;статус;начало;аудио_отправлено;закрыто` |
| `GET /api/admin/export/events.csv` | `дата;#id;тип;payload` |

CSV: BOM `﻿`, разделитель `;`, перевод строки `\r\n`, значения с `;`/кавычками — в двойных кавычках с удвоением. Даты — `YYYY-MM-DD HH:MM` в UTC **и** отдельной колонкой локальное время пользователя, где это про человека. Заголовки — по-русски (файл открывают в Excel).

### 6.6 Статистика — точные формулы

`GET /api/admin/stats?from=<unix>&to=<unix>` (по умолчанию: всё время). Все «люди» считаются по `users.id`, все «вечера» — по `sessions`. Ответ:

```ts
type Stats = {
  funnel: { started: number; finished: number; conversion: number }   // conversion = finished/started
  avgGain: number | null            // средний прирост первый→последний вечер
  stuckAt: Array<{ evening: number; people: number }>   // где чаще всего останавливаются
  reach: Array<{ evening: number; people: number }>     // сколько дошло до каждого вечера
  byEvening: Array<{ evening: number; n: number; avg_before: number; avg_after: number; avg_delta: number }>
  today: { active: number; practices: number; new: number }
  now: { sessions: number; by_category: Array<{ category: Category; n: number }> }
  practices: Array<{ id: number; slug: string; title: string; plays: number; avg_delta: number | null }>
  afterSource: Array<{ source: AfterSource | 'none'; n: number }>
  quiz: { in_avg: number | null; out_avg: number | null; gain: number | null; both: number }
  states: Array<{ state: UserState; n: number }>
  skips: { avg: number; abandoned: number; declined: number; autopaused: number }
}
```

**1. Начали / дошли / конверсия**
```sql
SELECT (SELECT COUNT(DISTINCT user_id) FROM events
         WHERE type='started' AND at BETWEEN :from AND :to)  AS started,
       (SELECT COUNT(DISTINCT user_id) FROM events
         WHERE type='finished' AND at BETWEEN :from AND :to) AS finished;
```
Демо-пользователей исключаем во всех запросах статистики: `AND user_id NOT IN (SELECT id FROM users WHERE demo=1)` — иначе приёмочные прогоны портят цифры. В админке — переключатель «показывать демо».

**2. Средний прирост «первый вечер → последний вечер»** (первый непустой `before`, последний непустой `after`, в пределах круга):
```sql
WITH fb AS (
  SELECT user_id, run_no, before_value,
         ROW_NUMBER() OVER (PARTITION BY user_id, run_no ORDER BY evening_no) AS rn
    FROM sessions
   WHERE kind='evening' AND before_value IS NOT NULL),
la AS (
  SELECT user_id, run_no, after_value,
         ROW_NUMBER() OVER (PARTITION BY user_id, run_no ORDER BY evening_no DESC) AS rn
    FROM sessions
   WHERE kind='evening' AND after_value IS NOT NULL)
SELECT ROUND(AVG(la.after_value - fb.before_value), 2) AS avg_gain,
       COUNT(*) AS people
  FROM fb JOIN la ON la.user_id = fb.user_id AND la.run_no = fb.run_no
 WHERE fb.rn = 1 AND la.rn = 1
   AND fb.user_id IN (SELECT user_id FROM events WHERE type='finished');
```
Для карточки человека и для `{avg}` в `admin.finished` — средний прирост **за вечер**:
```sql
SELECT ROUND(AVG(after_value - before_value), 2) FROM sessions
 WHERE user_id=:id AND run_no=:run AND kind='evening'
   AND before_value IS NOT NULL AND after_value IS NOT NULL;
```

**3. На каком вечере чаще всего останавливаются**
```sql
SELECT current_evening AS evening, COUNT(*) AS people
  FROM users
 WHERE demo = 0
   AND current_evening BETWEEN 1 AND 6
   AND state NOT IN ('completed')
   AND (last_seen_at IS NULL OR last_seen_at < :now - 7*86400)
 GROUP BY current_evening
 ORDER BY people DESC, evening ASC;
```
Первая строка — ответ на вопрос ТЗ. Определение «остановился» = 7 дней без активности и программа не закончена.

**4. Доходимость по вечерам (воронка)**
```sql
SELECT evening_no AS evening, COUNT(DISTINCT user_id) AS people
  FROM sessions
 WHERE kind='evening' AND practice_sent_at IS NOT NULL
 GROUP BY evening_no ORDER BY evening_no;
```

**5. Распределение «до/после» по вечерам**
```sql
SELECT evening_no AS evening, COUNT(*) AS n,
       ROUND(AVG(before_value),2) AS avg_before,
       ROUND(AVG(after_value),2)  AS avg_after,
       ROUND(AVG(CASE WHEN before_value IS NOT NULL AND after_value IS NOT NULL
                      THEN after_value - before_value END),2) AS avg_delta
  FROM sessions
 WHERE kind='evening' AND status='done'
 GROUP BY evening_no ORDER BY evening_no;
```
(в админке рисуется Recharts-графиком «две линии по вечерам» — тем же, что человек видит картинкой)

**6. Активные сегодня** (`:day_start` — 00:00 UTC текущих суток; в UI подписано «по серверу»)
```sql
SELECT (SELECT COUNT(*) FROM users WHERE last_seen_at >= :day_start AND demo=0)            AS active,
       (SELECT COUNT(*) FROM sessions WHERE practice_sent_at >= :day_start)                AS practices,
       (SELECT COUNT(*) FROM users WHERE created_at >= :day_start AND demo=0)              AS new;
```

**7. «Практика сейчас»**
```sql
SELECT COUNT(*) AS n FROM sessions WHERE kind='now' AND practice_sent_at IS NOT NULL;
SELECT category, COUNT(*) AS n FROM sessions
 WHERE kind='now' AND practice_sent_at IS NOT NULL GROUP BY category;
```

**8. Практики: сколько слушали и какой средний сдвиг**
```sql
SELECT p.id, p.slug, p.title, COUNT(s.id) AS plays,
       ROUND(AVG(CASE WHEN s.before_value IS NOT NULL AND s.after_value IS NOT NULL
                      THEN s.after_value - s.before_value END),2) AS avg_delta
  FROM practices p LEFT JOIN sessions s ON s.practice_id = p.id
 GROUP BY p.id ORDER BY plays DESC;
```

**9. Качество замера «после»**
```sql
SELECT COALESCE(after_source,'none') AS source, COUNT(*) AS n
  FROM sessions WHERE kind='evening' AND practice_sent_at IS NOT NULL
 GROUP BY 1 ORDER BY n DESC;
```

**10. Тест «Индекс внутренней опоры»** (только по тем, у кого оба замера)
```sql
SELECT COUNT(*) AS both,
       ROUND(AVG(quiz_index),1)       AS in_avg,
       ROUND(AVG(quiz_index_after),1) AS out_avg,
       ROUND(AVG(quiz_index_after - quiz_index),1) AS gain
  FROM users WHERE quiz_index IS NOT NULL AND quiz_index_after IS NOT NULL AND demo=0;
-- отдельно: средний входной индекс по всем пришедшим с лендинга
SELECT ROUND(AVG(quiz_index),1) FROM users WHERE quiz_index IS NOT NULL AND demo=0;
```

**11. Состояния и пропуски**
```sql
SELECT state, COUNT(*) n FROM users WHERE demo=0 GROUP BY state;
SELECT ROUND(AVG(consecutive_skips),2) FROM users WHERE demo=0;
SELECT status, COUNT(*) FROM sessions WHERE kind='evening' GROUP BY status;  -- abandoned/declined
SELECT COUNT(*) FROM events WHERE type='autopaused';
```

### 6.7 Экраны админки (минимум, чтобы «вся история и статистика» была видна)

1. **Дашборд** — карточки цифр ТЗ (начали, дошли, конверсия, средний прирост, вечер остановки), воронка по вечерам, две линии «до/после» по вечерам, активные сегодня, индекс теста на входе/выходе, последние 20 событий лентой.
2. **Люди** — таблица `AdminUserRow` с фильтрами и поиском, колонка «Индекс» вида `60 → 74`, клик → карточка: полная лента, сессии, график этого человека, его свободные сообщения, кнопки «Демо», «Пауза», «Написать».
3. **Практики** — список с категорией, порядком, плеером, длительностью, числом прослушиваний; формы редактирования двух строк; загрузка mp3 (drag-n-drop); переключатель «активна»; предупреждение «у практики нет аудио».
4. **Тексты** — по разделам, поле, список допустимых плейсхолдеров, кнопка «вернуть как было», отметка «изменено».
5. **Настройки** — ссылки, id администраторов, маршрут сна, `allow_restart`, секрет демо, кнопки «Скачать CSV».

---

## 7. Картинка графика для бота

Цель — артефакт, который не стыдно переслать и положить в сторис: вертикаль 4:5, тёмный тёплый фон, две линии, крупный итог, ноль личных данных.

### 7.1 Геометрия (фиксирована)

| Параметр | Значение |
|---|---|
| Холст | **1200 × 1500** (4:5), PNG |
| Фон | `#14110F`, поверх — радиальный градиент «лампы» из `#2A2119` (30 % прозрачности) с центром `(600, 300)` |
| Заголовок «Семь ночей» | Noto Sans Bold 64, `#F3EAE0`, центр, baseline `y = 150` |
| Подзаголовок (даты) | Regular 32, `#8C8078`, центр, `y = 200`, формат «18 сентября — 24 сентября» |
| Поле графика | `x ∈ [150, 1050]`, `y ∈ [330, 1010]` (ширина 900, высота 680) |
| Сетка | 6 горизонталей (`v = 0,2,4,6,8,10`), `#2B2521`, толщина 1; подписи слева Regular 26 `#6E645C` |
| Ось X | подписи «1»…«7» Regular 30 `#8C8078`, `y = 1060` |
| Линия «до» | `#7C6A58`, толщина 6, точки r = 9, заливка `#14110F`, обводка цветом линии |
| Линия «после» | `#E9B368`, толщина 8, точки r = 11, заливка сплошная; сверху лёгкое свечение (та же линия, толщина 18, `opacity 0.12`) |
| Легенда | две подписи Regular 28 у правого края под заголовком: «до» `#7C6A58`, «после» `#E9B368` |
| Итог | Bold 92 `#F3EAE0`, центр, `y = 1250`: «Было {first} → стало {last}» |
| Подпись | Regular 28 `#6E645C`, центр, `y = 1420`: «@ensoma_robot» |

Координаты:
```
x(evening) = 150 + (evening - 1) * 150            // 7 точек, шаг 150
y(value)   = 1010 - (value / 10) * 680            // 0 внизу, 10 наверху
```

### 7.2 Правила отрисовки данных

- `null` — **разрыв**, а не ноль. Путь строится сегментами: подряд идущие непустые точки соединяются, на `null` линия прерывается. Одиночная непустая точка между двумя `null` рисуется только кружком.
- На месте `null` рисуется пустой кружок r = 7 с обводкой `#3A322C` — «этот вечер был, замера нет».
- Если человек прошёл меньше 7 вечеров (график запрашивают из админки), пустые вечера — пустые кружки, ось всё равно 1…7.
- Никаких имён, дат рождения, `tg_id`, номеров участника. Только даты первого и последнего вечера.
- Все числа — целые 0…10, шрифт только из `assets/fonts` (в resvg системные шрифты выключены, иначе на другой машине картинка «поедет»).

### 7.3 Реализация

```ts
// src/chart/svg.ts — чистая функция, тестируется сравнением подстрок, без рендера
export function buildChartSvg(points: ChartPoint[], o: ChartOpts): string {
  const X = (e: number) => 150 + (e - 1) * 150
  const Y = (v: number) => 1010 - (v / 10) * 680
  const segments = (key: 'before' | 'after') => {
    const out: string[] = []; let cur: string[] = []
    for (const p of points) {
      const v = p[key]
      if (v == null) { if (cur.length > 1) out.push(cur.join(' ')); cur = []; continue }
      cur.push(`${cur.length ? 'L' : 'M'}${X(p.evening)},${Y(v)}`)
    }
    if (cur.length > 1) out.push(cur.join(' '))
    return out
  }
  // …собираем строку SVG: <svg width="1200" height="1500" viewBox="0 0 1200 1500"
  //    xmlns="http://www.w3.org/2000/svg" font-family="Noto Sans"> … </svg>
}

// src/chart/render.ts
import { Resvg } from '@resvg/resvg-js'
export function renderPng(svg: string): Buffer {
  const r = new Resvg(svg, {
    background: '#14110F',
    fitTo: { mode: 'width', value: 1200 },
    font: {
      loadSystemFonts: false,
      fontFiles: ['assets/fonts/NotoSans-Regular.ttf', 'assets/fonts/NotoSans-Bold.ttf'],
      defaultFontFamily: 'Noto Sans',
    },
  })
  return Buffer.from(r.render().asPng())
}
```
Текст в SVG экранируется (`&`, `<`, `>`), хотя подставляются только числа и даты. Рендер занимает ~60–120 мс — синхронный вызов допустим, он случается один раз на человека за неделю.

Та же функция используется админкой: `GET /api/admin/users/:id/chart.png` — специалист видит ровно то, что получил человек.

---

## 8. Аудио-пайплайн

> **Провайдер — Azure AI Speech**, не ElevenLabs (см. §0, решение 3 и `docs/tts-decision.md`). Ключ: `~/.claude/secrets/azure-speech.env` (`AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION=westeurope`, тариф F0 ≈ 500 000 знаков/мес). Квота избыточна, поэтому перегенерация ничего не стоит и «права на ошибку нет» больше не действует.

### 8.1 Источник — сценарии

`content/practices/<slug>.md`, 9 штук, уже написаны. Frontmatter: `slug`, `title`, `category`, `duration_hint`, `intro` (две строки → `line1`/`line2` в БД), `chars`. Тело — текст с паузами двух видов: `<break time="2.0s" />` и `[[pause:8]]`. Слаги: `sleep-landing`, `sleep-warmth`, `sleep-release`, `sleep-shuffle`, `calm-sigh`, `calm-ground`, `calm-kind`, `day-tune`, `day-talk`.

### 8.2 Генерация (`scripts/generate-audio.ts` — уже написан, не переписывать)

```
npm run audio:generate                    # всё, чего нет или что изменилось
npm run audio:generate -- --only sleep-landing
npm run audio:generate -- --force         # перегенерировать всё
npm run audio:generate -- --dry-run       # посчитать знаки и куски, ничего не тратить
npm run audio:generate -- --voice ru-RU-SvetlanaNeural --style ""
```
Конвейер: `parseScript` (оба синтаксиса пауз, схлопывание подряд идущих, обрезка пауз по краям) → `planRequests` (куски между паузами; для голосов без поддержки `<break>` паузы делаются склейкой, а не SSML) → `synthesize` (REST `POST /cognitiveservices/v1`, `audio-48khz-192kbitrate-mono-mp3`, `prosody rate` по профилю категории) → ffmpeg: `anullsrc` нужной длины между кусками, `concat`, `adelay=1500`, `lowpass=f=12000`, `loudnorm` (−19 LUFS сон / −17 остальные), `afade` в конце (8 с для сна), хвост тишины (5 с сон / 2 с) → `content/audio/<slug>.mp3`.

### 8.3 Идемпотентность

`content/audio/manifest.json`:
```json
{ "sleep-landing": { "duration": 312.4, "voice": "ru-RU-Masha:MAI-Voice-2",
                     "style": "caringempathy", "hash": "<sha256 тела сценария + параметров>",
                     "bytes": 7512345, "generated_at": 1758100000 } }
```
Совпал хеш — файл не трогаем и **не тратим квоту**. `--force` игнорирует манифест. Манифест — источник `duration_sec` для БД при синке (`syncPracticesFromFiles`).

### 8.4 Загрузка в Telegram и кэш `file_id`

- При первой отправке практики `sendAudio` получает `InputFile` из `content/audio/<slug>.mp3`; из ответа берём `audio.file_id` и `file_unique_id` → `practices.tg_file_id`. Дальше всем остальным шлём строку `file_id` — файл больше не загружается.
- `scripts/upload-audio.ts` прогревает кэш заранее (чтобы первый живой человек не ждал загрузки 7 МБ): шлёт все практики с `tg_file_id IS NULL` в чат первого `ADMIN_TG_IDS` и сохраняет `file_id`. Запускать после каждой генерации: `npm run audio:upload`.
- Протухание (`wrong file identifier`, смена токена бота, удаление файла в Telegram) — `Sender.audio` ловит эту ошибку, вызывает `clearFileId` и перезаливает с диска один раз (§5.5).
- Загрузка через админку (`POST /practices/:id/audio`) обязана вызвать `clearFileId` — иначе люди получат старую запись.
- Ограничения Telegram: 50 МБ на bot API; наши файлы ~5–8 МБ. `duration` и `title`/`performer` передаём всегда — без них плеер в чате выглядит как безымянный файл, а это прямо противоречит вау-моменту №3.

### 8.5 Порядок работ по контенту

1. `npm run audio:samples` → владелец слушает голоса → выбирает → `TTS_VOICE`/`TTS_STYLE` в `.env`.
2. `npm run audio:generate` → 9 mp3 + манифест.
3. `npm run seed` → практики в БД с `line1`/`line2` и длительностями.
4. `npm run audio:upload` → прогрев `file_id`.
5. Специалист позже заменяет файлы своим голосом **через админку**, по одной практике; слаги, тексты и маршрут не меняются.

### 8.6 Интерфейс провайдера (на случай ElevenLabs)

```ts
export type TtsProvider = {
  name: 'azure' | 'elevenlabs'
  quota(): Promise<{ used: number; limit: number }>
  synthesize(parts: SsmlPart[] | string, v: VoiceParams): Promise<Buffer>
  honorsBreaks(voice: string): boolean
}
```
`scripts/tts.ts` уже реализует `azure`. Добавление ElevenLabs = новый файл с тем же интерфейсом + выбор по `TTS_PROVIDER`; ротация ключей (`KEY_2..6`) имеет смысл только там и только на платном плане.

---

## 9. Стратегия тестирования

`vitest`, все тесты — офлайн, ни одного сетевого вызова. `npm test` — обязательная часть приёмки.

### 9.1 Опоры

```ts
// tests/helpers/db.ts
export function testDb(): Database            // new Database(':memory:'), миграции, seed текстов и практик

// tests/helpers/clock.ts
export const clk = fakeClock(1758000000)      // sleep() резолвится мгновенно

// tests/helpers/bot.ts
export function testBot(ctx: Ctx) {
  const outbox: Array<{ method: string; payload: any }> = []
  const bot = new Bot('12345:TEST', { botInfo: { id: 1, is_bot: true, first_name: 'Семь ночей',
                                                 username: 'ensoma_robot', can_join_groups: false,
                                                 can_read_all_group_messages: false,
                                                 supports_inline_queries: false } })
  // перехват ВСЕХ исходящих вызовов: сеть не трогаем, возвращаем правдоподобные ответы
  bot.api.config.use(async (prev, method, payload) => {
    outbox.push({ method, payload })
    if (method === 'sendMessage' || method === 'sendPhoto')
      return { ok: true, result: { message_id: nextMsgId(), date: clk.now(), chat: { id: payload.chat_id } } } as any
    if (method === 'sendAudio')
      return { ok: true, result: { message_id: nextMsgId(), audio: { file_id: 'FILE_1',
               file_unique_id: 'U1', duration: 300 } } } as any
    return { ok: true, result: true } as any
  })
  return { bot, outbox, texts: () => outbox.filter(o => o.method === 'sendMessage').map(o => o.payload.text) }
}
export function msg(text: string, from = 1000): Update       // фейковый Update с message
export function cb(data: string, from = 1000): Update        // фейковый Update с callback_query
```
`botInfo` передаётся явно, поэтому `bot.init()` не ходит в `getMe`. Обновления скармливаются напрямую: `await bot.handleUpdate(msg('21:00'))`.

### 9.2 Обязательные тесты (каждый = пункт приёмки или инвариант)

| Файл | Проверяет |
|---|---|
| `parse.test.ts` | все формы часа, часов, цифры, payload `?start=q42`, слова паузы, склонение «деление/деления/делений» |
| `onboarding.test.ts` | **5 касаний до звучащей практики**: `/start` → «21:00» → «18:42» → «4» → «😴 Сон» → в outbox есть `sendAudio`. Отдельно: индекс с лендинга упомянут ровно один раз; без payload строки нет |
| `evening.test.ts` | полный вечер: цифры записаны, `current_evening` вырос в момент `sendAudio`, `ev.close` содержит «Было 4, стало 7», `{dots}` = `●○○○○○○` |
| `skip.test.ts` | **пропуск сдвигает программу**: пинг вечера 3 → тишина → 04:00 → `evening_skipped`, `current_evening` не изменился → следующий пинг снова «Вечер 3 из 7» и начинается с `ev.before_after_skip`; три пропуска → автопауза и ни одного четвёртого пинга |
| `finale.test.ts` | **седьмой вечер даёт график**: в outbox есть `sendPhoto` c непустым буфером, подпись содержит «Было 4. Стало 7», следом `final.invite`, `state='completed'`, событие `finished`, уведомление в очереди |
| `now.test.ts` | правило слияния: «Практика сейчас» в вечернем окне запускает вечер (`kind='evening'`, плановый пинг не дублируется), днём — `kind='now'` и `current_evening` не меняется; возврат в прежнее состояние по таймауту |
| `pause.test.ts` | пауза словом и кнопкой из каждого состояния, «Продолжить» в окне и вне окна, `consecutive_skips` не растёт на паузе |
| `scheduler.test.ts` | фейковые часы: `due_at` в прошлом → ровно одно действие; **двойной тик не шлёт дважды** (claim); перезапуск (пересоздание Ctx на той же БД) не теряет и не дублирует; просрочка `practicing` ≥ 3 ч не задаёт ночной вопрос; `due_kind` ≠ состояние → самолечение без отправки |
| `demo-run.test.ts` | **приёмочный прогон целиком**: демо-пользователь проходит 7 вечеров на фейковых часах за ≤ 20 «минут», получает график, день 8 приходит один раз, дальше молчание |
| `pick.test.ts` | маршрут сна 1→A…7→A; при выключенной практике падаем на «меньше всего слушал»; пустая категория → sleep; пустая библиотека → `err.no_practices` и сессия не зависает |
| `chart.test.ts` | `buildChartSvg` даёт разрыв на `null` (два `path`, а не один), 7 подписей оси, итог в тексте; `renderPng` возвращает PNG с сигнатурой `\x89PNG` и размером 1200×1500 |
| `quiz.test.ts` ✅ | границы результатов по сумме (0–21 / 22–35 / 36–49 / 50–59 / 60–70), индекс = round(sum/70*100) |
| `quiz-bot.test.ts` | предложение после финала только при наличии входного индекса; «Не сейчас» больше не спрашивает; 7 ответов дают «Было 60. Стало 74.» + дисклеймер; «Назад» удаляет ответ |
| `stats.test.ts` | на подготовленной БД (10 людей, разные исходы) каждая формула §6.6 даёт ожидаемое число; демо-пользователи исключены |
| `admin-api.test.ts` | 401 без куки; логин, CRUD практик, валидация плейсхолдеров при `PUT /texts/:key`, multipart-загрузка сбрасывает `tg_file_id`, CSV начинается с BOM |
| `tts.test.ts` ✅ | парсер сценариев и планировщик запросов |

### 9.3 Приёмка из ТЗ → тест

| Пункт ТЗ | Автотест | Ручная проверка |
|---|---|---|
| Прогон 7 вечеров в ускоренном режиме | `demo-run.test.ts` | `/demo <secret>` в живом боте, ~15 минут |
| Пропуск вечера сдвигает программу | `skip.test.ts` | демо: пропустить один вечер |
| На 7-м вечере график и итог | `finale.test.ts` + `chart.test.ts` | картинку посмотреть глазами на телефоне |
| Уведомления и цифры видны | `stats.test.ts` | дашборд админки + сообщения владельцу |

---

## 10. Конфигурация и деплой

### 10.1 `.env` (полный список; `.env.example` привести к нему)

```dotenv
TELEGRAM_BOT_TOKEN=            # из ~/.claude/secrets/seven-nights.env, НИКОГДА не в git
ADMIN_PASSWORD=change-me       # пароль админки, минимум 12 символов
PORT=3700
BIND_HOST=100.91.124.2         # только tailnet, наружу не слушаем
ADMIN_TG_IDS=                  # id владельца и специалиста через запятую (узнать: /whoami в боте)
DATA_DIR=./data
CONTENT_DIR=./content
BOT_USERNAME=ensoma_robot
SCHEDULER_TICK_MS=30000
DEMO_MODE_DEFAULT=0
ADMIN_COOKIE_SECURE=0          # 1 только когда появится https-домен
LOG_LEVEL=info
TZ=UTC                         # обязательно: все расчёты идут от tz_offset_min пользователя
# озвучка (используются только скриптами, не сервисом)
AZURE_SPEECH_KEY=
AZURE_SPEECH_REGION=westeurope
TTS_VOICE=ru-RU-Masha:MAI-Voice-2
TTS_STYLE=caringempathy
FFMPEG_BIN=/home/karpushin/.local/bin/ffmpeg
FFPROBE_BIN=/home/karpushin/.local/bin/ffprobe
```

### 10.2 npm-скрипты

```jsonc
{
  "dev":            "tsx watch src/index.ts",
  "start":          "tsx src/index.ts",
  "typecheck":      "tsc --noEmit",
  "test":           "vitest run",
  "seed":           "tsx scripts/seed.ts",            // миграции + тексты + практики из файлов
  "backup":         "tsx scripts/backup-db.ts",
  "build:admin":    "vite build --config web/admin/vite.config.ts",   // → web/admin/dist
  "dev:admin":      "vite --config web/admin/vite.config.ts",         // proxy /api → 3700
  "audio:samples":  "tsx scripts/voice-samples.ts",
  "audio:generate": "tsx scripts/generate-audio.ts",
  "audio:upload":   "tsx scripts/upload-audio.ts"
}
```
`web/admin/vite.config.ts`: `base: '/admin/'`, `build.outDir: 'dist'`, `server.proxy['/api'] = 'http://127.0.0.1:3700'`.

### 10.3 HTTP-сервер (`src/http/server.ts`)

| Маршрут | Что отдаёт |
|---|---|
| `GET /` и `/*` (статика) | `web/landing/` — лендинг с тестом |
| `GET /admin`, `/admin/*` | `web/admin/dist/` со SPA-фолбэком на `index.html` |
| `/api/admin/*` | §6 |
| `GET /media/practices/:file` | аудио для плеера админки (требует куки) |
| `GET /healthz` | `{ ok, uptimeSec, users, dueBacklog, lastTickAt, botUsername }` — без авторизации, для монитора |

Слушаем `BIND_HOST:PORT` (`100.91.124.2:3700`) — снаружи tailnet порт недоступен. Публичный домен добавится Caddy-прокси позже, тогда же `ADMIN_COOKIE_SECURE=1`.

### 10.4 systemd (`deploy/seven-nights.service`, уже написан)

Ключевое — по образцу `mapper.service` и с учётом инцидента 2026-08-04:
- `Restart=always` (не `on-failure`: systemd считает смерть от SIGTERM штатной, и `on-failure` такой процесс не поднимет),
- `RestartSec=2`,
- `EnvironmentFile=/home/karpushin/7days/.env`,
- `Environment=PROCESS_TITLE=seven-nights` — процесс называет себя сам (`process.title`), чтобы его можно было найти и остановить **точно**,
- `KillMode=mixed`, `TimeoutStopSec=20` — один владелец long polling; два экземпляра дают `409 Conflict`.

Установка и эксплуатация:
```bash
cp /home/karpushin/7days/deploy/seven-nights.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now seven-nights
systemctl --user status seven-nights
journalctl --user -u seven-nights -f
systemctl --user restart seven-nights     # только так; никаких pkill по имени файла
```
**Никогда не останавливать сервис сигналом по шаблону имени** (`pkill -f index.ts` найдёт половину машины) — только `systemctl --user stop seven-nights`.

### 10.5 Порядок первого запуска

```bash
cd /home/karpushin/7days
npm ci
cp .env.example .env && $EDITOR .env          # токен, пароль, ADMIN_TG_IDS
npm run seed                                  # схема + тексты по умолчанию + практики
npm run audio:generate                        # 9 mp3 (нужен AZURE_SPEECH_KEY)
npm run build:admin
systemctl --user enable --now seven-nights
npm run audio:upload                          # прогрев file_id (бот уже должен работать)
```

### 10.6 Логи и наблюдаемость

- Один JSON-объект на строку в stdout → journald. Обязательные поля: `ts`, `level`, `msg`, `user_id`, `state_from`, `state_to`, `trigger`, `session_id`, `ms`. Токен и текст свободных сообщений в лог **не пишем** (в логе только длина).
- Каждый переход состояния логируется на `info` — по журналу можно восстановить путь любого человека, не открывая БД.
- `GET /healthz` отдаёт `dueBacklog` = число пользователей с `due_at <= now`; устойчивое значение > 20 означает, что тик не справляется или падает.

---

## 11. Зависимости модулей и риски

### 11.1 Граф импортов (стрелка = «импортирует»)

```
src/index.ts → env, db/index, content/practices, texts, bot/index, scheduler/index, http/server
bot/index    → ctx, flow, parse, texts, keyboards, send, admin-cmds
bot/flow     → db/{users,sessions,events,plays,messages,quiz}, time, timings, texts, keyboards,
               send, content/{pick,audio}, chart/{data,svg,render}, bot/notify
scheduler/*  → db/users, time, timings, bot/flow (только публичные функции §5.6), bot/notify, send
admin-api/*  → db/*, texts, content/practices, chart/*, send (для «Написать» и preview)
chart/*      → db/sessions (только через chart/data), resvg
content/*    → db/{practices,plays,settings}, send
send         → db/{users,practices}, texts, bot/flow (ТОЛЬКО обработчик 403 — вынесен в
               отдельный модуль bot/blocked.ts, чтобы не было цикла send ↔ flow)
```
Циклов быть не должно; единственное опасное место (`send` ↔ `flow`) разорвано вынесением `markBlocked()` в `src/bot/blocked.ts`, который зависит только от `db/users` и `db/events`.

### 11.2 Пять самых рискованных мест

1. **Двойная отправка практики** (дабл-тап, ретрай, перезапуск) — четыре рубежа §4.4; тест «двойной тик» и «дабл-тап по категории» обязательны.
2. **Транзакция и `await`** — `better-sqlite3` синхронен; `await` внутри `db.transaction()` рвёт атомарность молча. Три такта §2.5.1 — единственный разрешённый паттерн.
3. **Часовой пояс и ритуальная дата** — весь движок держится на `tz_offset_min` и границе 04:00; любая работа с `new Date()` в локальном поясе сервера ломает всё незаметно. `TZ=UTC` + `time.ts` — единственная арифметика дат.
4. **Кэш `file_id` и подмена аудио через админку** — забыть `clearFileId` = люди неделю слушают старую запись; ошибка не видна ни в логах, ни в тестах.
5. **Таймеры после простоя** — расчёт «что делать с просроченным `due_at`» (строки 9, 21, 27) отвечает за то, что человек не получит в 11 утра «А сейчас как, от 0 до 10?» про вчерашнюю практику.

### 11.3 Открытые вопросы (решать после первых прогонов, в код не закладывать)

- Порог автопаузы 3 vs 4 (`settings.autopause_after_skips` уже вынесен в настройки).
- Фиксированные 10:00 для утреннего догона при вечернем часе 23:00 — возможно `max(10:00, {time} − 11 ч)`.
- Нужен ли «мягкий напоминатель» через 90 минут после проигнорированного пинга (в v1 сознательно нет).
- Летнее время: автоматики нет, лечится кнопкой «Поменять время».
- Вход свободный (оплата и коды выпилены) — защиты от посторонних нет. IP мы не видим, поэтому единственная мера при потоке спама — ручная блокировка в админке (`DELETE /api/admin/users/:id`) плюс, если понадобится, флаг «приём новых закрыт» в настройках: `/start` отвечает одним текстом и пользователя не создаёт.
