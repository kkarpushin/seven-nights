/**
 * Пересобирает docs/before-launch.md — список того, что нужно заполнить перед запуском.
 *
 *   npx tsx scripts/list-placeholders.ts
 *
 * Список собирается из самих файлов лендинга, а не пишется руками: список, набранный
 * вручную, устаревает на первой же правке вёрстки, и заглушка уезжает в публикацию.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const LANDING = join(ROOT, 'web', 'landing')
const OUT = join(ROOT, 'docs', 'before-launch.md')

const found = new Map<string, Set<string>>()
for (const file of readdirSync(LANDING).filter((f) => /\.(html|js|css)$/.test(f))) {
  const text = readFileSync(join(LANDING, file), 'utf8')
  for (const m of text.matchAll(/\[\[([^\]\n]{1,120})\]\]/g)) {
    const key = m[1].trim()
    if (!found.has(key)) found.set(key, new Set())
    found.get(key)!.add(file)
  }
}

const rows = [...found.entries()]
  .sort(([a], [b]) => a.localeCompare(b, 'ru'))
  .map(([text, files]) => `| ${text} | ${[...files].sort().join(', ')} |`)

const doc = `# Что заполнить перед запуском

Список собран автоматически из \`web/landing/\` — пересобрать: \`npx tsx scripts/list-placeholders.ts\`.
Пока эти места стоят заглушками, страницу показывать можно, публиковать — нет.

## Лендинг

| Что заменить | Где встречается |
|---|---|
${rows.join('\n')}

Отдельно: заглушки про оплату (\`[[X ₽]]\`, \`[[Продамус]]\`, \`[[ссылка на оплату]]\`) лежат
в закомментированном блоке — оплату из задачи выпилили, блок оставлен на будущее.
Если оплаты не будет, блок надо удалить, а не заполнять.

## Бот

| Что | Как |
|---|---|
| Ссылка на разговор (тридцать минут) | Настройки админки → \`talk_url\`. Пока её нет, приглашение приходит текстом без кнопки. |
| Ссылка на телеграм-канал | Настройки админки → \`channel_url\`. |
| Telegram ID для уведомлений владельцу | Написать боту \`/whoami\`, полученный номер вписать в настройки. |
| Пароль админки | \`ADMIN_PASSWORD\` в \`.env\`. |

## Практики

Девять сценариев и озвучка — заглушки для показа. Специалист заменяет их своим голосом
через админку: категория, название, две строки подписи, mp3. Сценарии лежат
в \`content/practices/\` и правятся как обычные markdown-файлы.

## Чего делать НЕ надо

Менять тексты теста «Индекс внутренней опоры» — вопросы, подписи ползунков и пять
результатов заданы автором и проверяются посимвольно (\`tests/quiz.test.ts\`).
Если формулировки всё-таки меняются, править нужно \`docs/quiz-spec.md\`, а не код.
`

writeFileSync(OUT, doc)
console.log(`${OUT}: ${found.size} плейсхолдеров`)
