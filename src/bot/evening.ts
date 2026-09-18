/**
 * Вечерний ритуал: пинг → цифра «до» → категория → практика → цифра «после» → закрытие.
 * §2.2, §2.4, §2.7 design-bot; строки 8, 12–14, 16–27 таблицы переходов §3.2.
 *
 * Два правила, которые здесь нельзя нарушать, потому что на них держится вся
 * честность продукта:
 *
 * 1. **Вечер засчитан в момент успешной отправки аудио.** Не по «Готово», не по
 *    цифре «после». Человек, уснувший под практику, прошёл вечер — и именно это
 *    ему потом покажет полоска ●●●○○○○.
 * 2. **Пропуск сдвигает программу, а не теряет её.** Номер вечера не растёт при
 *    пропуске: был третий — завтра снова третий. Все семь практик человек услышит,
 *    просто календарных дней уйдёт больше.
 */

import type { Ctx } from '../ctx.ts'
import type { AfterSource, Category, SessionRow, UserRow } from '../db/types.ts'
import { bar, dots } from '../texts.ts'
import { localHm } from '../time.ts'
import { CATEGORY_LABEL_KEY } from '../db/settings.ts'
import { pickPractice } from '../content/pick.ts'
import { hasAudio, sendPractice } from '../content/audio.ts'
import { chartData, chartSummary } from '../chart/data.ts'
import { renderChartPng } from '../chart/render.ts'
import { notifyFinished, notifyNoPractices, notifyRaw } from './notify.ts'
import {
  commonVars,
  eveningPromptKey,
  fresh,
  homeKbFor,
  kbs,
  practiceDuration,
  prefixOf,
  recomputeDue,
  setDue,
  timings,
} from './flow.ts'

// ───────────────────────────── шаг 0: пинг ─────────────────────────────

/**
 * Открыть вечер {n}. Строка 8 §3.2.
 *
 * Порядок здесь не косметический: сессия открывается и prompt_sent_at пишется ДО
 * вызова Telegram (§4.4, рубеж 2), а состояние меняется ПОСЛЕ успешной отправки.
 * Если сообщение не ушло, человек остаётся в idle с припаркованным сроком, и
 * планировщик повторит попытку через две минуты — вместо немого awaiting_before,
 * из которого человек не может выйти, потому что вопроса он не видел.
 */
export async function startEvening(
  ctx: Ctx,
  user: UserRow,
  eveningNo: number,
  now: number,
  opts: { fromOnboarding?: boolean } = {},
): Promise<void> {
  const u = fresh(ctx, user)
  const t = timings(ctx, u)
  const ritual = t.ritualDate(u, now)

  // Инвариант «один засчитанный вечер на ритуальную дату»: до уникального индекса
  // в базе лучше не доводить — ответ человеку был бы уже не в наших руках.
  if (ctx.repo.sessions.countedOn(u.id, ritual)) {
    ctx.log.warn('вечер на эту дату уже засчитан', { user_id: u.id, ritual_date: ritual })
    setDue(ctx, u, 'idle', t.nextEvening(u, now), 'ping')
    return
  }

  clearStaleSession(ctx, u, now)

  const s = ctx.repo.sessions.open({
    userId: u.id,
    runNo: u.run_no,
    kind: 'evening',
    eveningNo,
    ritualDate: ritual,
    now,
  })
  ctx.repo.sessions.setPromptSent(s.id, now)

  const K = kbs(ctx)
  const kb = K.numbersKb(
    opts.fromOnboarding
      ? { betterAt: ctx.texts.label('better_at', { time: u.evening_time }) }
      : { notToday: true },
  )

  let msgId: number
  try {
    msgId = await ctx.send.text(
      u,
      eveningPromptKey(u, eveningNo),
      { ...commonVars(ctx, u, now), n: eveningNo, dots: dots(eveningNo - 1) },
      kb,
    )
  } catch (err) {
    // Сообщение не ушло — сессии как будто и не было: пустая строка в статистике
    // выглядела бы как брошенный вечер, которого человек не видел.
    ctx.repo.sessions.setPromptSent(s.id, null)
    ctx.repo.sessions.deleteSession(s.id)
    throw err
  }

  ctx.repo.sessions.setPromptSent(s.id, now, msgId)
  setDue(ctx, u, 'awaiting_before', t.skipDeadline(u, now), 'skip_deadline')
}

