/**
 * Ядро переходов. §3.2 архитектуры (таблица переходов), §2 design-bot (карта пути).
 *
 * Этот файл зовут двое: бот (входящее сообщение) и планировщик (сработавший срок).
 * Поэтому здесь нет ни grammY, ни HTTP — только Ctx, пользователь, триггер и «сейчас».
 * Любая ветка, написанная в обработчике сообщения мимо этого файла, через неделю
 * разойдётся с той же веткой в планировщике: там «пришла цифра», тут «наступило
 * 04:00», а состояние одно на двоих.
 *
 * Три правила, на которых всё держится:
 *
 * 1. Один человек обрабатывается строго последовательно (withUserLock). Два быстрых
 *    тапа по категории иначе дадут две практики: между «проверить шаг» и «записать»
 *    успеет вклиниться второй await.
 * 2. Шаг «тратится» условным UPDATE (sessions.setBefore / setCategory / …). Если он
 *    вернул false — шаг уже сделан кем-то другим, и правильный ответ «это уже прошло»,
 *    а не повторное действие.
 * 3. Между записью состояния и вызовом Telegram нет транзакции: better-sqlite3
 *    синхронен, await внутри db.transaction() тихо коммитит раньше времени.
 *    Порядок всегда такой: транзакция «состояние + prompt_sent_at» → await отправки →
 *    транзакция «msg_id, practice_sent_at, plays, событие».
 */

import type { Ctx } from '../ctx.ts'
import type { ButtonId } from '../ctx.ts'
import type { Category, DueKind, SessionRow, UserRow, UserState } from '../db/types.ts'
import { createKeyboards, type Keyboards } from '../keyboards.ts'
import { parseStartPayload } from '../parse.ts'
import { bar, dots } from '../texts.ts'
import { fmtHm, fmtTz, whenWord } from '../time.ts'
import { timingsFor, type Timings } from '../timings.ts'
import { BlockedError } from './send.ts'

import { acceptClock, acceptHour, reprompt as repromptOnboarding, startOnboarding } from './onboarding.ts'
import {
  acceptBefore,
  acceptAfter,
  askAfter,
  declineEvening,
  deliverPractice,
  finale,
  morningNudge,
  repeatCategoryQuestion,
  skipEvening,
  startEvening,
} from './evening.ts'
import { closeNowByTimeout, dropNowSession, startNow } from './now.ts'
import { handleFreeText } from './freetext.ts'
import { quizAnswer, quizBack, quizDecline, quizStart, resumeQuiz } from './quiz.ts'

// §5.6 обещает эти функции из src/bot/flow.ts, а §1 — раскладку по темам.
// Реализация живёт по темам, контракт выполняется реэкспортом: планировщик
// (SchedulerFlow, src/scheduler/due.ts) берёт их именно отсюда.
export {
  acceptBefore,
  acceptAfter,
  askAfter,
  deliverPractice,
  finale,
  morningNudge,
  skipEvening,
  startEvening,
} from './evening.ts'
export { startNow } from './now.ts'

// ───────────────────────────── триггеры ─────────────────────────────

export type CbAction =
  | 'cat' | 'done' | 'change_time'
  | 'quiz_start' | 'quiz_skip' | 'quiz_answer' | 'quiz_back' | 'quiz_resume'

export type Trigger =
  | { t: 'start'; payload?: string }
  | { t: 'number'; value: number }
  | { t: 'text'; raw: string; isMedia?: boolean }
  | { t: 'button'; id: ButtonId }
  | {
      t: 'cb'
      action: CbAction
      sessionId?: number
      category?: Category
      q?: number
      value?: number
      cbId: string
      /** Сообщение с кнопкой: нужно, чтобы снять клавиатуру у отказа (строка 44). */
      msgId?: number
    }
  | { t: 'due'; kind: DueKind }

// ───────────────────────────── пер-пользовательский лок ─────────────────────────────

const locks = new Map<number, Promise<unknown>>()

/**
 * Очередь на одного человека. Глобального лока нет намеренно: пятьдесят человек в
 * 21:00 должны получить пинг параллельно, а вот один человек, тапнувший дважды, —
 * строго по очереди.
 */
export async function withUserLock<T>(userId: number, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(userId) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  locks.set(
    userId,
    next.catch(() => undefined),
  )
  try {
    return await next
  } finally {
    // Хвост очереди убираем за собой, иначе Map растёт на каждого, кто когда-либо писал.
    if (locks.get(userId) === next || locks.get(userId) === undefined) locks.delete(userId)
  }
}

