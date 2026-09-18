/**
 * Дублёр ядра переходов для тестов планировщика.
 *
 * Зона «время» проверяется в отрыве от зоны «диалог»: планировщику важно, КОГДА
 * зовут переход и что стало со сроком, а не какими словами бот поздоровался. Здесь
 * реализован минимум §5.6 — ровно столько, чтобы состояния и сессии двигались по
 * таблице §3.2, а исходящие сообщения складывались в список вместо Telegram.
 *
 * Почему дублёр, а не настоящий src/bot/flow.ts: он пишется параллельно другим
 * инженером, а приёмочный прогон «семь вечеров за пятнадцать минут» должен быть
 * зелёным уже сегодня. Когда ядро появится, эти же тесты можно натравить на него,
 * подменив createFlowDouble() на импорт модуля — сигнатуры совпадают.
 *
 * Одно отличие от ожидаемого поведения ядра сделано намеренно: skipEvening НЕ
 * двигает demo_day_counter. Так проверяется страховка планировщика, которая
 * додвигает счётчик виртуальных суток, если переход этого не сделал.
 */

import type { Ctx, Kb, Sender, Texts } from '../../src/ctx.ts'
import type { AfterSource, Category, SessionRow, UserRow } from '../../src/db/types.ts'
import type { TextsRepo } from '../../src/db/texts.ts'
import type { SchedulerFlow } from '../../src/scheduler/due.ts'
import {
  NO_DUE,
  planAfterAsked,
  planAfterTimeout,
  planDay8,
  planNowBefore,
  planPing,
  planSkipDeadline,
} from '../../src/scheduler/plan.ts'
import { timingsFor } from '../../src/timings.ts'
import { notifyFinished, notifyStarted } from '../../src/bot/notify.ts'
import { testCtx, type TestCtx, type TestCtxOptions } from './db.ts'

// ───────────────────────────── исходящие ─────────────────────────────

export type OutEntry = {
  kind: 'text' | 'raw' | 'audio' | 'photo' | 'edit' | 'action' | 'admin'
  to: number
  key?: string
  text: string
  kb?: Kb
}

export type Outbox = OutEntry[]

/** Подстановка {плейсхолдеров} без склонений: тексты проверяются в зоне B. */
export function renderWith(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{([a-zA-Zа-яА-Я_][a-zA-Z0-9а-яА-Я_]*)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  )
}

/** Реестр текстов поверх засеянной таблицы: ключи настоящие, логика — простейшая. */
export function createTextsDouble(repo: TextsRepo): Texts {
  const get = (key: string): string => repo.get(key) ?? `«${key}»`
  return {
    get,
    render: (key, vars) => renderWith(get(key), vars),
    buttonId: () => null,
    label: (id) => get(`btn.${id}`),
    reload: () => {},
    validate: () => ({ ok: true }),
  }
}

export function createSenderDouble(outbox: Outbox, texts: () => Texts): Sender {
  let msgId = 1000
  const push = (e: OutEntry): number => {
    outbox.push(e)
    return ++msgId
  }
  return {
    text: async (user, key, vars, kb) =>
      push({ kind: 'text', to: user.id, key, text: texts().render(key, vars), kb }),
    raw: async (user, text, kb) => push({ kind: 'raw', to: user.id, text, kb }),
    audio: async (user, p, caption, kb) => ({
      msgId: push({ kind: 'audio', to: user.id, key: p.slug, text: caption, kb }),
      fileId: `file-${p.slug}`,
    }),
    photo: async (user, png, caption, kb) =>
      push({ kind: 'photo', to: user.id, text: `${caption} [${png.length} байт]`, kb }),
    editText: async (user, _msgId, text, kb) => void push({ kind: 'edit', to: user.id, text, kb }),
    clearInline: async () => {},
    action: async (user, a) => void push({ kind: 'action', to: user.id, text: a }),
    answerCallback: async () => {},
    toAdmins: async (text) => void push({ kind: 'admin', to: 0, text }),
  }
}

/** Ctx с подставленными текстами и отправителем: всё, кроме сети, настоящее. */
export function ctxWithDoubles(opts: TestCtxOptions = {}): TestCtx & { outbox: Outbox } {
  const ctx = testCtx(opts) as TestCtx & { outbox: Outbox }
  const outbox: Outbox = []
  ctx.texts = createTextsDouble(ctx.repo.texts)
  ctx.send = createSenderDouble(outbox, () => ctx.texts)
  ctx.outbox = outbox
  return ctx
}

