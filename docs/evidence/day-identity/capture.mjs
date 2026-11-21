#!/usr/bin/env node
/**
 * Real Hono/SQLite + Vite evidence capture. No API responses or UI are mocked.
 * Run from any directory:
 *   node docs/evidence/day-identity/capture.mjs --root /absolute/archive/root --label before --revision SHA
 * The archive must have its own `pnpm install --frozen-lockfile` completed.
 * Use separate archives for baseline and changed revisions. Each run uses fresh
 * ports, SQLite, browser context, and Vite cache; it closes all child processes.
 */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1])
const root = path.resolve(args.get('--root') ?? '.')
const label = args.get('--label')
const revision = args.get('--revision')
assert.ok(label === 'before' || label === 'after', '--label must be before or after')
assert.match(revision ?? '', /^[0-9a-f]{40}$/, '--revision must be an exact Git commit SHA')
const output = path.dirname(fileURLToPath(import.meta.url))
const workspace = await mkdtemp(path.join(tmpdir(), `travles-day-identity-${label}-run-`))
const databasePath = path.join(workspace, 'trips.db')
const children = []
const commandLog = []
const logs = []
let browser
const tripId = 'evidence-day-identity'
const clientTripId = 'evidence-day-identity-client'
const tripTitle = '日程序号兼容验证'
const expectedIndex = label === 'before' ? 8 : 2

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}
function launch(name, argv, env) {
  const logPath = path.join(output, `${label}-${name}.log`)
  const stream = createWriteStream(logPath)
  const child = spawn(process.execPath, argv, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(stream)
  child.stderr.pipe(stream)
  let text = ''
  child.stdout.on('data', chunk => { text += chunk })
  child.stderr.on('data', chunk => { text += chunk })
  const closed = new Promise(resolve => child.once('close', (code, signal) => {
    stream.end()
    resolve({ code, signal })
  }))
  child.once('error', error => { text += error.stack })
  const record = { name, child, closed, logPath, readLogs: () => text }
  children.push(record)
  commandLog.push({ cwd: root, executable: process.execPath, argv, env: {
    SERVER_PORT: env.SERVER_PORT, TRIPS_DB_PATH: env.TRIPS_DB_PATH,
    APP_TEST_VITE_CACHE_DIR: env.APP_TEST_VITE_CACHE_DIR,
  } })
  logs.push(logPath)
  return record
}
async function waitFor(url) {
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    for (const child of children) {
      if (child.child.exitCode !== null) throw new Error(`${child.name} exited early: ${child.readLogs()}`)
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) })
      if (response.ok) return
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  throw new Error(`Server was not ready at ${url}`)
}
function seedFixture(db, id, title) {
  const timestamp = '2026-01-01T00:00:00.000Z'
  db.prepare(`INSERT INTO trips (id,title,start_date,end_date,created_at,updated_at) VALUES (?,?,?,?,?,?)`)
    .run(id, title, '', '', timestamp, timestamp)
  const insertDay = db.prepare(`INSERT INTO days (id,trip_id,idx,date,theme,color) VALUES (?,?,?,?,?,?)`)
  insertDay.run(`${id}-day-a`, id, 0, '', '已有日程一', '#c26d4f')
  insertDay.run(`${id}-day-b`, id, 7, '', '已有日程二', '#3f7d5c')
}
function fixtureRows(db) {
  return {
    trips: db.prepare('SELECT id,title,start_date,end_date FROM trips WHERE id IN (?,?) ORDER BY id').all(tripId, clientTripId),
    days: db.prepare('SELECT id,trip_id,idx,date,theme,color FROM days WHERE trip_id IN (?,?) ORDER BY trip_id,idx').all(tripId, clientTripId),
    items: db.prepare('SELECT * FROM items WHERE trip_id IN (?,?)').all(tripId, clientTripId),
  }
}

