/**
 * «Семь ночей» — работающий бот для показа.
 *
 *   npx tsx src/demo/bot.ts
 *
 * Это самостоятельная сборка на одном файле: весь путь человека от /start до графика
 * седьмого вечера, с настоящими практиками и настоящим аудио. Она написана, чтобы
 * продукт можно было открыть в Telegram и пройти уже сегодня, пока параллельно
 * собирается полная версия с админкой (src/bot, src/scheduler, src/admin-api).
 *
 * Отличия от полной версии сознательные: своя маленькая база (data/demo.db), тексты
 * в коде, а не в редактируемой таблице, нет админки и уведомлений владельцу. Механика
 * и тексты — из docs/design-bot.md, чтобы показ не расходился с тем, что строится.
 *
 * Останавливать по сохранённому PID или через systemctl. Никогда не pkill по имени.
 */

import { Bot, InlineKeyboard, Keyboard, InputFile } from 'grammy'
import Database from 'better-sqlite3'
import { Resvg } from '@resvg/resvg-js'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..', '..')
const AUDIO_DIR = join(ROOT, 'content', 'audio')
const FONT_DIR = join(ROOT, 'assets', 'fonts')

// ───────────────────────────── конфигурация ─────────────────────────────

function readEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  const path = join(ROOT, '.env')
  if (existsSync(path)) {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
      if (m) out[m[1]] = m[2].trim()
    }
  }
  return { ...out, ...process.env } as Record<string, string>
}

const env = readEnv()
const TOKEN = env.TELEGRAM_BOT_TOKEN
if (!TOKEN) throw new Error('Нет TELEGRAM_BOT_TOKEN в .env')

/** Ускоренный режим: вечер идёт пару минут. Для показа включён по умолчанию. */
const DEMO_DEFAULT = env.DEMO_MODE_DEFAULT !== '0'

const TIMINGS = {
  demo: { afterPracticeSec: 60, nextEveningSec: 90, skipAfterSec: 300 },
  real: { afterPracticeSec: 20 * 60, nextEveningSec: 0, skipAfterSec: 0 },
}

// ───────────────────────────── база ─────────────────────────────

mkdirSync(join(ROOT, 'data'), { recursive: true })
const db = new Database(env.DEMO_DB || join(ROOT, 'data', 'demo.db'))
db.pragma('journal_mode = WAL')
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  tg_id           INTEGER PRIMARY KEY,
  tz_offset_min   INTEGER NOT NULL DEFAULT 180,
  evening_time    TEXT    NOT NULL DEFAULT '21:00',
  state           TEXT    NOT NULL DEFAULT 'new',
  due_at          INTEGER,
  due_kind        TEXT,
  evening_no      INTEGER NOT NULL DEFAULT 0,   -- засчитанных вечеров
  demo            INTEGER NOT NULL DEFAULT 1,
  quiz_sum        INTEGER,
  quiz_index      INTEGER,
  cur_before      INTEGER,
  cur_category    TEXT,
  cur_practice    TEXT,
  practice_msg_id INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS evenings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id       INTEGER NOT NULL,
  no          INTEGER NOT NULL,          -- 1..7; 0 = «практика сейчас», вне программы
  category    TEXT,
  practice    TEXT,
  before_v    INTEGER,
  after_v     INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS file_ids (slug TEXT PRIMARY KEY, file_id TEXT NOT NULL);
