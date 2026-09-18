import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

// Админка живёт по /admin/ на том же процессе, что бот, поэтому base фиксированный:
// с ним собранные пути к скриптам и шрифтам совпадают с тем, как сервер их отдаёт.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/admin/',
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 900 },
  server: {
    port: 3710,
    // В режиме разработки данные берём у настоящего процесса на 3700.
    proxy: {
      '/api': 'http://127.0.0.1:3700',
      '/media': 'http://127.0.0.1:3700',
    },
  },
})
