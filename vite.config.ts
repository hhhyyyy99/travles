import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Ticket 09 cutover: the production entries are index.html (the guide) and
// trip.html (redirect stub preserving query + hash for legacy bookmarks).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      input: {
        index: 'index.html',
        trip: 'trip.html',
      },
    },
  },
})