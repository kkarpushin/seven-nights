/**
 * SVG → PNG. §7.3 архитектуры.
 *
 * Системные шрифты выключены намеренно: на этой машине «Noto Sans» стоит, на
 * сервере может не стоять, и картинка молча поедет — подписи разъедутся, кегль
 * сменится, а заметим мы это по скриншоту от человека. Поэтому файлы шрифтов
 * передаются явно и абсолютными путями от этого модуля, а не от cwd: бот
 * запускается systemd-юнитом, скрипты — из любого каталога.
 */

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { buildChartSvg, HEIGHT, WIDTH, type ChartOpts } from './svg.ts'
import type { ChartPoint } from './data.ts'

export const FONTS_DIR = resolve(import.meta.dirname, '..', '..', 'assets', 'fonts')

export const FONT_FILES = [
  join(FONTS_DIR, 'NotoSans-Regular.ttf'),
  join(FONTS_DIR, 'NotoSans-Bold.ttf'),
]

export const DEFAULT_FONT_FAMILY = 'Noto Sans'

/** Шрифты есть на диске? Проверяется на старте, чтобы не узнать об этом в седьмой вечер. */
export function fontsReady(): { ok: boolean; missing: string[] } {
  const missing = FONT_FILES.filter((f) => !existsSync(f))
  return { ok: missing.length === 0, missing }
}

export function renderPng(svg: string): Buffer {
  const { ok, missing } = fontsReady()
  if (!ok) throw new Error(`Нет файлов шрифта для картинки: ${missing.join(', ')}`)

  const r = new Resvg(svg, {
    background: '#14110F',
    fitTo: { mode: 'width', value: WIDTH },
    font: {
      loadSystemFonts: false,
      fontFiles: FONT_FILES,
      defaultFontFamily: DEFAULT_FONT_FAMILY,
    },
  })
  return Buffer.from(r.render().asPng())
}

/** Точки → PNG одним вызовом: то, что зовёт финал седьмого вечера и админка. */
export function renderChartPng(points: readonly ChartPoint[], o: ChartOpts): Buffer {
  return renderPng(buildChartSvg(points, o))
}

export { WIDTH, HEIGHT }
