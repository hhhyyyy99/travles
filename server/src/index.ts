import { serve } from '@hono/node-server'
import { createApp } from './app.js'

const port = Number(process.env.SERVER_PORT ?? 4310)

const app = await createApp()

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`@hailar/server listening on http://127.0.0.1:${info.port}`)
})
