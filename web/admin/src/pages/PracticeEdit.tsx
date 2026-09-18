/**
 * Одна практика: поля слева, «как это увидит человек» справа. §3.4 design-admin.
 *
 * Поля сохраняются по уходу из поля — кнопка «Сохранить» оставлена только для
 * спокойствия. Предпросмотр обновляется на каждое нажатие клавиши: две строки
 * пишутся именно так, глядя на то, как они лягут под аудио.
 */

import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, ApiError } from '../api.ts'
import { useData } from '../lib/useData.ts'
import { CATEGORY_LABEL } from '../lib/format.ts'
import { PageHeader } from '../components/AppShell.tsx'
import { Button, Card, ErrorState, Field, inputClass, Skeleton, Segmented, useToast } from '../components/ui.tsx'
import { AudioBlock } from '../components/AudioUploader.tsx'
import { TelegramPreview } from '../components/TelegramPreview.tsx'
import type { Category, Practice } from '../types.ts'

const MAX_TOTAL = 900

export function PracticeEdit() {
  const { id } = useParams()
  const practiceId = Number(id)
  const state = useData(() => api.practices(), [], 0)
  const settings = useData(() => api.settings(), [], 0)
  const texts = useData(() => api.texts(), [], 0)
  const toast = useToast()

  const [draft, setDraft] = useState<Practice | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [kind, setKind] = useState<'evening' | 'now'>('evening')

  const loaded = state.data?.rows.find((p) => p.id === practiceId) ?? null
  useEffect(() => {
    if (loaded && draft === null) setDraft(loaded)
  }, [loaded, draft])

  if (state.loading && !state.data) return <Skeleton h={320} />
  if (state.error) return <ErrorState title="Не получилось загрузить практику" onRetry={state.reload} />
  if (!draft) return <ErrorState title="Такой практики нет" onRetry={state.reload} />

  const tooLong = draft.line1.length + draft.line2.length > MAX_TOTAL

  async function save(patch: Partial<Practice>) {
    if (!draft) return
    setError(null)
    try {
      const res = await api.practicePatch(draft.id, patch)
      setDraft(res.practice)
      toast('Сохранено')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не сохранилось. Проверь связь.')
    }
  }

  const captionKey = kind === 'evening' ? 'ev.practice_caption' : 'now.practice_caption'
  const caption = texts.data?.rows.find((t) => t.key === captionKey)?.value ?? '{line1}\n{line2}'
  const sleepHint =
    kind === 'evening' && draft.category === 'sleep'
      ? texts.data?.rows.find((t) => t.key === 'ev.practice_sleep_hint')?.value
      : undefined
  const myTgId = settings.data?.admin_tg_ids[0]

  return (
    <>
      <PageHeader
        back={
          <Link to="/practices" className="mb-2 inline-block text-[13px] text-ink2 hover:text-ink">
            ← Практики
          </Link>
        }
        title={draft.title || 'Без названия'}
        subtitle={CATEGORY_LABEL[draft.category]}
      />

      <div className="grid gap-4 md:grid-cols-[1.3fr_1fr]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <div className="flex flex-col gap-4">
              <Field label="Название" hint="Видно человеку в плеере Telegram.">
                <input
                  className={inputClass}
                  value={draft.title}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  onBlur={() => draft.title !== loaded?.title && save({ title: draft.title })}
                />
              </Field>

              <Field label="Категория" hint="Категория решает, кому бот её предложит.">
                <div className="flex flex-wrap gap-2">
                  {(['sleep', 'calm', 'day'] as Category[]).map((c) => (
                    <Button
                      key={c}
                      size="sm"
                      kind={draft.category === c ? 'accent' : 'quiet'}
                      onClick={() => {
                        setDraft({ ...draft, category: c })
                        void save({ category: c })
                      }}
                    >
                      {CATEGORY_LABEL[c]}
                    </Button>
                  ))}
                </div>
              </Field>

              <div>
                <p className="mb-2 text-[13px] text-ink2">
                  Приходят вместе с аудио. Коротко, на «ты», от женского лица, без восклицательных знаков и без
                  указания на пол человека.
                </p>
                <div className="flex flex-col gap-3">
                  <Field label="Первая строка" counter={`${draft.line1.length} из 200`}>
                    <input
                      className={inputClass}
                      value={draft.line1}
                      onChange={(e) => setDraft({ ...draft, line1: e.target.value })}
                      onBlur={() => draft.line1 !== loaded?.line1 && save({ line1: draft.line1 })}
                    />
                  </Field>
                  <Field
                    label="Вторая строка"
                    counter={`${draft.line2.length} из 200`}
                    error={tooLong ? 'Слишком длинно, Telegram не примет подпись. Убери примерно 40 знаков.' : error}
                  >
                    <input
                      className={inputClass}
                      value={draft.line2}
                      onChange={(e) => setDraft({ ...draft, line2: e.target.value })}
                      onBlur={() => draft.line2 !== loaded?.line2 && save({ line2: draft.line2 })}
                    />
                  </Field>
                </div>
              </div>
            </div>
          </Card>

          <Card title="Аудио">
            <AudioBlock
              practice={draft}
              canSend={myTgId !== undefined}
              onUploaded={(p) => {
                setDraft(p)
                toast('Аудио загружено')
                state.reload()
              }}
              onSendToMe={async () => {
                if (myTgId === undefined) return
                try {
                  await api.practiceSendToMe(draft.id, myTgId)
                  toast('Отправила. Проверь Telegram.')
                  state.reload()
                } catch (err) {
                  toast(err instanceof ApiError ? err.message : 'Не отправилось')
                }
              }}
            />
          </Card>

          <Card title="Показывать людям">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[14px] text-ink2">
                {draft.active === 1 ? 'Бот предлагает эту практику.' : 'Практика выключена, бот её не предлагает.'}
              </p>
              <Button
                onClick={() => {
                  const next = (draft.active === 1 ? 0 : 1) as 0 | 1
                  setDraft({ ...draft, active: next })
                  void save({ active: next })
                }}
              >
                {draft.active === 1 ? 'Выключить' : 'Включить'}
              </Button>
            </div>
          </Card>
        </div>

        <div className="md:sticky md:top-6 md:self-start">
          <Card
            title="Как это увидит человек"
            action={
              <Segmented
                value={kind}
                onChange={setKind}
                options={[
                  { value: 'evening', label: 'Вечерняя' },
                  { value: 'now', label: 'Сейчас' },
                ]}
              />
            }
          >
            <TelegramPreview
              title={draft.title}
              line1={draft.line1}
              line2={draft.line2}
              durationSec={draft.duration_sec}
              caption={caption}
              sleepHint={sleepHint}
              kind={kind}
            />
          </Card>
        </div>
      </div>
    </>
  )
}