/** Остатки прошлой сессии: закрываем по факту — засчитанную как состоявшуюся, пустую удаляем. */
function clearStaleSession(ctx: Ctx, u: UserRow, now: number): void {
  const stale = ctx.repo.sessions.active(u.id)
  if (!stale) return
  if (stale.practice_sent_at) ctx.repo.sessions.close(stale.id, 'done', now)
  else if (stale.kind === 'now' || stale.before_value === null) ctx.repo.sessions.deleteSession(stale.id)
  else ctx.repo.sessions.close(stale.id, 'abandoned', now)
}

// ───────────────────────────── шаг 1: цифра «до» ─────────────────────────────

/** Строка 12 §3.2: цифра «до» и вопрос категории — одним сообщением. */
export async function acceptBefore(
  ctx: Ctx,
  user: UserRow,
  s: SessionRow,
  value: number,
  now: number,
): Promise<void> {
  const u = fresh(ctx, user)

  // Условный UPDATE: если цифра уже записана, второй ответ ничего не меняет и
  // превращается в повтор вопроса о категории, а не во вторую запись.
  if (!ctx.repo.sessions.setBefore(s.id, value, now)) {
    await repeatCategoryQuestion(ctx, u, s, now)
    return
  }

  if (s.kind === 'evening') {
    ctx.repo.events.add(u.id, 'evening_started', now, { evening_no: s.evening_no, before: value }, s.id)
  }
  // Срок не меняется: до 04:00 (или до таймаута сессии «сейчас») времени столько же.
  ctx.repo.users.update(u.id, { state: 'awaiting_state' })

  const u2 = fresh(ctx, u)
  const msgId = await ctx.send.text(
    u2,
    `${prefixOf(s)}.before_ack`,
    { ...commonVars(ctx, u2, now), before: value, bar: bar(value) },
    kbs(ctx).categoriesKb(s.id, localHm(u2, now).h),
  )
  ctx.repo.sessions.setChoiceMsg(s.id, msgId)
}

/**
 * Строка 50 §3.2: в awaiting_state пришло что угодно кроме категории.
 * Цифра уже записана, переспрашивать её нельзя — повторяем вопрос о категории
 * новым сообщением, со старого снимаем кнопки, чтобы «живой» осталась одна пара.
 */
export async function repeatCategoryQuestion(
  ctx: Ctx,
  user: UserRow,
  s: SessionRow,
  now: number,
): Promise<void> {
  const u = fresh(ctx, user)
  const row = ctx.repo.sessions.byId(s.id) ?? s
  if (row.choice_msg_id) await ctx.send.clearInline(u, row.choice_msg_id)

  const msgId = await ctx.send.text(
    u,
    `${prefixOf(row)}.before_ack`,
    { ...commonVars(ctx, u, now), before: row.before_value ?? 0, bar: bar(row.before_value ?? 0) },
    kbs(ctx).categoriesKb(row.id, localHm(u, now).h),
  )
  ctx.repo.sessions.setChoiceMsg(row.id, msgId)
}

// ───────────────────────────── шаг 2: практика ─────────────────────────────

/**
 * Строка 16 §3.2: выбрана категория — уходит практика.
 *
 * Здесь же четвёртый рубеж защиты от дублей (§4.4): sessions.setCategory —
 * условный UPDATE по `category IS NULL`. Два быстрых тапа по кнопкам категорий
 * дадут ровно одну практику, потому что второй UPDATE не найдёт строку.
 */