const startedAt = new Date().toISOString()
let result
let failure
try {
  // Use dependencies belonging to the archived revision, including its browser API.
  const { chromium } = await import(pathToFileURL(path.join(root, 'node_modules/playwright/index.mjs')).href)
  const serverPort = await freePort()
  let frontendPort = await freePort()
  while (frontendPort === serverPort) frontendPort = await freePort()
  const origin = `http://127.0.0.1:${frontendPort}`
  const env = { ...process.env, SERVER_PORT: String(serverPort), TRIPS_DB_PATH: databasePath,
    APP_TEST_VITE_CACHE_DIR: path.join(workspace, 'vite-cache') }
  // No environment credentials are necessary for this scenario.
  for (const name of Object.keys(env)) {
    if (/^(OPENAI_|ANTHROPIC_|DEEPSEEK_|AMAP_|VITE_AMAP_|AI_)/.test(name)) delete env[name]
  }
  launch('server', ['--import', 'tsx', 'server/src/index.ts'], env)
  await waitFor(`http://127.0.0.1:${serverPort}/api/trips`)
  const db = new DatabaseSync(databasePath)
  seedFixture(db, tripId, tripTitle)
  seedFixture(db, clientTripId, `${tripTitle}（浏览器客户端断言）`)
  const initialDatabase = fixtureRows(db)
  db.close()
  launch('vite', [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(frontendPort), '--strictPort'], env)
  await waitFor(`${origin}/`)
  browser = await chromium.launch({ headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1, colorScheme: 'light', locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
  const page = await context.newPage()
  page.setDefaultTimeout(20000)
  const network = []
  const browserErrors = []
  let abortedEvents = 0
  const blockedExternal = new Set()
  await page.route('**/*', route => {
    const url = route.request().url()
    if (url.startsWith(origin)) return route.continue()
    blockedExternal.add(url)
    return route.abort('blockedbyclient')
  })
  // Deliberately hold realtime offline on BOTH revisions. No API data is changed.
  await page.route('**/events*', route => { abortedEvents += 1; return route.abort('blockedbyclient') })
  page.on('pageerror', error => browserErrors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api/')) network.push({ method: request.method(), path: url.pathname, at: Date.now() })
  })
  await page.goto(`${origin}/?view=workbench&trip=${tripId}`, { waitUntil: 'domcontentloaded' })
  await page.locator('#workbench-topbar').waitFor()
  await page.locator('[data-action="view-list"]').click()
  await page.locator('[data-list-tab]').first().waitFor()
  await page.waitForFunction(() => document.fonts.status === 'loaded')
  const initialClient = await page.evaluate(async id => {
    const { fetchTripCanvas } = await import('/src/domain/workbench.ts')
    return fetchTripCanvas(id)
  }, tripId)
  assert.equal(initialClient.ok, true)
  assert.deepEqual(initialClient.data.days.map(day => day.index), [0, 7])
  const initialTabs = await page.locator('[data-list-tab]').allTextContents()
  await page.screenshot({ path: path.join(output, `${label}-initial.png`) })
  const readsBeforeClick = network.filter(request => request.path === `/api/trips/${tripId}/canvas`).length
  const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === `/api/trips/${tripId}/days` && response.request().method() === 'POST')
  // This is the app's real accessible + control; it invokes createWorkbenchDay.
  await page.getByRole('button', { name: '添加一天', exact: true }).click()
  const response = await responsePromise
  assert.equal(response.status(), 201)
  const createResponse = await response.json()
  assert.equal(createResponse.day.index, expectedIndex)
  if (label === 'after') {
    assert.equal(createResponse.day.tripId, tripId)
    assert.equal(createResponse.day.dayNumber, 3)
  }
  const added = page.locator(`[data-list-tab="${createResponse.day.id}"]`)
  await added.waitFor()
  await added.click()
  await page.waitForFunction(expected => {
    const selected = document.querySelector('[data-list-tab][aria-selected="true"]')
    return selected?.textContent?.includes(`D${expected + 1}`)
  }, expectedIndex)
  const readsAtScreenshot = network.filter(request => request.path === `/api/trips/${tripId}/canvas`).length
  assert.equal(readsAtScreenshot, readsBeforeClick, 'No automatic canvas refetch may hide the POST response state')
  const tabsAtScreenshot = await page.locator('[data-list-tab]').allTextContents()
  const selectedTab = await added.textContent()
  const screenshotPath = path.join(output, `${label}.png`)
  await page.screenshot({ path: screenshotPath })
  const accessibility = await page.locator('body').ariaSnapshot()
  await writeFile(path.join(output, `${label}-aria.txt`), `${accessibility}\n`)
  // Read authoritative rows only AFTER capture, without changing mounted React state.
  const serverCanvasAfter = await (await context.request.get(`${origin}/api/trips/${tripId}/canvas`)).json()
  assert.equal(serverCanvasAfter.days.find(day => day.id === createResponse.day.id).index, 2)
  // Exercise the actual exported frontend functions in the browser on a second
  // identical sparse fixture, so this extra real mutation cannot affect the image.
  const clientFunctions = await page.evaluate(async id => {
    const { fetchTripCanvas, createWorkbenchDay } = await import('/src/domain/workbench.ts')
    const canvasBefore = await fetchTripCanvas(id)
    const created = await createWorkbenchDay(id)
    const canvasAfter = await fetchTripCanvas(id)
    return { canvasBefore, created, canvasAfter }
  }, clientTripId)
  assert.equal(clientFunctions.created.ok, true)
  assert.equal(clientFunctions.created.data.index, expectedIndex)
  if (label === 'after') {
    assert.equal(clientFunctions.created.data.tripId, clientTripId)
    assert.equal(clientFunctions.created.data.dayNumber, 3)
    assert.deepEqual(clientFunctions.canvasBefore.data.days.map(day => day.dayNumber), [1, 8])
  }
  assert.ok(abortedEvents > 0, 'SSE route must actually have been interrupted')
  assert.deepEqual(browserErrors, [], 'No unhandled browser errors')
  const screenshotSha256 = createHash('sha256').update(await readFile(screenshotPath)).digest('hex')
  const sourceTree = execFileSync('git', ['rev-parse', `${revision}^{tree}`], { cwd: output, encoding: 'utf8' }).trim()
  result = { label, revision, sourceTree, root, startedAt, capturedAt: new Date().toISOString(),
    node: process.version, pnpm: execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim(),
    browserVersion: browser.version(), browserExecutable: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath(),
    viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: 'light', locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai', theme: await page.evaluate(() => ({ rootClass: document.documentElement.className,
      bodyClass: document.body.className, background: getComputedStyle(document.body).backgroundColor })),
    origin, serverPort, frontendPort, databasePath, initialDatabase, initialTabs, initialClient,
    createHttpStatus: response.status(), createResponse, readsBeforeClick, readsAtScreenshot,
    selectedTab, tabsAtScreenshot, serverCanvasAfter, clientFunctions, abortedEvents,
    blockedExternal: [...blockedExternal], browserErrors, screenshot: path.basename(screenshotPath), screenshotSha256,
    commandLog, logs, network, cleanup: [] }
} catch (error) {
  failure = error
  console.error(error.stack)
} finally {
  if (browser) await browser.close()
  for (const child of children.reverse()) {
    if (child.child.exitCode === null && child.child.signalCode === null) child.child.kill('SIGTERM')
    const timeout = setTimeout(() => child.child.kill('SIGKILL'), 5000)
    const stopped = await child.closed
    clearTimeout(timeout)
    if (result) result.cleanup.push({ name: child.name, pid: child.child.pid, ...stopped })
  }
}
if (result) {
  result.cleanupComplete = true
  await writeFile(path.join(output, `${label}.json`), `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify({ label, revision, sourceTree: result.sourceTree, screenshot: result.screenshot,
    responseIndex: result.createResponse.day.index, responseDayNumber: result.createResponse.day.dayNumber,
    selectedTab: result.selectedTab, readsBeforeClick: result.readsBeforeClick, readsAtScreenshot: result.readsAtScreenshot,
    abortedEvents: result.abortedEvents, cleanup: result.cleanup }, null, 2))
}
if (failure) process.exitCode = 1
