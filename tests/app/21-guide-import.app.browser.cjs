const assert = require('node:assert/strict')
const { test } = require('node:test')
const { spawn } = require('node:child_process')
const path = require('node:path')
const { mkdir } = require('node:fs/promises')
const { openApp } = require('../helpers/vite-app.cjs')
const root = path.resolve(__dirname, '../..')
const guideText = '成都两天，第一天人民公园喝茶、街边小吃；第二天都江堰，回来整理照片。'

async function startBackend() {
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/helpers/guide-import-server.ts'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, AMAP_WEB_KEY: '', AI_API_KEY: '' },
  })
  let logs = ''
  const stopped = new Promise((resolve) => child.once('exit', resolve))
  const close = async () => { child.kill('SIGTERM'); await stopped }
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Backend startup timeout: ' + logs)), 20000)
      child.once('error', (error) => { clearTimeout(timer); reject(error) })
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Backend exited: ' + logs)) })
      child.stdout.on('data', (chunk) => {
        logs += chunk.toString()
        const match = logs.match(/READY (\d+)/)
        if (match) { clearTimeout(timer); resolve(Number(match[1])) }
      })
      child.stderr.on('data', (chunk) => { logs += chunk.toString() })
    })
    return { port, close, url: 'http://127.0.0.1:' + port }
  } catch (error) { await close(); throw error }
}

async function fixture(options = {}) {
  const backend = await startBackend()
  try {
    const app = await openApp({ entry: '/?view=trips', serverPort: backend.port, amapConfig404: true,
      viewport: options.viewport || { width: 1440, height: 1100 }, setup: options.setup })
    await app.page.locator('#trip-mode-guide').click()
    return { ...app, backend, async close() { await app.close(); await backend.close() } }
  } catch (error) { await backend.close(); throw error }
}
async function readTrips(f) {
  return (await (await fetch(f.backend.url + '/api/trips')).json()).trips
}
async function parseText(f) {
  await f.page.locator('#guide-text').fill(guideText)
  await f.page.locator('#guide-parse-submit').click()
  await f.page.locator('#guide-preview').waitFor()
}
async function screenshot(page, name) {
  if (!process.env.GUIDE_IMPORT_EVIDENCE_DIR) return
  await mkdir(process.env.GUIDE_IMPORT_EVIDENCE_DIR, { recursive: true })
  await page.screenshot({ path: path.join(process.env.GUIDE_IMPORT_EVIDENCE_DIR, name + '.png') })
}

test('real browser parses, previews and explicitly creates a durable itinerary, then opens its existing workbench', async () => {
  const f = await fixture()
  let chatPosts = 0
  f.page.on('request', (request) => { if (request.method() === 'POST' && /\/messages$/.test(new URL(request.url()).pathname)) chatPosts++ })
  try {
    await screenshot(f.page, 'input-desktop')
    await parseText(f)
    assert.equal((await readTrips(f)).length, 0, 'preview cannot create a trip')
    assert.equal(await f.page.locator('[data-guide-day]').count(), 2)
    assert.match(await f.page.locator('#guide-preview').innerText(), /日期待定/)
    assert.match(await f.page.locator('#guide-preview').innerText(), /地点待确认/)
    assert.match(await f.page.locator('#guide-preview').innerText(), /已定位 · 人民公园/)
    assert.match(await f.page.locator('#guide-preview').innerText(), /便签/)
    await f.page.locator('#guide-trip-title').fill('我的成都周末')
    await screenshot(f.page, 'preview-desktop')
    await f.page.locator('#guide-import-confirm').click()
    await f.page.locator('#workbench-topbar').waitFor()
    const trips = await readTrips(f)
    assert.equal(trips.length, 1)
    assert.equal(trips[0].title, '我的成都周末')
    assert.equal(trips[0].durationDays, 2)
    assert.equal(trips[0].dateStatus, 'unspecified')
    const canvas = await (await fetch(f.backend.url + '/api/trips/' + trips[0].id + '/canvas')).json()
    assert.deepEqual(canvas.days.map((day) => day.items.map((item) => item.title)), [['人民公园', '街边小吃'], ['都江堰', '整理照片']])
    assert.equal(canvas.days[0].items[0].pending, false)
    assert.equal(canvas.days[0].items[1].pending, true)
    await f.page.locator('#workbench-back').click()
    await f.page.locator('#guide-parse-form').waitFor()
    assert.equal(await f.page.locator('#guide-preview').count(), 0, 'successful navigation clears the in-memory preview')
    assert.equal(await f.page.locator('#guide-text').inputValue(), '')
    await f.page.goto(f.url + '/?view=workbench&trip=' + trips[0].id)
    await f.page.locator('#workbench-topbar').waitFor()
    assert.match(await f.page.locator('#workbench-trip-badge').innerText(), /日期待定.*2天1晚/)
    await f.page.getByText('人民公园', { exact: true }).first().waitFor()
    await f.page.waitForFunction(() => document.querySelector('#chat-list')?.parentElement?.getAttribute('aria-busy') === 'false')
    await f.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.equal(chatPosts, 0, 'opening or reopening an imported itinerary does not request an AI conversation')
    assert.equal((await (await fetch(f.backend.url + '/api/trips/' + trips[0].id + '/messages')).json()).messages.length, 0)
    await screenshot(f.page, 'imported-workbench')
    await f.page.locator('#workbench-back').click()
    await f.page.locator('#trip-mode-guide').click()
    await f.page.locator('#guide-parse-form').waitFor()
    assert.equal(await f.page.locator('#guide-preview').count(), 0, 'returning to the list cannot restore an already imported preview')
    assert.equal(await f.page.locator('#guide-text').inputValue(), '')
  } finally { await f.close() }
})

