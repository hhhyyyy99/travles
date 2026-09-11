import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

import { createApp } from '../src/app.js'

const require = createRequire(import.meta.url)
const pkg = require('../package.json') as { version?: string }

test('GET /api/health returns version info from the real app instance', async () => {
  const app = await createApp()

  const res = await app.request('/api/health')
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') ?? '', /^application\/json/)

  const body = (await res.json()) as Record<string, unknown>
  assert.equal(body.ok, true)
  assert.equal(body.name, '@hailar/server')
  assert.equal(body.version, pkg.version)
  assert.equal(typeof body.node, 'string')
  assert.match(body.node as string, /^v\d+/)
})

test('GET /api/health reports the mounted Mastra instance', async () => {
  const app = await createApp()

  const res = await app.request('/api/health')
  assert.equal(res.status, 200)

  const body = (await res.json()) as Record<string, unknown>
  assert.equal(body.mastraReady, true)
})

test('unknown /api routes do not shadow the health endpoint', async () => {
  const app = await createApp()

  const res = await app.request('/api/health/extra')
  assert.equal(res.status, 404)
})
