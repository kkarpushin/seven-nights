/**
 * Обработка сработавших сроков. §4.2 архитектуры, строки 8–11, 14, 15, 20, 21,
 * 26–28, 35 таблицы переходов §3.2.
 *
 * Диспетчер идёт по due_kind, а состояние служит сторожем: если они разошлись
 * (ручная правка в админке, баг, перезапуск посреди перехода), мы НЕ выполняем
 * действие наугад, а пересчитываем срок и ждём его. Человек скорее простит
 * опоздание на вечер, чем вопрос «а сейчас как?» про практику, которой не было.
 *
 * Три правила этого файла:
 *
 * 1. Диалог здесь не пишется. Всё, что видит человек, делают функции flow.* —
 *    те же самые, что зовёт бот. Планировщик только решает, когда их звать.
 *    Исключения — три места, где по дизайну НЕЛЬЗЯ ничего отправлять (строки 9,
 *    21, 27) и где вся работа сводится к записи состояния.
 *
 * 2. Ни одного await внутри транзакций: better-sqlite3 синхронен (§2.5.1).
 *
 * 3. После вызова flow.* срок проверяется. Если переход его не поставил, ставим
 *    сами через plan.recompute — иначе человек застыл бы навсегда, и заметили бы
 *    это только по жалобе «бот замолчал».
 */

import type { Ctx } from '../ctx.ts'
import type { DueKind, SessionRow, UserRow, UserState } from '../db/types.ts'
import { timingsFor } from '../timings.ts'
import { notifyRaw } from '../bot/notify.ts'
import {
  applyRecompute,
  NO_DUE,
  planAfterAsked,
  planDay8,
  planPing,
  type Plan,
} from './plan.ts'

/**
 * То, что планировщику нужно от ядра переходов (§5.6). Объект, а не прямой импорт,
 * по двум причинам: тесты планировщика не должны тащить за собой Telegram и тексты,
 * а граф импортов §11.1 запрещает обратную стрелку flow → scheduler.
 *
 * Необязательные члены — точки, которых в §5.6 нет: если ядро их реализует, зовём
 * их, если нет — обходимся тем, что можно сделать состоянием и одним сообщением.
 */
export type SchedulerFlow = {
  startEvening(
    ctx: Ctx,
    u: UserRow,
    eveningNo: number,
    now: number,
    opts?: { fromOnboarding?: boolean },
  ): Promise<void>
  askAfter(ctx: Ctx, u: UserRow, s: SessionRow, now: number, opts?: { morning?: boolean }): Promise<void>
  skipEvening(ctx: Ctx, u: UserRow, s: SessionRow | null, now: number): Promise<void>
  finale(ctx: Ctx, u: UserRow, s: SessionRow, now: number): Promise<void>
  pause(ctx: Ctx, u: UserRow, reason: 'button' | 'text' | 'auto', now: number): Promise<void>
  /** Утренний догон: тот же вопрос «после», но текстом ev.morning. */
  morningNudge?(ctx: Ctx, u: UserRow, s: SessionRow, now: number): Promise<void>
  /** Сообщение дня восьмого; без него шлём final.day8 сами (см. sendDay8Fallback). */
  day8?(ctx: Ctx, u: UserRow, now: number): Promise<void>
}

/** Чем закончилась обработка одного срока — для логов и тестов. */
export type DueOutcome =
  | 'handled' // действие выполнено
  | 'silent' // сработало, но человеку ничего не ушло (так задумано)
  | 'healed' // due_kind не совпал с состоянием: пересчитали срок, ничего не сделали
  | 'postponed' // отложили на пару минут, момент неподходящий
  | 'stopped' // срок погашен: делать больше нечего

const STATES_BEFORE: readonly UserState[] = ['awaiting_before', 'awaiting_state']

/** На сколько откладываем пинг, если человек занят сессией «Практика сейчас» (строка 11). */
const POSTPONE_SEC = 60

/**
 * Единственная точка входа. Возвращает исход; сам не ловит исключения — их ловит
 * цикл тика, чтобы упавший обработчик увеличил due_attempts и повторился через две
 * минуты, а не остановил весь тик.
 */