export async function deliverPractice(
  ctx: Ctx,
  user: UserRow,
  s: SessionRow,
  category: Category,
  now: number,
): Promise<void> {
  const u = fresh(ctx, user)
  const practice = pickPractice(ctx, u, s, category)

  if (!practice || !hasAudio(practice)) {
    await noPractices(ctx, u, s, now)
    return
  }

  if (!ctx.repo.sessions.setCategory(s.id, category, practice.id)) {
    ctx.log.info('категория уже выбрана, второй тап игнорируем', { user_id: u.id, session_id: s.id })
    return
  }

  const row = ctx.repo.sessions.byId(s.id) ?? s
  if (row.choice_msg_id) {
    await ctx.send.editText(
      u,
      row.choice_msg_id,
      ctx.texts.render('ev.state_ack', {
        category: ctx.texts.get(CATEGORY_LABEL_KEY[category]),
        title: practice.title,
      }),
    )
  }

  // Полторы секунды «записывает голосовое» — ритм, ради которого практика
  // ощущается как что-то приготовленное, а не как файл из папки.
  await ctx.send.action(u, 'upload_voice')
  await ctx.clock.sleep(1500)

  const msgId = await sendPractice(
    ctx,
    u,
    row,
    practice,
    `${prefixOf(row)}.practice_caption`,
    { ...commonVars(ctx, u, now), n: row.evening_no ?? 0 },
    kbs(ctx).doneKb(row.id),
  )

  const sent = ctx.repo.sessions.markPracticeSent(row.id, msgId, now)
  if (sent) {
    ctx.db.transaction(() => {
      ctx.repo.plays.add(u.id, practice.id, row.id, now)
      if (row.kind === 'evening' && row.evening_no !== null) {
        // Вот он, момент «человек сделал»: счётчик вечеров и обнуление пропусков.
        ctx.repo.users.update(u.id, {
          current_evening: row.evening_no,
          consecutive_skips: 0,
          not_today_streak: 0,
        })
      }
      ctx.repo.events.add(
        u.id,
        'practice_sent',
        now,
        {
          evening_no: row.evening_no,
          kind: row.kind,
          practice_id: practice.id,
          category,
        },
        row.id,
      )
    })()
  }

  const u2 = fresh(ctx, u)
  setDue(ctx, u2, 'practicing', now + timings(ctx, u2).afterTimeout(practice.duration_sec), 'after_timeout')
}

/** Строка 18 §3.2: отдавать нечего. Редчайший случай, но человек не должен зависнуть. */
async function noPractices(ctx: Ctx, user: UserRow, s: SessionRow, now: number): Promise<void> {
  const u = fresh(ctx, user)
  ctx.repo.events.add(u.id, 'no_practices', now, { session_kind: s.kind }, s.id)
  notifyNoPractices(ctx, u, now)
  ctx.log.error('библиотека практик пуста', { user_id: u.id })

  ctx.repo.sessions.deleteSession(s.id)
  const back = s.kind === 'now' ? (u.state_before_now ?? 'idle') : 'idle'
  ctx.repo.users.update(u.id, { state: back, state_before_now: null })
  const u2 = fresh(ctx, u)
  recomputeDue(ctx, u2, now)
  await ctx.send.text(u2, 'err.no_practices', commonVars(ctx, u2, now), homeKbFor(ctx, u2))
}

// ───────────────────────────── шаг 3: цифра «после» ─────────────────────────────

/**
 * Строки 19–21 §3.2: спрашиваем «а сейчас как».
 * opts.morning — утренний догон: тот же вопрос, но своим текстом (строка 26).
 */
export async function askAfter(
  ctx: Ctx,
  user: UserRow,
  s: SessionRow,
  now: number,
  opts: { morning?: boolean } = {},
): Promise<void> {
  const u = fresh(ctx, user)
  const t = timings(ctx, u)
  const row = ctx.repo.sessions.byId(s.id) ?? s

  const due =
    row.kind === 'now'
      ? { at: t.nowAfterTimeout(now), kind: 'now_timeout_after' as const }
      : (() => {
          const morning = t.morningAt(u, now)
          return morning !== null && row.nudged === 0 && !opts.morning
            ? { at: morning, kind: 'morning' as const }
            : { at: t.nextEvening(u, now), kind: 'ping_or_close' as const }
        })()

  setDue(ctx, u, 'awaiting_after', due.at, due.kind)

  // Кнопку «Готово» снимаем: она свою работу сделала, а висящая кнопка под
  // аудио на следующий день выглядит как незакрытое дело.
  if (row.practice_msg_id) await ctx.send.clearInline(u, row.practice_msg_id)

  const u2 = fresh(ctx, u)
  const key = opts.morning ? 'ev.morning' : `${prefixOf(row)}.after`
  await ctx.send.text(u2, key, commonVars(ctx, u2, now), kbs(ctx).numbersKb())
}

