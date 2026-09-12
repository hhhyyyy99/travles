import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Ticket 01 workspace split: the backend lives in the `server` workspace
// member and listens on SERVER_PORT (default 4310). Dev requests to /api are
// proxied there; production deployment is expected to be same-origin.
const serverPort = process.env.SERVER_PORT ?? '4310'

// Ticket 09 cutover: the production entries are index.html (the guide) and
// trip.html (redirect stub preserving query + hash for legacy bookmarks).
export default defineConfig({
  cacheDir: process.env.APP_TEST_VITE_CACHE_DIR,
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': `http://127.0.0.1:${serverPort}`,
    },
  },
  build: {
    rollupOptions: {
      input: {
        index: 'index.html',
        trip: 'trip.html',
      },
    },
  },
})
