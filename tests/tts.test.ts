import { describe, expect, it } from 'vitest'
import { buildSsml, honorsSsmlBreaks, parseScript, planRequests } from '../scripts/tts.ts'

const SCRIPT = `Я рядом.
<break time="1.5s" />
Устраивайся так, как тебе удобно.
<break time="2.0s" />
Один выдох — длиннее обычного.
[[pause:5]]
Сегодня — приземление.

Запоминать ничего не нужно.
[[pause:600ms]]
Спи.`

describe('parseScript', () => {
  it('понимает оба синтаксиса пауз и склеивает переносы внутри абзаца', () => {
    const segs = parseScript(SCRIPT)
    expect(segs.filter((s) => s.kind === 'text').map((s) => (s as any).text)).toEqual([
      'Я рядом.',
      'Устраивайся так, как тебе удобно.',
      'Один выдох — длиннее обычного.',
      'Сегодня — приземление.',
      'Запоминать ничего не нужно.',
      'Спи.',
    ])
    const pauses = segs.filter((s) => s.kind === 'pause').map((s) => (s as any).seconds)
    // 1.5s, 2.0s, 5s (маркер), 0.8s (пустая строка между абзацами), 0.6s ([[pause:600ms]] — доли секунды тоже допустимы)
    expect(pauses).toEqual([1.5, 2, 5, 0.8, 0.6])
  })

  it('не оставляет пауз по краям — тишину в начале и конце добавляет постобработка', () => {
    const segs = parseScript('[[pause:3]]\nТекст.\n[[pause:9]]')
    expect(segs).toEqual([{ kind: 'text', text: 'Текст.' }])
  })

  it('схлопывает подряд идущие паузы в самую длинную', () => {
    const segs = parseScript('А.\n[[pause:3]]\n<break time="2.0s" />\nБ.')
    expect(segs).toEqual([
      { kind: 'text', text: 'А.' },
      { kind: 'pause', seconds: 3 },
      { kind: 'text', text: 'Б.' },
    ])
  })
})

describe('honorsSsmlBreaks', () => {
  it('генеративный MAI-Voice-2 теги пауз игнорирует, классические Neural — нет', () => {
    expect(honorsSsmlBreaks('ru-RU-Masha:MAI-Voice-2')).toBe(false)
    expect(honorsSsmlBreaks('ru-RU-Masha:MAI-Voice-2-Flash')).toBe(false)
    expect(honorsSsmlBreaks('ru-RU-SvetlanaNeural')).toBe(true)
    expect(honorsSsmlBreaks('ru-RU-DariyaNeural')).toBe(true)
  })
})

describe('planRequests', () => {
  const segs = parseScript(SCRIPT)

  it('для голоса с поддержкой SSML прячет короткие паузы внутрь запроса', () => {
    const plan = planRequests(segs, 'ru-RU-SvetlanaNeural')
    const speaks = plan.filter((r) => r.kind === 'speak')
    // Режут только паузы ≥ 2.5s: [[pause:5]]. Остальные ушли в теги.
    expect(speaks).toHaveLength(2)
    expect(plan.filter((r) => r.kind === 'silence').map((r: any) => r.seconds)).toEqual([5])
  })

  it('для голоса без поддержки SSML режет по каждой паузе', () => {
    const plan = planRequests(segs, 'ru-RU-Masha:MAI-Voice-2')
    expect(plan.filter((r) => r.kind === 'speak')).toHaveLength(6)
    expect(plan.filter((r) => r.kind === 'silence').map((r: any) => r.seconds)).toEqual([1.5, 2, 5, 0.8, 0.6])
  })

  it('считает только озвучиваемые знаки и не теряет текст', () => {
    for (const voice of ['ru-RU-SvetlanaNeural', 'ru-RU-Masha:MAI-Voice-2']) {
      const plan = planRequests(segs, voice)
      const spoken = plan
        .filter((r) => r.kind === 'speak')
        .flatMap((r: any) => r.parts)
        .filter((p: any) => 'text' in p)
        .map((p: any) => p.text)
        .join('')
      expect(spoken).toContain('Я рядом.')
      expect(spoken).toContain('Спи.')
      const chars = plan.reduce((n, r: any) => (r.kind === 'speak' ? n + r.chars : n), 0)
      expect(chars).toBe(spoken.length)
    }
  })

  it('не оставляет запрос, состоящий из одной паузы', () => {
    const plan = planRequests(parseScript('А.\n<break time="1.0s" />'), 'ru-RU-SvetlanaNeural')
    expect(plan).toHaveLength(1)
    expect(plan[0]).toMatchObject({ kind: 'speak' })
  })
})

describe('buildSsml', () => {
  const v = { voice: 'ru-RU-SvetlanaNeural', rate: '-15%' }

  it('экранирует текст и не экранирует теги пауз', () => {
    const ssml = buildSsml([{ text: 'А & Б' }, { breakSec: 2 }, { text: 'В' }], v)
    expect(ssml).toContain('А &amp; Б')
    expect(ssml).toContain('<break time="2000ms"/>')
    expect(ssml).toContain('<prosody rate="-15%">')
  })

  it('обрезает паузу до пятисекундного потолка Azure', () => {
    expect(buildSsml([{ text: 'А' }, { breakSec: 12 }], v)).toContain('<break time="5000ms"/>')
  })

  it('добавляет стиль, только если он задан', () => {
    expect(buildSsml('текст', { ...v, style: 'caringempathy' })).toContain('<mstts:express-as style="caringempathy">')
    expect(buildSsml('текст', v)).not.toContain('express-as')
  })
})
