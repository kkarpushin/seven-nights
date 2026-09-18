/**
 * Журнал уведомлений. §3.7 design-admin.
 *
 * Вопрос экрана: что бот мне присылал и не потерялось ли что-то. Поэтому
 * недоставленное видно сразу и пересылается одной кнопкой.
 */

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api.ts'
import { useData } from '../lib/useData.ts'
import { fmtDate, fmtTime } from '../lib/format.ts'
import { PageHeader } from '../components/AppShell.tsx'
import { Button, Chip, EmptyState, ErrorState, SkeletonRows, useToast } from '../components/ui.tsx'

const FILTERS = [
  { value: 'all', label: 'Все' },
  { value: 'started', label: 'Начали' },
  { value: 'finished', label: 'Финиш' },
  { value: 'silent', label: 'Молчат' },
  { value: 'message', label: 'Написали' },
  { value: 'problems', label: 'Проблемы' },
]

const ICON: Record<string, string> = {
  started: '🟢',
  finished: '🏁',
  silent: '🔕',
  message: '✉️',
  blocked: '⛔',
  no_practices: '⚠️',
}

export function Notifications({ adminsSet }: { adminsSet: boolean }) {
  const [filter, setFilter] = useState('all')
  const state = useData(() => api.notifications(filter), [filter])
  const toast = useToast()

  return (
    <>
      <PageHeader title="Уведомления" subtitle="Что бот присылал тебе в Telegram" />

      {!adminsSet && (
        <p className="mb-4 rounded-[12px] border border-accent/50 bg-surface px-4 py-3 text-[14px] text-ink">
          Уведомления некому отправлять: не задан твой Telegram ID.{' '}
          <Link to="/settings" className="text-accent underline underline-offset-2">
            Настройки →
          </Link>
        </p>
      )}

      <div className="mb-4 flex gap-2 overflow-x-auto pb-1">
        {FILTERS.map((f) => (
          <Chip key={f.value} active={filter === f.value} onClick={() => setFilter(f.value)}>
            {f.label}
          </Chip>
        ))}
      </div>

      {state.loading && !state.data ? (
        <SkeletonRows rows={6} h={56} />
      ) : state.error || !state.data ? (
        <ErrorState title="Не получилось загрузить журнал" onRetry={state.reload} />
      ) : state.data.rows.length === 0 ? (
        <EmptyState
          title="Пока тихо"
          text="Здесь появятся уведомления: кто начал, кто дошёл до конца, кто написал."
        />
      ) : (
        <div className="overflow-hidden rounded-[16px] border border-line bg-surface">
          {state.data.rows.map((n) => (
            <div key={n.id} className="flex items-start gap-3 border-t border-line px-4 py-3 first:border-t-0">
              <span className="text-[16px]" aria-hidden>
                {ICON[n.type] ?? '•'}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[14px] text-ink">{n.text}</p>
                <p className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-ink3">
                  <span>
                    {fmtDate(n.created_at)} {fmtTime(n.created_at)}
                  </span>
                  {n.user_id !== null && (
                    <Link to={`/people/${n.user_id}`} className="text-ink2 underline underline-offset-2">
                      Открыть #{n.user_id}
                    </Link>
                  )}
                  {n.sent_at === null && (
                    <>
                      <span className="rounded-full border border-line px-2 py-0.5">Не доставлено</span>
                      <span>{n.last_error ?? 'Telegram не ответил'}</span>
                    </>
                  )}
                </p>
              </div>
              {n.sent_at === null && (
                <Button
                  size="sm"
                  onClick={async () => {
                    await api.notificationRetry(n.id)
                    toast('Поставила в очередь ещё раз')
                    state.reload()
                  }}
                >
                  Отправить снова
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  )
}
