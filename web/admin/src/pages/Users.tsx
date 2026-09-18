/**
 * Люди — список. §3.3 design-admin.
 *
 * На ноутбуке таблица, на телефоне карточки — из одного источника колонок, чтобы
 * они не разъезжались по смыслу. Имён у нас нет: человек это номер, и поиск
 * работает по номеру участника или по его номеру в Telegram.
 */

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api.ts'
import { useData } from '../lib/useData.ts'
import { dots, fmtAgo, fmtDate, fmtNum, fmtPeople, statusOf, STATUS_LABEL } from '../lib/format.ts'
import { PageHeader } from '../components/AppShell.tsx'
import { Button, Chip, EmptyState, ErrorState, inputClass, SkeletonRows, StatusChip } from '../components/ui.tsx'
import type { UserRow } from '../types.ts'

const SEGMENTS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Все' },
  { value: 'active', label: 'Идёт' },
  { value: 'paused', label: 'Пауза' },
  { value: 'finished', label: 'Финиш' },
  { value: 'stuck', label: 'Молчит' },
  { value: 'blocked', label: 'Блок' },
]

export function Users({ showDemo }: { showDemo: boolean }) {
  const [segment, setSegment] = useState('')
  const [query, setQuery] = useState('')
  const [per, setPer] = useState(50)
  const state = useData(
    () => api.users({ segment: segment || undefined, q: query || undefined, per, demo: showDemo }),
    [segment, query, per, showDemo],
  )
  const now = Math.round(Date.now() / 1000)

  return (
    <>
      <PageHeader
        title="Люди"
        subtitle={state.data ? fmtPeople(state.data.total) : ' '}
        action={
          <input
            className={`${inputClass} md:w-[220px]`}
            placeholder="Найти по номеру"
            inputMode="numeric"
            value={query}
            onChange={(e) => setQuery(e.target.value.replace(/[^\d#]/g, ''))}
          />
        }
      />

      <div className="mb-4 flex gap-2 overflow-x-auto pb-1">
        {SEGMENTS.map((s) => (
          <Chip key={s.value} active={segment === s.value} onClick={() => setSegment(s.value)}>
            {s.label}
          </Chip>
        ))}
      </div>

      {state.loading && !state.data ? (
        <SkeletonRows rows={8} h={56} />
      ) : state.error || !state.data ? (
        <ErrorState title="Не получилось загрузить список" onRetry={state.reload} />
      ) : state.data.rows.length === 0 ? (
        segment !== '' || query !== '' ? (
          <EmptyState title="Никто не подходит под фильтр">
            <Button
              onClick={() => {
                setSegment('')
                setQuery('')
              }}
            >
              Показать всех
            </Button>
          </EmptyState>
        ) : (
          <EmptyState title="Здесь появятся люди, как только кто-то начнёт программу." />
        )
      ) : (
        <>
          {/* Ноутбук */}
          <div className="hidden overflow-hidden rounded-[16px] border border-line bg-surface md:block">
            <table className="w-full text-[14px]">
              <thead>
                <tr className="text-left text-[13px] text-ink3">
                  <th className="px-4 py-3 font-normal">Номер</th>
                  <th className="px-4 py-3 font-normal">Начал</th>
                  <th className="px-4 py-3 font-normal">Вечер</th>
                  <th className="px-4 py-3 font-normal">Статус</th>
                  <th className="px-4 py-3 font-normal">Последний контакт</th>
                  <th className="px-4 py-3 font-normal">Прирост</th>
                  <th className="px-4 py-3 font-normal">Индекс</th>
                </tr>
              </thead>
              <tbody>
                {state.data.rows.map((u) => (
                  <Row key={u.id} u={u} now={now} />
                ))}
              </tbody>
            </table>
          </div>

          {/* Телефон */}
          <div className="flex flex-col gap-3 md:hidden">
            {state.data.rows.map((u) => (
              <MobileCard key={u.id} u={u} now={now} />
            ))}
          </div>

          {state.data.total > state.data.rows.length && (
            <div className="mt-4 flex justify-center">
              <Button onClick={() => setPer(per + 50)}>Показать ещё</Button>
            </div>
          )}
        </>
      )}
    </>
  )
}

function Delta({ value }: { value: number | null }) {
  if (value === null) return <span className="text-ink3">—</span>
  const color = value > 0 ? 'var(--color-st-run)' : value < 0 ? 'var(--color-st-blocked)' : 'var(--color-ink2)'
  return (
    <span className="tnum" style={{ color }}>
      {fmtNum(value, 0, true)}
    </span>
  )
}

function Row({ u, now }: { u: UserRow; now: number }) {
  const kind = statusOf(u, now)
  return (
    <tr className="border-t border-line transition hover:bg-raised">
      <td className="px-4 py-3">
        <Link to={`/people/${u.id}`} className="tnum font-semibold text-ink">
          #{u.id}
          {u.demo === 1 && <span className="ml-2 text-[12px] text-accent">⚡ демо</span>}
        </Link>
      </td>
      <td className="px-4 py-3 text-ink2">{fmtDate(u.created_at)}</td>
      <td className="px-4 py-3">
        <Link to={`/people/${u.id}`} className="tnum text-ink">
          {u.current_evening} / 7 <span className="ml-1 text-ink3">{dots(u.current_evening)}</span>
        </Link>
      </td>
      <td className="px-4 py-3">
        <StatusChip kind={kind} />
      </td>
      <td className={`px-4 py-3 ${kind === 'silent' ? 'text-[color:var(--color-st-silent)]' : 'text-ink2'}`}>
        {fmtAgo(u.last_seen_at, now)}
      </td>
      <td className="px-4 py-3" title={u.delta === null ? '' : `с ${u.first_before} до ${u.last_after}`}>
        <Delta value={u.delta} />
      </td>
      <td className="tnum px-4 py-3 text-ink2">
        {u.quiz_index === null ? '—' : `${u.quiz_index} → ${u.quiz_index_after ?? '—'}`}
      </td>
    </tr>
  )
}

function MobileCard({ u, now }: { u: UserRow; now: number }) {
  return (
    <Link to={`/people/${u.id}`} className="rounded-[16px] border border-line bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="tnum text-[16px] font-semibold text-ink">#{u.id}</span>
            {u.demo === 1 && <span className="text-[12px] text-accent">⚡ демо</span>}
          </div>
          <div className="tnum mt-1 text-[14px] text-ink2">
            Вечер {u.current_evening} из 7 · <span className="text-ink3">{dots(u.current_evening)}</span>
          </div>
          <div className="mt-1 text-[13px] text-ink3">
            Начал {fmtDate(u.created_at)} · был {fmtAgo(u.last_seen_at, now)}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <span className="text-[18px] font-semibold">
            <Delta value={u.delta} />
          </span>
          <span className="text-[12px] text-ink3">{STATUS_LABEL[statusOf(u, now)]}</span>
        </div>
      </div>
    </Link>
  )
}
