import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Tickets 01–08: the new app is served from the temporary app.html entry.
// Ticket 09 switches the build input to index.html + trip.html.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      input: 'app.html',
    },
  },
})
