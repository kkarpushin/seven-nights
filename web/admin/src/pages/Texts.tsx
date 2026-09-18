/**
 * Тексты бота. §3.5 design-admin.
 *
 * Карточка начинается не с ключа, а с описания «где это видно»: специалист ищет
 * фразу по смыслу («первое сообщение»), а не по `onb.welcome`. Ключ оставлен
 * мелким и тусклым — он нужен ровно один раз, в разговоре с разработчиком.
 */

import { useMemo, useRef, useState } from 'react'
import { api, ApiError } from '../api.ts'
import { useData } from '../lib/useData.ts'
import { PageHeader } from '../components/AppShell.tsx'
import { Button, Chip, EmptyState, ErrorState, inputClass, SkeletonRows, useToast } from '../components/ui.tsx'
import { TelegramBubble } from '../components/TelegramPreview.tsx'
import type { TextRow } from '../types.ts'

export function Texts() {
  const state = useData(() => api.texts(), [], 0)
  const [query, setQuery] = useState('')
  const [section, setSection] = useState('')

  const rows = useMemo(() => {
    const all = state.data?.rows ?? []
    const q = query.trim().toLowerCase()
    return all.filter((r) => {
      if (section !== '' && r.section !== section) return false
      if (q === '') return true
      return r.value.toLowerCase().includes(q) || r.hint.toLowerCase().includes(q)
    })
  }, [state.data, query, section])

  const sections = state.data?.sections ?? []
  const grouped = useMemo(() => {
    const map = new Map<string, TextRow[]>()
    for (const r of rows) map.set(r.section, [...(map.get(r.section) ?? []), r])
    return map
  }, [rows])

  return (
    <>
      <PageHeader
        title="Тексты бота"
        subtitle="Это всё, что бот пишет людям. Меняй смело: всегда можно вернуть как было."
        action={
          <input
            className={`${inputClass} md:w-[240px]`}
            placeholder="Найти по словам"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        }
      />

      <div className="mb-4 flex gap-2 overflow-x-auto pb-1">
        <Chip active={section === ''} onClick={() => setSection('')}>
          Все
        </Chip>
        {sections.map((s) => (
          <Chip key={s.section} active={section === s.section} onClick={() => setSection(s.section)} count={s.count}>
            {s.title}
          </Chip>
        ))}
      </div>

      {state.loading && !state.data ? (
        <SkeletonRows rows={6} h={120} />
      ) : state.error || !state.data ? (
        <ErrorState title="Не получилось загрузить тексты" onRetry={state.reload} />
      ) : rows.length === 0 ? (
        <EmptyState title={`Ничего не нашла по слову «${query}»`}>
          <Button
            onClick={() => {
              setQuery('')
              setSection('')
            }}
          >
            Показать все тексты
          </Button>
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-6">
          {sections
            .filter((s) => grouped.has(s.section))
            .map((s) => (
              <section key={s.section}>
                <h2 className="mb-1 text-[16px] font-semibold text-ink">{s.title}</h2>
                {s.section === 'admin' && (
                  <p className="mb-3 text-[13px] text-ink2">Эти сообщения бот присылает тебе, а не людям.</p>
                )}
                <div className="flex flex-col gap-3">
                  {(grouped.get(s.section) ?? []).map((row) => (
                    <TextCard key={row.key} row={row} onChanged={(next) =>
                      state.set((prev) => ({ ...prev, rows: prev.rows.map((r) => (r.key === next.key ? next : r)) }))
                    } />
                  ))}
                </div>
              </section>
            ))}
        </div>
      )}
    </>
  )
}

function TextCard({ row, onChanged }: { row: TextRow; onChanged: (row: TextRow) => void }) {
  const [value, setValue] = useState(row.value)
  const [error, setError] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const areaRef = useRef<HTMLTextAreaElement | null>(null)
  const toast = useToast()
  const isButton = row.key.startsWith('btn.')

  async function save() {
    if (value === row.value) return
    setError(null)
    try {
      const res = await api.textSave(row.key, value)
      onChanged(res.row)
      setWarning(res.warnings[0] ?? null)
      const previous = row.value
      toast('Сохранено', async () => {
        const back = await api.textSave(row.key, previous)
        onChanged(back.row)
        setValue(previous)
      })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не сохранилось. Нажми «Повторить».')
    }
  }

  async function reset() {
    try {
      const res = await api.textReset(row.key)
      onChanged(res.row)
      setValue(res.row.value)
      setError(null)
      toast('Вернула текст по умолчанию')
    } catch {
      setError('Не получилось вернуть')
    }
  }

  /** Чип вставляет плейсхолдер туда, где стоит курсор, — иначе его дописывают в конец. */
  function insert(placeholder: string) {
    const el = areaRef.current
    if (!el) return
    const start = el.selectionStart ?? value.length
    const end = el.selectionEnd ?? value.length
    const next = value.slice(0, start) + placeholder + value.slice(end)
    setValue(next)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(start + placeholder.length, start + placeholder.length)
    })
  }

  return (
    <article className="rounded-[16px] border border-line bg-surface p-4">
      <header className="mb-2 flex items-start justify-between gap-3">
        <p className="text-[15px] text-ink">{row.hint}</p>
        <code className="tnum shrink-0 text-[12px] text-ink3">{row.key}</code>
      </header>

      {isButton ? (
        <input
          className={`${inputClass} ${error ? 'border-[color:var(--color-st-blocked)]' : ''}`}
          value={value}
          maxLength={30}
          onChange={(e) => setValue(e.target.value)}
          onBlur={save}
        />
      ) : (
        <textarea
          ref={areaRef}
          className={`${inputClass} min-h-[76px] resize-y ${error ? 'border-[color:var(--color-st-blocked)]' : ''}`}
          value={value}
          rows={Math.min(10, Math.max(2, value.split('\n').length))}
          onChange={(e) => setValue(e.target.value)}
          onBlur={save}
        />
      )}

      {row.placeholder_list.length > 0 && (
        <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1">
          {row.placeholder_list.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => insert(p)}
              className="tnum shrink-0 rounded-full border border-line px-2.5 py-1 text-[12px] text-ink2 hover:text-ink"
            >
              {p}
            </button>
          ))}
        </div>
      )}

      {error && <p className="mt-2 text-[13px] text-[color:var(--color-st-blocked)]">{error}</p>}
      {warning && !error && <p className="mt-2 text-[13px] text-ink2">{warning}</p>}
      {isButton && !error && (
        <p className="mt-2 text-[12px] text-ink3">
          Это надпись на кнопке. Бот узнаёт нажатие по этой надписи, поэтому после изменения проверь бота на себе.
        </p>
      )}

      <footer className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="text-[13px] text-ink2 underline underline-offset-2 hover:text-ink"
          onClick={async () => {
            if (preview !== null) {
              setPreview(null)
              return
            }
            try {
              const res = await api.textPreview(row.key, value)
              setPreview(res.text)
            } catch {
              setPreview('Не получилось показать')
            }
          }}
        >
          {preview === null ? 'Предпросмотр' : 'Скрыть предпросмотр'}
        </button>
        {row.changed && (
          <>
            <span className="rounded-full border border-accent/50 px-2.5 py-0.5 text-[12px] text-accent">Изменено</span>
            <button
              type="button"
              className="text-[13px] text-ink2 underline underline-offset-2 hover:text-ink"
              onClick={reset}
            >
              Вернуть по умолчанию
            </button>
          </>
        )}
      </footer>

      {preview !== null && (
        <div className="mt-3">
          <TelegramBubble text={preview} note="Значения в предпросмотре — для примера" />
        </div>
      )}
    </article>
  )
}
