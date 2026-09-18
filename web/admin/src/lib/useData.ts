/**
 * Загрузка данных экрана: три состояния (идёт, ошибка, данные) и тихое обновление
 * раз в минуту. Отдельный хук нужен, чтобы «Обновлено минуту назад» и скелетоны
 * везде вели себя одинаково, а не так, как написал автор конкретной страницы.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

export type DataState<T> = {
  data: T | null
  error: string | null
  loading: boolean
  /** Момент последней удачной загрузки — для строки «обновлено …». */
  loadedAt: number | null
  reload: () => void
  set: (updater: (prev: T) => T) => void
}

export function useData<T>(load: () => Promise<T>, deps: unknown[] = [], refreshMs = 60_000): DataState<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadedAt, setLoadedAt] = useState<number | null>(null)
  const loadRef = useRef(load)
  loadRef.current = load

  const run = useCallback(async (quiet: boolean) => {
    if (!quiet) setLoading(true)
    try {
      const next = await loadRef.current()
      setData(next)
      setError(null)
      setLoadedAt(Date.now())
    } catch (err) {
      // Тихое фоновое обновление не имеет права стереть уже показанные цифры.
      if (!quiet) setError(err instanceof Error ? err.message : 'Не получилось загрузить данные')
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    void run(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  useEffect(() => {
    if (refreshMs <= 0) return
    const t = setInterval(() => void run(true), refreshMs)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshMs, ...deps])

  return {
    data,
    error,
    loading,
    loadedAt,
    reload: () => void run(false),
    set: (updater) => setData((prev) => (prev === null ? prev : updater(prev))),
  }
}
