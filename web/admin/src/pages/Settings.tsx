/**
 * Настройки. §3.6 design-admin.
 *
 * Здесь единственное место без автосохранения: у каждой карточки своя кнопка
 * «Сохранить». Настройка меняет поведение бота сразу у всех людей, и случайное
 * «ушла из поля» не должно этого делать.
 */

import { useEffect, useState } from 'react'
import { api, ApiError } from '../api.ts'
import { useData } from '../lib/useData.ts'
import { PageHeader } from '../components/AppShell.tsx'
import {
  Button, Card, ErrorState, Field, inputClass, Skeleton, Switch, useConfirm, useToast,
} from '../components/ui.tsx'
import type { Settings as SettingsData } from '../types.ts'

const NOTIFY_LABELS: Array<{ value: string; label: string }> = [
  { value: 'started', label: 'Человек начал программу' },
  { value: 'finished', label: 'Человек дошёл до седьмого вечера' },
  { value: 'silent', label: 'Человек три дня не открывал бота' },
  { value: 'message', label: 'Человек написал текстом' },
  { value: 'blocked', label: 'Человек заблокировал бота' },
  { value: 'no_practices', label: 'Проблема с практиками' },
]

const TZ_OPTIONS: Array<{ label: string; value: number }> = [
  { label: 'Лиссабон, UTC+0', value: 0 },
  { label: 'Берлин, UTC+1', value: 60 },
  { label: 'Киев, UTC+2', value: 120 },
  { label: 'Москва, UTC+3', value: 180 },
  { label: 'Тбилиси, UTC+4', value: 240 },
  { label: 'Ташкент, UTC+5', value: 300 },
  { label: 'Алматы, UTC+6', value: 360 },
  { label: 'Бангкок, UTC+7', value: 420 },
]