/** Строка 26 §3.2: утренний догон. Отдельная функция — её зовёт планировщик (§5.6 C). */
export async function morningNudge(ctx: Ctx, user: UserRow, s: SessionRow, now: number): Promise<void> {
  ctx.repo.sessions.setNudged(s.id)
  await askAfter(ctx, user, ctx.repo.sessions.byId(s.id) ?? s, now, { morning: true })
}

// ───────────────────────────── шаг 4: закрытие ─────────────────────────────

/** Строка {delta} закрытия. §2.2 design-bot. */
export function deltaText(
  ctx: Ctx,
  before: number | null,
  after: number,
  source: AfterSource,
): string {
  if (before === null) return ''
  const d = Math.abs(after - before)
  const vars = { before, after, d }
  if (source === 'morning') return ctx.texts.render('ev.delta_morning', vars)
  if (after > before) return ctx.texts.render('ev.delta_up', vars)
  if (after === before) return ctx.texts.render('ev.delta_same', vars)
  return ctx.texts.render('ev.delta_down', vars)
}

/**
 * Хвост «До завтра.» меняется на «До вечера.», когда цифра пришла утром (§2.2).
 * Замена именно по подстроке: ev.close правится в админке целиком, и держать
 * хвост отдельным ключом значило бы склеивать два поля в одном сообщении.
 * Не нашли — просто дописываем; текст всегда остаётся осмысленным.
 */
export function withMorningTail(text: string, tail: string): string {
  const stripped = text.replace(/До завтра\.\s*$/u, '').trimEnd()
  return stripped === text.trimEnd() ? `${text.trimEnd()} ${tail}` : `${stripped} ${tail}`
}

/** Строки 23–25 §3.2: пришла цифра «после». */
export async function acceptAfter(
  ctx: Ctx,
  user: UserRow,
  s: SessionRow,
  value: number,
  source: AfterSource,
  now: number,
): Promise<void> {
  const u = fresh(ctx, user)

  if (!ctx.repo.sessions.setAfter(s.id, value, source, now)) {
    ctx.log.info('цифра «после» уже записана', { user_id: u.id, session_id: s.id })
    return
  }

  const row = ctx.repo.sessions.byId(s.id) ?? s
  ctx.db.transaction(() => {
    ctx.repo.sessions.close(row.id, 'done', now)
    ctx.repo.events.add(
      u.id,
      row.kind === 'evening' ? 'evening_done' : 'now_done',
      now,
      {
        evening_no: row.evening_no,
        before: row.before_value,
        after: value,
        after_source: source,
        practice_id: row.practice_id,
      },
      row.id,
    )
    // Виртуальные сутки демо двигает закрытие вечера — иначе уникальный индекс
    // «один вечер на дату» не дал бы пройти семь вечеров за четверть часа.
    if (row.kind === 'evening' && u.demo) {
      ctx.repo.users.update(u.id, { demo_day_counter: u.demo_day_counter + 1 })
    }
  })()

  const delta = deltaText(ctx, row.before_value, value, source)
  const K = kbs(ctx)

  if (row.kind === 'now') {
    const back = u.state_before_now ?? 'idle'
    ctx.repo.users.update(u.id, { state: back, state_before_now: null })
    const u2 = fresh(ctx, u)
    recomputeDue(ctx, u2, now)
    const u3 = fresh(ctx, u2)
    await ctx.send.text(
      u3,
      'now.close',
      { ...commonVars(ctx, u3, now), after: value, bar: bar(value), delta },
      homeKbFor(ctx, u3),
    )
    return
  }

  if (row.evening_no === 7) {
    await finale(ctx, fresh(ctx, u), row, now)
    return
  }

  const u2 = fresh(ctx, u)
  setDue(ctx, u2, 'idle', timings(ctx, u2).nextEvening(u2, now), 'ping')

  const u3 = fresh(ctx, u2)
  let text = ctx.texts.render('ev.close', {
    ...commonVars(ctx, u3, now),
    after: value,
    bar: bar(value),
    delta,
    dots: dots(row.evening_no ?? u3.current_evening),
    n: row.evening_no ?? u3.current_evening,
  })
  if (source === 'morning') text = withMorningTail(text, ctx.texts.get('ev.close_morning_tail'))
  await ctx.send.raw(u3, text, K.homeKb())
}

