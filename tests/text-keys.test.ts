/**
 * Каждый ключ текста, который просит код, должен существовать в засеве.
 *
 * Пропущенный ключ не падает и не логируется — бот просто отправляет человеку
 * пустое сообщение или строку вида «ev.close». Такое находят на живых людях,
 * поэтому проверяем механически: сканируем исходники на обращения к текстам
 * и сверяем с DEFAULT_TEXTS.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_TEXTS } from '../src/db/defaultTexts.ts'

const ROOT = join(import.meta.dirname, '..')
const SRC = join(ROOT, 'src')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (/\.tsx?$/.test(p)) out.push(p)
  }
  return out
}

const files = walk(SRC).filter((f) => !f.includes('/demo/') && !f.endsWith('defaultTexts.ts'))
const defined = new Set(DEFAULT_TEXTS.map((t: { key: string }) => t.key))

/**
 * Обращения вида t('ev.close'), texts.get('onb.welcome'), render('num.range', …).
 * Ключи собираются по форме «слово.слово», чтобы не ловить произвольные строки.
 */
const KEY_CALL = /\b(?:t|tr|text|texts|getText|render|reply|say)\w*\(\s*['"`]([a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*)['"`]/gi

const used = new Map<string, Set<string>>()
for (const file of files) {
  const src = readFileSync(file, 'utf8')
  for (const m of src.matchAll(KEY_CALL)) {
    const key = m[1]
    if (!used.has(key)) used.set(key, new Set())
    used.get(key)!.add(file.slice(ROOT.length + 1))
  }
}

describe('ключи текстов', () => {
  it('в засеве есть хоть что-то (иначе тест бессмысленно зелёный)', () => {
    expect(defined.size).toBeGreaterThan(50)
  })

  it('каждый ключ, который запрашивает код, засеян', () => {
    const missing = [...used.entries()]
      .filter(([key]) => !defined.has(key))
      .map(([key, where]) => `${key} — ${[...where].join(', ')}`)
    expect(missing, `Нет в DEFAULT_TEXTS:\n  ${missing.join('\n  ')}`).toEqual([])
  })

  it('ключи уникальны', () => {
    const seen = new Set<string>()
    const dupes: string[] = []
    for (const t of DEFAULT_TEXTS as { key: string }[]) {
      if (seen.has(t.key)) dupes.push(t.key)
      seen.add(t.key)
    }
    expect(dupes).toEqual([])
  })

  it('у каждого текста непустое значение', () => {
    const empty = (DEFAULT_TEXTS as { key: string; value: string }[])
      .filter((t) => !t.value || !t.value.trim())
      .map((t) => t.key)
    expect(empty).toEqual([])
  })

  it('плейсхолдеры в значении объявлены в поле placeholders', () => {
    const problems: string[] = []
    for (const t of DEFAULT_TEXTS as { key: string; value: string; placeholders: string[] }[]) {
      const inValue = [...t.value.matchAll(/\{(\w+)\}/g)].map((m) => m[1])
      for (const p of inValue) {
        if (!t.placeholders.includes(p)) problems.push(`${t.key}: {${p}} не объявлен`)
      }
    }
    expect(problems).toEqual([])
  })
})