export async function handleDue(
  ctx: Ctx,
  u: UserRow,
  kind: DueKind,
  now: number,
  flow: SchedulerFlow,
  /** Значение due_at, на которое мы среагировали (до захвата). Нужно, чтобы понять опоздание. */
  seenDueAt: number,
): Promise<DueOutcome> {
  switch (kind) {
    case 'ping':
      return await onPing(ctx, u, now, flow, seenDueAt)
    case 'skip_deadline':
      return await onSkipDeadline(ctx, u, now, flow)
    case 'after_timeout':
      return await onAfterTimeout(ctx, u, now, flow, seenDueAt)
    case 'morning':
      return await onMorning(ctx, u, now, flow)
    case 'ping_or_close':
      return await onPingOrClose(ctx, u, now, flow)
    case 'now_timeout_before':
      return onNowTimeoutBefore(ctx, u, now)
    case 'now_timeout_after':
      return onNowTimeoutAfter(ctx, u, now)
    case 'day8':
      return await onDay8(ctx, u, now, flow)
    // 'retry' мы не ставим сами: захват сохраняет исходный due_kind. Если он всё-таки
    // появился (правка в админке), пересчёт — единственный осмысленный ответ.
    case 'retry':
    default:
      return heal(ctx, u, now, `неизвестный due_kind «${kind}»`)
  }
}

/** Рассинхрон: ничего не отправляем, ставим правильный срок, пишем warn. */
function heal(ctx: Ctx, u: UserRow, now: number, why: string): DueOutcome {
  const plan = applyRecompute(ctx, u, now)
  ctx.log.warn('срок не совпал с состоянием, пересчитали', {
    user_id: u.id,
    state: u.state,
    due_kind: u.due_kind,
    why,
    next_at: plan.at,
    next_kind: plan.kind,
  })
  return 'healed'
}

/** Записать срок, посчитанный планом. */
function setPlan(ctx: Ctx, u: UserRow, plan: Plan): void {
  ctx.repo.users.setDue(u.id, plan)
}

// ───────────────────────────── ping (строки 8–11) ─────────────────────────────

async function onPing(
  ctx: Ctx,
  u: UserRow,
  now: number,
  flow: SchedulerFlow,
  seenDueAt: number,
): Promise<DueOutcome> {
  if (u.state !== 'idle') return heal(ctx, u, now, 'пинг ждал состояния idle')

  const t = timingsFor(ctx, u)
  const active = ctx.repo.sessions.active(u.id)

  // Строка 11: человек в середине «Практики сейчас». Вечер подождёт минуту —
  // две практики подряд это не забота, а навязчивость.
  if (active && active.kind === 'now') {
    setPlan(ctx, u, { at: now + POSTPONE_SEC, kind: 'ping' })
    return 'postponed'
  }

  // Строка 10: три пропуска подряд — бот замолкает сам, не дожидаясь, пока человек
  // начнёт его игнорировать. Проверка идёт ПЕРЕД проверкой даты: если сервер лежал
  // неделю, пропуски уже накопились, и правильный ответ — пауза, а не пинг.
  if (u.consecutive_skips >= t.autopauseAfterSkips) {
    await flow.pause(ctx, u, 'auto', now)
    ensureDue(ctx, u, now, NO_DUE)
    return 'handled'
  }

  const plannedRitual = t.ritualDate(u, seenDueAt)
  const currentRitual = t.ritualDate(u, now)

  // Строка 9: пинг протух — ритуальные сутки, на которые он ставился, уже кончились
  // (процесс лежал). Слать вечер задним числом нельзя: человек получит в полдень
  // «Добрый вечер». Засчитываем пропуск молча.
  if (plannedRitual !== currentRitual) {
    ctx.db.transaction(() => {
      ctx.repo.users.update(u.id, { consecutive_skips: u.consecutive_skips + 1 })
      ctx.repo.events.add(u.id, 'evening_skipped', now, {
        evening_no: u.current_evening + 1,
        reason: 'stale_ping',
        planned_ritual_date: plannedRitual,
      })
    })()
    const fresh = ctx.repo.users.byId(u.id) ?? u
    // Пропуск мог оказаться третьим — тогда следующий пинг сразу уйдёт в автопаузу.
    setPlan(ctx, fresh, planPing(t, fresh, now))
    return 'silent'
  }

  // Вечер на эти ритуальные сутки уже засчитан («Практика сейчас» в вечернем окне
  // слилась с вечером, строка 29) — второй вечер за сутки запрещён инвариантом.
  if (ctx.repo.sessions.countedOn(u.id, currentRitual)) {
    setPlan(ctx, u, planPing(t, u, now))
    return 'silent'
  }

  const eveningNo = u.current_evening + 1
  if (eveningNo > 7) {
    // Семь вечеров пройдены, а состояние idle — значит финал не закрылся. Пинговать
    // восьмой вечер нельзя: программа семидневная. Гасим срок и говорим об этом вслух.
    ctx.repo.users.clearDue(u.id)
    ctx.log.error('idle после седьмого вечера: пинг некуда ставить', {
      user_id: u.id,
      current_evening: u.current_evening,
    })
    return 'stopped'
  }

  await flow.startEvening(ctx, u, eveningNo, now)
  ensureDue(ctx, u, now, null)
  return 'handled'
}