`)

// База могла быть создана до появления колонки — добавляем на месте, без миграций.
const hasKind = (db.prepare("PRAGMA table_info(users)").all() as { name: string }[]).some((c) => c.name === 'cur_kind')
if (!hasKind) db.exec("ALTER TABLE users ADD COLUMN cur_kind TEXT NOT NULL DEFAULT 'evening'")
const hasSkips = (db.prepare("PRAGMA table_info(users)").all() as { name: string }[]).some((c) => c.name === 'skips')
if (!hasSkips) db.exec('ALTER TABLE users ADD COLUMN skips INTEGER NOT NULL DEFAULT 0')

type User = {
  tg_id: number; tz_offset_min: number; evening_time: string; state: string
  due_at: number | null; due_kind: string | null; evening_no: number; demo: number
  quiz_sum: number | null; quiz_index: number | null
  cur_before: number | null; cur_category: string | null; cur_practice: string | null
  cur_kind: string; skips: number; practice_msg_id: number | null; created_at: number
}

const q = {
  get: db.prepare('SELECT * FROM users WHERE tg_id = ?'),
  create: db.prepare('INSERT INTO users (tg_id, demo, created_at) VALUES (?, ?, ?)'),
  due: db.prepare('SELECT * FROM users WHERE due_at IS NOT NULL AND due_at <= ?'),
  addEvening: db.prepare('INSERT INTO evenings (tg_id, no, category, practice, before_v, created_at) VALUES (?,?,?,?,?,?)'),
  closeEvening: db.prepare('UPDATE evenings SET after_v = ? WHERE id = (SELECT MAX(id) FROM evenings WHERE tg_id = ?)'),
  listEvenings: db.prepare('SELECT * FROM evenings WHERE tg_id = ? AND no > 0 ORDER BY no'),
  played: db.prepare('SELECT practice, COUNT(*) n FROM evenings WHERE tg_id = ? GROUP BY practice'),
  getFileId: db.prepare('SELECT file_id FROM file_ids WHERE slug = ?'),
  putFileId: db.prepare('INSERT OR REPLACE INTO file_ids (slug, file_id) VALUES (?, ?)'),
}

const now = () => Math.floor(Date.now() / 1000)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Пауза между финальными сообщениями. В тестах нулевая, чтобы не ждать впустую. */
const PACING_MS = env.SEVEN_NIGHTS_NO_POLL ? 0 : 2500

function user(tgId: number): User {
  let u = q.get.get(tgId) as User | undefined
  if (!u) {
    q.create.run(tgId, DEMO_DEFAULT ? 1 : 0, now())
    u = q.get.get(tgId) as User
  }
  return u
}

function set(tgId: number, patch: Partial<User>) {
  const keys = Object.keys(patch)
  if (!keys.length) return
  db.prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE tg_id = ?`)
    .run(...keys.map((k) => (patch as any)[k]), tgId)
}

// ───────────────────────────── практики ─────────────────────────────

type Practice = { slug: string; title: string; category: string; intro: string[]; duration: number }
const practices: Practice[] = Object.values(
  JSON.parse(readFileSync(join(AUDIO_DIR, 'manifest.json'), 'utf8')) as Record<string, Practice>,
)

const CATEGORIES = [
  { key: 'sleep', label: '😴 Сон и расслабление' },
  { key: 'calm', label: '🌿 Тревога и стресс' },
  { key: 'day', label: '🌅 Настроиться на день' },
]

/** Берём ту, которую человек слышал реже всех: пока есть непрослушанные — только их. */
function pickPractice(tgId: number, category: string): Practice | null {
  const counts = new Map<string, number>()
  for (const r of q.played.all(tgId) as { practice: string; n: number }[]) counts.set(r.practice, r.n)
  const pool = practices.filter((p) => p.category === category)
  const list = pool.length ? pool : practices
  return list.sort((a, b) => (counts.get(a.slug) ?? 0) - (counts.get(b.slug) ?? 0))[0] ?? null
}

// ───────────────────────────── тексты ─────────────────────────────

const bar = (n: number) => '▰'.repeat(n) + '▱'.repeat(10 - n)
const dots = (n: number) => '●'.repeat(n) + '○'.repeat(7 - n)

/** «на три деления легче» — форма слова по числу. */
function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few
  return many
}

/**
 * Маркеры сообщений, на которые нельзя отвечать «Передала».
 * Список короткий сознательно: ложное срабатывание здесь хуже пропуска — человек,
 * которому просто грустно, получит неуместно тревожный текст.
 */
const CRISIS_MARKERS = [
  'не хочу жить', 'не хочется жить', 'незачем жить', 'жить незачем',
  'покончить с собой', 'покончу с собой', 'убить себя', 'убью себя',
  'суицид', 'не вижу смысла жить', 'хочу умереть', 'хочу сдохнуть',
  'причинить себе вред', 'навредить себе', 'порезать себя',
]

const looksLikeCrisis = (t: string) => {
  const low = t.toLowerCase()
  return CRISIS_MARKERS.some((m) => low.includes(m))
}

