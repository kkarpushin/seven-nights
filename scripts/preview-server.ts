/**
 * Превью-сервер: отдаёт лендинг и образцы голосов по tailnet, пока проект собирается.
 *
 *   npx tsx scripts/preview-server.ts          # 100.91.124.2:3701
 *
 * Это временная витрина для владельца, а НЕ боевой сервер бота — тот будет на 3700
 * и поднимется из src/. Здесь нет ни базы, ни админки, ни зависимостей.
 *
 *   /            — лендинг «Семь ночей» (web/landing)
 *   /samples/    — страница сравнения голосов (content/audio/samples)
 *   /audio/      — сгенерированные практики (content/audio)
 */

import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const PORT = Number(process.env.PREVIEW_PORT || 3701)
const HOST = process.env.PREVIEW_HOST || '0.0.0.0'

const MOUNTS: Array<[string, string]> = [
  ['/samples', join(ROOT, 'content', 'audio', 'samples')],
  ['/audio', join(ROOT, 'content', 'audio')],
  ['/', join(ROOT, 'web', 'landing')],
]

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
}

createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0])

  for (const [prefix, dir] of MOUNTS) {
    if (prefix !== '/' && !urlPath.startsWith(prefix)) continue
    let rel = prefix === '/' ? urlPath : urlPath.slice(prefix.length) || '/'
    if (rel.endsWith('/')) rel += 'index.html'
    // normalize + проверка префикса: не пускаем ../ за пределы смонтированной папки
    const file = normalize(join(dir, rel))
    if (!file.startsWith(dir)) break
    if (existsSync(file) && statSync(file).isFile()) {
      res.writeHead(200, {
        'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      })
      createReadStream(file).pipe(res)
      return
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('Нет такой страницы. Есть / (лендинг) и /samples/ (голоса).')
}).listen(PORT, HOST, () => {
  console.log(`превью: http://100.91.124.2:${PORT}/  ·  голоса: http://100.91.124.2:${PORT}/samples/`)
})
