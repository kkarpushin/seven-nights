/**
 * Лента разговора. §3.3 design-admin, блок 3.
 *
 * Это главный экран специалиста, и он намеренно похож на переписку, а не на
 * журнал базы: слева бот, справа человек, между ними карточки замеров. Так видно
 * то, ради чего продукт и делается, — что человеку отвечали и что он писал в ответ.
 */

import { useMemo, useState } from 'react'
import { afterSourceText, bar, fmtDate, fmtDuration, fmtTime } from '../lib/format.ts'
import type { AfterSource, Category, TimelineItem } from '../types.ts'
import { CATEGORY_SHORT } from '../lib/format.ts'
import { AudioPlayer } from './AudioUploader.tsx'

function dayKey(at: number): string {
  return new Date(at * 1000).toISOString().slice(0, 10)
}

function dayTitle(at: number, now: number): string {
  const today = dayKey(now)
  const yesterday = dayKey(now - 86_400)
  const key = dayKey(at)
  if (key === today) return 'Сегодня'
  if (key === yesterday) return 'Вчера'
  return fmtDate(at)
}

export function Timeline({ items, now }: { items: TimelineItem[]; now: number }) {
  const [onlyMine, setOnlyMine] = useState(false)

  // С сервера лента приходит по убыванию времени (§6.2), а читается снизу вверх
  // по времени — как переписка.
  const ordered = useMemo(() => {
    const list = [...items].reverse()
    return onlyMine ? list.filter((i) => i.kind === 'admin_message' || i.kind === 'message') : list
  }, [items, onlyMine])

  if (items.length === 0) {
    return <p className="py-6 text-center text-[14px] text-ink3">Разговора пока не было.</p>
  }

  let lastDay = ''
  return (
    <div>
      <div className="mb-3 flex justify-end">
        <button
          type="button"
          className="text-[13px] text-ink2 underline underline-offset-2 hover:text-ink"
          onClick={() => setOnlyMine((v) => !v)}
        >
          {onlyMine ? 'Показать всё' : 'Только сообщения словами'}
        </button>
      </div>

      <div className="flex flex-col gap-2">
        {ordered.map((item, idx) => {
          const key = dayKey(item.at)
          const showDay = key !== lastDay
          lastDay = key
          return (
            <div key={`${item.at}-${item.kind}-${idx}`}>
              {showDay && (
                <div className="my-3 text-center text-[12px] text-ink3">{dayTitle(item.at, now)}</div>
              )}
              <TimelineRow item={item} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Time({ at }: { at: number }) {
  return <span className="tnum ml-2 shrink-0 text-[11px] text-ink3">{fmtTime(at)}</span>
}

function TimelineRow({ item }: { item: TimelineItem }) {
  const d = item.detail as {
    value?: number
    where?: string
    source?: AfterSource | null
    done_after_sec?: number | null
    category?: Category | null
    slug?: string | null
    duration_sec?: number | null
    line1?: string
    line2?: string
    state?: string
  }

  if (item.kind === 'event') {
    return <p className="py-1 text-center text-[12px] text-ink3">{item.title}</p>
  }

  if (item.kind === 'measure_before' || item.kind === 'measure_after') {
    const value = d.value ?? 0
    return (
      <div className="mx-auto w-full max-w-[320px] rounded-[12px] border border-line bg-surface px-3 py-2 text-center">
        <div className="text-[13px] text-ink2">
          {item.kind === 'measure_before' ? 'Замер до' : 'Замер после'} · {d.where}
        </div>
        <div className="tnum mt-0.5 text-[15px] text-ink">
          {value} <span className="text-ink3">{bar(value)}</span>
        </div>
        {item.kind === 'measure_after' && (
          <div className="mt-0.5 text-[11px] text-ink3">
            {afterSourceText(d.source ?? null, d.done_after_sec ?? null)}
            <Time at={item.at} />
          </div>
        )}
      </div>
    )
  }

  if (item.kind === 'practice') {
    return (
      <div className="flex">
        <div className="max-w-[85%] rounded-[16px] rounded-bl-[6px] border border-line bg-surface px-3.5 py-3">
          <div className="flex items-baseline gap-2">
            <span aria-hidden>♪</span>
            <span className="text-[15px] text-ink">{item.title}</span>
            <span className="tnum text-[12px] text-ink3">{fmtDuration(d.duration_sec ?? null)}</span>
            <Time at={item.at} />
          </div>
          <div className="mt-0.5 text-[12px] text-ink3">
            {d.where}
            {d.category ? ` · ${CATEGORY_SHORT[d.category]}` : ''}
          </div>
          {d.slug && (
            <div className="mt-2">
              <AudioPlayer src={`/media/practices/${d.slug}.mp3`} compact />
            </div>
          )}
        </div>
      </div>
    )
  }

  if (item.kind === 'admin_message') {
    return (
      <div className="flex">
        <div className="max-w-[85%] rounded-[16px] rounded-bl-[6px] border border-accent/40 bg-surface px-3.5 py-2.5">
          <p className="whitespace-pre-wrap text-[15px] text-ink">{item.title}</p>
          <div className="mt-1 text-[11px] text-ink3">
            отправила ты
            <Time at={item.at} />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-[16px] rounded-br-[6px] bg-raised px-3.5 py-2.5">
        <p className="whitespace-pre-wrap text-[15px] text-ink">{item.title}</p>
        <div className="mt-1 text-right text-[11px] text-ink3">
          <Time at={item.at} />
        </div>
      </div>
    </div>
  )
}
