import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Mockup dev config (2026-09-11): the SPA from source, the API from the dev instance on
 * 8421. Start it with the root's vite binary - `web/node_modules/.bin/vite` (7.3.6) fails
 * every transform against @vitejs/plugin-react 5.2.0 ("Missing field moduleType"):
 *
 *   cd web && ../node_modules/.bin/vite --config vite.mock.config.ts
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5199,
    strictPort: true,
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8421',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => proxyReq.setHeader('accept-encoding', 'identity'))
        },
      },
    },
  },
})