// ───────────────────────────── общие мелочи ─────────────────────────────

export function kbs(ctx: Ctx): Keyboards {
  return createKeyboards(ctx.texts)
}

export function timings(ctx: Ctx, u: UserRow): Timings {
  return timingsFor(ctx, u)
}

/** Свежая строка пользователя: после каждой записи прежняя копия уже врёт. */
export function fresh(ctx: Ctx, u: UserRow): UserRow {
  return ctx.repo.users.byId(u.id) ?? u
}

/** Префикс ключей текста: вечер программы или внесчётная «Практика сейчас». */
export function prefixOf(s: Pick<SessionRow, 'kind'>): 'ev' | 'now' {
  return s.kind === 'evening' ? 'ev' : 'now'
}

/** Номер вечера, который человек видит в тексте: следующий незасчитанный. */
export function eveningLabel(u: UserRow): number {
  return Math.min(7, u.current_evening + 1)
}

/** Значения плейсхолдеров, которые могут понадобиться почти любому тексту. */
export function commonVars(ctx: Ctx, u: UserRow, now: number): Record<string, string | number> {
  const t = timings(ctx, u)
  const next = t.nextEvening(u, now)
  return {
    n: eveningLabel(u),
    dots: dots(u.current_evening),
    time: u.evening_time,
    when: whenWord(u, next, now),
    tz: fmtTz(u.tz_offset_min),
    id: u.id,
    tg_id: u.tg_id,
    clock: fmtHm(now, u.tz_offset_min),
    quiz_index: u.quiz_index ?? '',
    quiz_sum: u.quiz_sum ?? '',
  }
}

export function setDue(ctx: Ctx, u: UserRow, state: UserState, at: number | null, kind: DueKind | null): void {
  ctx.repo.users.setState(u.id, state, { at, kind })
}

/** Домашняя клавиатура для текущего состояния: «Продолжить» и «Ещё семь вечеров» — по месту. */
export function homeKbFor(ctx: Ctx, u: UserRow): ReturnType<Keyboards['homeKb']> {
  return kbs(ctx).homeKb({
    resume: u.state === 'paused',
    restart: u.state === 'completed' && ctx.settings.bool('allow_restart', true),
  })
}

/**
 * Пересчёт срока по текущему состоянию — то же, что plan.recompute у планировщика (§4.2).
 * Нужен везде, где состояние восстанавливают, а не задают: возврат из сессии
 * «Практика сейчас», разблокировка, рассинхрон due_kind и state.
 */
export function recomputeDue(ctx: Ctx, user: UserRow, now: number): void {
  const u = fresh(ctx, user)
  const t = timings(ctx, u)
  const s = ctx.repo.sessions.active(u.id)

  const put = (at: number | null, kind: DueKind | null): void => {
    ctx.repo.users.update(u.id, { due_at: at, due_kind: kind, due_attempts: 0 })
  }

  switch (u.state) {
    case 'idle':
      put(u.current_evening >= 7 ? null : t.nextEvening(u, now), u.current_evening >= 7 ? null : 'ping')
      return
    case 'awaiting_before':
    case 'awaiting_state':
      if (!s) {
        // Состояние ждёт сессии, которой нет, — чинимся в пользу дома.
        setDue(ctx, u, 'idle', t.nextEvening(u, now), 'ping')
        return
      }
      put(
        s.kind === 'evening' ? t.skipDeadline(u, now) : t.nowBeforeTimeout(now),
        s.kind === 'evening' ? 'skip_deadline' : 'now_timeout_before',
      )
      return
    case 'practicing':
      put(
        (s?.practice_sent_at ?? now) + t.afterTimeout(practiceDuration(ctx, s)),
        'after_timeout',
      )
      return
    case 'awaiting_after':
      if (!s) {
        setDue(ctx, u, 'idle', t.nextEvening(u, now), 'ping')
        return
      }
      if (s.kind === 'now') {
        put(t.nowAfterTimeout(now), 'now_timeout_after')
        return
      }
      if (s.nudged === 0) {
        const morning = t.morningAt(u, now)
        if (morning !== null) {
          put(morning, 'morning')
          return
        }
      }
      put(t.nextEvening(u, now), 'ping_or_close')
      return
    case 'completed':
    case 'quiz_after':
      put(u.day8_sent ? null : t.day8At(u, now), u.day8_sent ? null : 'day8')
      return
    default:
      // new, onb_*, change_*, paused, blocked — тут таймера нет и быть не должно.
      put(null, null)
  }
}