// ───────────────────────── skip_deadline (строка 14) ─────────────────────────

async function onSkipDeadline(ctx: Ctx, u: UserRow, now: number, flow: SchedulerFlow): Promise<DueOutcome> {
  if (!STATES_BEFORE.includes(u.state)) return heal(ctx, u, now, 'срок пропуска ждал вопроса «до»')
  const s = ctx.repo.sessions.active(u.id)
  if (!s) return heal(ctx, u, now, 'срок пропуска без активной сессии')
  if (s.kind !== 'evening') return heal(ctx, u, now, 'срок пропуска у сессии «Практика сейчас»')

  const demoDayBefore = u.demo_day_counter
  await flow.skipEvening(ctx, u, s, now)
  bumpDemoDay(ctx, u, demoDayBefore)
  ensureDue(ctx, u, now, null)
  return 'silent'
}

// ───────────────────────── after_timeout (строки 20, 21) ─────────────────────────

async function onAfterTimeout(
  ctx: Ctx,
  u: UserRow,
  now: number,
  flow: SchedulerFlow,
  seenDueAt: number,
): Promise<DueOutcome> {
  if (u.state !== 'practicing') return heal(ctx, u, now, 'таймер практики ждал состояния practicing')
  const s = ctx.repo.sessions.active(u.id)
  if (!s) return heal(ctx, u, now, 'таймер практики без активной сессии')

  const t = timingsFor(ctx, u)

  // Строка 21: процесс лежал всю ночь. Спрашивать в десять утра «как тебе сейчас?»
  // про вчерашнюю практику — значит показать, что бот не заметил ночи. Молча
  // переводим в ожидание и ждём утреннего догона, у которого свой текст.
  if (now - seenDueAt >= t.lateAfterSec) {
    const plan = planAfterAsked(t, u, s, now)
    ctx.repo.users.setState(u.id, 'awaiting_after', plan)
    ctx.log.info('таймер «после» просрочен, ночной вопрос не задаём', {
      user_id: u.id,
      late_sec: now - seenDueAt,
      next_kind: plan.kind,
    })
    return 'silent'
  }

  await flow.askAfter(ctx, u, s, now)
  ensureDue(ctx, u, now, null)
  return 'handled'
}

// ───────────────────────────── morning (строка 26) ─────────────────────────────

async function onMorning(ctx: Ctx, u: UserRow, now: number, flow: SchedulerFlow): Promise<DueOutcome> {
  if (u.state !== 'awaiting_after') return heal(ctx, u, now, 'утренний догон ждал ожидания цифры «после»')
  const s = ctx.repo.sessions.active(u.id)
  if (!s || s.kind !== 'evening') return heal(ctx, u, now, 'утренний догон без вечерней сессии')

  const t = timingsFor(ctx, u)
  // Догон ровно один на сессию: второе «а как ночь?» подряд превращает заботу в опрос.
  if (s.nudged === 1) {
    setPlan(ctx, u, { at: t.nextEvening(u, now), kind: 'ping_or_close' })
    return 'silent'
  }

  if (flow.morningNudge) await flow.morningNudge(ctx, u, s, now)
  else await flow.askAfter(ctx, u, s, now, { morning: true })

  if ((ctx.repo.sessions.byId(s.id)?.nudged ?? 1) === 0) ctx.repo.sessions.setNudged(s.id)
  ensureDue(ctx, u, now, { at: t.nextEvening(u, now), kind: 'ping_or_close' })
  return 'handled'
}

