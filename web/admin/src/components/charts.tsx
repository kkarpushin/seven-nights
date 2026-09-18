/**
 * Графики. §2.6 и §4 design-admin — правила оттуда, без самодеятельности.
 *
 * Три из них стоит назвать вслух, потому что их легко нарушить незаметно:
 * — одна ось Y на график, разные величины никогда не делят шкалу;
 * — пропуск это разрыв линии (connectNulls={false}), а не ноль: человек мог уснуть,
 *   и «ноль по шкале» сказал бы о нём неправду;
 * — под каждым графиком есть «Показать числами»: это и доступность, и способ
 *   перенести цифру в заметки, не переписывая её с экрана глазами.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import {
  Bar, BarChart, CartesianGrid, Cell, LabelList, Line, LineChart, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { CATEGORY_COLOR, CATEGORY_LABEL, fmtNum, fmtWeekday, fmtPeople } from '../lib/format.ts'
import type { Category, ChartPoint } from '../types.ts'

const S1 = 'var(--color-s1)'
const S2 = 'var(--color-s2)'
const INK3 = 'var(--color-ink3)'
const GRID = 'var(--color-grid)'
const AXIS = 'var(--color-axis)'

const axisProps = {
  stroke: AXIS,
  tick: { fill: INK3, fontSize: 12 },
  tickLine: false,
} as const

export type TipRow = { label: string; value: string; color?: string }

export function TooltipBox({ title, rows }: { title: string; rows: TipRow[] }) {
  return (
    <div className="rounded-[12px] border border-line bg-raised px-3 py-2 text-[13px] text-ink shadow-lg">
      <div className="mb-1 text-ink2">{title}</div>
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-2">
          {r.color && <span className="h-2 w-2 rounded-full" style={{ background: r.color }} />}
          <span className="text-ink2">{r.label}</span>
          <span className="tnum ml-auto pl-3 font-medium">{r.value}</span>
        </div>
      ))}
    </div>
  )
}

/** Своя легенда, а не рехартовская: 13px, точка 8px, слово обязательно. */
export function Legend({ items }: { items: Array<{ color: string; label: string }> }) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-3">
      {items.map((i) => (
        <span key={i.label} className="flex items-center gap-1.5 text-[13px] text-ink2">
          <span className="h-2 w-2 rounded-full" style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  )
}

export function ChartCard({
  title, subtitle, legend, children, table, footnote, empty,
}: {
  title: string
  subtitle?: string
  legend?: Array<{ color: string; label: string }>
  children: ReactNode
  table?: Array<[string, string]>
  footnote?: string
  empty?: string
}) {
  const [showNumbers, setShowNumbers] = useState(false)
  return (
    <section className="rounded-[16px] border border-line bg-surface p-4 md:p-5">
      <h2 className="text-[16px] font-semibold text-ink">{title}</h2>
      {subtitle && <p className="mt-0.5 mb-3 text-[13px] text-ink2">{subtitle}</p>}
      {legend && <Legend items={legend} />}
      {empty ? (
        <p className="py-8 text-center text-[14px] text-ink3">{empty}</p>
      ) : (
        <>
          <div className="h-[220px] md:h-[280px]">{children}</div>
          {footnote && <p className="mt-2 text-[12px] text-ink3">{footnote}</p>}
          {table && (
            <>
              <button
                type="button"
                className="mt-2 text-[13px] text-ink2 underline underline-offset-2 hover:text-ink"
                onClick={() => setShowNumbers((v) => !v)}
              >
                {showNumbers ? 'Скрыть числа' : 'Показать числами'}
              </button>
              {showNumbers && (
                <table className="mt-2 w-full text-[13px]">
                  <tbody>
                    {table.map(([k, v]) => (
                      <tr key={k} className="border-t border-line">
                        <td className="py-1.5 text-ink2">{k}</td>
                        <td className="tnum py-1.5 text-right text-ink">{v}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </>
      )}
    </section>
  )
}

// ─────────────────────── воронка: сколько дошли до вечера ───────────────────────

export function FunnelBars({ reach, total }: { reach: Array<{ evening: number; people: number }>; total: number }) {
  const data = Array.from({ length: 7 }, (_, i) => {
    const row = reach.find((r) => r.evening === i + 1)
    return { evening: `Вечер ${i + 1}`, people: row?.people ?? 0 }
  })
  const base = total > 0 ? total : Math.max(...data.map((d) => d.people), 1)

  return (
    <ChartCard
      title="Сколько людей дошли до вечера"
      subtitle="Каждый вечер — сколько человек его прошли хотя бы раз"
      footnote="Вечер считается пройденным, когда человек получил аудио."
      table={data.map((d) => [d.evening, `${d.people} · ${Math.round((d.people / base) * 100)}%`])}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 64, left: 0, bottom: 0 }}>
          <CartesianGrid horizontal={false} stroke={GRID} />
          <XAxis type="number" hide domain={[0, base]} />
          <YAxis type="category" dataKey="evening" width={78} {...axisProps} axisLine={false} />
          <Tooltip
            cursor={{ fill: 'rgba(255,255,255,0.04)' }}
            content={(p: unknown) => {
              const t = p as { active?: boolean; payload?: Array<{ payload: { evening: string; people: number } }> }
              if (!t.active || !t.payload?.length) return null
              const d = t.payload[0]!.payload
              return <TooltipBox title={d.evening} rows={[{ label: 'дошли', value: fmtPeople(d.people), color: S1 }]} />
            }}
          />
          <Bar dataKey="people" fill={S1} radius={[0, 4, 4, 0]} barSize={22} isAnimationActive={false}>
            <LabelList
              dataKey="people"
              position="right"
              content={(props: unknown) => {
                const p = props as { x?: number; y?: number; width?: number; height?: number; value?: number }
                const value = Number(p.value ?? 0)
                return (
                  <text
                    x={(p.x ?? 0) + (p.width ?? 0) + 8}
                    y={(p.y ?? 0) + (p.height ?? 0) / 2 + 4}
                    fill="var(--color-ink2)"
                    fontSize={12}
                  >
                    {`${value} · ${Math.round((value / base) * 100)}%`}
                  </text>
                )
              }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

// ─────────────────────── до и после по вечерам ───────────────────────

export function BeforeAfterBars({
  rows,
}: {
  rows: Array<{ evening: number; n: number; avg_before: number | null; avg_after: number | null }>
}) {
  const data = Array.from({ length: 7 }, (_, i) => {
    const row = rows.find((r) => r.evening === i + 1)
    return {
      evening: i + 1,
      before: row?.avg_before ?? null,
      after: row?.avg_after ?? null,
      n: row?.n ?? 0,
    }
  })
  const hasData = data.some((d) => d.before !== null || d.after !== null)

  return (
    <ChartCard
      title="Среднее состояние до и после практики"
      subtitle="По шкале 0–10, среднее по всем участникам"
      legend={[{ color: S1, label: 'до' }, { color: S2, label: 'после' }]}
      empty={hasData ? undefined : 'Пока нет ни одного закрытого вечера.'}
      table={data
        .filter((d) => d.n > 0)
        .map((d) => [`Вечер ${d.evening}`, `до ${fmtNum(d.before)} · после ${fmtNum(d.after)} · ${fmtPeople(d.n)}`])}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }} barGap={2}>
          <CartesianGrid vertical={false} stroke={GRID} />
          <XAxis dataKey="evening" {...axisProps} />
          <YAxis domain={[0, 10]} ticks={[0, 2, 4, 6, 8, 10]} {...axisProps} axisLine={false} />
          <Tooltip
            cursor={{ fill: 'rgba(255,255,255,0.04)' }}
            content={(p: unknown) => {
              const t = p as {
                active?: boolean
                payload?: Array<{ payload: { evening: number; before: number | null; after: number | null; n: number } }>
              }
              if (!t.active || !t.payload?.length) return null
              const d = t.payload[0]!.payload
              return (
                <TooltipBox
                  title={`Вечер ${d.evening} · ${fmtPeople(d.n)}`}
                  rows={[
                    { label: 'до', value: fmtNum(d.before), color: S1 },
                    { label: 'после', value: fmtNum(d.after), color: S2 },
                  ]}
                />
              )
            }}
          />
          <Bar dataKey="before" fill={S1} radius={[4, 4, 0, 0]} isAnimationActive={false} />
          <Bar dataKey="after" fill={S2} radius={[4, 4, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

// ─────────────────────── активность по дням ───────────────────────

export function ActivityBars({ rows }: { rows: Array<{ date: string; evening: number; now: number; total: number }> }) {
  const avg = rows.length === 0 ? 0 : rows.reduce((s, r) => s + r.total, 0) / rows.length

  return (
    <ChartCard
      title="Практики по дням"
      subtitle="Сколько практик прослушали в этот день"
      empty={rows.length === 0 ? 'За этот период практик не было.' : undefined}
      table={rows.map((r) => [fmtWeekday(r.date), String(r.total)])}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke={GRID} />
          <XAxis
            dataKey="date"
            {...axisProps}
            interval="preserveStartEnd"
            minTickGap={24}
            tickFormatter={(v: string) => v.slice(8) + '.' + v.slice(5, 7)}
          />
          <YAxis allowDecimals={false} {...axisProps} axisLine={false} />
          <ReferenceLine
            y={avg}
            stroke={AXIS}
            strokeDasharray="4 4"
            label={{ value: `в среднем ${fmtNum(avg, 0)}`, position: 'right', fill: INK3, fontSize: 11 }}
          />
          <Tooltip
            cursor={{ fill: 'rgba(255,255,255,0.04)' }}
            content={(p: unknown) => {
              const t = p as {
                active?: boolean
                payload?: Array<{ payload: { date: string; evening: number; now: number; total: number } }>
              }
              if (!t.active || !t.payload?.length) return null
              const d = t.payload[0]!.payload
              return (
                <TooltipBox
                  title={fmtWeekday(d.date)}
                  rows={[
                    { label: 'всего практик', value: String(d.total), color: S1 },
                    { label: 'вечерних', value: String(d.evening) },
                    { label: '«сейчас»', value: String(d.now) },
                  ]}
                />
              )
            }}
          />
          <Bar dataKey="total" fill={S1} radius={[4, 4, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

// ─────────────────────── что выбирают ───────────────────────

export function CategoryBars({ rows }: { rows: Array<{ category: Category; n: number }> }) {
  const total = rows.reduce((s, r) => s + r.n, 0)
  const data = (['sleep', 'calm', 'day'] as Category[]).map((c) => ({
    category: c,
    label: CATEGORY_LABEL[c],
    n: rows.find((r) => r.category === c)?.n ?? 0,
  }))

  return (
    <ChartCard
      title="Какие состояния выбирают"
      subtitle="Все практики за период"
      empty={total === 0 ? 'Пока никто не выбирал состояние.' : undefined}
      table={data.map((d) => [d.label, `${d.n} · ${total === 0 ? '0%' : Math.round((d.n / total) * 100) + '%'}`])}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 80, left: 0, bottom: 0 }}>
          <CartesianGrid horizontal={false} stroke={GRID} />
          <XAxis type="number" hide domain={[0, Math.max(total, 1)]} />
          <YAxis type="category" dataKey="label" width={170} {...axisProps} axisLine={false} />
          <Bar dataKey="n" radius={[0, 4, 4, 0]} barSize={22} isAnimationActive={false}>
            {data.map((d) => (
              <Cell key={d.category} fill={CATEGORY_COLOR[d.category]} />
            ))}
            <LabelList
              dataKey="n"
              position="right"
              content={(props: unknown) => {
                const p = props as { x?: number; y?: number; width?: number; height?: number; value?: number }
                const value = Number(p.value ?? 0)
                return (
                  <text
                    x={(p.x ?? 0) + (p.width ?? 0) + 8}
                    y={(p.y ?? 0) + (p.height ?? 0) / 2 + 4}
                    fill="var(--color-ink2)"
                    fontSize={12}
                  >
                    {`${value} · ${total === 0 ? 0 : Math.round((value / total) * 100)}%`}
                  </text>
                )
              }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

// ─────────────────────── неделя одного человека ───────────────────────

export function PersonLines({ points }: { points: ChartPoint[] }) {
  const data = Array.from({ length: 7 }, (_, i) => {
    const p = points.find((x) => x.evening === i + 1)
    return { evening: i + 1, before: p?.before ?? null, after: p?.after ?? null }
  })
  const first = points.find((p) => p.before !== null)?.before ?? null
  const last = [...points].reverse().find((p) => p.after !== null)?.after ?? null

  return (
    <ChartCard
      title="Его неделя"
      subtitle="Цифра до практики и после, по вечерам"
      legend={[{ color: S1, label: 'до' }, { color: S2, label: 'после' }]}
      empty={points.length === 0 ? 'Вечеров пока нет — график появится после первой практики.' : undefined}
      table={data
        .filter((d) => d.before !== null || d.after !== null)
        .map((d) => [`Вечер ${d.evening}`, `до ${d.before ?? '—'} · после ${d.after ?? '—'}`])}
      footnote={first !== null && last !== null ? `Было ${first} → стало ${last}` : undefined}
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke={GRID} />
          <XAxis dataKey="evening" {...axisProps} />
          <YAxis domain={[0, 10]} ticks={[0, 2, 4, 6, 8, 10]} {...axisProps} axisLine={false} />
          <Tooltip
            content={(p: unknown) => {
              const t = p as {
                active?: boolean
                payload?: Array<{ payload: { evening: number; before: number | null; after: number | null } }>
              }
              if (!t.active || !t.payload?.length) return null
              const d = t.payload[0]!.payload
              return (
                <TooltipBox
                  title={`Вечер ${d.evening}`}
                  rows={[
                    { label: 'до', value: d.before === null ? 'нет' : String(d.before), color: S1 },
                    { label: 'после', value: d.after === null ? 'нет' : String(d.after), color: S2 },
                  ]}
                />
              )
            }}
          />
          {/* connectNulls={false}: пропущенный вечер это разрыв, а не ноль. */}
          <Line
            type="monotone" dataKey="before" stroke={S1} strokeWidth={2} connectNulls={false}
            dot={{ r: 4, fill: S1 }} activeDot={{ r: 6 }} isAnimationActive={false}
          />
          <Line
            type="monotone" dataKey="after" stroke={S2} strokeWidth={2} connectNulls={false}
            dot={{ r: 4, fill: S2 }} activeDot={{ r: 6 }} isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}
