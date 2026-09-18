/**
 * Вход. §3.1 design-admin.
 *
 * Логина нет — только пароль, поэтому на экране нет ни одного лишнего элемента.
 * Сообщения об ошибке подсказывают, что делать («проверь раскладку и Caps Lock»),
 * а не сообщают факт: «неверный пароль» человеку и так виден.
 */

import { useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../api.ts'
import { Button, Field, inputClass } from '../components/ui.tsx'

export function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lockLeft, setLockLeft] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Отсчёт после пятой неудачи: кнопка неактивна, и видно, сколько ждать.
  useEffect(() => {
    if (lockLeft <= 0) return
    const t = setTimeout(() => setLockLeft((v) => v - 1), 1000)
    return () => clearTimeout(t)
  }, [lockLeft])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy || lockLeft > 0) return
    setBusy(true)
    setError(null)
    try {
      await api.login(password, remember)
      onDone()
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setLockLeft(60)
        setError('Слишком много попыток. Попробуй через минуту.')
      } else if (err instanceof ApiError && err.code === 'offline') {
        setError('Сервер не отвечает. Попробуй обновить страницу.')
      } else {
        setError('Пароль не подошёл. Проверь раскладку и Caps Lock.')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen justify-center bg-page px-4 pt-[18vh] md:items-center md:pt-0">
      <form onSubmit={submit} className="w-full max-w-[380px] rounded-[16px] border border-line bg-surface p-6">
        <div className="text-center">
          <div className="font-serif text-[28px] text-ink">Семь ночей</div>
          <div className="text-[13px] text-ink2">админка</div>
        </div>

        <div className="mt-6">
          <Field error={error}>
            <div className="relative">
              <input
                ref={inputRef}
                type={show ? 'text' : 'password'}
                autoComplete="current-password"
                placeholder="Пароль"
                value={password}
                disabled={busy}
                onChange={(e) => setPassword(e.target.value)}
                className={`${inputClass} pr-16 ${error ? 'border-[color:var(--color-st-blocked)]' : ''}`}
              />
              <button
                type="button"
                onClick={() => setShow((v) => !v)}
                className="absolute inset-y-0 right-3 my-auto h-8 text-[13px] text-ink2"
              >
                {show ? 'Скрыть' : 'Показать'}
              </button>
            </div>
          </Field>
        </div>

        <label className="mt-3 flex items-center gap-2 text-[14px] text-ink2">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="h-4 w-4 accent-[color:var(--color-accent)]"
          />
          Запомнить меня на этом устройстве
        </label>

        <div className="mt-5">
          <Button type="submit" kind="accent" full disabled={busy || lockLeft > 0}>
            {busy ? 'Вхожу…' : lockLeft > 0 ? `Подожди ${lockLeft} с` : 'Войти'}
          </Button>
        </div>

        <p className="mt-5 text-center text-[12px] text-ink3">
          Забыла пароль — напиши разработчику, он поставит новый.
        </p>
      </form>
    </div>
  )
}
