/**
 * Плеер и загрузка mp3. §3.4 design-admin.
 *
 * Здесь же — единственное место, где объясняется, что такое номер файла в
 * Telegram. Специалисту не нужно знать это слово, но нужно понимать, почему
 * «загружено» иногда становится «не отправлялось»: иначе статус выглядит как
 * поломка, а не как нормальная жизнь файла.
 */

import { useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../api.ts'
import { fmtBytes, fmtDate, fmtDuration } from '../lib/format.ts'
import type { Practice } from '../types.ts'
import { Button } from './ui.tsx'

export function AudioPlayer({ src, compact }: { src: string; compact?: boolean }) {
  const ref = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [position, setPosition] = useState(0)
  const [length, setLength] = useState(0)

  useEffect(() => {
    setPlaying(false)
    setPosition(0)
  }, [src])

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={() => {
          const el = ref.current
          if (!el) return
          if (el.paused) void el.play()
          else el.pause()
        }}
        className={`flex shrink-0 items-center justify-center rounded-full bg-accent text-on-accent ${
          compact ? 'h-9 w-9 text-[13px]' : 'h-11 w-11 text-[15px]'
        }`}
        aria-label={playing ? 'Пауза' : 'Послушать'}
      >
        {playing ? '❚❚' : '▸'}
      </button>

      <input
        type="range"
        min={0}
        max={Math.max(length, 0.1)}
        step={0.5}
        value={position}
        onChange={(e) => {
          const el = ref.current
          if (el) el.currentTime = Number(e.target.value)
          setPosition(Number(e.target.value))
        }}
        className="h-1 min-w-0 flex-1 accent-[color:var(--color-accent)]"
        aria-label="Перемотка"
      />

      <span className="tnum shrink-0 text-[12px] text-ink3">
        {fmtDuration(Math.round(position))} / {fmtDuration(Math.round(length))}
      </span>

      <audio
        ref={ref}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => setPosition(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setLength(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0)}
      />
    </div>
  )
}

export function TelegramStatus({ practice }: { practice: Practice }) {
  if (!practice.audio_path) {
    return (
      <p className="flex items-center gap-2 text-[13px] text-ink2">
        <span className="h-2 w-2 rounded-full bg-[color:var(--color-st-blocked)]" />
        Нет аудио — бот не сможет отправить эту практику
      </p>
    )
  }
  if (practice.tg_file_id) {
    return (
      <p className="flex items-center gap-2 text-[13px] text-ink2">
        <span className="h-2 w-2 rounded-full bg-[color:var(--color-st-run)]" />
        🎧 Загружено в Telegram — люди получат его мгновенно
      </p>
    )
  }
  return (
    <p className="flex items-center gap-2 text-[13px] text-ink2">
      <span className="h-2 w-2 rounded-full bg-[color:var(--color-st-silent)]" />
      ⚠ Ещё не отправлялось в Telegram — первый человек подождёт пару секунд, дальше будет мгновенно
    </p>
  )
}

export function AudioBlock({
  practice, onUploaded, onSendToMe, canSend,
}: {
  practice: Practice
  onUploaded: (p: Practice) => void
  onSendToMe: () => void
  canSend: boolean
}) {
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Пока файл летит, уходить со страницы нельзя — иначе загрузка оборвётся молча.
  useEffect(() => {
    if (progress === null) return
    const guard = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [progress])

  async function upload(file: File) {
    setError(null)
    setProgress(0)
    try {
      const updated = await api.uploadAudio(practice.id, file, setProgress)
      onUploaded(updated)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Загрузка прервалась. Файл цел, попробуй ещё раз.')
    } finally {
      setProgress(null)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {progress !== null ? (
        <div>
          <div className="h-2 overflow-hidden rounded-full bg-raised">
            <div className="h-full bg-accent transition-all" style={{ width: `${progress}%` }} />
          </div>
          <p className="mt-2 text-[13px] text-ink2">Загружаю… {progress}%. Не закрывай страницу.</p>
        </div>
      ) : practice.audio_path ? (
        <div className="rounded-[12px] border border-line bg-raised/40 p-3">
          <AudioPlayer src={`/media/practices/${practice.slug}.mp3`} />
          <p className="mt-2 text-[12px] text-ink3">
            mp3 · {fmtBytes(practice.audio_bytes)} · {fmtDuration(practice.duration_sec)} · обновлено{' '}
            {fmtDate(practice.updated_at)}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => inputRef.current?.click()}>
              Заменить файл
            </Button>
            <Button size="sm" onClick={onSendToMe} disabled={!canSend}
              title={canSend ? undefined : 'Сначала укажи свой Telegram ID в настройках'}>
              Отправить себе в Telegram
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            const file = e.dataTransfer.files[0]
            if (file) void upload(file)
          }}
          className={`flex h-[120px] w-full flex-col items-center justify-center gap-2 rounded-[12px] border border-dashed text-[14px] ${
            dragging ? 'border-accent text-ink' : 'border-line text-ink2'
          }`}
        >
          <span className="text-[22px]" aria-hidden>♪</span>
          Перетащи mp3 сюда или нажми, чтобы выбрать
        </button>
      )}

      <TelegramStatus practice={practice} />

      {error && <p className="text-[13px] text-[color:var(--color-st-blocked)]">{error}</p>}

      <p className="text-[12px] leading-[1.5] text-ink3">
        Telegram хранит у себя копию файла и выдаёт на неё внутренний номер. Этот номер нельзя ввести или поправить
        руками — он появляется сам, когда бот отправляет файл первый раз. Если аудио нужно изменить, просто загрузи
        новый mp3: старый номер сотрётся, и бот отправит новую запись.
      </p>

      <input
        ref={inputRef}
        type="file"
        accept="audio/mpeg,.mp3"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) void upload(file)
          e.target.value = ''
        }}
      />
    </div>
  )
}
