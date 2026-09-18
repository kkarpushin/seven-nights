/**
 * Оболочка: слева меню на ноутбуке, снизу таб-бар на телефоне. §1 design-admin.
 *
 * Телефон здесь не урезанная версия: те же разделы, те же данные, другая раскладка.
 * Психолог смотрит людей чаще всего с телефона, и «откройте с компьютера» было бы
 * отказом в работе, а не ограничением интерфейса.
 */

import { NavLink } from 'react-router-dom'
import type { ReactNode } from 'react'
import { Button } from './ui.tsx'

export type NavItem = { to: string; label: string; short: string; icon: string }

export const NAV: NavItem[] = [
  { to: '/', label: 'Обзор', short: 'Обзор', icon: '◴' },
  { to: '/people', label: 'Люди', short: 'Люди', icon: '☺' },
  { to: '/practices', label: 'Практики', short: 'Практики', icon: '♪' },
  { to: '/texts', label: 'Тексты бота', short: 'Тексты', icon: '¶' },
  { to: '/notifications', label: 'Уведомления', short: 'Ещё', icon: '✉' },
  { to: '/settings', label: 'Настройки', short: 'Настройки', icon: '⚙' },
]

const MOBILE_TABS = ['/', '/people', '/practices', '/texts', '/more']

export function AppShell({
  children, demoOn, onLogout, onDemoOff,
}: {
  children: ReactNode
  demoOn: boolean
  onLogout: () => void
  onDemoOff: () => void
}) {
  return (
    <div className="min-h-screen bg-page">
      {demoOn && (
        <div className="sticky top-0 z-40 flex h-9 items-center justify-center gap-2 bg-accent/12 text-[13px] text-ink">
          <span>⚡ Демо-режим включён: вечер идёт пару минут.</span>
          <button type="button" className="text-accent underline underline-offset-2" onClick={onDemoOff}>
            Выключить
          </button>
        </div>
      )}

      <div className="mx-auto flex w-full max-w-[1440px]">
        {/* Ноутбук: фиксированная колонка меню. */}
        <aside className="sticky top-0 hidden h-screen w-[232px] shrink-0 flex-col border-r border-line px-4 py-6 md:flex">
          <div className="px-2">
            <div className="font-serif text-[20px] text-ink">Семь ночей</div>
            <div className="text-[12px] text-ink3">админка</div>
          </div>
          <nav className="mt-7 flex flex-col gap-1">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  [
                    'relative flex min-h-[44px] items-center gap-3 rounded-[12px] px-3 text-[15px] transition',
                    isActive ? 'bg-raised text-ink' : 'text-ink2 hover:text-ink',
                  ].join(' ')
                }
              >
                {({ isActive }) => (
                  <>
                    {isActive && <span className="absolute left-0 h-5 w-[2px] rounded-full bg-accent" />}
                    <span className="w-5 text-center text-ink3" aria-hidden>{item.icon}</span>
                    {item.label}
                  </>
                )}
              </NavLink>
            ))}
          </nav>
          <div className="mt-auto px-1">
            <Button kind="ghost" onClick={onLogout} full>
              Выйти
            </Button>
          </div>
        </aside>

        <div className="min-w-0 flex-1">
          {/* Телефон: словесный знак сверху. Имя экрана не дублируем — оно ниже
              заголовком страницы, и два одинаковых слова подряд читаются как ошибка. */}
          <header className="flex items-center justify-between px-4 py-4 md:hidden">
            <span className="font-serif text-[19px] text-ink">Семь ночей</span>
            <button
              type="button"
              onClick={onLogout}
              className="flex h-10 w-10 items-center justify-center rounded-full border border-line text-ink2"
              aria-label="Выйти"
            >
              ⏻
            </button>
          </header>

          <main className="mx-auto w-full max-w-[1180px] px-4 pb-[96px] md:px-8 md:py-8 md:pb-10">{children}</main>
        </div>
      </div>

      {/* Телефон: таб-бар. Пятая кнопка ведёт в «Ещё» — уведомления и настройки. */}
      <nav
        className="fixed inset-x-0 bottom-0 z-40 flex border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
        aria-label="Разделы"
      >
        {MOBILE_TABS.map((to) => {
          const item = to === '/more' ? { to, label: 'Ещё', short: 'Ещё', icon: '⋯' } : NAV.find((n) => n.to === to)!
          return (
            <NavLink
              key={to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                [
                  'flex h-[56px] flex-1 flex-col items-center justify-center gap-0.5 text-[11px]',
                  isActive ? 'text-accent' : 'text-ink2',
                ].join(' ')
              }
            >
              <span className="text-[16px]" aria-hidden>{item.icon}</span>
              {item.short}
            </NavLink>
          )
        })}
      </nav>
    </div>
  )
}

export function PageHeader({
  title, subtitle, action, back,
}: {
  title: string
  subtitle?: ReactNode
  action?: ReactNode
  back?: ReactNode
}) {
  return (
    <header className="mb-4 md:mb-6">
      {back}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold text-ink md:text-[26px]">{title}</h1>
          {subtitle && <div className="mt-1 text-[13px] text-ink2">{subtitle}</div>}
        </div>
        {action}
      </div>
    </header>
  )
}
