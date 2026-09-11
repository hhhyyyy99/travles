import { Hono } from 'hono'
import { MastraServer, type HonoBindings, type HonoVariables } from '@mastra/hono'
import { mastra } from './mastra.js'
import { readServerVersion } from './version.js'

export type AppEnv = {
  Bindings: HonoBindings
  Variables: HonoVariables
}

/**
 * Build the backend Hono app with the Mastra instance mounted via the
 * @mastra/hono server adapter (the pattern recommended by the current Mastra
 * v1 docs: https://mastra.ai/reference/server/hono-adapter).
 *
 * Mastra routes are registered by `server.init()`. Our own routes registered
 * after init() can access the mounted instance via `c.get('mastra')`.
 */
export async function createApp(): Promise<Hono<AppEnv>> {
  const app = new Hono<AppEnv>()

  const server = new MastraServer({ app, mastra })
  await server.init()

  app.get('/api/health', (c) => {
    return c.json({
      ok: true,
      name: '@hailar/server',
      version: readServerVersion(),
      node: process.version,
      mastraReady: Boolean(c.get('mastra')),
    })
  })

  return app
}
