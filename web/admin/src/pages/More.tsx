/**
 * «Ещё» — только на телефоне: в таб-бар помещается пять кнопок, а разделов шесть.
 */

import { Link } from 'react-router-dom'
import { PageHeader } from '../components/AppShell.tsx'
import { Button } from '../components/ui.tsx'

export function More({ onLogout, version }: { onLogout: () => void; version: string }) {
  return (
    <>
      <PageHeader title="Ещё" />
      <div className="flex flex-col gap-2">
        <Link
          to="/notifications"
          className="flex min-h-[52px] items-center rounded-[12px] border border-line bg-surface px-4 text-[15px] text-ink"
        >
          Уведомления
        </Link>
        <Link
          to="/settings"
          className="flex min-h-[52px] items-center rounded-[12px] border border-line bg-surface px-4 text-[15px] text-ink"
        >
          Настройки
        </Link>
        <div className="mt-2">
          <Button full onClick={onLogout}>
            Выйти
          </Button>
        </div>
        <p className="mt-4 text-center text-[12px] text-ink3">Семь ночей · версия {version}</p>
      </div>
    </>
  )
}
