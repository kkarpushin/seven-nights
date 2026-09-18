/**
 * Один способ сходить на сервер. Здесь же живёт реакция на 401: если кука
 * протухла посреди работы, экран не должен показывать «ошибка загрузки» — он
 * должен показать форму входа, поэтому событие расходится по приложению.
 */

import type {
  Dashboard, Me, NotificationRow, Practice, Settings, TextsResponse, UserCard, UserRow,
} from './types.ts'

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly payload: Record<string, unknown>
  constructor(status: number, code: string, message: string, payload: Record<string, unknown> = {}) {
    super(message)
    this.status = status
    this.code = code
    this.payload = payload
  }
}

export const UNAUTHORIZED_EVENT = 'sn:unauthorized'

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, { credentials: 'same-origin', ...init })
  } catch {
    throw new ApiError(0, 'offline', 'Сервер не отвечает. Попробуй обновить страницу.')
  }
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT))
    throw new ApiError(401, 'unauthorized', 'Нужно войти заново.')
  }
  const isJson = (res.headers.get('content-type') ?? '').includes('application/json')
  const body = isJson ? await res.json() : null
  if (!res.ok) {
    const payload = (body ?? {}) as Record<string, unknown>
    throw new ApiError(
      res.status,
      String(payload.error ?? 'error'),
      String(payload.message ?? 'Что-то пошло не так.'),
      payload,
    )
  }
  return body as T
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

const qs = (params: Record<string, string | number | boolean | undefined>): string => {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '' || v === false) continue
    sp.set(k, String(v))
  }
  const s = sp.toString()
  return s === '' ? '' : `?${s}`
}

export const api = {
  login: (password: string, remember: boolean) =>
    request<{ ok: true }>('/api/admin/login', json('POST', { password, remember })),
  logout: () => request<{ ok: true }>('/api/admin/logout', { method: 'POST' }),
  me: () => request<Me>('/api/admin/me'),

  dashboard: (period: string, demo: boolean) =>
    request<Dashboard>(`/api/admin/stats${qs({ period, demo })}`),

  users: (p: {
    q?: string; segment?: string; sort?: string; dir?: string; page?: number; per?: number; demo?: boolean
  }) => request<{ rows: UserRow[]; total: number; page: number; per: number }>(`/api/admin/users${qs(p)}`),
  user: (id: number) => request<UserCard>(`/api/admin/users/${id}`),
  userPause: (id: number, on: boolean) =>
    request<{ ok: true }>(`/api/admin/users/${id}/pause`, json('POST', { on })),
  userDemo: (id: number, on: boolean) =>
    request<{ ok: true }>(`/api/admin/users/${id}/demo`, json('POST', { on })),
  userMessage: (id: number, text: string) =>
    request<{ ok: true; msgId: number }>(`/api/admin/users/${id}/message`, json('POST', { text })),
  userDelete: (id: number, tgId: number) =>
    request<{ ok: true }>(`/api/admin/users/${id}${qs({ confirm: tgId })}`, { method: 'DELETE' }),

  practices: () => request<{ rows: Practice[] }>('/api/admin/practices'),
  practiceCreate: (p: Partial<Practice>) =>
    request<{ ok: true; practice: Practice }>('/api/admin/practices', json('POST', p)),
  practicePatch: (id: number, p: Partial<Practice>) =>
    request<{ ok: true; practice: Practice }>(`/api/admin/practices/${id}`, json('PATCH', p)),
  practiceOff: (id: number) =>
    request<{ ok: true; practice: Practice }>(`/api/admin/practices/${id}`, { method: 'DELETE' }),
  practiceReorder: (order: Array<{ id: number; sort_order: number }>) =>
    request<{ ok: true; rows: Practice[] }>('/api/admin/practices/reorder', json('POST', { order })),
  practiceSendToMe: (id: number, tgId: number) =>
    request<{ ok: true }>(`/api/admin/practices/${id}/preview`, json('POST', { tg_id: tgId })),

  texts: () => request<TextsResponse>('/api/admin/texts'),
  textSave: (key: string, value: string) =>
    request<{ ok: true; row: import('./types.ts').TextRow; warnings: string[] }>(
      `/api/admin/texts/${key}`, json('PUT', { value }),
    ),
  textReset: (key: string) =>
    request<{ ok: true; row: import('./types.ts').TextRow }>(`/api/admin/texts/${key}/reset`, { method: 'POST' }),
  textPreview: (key: string, value: string) =>
    request<{ ok: true; text: string }>(`/api/admin/texts/${key}/preview`, json('POST', { value })),

  settings: () => request<Settings>('/api/admin/settings'),
  settingsSave: (patch: Record<string, unknown>) =>
    request<{ ok: true; settings: Settings; warnings: string[] }>('/api/admin/settings', json('PUT', patch)),
  settingsTest: () => request<{ ok: true }>('/api/admin/settings/test-notification', { method: 'POST' }),

  notifications: (filter: string) =>
    request<{ rows: NotificationRow[]; pending: number }>(`/api/admin/notifications${qs({ filter })}`),
  notificationRetry: (id: number) =>
    request<{ ok: boolean }>(`/api/admin/notifications/${id}/retry`, { method: 'POST' }),

  /**
   * Загрузка файла идёт мимо request(): нужен прогресс, а fetch его не даёт.
   * XMLHttpRequest — единственный способ показать «Загружаю… 62%».
   */
  uploadAudio(id: number, file: File, onProgress: (percent: number) => void): Promise<Practice> {
    return new Promise((resolve, reject) => {
      const form = new FormData()
      form.append('file', file)
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `/api/admin/practices/${id}/audio`)
      xhr.withCredentials = true
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100))
      }
      xhr.onload = () => {
        let body: Record<string, unknown> = {}
        try {
          body = JSON.parse(xhr.responseText) as Record<string, unknown>
        } catch {
          body = {}
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(body.practice as Practice)
        else if (xhr.status === 401) {
          window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT))
          reject(new ApiError(401, 'unauthorized', 'Нужно войти заново.'))
        } else {
          reject(new ApiError(xhr.status, String(body.error ?? 'error'),
            String(body.message ?? 'Загрузка прервалась. Файл цел, попробуй ещё раз.')))
        }
      }
      xhr.onerror = () => reject(new ApiError(0, 'offline', 'Загрузка прервалась. Файл цел, попробуй ещё раз.'))
      xhr.send(form)
    })
  },
}