// ───────────────────────── ping_or_close (строка 27) ─────────────────────────

async function onPingOrClose(ctx: Ctx, u: UserRow, now: number, flow: SchedulerFlow): Promise<DueOutcome> {
  if (u.state !== 'awaiting_after') return heal(ctx, u, now, 'закрытие вечера ждало ожидания цифры «после»')
  const s = ctx.repo.sessions.active(u.id)
  if (!s) return heal(ctx, u, now, 'закрытие вечера без активной сессии')
  if (s.kind === 'now') return onNowTimeoutAfter(ctx, u, now)

  const t = timingsFor(ctx, u)

  // Вечер засчитан в момент отправки аудио, поэтому закрываем сессию без замера
  // «после»: на графике будет точка «до» и разрыв — честная картина вечера,
  // который человек прошёл, но не отметил.
  ctx.db.transaction(() => {
    ctx.repo.sessions.close(s.id, 'done', now)
    ctx.repo.events.add(
      u.id,
      'evening_done',
      now,
      {
        evening_no: s.evening_no,
        before: s.before_value,
        after: null,
        after_source: null,
        practice_id: s.practice_id,
      },
      s.id,
    )
  })()

  const closed = ctx.repo.sessions.byId(s.id) as SessionRow
  bumpDemoDay(ctx, u, u.demo_day_counter, true)
  const fresh = ctx.repo.users.byId(u.id) ?? u

  if (s.evening_no === 7) {
    await flow.finale(ctx, fresh, closed, now)
    ensureDue(ctx, fresh, now, planDay8(t, fresh, now))
    return 'handled'
  }

  // Следующий вечер начинается прямо сейчас: срок ping_or_close и стоял на момент
  // его открытия. Отдельного пинга не будет — иначе человек получил бы два.
  ctx.repo.users.setState(fresh.id, 'idle', NO_DUE)
  const forEvening = ctx.repo.users.byId(fresh.id) ?? fresh
  await flow.startEvening(ctx, forEvening, forEvening.current_evening + 1, now)
  ensureDue(ctx, forEvening, now, null)
  return 'handled'
}

// ───────────────────── сессии «Практика сейчас» (строки 15, 28) ─────────────────────

/** Строка 15: не ответил на вопрос «до» — сессию удаляем целиком, статистику не мусорим. */
function onNowTimeoutBefore(ctx: Ctx, u: UserRow, now: number): DueOutcome {
  const s = ctx.repo.sessions.active(u.id)
  if (s && s.kind === 'now') ctx.repo.sessions.deleteSession(s.id)
  restoreAfterNow(ctx, u, now)
  return 'silent'
}

/** Строка 28: практику дослушал, цифру не прислал — закрываем молча, вечер тут ни при чём. */
function onNowTimeoutAfter(ctx: Ctx, u: UserRow, now: number): DueOutcome {
  const s = ctx.repo.sessions.active(u.id)
  if (s && s.kind === 'now') ctx.repo.sessions.close(s.id, 'done', now)
  restoreAfterNow(ctx, u, now)
  return 'silent'
}

/**
 * Вернуть человека туда, где его застала «Практика сейчас». Срок восстанавливаем
 * пересчётом, а не запоминанием: пока шла сессия, мог наступить следующий вечер,
 * и старое значение due_at было бы уже в прошлом.
 */
function restoreAfterNow(ctx: Ctx, u: UserRow, now: number): void {
  const back: UserState = u.state_before_now ?? 'idle'
  ctx.repo.users.update(u.id, { state: back, state_before_now: null })
  const fresh = ctx.repo.users.byId(u.id) ?? { ...u, state: back }
  applyRecompute(ctx, fresh as UserRow, now)
}

// ───────────────────────────── day8 (строка 35) ─────────────────────────────