export function practiceDuration(ctx: Ctx, s: SessionRow | undefined | null): number | null {
  if (!s?.practice_id) return null
  return ctx.repo.practices.byId(s.practice_id)?.duration_sec ?? null
}

/**
 * Правило слияния. §2.3 design-bot, строка 29 §3.2.
 *
 * «Практика сейчас» внутри вечернего окна — это и есть сегодняшний вечер программы,
 * а не дополнительная практика. Иначе человек делает две за вечер и не понимает,
 * засчиталось ли, а на графике появляется точка, которой он не ждал.
 */
export function mergeRule(ctx: Ctx, u: UserRow, now: number): 'evening' | 'now' {
  if (u.state !== 'idle') return 'now'
  if (u.current_evening >= 7) return 'now'
  const t = timings(ctx, u)
  if (!t.eveningWindow(u, now)) return 'now'
  if (ctx.repo.sessions.countedOn(u.id, t.ritualDate(u, now))) return 'now'
  return 'evening'
}

// ───────────────────────────── пауза и возвращение ─────────────────────────────

/** Закрытие активной сессии при паузе/блокировке. §2.5: до практики — отказ, после — состоявшийся вечер. */
export function closeActiveSession(ctx: Ctx, u: UserRow, now: number): void {
  const s = ctx.repo.sessions.active(u.id)
  if (!s) return
  ctx.repo.sessions.close(s.id, s.practice_sent_at ? 'done' : 'declined', now)
}

export async function pause(ctx: Ctx, user: UserRow, reason: 'button' | 'text' | 'auto', now: number): Promise<void> {
  const u = fresh(ctx, user)
  ctx.db.transaction(() => {
    closeActiveSession(ctx, u, now)
    ctx.repo.users.update(u.id, { paused_at: now, active_session_id: null })
    ctx.repo.users.setState(u.id, 'paused', { at: null, kind: null })
    ctx.repo.events.add(u.id, reason === 'auto' ? 'autopaused' : 'paused', now, {
      evening_no: u.current_evening,
      reason,
    })
  })()

  const after = fresh(ctx, u)
  const kb = kbs(ctx).homeKb({ resume: true })
  await ctx.send.text(after, reason === 'auto' ? 'ev.autopause' : 'pause.on', commonVars(ctx, after, now), kb)
}

export async function resume(ctx: Ctx, user: UserRow, now: number): Promise<void> {
  const u = fresh(ctx, user)
  ctx.repo.users.update(u.id, { consecutive_skips: 0, not_today_streak: 0, paused_at: null })
  ctx.repo.events.add(u.id, 'resumed', now, { evening_no: u.current_evening })

  const after = fresh(ctx, u)
  const t = timings(ctx, after)
  const canStartNow =
    after.current_evening < 7 &&
    t.eveningWindow(after, now) &&
    !ctx.repo.sessions.countedOn(after.id, t.ritualDate(after, now))

  if (canStartNow) {
    setDue(ctx, after, 'idle', null, null)
    await startEvening(ctx, fresh(ctx, after), after.current_evening + 1, now)
    return
  }

  setDue(ctx, after, 'idle', t.nextEvening(after, now), 'ping')
  const u2 = fresh(ctx, after)
  await ctx.send.text(u2, 'pause.off', commonVars(ctx, u2, now), kbs(ctx).homeKb())
}

/** «Ещё семь вечеров». Строка 36 §3.2, §2.8 design-bot. */
export async function restartProgram(ctx: Ctx, user: UserRow, now: number): Promise<void> {
  const u = fresh(ctx, user)
  // Кнопку могли выключить в настройках уже после того, как она попала человеку
  // на экран: тогда нажатие — просто старая кнопка, а не новый круг.
  if (!ctx.settings.bool('allow_restart', true)) {
    await reprompt(ctx, u, now)
    return
  }

  ctx.db.transaction(() => {
    ctx.repo.users.update(u.id, {
      run_no: u.run_no + 1,
      current_evening: 0,
      consecutive_skips: 0,
      not_today_streak: 0,
      day8_sent: 0,
      quiz_after_declined: 0,
      quiz_step: 0,
      quiz_resume_offered: 0,
      completed_at: null,
    })
    ctx.repo.events.add(u.id, 'restarted', now, { run_no: u.run_no + 1 })
  })()

  const after = fresh(ctx, u)
  const t = timings(ctx, after)
  setDue(ctx, after, 'idle', t.nextEvening(after, now), 'ping')

  const u2 = fresh(ctx, after)
  await ctx.send.text(u2, 'restart.done', commonVars(ctx, u2, now), kbs(ctx).homeKb())

  if (t.eveningWindow(u2, now) && !ctx.repo.sessions.countedOn(u2.id, t.ritualDate(u2, now))) {
    setDue(ctx, u2, 'idle', null, null)
    await startEvening(ctx, fresh(ctx, u2), 1, now)
  }
}