// ───────────────────────────── ядро-дублёр ─────────────────────────────

export type FlowDouble = SchedulerFlow & {
  calls: string[]
  startNow(ctx: Ctx, u: UserRow, now: number): Promise<void>
  acceptBefore(ctx: Ctx, u: UserRow, s: SessionRow, v: number, now: number): Promise<void>
  deliverPractice(ctx: Ctx, u: UserRow, s: SessionRow, c: Category, now: number): Promise<void>
  acceptAfter(ctx: Ctx, u: UserRow, s: SessionRow, v: number, src: AfterSource, now: number): Promise<void>
}

export type FlowDoubleOptions = {
  /** false — не реализовывать день восьмой: проверяем запасной вариант планировщика. */
  day8?: boolean
  /** Бросать исключение в startEvening: проверка due_attempts и ретраев. */
  failStartEvening?: boolean
}

/** Текст пинга по §3.3: пропуски старше номерных вариантов, кроме седьмого вечера. */
export function pingKey(u: UserRow, eveningNo: number): string {
  if (eveningNo === 7) return 'ev.before_last'
  if (u.consecutive_skips === 1) return 'ev.before_after_skip'
  if (u.consecutive_skips >= 2) return 'ev.before_after_skips'
  if (eveningNo === 1) return 'ev.before_first'
  if (eveningNo === 4) return 'ev.before_half'
  return 'ev.before'
}

