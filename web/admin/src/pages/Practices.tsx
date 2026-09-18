/**
 * Практики — список по категориям. §3.4 design-admin.
 *
 * Удаления нет нигде: только переключатель «Включена». Выключенная практика видна
 * тусклой — так понятно, что она есть и её можно вернуть, а не «куда-то делась».
 */

import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, ApiError } from '../api.ts'
import { useData } from '../lib/useData.ts'
import { CATEGORY_LABEL, fmtDuration, fmtPlays } from '../lib/format.ts'
import { PageHeader } from '../components/AppShell.tsx'
import {
  Button, Chip, EmptyState, ErrorState, Field, inputClass, SkeletonRows, useToast,
} from '../components/ui.tsx'
import { AudioPlayer, TelegramStatus } from '../components/AudioUploader.tsx'
import type { Category, Practice } from '../types.ts'

const CATS: Category[] = ['sleep', 'calm', 'day']

export function Practices() {
  const [cat, setCat] = useState<Category>('sleep')
  const [creating, setCreating] = useState(false)
  const state = useData(() => api.practices(), [], 0)
  const toast = useToast()

  const rows = useMemo(
    () => (state.data?.rows ?? []).filter((p) => p.category === cat).sort((a, b) => a.sort_order - b.sort_order),
    [state.data, cat],
  )

  async function move(p: Practice, dir: -1 | 1) {
    const idx = rows.findIndex((r) => r.id === p.id)
    const other = rows[idx + dir]
    if (!other) return
    try {
      await api.practiceReorder([
        { id: p.id, sort_order: other.sort_order },
        { id: other.id, sort_order: p.sort_order },
      ])
      state.reload()
    } catch {
      toast('Не получилось поменять порядок')
    }
  }

  async function toggle(p: Practice) {
    try {
      await api.practicePatch(p.id, { active: (p.active === 1 ? 0 : 1) as 0 | 1 })
      state.set((prev) => ({
        rows: prev.rows.map((r) => (r.id === p.id ? { ...r, active: (r.active === 1 ? 0 : 1) as 0 | 1 } : r)),
      }))
      toast(p.active === 1 ? 'Выключила' : 'Включила')
    } catch {
      toast('Не сохранилось')
    }
  }

  const noneActive = (state.data?.rows ?? []).every((p) => p.active === 0)

  return (
    <>
      <PageHeader
        title="Практики"
        action={<Button kind="accent" onClick={() => setCreating(true)}>+ Новая практика</Button>}
      />

      {state.data && state.data.rows.length > 0 && noneActive && (
        <p className="mb-4 rounded-[12px] border border-[color:var(--color-st-blocked)]/50 bg-surface px-4 py-3 text-[14px] text-ink">
          В библиотеке нет ни одной включённой практики — бот не сможет дать людям аудио.
        </p>
      )}

      <div className="mb-4 flex gap-2 overflow-x-auto pb-1">
        {CATS.map((c) => (
          <Chip
            key={c}
            active={cat === c}
            onClick={() => setCat(c)}
            count={(state.data?.rows ?? []).filter((p) => p.category === c).length}
          >
            {CATEGORY_LABEL[c]}
          </Chip>
        ))}
      </div>

      {creating && (
        <NewPractice
          category={cat}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false)
            state.reload()
          }}
        />
      )}

      {state.loading && !state.data ? (
        <SkeletonRows rows={3} h={120} />
      ) : state.error || !state.data ? (
        <ErrorState title="Не получилось загрузить практики" onRetry={state.reload} />
      ) : rows.length === 0 ? (
        <EmptyState title="В этой категории пока нет практик">
          <Button kind="accent" onClick={() => setCreating(true)}>
            + Новая практика
          </Button>
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((p, i) => (
            <article
              key={p.id}
              className={`rounded-[16px] border border-line bg-surface p-4 ${p.active === 0 ? 'opacity-55' : ''}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <Link to={`/practices/${p.id}`} className="text-[16px] font-semibold text-ink hover:underline">
                      {p.title}
                    </Link>
                    <span className="tnum text-[13px] text-ink3">{fmtDuration(p.duration_sec)}</span>
                    {p.active === 0 && <span className="text-[12px] text-ink3">Выключена</span>}
                  </div>
                  <p className="mt-1 line-clamp-2 text-[13px] italic text-ink2">
                    {[p.line1, p.line2].filter(Boolean).join(' ') || 'Две строки под аудио пока пустые'}
                  </p>
                  <div className="mt-2">
                    <TelegramStatus practice={p} />
                  </div>
                  <p className="mt-1 text-[12px] text-ink3">Слушали {fmtPlays(p.plays)}</p>
                </div>

                <div className="flex shrink-0 flex-col items-end gap-2">
                  <div className="flex gap-1">
                    <Button size="sm" kind="ghost" onClick={() => move(p, -1)} disabled={i === 0} title="Выше">
                      ↑
                    </Button>
                    <Button size="sm" kind="ghost" onClick={() => move(p, 1)} disabled={i === rows.length - 1} title="Ниже">
                      ↓
                    </Button>
                  </div>
                  <Button size="sm" onClick={() => toggle(p)}>
                    {p.active === 1 ? 'Выключить' : 'Включить'}
                  </Button>
                  <Link to={`/practices/${p.id}`} className="text-[13px] text-ink2 underline underline-offset-2">
                    Редактировать
                  </Link>
                </div>
              </div>

              {p.audio_path && (
                <div className="mt-3">
                  <AudioPlayer src={`/media/practices/${p.slug}.mp3`} compact />
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </>
  )
}

function NewPractice({
  category, onClose, onCreated,
}: {
  category: Category
  onClose: () => void
  onCreated: () => void
}) {
  const [title, setTitle] = useState('')
  const [slug, setSlug] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function create() {
    setBusy(true)
    setError(null)
    try {
      await api.practiceCreate({ title: title.trim(), slug: slug.trim(), category })
      onCreated()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не получилось создать')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mb-4 rounded-[16px] border border-line bg-surface p-4">
      <h2 className="mb-3 text-[16px] font-semibold text-ink">Новая практика · {CATEGORY_LABEL[category]}</h2>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Название" hint="Видно человеку в плеере Telegram.">
          <input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Отпустить день" />
        </Field>
        <Field label="Короткое имя файла" hint="Латиницей, через дефис: по нему называется mp3." error={error}>
          <input
            className={inputClass}
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
            placeholder="sleep-release"
          />
        </Field>
      </div>
      <div className="mt-3 flex gap-2">
        <Button kind="accent" onClick={create} disabled={busy || title.trim() === '' || slug.length < 3}>
          Создать
        </Button>
        <Button kind="ghost" onClick={onClose}>
          Отмена
        </Button>
      </div>
    </div>
  )
}
