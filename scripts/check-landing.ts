/**
 * Сквозная проверка лендинга в настоящем браузере.
 *
 *   npx tsx scripts/check-landing.ts [url]
 *
 * Юнит-тесты сверяют тексты и формулу, но не отвечают на вопрос «а пройти-то можно?».
 * Здесь запускается headless Chrome, скрипт реально проходит тест из семи ползунков
 * несколькими наборами ответов и проверяет, что показано: индекс, сумма, нужный из
 * пяти текстов, обязательный дисклеймер и ссылка в бота с правильной суммой.
 *
 * Отдельно ловится то, что не видно в коде: ошибки в консоли страницы и заголовок,
 * оставшийся с плейсхолдером.
 */

import { execFile, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const URL_ = process.argv[2] || 'http://127.0.0.1:3701/'
const CHROME = process.env.CHROME_BIN || 'google-chrome'
const PORT = Number(process.env.CDP_PORT || 9333)

type Case = { name: string; answers: number[]; expectSum: number; expectIndex: number; expectResultStarts: string }

/** Границы из docs/quiz-spec.md: 0–21 / 22–35 / 36–49 / 50–59 / 60–70. */
const CASES: Case[] = [
  { name: 'все нули', answers: [0, 0, 0, 0, 0, 0, 0], expectSum: 0, expectIndex: 0, expectResultStarts: 'Сейчас значительная часть' },
  { name: 'верх первой группы', answers: [3, 3, 3, 3, 3, 3, 3], expectSum: 21, expectIndex: 30, expectResultStarts: 'Сейчас значительная часть' },
  { name: 'низ второй группы', answers: [4, 3, 3, 3, 3, 3, 3], expectSum: 22, expectIndex: 31, expectResultStarts: 'Опора уже есть' },
  { name: 'середина', answers: [6, 6, 6, 6, 6, 6, 6], expectSum: 42, expectIndex: 60, expectResultStarts: 'Во многих ситуациях' },
  { name: 'низ четвёртой группы', answers: [8, 7, 7, 7, 7, 7, 7], expectSum: 50, expectIndex: 71, expectResultStarts: 'Внутренняя опора достаточно' },
  { name: 'все десятки', answers: [10, 10, 10, 10, 10, 10, 10], expectSum: 70, expectIndex: 100, expectResultStarts: 'Сейчас ты ощущаешь высокую' },
]

async function cdp(): Promise<{ send: (method: string, params?: unknown) => Promise<any>; close: () => void; logs: string[] }> {
  const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json() as Promise<any[]>)
  const page = list.find((t) => t.type === 'page')
  if (!page) throw new Error('не нашёл вкладку в Chrome')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  const pending = new Map<number, { ok: (v: any) => void; err: (e: Error) => void }>()
  const logs: string[] = []
  let id = 0
  await new Promise<void>((ok, err) => {
    ws.onopen = () => ok()
    ws.onerror = () => err(new Error('не удалось подключиться к Chrome по CDP'))
  })
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data))
    if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
      logs.push(`${msg.params.type}: ${msg.params.args.map((a: any) => a.value ?? a.description ?? '').join(' ')}`)
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      logs.push(`exception: ${msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text}`)
    }
    const p = msg.id !== undefined && pending.get(msg.id)
    if (p) {
      pending.delete(msg.id)
      msg.error ? p.err(new Error(msg.error.message)) : p.ok(msg.result)
    }
  }
  const send = (method: string, params: unknown = {}) =>
    new Promise<any>((ok, err) => {
      const n = ++id
      pending.set(n, { ok, err })
      ws.send(JSON.stringify({ id: n, method, params }))
    })
  await send('Runtime.enable')
  return { send, close: () => ws.close(), logs }
}

async function evaluate(send: (m: string, p?: unknown) => Promise<any>, expression: string): Promise<any> {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(`ошибка в странице: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`)
  return r.result.value
}

/**
 * Проходит тест, отвечая заданными цифрами.
 *
 * Ползунок — нативный input[type=range], поэтому значение ставим через нативный
 * сеттер и шлём те же события, что и живой палец: так срабатывает вся логика
 * страницы, а не только наша подмена значения.
 */