export function createFlowDouble(opts: FlowDoubleOptions = {}): FlowDouble {
  const calls: string[] = []

  const flow: FlowDouble = {
    calls,

    async startEvening(ctx, u, eveningNo, now) {
      calls.push(`startEvening:${eveningNo}`)
      if (opts.failStartEvening) throw new Error('startEvening упал намеренно')
      const t = timingsFor(ctx, u)
      const s = ctx.repo.sessions.open({
        userId: u.id,
        runNo: u.run_no,
        kind: 'evening',
        eveningNo,
        ritualDate: t.ritualDate(u, now),
        now,
      })
      // prompt_sent_at пишется ДО обращения к Telegram — второй рубеж §4.4.
      ctx.repo.sessions.setPromptSent(s.id, now)
      const msgId = await ctx.send.text(u, pingKey(u, eveningNo), { n: eveningNo })
      ctx.repo.sessions.setPromptSent(s.id, now, msgId)
      ctx.repo.events.add(u.id, 'evening_started', now, { evening_no: eveningNo }, s.id)
      ctx.repo.users.setState(u.id, 'awaiting_before', planSkipDeadline(t, u, now))
    },

    async startNow(ctx, u, now) {
      calls.push('startNow')
      const t = timingsFor(ctx, u)
      const s = ctx.repo.sessions.open({
        userId: u.id,
        runNo: u.run_no,
        kind: 'now',
        eveningNo: null,
        ritualDate: t.ritualDate(u, now),
        now,
      })
      await ctx.send.text(u, 'now.before')
      ctx.repo.users.update(u.id, { state_before_now: u.state })
      ctx.repo.users.setState(u.id, 'awaiting_before', planNowBefore(t, now))
      void s
    },

    async acceptBefore(ctx, u, s, v, now) {
      calls.push(`acceptBefore:${v}`)
      ctx.repo.sessions.setBefore(s.id, v, now)
      await ctx.send.text(u, s.kind === 'now' ? 'now.before_ack' : 'ev.before_ack', { before: v })
      // Срок не меняется: до конца ритуальных суток он тот же самый.
      ctx.repo.users.setState(u.id, 'awaiting_state', { at: u.due_at, kind: u.due_kind })
    },

    async deliverPractice(ctx, u, s, category, now) {
      calls.push(`deliverPractice:${category}`)
      const p = ctx.repo.practices.listActive(category)[0]
      if (!p) throw new Error('в тесте нет практик')
      ctx.repo.sessions.setCategory(s.id, category, p.id)
      const sent = await ctx.send.audio(u, p, 'подпись')
      const t = timingsFor(ctx, u)
      ctx.db.transaction(() => {
        ctx.repo.sessions.markPracticeSent(s.id, sent.msgId, now)
        ctx.repo.plays.add(u.id, p.id, s.id, now)
        if (s.kind === 'evening' && s.evening_no !== null) {
          ctx.repo.users.update(u.id, {
            current_evening: s.evening_no,
            consecutive_skips: 0,
            not_today_streak: 0,
          })
        }
        ctx.repo.events.add(
          u.id,
          'practice_sent',
          now,
          { evening_no: s.evening_no, kind: s.kind, practice_id: p.id, category },
          s.id,
        )
      })()
      ctx.repo.users.setState(u.id, 'practicing', planAfterTimeout(t, now, p.duration_sec))
    },

    async askAfter(ctx, u, s, now, o) {
      calls.push(o?.morning ? 'askAfter:morning' : 'askAfter')
      await ctx.send.text(u, o?.morning ? 'ev.morning' : s.kind === 'now' ? 'now.after' : 'ev.after')
      const t = timingsFor(ctx, u)
      ctx.repo.users.setState(u.id, 'awaiting_after', planAfterAsked(t, u, s, now))
    },

    async acceptAfter(ctx, u, s, v, src, now) {
      calls.push(`acceptAfter:${v}:${src}`)
      const t = timingsFor(ctx, u)
      ctx.db.transaction(() => {
        ctx.repo.sessions.setAfter(s.id, v, src, now)
        ctx.repo.sessions.close(s.id, 'done', now)
        ctx.repo.events.add(
          u.id,
          s.kind === 'now' ? 'now_done' : 'evening_done',
          now,
          { evening_no: s.evening_no, before: s.before_value, after: v, after_source: src },
          s.id,
        )
      })()

      if (s.kind === 'now') {
        const back = u.state_before_now ?? 'idle'
        await ctx.send.text(u, 'now.close', { after: v })
        ctx.repo.users.update(u.id, { state_before_now: null })
        const fresh = ctx.repo.users.byId(u.id) as UserRow
        ctx.repo.users.setState(u.id, back, planPing(t, fresh, now))
        return
      }

      // Виртуальные сутки демо двигает закрытие вечера (§3.4): иначе следующий
      // вечер упёрся бы в уникальный индекс «один вечер на ритуальную дату».
      if (u.demo === 1) ctx.repo.users.update(u.id, { demo_day_counter: u.demo_day_counter + 1 })
      const fresh = ctx.repo.users.byId(u.id) as UserRow
      const closed = ctx.repo.sessions.byId(s.id) as SessionRow

      if (s.evening_no === 7) {
        await flow.finale(ctx, fresh, closed, now)
        return
      }
      await ctx.send.text(u, 'ev.close', { after: v, n: s.evening_no ?? 0 })
      ctx.repo.users.setState(u.id, 'idle', planPing(t, fresh, now))
    },

    async finale(ctx, u, s, now) {
      calls.push('finale')
      const t = timingsFor(ctx, u)
      await ctx.send.text(u, 'final.close', { after: s.after_value ?? '—' })
      await ctx.send.photo(u, Buffer.from('\x89PNG-fake'), ctx.texts.get('final.chart_caption'))
      await ctx.send.text(u, 'final.invite')
      ctx.db.transaction(() => {
        ctx.repo.users.update(u.id, { completed_at: now })
        ctx.repo.events.add(u.id, 'finished', now, {}, s.id)
      })()
      const fresh = ctx.repo.users.byId(u.id) as UserRow
      notifyFinished(ctx, fresh, now)
      ctx.repo.users.setState(u.id, 'completed', planDay8(t, fresh, now))
    },

    async skipEvening(ctx, u, s, now) {
      calls.push('skipEvening')
      const t = timingsFor(ctx, u)
      ctx.db.transaction(() => {
        if (s) ctx.repo.sessions.close(s.id, 'abandoned', now)
        ctx.repo.users.update(u.id, { consecutive_skips: u.consecutive_skips + 1 })
        ctx.repo.events.add(u.id, 'evening_skipped', now, { evening_no: s?.evening_no ?? null }, s?.id ?? null)
      })()
      const fresh = ctx.repo.users.byId(u.id) as UserRow
      ctx.repo.users.setState(u.id, 'idle', planPing(t, fresh, now))
    },

    async pause(ctx, u, reason, now) {
      calls.push(`pause:${reason}`)
      await ctx.send.text(u, reason === 'auto' ? 'ev.autopause' : 'pause.on')
      ctx.db.transaction(() => {
        ctx.repo.users.update(u.id, { paused_at: now })
        ctx.repo.events.add(u.id, reason === 'auto' ? 'autopaused' : 'paused', now)
      })()
      ctx.repo.users.setState(u.id, 'paused', NO_DUE)
    },
  }

  if (opts.day8 !== false) {
    flow.day8 = async (ctx, u, now) => {
      calls.push('day8')
      await ctx.send.text(u, 'final.day8')
      ctx.db.transaction(() => {
        ctx.repo.users.update(u.id, { day8_sent: 1 })
        ctx.repo.events.add(u.id, 'day8', now)
      })()
      ctx.repo.users.clearDue(u.id)
    }
  }

  return flow
}

