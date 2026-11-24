const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { mkdtemp } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { test } = require('node:test')
const { openApp } = require(join(process.cwd(), 'tests/helpers/vite-app.cjs'))

async function startBackend() {
  const database = join(await mkdtemp(join(tmpdir(), 'pr29-chat-')), 'trips.db')
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], {
    env: { ...process.env, TRIPS_DB_PATH: database, SERVER_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stopped = once(child, 'close')
  let logs = ''
  child.stderr.on('data', (chunk) => {
    logs += chunk.toString()
  })
  const close = async () => {
    if (child.exitCode === null) child.kill('SIGTERM')
    await stopped
  }
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Backend did not start: ${logs}`)), 15000)
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('exit', (status) => {
        clearTimeout(timer)
        reject(new Error(`Backend exited ${status}: ${logs}`))
      })
      let stdout = ''
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString()
        const match = stdout.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)
        if (match) {
          clearTimeout(timer)
          resolve(Number(match[1]))
        }
      })
    })
    return { port, close }
  } catch (error) {
    await close()
    throw error
  }
}

function postPath(response) {
  return response.request().method() === 'POST' ? new URL(response.url()).pathname : ''
}

test('production Chromium sends all three empty-state suggestions to the actual newly created Chengdu trip', async (t) => {
  const revision = process.env.REVISION
  assert.ok(['baseline', 'reviewed-candidate', 'current-candidate'].includes(revision))
  for (const variable of ['AI_BASE_URL', 'AI_API_KEY', 'AMAP_KEY', 'AMAP_WEB_KEY']) {
    assert.equal(process.env[variable], '', `${variable} must be explicitly empty`)
  }
  const backend = await startBackend()
  let app
  try {
    app = await openApp({ mode: 'preview', serverPort: backend.port, amapConfig404: true })
    const { page } = app
    const title = '成都周末行程'
    const form = page.locator('#trip-create-form')
    await form.getByLabel('行程标题').fill(title)
    await form.getByLabel('开始日期').fill('2026-12-05')
    await form.getByLabel('结束日期').fill('2026-12-06')
    const [created] = await Promise.all([
      page.waitForResponse((response) => postPath(response) === '/api/trips'),
      form.getByRole('button', { name: '创建行程' }).click(),
    ])
    assert.equal(created.status(), 201)
    const { trip } = await created.json()
    assert.equal(trip.title, title)
    assert.equal(trip.days, 2)
    assert.equal(trip.destination, undefined)
    assert.ok(trip.id)
    t.diagnostic(
      `Created trip: ${JSON.stringify({ id: trip.id, title, days: trip.days, structuredDestinationPresent: false })}`,
    )

    const expected = [
      revision === 'baseline' ? '第一次去呼伦贝尔，7 天怎么安排不赶？' : '这趟行程怎么安排才不赶？',
      '沿路有哪些值得吃的和值得带的？',
      '帮我把路线顺一顺，少绕路、多玩几个地方',
    ]
    const starters = page.locator('[data-chat-starters]').getByRole('button')
    for (const [index, label] of expected.entries()) {
      await page.getByRole('heading', { name: title, exact: true }).click()
      assert.equal(await page.locator('#workbench-trip-title').innerText(), title)
      await starters.last().waitFor({ state: 'visible' })
      assert.equal(await starters.count(), 3)
      assert.equal(await page.locator('[data-chat-message]').count(), 0)
      const chip = starters.nth(index)
      const visibleLabel = await chip.innerText()
      const [response] = await Promise.all([
        page.waitForResponse((response) => postPath(response).endsWith('/messages')),
        chip.click(),
      ])
      const actual = {
        visibleLabel,
        path: postPath(response),
        content: response.request().postDataJSON().content,
        status: response.status(),
      }
      t.diagnostic(`Button ${index + 1}: ${JSON.stringify(actual)}`)
      assert.deepEqual(actual, {
        visibleLabel: label,
        path: `/api/trips/${trip.id}/messages`,
        content: label,
        status: 503,
      })
      await page.getByRole('button', { name: '返回行程列表' }).click()
    }

    await page.getByRole('heading', { name: '呼伦贝尔慢环线 · 示例行程', exact: true }).click()
    assert.equal(
      await page.locator('#workbench-trip-title').innerText(),
      '呼伦贝尔慢环线 · 示例行程',
    )
    await page.locator('[data-day-badge]').first().waitFor()
    await page.getByRole('button', { name: '返回行程列表' }).click()
    await page.getByRole('button', { name: '示例行程 · 呼伦贝尔指南' }).click()
    await page.locator('#day-detail').waitFor()
    t.diagnostic(
      'Built-in trip canvas and legacy guide both opened. No AI provider configured: the real chat endpoint returned 503 for all three requests.',
    )
  } finally {
    try {
      await app?.close()
    } finally {
      await backend.close()
    }
  }
})