const T = {
  welcome:
    'Привет. Это «Семь ночей»: семь вечеров подряд, каждый вечер одна аудиопрактика. ' +
    'Ничего готовить не надо: наушники и кровать. Вечером я напишу, а в конце недели покажу, что изменилось.',
  disclaimer:
    'Это практики для самоподдержки. Они не лечат и не заменяют врача или психотерапевта. ' +
    'Если тяжело дольше нескольких недель — стоит поговорить со специалистом.',
  safety: 'Слушай дома, лёжа или сидя. Не за рулём и не там, где нужно внимание.',
  crisis:
    'Я тебя слышу, и это звучит тяжело. Если сейчас правда очень плохо — это важнее любой практики. ' +
    'Пожалуйста, не оставайся с этим один на один: напиши тому, кому доверяешь, или обратись за помощью сегодня. ' +
    'Я передала твоё сообщение.',
  deleteAsk:
    'Сотру всё, что у меня про тебя есть: удобный час, номер вечера и все цифры. ' +
    'Отменить это будет нельзя. Точно?',
  deleteDone: 'Стёрла. Ничего про тебя у меня не осталось. Если захочешь начать заново — напиши /start.',
  deleteNo: 'Хорошо, ничего не трогаю.',
  quizIndex: (i: number) => `Твой индекс опоры сейчас ${i} из ста. Это точка отсчёта, к ней вернёмся через семь вечеров.`,
  hourAsk: 'Во сколько вечером тебе удобно получать практику?',
  hourRetry: 'Напиши час как на часах, например 21:30.',
  clockAsk: (t: string) => `Поняла, ${t}. И одно уточнение, чтобы не перепутать часовой пояс. Сколько сейчас у тебя на часах?`,
  clockRetry: 'Напиши время, как на телефоне, например 18:42.',
  doneNow: 'Открыла тебе семь вечеров. Первый можно начать прямо сейчас.',
  doneLater: (t: string) =>
    `Открыла тебе семь вечеров. Первая практика — сегодня в ${t}. До вечера можно ничего не делать, я напишу сама.`,
  beforeFirst: 'Добрый вечер. Первый вечер из семи. Как ты сейчас, от 0 до 10? 0 — совсем тяжело, 10 — лучше некуда.',
  before: (n: number) => `Добрый вечер. Вечер ${n} из 7. Как ты сейчас, от 0 до 10?`,
  beforeHalf: 'Добрый вечер. Четвёртый вечер, половина пути. Как ты сейчас, от 0 до 10?',
  beforeLast: 'Добрый вечер. Седьмой вечер, последний. Как ты сейчас, от 0 до 10?',
  beforeAfterSkip: (n: number) =>
    `Вчера не получилось, это нормально. Продолжим с того места, где остановились. Вечер ${n} из 7. Как ты сейчас, от 0 до 10?`,
  beforeAfterSkips: (n: number) =>
    `Несколько дней не получилось, это нормально. Продолжим с того места, где остановились. Вечер ${n} из 7. Как ты сейчас, от 0 до 10?`,
  beforeAck: (v: number) => `Записала: ${v}  ${bar(v)}\nЧто сегодня ближе?`,
  stateAck: (label: string) => `Сегодня: ${label.toLowerCase()}`,
  caption: (p: Practice, n: number, first: boolean) =>
    'Ложись, надень наушники и просто слушай.\n\n' +
    `${p.intro[0] ?? ''}\n${p.intro[1] ?? ''}` +
    (p.category === 'sleep' ? '\n\nЕсли уснёшь — хорошо. Утром спрошу, как ты.' : '') +
    (first ? `\n\n${T.safety}` : ''),
  after: 'А сейчас как, от 0 до 10?',
  deltaUp: (b: number, a: number) =>
    `Было ${b}, стало ${a}. На ${a - b} ${plural(a - b, 'деление', 'деления', 'делений')} легче.`,
  deltaSame: 'Ровно. Тоже честный ответ.',
  deltaDown: (b: number, a: number) => `Ниже на ${b - a}. Бывает, это тоже часть недели.`,
  close: (v: number, delta: string, n: number) => `Записала: ${v}  ${bar(v)}\n${delta}\n${dots(n)} Вечер ${n} из 7. До завтра.`,
  finalClose: (v: number, delta: string) => `Записала: ${v}  ${bar(v)}\n${delta}`,
  chartCaption: (b: number, a: number) => `Смотри, где всё началось и где ты сейчас.\n\nБыло ${b}. Стало ${a}.`,
  invite: 'Если захочешь разобрать своё, приходи на разговор. Тридцать минут, вдвоём.',
  notNumber: 'Мне нужна просто цифра от 0 до 10. Можно нажать на клавиатуре.',
  range: 'От 0 до 10 — какая ближе?',
  idle: (t: string) => `Передала. Цифру спрошу вечером, в ${t}. А если хочется практику сейчас — кнопка внизу.`,
  completed: 'Семь вечеров позади. Практики остаются с тобой: кнопка «Практика сейчас» никуда не денется.',
  practicing: 'Практика у тебя выше. Когда дослушаешь, нажми «Готово».',
}

// ───────────────────────────── клавиатуры ─────────────────────────────

const HOME = new Keyboard().text('Практика сейчас').resized().persistent()

const numbers = (extra?: string) => {
  const k = new Keyboard()
  for (let i = 0; i <= 5; i++) k.text(String(i))
  k.row()
  for (let i = 6; i <= 10; i++) k.text(String(i))
  if (extra) k.row().text(extra)
  return k.resized().oneTime()
}