async function onDay8(ctx: Ctx, u: UserRow, now: number, flow: SchedulerFlow): Promise<DueOutcome> {
  if (u.state !== 'completed') return heal(ctx, u, now, 'день восьмой ждал завершённой программы')
  if (u.day8_sent === 1) {
    ctx.repo.users.clearDue(u.id)
    return 'stopped'
  }

  if (flow.day8) await flow.day8(ctx, u, now)
  else await sendDay8Fallback(ctx, u)

  const fresh = ctx.repo.users.byId(u.id) ?? u
  if (fresh.day8_sent === 0) {
    ctx.db.transaction(() => {
      ctx.repo.users.update(u.id, { day8_sent: 1 })
      ctx.repo.events.add(u.id, 'day8', now)
    })()
  }
  // Дальше бот молчит навсегда: это последнее запланированное сообщение программы.
  ctx.repo.users.clearDue(u.id)
  return 'handled'
}

/**
 * Запасной вариант дня восьмого, если ядро не дало своей реализации. Текст и
 * подписи кнопок — из таблицы texts, как везде; собрать две кнопки по ссылке из
 * настроек проще, чем оставить человека без последнего сообщения программы.
 */
async function sendDay8Fallback(ctx: Ctx, u: UserRow): Promise<void> {
  const channelUrl = ctx.settings.str('channel_url', '')
  const home = [ctx.texts.get('btn.practice_now')]
  if (ctx.settings.bool('allow_restart', true)) home.push(ctx.texts.get('btn.restart'))
  await ctx.send.text(u, 'final.day8', {}, {
    reply: [home],
    inline: channelUrl === '' ? undefined : [[{ text: ctx.texts.get('btn.channel'), url: channelUrl }]],
  })
}

// ───────────────────────────── общие мелочи ─────────────────────────────

/**
 * Страховка от «переход забыл поставить срок». Если после работы flow.* у человека
 * не осталось осмысленного due_at, ставим его сами: пересчётом или тем, что передали.
 *
 * `expected = null` означает «доверяем переходу, проверяем только факт». Это не
 * недоверие к соседнему модулю, а свойство системы: единственный due_at — общий
 * ресурс двух авторов, и молчаливая потеря значения здесь стоит человеку недели.
 */
function ensureDue(ctx: Ctx, u: UserRow, now: number, expected: Plan | null): void {
  const fresh = ctx.repo.users.byId(u.id)
  if (!fresh) return

  if (expected !== null) {
    // Переход мог поставить свой, более точный срок — тогда не трогаем.
    if (fresh.due_at === null && expected.at === null) return
    if (fresh.due_at !== null && fresh.due_at > now) {
      ctx.repo.users.setDue(fresh.id, { at: fresh.due_at, kind: fresh.due_kind })
      return
    }
    ctx.repo.users.setDue(fresh.id, expected)
    return
  }

  // Срок в прошлом или парковочный (мы его ставили при захвате) — значит переход
  // его не переставил. Пересчитываем по состоянию.
  if (fresh.due_at !== null && fresh.due_at > now) {
    ctx.repo.users.setDue(fresh.id, { at: fresh.due_at, kind: fresh.due_kind })
    return
  }
  if (fresh.due_at === null && isSilentState(fresh.state)) {
    ctx.repo.users.clearDue(fresh.id)
    return
  }
  applyRecompute(ctx, fresh, now)
}

/** Состояния, в которых пустой due_at — это норма, а не потеря. */
function isSilentState(state: UserState): boolean {
  return (
    state === 'paused' ||
    state === 'blocked' ||
    state === 'quiz_after' ||
    state === 'new' ||
    state === 'onb_hour' ||
    state === 'onb_clock' ||
    state === 'change_hour' ||
    state === 'change_clock'
  )
}

/**
 * Виртуальные сутки демо-режима. Счётчик двигает закрытие или пропуск вечера
 * (§3.4), иначе уникальный индекс «один засчитанный вечер на ритуальную дату»
 * запретил бы второй вечер за прогон.
 *
 * Двигаем, только если этого не сделал переход: двойной шаг проглотил бы один
 * вечер и семь вечеров превратились бы в четыре.
 */
function bumpDemoDay(ctx: Ctx, u: UserRow, counterBefore: number, force = false): void {
  if (u.demo !== 1) return
  const fresh = ctx.repo.users.byId(u.id)
  if (!fresh) return
  if (!force && fresh.demo_day_counter !== counterBefore) return
  if (force && fresh.demo_day_counter !== counterBefore) return
  ctx.repo.users.update(u.id, { demo_day_counter: fresh.demo_day_counter + 1 })
}

export { isSilentState }
