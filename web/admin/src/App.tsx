/**
 * Приложение: кто вошёл, куда ведут маршруты, что делать, когда кука протухла.
 *
 * Состояние входа проверяется одним запросом /me. Пока ответа нет, показывается
 * пустой экран, а не форма входа: мигнувшая форма у уже вошедшего человека
 * выглядит как «меня выкинуло», и это первое, о чём спросят.
 */

import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { api, UNAUTHORIZED_EVENT } from './api.ts'
import type { Me } from './types.ts'
import { AppShell } from './components/AppShell.tsx'
import { ToastHost } from './components/ui.tsx'
import { Login } from './pages/Login.tsx'
import { More } from './pages/More.tsx'
import { Practices } from './pages/Practices.tsx'
import { Texts } from './pages/Texts.tsx'
import { Users } from './pages/Users.tsx'

// Библиотека графиков весит больше, чем всё остальное приложение вместе. Экраны,
// которым она нужна, грузятся отдельным куском: вход и список людей на телефоне
// открываются мгновенно, а графики подтягиваются, когда за ними пришли.
const Dashboard = lazy(() => import('./pages/Dashboard.tsx').then((m) => ({ default: m.Dashboard })))
const User = lazy(() => import('./pages/User.tsx').then((m) => ({ default: m.User })))
const PracticeEdit = lazy(() => import('./pages/PracticeEdit.tsx').then((m) => ({ default: m.PracticeEdit })))
const Settings = lazy(() => import('./pages/Settings.tsx').then((m) => ({ default: m.Settings })))
const Notifications = lazy(() => import('./pages/Notifications.tsx').then((m) => ({ default: m.Notifications })))

export function App() {
  const [me, setMe] = useState<Me | null>(null)
  const [checked, setChecked] = useState(false)
  const [demoDefault, setDemoDefault] = useState(false)

  const check = useCallback(async () => {
    try {
      const res = await api.me()
      setMe(res)
      setDemoDefault(res.demoDefault)
    } catch {
      setMe(null)
    } finally {
      setChecked(true)
    }
  }, [])

  useEffect(() => {
    void check()
  }, [check])

  // Кука могла протухнуть посреди работы: любой 401 возвращает на форму входа.
  useEffect(() => {
    const onUnauthorized = () => setMe(null)
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
  }, [])

  if (!checked) return <div className="min-h-screen bg-page" />
  if (!me) return <Login onDone={() => void check()} />

  const logout = async () => {
    try {
      await api.logout()
    } finally {
      setMe(null)
    }
  }

  return (
    <BrowserRouter basename="/admin">
      <ToastHost>
        <AppShell
          demoOn={demoDefault}
          onLogout={() => void logout()}
          onDemoOff={async () => {
            await api.settingsSave({ demo_default: false })
            setDemoDefault(false)
          }}
        >
          <Suspense fallback={<div className="skeleton h-[280px] w-full" />}>
          <Routes>
            <Route path="/" element={<Dashboard showDemo={demoDefault} />} />
            <Route path="/people" element={<Users showDemo={demoDefault} />} />
            <Route path="/people/:id" element={<User />} />
            <Route path="/practices" element={<Practices />} />
            <Route path="/practices/:id" element={<PracticeEdit />} />
            <Route path="/texts" element={<Texts />} />
            <Route path="/notifications" element={<Notifications adminsSet={me.adminsSet} />} />
            <Route path="/settings" element={<Settings onDemoDefaultChange={setDemoDefault} />} />
            <Route path="/more" element={<More onLogout={() => void logout()} version={me.version} />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          </Suspense>
        </AppShell>
      </ToastHost>
    </BrowserRouter>
  )
}