test('unreadable URL focuses the text fallback and keeps the URL while pasted text takes precedence', async () => {
  const f = await fixture()
  try {
    await f.page.locator('#guide-url').fill('http://127.0.0.1:1/blocked')
    await f.page.locator('#guide-parse-submit').click()
    await f.page.locator('#guide-fallback').waitFor()
    assert.equal(await f.page.locator('#guide-text').evaluate((node) => node === document.activeElement), true)
    assert.equal(await f.page.locator('#guide-url').inputValue(), 'http://127.0.0.1:1/blocked')
    assert.equal((await readTrips(f)).length, 0)
    const sent = f.page.waitForRequest((request) => new URL(request.url()).pathname === '/api/ai/parse-guide')
    await parseText(f)
    assert.deepEqual((await sent).postDataJSON(), { text: guideText })
    await f.page.getByRole('button', { name: '放弃草稿', exact: true }).click()
    assert.equal(await f.page.locator('#guide-text').inputValue(), guideText)
    assert.equal((await readTrips(f)).length, 0)
  } finally { await f.close() }
})

test('a lost successful confirmation response can be retried with the identical key and payload without creating duplicates', async () => {
  let first = true
  const confirmations = []
  const f = await fixture({ setup: async ({ page }) => {
    await page.route('**/api/trips/from-guide', async (route) => {
      confirmations.push(route.request().postDataJSON())
      const response = await route.fetch()
      if (first) { first = false; await route.abort('failed'); return }
      await route.fulfill({ response })
    })
  } })
  try {
    await parseText(f)
    await f.page.locator('#guide-import-confirm').click()
    await f.page.locator('#guide-error').waitFor()
    assert.equal((await readTrips(f)).length, 1, 'server committed the lost response')
    assert.equal(await f.page.locator('#guide-trip-title').isDisabled(), true)
    await f.page.locator('#open-ai-settings').click()
    await f.page.locator('#ai-settings-back').click()
    await f.page.locator('#guide-preview').waitFor()
    assert.equal(await f.page.locator('#guide-trip-title').isDisabled(), true)
    await f.page.locator('#guide-import-confirm').click()
    await f.page.locator('#workbench-topbar').waitFor()
    assert.equal(confirmations.length, 2)
    assert.deepEqual(confirmations[0], confirmations[1])
    assert.equal((await readTrips(f)).length, 1)
  } finally { await f.close() }
})