const categoryKeyboard = (eveningHint: boolean) => {
  const order = eveningHint ? ['sleep', 'calm', 'day'] : ['day', 'calm', 'sleep']
  const k = new InlineKeyboard()
  for (const key of order) {
    const c = CATEGORIES.find((x) => x.key === key)!
    k.text(key === 'day' && eveningHint ? '🌅 Настроиться на завтра' : c.label, `cat:${key}`).row()
  }
  return k
}

// ───────────────────────────── время ─────────────────────────────

const localNow = (u: User) => now() + u.tz_offset_min * 60
const hhmm = (sec: number) => {
  const d = new Date(sec * 1000)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

/** Следующее наступление HH:MM по локальному времени человека, в UTC. */
function nextEveningAt(u: User): number {
  const [h, m] = u.evening_time.split(':').map(Number)
  const local = localNow(u)
  const dayStart = Math.floor(local / 86400) * 86400
  let t = dayStart + h * 3600 + m * 60
  if (t <= local) t += 86400
  return t - u.tz_offset_min * 60
}

/** Вечернее окно: от часа минус час до четырёх утра. В нём первый вечер начинаем сразу. */
function inEveningWindow(u: User): boolean {
  const [h] = u.evening_time.split(':').map(Number)
  const localH = new Date(localNow(u) * 1000).getUTCHours()
  return localH >= h - 1 || localH < 4
}

function parseHour(text: string): string | null {
  const t = text.trim().toLowerCase().replace(/[.\s]/g, ':').replace(/::+/g, ':')
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?/)
  if (!m) return null
  let h = Number(m[1])
  const min = Number(m[2] ?? 0)
  if (h > 23 || min > 59) return null
  if (h >= 4 && h <= 11 && !/утр/.test(text)) h += 12   // «9» вечером значит 21:00
  if (h > 23) h -= 12
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

function parseClock(text: string): { h: number; m: number } | null {
  const t = text.trim().replace(/[.\s]/g, ':')
  let m = t.match(/^(\d{1,2}):(\d{2})/)
  if (!m) {
    const only = t.match(/^(\d{1,2})$/)
    // Человек написал только час. Ставить ноль минут нельзя: смещение округлится
    // с ошибкой почти в час. Минуты у всех поясов одинаковые — берём текущие.
    if (only) return { h: Number(only[1]), m: new Date().getUTCMinutes() }
    const four = t.match(/^(\d{2})(\d{2})$/)
    if (four) return { h: Number(four[1]), m: Number(four[2]) }
    return null
  }
  return { h: Number(m[1]), m: Number(m[2]) }
}

function parseNumber(text: string): number | 'out-of-range' | null {
  const words: Record<string, number> = {
    ноль: 0, один: 1, два: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10,
  }
  const t = text.trim().toLowerCase()
  if (t in words) return words[t]
  const slash = t.match(/^(\d{1,2})\s*(?:\/|из)\s*10$/)
  if (slash) return Number(slash[1]) <= 10 ? Number(slash[1]) : 'out-of-range'
  const all = t.match(/\d{1,3}/g)
  if (!all || all.length !== 1) return null
  const n = Number(all[0])
  return n >= 0 && n <= 10 ? n : 'out-of-range'
}

// ───────────────────────────── график седьмого вечера ─────────────────────────────

function chartPng(rows: { no: number; before_v: number | null; after_v: number | null }[]): Buffer {
  const W = 1200
  const H = 1500
  const padX = 120
  const top = 420
  const plotH = 620
  const x = (i: number) => padX + (i * (W - padX * 2)) / 6
  const y = (v: number) => top + plotH - (v / 10) * plotH

  const firstBefore = rows.find((r) => r.before_v != null)?.before_v ?? 0
  const lastAfter = [...rows].reverse().find((r) => r.after_v != null)?.after_v ?? 0

  const line = (key: 'before_v' | 'after_v', color: string, width: number) => {
    // Разрыв, а не ноль: вечер без ответа оставляет дырку в линии, это честнее.
    const segs: string[] = []
    let open = false
    rows.forEach((r, i) => {
      const v = r[key]
      if (v == null) { open = false; return }
      segs.push(`${open ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
      open = true
    })
    return segs.length
      ? `<path d="${segs.join(' ')}" stroke="${color}" stroke-width="${width}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`
      : ''
  }
  const points = (key: 'before_v' | 'after_v', color: string) =>
    rows
      .map((r, i) => {
        const v = r[key]
        // Вечер без ответа не рисуем вовсе: любая точка-заглушка читается как цифра,
        // которой человек не называл. Разрыв линии говорит правду сам.
        return v == null ? '' : `<circle cx="${x(i)}" cy="${y(v).toFixed(1)}" r="9" fill="${color}"/>`
      })
      .join('')

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#0F1233"/>
  <text x="${padX}" y="150" font-family="Noto Sans" font-size="54" font-weight="700" fill="#F3EEE3">Семь ночей</text>
  <text x="${padX}" y="212" font-family="Noto Sans" font-size="32" fill="#A9ACC8">семь вечеров · до и после</text>
  ${[0, 5, 10].map((v) => `<line x1="${padX}" y1="${y(v)}" x2="${W - padX}" y2="${y(v)}" stroke="#2A2456" stroke-width="2"/>
     <text x="${padX - 24}" y="${y(v) + 12}" text-anchor="end" font-family="Noto Sans" font-size="28" fill="#A9ACC8">${v}</text>`).join('')}
  ${line('before_v', '#8A93D6', 6)}
  ${line('after_v', '#F2B56B', 8)}
  ${points('before_v', '#8A93D6')}
  ${points('after_v', '#F2B56B')}
  ${rows.map((r, i) => `<text x="${x(i)}" y="${top + plotH + 58}" text-anchor="middle" font-family="Noto Sans" font-size="30" fill="#A9ACC8">${r.no}</text>`).join('')}
  <text x="${W - padX}" y="${y(lastAfter) - 28}" text-anchor="end" font-family="Noto Sans" font-size="30" fill="#F2B56B">после</text>
  <text x="${W - padX}" y="${y([...rows].reverse().find((r) => r.before_v != null)?.before_v ?? 5) + 46}" text-anchor="end" font-family="Noto Sans" font-size="30" fill="#8A93D6">до</text>
  <text x="${padX}" y="1290" font-family="Noto Sans" font-size="86" font-weight="700" fill="#F3EEE3">Было ${firstBefore}. Стало ${lastAfter}.</text>
  <text x="${padX}" y="1370" font-family="Noto Sans" font-size="30" fill="#A9ACC8">@ensoma_robot</text>
</svg>`

  return Buffer.from(
    new Resvg(svg, {
      font: { fontDirs: [FONT_DIR], defaultFontFamily: 'Noto Sans', loadSystemFonts: false },
      fitTo: { mode: 'width', value: W },
    }).render().asPng(),
  )
}

// ───────────────────────────── бот ─────────────────────────────

const bot = new Bot(TOKEN)

const timings = (u: User) => (u.demo ? TIMINGS.demo : TIMINGS.real)

async function askBefore(tgId: number) {
  const u = user(tgId)
  const n = u.evening_no + 1
  const text =
    u.skips === 1 ? T.beforeAfterSkip(n)
    : u.skips > 1 ? T.beforeAfterSkips(n)
    : n === 1 ? T.beforeFirst
    : n === 4 ? T.beforeHalf
    : n === 7 ? T.beforeLast
    : T.before(n)
  // Срок пропуска ставится вместе с вопросом: если человек не дойдёт до практики,
  // вечер закроется сам, программа сдвинется, а номер вечера останется прежним.
  set(tgId, {
    state: 'awaiting_before', cur_kind: 'evening',
    due_at: now() + (u.demo ? 180 : 8 * 3600), due_kind: 'skip',
  })
  await bot.api.sendMessage(tgId, text, { reply_markup: numbers() })
}

async function sendPractice(tgId: number, category: string) {
  const u = user(tgId)
  const p = pickPractice(tgId, category)
  if (!p) {
    await bot.api.sendMessage(tgId, 'Практики ещё загружаются. Загляни чуть позже.')
    return
  }
  // Сессия «Практика сейчас» живёт вне семи вечеров: счётчик она не двигает,
  // в историю пишется с номером ноль и на график недели не попадает.
  const isNow = u.cur_kind === 'now'
  const n = isNow ? u.evening_no : u.evening_no + 1
  await bot.api.sendChatAction(tgId, 'upload_voice')

  const cached = (q.getFileId.get(p.slug) as { file_id: string } | undefined)?.file_id
  const audio = cached ?? new InputFile(join(AUDIO_DIR, `${p.slug}.mp3`))
  const msg = await bot.api.sendAudio(tgId, audio, {
    caption: T.caption(p, n, u.evening_no === 0),
    title: p.title,
    performer: isNow ? 'Семь ночей' : `Семь ночей · Вечер ${n}`,
    duration: p.duration,
    reply_markup: new InlineKeyboard().text('Готово', 'done'),
  })
  if (!cached && msg.audio?.file_id) q.putFileId.run(p.slug, msg.audio.file_id)

  // Вечер засчитан в момент успешной отправки аудио — не по кнопке и не по замеру «после».
  q.addEvening.run(tgId, isNow ? 0 : n, category, p.slug, u.cur_before, now())
  if (!isNow) set(tgId, { skips: 0 })   // вечер засчитан — серия пропусков прервана
  set(tgId, {
    state: 'practicing', evening_no: isNow ? u.evening_no : n, cur_practice: p.slug, practice_msg_id: msg.message_id,
    due_at: now() + Math.max(timings(u).afterPracticeSec, u.demo ? 0 : p.duration + 120),
    due_kind: 'after',
  })
}

async function askAfter(tgId: number) {
  const u = user(tgId)
  if (u.practice_msg_id) {
    await bot.api.editMessageReplyMarkup(tgId, u.practice_msg_id, { reply_markup: undefined }).catch(() => {})
  }
  set(tgId, { state: 'awaiting_after', due_at: null, due_kind: null })
  await bot.api.sendMessage(tgId, T.after, { reply_markup: numbers() })
}

async function closeEvening(tgId: number, after: number) {
  const u = user(tgId)
  q.closeEvening.run(after, tgId)
  const before = u.cur_before ?? after
  const delta = after > before ? T.deltaUp(before, after) : after === before ? T.deltaSame : T.deltaDown(before, after)

  if (u.cur_kind === 'now') {
    await bot.api.sendMessage(tgId, `Записала: ${after}  ${bar(after)}\n${delta}`, { reply_markup: HOME })
    // Возвращаемся туда, где человек был: программа не сдвинулась ни на шаг.
    const back = u.evening_no >= 7 ? 'completed' : 'idle'
    set(tgId, { state: back, cur_before: null, cur_category: null, cur_kind: 'evening' })
    return
  }

  if (u.evening_no >= 7) {
    await bot.api.sendMessage(tgId, T.finalClose(after, delta), { reply_markup: { remove_keyboard: true } })
    await bot.api.sendChatAction(tgId, 'upload_photo')
    const rows = q.listEvenings.all(tgId) as any[]
    const seven = Array.from({ length: 7 }, (_, i) => rows.find((r) => r.no === i + 1) ?? { no: i + 1, before_v: null, after_v: null })
    const png = chartPng(seven)
    const firstBefore = seven.find((r) => r.before_v != null)?.before_v ?? before
    const lastAfter = [...seven].reverse().find((r) => r.after_v != null)?.after_v ?? after
    await bot.api.sendPhoto(tgId, new InputFile(png, 'seven-nights.png'), {
      caption: T.chartCaption(firstBefore, lastAfter),
    })
    // Пауза перед приглашением — ради ритма, но внутри того же обработчика:
    // отложенный setTimeout пережил бы не всякий перезапуск, а сообщение потерялось бы.
    await sleep(PACING_MS)
    await bot.api.sendMessage(tgId, T.invite, { reply_markup: HOME })
    set(tgId, { state: 'completed', due_at: null, due_kind: null, cur_before: null })
    return
  }

  await bot.api.sendMessage(tgId, T.close(after, delta, u.evening_no), { reply_markup: HOME })
  const next = u.demo ? now() + timings(u).nextEveningSec : nextEveningAt(u)
  set(tgId, { state: 'idle', due_at: next, due_kind: 'evening', cur_before: null, cur_category: null })
}

bot.command('start', async (ctx) => {
  const tgId = ctx.from!.id
  const payload = (ctx.match as string | undefined)?.trim() ?? ''
  const u = user(tgId)

  if (u.state !== 'new' && u.state !== 'onb_hour' && u.state !== 'onb_clock') {
    if (u.state === 'completed') return ctx.reply(T.completed, { reply_markup: HOME })
    return ctx.reply(`Ты на вечере ${u.evening_no + 1} из 7. Сегодня в ${u.evening_time} пришлю практику.`, { reply_markup: HOME })
  }

  await ctx.reply(T.welcome, { reply_markup: { remove_keyboard: true } })
  await ctx.reply(T.disclaimer)

  // Пришёл с лендинга после теста: ?start=q42 — сумма ответов, индекс считаем сами.
  const m = payload.match(/^q(\d{1,2})$/)
  if (m && Number(m[1]) <= 70) {
    const sum = Number(m[1])
    const index = Math.round((sum / 70) * 100)
    set(tgId, { quiz_sum: sum, quiz_index: index })
    await ctx.reply(T.quizIndex(index))
  }

  set(tgId, { state: 'onb_hour' })
  await ctx.reply(T.hourAsk, {
    reply_markup: new Keyboard().text('21:00').text('22:00').text('23:00').row().text('Другое время').resized().oneTime(),
  })
})

bot.command('demo', async (ctx) => {
  const u = user(ctx.from!.id)
  set(ctx.from!.id, { demo: u.demo ? 0 : 1 })
  await ctx.reply(u.demo ? 'Обычный режим: практика приходит в твой вечерний час.' : 'Демо-режим: вечер длится пару минут.')
})

bot.command('reset', async (ctx) => {
  const tgId = ctx.from!.id
  db.prepare('DELETE FROM evenings WHERE tg_id = ?').run(tgId)
  db.prepare('DELETE FROM users WHERE tg_id = ?').run(tgId)
  await ctx.reply('Стёрла. Напиши /start, чтобы начать заново.', { reply_markup: { remove_keyboard: true } })
})

bot.command('whoami', (ctx) => ctx.reply(`Твой Telegram ID: ${ctx.from!.id}`))

bot.command('delete', async (ctx) => {
  await ctx.reply(T.deleteAsk, {
    reply_markup: new InlineKeyboard().text('Да, стереть', 'del:yes').text('Нет', 'del:no'),
  })
})

bot.callbackQuery(/^del:(yes|no)$/, async (ctx) => {
  await ctx.answerCallbackQuery()
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {})
  if (ctx.match![1] === 'no') return void ctx.reply(T.deleteNo)
  const tgId = ctx.from.id
  db.prepare('DELETE FROM evenings WHERE tg_id = ?').run(tgId)
  db.prepare('DELETE FROM users WHERE tg_id = ?').run(tgId)
  await ctx.reply(T.deleteDone, { reply_markup: { remove_keyboard: true } })
})

bot.callbackQuery(/^cat:(.+)$/, async (ctx) => {
  const tgId = ctx.from.id
  const u = user(tgId)
  if (u.state !== 'awaiting_state') {
    await ctx.answerCallbackQuery('Это уже прошло')
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {})
    return
  }
  const key = ctx.match![1]
  const label = CATEGORIES.find((c) => c.key === key)?.label ?? ''
  // Шаг меняем ДО отправки практики: второй тап по той же кнопке уже не пройдёт.
  set(tgId, { state: 'sending', cur_category: key })
  await ctx.answerCallbackQuery()
  await ctx.editMessageText(T.stateAck(label)).catch(() => {})
  await sendPractice(tgId, key)
})

bot.callbackQuery('done', async (ctx) => {
  const tgId = ctx.from.id
  const u = user(tgId)
  await ctx.answerCallbackQuery()
  if (u.state !== 'practicing') return
  await askAfter(tgId)
})

bot.on('message:text', async (ctx) => {
  const tgId = ctx.from!.id
  const text = ctx.message.text
  const u = user(tgId)

  // Раньше любого шага: человеку, который пишет такое, не нужен вопрос про цифру.
  if (looksLikeCrisis(text)) {
    await ctx.reply(T.crisis)
    return
  }

  if (text === 'Практика сейчас') {
    if (u.state === 'idle' || u.state === 'completed') {
      set(tgId, { state: 'awaiting_before', cur_kind: 'now' })
      await ctx.reply('Как ты сейчас, от 0 до 10?', { reply_markup: numbers() })
      return
    }
  }

  switch (u.state) {
    case 'onb_hour': {
      const h = parseHour(text)
      if (!h) return void ctx.reply(T.hourRetry)
      set(tgId, { evening_time: h, state: 'onb_clock' })
      const guess = hhmm(localNow(user(tgId)))
      const alt = (d: number) => hhmm(localNow(user(tgId)) + d * 3600)
      await ctx.reply(T.clockAsk(h), {
        reply_markup: new Keyboard().text(guess).text(alt(-1)).text(alt(1)).row().text('Другое').resized().oneTime(),
      })
      return
    }
    case 'onb_clock': {
      const c = parseClock(text)
      if (!c) return void ctx.reply(T.clockRetry)
      // Смещение = что на часах у человека минус UTC, округлённое до четверти часа.
      const utc = new Date(now() * 1000)
      let diff = (c.h * 60 + c.m) - (utc.getUTCHours() * 60 + utc.getUTCMinutes())
      if (diff > 840) diff -= 1440
      if (diff < -720) diff += 1440
      const off = Math.round(diff / 15) * 15
      set(tgId, { tz_offset_min: off, state: 'idle' })
      const fresh = user(tgId)
      if (inEveningWindow(fresh) || fresh.demo) {
        await ctx.reply(T.doneNow, { reply_markup: { remove_keyboard: true } })
        await askBefore(tgId)
      } else {
        set(tgId, { due_at: nextEveningAt(fresh), due_kind: 'evening' })
        await ctx.reply(T.doneLater(fresh.evening_time), { reply_markup: HOME })
      }
      return
    }
    case 'awaiting_before': {
      const n = parseNumber(text)
      if (n === null) return void ctx.reply(T.notNumber, { reply_markup: numbers() })
      if (n === 'out-of-range') return void ctx.reply(T.range, { reply_markup: numbers() })
      set(tgId, {
        cur_before: n, state: 'awaiting_state',
        due_at: now() + (u.demo ? 60 : 600), due_kind: 'category',
      })
      const evening = new Date(localNow(u) * 1000).getUTCHours() >= 14
      await ctx.reply(T.beforeAck(n), { reply_markup: categoryKeyboard(evening) })
      return
    }
    case 'practicing': {
      const n = parseNumber(text)
      if (typeof n === 'number') {
        // Прислал цифру, не дождавшись вопроса — принимаем как замер «после».
        if (u.practice_msg_id) await ctx.api.editMessageReplyMarkup(tgId, u.practice_msg_id, { reply_markup: undefined }).catch(() => {})
        await closeEvening(tgId, n)
        return
      }
      return void ctx.reply(T.practicing)
    }
    case 'awaiting_after': {
      const n = parseNumber(text)
      if (n === null) return void ctx.reply(T.notNumber, { reply_markup: numbers() })
      if (n === 'out-of-range') return void ctx.reply(T.range, { reply_markup: numbers() })
      await closeEvening(tgId, n)
      return
    }
    case 'completed':
      return void ctx.reply(T.completed, { reply_markup: HOME })
    default:
      return void ctx.reply(T.idle(u.evening_time), { reply_markup: HOME })
  }
})

// ───────────────────────────── планировщик ─────────────────────────────

/**
 * Единственный источник отложенных действий — колонка due_at в базе.
 * Таймеров в памяти нет: перезапуск процесса ничего не теряет.
 */
export const tick = async () => {
  const rows = q.due.all(now()) as User[]
  for (const u of rows) {
    try {
      if (u.due_kind === 'evening') {
        set(u.tg_id, { due_at: null, due_kind: null })
        await askBefore(u.tg_id)
      } else if (u.due_kind === 'skip') {
        // Практика так и не ушла. Вечер НЕ засчитываем и номер не двигаем:
        // программа сдвигается, человек всё равно пройдёт все семь.
        const nextAt = u.demo ? now() + timings(u).nextEveningSec : nextEveningAt(u)
        set(u.tg_id, {
          state: 'idle', skips: u.skips + 1, cur_before: null, cur_category: null,
          due_at: nextAt, due_kind: 'evening',
        })
        // Молча: следующим сообщением человек увидит «Вчера не получилось, это нормально».
      } else if (u.due_kind === 'category') {
        // Не выбрал состояние — не повод терять вечер: молча даём сон.
        set(u.tg_id, { due_at: null, due_kind: null })
        if (u.state === 'awaiting_state') {
          set(u.tg_id, { state: 'sending', cur_category: 'sleep' })
          await sendPractice(u.tg_id, 'sleep')
        }
      } else if (u.due_kind === 'after') {
        set(u.tg_id, { due_at: null, due_kind: null })
        if (u.state === 'practicing') await askAfter(u.tg_id)
      }
    } catch (e) {
      console.error('тик планировщика:', e instanceof Error ? e.message : e)
    }
  }
}

// ───────────────────────────── запуск ─────────────────────────────

export { bot, db, user, set, q }

// Под тестом модуль импортируют, чтобы прогнать путь фейковыми апдейтами: тогда ни
// polling, ни таймер, ни обращения к Telegram при старте не нужны.
if (!env.SEVEN_NIGHTS_NO_POLL) {
  process.title = 'seven-nights-demo'
  setInterval(tick, 15_000)
  bot.api.setMyCommands([]).catch(() => {})
  bot.catch((err) => console.error('ошибка бота:', err.message))

  const me = await bot.api.getMe()
  console.log(`«Семь ночей» запущен: @${me.username}, практик ${practices.length}, демо-режим ${DEMO_DEFAULT ? 'включён' : 'выключен'}`)
  // Накопившиеся сообщения НЕ сбрасываем: человек мог ответить ровно в секунду
  // перезапуска, и его цифра — единственное, чего бот от него ждёт. Потерять её
  // значит молча оборвать ему вечер.
  bot.start()

  const stop = () => { bot.stop(); db.close(); process.exit(0) }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}
