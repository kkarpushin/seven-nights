/**
 * Единственный HTTP-сервер процесса. §10.3 архитектуры.
 *
 * Отдаёт четыре разные вещи с одного порта: лендинг, SPA админки, API и аудио для
 * плеера. Статику раздаём своим кодом, а не middleware, по одной причине: готовые
 * обработчики ищут файлы относительно текущей рабочей директории, а процесс
 * запускается и из systemd, и из тестов, и из vitest. Здесь все пути абсолютные и
 * считаются от корня репозитория — тогда «работает у меня» значит «работает везде».
 *
 * Слушаем BIND_HOST:PORT (tailnet), наружу порт не выставлен.
 */

import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import type { Ctx } from '../ctx.ts'
import { createAdminApi } from '../admin-api/index.ts'
import { requireAuth } from '../admin-api/auth.ts'
import { PROJECT_ROOT } from '../env.ts'

export const LANDING_DIR = join(PROJECT_ROOT, 'web', 'landing')
export const ADMIN_DIST_DIR = join(PROJECT_ROOT, 'web', 'admin', 'dist')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

/**
 * Безопасная склейка: путь из запроса не имеет права вывести за пределы корня.
 * Проверяем не строку запроса (её можно закодировать по-разному), а уже
 * разрешённый абсолютный путь.
 */
export function safeJoin(root: string, relative: string): string | null {
  const decoded = (() => {
    try {
      return decodeURIComponent(relative)
    } catch {
      return relative
    }
  })()
  // Путь не «чистим», а отвергаем: молча превратив ../../etc/passwd в
  // <корень>/etc/passwd, мы бы отдали 404 и никогда не узнали, что кто-то пробовал.
  const full = resolve(root, '.' + sep + normalize(decoded))
  const rootResolved = resolve(root)
  return full === rootResolved || full.startsWith(rootResolved + sep) ? full : null
}

/** Отдача файла с поддержкой Range: без неё в плеере нельзя перемотать практику. */
export function fileResponse(path: string, rangeHeader: string | undefined): Response {
  const stat = statSync(path)
  const type = MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
  const headers: Record<string, string> = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Last-Modified': new Date(stat.mtimeMs).toUTCString(),
  }

  const m = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null
  if (m && stat.size > 0) {
    const start = m[1] === '' ? Math.max(0, stat.size - Number(m[2])) : Number(m[1])
    const end = m[2] === '' || m[1] === '' ? stat.size - 1 : Math.min(Number(m[2]), stat.size - 1)
    if (Number.isFinite(start) && start <= end && start < stat.size) {
      const stream = Readable.toWeb(createReadStream(path, { start, end })) as unknown as ReadableStream
      return new Response(stream, {
        status: 206,
        headers: {
          ...headers,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Content-Length': String(end - start + 1),
        },
      })
    }
  }

  const stream = Readable.toWeb(createReadStream(path)) as unknown as ReadableStream
  return new Response(stream, { status: 200, headers: { ...headers, 'Content-Length': String(stat.size) } })
}

function tryFile(root: string, relative: string, rangeHeader?: string): Response | null {
  const path = safeJoin(root, relative)
  if (!path || !existsSync(path)) return null
  const stat = statSync(path)
  if (stat.isDirectory()) return tryFile(root, join(relative, 'index.html'), rangeHeader)
  return fileResponse(path, rangeHeader)
}

export type ServerHooks = {
  /** Когда планировщик в последний раз отработал тик — для /healthz (ставит src/index.ts). */
  lastTickAt?: () => number | null
}

export function createApp(ctx: Ctx, hooks: ServerHooks = {}): Hono {
  const app = new Hono()
  const startedAt = ctx.clock.now()

  // ─────────────────────────────── /healthz ───────────────────────────────
  // Без авторизации: это для монитора, и здесь нет ничего, кроме счётчиков.
  app.get('/healthz', (c) => {
    const due = ctx.db
      .prepare('SELECT COUNT(*) AS n FROM users WHERE due_at IS NOT NULL AND due_at <= ?')
      .get(ctx.clock.now()) as { n: number }
    c.header('Cache-Control', 'no-store')
    return c.json({
      ok: true,
      uptimeSec: ctx.clock.now() - startedAt,
      users: ctx.repo.users.countAll(true),
      dueBacklog: due.n,
      lastTickAt: hooks.lastTickAt?.() ?? null,
      botUsername: ctx.cfg.botUsername,
    })
  })

  app.route('/api/admin', createAdminApi(ctx))

  // ─────────────────────────────── аудио ───────────────────────────────
  // Плеер админки — за куками: записи практик не должны утекать по прямой ссылке.
  app.use('/media/*', requireAuth(ctx))
  app.get('/media/practices/:file', (c) => {
    const res = tryFile(join(ctx.cfg.contentDir, 'audio'), c.req.param('file'), c.req.header('range'))
    return res ?? c.json({ error: 'not_found', message: 'Файла нет на диске.' }, 404)
  })

  // ─────────────────────────────── админка ───────────────────────────────
  app.get('/admin', (c) => c.redirect('/admin/'))
  app.get('/admin/*', (c) => {
    const rel = c.req.path.slice('/admin/'.length)
    const direct = rel === '' ? null : tryFile(ADMIN_DIST_DIR, rel)
    if (direct) return direct
    // SPA-фолбэк: любой неизвестный путь внутри /admin — это маршрут роутера.
    const index = tryFile(ADMIN_DIST_DIR, 'index.html')
    if (index) return index
    return c.text('Админка ещё не собрана. Выполните: npm run build:admin', 503, {
      'Content-Type': 'text/plain; charset=utf-8',
    })
  })

  // ─────────────────────────────── лендинг ───────────────────────────────
  app.get('/*', (c) => {
    const rel = c.req.path === '/' ? 'index.html' : c.req.path.slice(1)
    const res = tryFile(LANDING_DIR, rel)
    if (res) return res
    return c.text('Страница не найдена', 404, { 'Content-Type': 'text/plain; charset=utf-8' })
  })

  return app
}

export type HttpServer = { close(): Promise<void> }

export function startHttp(ctx: Ctx, hooks: ServerHooks = {}): HttpServer {
  const app = createApp(ctx, hooks)
  const server = serve({ fetch: app.fetch, port: ctx.cfg.port, hostname: ctx.cfg.bindHost })
  ctx.log.info('http listening', { host: ctx.cfg.bindHost, port: ctx.cfg.port })
  return {
    close: () =>
      new Promise<void>((done) => {
        server.close(() => done())
      }),
  }
}
