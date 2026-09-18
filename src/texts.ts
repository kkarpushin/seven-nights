/**
 * Реестр текстов. §5.8 архитектуры, Приложение А design-bot.
 *
 * Единственное правило, ради которого этот файл существует: в коде бота нет ни
 * одной строки, которую увидит человек, — только ключи. Владелец правит слова в
 * админке, и правка действует сразу, без перезапуска (reload()).
 *
 * Значения держим в памяти картой и перечитываем по reload(), а не ходим в базу на
 * каждое сообщение: за вечер бот рендерит десяток текстов, а правка происходит раз
 * в неделю. Обратная сторона — про reload() обязан помнить admin-api после PUT.
 *
 * DEFAULT_TEXTS живёт в src/db/defaultTexts.ts (его читает и засев, и рантайм) и
 * реэкспортируется отсюда: контракт §5.8 «DEFAULT_TEXTS из src/texts.ts» сохраняется.
 */

import type { ButtonId, Texts } from './ctx.ts'
import type { Logger } from './log.ts'
import type { TextsRepo } from './db/texts.ts'
import { DEFAULT_TEXTS } from './db/defaultTexts.ts'
import { divisionWord, questionWord } from './plural.ts'

export { DEFAULT_TEXTS } from './db/defaultTexts.ts'
export { quizIndex, quizResultKey, SECTION_TITLES, TEXT_SECTIONS } from './db/defaultTexts.ts'

/** Полоска замера: «▰▰▰▰▱▱▱▱▱▱» для 4. §2.2 design-bot. */
export function bar(value: number): string {
  const v = Math.max(0, Math.min(10, Math.round(value)))
  return '▰'.repeat(v) + '▱'.repeat(10 - v)
}

/** Полоска пути: «●●●○○○○» для трёх пройденных вечеров. */
export function dots(done: number): string {
  const n = Math.max(0, Math.min(7, Math.round(done)))
  return '●'.repeat(n) + '○'.repeat(7 - n)
}

/** Подпись кнопки ↔ ключ текста. Только reply-кнопки: нажатие приходит текстом. */
export const BUTTON_KEYS: Record<ButtonId, string> = {
  practice_now: 'btn.practice_now',
  not_today: 'btn.not_today',
  better_at: 'btn.better_at',
  pause: 'btn.pause',
  remind_tomorrow: 'btn.remind_tomorrow',
  resume: 'btn.resume',
  restart: 'btn.restart',
  other_hour: 'btn.other_hour',
  other_clock: 'btn.other_clock',
}

export const BUTTON_IDS = Object.keys(BUTTON_KEYS) as ButtonId[]

const PLACEHOLDER_RE = /\{[^{}\s]{1,40}\}/g

/** Список плейсхолдеров, встречающихся в тексте: и для валидации, и для рендера. */
export function placeholdersIn(text: string): string[] {
  return [...new Set(text.match(PLACEHOLDER_RE) ?? [])]
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Регулярка для сопоставления нажатой кнопки с её подписью.
 * Плейсхолдер превращается в «.+»: подпись «Лучше в {time}» приходит от человека
 * уже подставленной («Лучше в 21:00»), и сравнивать шаблон со строкой напрямую нельзя.
 */
function labelMatcher(template: string): RegExp {
  const parts = template.split(PLACEHOLDER_RE).map(escapeRe)
  return new RegExp(`^${parts.join('.+')}$`, 'i')
}

export type CreateTextsOptions = {
  /** Куда жаловаться на неизвестный плейсхолдер. Без логгера жалобы теряются. */
  log?: Logger
}

/**
 * Реализация Texts поверх репозитория. Значения по умолчанию из DEFAULT_TEXTS —
 * подстраховка на случай, если ключа нет в базе (база засеяна старой версией,
 * а код уже новый): лучше отправить формулировку из кода, чем «{ev.close}».
 */
export function createTexts(repo: TextsRepo, opts: CreateTextsOptions = {}): Texts {
  const fallback = new Map(DEFAULT_TEXTS.map((t) => [t.key, t.value]))
  const allowed = new Map(DEFAULT_TEXTS.map((t) => [t.key, t.placeholders]))
  let values = repo.map()

  const get = (key: string): string => values.get(key) ?? fallback.get(key) ?? `«${key}»`

  function render(key: string, vars: Record<string, string | number> = {}): string {
    const template = get(key)
    return fill(template, vars, key, opts.log)
  }

  const texts: Texts = {
    get,
    render,

    buttonId(label) {
      const raw = label.trim()
      if (raw === '') return null
      for (const id of BUTTON_IDS) {
        const template = get(BUTTON_KEYS[id]).trim()
        if (template === '') continue
        if (labelMatcher(template).test(raw)) return id
      }
      return null
    },

    label: (id, vars) => render(BUTTON_KEYS[id], vars),

    reload() {
      values = repo.map()
    },

    validate(key, value) {
      if (value.trim() === '') return { ok: false, error: 'Пустой текст сохранить нельзя.' }
      const whitelist = allowed.get(key) ?? repoPlaceholders(repo, key)
      const unknown = placeholdersIn(value).filter((p) => !whitelist.includes(p) && !SERVICE_PLACEHOLDERS.has(p))
      if (unknown.length > 0) {
        return { ok: false, error: `Неизвестные плейсхолдеры: ${unknown.join(', ')}`, unknown }
      }
      return { ok: true }
    },
  }

  return texts
}

/** Плейсхолдеры, которые бот подставляет сам, — они разрешены всегда. */
const SERVICE_PLACEHOLDERS = new Set(['{деление}', '{вопрос}'])

function repoPlaceholders(repo: TextsRepo, key: string): string[] {
  const row = repo.row(key)
  if (!row) return []
  try {
    const parsed = JSON.parse(row.placeholders)
    return Array.isArray(parsed) ? (parsed as string[]) : []
  } catch {
    return []
  }
}

/**
 * Подстановка значений в шаблон.
 *
 * Неизвестный плейсхолдер НЕ роняет отправку: человеку уйдёт текст с «{foo}», а в
 * лог — предупреждение. Падать здесь нельзя, иначе одна опечатка владельца в
 * админке останавливает вечер у всех, кто в этот момент ждёт практику. Настоящая
 * защита стоит на входе — Texts.validate().
 */
export function fill(
  template: string,
  vars: Record<string, string | number>,
  key = '',
  log?: Logger,
): string {
  // Служебные склонения считает бот: в тексте админки стоит {деление}, а три формы
  // в голове владельца держать не нужно (Приложение А design-bot).
  const withService: Record<string, string | number> = { ...vars }
  if (template.includes('{деление}') && vars.d !== undefined) {
    withService['деление'] = divisionWord(Number(vars.d))
  }
  if (template.includes('{вопрос}') && vars.k !== undefined) {
    withService['вопрос'] = questionWord(Number(vars.k))
  }

  const unknown: string[] = []
  const out = template.replace(PLACEHOLDER_RE, (match) => {
    const name = match.slice(1, -1)
    const value = withService[name]
    if (value === undefined) {
      unknown.push(match)
      return match
    }
    return String(value)
  })

  if (unknown.length > 0) {
    log?.warn('текст отправлен с неподставленным плейсхолдером', { key, unknown })
  }
  return out
}