/** Возврат человека после 403. Строка 42 §3.2. */
export function unblock(ctx: Ctx, user: UserRow, now: number): UserRow {
  const u = fresh(ctx, user)
  const saved = u.state_before_block
  // Состояния внутри сессии не восстанавливаем: сессию закрыли при блокировке,
  // и «ждём цифру» без сессии — это тупик, из которого человек не выйдет.
  const inSession: UserState[] = ['awaiting_before', 'awaiting_state', 'practicing', 'awaiting_after']
  const target: UserState = !saved || inSession.includes(saved) ? 'idle' : saved

  ctx.db.transaction(() => {
    ctx.repo.users.update(u.id, { state: target, state_before_block: null, blocked_at: null })
    ctx.repo.events.add(u.id, 'unblocked', now, { state: target })
  })()
  recomputeDue(ctx, fresh(ctx, u), now)
  return fresh(ctx, u)
}

// ───────────────────────────── reprompt (§3.6) ─────────────────────────────

/**
 * Канонический вопрос текущего состояния.
 *
 * Единственный ответ на /start внутри сессии, на нажатие старой кнопки и на
 * восстановление после сбоя. Отдельной логики для этих трёх случаев не пишем —
 * иначе их станет три разных, и две из них устареют.
 */
export async function reprompt(ctx: Ctx, user: UserRow, now: number): Promise<void> {
  const u = fresh(ctx, user)
  const K = kbs(ctx)
  const vars = commonVars(ctx, u, now)
  const s = ctx.repo.sessions.active(u.id)

  switch (u.state) {
    case 'onb_hour':
    case 'onb_clock':
    case 'change_hour':
    case 'change_clock':
      await repromptOnboarding(ctx, u, now)
      return

    case 'awaiting_before': {
      if (!s) {
        recomputeDue(ctx, u, now)
        return
      }
      const kb = K.numbersKb({ notToday: s.kind === 'evening' })
      if (s.kind === 'now') await ctx.send.text(u, 'now.before', vars, kb)
      else await ctx.send.text(u, eveningPromptKey(u, s.evening_no ?? 1), { ...vars, n: s.evening_no ?? 1 }, kb)
      return
    }

    case 'awaiting_state':
      if (s) await repeatCategoryQuestion(ctx, u, s, now)
      return

    case 'practicing':
      // Аудио переотправлять нельзя: оно выше в чате, и второй файл выглядит как сбой.
      await ctx.send.text(u, 'free.practicing', vars)
      return

    case 'awaiting_after':
      if (s) await ctx.send.text(u, `${prefixOf(s)}.after`, vars, K.numbersKb())
      return

    // Телеграм разрешает одному сообщению одну клавиатуру, а §2.9 хочет и inline
    // «Поменять время», и домашний ряд. Домашний ряд у человека уже стоит с прошлых
    // сообщений (reply-клавиатура живёт до явной замены), поэтому здесь inline.
    case 'paused':
      await ctx.send.text(u, 'start.paused', vars, K.changeTimeKb())
      return

    case 'completed':
      await ctx.send.text(u, 'start.completed', vars, homeKbFor(ctx, u))
      return

    case 'quiz_after':
      // Канонический вопрос этого состояния — текущий вопрос теста.
      await resumeQuiz(ctx, u, now)
      return

    default:
      await ctx.send.text(u, 'start.idle', vars, K.changeTimeKb())
  }
}

/** Выбор текста вечернего пинга. §3.3 архитектуры. */
export function eveningPromptKey(u: UserRow, eveningNo: number): string {
  if (eveningNo === 7) return 'ev.before_last'
  if (u.consecutive_skips >= 2) return 'ev.before_after_skips'
  if (u.consecutive_skips === 1) return 'ev.before_after_skip'
  if (eveningNo === 1) return 'ev.before_first'
  if (eveningNo === 4) return 'ev.before_half'
  return 'ev.before'
}