// ───────────────────────────── седьмой вечер ─────────────────────────────

/**
 * Финал. §2.7 design-bot, §3.5 архитектуры.
 *
 * Состояние переводим в completed ПЕРЕД отправкой: дальше идут две паузы и
 * рендер картинки, и если процесс умрёт посреди них, человек всё равно останется
 * дошедшим — с уведомлением владельцу и с сообщением дня восьмого. Потерять
 * картинку не страшно; потерять факт «прошёл семь вечеров» — страшно.
 *
 * Картинка не имеет права уронить финал целиком (§3.5): не собралась — уходит
 * тот же текст подписью, а владельцу — служебное уведомление.
 */
export async function finale(ctx: Ctx, user: UserRow, s: SessionRow, now: number): Promise<void> {
  const u = fresh(ctx, user)
  const t = timings(ctx, u)
  const K = kbs(ctx)

  const points = chartData(ctx, u.id, u.run_no)
  const summary = chartSummary(points)

  ctx.db.transaction(() => {
    if (ctx.repo.sessions.byId(s.id)?.status === 'active') ctx.repo.sessions.close(s.id, 'done', now)
    ctx.repo.users.update(u.id, { completed_at: now, active_session_id: null })
    ctx.repo.users.setState(u.id, 'completed', { at: t.day8At(u, now), kind: 'day8' })
    ctx.repo.events.add(
      u.id,
      'finished',
      now,
      {
        first_before: summary.firstBefore,
        last_after: summary.lastAfter,
        avg_delta: ctx.repo.stats.avgGainForUser(u.id, u.run_no),
      },
      s.id,
    )
  })()
  notifyFinished(ctx, fresh(ctx, u), now)

  const u2 = fresh(ctx, u)
  const home = K.homeKb({ restart: ctx.settings.bool('allow_restart', true) })
  let homeSent = false

  // Шаг 1. «Записала: 8 ▰▰▰▰▰▰▰▰▱▱» — только если цифра «после» вообще была.
  if (s.after_value !== null) {
    await ctx.send.text(
      u2,
      'final.close',
      {
        ...commonVars(ctx, u2, now),
        after: s.after_value,
        bar: bar(s.after_value),
        delta: deltaText(ctx, s.before_value, s.after_value, s.after_source ?? 'button'),
      },
      home,
    )
    homeSent = true
  }

  // Шаг 2–3. Картинка недели.
  await ctx.send.action(u2, 'upload_photo')
  await ctx.clock.sleep(2000)

  const caption =
    summary.lastAfter === null
      ? ctx.texts.render('final.no_after', { first_before: summary.firstBefore ?? '—' })
      : ctx.texts.render('final.chart_caption', {
          first_before: summary.firstBefore ?? '—',
          last_after: summary.lastAfter,
        })

  let png: Buffer | null = null
  try {
    png = renderChartPng(points, {
      firstBefore: summary.firstBefore,
      lastAfter: summary.lastAfter,
      fromDate: summary.fromDate,
      toDate: summary.toDate,
      botName: ctx.cfg.botUsername,
    })
  } catch (err) {
    ctx.log.error('картинка недели не собралась, финал идёт без неё', { user_id: u.id, err })
    notifyRaw(ctx, {
      user: u2,
      dedupKey: `chart_failed:${u2.id}:${u2.run_no}`,
      text: `⚠️ Участник #${u2.id} прошёл седьмой вечер, но картинка не собралась. Финал отправлен текстом.`,
      now,
    })
  }

  if (png) await ctx.send.photo(u2, png, caption, homeSent ? undefined : home)
  else await ctx.send.raw(u2, caption, homeSent ? undefined : home)

  // Шаг 4. Приглашение на разговор — единственный призыв седьмого вечера.
  await ctx.clock.sleep(3000)
  const talkUrl = ctx.settings.str('talk_url', '')
  await ctx.send.text(
    u2,
    'final.invite',
    commonVars(ctx, u2, now),
    talkUrl ? K.urlKb('btn.talk', talkUrl) : undefined,
  )

  // Шаг 5. Повторный тест — отдельным сообщением и только по кнопке.
  const { offerQuizAfter } = await import('./quiz.ts')
  await offerQuizAfter(ctx, fresh(ctx, u2), now)
}