// ───────────────────────── действия «человека» ─────────────────────────

/** Входящее сообщение всегда двигает last_seen_at — как middleware бота. */
function touch(ctx: Ctx, u: UserRow, now: number): UserRow {
  ctx.repo.users.touchSeen(u.id, now)
  return ctx.repo.users.byId(u.id) as UserRow
}

export function currentUser(ctx: Ctx, id: number): UserRow {
  return ctx.repo.users.byId(id) as UserRow
}

/**
 * Онбординг одним движением: результат строк 4–6 §3.2 без разбора текста.
 * Возвращает человека уже с часовым поясом и открытым первым вечером, если
 * вечернее окно открыто (в демо оно открыто всегда).
 */
export async function onboard(
  ctx: Ctx,
  flow: FlowDouble,
  now: number,
  init: { tgId?: number; eveningTime?: string; tzOffsetMin?: number; demo?: boolean } = {},
): Promise<UserRow> {
  const u0 = ctx.repo.users.create(init.tgId ?? 500_001, 'ru', now, {
    evening_time: init.eveningTime ?? '21:00',
    tz_offset_min: init.tzOffsetMin ?? 180,
    demo: init.demo ? 1 : 0,
  })
  ctx.repo.events.add(u0.id, 'started', now)
  notifyStarted(ctx, u0, now)

  const t = timingsFor(ctx, u0)
  if (t.eveningWindow(u0, now) && !ctx.repo.sessions.countedOn(u0.id, t.ritualDate(u0, now))) {
    await ctx.send.text(u0, 'onb.done_now')
    await flow.startEvening(ctx, u0, 1, now, { fromOnboarding: true })
  } else {
    await ctx.send.text(u0, 'onb.done_later')
    ctx.repo.users.setState(u0.id, 'idle', planPing(t, u0, now))
  }
  return currentUser(ctx, u0.id)
}

export async function answerBefore(ctx: Ctx, flow: FlowDouble, userId: number, v: number, now: number): Promise<void> {
  const u = touch(ctx, currentUser(ctx, userId), now)
  const s = ctx.repo.sessions.active(u.id)
  if (!s) throw new Error('нет активной сессии для цифры «до»')
  await flow.acceptBefore(ctx, u, s, v, now)
}

export async function chooseCategory(
  ctx: Ctx,
  flow: FlowDouble,
  userId: number,
  category: Category,
  now: number,
): Promise<void> {
  const u = touch(ctx, currentUser(ctx, userId), now)
  const s = ctx.repo.sessions.active(u.id)
  if (!s) throw new Error('нет активной сессии для выбора категории')
  await flow.deliverPractice(ctx, u, s, category, now)
}

export async function pressDone(ctx: Ctx, flow: FlowDouble, userId: number, now: number): Promise<void> {
  const u = touch(ctx, currentUser(ctx, userId), now)
  const s = ctx.repo.sessions.active(u.id)
  if (!s) throw new Error('нет активной сессии для «Готово»')
  await flow.askAfter(ctx, u, s, now)
}

export async function answerAfter(
  ctx: Ctx,
  flow: FlowDouble,
  userId: number,
  v: number,
  now: number,
  src: AfterSource = 'button',
): Promise<void> {
  const u = touch(ctx, currentUser(ctx, userId), now)
  const s = ctx.repo.sessions.active(u.id)
  if (!s) throw new Error('нет активной сессии для цифры «после»')
  await flow.acceptAfter(ctx, u, s, v, src, now)
}