// ───────────────────────────── вход ─────────────────────────────

/**
 * Единственная точка входа. Внутри: лок на пользователя, отметка «был здесь»,
 * возврат из blocked и глушение BlockedError — выше по стеку про неё знать нечего.
 */
export async function handle(ctx: Ctx, user: UserRow, trg: Trigger, now: number): Promise<void> {
  await withUserLock(user.id, async () => {
    let u = ctx.repo.users.byId(user.id)
    if (!u) return

    if (trg.t !== 'due') {
      ctx.repo.users.touchSeen(u.id, now)
      u = fresh(ctx, u)
      if (u.state === 'blocked') u = unblock(ctx, u, now)
    }

    try {
      await route(ctx, u, trg, now)
    } catch (err) {
      if (err instanceof BlockedError) return
      throw err
    }
  })
}

async function route(ctx: Ctx, u: UserRow, trg: Trigger, now: number): Promise<void> {
  ctx.log.debug('переход', { user_id: u.id, state: u.state, trigger: trg.t })
  switch (trg.t) {
    case 'start':
      return onStart(ctx, u, trg.payload, now)
    case 'number':
      return onNumber(ctx, u, trg.value, now)
    case 'text':
      return onText(ctx, u, trg.raw, now, trg.isMedia === true)
    case 'button':
      return onButton(ctx, u, trg.id, now)
    case 'cb':
      return onCallback(ctx, u, trg, now)
    case 'due':
      return onDue(ctx, u, trg.kind, now)
  }
}

// ───────────────────────────── /start ─────────────────────────────

async function onStart(ctx: Ctx, u: UserRow, payload: string | undefined, now: number): Promise<void> {
  if (u.state === 'new') {
    await startOnboarding(ctx, u, payload, now)
    return
  }
  // Повторный /start: прогресс не сбрасывается никогда, индекс с лендинга не
  // перезаписывает первый замер — точка отсчёта у круга одна (§2 интеграции теста).
  const parsed = parseStartPayload(payload)
  if (parsed.quizSum !== null) {
    if (u.state === 'completed' && u.quiz_sum !== null) {
      ctx.repo.quiz.resetIncoming(u.id, parsed.quizSum, now)
    } else {
      ctx.repo.quiz.setIncoming(u.id, parsed.quizSum, now)
    }
    ctx.repo.events.add(u.id, 'quiz_in', now, { sum: parsed.quizSum, repeat: true })
  }
  await reprompt(ctx, fresh(ctx, u), now)
}

// ───────────────────────────── цифра ─────────────────────────────

async function onNumber(ctx: Ctx, u: UserRow, value: number, now: number): Promise<void> {
  const s = ctx.repo.sessions.active(u.id)

  switch (u.state) {
    case 'awaiting_before':
      if (!s) {
        recomputeDue(ctx, u, now)
        return
      }
      return acceptBefore(ctx, u, s, value, now)

    case 'awaiting_state':
      // Цифра уже записана, ждём категорию: повторяем вопрос, а не переспрашиваем цифру.
      if (s) await repeatCategoryQuestion(ctx, u, s, now)
      return

    case 'practicing':
      // Строка 22 §3.2: человек поспешил и прислал цифру, не нажав «Готово».
      // Вопрос «а сейчас как» после этого был бы издевательством.
      if (s) return acceptAfter(ctx, u, s, value, 'early', now)
      return

    case 'awaiting_after':
      if (s) return acceptAfter(ctx, u, s, value, afterSourceFor(ctx, s, now), now)
      return

    default:
      // Цифра не к месту (idle, paused, completed, онбординг) — это свободный текст.
      return handleFreeText(ctx, u, String(value), now)
  }
}

/**
 * Откуда пришла цифра «после». §3.4 design-bot.
 *
 * Утро видно по nudged. Кнопку от таймера отличаем по тому, наступил ли уже момент
 * таймера: до него вопрос мог появиться только от нажатия «Готово». Отдельной
 * колонки под это в схеме нет, а заранее писать after_source нельзя — он попадёт
 * в статистику качества замера даже у сессий, где цифра так и не пришла.
 */
