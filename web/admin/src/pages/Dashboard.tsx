/**
 * Обзор. §3.2 design-admin.
 *
 * Экран отвечает на один вопрос — как идёт неделя в целом, — и поэтому у каждой
 * цифры есть подпись обычным языком и строка, объясняющая, из чего она посчитана.
 * «43% из начавших» без «из скольких» — это цифра, которой нельзя доверять.
 */

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api.ts'
import { useData } from '../lib/useData.ts'
import { fmtAgo, fmtDate, fmtNum, fmtPeople, fmtPeopleDative, WAITING_LABEL } from '../lib/format.ts'
import { PageHeader } from '../components/AppShell.tsx'
import { Card, EmptyState, ErrorState, Segmented, Skeleton, StatTile } from '../components/ui.tsx'
import { ActivityBars, BeforeAfterBars, CategoryBars, FunnelBars } from '../components/charts.tsx'

type Period = '7' | '30' | 'all'

export function Dashboard({ showDemo }: { showDemo: boolean }) {
  const [period, setPeriod] = useState<Period>('30')
  const state = useData(() => api.dashboard(period, showDemo), [period, showDemo])

  const header = (
    <PageHeader
      title="Обзор"
      subtitle={
        state.data
          ? state.data.period.days === null
            ? 'за всё время'
            : `с ${fmtDate(state.data.period.from)} по ${fmtDate(state.data.period.to)}`
          : ' '
      }
      action={
        <Segmented
          value={period}
          onChange={setPeriod}
          options={[
            { value: '7', label: '7 дней' },
            { value: '30', label: '30 дней' },
            { value: 'all', label: 'Всё время' },
          ]}
        />
      }
    />
  )

  if (state.loading && !state.data) {
    return (
      <>
        {header}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} h={132} />
          ))}
        </div>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <Skeleton h={300} />
          <Skeleton h={300} />
        </div>
      </>
    )
  }

  if (state.error || !state.data) {
    return (
      <>
        {header}
        <ErrorState title="Не получилось загрузить цифры" onRetry={state.reload} note={state.error ?? undefined} />
      </>
    )
  }

  const d = state.data
  const s = d.stats
  const stuck = s.stuckAt[0] ?? null
  const periodWord = d.period.days === null ? 'всё время' : `${d.period.days} дней`

  if (d.totals.users === 0) {
    return (
      <>
        {header}
        <EmptyState
          title="Пока никто не начал"
          text="Как только первый человек нажмёт «Старт» в боте, здесь появятся цифры. А пока можно загрузить практики и проверить тексты."
        >
          <Link to="/practices" className="rounded-[12px] bg-accent px-4 py-2.5 text-[15px] text-on-accent">
            Практики
          </Link>
          <Link to="/texts" className="rounded-[12px] border border-line px-4 py-2.5 text-[15px] text-ink">
            Тексты бота
          </Link>
        </EmptyState>
      </>
    )
  }

  return (
    <>
      {header}

      {d.totals.users > 0 && d.totals.users < 3 && (
        <p className="mb-4 rounded-[12px] border border-line bg-surface px-4 py-3 text-[13px] text-ink2">
          Пока мало людей: средние значения будут прыгать.
        </p>
      )}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatTile
          value={s.funnel.started}
          label="начали программу"
          note={d.previous ? `за предыдущие ${periodWord} — ${d.previous.started}` : 'за всё время'}
        />
        <StatTile
          value={s.funnel.finished}
          label="дошли до седьмого вечера"
          note={
            s.funnel.started === 0
              ? 'никто ещё не начинал'
              : `это ${Math.round(s.funnel.conversion * 100)}% из начавших`
          }
        />
        <StatTile
          value={s.avgGain === null ? '—' : fmtNum(s.avgGain, 1, true)}
          label="средний прирост: первый вечер → последний"
          note={
            d.gainPeople === 0
              ? 'пока не по кому считать'
              : `считаю по ${fmtPeopleDative(d.gainPeople)}, у кого есть обе цифры`
          }
          tone="accent"
        />
        <StatTile
          value={stuck ? `Вечер ${stuck.evening}` : '—'}
          label="чаще всего останавливаются здесь"
          note={stuck ? `${stuck.people} из ${d.notFinished} недошедших` : 'все идут дальше'}
        />
      </div>

      {s.quiz.both >= 3 && (
        <p className="mt-4 rounded-[12px] border border-line bg-surface px-4 py-3 text-[14px] text-ink2">
          Индекс опоры: на входе <span className="tnum text-ink">{fmtNum(s.quiz.in_avg, 0)}</span> · после семи
          вечеров <span className="tnum text-ink">{fmtNum(s.quiz.out_avg, 0)}</span> · прирост{' '}
          <span className="tnum text-ink">{fmtNum(s.quiz.gain, 0, true)}</span> (по {fmtPeopleDative(s.quiz.both)},
          кто прошёл оба замера)
        </p>
      )}

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <FunnelBars reach={s.reach} total={s.funnel.started} />
        <BeforeAfterBars rows={s.byEvening} />
        <ActivityBars rows={d.byDay} />
        <CategoryBars rows={d.categories} />
      </div>

      <div className="mt-4">
        <Card
          title="Сейчас в программе"
          subtitle={`Сегодня заходили: ${s.today.active} · практик сегодня: ${s.today.practices} · новых: ${s.today.new}`}
          action={
            <Link to="/people" className="text-[13px] text-ink2 underline underline-offset-2 hover:text-ink">
              Все люди →
            </Link>
          }
        >
          {d.nowInProgram.length === 0 ? (
            <p className="py-4 text-center text-[14px] text-ink3">Сейчас никого нет в программе.</p>
          ) : (
            <ul className="flex flex-col">
              {d.nowInProgram.map((u) => (
                <li key={u.id} className="border-t border-line first:border-t-0">
                  <Link
                    to={`/people/${u.id}`}
                    className="flex items-center justify-between gap-3 py-2.5 text-[14px] hover:text-ink"
                  >
                    <span className="text-ink">
                      <span className="tnum">#{u.id}</span>
                      <span className="text-ink2"> · вечер {u.current_evening} · {WAITING_LABEL[u.state]}</span>
                    </span>
                    <span className="shrink-0 text-[13px] text-ink3">{fmtAgo(u.last_seen_at, d.serverNow)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <p className="mt-4 text-center text-[12px] text-ink3">
        {state.loadedAt ? `Обновлено ${fmtAgo(Math.round(state.loadedAt / 1000), Math.round(Date.now() / 1000))}` : ''}
      </p>
    </>
  )
}
