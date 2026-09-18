/**
 * Тест теста «Индекс внутренней опоры».
 *
 * Сверяет ДВЕ вещи, каждая из которых тихо ломает продукт:
 *  1. Тексты на лендинге совпадают со спецификацией символ в символ. Спецификацию
 *     писал не разработчик, менять её формулировки нельзя.
 *  2. Границы результата и индекс считаются по сумме, а не по округлённому индексу.
 *
 * quiz.js — браузерный IIFE, поэтому исполняем его с минимальными заглушками
 * document/window: нам нужен только чистый window.SevenNightsQuiz.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const SPEC = readFileSync(join(ROOT, 'docs', 'quiz-spec.md'), 'utf8')
const QUIZ_JS = readFileSync(join(ROOT, 'web', 'landing', 'quiz.js'), 'utf8')

/** Заглушки ровно на то, что модуль трогает при загрузке. */
function loadQuiz() {
  const noop = () => {}
  const el = (): any =>
    new Proxy(
      {
        style: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
        appendChild: noop, setAttribute: noop, addEventListener: noop, querySelector: () => null,
        querySelectorAll: () => [], children: [], dataset: {},
      },
      { get: (t: any, k) => (k in t ? t[k] : k === 'nodeType' ? 1 : noop) },
    )
  const sandbox: any = {
    document: {
      readyState: 'loading', addEventListener: noop, createElement: el,
      querySelector: () => null, querySelectorAll: () => [], documentElement: el(), body: el(),
    },
    navigator: { vibrate: noop },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    matchMedia: () => ({ matches: false, addEventListener: noop, addListener: noop }),
    setTimeout, clearTimeout, requestAnimationFrame: noop, IntersectionObserver: class { observe() {} },
    console,
  }
  sandbox.window = sandbox
  sandbox.globalThis = sandbox
  runInNewContext(QUIZ_JS, sandbox)
  return sandbox.window.SevenNightsQuiz
}

const quiz = loadQuiz()

/** Пробелы и неразрывные пробелы не считаем различием, всё остальное — считаем. */
const norm = (s: string) => s.normalize('NFC').replace(/ /g, ' ').replace(/\s+/g, ' ').trim()

describe('тексты совпадают со спецификацией', () => {
  const questions = [...SPEC.matchAll(/^\d\.\s+\*\*(.+?)\*\*\n\s+0 = (.+?)\n\s+10 = (.+?)$/gm)]
  const results = [...SPEC.matchAll(/^\*\*ИНДЕКС [^*]+\*\*\n(.+?)$/gm)].map((m) => m[1])

  it('в спецификации ровно семь вопросов и пять результатов', () => {
    expect(questions).toHaveLength(7)
    expect(results).toHaveLength(5)
  })

  it.each(questions.map((m, i) => [i + 1, m[1], m[2], m[3]]))(
    'вопрос %i и обе его подписи есть в quiz.js дословно',
    (_n, text, low, high) => {
      expect(norm(QUIZ_JS)).toContain(norm(text as string))
      expect(norm(QUIZ_JS)).toContain(norm(low as string))
      expect(norm(QUIZ_JS)).toContain(norm(high as string))
    },
  )

  it.each(results.map((t, i) => [i + 1, t]))('текст результата %i есть в quiz.js дословно', (_n, text) => {
    expect(norm(QUIZ_JS)).toContain(norm(text as string))
  })

  it('подсказка и дисклеймер на месте', () => {
    const hint = SPEC.match(/\*\*Подсказка вверху страницы:\*\*\s*(.+?)$/m)![1]
    const disclaimer = SPEC.match(/ОБЯЗАТЕЛЬНО:\*\*\n(.+?)$/m)![1]
    expect(norm(QUIZ_JS)).toContain(norm(hint))
    expect(norm(QUIZ_JS)).toContain(norm(disclaimer))
  })
})

describe('подсчёт', () => {
  it('индекс = сумма ÷ 70 × 100, округлённая', () => {
    expect(quiz.maxSum).toBe(70)
    expect(quiz.total).toBe(7)
    expect(quiz.indexFor(0)).toBe(0)
    expect(quiz.indexFor(42)).toBe(60)
    expect(quiz.indexFor(70)).toBe(100)
    expect(quiz.indexFor(35)).toBe(50)
  })

  // Границы из спецификации: 0–21 / 22–35 / 36–49 / 50–59 / 60–70.
  // Проверяем обе стороны каждой границы — именно там ошибается `<` вместо `<=`.
  const BOUNDS: Array<[number, number]> = [
    [0, 1], [21, 1], [22, 2], [35, 2], [36, 3], [49, 3], [50, 4], [59, 4], [60, 5], [70, 5],
  ]
  const texts = [...SPEC.matchAll(/^\*\*ИНДЕКС [^*]+\*\*\n(.+?)$/gm)].map((m) => m[1])

  it.each(BOUNDS)('сумма %i даёт результат №%i', (sum, n) => {
    expect(norm(quiz.resultTextFor(sum))).toBe(norm(texts[n - 1]))
  })

  it('сумма считается по всем семи ответам', () => {
    expect(quiz.sumOf([0, 0, 0, 0, 0, 0, 0])).toBe(0)
    expect(quiz.sumOf([10, 10, 10, 10, 10, 10, 10])).toBe(70)
    expect(quiz.sumOf([6, 6, 6, 6, 6, 6, 6])).toBe(42)
  })
})

describe('ссылка в бота', () => {
  it('на странице есть deep link с суммой, а не с индексом', () => {
    // ?start=q<сумма>: по сумме бот сам посчитает индекс и всегда попадёт в ту же группу.
    expect(QUIZ_JS).toMatch(/start=q/)
    expect(QUIZ_JS).toContain('https://t.me/ensoma_robot')
  })
})
