/**
 * Карточка человека. §3.3 design-admin.
 *
 * Порядок блоков не случайный: сначала «его неделя» (ради этого продукт и
 * существует), потом качество замеров, потом разговор, и только потом действия.
 * Кнопки внизу на телефоне и липкой панелью справа на ноутбуке — их нажимают
 * редко, а читают экран каждый день.
 */

import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, ApiError } from '../api.ts'
import { useData } from '../lib/useData.ts'
import {
  afterSourceText, fmtAgo, fmtDate, fmtDateFull, fmtNum, fmtTime, statusOf, WAITING_LABEL,
} from '../lib/format.ts'
import { PageHeader } from '../components/AppShell.tsx'
import {
  Button, Card, ErrorState, Field, inputClass, Skeleton, StatusChip, useConfirm, useToast,
} from '../components/ui.tsx'
import { PersonLines } from '../components/charts.tsx'
import { Timeline } from '../components/Timeline.tsx'

export function User() {
  const { id } = useParams()
  const userId = Number(id)
  const state = useData(() => api.user(userId), [userId])
  const toast = useToast()
  const [confirmNode, ask] = useConfirm()
  const [message, setMessage] = useState('')
  const [sendError, setSendError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  if (state.loading && !state.data) {
    return (
      <>
        <Skeleton h={40} w="240px" />
        <div className="mt-4 grid gap-4 md:grid-cols-[1.4fr_1fr]">
          <Skeleton h={300} />
          <Skeleton h={300} />
        </div>
      </>
    )
  }
  if (state.error || !state.data) {
    return <ErrorState title="Не получилось загрузить карточку" onRetry={state.reload} note={state.error ?? undefined} />
  }

  const card = state.data
  const u = card.user
  const now = card.serverNow
  const status = statusOf({ state: u.state, last_seen_at: u.last_seen_at }, now)
  const paused = u.state === 'paused'
  const tz = `UTC${u.tz_offset_min >= 0 ? '+' : '−'}${Math.abs(u.tz_offset_min) / 60}`

  async function act(run: () => Promise<unknown>, done: string) {
    try {
      await run()
      toast(done)
      state.reload()
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Не получилось')
    }
  }

  async function sendMessage() {
    if (message.trim() === '' || sending) return
    setSending(true)
    setSendError(null)
    try {
      await api.userMessage(userId, message.trim())
      setMessage('')
      toast('Отправлено')
      state.reload()
    } catch (err) {
      setSendError(err instanceof ApiError ? err.message : 'Не отправилось')
    } finally {
      setSending(false)
    }
  }

  return (
    <>
      {confirmNode}
      <PageHeader
        back={
          <Link to="/people" className="mb-2 inline-block text-[13px] text-ink2 hover:text-ink">
            ← Люди
          </Link>
        }
        title={`Участник #${u.id}`}
        subtitle={
          <span>
            Начал {fmtDateFull(u.created_at)} · вечер {u.current_evening} из 7 · пишу в {u.evening_time} · часовой
            пояс{' '}
            <span title="Часовой пояс бот определил сам по вопросу «сколько сейчас на часах». Человек может изменить его в боте кнопкой «Поменять время».">
              {tz} ⓘ
            </span>{' '}
            · {u.last_seen_at ? `последний раз был ${fmtAgo(u.last_seen_at, now)}` : 'ещё ни разу не отвечал'} ·{' '}
            сейчас {WAITING_LABEL[u.state]}
          </span>
        }
        action={
          <div className="flex items-center gap-2">
            {u.demo === 1 && (
              <span className="rounded-full border border-accent/50 px-3 py-1 text-[13px] text-accent">⚡ Демо</span>
            )}
            <StatusChip kind={status} />
          </div>
        }
      />

      <div className="grid gap-4 md:grid-cols-[1.5fr_1fr]">
        <div className="flex min-w-0 flex-col gap-4">
          <PersonLines points={card.chart} />

          {card.nowCount > 0 && (
            <p className="text-[13px] text-ink3">
              Практики «сейчас» — {card.nowCount} шт., в график недели не входят.
            </p>
          )}

          <Card title="Что бот видит по замерам" subtitle="Откуда пришла цифра «после» — это качество замера">
            {card.sessions.filter((s) => s.kind === 'evening').length === 0 ? (
              <p className="py-3 text-center text-[14px] text-ink3">Вечеров пока не было.</p>
            ) : (
              <table className="hidden w-full text-[13px] md:table">
                <thead>
                  <tr className="text-left text-ink3">
                    <th className="py-2 font-normal">Вечер</th>
                    <th className="py-2 font-normal">Дата</th>
                    <th className="py-2 font-normal">До</th>
                    <th className="py-2 font-normal">После</th>
                    <th className="py-2 font-normal">Откуда «после»</th>
                  </tr>
                </thead>
                <tbody>
                  {card.sessions
                    .filter((s) => s.kind === 'evening')
                    .sort((a, b) => (a.evening_no ?? 0) - (b.evening_no ?? 0))
                    .map((s) => (
                      <tr key={s.id} className="border-t border-line">
                        <td className="tnum py-2">{s.evening_no}</td>
                        <td className="py-2 text-ink2">{fmtDate(Date.parse(`${s.ritual_date}T12:00:00Z`) / 1000)}</td>
                        <td className="tnum py-2">{s.before_value ?? '—'}</td>
                        <td className="tnum py-2">{s.after_value ?? '—'}</td>
                        <td className="py-2 text-ink2">{afterSourceText(s.after_source, s.done_after_sec)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}

            {/* Телефон: та же таблица карточками — пять колонок на 390px не читаются. */}
            <div className="flex flex-col gap-2 md:hidden">
              {card.sessions
                .filter((s) => s.kind === 'evening')
                .sort((a, b) => (a.evening_no ?? 0) - (b.evening_no ?? 0))
                .map((s) => (
                  <div key={s.id} className="rounded-[12px] border border-line px-3 py-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[14px] text-ink">Вечер {s.evening_no}</span>
                      <span className="tnum text-[14px] text-ink">
                        {s.before_value ?? '—'} → {s.after_value ?? '—'}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[12px] text-ink3">
                      {fmtDate(Date.parse(`${s.ritual_date}T12:00:00Z`) / 1000)} ·{' '}
                      {afterSourceText(s.after_source, s.done_after_sec)}
                    </div>
                  </div>
                ))}
            </div>
          </Card>

          <Card title="Разговор" subtitle="Слева бот, справа человек">
            <Timeline items={card.timeline} now={now} />
          </Card>
        </div>

        <div className="flex flex-col gap-4 md:sticky md:top-6 md:self-start">
          <Card title="Написать через бота">
            <Field
              hint="Придёт человеку от имени бота, сейчас же."
              error={sendError}
              counter={`осталось ${1000 - message.length}`}
            >
              <textarea
                className={`${inputClass} min-h-[92px] resize-y`}
                value={message}
                maxLength={1000}
                placeholder="Как ты сегодня?"
                onChange={(e) => setMessage(e.target.value)}
              />
            </Field>
            <div className="mt-3">
              <Button kind="accent" full disabled={sending || message.trim() === ''} onClick={sendMessage}>
                {sending ? 'Отправляю…' : 'Отправить'}
              </Button>
            </div>
          </Card>

          <Card title="Действия">
            <div className="flex flex-col gap-2">
              <Button
                full
                onClick={() =>
                  ask({
                    title: paused ? 'Снять с паузы?' : 'Поставить на паузу?',
                    text: paused
                      ? 'Бот снова начнёт писать вечерами, с ближайшего вечера.'
                      : 'Бот перестанет писать вечерами. Практики не сгорают.',
                    confirmLabel: paused ? 'Снять с паузы' : 'Поставить на паузу',
                    onConfirm: () =>
                      act(() => api.userPause(userId, !paused), paused ? 'Сняла с паузы' : 'Поставила на паузу'),
                  })
                }
              >
                {paused ? 'Снять с паузы' : 'Поставить на паузу'}
              </Button>

              <Button
                full
                onClick={() =>
                  ask({
                    title: u.demo === 1 ? 'Выключить демо-режим?' : `Включить демо-режим для #${u.id}?`,
                    text:
                      u.demo === 1
                        ? 'Вечера снова будут идти по суткам.'
                        : 'В демо вечер идёт пару минут, а не сутки. Так удобно проверять программу на себе.',
                    confirmLabel: u.demo === 1 ? 'Выключить демо' : 'Включить демо',
                    onConfirm: () =>
                      act(() => api.userDemo(userId, u.demo !== 1), u.demo === 1 ? 'Демо выключено' : 'Демо включено'),
                  })
                }
              >
                {u.demo === 1 ? 'Выключить демо-режим' : 'Включить демо-режим'}
              </Button>

              <a
                href={`/api/admin/export/user/${userId}/history.csv`}
                className="flex min-h-[44px] items-center justify-center rounded-[12px] border border-line bg-raised text-[15px] text-ink"
              >
                Скачать его историю файлом
              </a>

              {u.demo === 1 && (
                <Button
                  kind="danger"
                  full
                  onClick={() =>
                    ask({
                      title: 'Удалить участника целиком?',
                      text: 'Пропадут все его замеры и переписка. Это нельзя отменить. Доступно только для демо-людей.',
                      confirmLabel: 'Удалить',
                      danger: true,
                      onConfirm: async () => {
                        await act(() => api.userDelete(userId, u.tg_id), 'Удалила')
                        window.location.href = '/admin/people'
                      },
                    })
                  }
                >
                  Удалить участника
                </Button>
              )}
            </div>
          </Card>

          <Card title="Тест «Индекс внутренней опоры»">
            {u.quiz_sum === null ? (
              <p className="text-[14px] text-ink3">Этот человек пришёл не с теста — замеров нет.</p>
            ) : (
              <>
                <p className="tnum text-[15px] text-ink">
                  Было {card.quiz.before.index ?? '—'} → стало {card.quiz.after.index ?? '—'}
                </p>
                <p className="mt-1 text-[13px] text-ink2">
                  {card.quiz.before.at ? `Первый замер ${fmtDate(card.quiz.before.at)}` : 'Первый замер пришёл с теста на сайте'}
                  {card.quiz.after.at ? `, второй ${fmtDate(card.quiz.after.at)}` : ', второго ещё не было'}
                </p>
                {card.quiz.after.answers.some((a) => a !== null) && (
                  <table className="mt-3 w-full text-[13px]">
                    <tbody>
                      {card.quiz.after.answers.map((a, i) => (
                        <tr key={i} className="border-t border-line">
                          <td className="py-1.5 text-ink2">Вопрос {i + 1}</td>
                          <td className="tnum py-1.5 text-right">
                            {card.quiz.before.answers[i] ?? '—'} → {a ?? '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {card.avgGain !== null && (
                  <p className="mt-3 text-[13px] text-ink2">
                    Средний прирост за вечер: <span className="tnum text-ink">{fmtNum(card.avgGain, 1, true)}</span>
                  </p>
                )}
              </>
            )}
          </Card>

          {card.notifications.length > 0 && (
            <Card title="Что бот присылал мне о нём">
              <ul className="flex flex-col gap-2 text-[13px]">
                {card.notifications.slice(0, 6).map((n) => (
                  <li key={n.id} className="border-t border-line pt-2 first:border-t-0 first:pt-0">
                    <span className="text-ink2">{n.text}</span>
                    <span className="ml-2 text-ink3">
                      {fmtDate(n.created_at)} {fmtTime(n.created_at)}
                      {n.sent_at === null && ' · не доставлено'}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </>
  )
}