export function afterSourceFor(ctx: Ctx, s: SessionRow, now: number): 'button' | 'timer' | 'morning' {
  if (s.nudged === 1) return 'morning'
  const u = ctx.repo.users.byId(s.user_id)
  if (!u || !s.practice_sent_at) return 'button'
  const timerAt = s.practice_sent_at + timings(ctx, u).afterTimeout(practiceDuration(ctx, s))
  return now < timerAt ? 'button' : 'timer'
}

// ───────────────────────────── свободный текст ─────────────────────────────

async function onText(ctx: Ctx, u: UserRow, raw: string, now: number, isMedia: boolean): Promise<void> {
  switch (u.state) {
    case 'new':
      return startOnboarding(ctx, u, undefined, now)
    case 'onb_hour':
    case 'change_hour':
      return acceptHour(ctx, u, raw, now)
    case 'onb_clock':
    case 'change_clock':
      return acceptClock(ctx, u, raw, now)
    default:
      return handleFreeText(ctx, u, raw, now, isMedia)
  }
}

// ───────────────────────────── reply-кнопки ─────────────────────────────

async function onButton(ctx: Ctx, u: UserRow, id: ButtonId, now: number): Promise<void> {
  const s = ctx.repo.sessions.active(u.id)

  switch (id) {
    case 'practice_now':
      if (u.state === 'awaiting_after') {
        await ctx.send.text(u, 'now.finish_first', commonVars(ctx, u, now), kbs(ctx).numbersKb())
        return
      }
      if (u.state === 'idle' || u.state === 'paused' || u.state === 'completed') {
        if (mergeRule(ctx, u, now) === 'evening') {
          setDue(ctx, u, 'idle', null, null)
          return startEvening(ctx, fresh(ctx, u), u.current_evening + 1, now)
        }
        return startNow(ctx, u, now)
      }
      // Внутри сессии кнопка «Практика сейчас» — это старая клавиатура; повторяем вопрос.
      return reprompt(ctx, u, now)

    case 'not_today':
      if (s && s.kind === 'evening' && (u.state === 'awaiting_before' || u.state === 'awaiting_state')) {
        return declineEvening(ctx, u, s, now)
      }
      return reprompt(ctx, u, now)

    case 'better_at':
      // Строка 7 §3.2: первый вечер из онбординга переносится на вечерний час.
      if (s && u.state === 'awaiting_before') {
        ctx.repo.sessions.deleteSession(s.id)
        const t = timings(ctx, u)
        setDue(ctx, u, 'idle', t.nextEvening(u, now), 'ping')
        const u2 = fresh(ctx, u)
        await ctx.send.text(u2, 'onb.done_later', commonVars(ctx, u2, now), kbs(ctx).homeKb())
        return
      }
      return reprompt(ctx, u, now)

    case 'pause':
      return pause(ctx, u, 'button', now)

    case 'remind_tomorrow': {
      const t = timings(ctx, u)
      setDue(ctx, u, 'idle', t.nextEvening(u, now), 'ping')
      const u2 = fresh(ctx, u)
      await ctx.send.text(u2, 'ev.not_today', commonVars(ctx, u2, now), kbs(ctx).homeKb())
      return
    }

    case 'resume':
      if (u.state === 'paused') return resume(ctx, u, now)
      return reprompt(ctx, u, now)

    case 'restart':
      if (u.state === 'completed') return restartProgram(ctx, u, now)
      return reprompt(ctx, u, now)

    case 'other_hour':
      await ctx.send.text(u, 'onb.hour_retry', commonVars(ctx, u, now), kbs(ctx).hoursKb())
      return

    case 'other_clock':
      await ctx.send.text(u, 'onb.clock_retry', commonVars(ctx, u, now))
      return
  }
}

// ───────────────────────────── inline-кнопки ─────────────────────────────

