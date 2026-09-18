/**
 * «Как это увидит человек» — имитация экрана Telegram.
 *
 * Один компонент на две страницы: практики и тексты. Смысл не в украшении, а в
 * проверке: подпись под аудио, две строки и кнопка «Готово» вместе занимают у
 * человека полтора экрана телефона, и понять это по полю ввода невозможно.
 */

import { fmtDuration } from '../lib/format.ts'

export function TelegramBubble({ text, note }: { text: string; note?: string }) {
  return (
    <div className="max-w-[92%] rounded-[16px] rounded-bl-[6px] border border-line bg-raised px-3.5 py-2.5">
      <p className="whitespace-pre-wrap text-[14px] leading-[1.45] text-ink">{text}</p>
      {note && <p className="mt-1 text-[11px] text-ink3">{note}</p>}
    </div>
  )
}

export function TelegramPreview({
  title, line1, line2, durationSec, caption, sleepHint, kind,
}: {
  title: string
  line1: string
  line2: string
  durationSec: number | null
  caption: string
  sleepHint?: string
  kind: 'evening' | 'now'
}) {
  const performer = kind === 'evening' ? 'Семь ночей · Вечер 3' : 'Семь ночей'
  const body = [caption.replace('{line1}', line1).replace('{line2}', line2), sleepHint]
    .filter((s) => s && s !== '')
    .join('\n\n')

  return (
    <div className="rounded-[16px] border border-line bg-page p-3">
      <div className="mb-2 text-[12px] text-ink3">Так это выглядит в Telegram</div>
      <div className="flex flex-col gap-2">
        <div className="max-w-[92%] rounded-[16px] rounded-bl-[6px] border border-line bg-raised p-3">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent/20 text-[18px]">
              ♪
            </div>
            <div className="min-w-0">
              <div className="truncate text-[14px] font-medium text-ink">{title || 'Без названия'}</div>
              <div className="truncate text-[12px] text-ink3">
                {performer} · {fmtDuration(durationSec)}
              </div>
            </div>
          </div>
          <p className="mt-2.5 whitespace-pre-wrap text-[14px] leading-[1.45] text-ink">{body}</p>
          <div className="mt-2.5 rounded-[10px] border border-line py-2 text-center text-[13px] text-ink2">
            Готово
          </div>
        </div>
      </div>
    </div>
  )
}