export function Settings({ onDemoDefaultChange }: { onDemoDefaultChange: (on: boolean) => void }) {
  const state = useData(() => api.settings(), [], 0)
  const [draft, setDraft] = useState<SettingsData | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const toast = useToast()
  const [confirmNode, ask] = useConfirm()

  useEffect(() => {
    if (state.data && draft === null) setDraft(state.data)
  }, [state.data, draft])

  if (state.loading && !state.data) return <Skeleton h={320} />
  if (state.error || !draft) return <ErrorState title="Не получилось загрузить настройки" onRetry={state.reload} />

  async function save(patch: Record<string, unknown>, done = 'Сохранено') {
    setErrors({})
    try {
      const res = await api.settingsSave(patch)
      setDraft(res.settings)
      onDemoDefaultChange(res.settings.demo_default)
      toast(res.warnings[0] ?? done)
    } catch (err) {
      if (err instanceof ApiError && Array.isArray(err.payload.errors)) {
        const map: Record<string, string> = {}
        for (const e of err.payload.errors as Array<{ field: string; message: string }>) map[e.field] = e.message
        setErrors(map)
      } else {
        toast(err instanceof ApiError ? err.message : 'Не сохранилось')
      }
    }
  }

  return (
    <>
      {confirmNode}
      <PageHeader title="Настройки" subtitle="Куда бот ведёт людей и кому пишет" />

      <div className="flex flex-col gap-4">
        <Card title="Ссылки">
          <div className="flex flex-col gap-4">
            <Field
              label="Ссылка на разговор"
              hint="Бот покажет её кнопкой «Записаться на разговор» в конце седьмого вечера. Если поле пустое, кнопки не будет, а текст останется."
              error={errors.talk_url}
            >
              <div className="flex gap-2">
                <input
                  className={inputClass}
                  type="url"
                  placeholder="https://…"
                  value={draft.talk_url}
                  onChange={(e) => setDraft({ ...draft, talk_url: e.target.value })}
                />
                {draft.talk_url !== '' && (
                  <a
                    href={draft.talk_url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex min-h-[44px] shrink-0 items-center rounded-[12px] border border-line px-3 text-[14px] text-ink2"
                  >
                    Проверить
                  </a>
                )}
              </div>
            </Field>

            <Field
              label="Ссылка на твой канал"
              hint="Кнопка «Мой канал» в сообщении восьмого дня."
              error={errors.channel_url}
            >
              <input
                className={inputClass}
                type="url"
                placeholder="https://…"
                value={draft.channel_url}
                onChange={(e) => setDraft({ ...draft, channel_url: e.target.value })}
              />
            </Field>
          </div>
          <div className="mt-4">
            <Button
              kind="accent"
              onClick={() => save({ talk_url: draft.talk_url, channel_url: draft.channel_url })}
            >
              Сохранить
            </Button>
          </div>
        </Card>

        <Card title="Уведомления мне">
          <Field
            label="Мой Telegram ID"
            hint="Не знаешь свой ID — напиши боту /whoami, он ответит числом. Скопируй его сюда. Можно несколько через запятую."
            error={errors.admin_tg_ids}
          >
            <div className="flex gap-2">
              <input
                className={inputClass}
                inputMode="numeric"
                value={draft.admin_tg_ids.join(', ')}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    admin_tg_ids: e.target.value
                      .split(/[,;\s]+/)
                      .filter((s) => s !== '')
                      .map((s) => Number(s.replace(/\D/g, '')) || 0),
                  })
                }
              />
              <a
                href={`https://t.me/${draft.bot_username}`}
                target="_blank"
                rel="noreferrer"
                className="flex min-h-[44px] shrink-0 items-center rounded-[12px] border border-line px-3 text-[14px] text-ink2"
              >
                Открыть бота
              </a>
            </div>
          </Field>

          <div className="mt-4 flex flex-col gap-1">
            {NOTIFY_LABELS.map((n) => (
              <label key={n.value} className="flex items-center gap-2 text-[14px] text-ink2">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-[color:var(--color-accent)]"
                  checked={draft.notify_types.includes(n.value)}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      notify_types: e.target.checked
                        ? [...draft.notify_types, n.value]
                        : draft.notify_types.filter((t) => t !== n.value),
                    })
                  }
                />
                {n.label}
              </label>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              kind="accent"
              onClick={() =>
                save({ admin_tg_ids: draft.admin_tg_ids.filter((n) => n > 0), notify_types: draft.notify_types })
              }
            >
              Сохранить
            </Button>
            <Button
              onClick={async () => {
                try {
                  await api.settingsTest()
                  toast('Отправила. Проверь Telegram.')
                } catch (err) {
                  toast(err instanceof ApiError ? err.message : 'Не отправилось')
                }
              }}
            >
              Отправить себе тестовое
            </Button>
          </div>
        </Card>

        <Card title="Как работает программа">
          <div className="flex flex-col gap-3">
            <Switch
              label="Разрешить проходить семь вечеров заново"
              hint="После финала у человека появится кнопка «Ещё семь вечеров»."
              checked={draft.allow_restart}
              onChange={(v) => {
                setDraft({ ...draft, allow_restart: v })
                void save({ allow_restart: v })
              }}
            />
            <Switch
              label="Предлагать тест второй раз после седьмого вечера"
              hint="Тот же «Индекс внутренней опоры», чтобы человек увидел «было — стало»."
              checked={draft.quiz_after_enabled}
              onChange={(v) => {
                setDraft({ ...draft, quiz_after_enabled: v })
                void save({ quiz_after_enabled: v })
              }}
            />
            <Switch
              danger
              label="Демо-режим для всех новых"
              hint="Осторожно: в демо вечер идёт пару минут. Это для проверки, не для людей. Включай, когда показываешь программу."
              checked={draft.demo_default}
              onChange={(v) =>
                v
                  ? ask({
                      title: 'Включить демо-режим для всех новых?',
                      text: 'Каждый, кто нажмёт «Старт», пойдёт по ускоренной программе. Это режим показа, а не работы.',
                      confirmLabel: 'Включить демо',
                      onConfirm: async () => {
                        setDraft({ ...draft, demo_default: true })
                        await save({ demo_default: true })
                      },
                    })
                  : void (async () => {
                      setDraft({ ...draft, demo_default: false })
                      await save({ demo_default: false })
                    })()
              }
            />

            <Field
              label="Часовой пояс по умолчанию"
              hint="Бот сам определяет пояс по вопросу «сколько сейчас на часах». Это значение — только первая догадка."
              error={errors.default_tz_offset_min}
            >
              <select
                className={inputClass}
                value={draft.default_tz_offset_min}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  setDraft({ ...draft, default_tz_offset_min: v })
                  void save({ default_tz_offset_min: v })
                }}
              >
                {TZ_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label="Маршрут вечеров для практик сна"
              hint="Семь вечеров подряд: какая практика звучит в каждый из них. Седьмой вечер намеренно повторяет первый."
              error={errors.sleep_route}
            >
              <div className="flex flex-col gap-2">
                {draft.sleep_route.map((slug, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="w-[74px] shrink-0 text-[13px] text-ink2">Вечер {i + 1}</span>
                    <select
                      className={inputClass}
                      value={slug}
                      onChange={(e) => {
                        const next = [...draft.sleep_route]
                        next[i] = e.target.value
                        setDraft({ ...draft, sleep_route: next })
                      }}
                    >
                      {draft.sleep_practices.map((p) => (
                        <option key={p.slug} value={p.slug}>
                          {p.title}
                          {p.active === 0 ? ' (выключена)' : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </Field>

            <div>
              <Button kind="accent" onClick={() => save({ sleep_route: draft.sleep_route })}>
                Сохранить маршрут
              </Button>
            </div>

            <Field
              label="Секретное слово для команд /demo и /reset"
              hint="Бот принимает эти команды только с ним. Держи его при себе."
              error={errors.demo_secret}
            >
              <div className="flex gap-2">
                <input
                  className={inputClass}
                  value={draft.demo_secret}
                  onChange={(e) => setDraft({ ...draft, demo_secret: e.target.value })}
                />
                <Button onClick={() => save({ demo_secret: draft.demo_secret })}>Сохранить</Button>
              </div>
            </Field>
          </div>
        </Card>

        <Card title="Выгрузки">
          <p className="mb-3 text-[14px] text-ink2">Файлы открываются в Excel.</p>
          <div className="flex flex-wrap gap-2">
            {[
              ['Люди', '/api/admin/export/users.csv'],
              ['Вечера', '/api/admin/export/sessions.csv'],
              ['События', '/api/admin/export/events.csv'],
            ].map(([label, href]) => (
              <a
                key={href}
                href={href}
                className="flex min-h-[44px] items-center rounded-[12px] border border-line bg-raised px-4 text-[15px] text-ink"
              >
                Скачать «{label}»
              </a>
            ))}
          </div>
        </Card>

        <Card title="Пароль в админку">
          <p className="text-[14px] text-ink2">
            Пароль хранится в настройках сервера, а не в базе, — так его нельзя случайно стереть из этого экрана.
            Чтобы поменять, напиши разработчику: это одна строка в настройках и перезапуск.
          </p>
        </Card>
      </div>
    </>
  )
}