test('parsing has feedback, rejects double submit, and cancellation ignores a late result without writing', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let finished
  const done = new Promise((resolve) => { finished = resolve })
  let calls = 0
  const f = await fixture({ setup: async ({ page }) => {
    await page.route('**/api/ai/parse-guide', async (route) => {
      calls++
      const response = await route.fetch()
      await gate
      try { await route.fulfill({ response }) } catch {} finally { finished() }
    })
  } })
  try {
    await f.page.locator('#guide-text').fill(guideText)
    await f.page.locator('#guide-parse-form').evaluate((form) => { form.requestSubmit(); form.requestSubmit() })
    await f.page.getByText('正在读取攻略、提取日程并匹配地点，请稍候。').waitFor()
    assert.equal(await f.page.locator('#trip-mode-ai').isDisabled(), true)
    await f.page.getByRole('button', { name: '取消解析', exact: true }).click()
    assert.equal(await f.page.locator('#guide-parse-submit').isEnabled(), true)
    release()
    await done
    await f.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.equal(await f.page.locator('#guide-preview').count(), 0)
    assert.equal(calls, 1)
    assert.equal((await readTrips(f)).length, 0)
  } finally { release(); await f.close() }
})

test('invalid input and unconfigured models expose a recovery action while keeping the guide text', async () => {
  let calls = 0
  const f = await fixture({ setup: async ({ page }) => {
    await page.route('**/api/ai/parse-guide', (route) => {
      calls++
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ status: 'error', code: 'model_unconfigured', error: '请先配置 AI 服务商。' }) })
    })
  } })
  try {
    await f.page.locator('#guide-parse-submit').click()
    await f.page.locator('#guide-error').waitFor()
    assert.equal(calls, 0)
    await f.page.locator('#guide-url').fill('javascript:alert(1)')
    await f.page.locator('#guide-parse-submit').click()
    assert.equal(calls, 0)
    await f.page.locator('#guide-text').fill(guideText)
    await f.page.locator('#guide-parse-submit').click()
    await f.page.getByRole('button', { name: '前往 AI 接入设置', exact: true }).waitFor()
    assert.equal(await f.page.locator('#guide-text').inputValue(), guideText)
    assert.equal((await readTrips(f)).length, 0)
    await f.page.getByRole('button', { name: '前往 AI 接入设置', exact: true }).click()
    await f.page.locator('#ai-provider-name').waitFor()
    await f.page.locator('#ai-settings-back').click()
    await f.page.locator('#guide-parse-form').waitFor()
    assert.equal(await f.page.locator('#guide-text').inputValue(), guideText)
    assert.equal(await f.page.locator('#trip-mode-guide').getAttribute('aria-pressed'), 'true')
  } finally { await f.close() }
})

test('narrow screens support keyboard entry, preserve both creation forms and preview without horizontal overflow', async () => {
  const f = await fixture({ viewport: { width: 390, height: 844 } })
  try {
    await f.page.locator('#trip-mode-ai').focus()
    await f.page.keyboard.press('Enter')
    await f.page.locator('#trip-intake-input').fill('北京3天慢游')
    await f.page.locator('#trip-mode-guide').focus()
    await f.page.keyboard.press('Enter')
    await f.page.locator('#guide-text').fill(guideText)
    await f.page.locator('#trip-mode-ai').click()
    assert.equal(await f.page.locator('#trip-intake-input').inputValue(), '北京3天慢游')
    await f.page.locator('#trip-mode-guide').click()
    assert.equal(await f.page.locator('#guide-text').inputValue(), guideText)
    assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await screenshot(f.page, 'input-mobile')
    await f.page.locator('#guide-parse-submit').click()
    await f.page.locator('#guide-preview').waitFor()
    assert.equal(await f.page.getByRole('heading', { name: '攻略草稿预览' }).evaluate((node) => node === document.activeElement), true)
    assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await f.page.locator('#guide-preview').scrollIntoViewIfNeeded()
    await screenshot(f.page, 'preview-mobile')
    await f.page.getByRole('button', { name: '放弃草稿', exact: true }).click()
    assert.equal((await readTrips(f)).length, 0)
  } finally { await f.close() }
})

test('guide preview and confirmation work when secure-context randomUUID is unavailable', async () => {
  const f = await fixture({ setup: async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined }))
  } })
  try {
    await parseText(f)
    assert.equal(await f.page.evaluate(() => typeof crypto.randomUUID), 'undefined')
    await f.page.locator('#guide-import-confirm').click()
    await f.page.locator('#workbench-topbar').waitFor()
    assert.equal((await readTrips(f)).length, 1)
  } finally { await f.close() }
})