const RUN = (answers: number[]) => `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  try { localStorage.removeItem('seven-nights-quiz'); } catch (e) {}
  const quiz = document.querySelector('#quiz');
  const clickText = (re) => {
    const el = [...quiz.querySelectorAll('button, a')].find(b => re.test((b.textContent || '').trim()));
    if (el) { el.click(); return true; }
    return false;
  };
  // состояние «приглашение» → начать
  clickText(/^(Начать|Пройти тест)/i);
  await sleep(350);
  const answers = ${JSON.stringify(answers)};
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  for (let i = 0; i < answers.length; i++) {
    const input = quiz.querySelector('input[type=range]');
    if (!input) return { error: 'нет ползунка на шаге ' + (i + 1) };
    setter.call(input, String(answers[i]));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    await sleep(700);
    // если автопереход не сработал (последний шаг или отключён) — жмём кнопку
    if (quiz.querySelector('input[type=range]') === input) {
      clickText(/^(Дальше|Показать результат)/i);
      await sleep(700);
    }
  }
  await sleep(1200);
  const text = quiz.innerText || '';
  const link = [...quiz.querySelectorAll('a')].map(a => a.getAttribute('href')).find(h => h && h.includes('t.me'));
  const allLinks = [...document.querySelectorAll('a[href*="t.me"]')].map(a => a.getAttribute('href'));
  return { text, link, allLinks };
})()`

async function main() {
  const profile = mkdtempSync(join(tmpdir(), 'sn-chrome-'))
  let chrome: ChildProcess | null = null
  let failures = 0
  try {
    chrome = execFile(CHROME, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=390,844',
      URL_,
    ])
    // ждём, пока Chrome поднимет отладочный порт
    for (let i = 0; i < 40; i++) {
      try { await fetch(`http://127.0.0.1:${PORT}/json/version`); break } catch { await new Promise((r) => setTimeout(r, 250)) }
    }

    const { send, close, logs } = await cdp()
    await evaluate(send, '1')

    // Заголовок и плейсхолдеры — видны сразу, проверяем до прохождения теста.
    const page = await evaluate(send, 'document.body.innerText')
    const leftovers = [...String(page).matchAll(/\[\[[^\]]{0,60}\]\]/g)].map((m) => m[0])
    if (leftovers.length) {
      console.log(`⚠ на странице видны незаменённые плейсхолдеры (${leftovers.length}): ${[...new Set(leftovers)].slice(0, 6).join(' ')}`)
      console.log('  это нормально до передачи специалисту, но перед публикацией их надо заменить')
    }

    for (const c of CASES) {
      const res = await evaluate(send, RUN(c.answers))
      if (res?.error) { console.log(`✗ ${c.name}: ${res.error}`); failures++; continue }
      const text: string = res.text || ''
      const okIndex = new RegExp(`(^|\\D)${c.expectIndex}(\\D|$)`).test(text)
      const okSum = text.includes(`${c.expectSum} из 70`)
      const okResult = text.includes(c.expectResultStarts)
      const okDisc = text.includes('Это не диагноз и не оценка твоей личности')
      const okLink = typeof res.link === 'string' && res.link.includes(`start=q${c.expectSum}`)
      const bad = [
        !okIndex && `индекс ${c.expectIndex}`,
        !okSum && `«сумма ответов: ${c.expectSum} из 70»`,
        !okResult && `текст результата «${c.expectResultStarts}…»`,
        !okDisc && 'дисклеймер',
        !okLink && `ссылка ?start=q${c.expectSum} (получено: ${res.link})`,
      ].filter(Boolean)
      if (bad.length) { console.log(`✗ ${c.name}: не найдено — ${bad.join('; ')}`); failures++ }
      else console.log(`✓ ${c.name}: сумма ${c.expectSum}, индекс ${c.expectIndex}, текст и ссылка на месте`)
    }

    const real = logs.filter((l) => !/favicon|preload|Deprecation/i.test(l))
    console.log(real.length ? `\n⚠ сообщения консоли:\n  ${real.join('\n  ')}` : '\nОшибок в консоли нет.')
    close()
  } finally {
    if (chrome?.pid) process.kill(chrome.pid)   // только свой процесс, по сохранённому pid
    rmSync(profile, { recursive: true, force: true })
  }
  console.log(failures ? `\nПровалено проверок: ${failures}` : '\nВсе проверки пройдены.')
  process.exit(failures ? 1 : 0)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