async function onCallback(
  ctx: Ctx,
  u: UserRow,
  trg: Extract<Trigger, { t: 'cb' }>,
  now: number,
): Promise<void> {
  const s = ctx.repo.sessions.active(u.id)

  const expired = async (): Promise<void> => {
    await ctx.send.answerCallback(trg.cbId, 'cb.expired')
  }

  switch (trg.action) {
    case 'cat': {
      // Кнопка привязана к сессии: вчерашнее сообщение с категориями не имеет
      // права открыть сегодняшнюю практику.
      if (!s || u.state !== 'awaiting_state' || trg.sessionId !== s.id || !trg.category) return expired()
      await ctx.send.answerCallback(trg.cbId)
      return deliverPractice(ctx, u, s, trg.category, now)
    }

    case 'done': {
      if (!s || u.state !== 'practicing' || trg.sessionId !== s.id) return expired()
      await ctx.send.answerCallback(trg.cbId)
      return askAfter(ctx, u, s, now)
    }

    case 'change_time': {
      if (u.state !== 'idle' && u.state !== 'paused' && u.state !== 'completed') return expired()
      await ctx.send.answerCallback(trg.cbId)
      // Куда вернуться после смены времени: строка 39 велит уйти в idle, но это
      // сняло бы паузу и разбудило бы завершившего программу. Возвращаем туда, где были.
      ctx.repo.users.update(u.id, { state_before_now: u.state })
      setDue(ctx, u, 'change_hour', null, null)
      const u2 = fresh(ctx, u)
      await ctx.send.text(u2, 'time.hour_ask', commonVars(ctx, u2, now), kbs(ctx).hoursKb())
      return
    }

    case 'quiz_start':
      await ctx.send.answerCallback(trg.cbId)
      return quizStart(ctx, u, now)

    case 'quiz_skip':
      await ctx.send.answerCallback(trg.cbId)
      return quizDecline(ctx, u, now, trg.msgId)

    case 'quiz_answer':
      if (u.state !== 'quiz_after' || trg.q === undefined || trg.value === undefined) return expired()
      await ctx.send.answerCallback(trg.cbId)
      return quizAnswer(ctx, u, trg.q, trg.value, now)

    case 'quiz_back':
      if (u.state !== 'quiz_after' || trg.q === undefined) return expired()
      await ctx.send.answerCallback(trg.cbId)
      return quizBack(ctx, u, trg.q, now)

    case 'quiz_resume':
      if (u.state !== 'quiz_after') return expired()
      await ctx.send.answerCallback(trg.cbId)
      return resumeQuiz(ctx, u, now)
  }
}

// ───────────────────────────── сроки ─────────────────────────────

/**
 * Обработка сработавшего due_at. §4.2 архитектуры.
 *
 * Диспетчер идёт по due_kind, а состояние работает сторожем: если они не сходятся,
 * действие не выполняется, а срок пересчитывается. Так рассинхрон (ручная правка в
 * админке, баг) лечится сам и не превращается в сообщение не к месту.
 */
async function onDue(ctx: Ctx, u: UserRow, kind: DueKind, now: number): Promise<void> {
  const s = ctx.repo.sessions.active(u.id)
  const t = timings(ctx, u)

  const heal = (): void => {
    ctx.log.warn('срок не совпал с состоянием, пересчитываем', { user_id: u.id, state: u.state, due_kind: kind })
    recomputeDue(ctx, u, now)
  }

  switch (kind) {
    case 'ping':
      if (u.state !== 'idle') {
        // Человек внутри сессии «Практика сейчас» — вечер подождёт (строка 11).
        if (s?.kind === 'now') {
          ctx.repo.users.update(u.id, { due_at: now + 60, due_kind: 'ping', due_attempts: 0 })
          return
        }
        return heal()
      }
      return onPing(ctx, u, now)

    case 'skip_deadline':
      if (!s) return heal()
      if (s.kind === 'now') return dropNowSession(ctx, u, s, now)
      if (u.state !== 'awaiting_before' && u.state !== 'awaiting_state') return heal()
      return skipEvening(ctx, u, s, now)

    case 'now_timeout_before':
      if (!s || s.kind !== 'now') return heal()
      return dropNowSession(ctx, u, s, now)

    case 'after_timeout': {
      if (u.state !== 'practicing' || !s) return heal()
      const timerAt = (s.practice_sent_at ?? now) + t.afterTimeout(practiceDuration(ctx, s))
      if (now - timerAt >= t.lateAfterSec) {
        // Строка 21: процесс лежал ночью. Вопрос «а сейчас как» в семь утра про
        // вчерашнюю практику — хуже молчания; ждём утреннего догона.
        const morning = t.morningAt(u, now)
        setDue(ctx, u, 'awaiting_after', morning ?? t.nextEvening(u, now), morning ? 'morning' : 'ping_or_close')
        return
      }
      return askAfter(ctx, u, s, now)
    }

    case 'morning': {
      if (u.state !== 'awaiting_after' || !s || s.kind !== 'evening') return heal()
      // Догон ровно один на сессию: второе «а как ночь?» подряд превращает
      // заботу в опрос.
      if (s.nudged === 1 || t.demo) {
        setDue(ctx, u, 'awaiting_after', t.nextEvening(u, now), 'ping_or_close')
        return
      }
      return morningNudge(ctx, u, s, now)
    }

    case 'ping_or_close': {
      if (u.state !== 'awaiting_after' || !s) return heal()
      if (s.kind === 'now') return closeNowByTimeout(ctx, u, s, now)
      // Цифры «после» так и нет. Вечер остаётся засчитанным, на графике будет разрыв.
      return closeEveningWithoutAfter(ctx, u, s, now)
    }

    case 'now_timeout_after':
      if (!s || s.kind !== 'now') return heal()
      return closeNowByTimeout(ctx, u, s, now)

    case 'day8': {
      if (u.state !== 'completed' && u.state !== 'quiz_after') return heal()
      if (u.day8_sent) {
        ctx.repo.users.clearDue(u.id)
        return
      }
      return sendDay8(ctx, u, now)
    }

    case 'retry':
      return heal()
  }
}