// ───────────────────────────── пропуск и отказ ─────────────────────────────

/**
 * Строка 14 §3.2: 04:00, практики не было.
 * Ничего не отправляем — следующим текстом будет вечерний пинг с преамбулой
 * «Вчера не получилось, это нормально». Упрёка в продукте нет ни одного.
 */
export async function skipEvening(
  ctx: Ctx,
  user: UserRow,
  s: SessionRow | null,
  now: number,
): Promise<void> {
  const u = fresh(ctx, user)
  const session = s ? (ctx.repo.sessions.byId(s.id) ?? s) : null

  ctx.db.transaction(() => {
    if (session && session.status === 'active') ctx.repo.sessions.close(session.id, 'abandoned', now)
    ctx.repo.users.update(u.id, {
      consecutive_skips: u.consecutive_skips + 1,
      active_session_id: null,
    })
    ctx.repo.events.add(
      u.id,
      'evening_skipped',
      now,
      { evening_no: session?.evening_no ?? u.current_evening + 1 },
      session?.id ?? null,
    )
    if (u.demo) ctx.repo.users.update(u.id, { demo_day_counter: u.demo_day_counter + 1 })
  })()

  // Снимаем кнопки с обоих сообщений вечера: живых кнопок вчерашнего дня не остаётся.
  if (session?.choice_msg_id) await ctx.send.clearInline(u, session.choice_msg_id)
  if (session?.prompt_msg_id) await ctx.send.clearInline(u, session.prompt_msg_id)

  const u2 = fresh(ctx, u)
  setDue(ctx, u2, 'idle', timings(ctx, u2).nextEvening(u2, now), 'ping')
}

/**
 * Строка 13 §3.2: «Не сегодня».
 * consecutive_skips НЕ растёт: сознательный отказ — это не молчание, и автопауза
 * за честный ответ была бы наказанием.
 */
export async function declineEvening(
  ctx: Ctx,
  user: UserRow,
  s: SessionRow,
  now: number,
): Promise<void> {
  const u = fresh(ctx, user)
  const streak = u.not_today_streak + 1

  ctx.db.transaction(() => {
    ctx.repo.sessions.close(s.id, 'declined', now)
    ctx.repo.users.update(u.id, { not_today_streak: streak, active_session_id: null })
    ctx.repo.events.add(u.id, 'not_today', now, { evening_no: s.evening_no, streak }, s.id)
  })()

  const u2 = fresh(ctx, u)
  setDue(ctx, u2, 'idle', timings(ctx, u2).nextEvening(u2, now), 'ping')

  const u3 = fresh(ctx, u2)
  const K = kbs(ctx)
  if (streak >= 2) {
    await ctx.send.text(u3, 'ev.pause_offer', commonVars(ctx, u3, now), K.pauseOfferKb())
    return
  }
  await ctx.send.text(u3, 'ev.not_today', commonVars(ctx, u3, now), K.homeKb())
}
