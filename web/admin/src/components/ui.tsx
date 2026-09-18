/**
 * Кирпичи интерфейса. §4 design-admin.
 *
 * Правило, из-за которого они здесь, а не по месту: у каждого блока обязаны быть
 * три состояния — пусто, загрузка, ошибка. Если писать их на каждой странице
 * заново, одно из трёх однажды забудут, и специалист увидит пустой экран без
 * объяснений вместо «здесь пока никого нет».
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { STATUS_COLOR, STATUS_LABEL, type StatusKind } from '../lib/format.ts'

// ─────────────────────────────── кнопки ───────────────────────────────

type ButtonProps = {
  children: ReactNode
  onClick?: () => void
  kind?: 'accent' | 'quiet' | 'ghost' | 'danger'
  size?: 'md' | 'sm'
  disabled?: boolean
  type?: 'button' | 'submit'
  full?: boolean
  title?: string
}

const BUTTON_KIND: Record<NonNullable<ButtonProps['kind']>, string> = {
  accent: 'bg-accent text-on-accent hover:brightness-105',
  quiet: 'bg-raised text-ink hover:bg-raised/70 border border-line',
  ghost: 'text-ink2 hover:text-ink hover:bg-raised/60',
  danger: 'bg-raised text-[color:var(--color-st-blocked)] border border-line hover:bg-raised/70',
}

export function Button({
  children, onClick, kind = 'quiet', size = 'md', disabled, type = 'button', full, title,
}: ButtonProps) {
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={[
        'inline-flex items-center justify-center gap-2 rounded-[12px] font-medium transition',
        'disabled:opacity-45 disabled:cursor-not-allowed',
        size === 'sm' ? 'min-h-[36px] px-3 text-[14px]' : 'min-h-[44px] px-4 text-[15px]',
        full ? 'w-full' : '',
        BUTTON_KIND[kind],
      ].join(' ')}
    >
      {children}
    </button>
  )
}

// ─────────────────────────────── карточки ───────────────────────────────

export function Card({
  title, subtitle, action, children, className = '',
}: {
  title?: ReactNode
  subtitle?: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`rounded-[16px] border border-line bg-surface p-4 md:p-5 ${className}`}>
      {(title || action) && (
        <header className="mb-3 flex items-start justify-between gap-3">
          <div>
            {title && <h2 className="text-[16px] font-semibold text-ink">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-[13px] text-ink2">{subtitle}</p>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  )
}

export function StatTile({
  value, label, note, tone = 'ink',
}: {
  value: ReactNode
  label: string
  note?: ReactNode
  tone?: 'ink' | 'accent'
}) {
  return (
    <div className="flex min-h-[132px] flex-col justify-between rounded-[16px] border border-line bg-surface p-4">
      <div
        className={`tnum text-[40px] leading-[1.1] font-semibold md:text-[48px] ${
          tone === 'accent' ? 'text-accent' : 'text-ink'
        }`}
      >
        {value}
      </div>
      <div>
        <div className="mt-2 text-[13px] text-ink2">{label}</div>
        {note && <div className="mt-1 text-[12px] text-ink3">{note}</div>}
      </div>
    </div>
  )
}

// ────────────────────────── три обязательных состояния ──────────────────────────

export function Skeleton({ h = 16, w = '100%', className = '' }: { h?: number; w?: string; className?: string }) {
  return <div className={`skeleton ${className}`} style={{ height: h, width: w }} aria-hidden />
}

export function SkeletonRows({ rows = 6, h = 44 }: { rows?: number; h?: number }) {
  return (
    <div className="flex flex-col gap-2" aria-label="Загружаю">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} h={h} />
      ))}
    </div>
  )
}

export function EmptyState({ title, text, children }: { title: string; text?: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-[16px] border border-line bg-surface px-5 py-10 text-center">
      <h3 className="text-[16px] font-semibold text-ink">{title}</h3>
      {text && <p className="max-w-[420px] text-[14px] text-ink2">{text}</p>}
      {children && <div className="mt-1 flex flex-wrap justify-center gap-2">{children}</div>}
    </div>
  )
}

export function ErrorState({ title, onRetry, note }: { title: string; onRetry: () => void; note?: string }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-[16px] border border-line bg-surface px-5 py-8 text-center">
      <h3 className="text-[16px] font-semibold text-ink">{title}</h3>
      {note && <p className="text-[13px] text-ink3">{note}</p>}
      <Button onClick={onRetry}>Попробовать ещё раз</Button>
    </div>
  )
}

// ─────────────────────────────── мелочи ───────────────────────────────

export function StatusChip({ kind }: { kind: StatusKind }) {
  return (
    <span
      className="inline-flex items-center gap-2 rounded-full border border-line bg-raised px-3 py-1 text-[13px] text-ink"
      aria-label={STATUS_LABEL[kind]}
    >
      <span className="h-2 w-2 rounded-full" style={{ background: STATUS_COLOR[kind] }} aria-hidden />
      {STATUS_LABEL[kind]}
    </span>
  )
}

export function Chip({
  active, onClick, children, count,
}: {
  active?: boolean
  onClick?: () => void
  children: ReactNode
  count?: number
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'min-h-[36px] shrink-0 rounded-full border px-3 text-[14px] transition',
        active ? 'border-accent bg-accent/15 text-ink' : 'border-line bg-surface text-ink2 hover:text-ink',
      ].join(' ')}
    >
      {children}
      {count !== undefined && <span className="tnum ml-1.5 text-ink3">{count}</span>}
    </button>
  )
}

export function Segmented<T extends string>({
  value, options, onChange,
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (v: T) => void
}) {
  return (
    <div role="radiogroup" className="inline-flex rounded-[12px] border border-line bg-surface p-1">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={[
            'min-h-[36px] rounded-[9px] px-3 text-[14px] transition',
            value === o.value ? 'bg-raised text-ink' : 'text-ink2 hover:text-ink',
          ].join(' ')}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Switch({
  checked, onChange, label, hint, danger,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  hint?: string
  danger?: boolean
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-[12px] p-2 ${
        danger ? 'border border-[color:var(--color-st-blocked)]/40' : ''
      }`}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`mt-0.5 h-6 w-11 shrink-0 rounded-full border transition ${
          checked ? 'border-accent bg-accent' : 'border-line bg-raised'
        }`}
      >
        <span
          className={`block h-5 w-5 rounded-full bg-page transition ${checked ? 'translate-x-[22px]' : 'translate-x-[2px]'}`}
        />
      </button>
      <span>
        <span className="block text-[15px] text-ink">{label}</span>
        {hint && <span className="mt-0.5 block text-[13px] text-ink2">{hint}</span>}
      </span>
    </label>
  )
}

export function Field({
  label, hint, error, children, counter,
}: {
  label?: string
  hint?: ReactNode
  error?: string | null
  children: ReactNode
  counter?: string
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[14px] font-medium text-ink">{label}</span>
          {counter && <span className="tnum text-[12px] text-ink3">{counter}</span>}
        </div>
      )}
      {children}
      {error ? (
        <span className="text-[13px] text-[color:var(--color-st-blocked)]">{error}</span>
      ) : (
        hint && <span className="text-[13px] text-ink2">{hint}</span>
      )}
    </div>
  )
}

export const inputClass =
  'w-full rounded-[12px] border border-line bg-raised px-3 py-2.5 text-[15px] text-ink outline-none ' +
  'placeholder:text-ink3 focus:border-accent/60'

// ─────────────────────────────── тосты ───────────────────────────────

export type Toast = { id: number; text: string; undo?: () => void }

const ToastCtx = createContext<(text: string, undo?: () => void) => void>(() => {})

export function useToast() {
  return useContext(ToastCtx)
}

export function ToastHost({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(1)

  const push = useCallback((text: string, undo?: () => void) => {
    const id = nextId.current++
    setToasts((prev) => [...prev.slice(-2), { id, text, undo }])
    // Восемь секунд — столько нужно, чтобы прочитать и успеть нажать «Отменить».
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 8000)
  }, [])

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-[76px] z-50 flex flex-col items-center gap-2 px-4 md:bottom-6 md:right-6 md:left-auto md:items-end"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className="pointer-events-auto flex items-center gap-3 rounded-[12px] border border-line bg-raised px-4 py-3 text-[14px] text-ink shadow-lg"
          >
            <span>{t.text}</span>
            {t.undo && (
              <button
                type="button"
                className="text-accent underline underline-offset-2"
                onClick={() => {
                  t.undo?.()
                  setToasts((prev) => prev.filter((x) => x.id !== t.id))
                }}
              >
                Отменить
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

// ─────────────────────────── подтверждение ───────────────────────────

export type Confirm = {
  title: string
  text?: string
  confirmLabel: string
  danger?: boolean
  onConfirm: () => void | Promise<void>
}

export function ConfirmDialog({ confirm, onClose }: { confirm: Confirm | null; onClose: () => void }) {
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!confirm) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirm, onClose])

  if (!confirm) return null
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-page/80 p-4 md:items-center" role="dialog" aria-modal>
      <div className="w-full max-w-[420px] rounded-[16px] border border-line bg-surface p-5">
        <h3 className="text-[17px] font-semibold text-ink">{confirm.title}</h3>
        {confirm.text && <p className="mt-2 text-[14px] text-ink2">{confirm.text}</p>}
        <div className="mt-5 flex flex-col-reverse gap-2 md:flex-row md:justify-end">
          <Button kind="ghost" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button
            kind={confirm.danger ? 'danger' : 'accent'}
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await confirm.onConfirm()
                onClose()
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? 'Минуту…' : confirm.confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}

/** Небольшой хелпер: диалог подтверждения как состояние страницы. */
export function useConfirm(): [ReactNode, (c: Confirm) => void] {
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const node = useMemo(
    () => <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />,
    [confirm],
  )
  return [node, setConfirm]
}