/** Строки 8–10 §3.2: наступил вечерний час. */
async function onPing(ctx: Ctx, u: UserRow, now: number): Promise<void> {
  const t = timings(ctx, u)

  if (u.current_evening >= 7) {
    recomputeDue(ctx, u, now)
    return
  }

  if (u.consecutive_skips >= t.autopauseAfterSkips) {
    return pause(ctx, u, 'auto', now)
  }

  const ritual = t.ritualDate(u, now)
  if (ctx.repo.sessions.countedOn(u.id, ritual)) {
    // Вечер на эту дату уже прошёл (человек нажал «Практика сейчас» раньше пинга).
    setDue(ctx, u, 'idle', t.nextEvening(u, now), 'ping')
    return
  }

  // Строка 9: срок пролежал до следующих ритуальных суток. Молча считаем пропуск —
  // писать «добрый вечер» в семь утра нельзя.
  if (!t.eveningWindow(u, now)) {
    ctx.db.transaction(() => {
      ctx.repo.users.update(u.id, { consecutive_skips: u.consecutive_skips + 1 })
      ctx.repo.events.add(u.id, 'evening_skipped', now, { evening_no: u.current_evening + 1, silent: true })
    })()
    const u2 = fresh(ctx, u)
    setDue(ctx, u2, 'idle', timings(ctx, u2).nextEvening(u2, now), 'ping')
    return
  }

  return startEvening(ctx, u, u.current_evening + 1, now)
}

/** Строка 27 §3.2: пришёл следующий вечер, а цифры «после» так и нет. */
export async function closeEveningWithoutAfter(
  ctx: Ctx,
  user: UserRow,
  s: SessionRow,
  now: number,
): Promise<void> {
  const u = fresh(ctx, user)
  ctx.db.transaction(() => {
    ctx.repo.sessions.close(s.id, 'done', now)
    ctx.repo.events.add(u.id, 'evening_done', now, {
      evening_no: s.evening_no,
      before: s.before_value,
      after: null,
      after_source: null,
      practice_id: s.practice_id,
    })
    if (u.demo) ctx.repo.users.update(u.id, { demo_day_counter: u.demo_day_counter + 1 })
  })()

  if (s.evening_no === 7) {
    await finale(ctx, fresh(ctx, u), s, now)
    return
  }

  const u2 = fresh(ctx, u)
  setDue(ctx, u2, 'idle', null, null)
  await onPing(ctx, fresh(ctx, u2), now)
}

/** Строка 35 §3.2, §2.8 design-bot: утро восьмого дня, одно сообщение и тишина. */
export async function sendDay8(ctx: Ctx, user: UserRow, now: number): Promise<void> {
  const u = fresh(ctx, user)
  const channel = ctx.settings.str('channel_url', '')
  const K = kbs(ctx)

  ctx.db.transaction(() => {
    ctx.repo.users.update(u.id, { day8_sent: 1, due_at: null, due_kind: null })
    ctx.repo.events.add(u.id, 'day8', now, {})
  })()

  const u2 = fresh(ctx, u)
  // Одно сообщение — одна клавиатура. Reply-ряд «Практика сейчас / Ещё семь вечеров»
  // остался с финала и никуда не делся, поэтому ссылку на канал показываем inline.
  const kb = channel ? K.urlKb('btn.channel', channel) : homeKbFor(ctx, u2)
  await ctx.send.text(u2, 'final.day8', commonVars(ctx, u2, now), kb)
}
