const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { pathToFileURL } = require('node:url')
const { test } = require('node:test')
const { openApp } = require(join(process.cwd(), 'tests/helpers/vite-app.cjs'))

const revision = process.env.REVISION
assert.ok(revision === 'baseline' || revision === 'candidate')
const baseline = revision === 'baseline'
const builtin = '/api/trips/builtin-hailar-oct7'
const stayId = (dayIndex) => `builtin-stay-day-${dayIndex}`
const legacyBase = {
  id: 'test-stay',
  name: '测试民宿',
  type: 'hotel',
  lat: 50.24,
  lng: 120.18,
  address: '测试民宿地址',
}
const manualPoi = { name: '手选住宿', lat: 49.6, lng: 117.4 }
const oldDisplay = { title: '额尔古纳 · 1 晚', note: '约 580–650 m' }
const newDisplay = { title: legacyBase.name, note: legacyBase.address }

async function server(t) {
  const directory = await mkdtemp(join(tmpdir(), 'legacy-stay-chromium-'))
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], {
    env: {
      ...process.env,
      SERVER_PORT: '0',
      TRIPS_DB_PATH: `file:${join(directory, 'trips.db')}`,
      AMAP_KEY: '',
      AMAP_WEB_KEY: '',
      AI_API_KEY: '',
    },
  })
  const exited = once(child, 'exit')
  child.stderr.pipe(process.stderr)
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await exited
    await rm(directory, { recursive: true, force: true })
  })
  const port = await new Promise((resolvePort, reject) => {
    const timeout = setTimeout(() => reject(new Error('Hono startup timed out')), 15000)
    exited.then(([code]) => {
      clearTimeout(timeout)
      reject(new Error(`Hono exited with ${code}`))
    }, reject)
    child.stdout.on('data', (chunk) => {
      const match = String(chunk).match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)
      if (match) {
        clearTimeout(timeout)
        resolvePort(Number(match[1]))
      }
    })
  })
  async function api(path, method = 'GET', body) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    assert.ok(response.ok, `${method} ${path}: ${response.status}`)
    return response.json()
  }
  return { port, api }
}

function displayFields(card) {
  return Promise.all([
    card.locator('h3').textContent(),
    card.locator('[data-card-note-edit]').textContent(),
    card.locator('[data-canvas-card-poi]').textContent(),
  ]).then(([title, note, poi]) => ({ title, note, poi }))
}

test(`${revision}: real browser migration, isolation and marked-record edit`, async (t) => {
  const { port, api } = await server(t)
  const { ACCOMMODATION_STORAGE_KEY } = await import(
    pathToFileURL(resolve('src/domain/storage.ts'))
  )
  const { CHECKLIST_STORAGE_KEY } = await import(pathToFileURL(resolve('src/domain/checklist.ts')))
  const { SERVER_MIGRATION_MARKER_KEY } = await import(
    pathToFileURL(resolve('src/domain/migration.ts'))
  )
  async function readStays() {
    const { days } = await api(`${builtin}/days`)
    return days.slice(0, 6).map((day, index) => {
      const stay = day.items.find((item) => item.id === stayId(index))
      assert.ok(stay, `seeded stay ${index}`)
      return stay
    })
  }
  const seeded = await readStays()
  assert.deepEqual({ title: seeded[1].title, note: seeded[1].note }, oldDisplay)
  assert.equal(seeded[1].poi, undefined)
  await api(`${builtin}/items`, 'PUT', {
    items: [
      { ...seeded[2], title: '手工安排 · 第 3 晚', itemOrder: 42 },
      { ...seeded[3], note: '' },
      { ...seeded[4], note: '用户备注', poi: manualPoi },
    ],
  })
  const { trip } = await api('/api/trips', 'POST', {
    title: '成都周末',
    startDate: '2026-10-10',
    endDate: '2026-10-11',
  })
  const ordinary = `/api/trips/${trip.id}`
  const { day } = await api(`${ordinary}/days`, 'POST', { theme: '成都慢游' })
  await api(`${ordinary}/items`, 'PUT', {
    items: [
      { id: 'chengdu-stay', dayId: day.id, type: 'stay', title: '成都住宿', note: '临近地铁' },
    ],
  })
  await api(`${ordinary}/checklist`, 'POST', { content: '带地铁卡' })
  const readOrdinary = () => Promise.all([api(`${ordinary}/canvas`), api(`${ordinary}/checklist`)])
  const ordinaryBefore = await readOrdinary()

  const migrationWrites = []
  const app = await openApp({
    mode: 'preview',
    entry: '/?view=trips',
    serverPort: port,
    viewport: { width: 1440, height: 1000 },
    amapConfig404: true,
    setup: async ({ page }) => {
      await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
      page.on('request', (request) => {
        const path = new URL(request.url()).pathname
        if (request.method() === 'PUT' && /\/(items|checklist)$/.test(path))
          migrationWrites.push(path)
      })
      await page.addInitScript(
        ({ accommodationKey, checklistKey, base }) => {
          if (location.search !== '?view=trips' || localStorage.getItem(accommodationKey)) return
          localStorage.setItem(
            accommodationKey,
            JSON.stringify({ version: 1, bases: [base], stays: { 1: base.id } }),
          )
          localStorage.setItem(checklistKey, JSON.stringify([0, 2]))
        },
        {
          accommodationKey: ACCOMMODATION_STORAGE_KEY,
          checklistKey: CHECKLIST_STORAGE_KEY,
          base: legacyBase,
        },
      )
    },
  })
  t.after(() => app.close())
  const { page } = app
  await page.waitForFunction(
    (key) => localStorage.getItem(key) === 'done',
    SERVER_MIGRATION_MARKER_KEY,
  )
  assert.deepEqual(migrationWrites, [`${builtin}/items`, `${builtin}/checklist`])
  const workbench = `${app.url}/?view=workbench&trip=builtin-hailar-oct7`
  const card = page.locator(`[data-canvas-card="${stayId(1)}"]`)
  await page.goto(workbench)
  await card.waitFor()
  const fields = await displayFields(card)
  const importedLabel = '酒店 / 民宿 · 测试民宿'
  assert.deepEqual(fields, { ...(baseline ? oldDisplay : newDisplay), poi: importedLabel })
  const migrated = await readStays()
  const { name, address, lat, lng, amapId } = JSON.parse(migrated[1].poi)
  assert.deepEqual(
    { name, address, lat, lng, amapId },
    {
      name: legacyBase.name,
      address: legacyBase.address,
      lat: legacyBase.lat,
      lng: legacyBase.lng,
      amapId: 'legacy-accommodation:test-stay',
    },
  )
  console.log(
    `${revision} first migration (${baseline ? 'reproduced stale title and note' : 'title, note and POI aligned'}):`,
    fields,
    { name, address, lat, lng, amapId },
  )

  const manual = {
    title: migrated[2].title,
    order: migrated[2].itemOrder,
    clearedNote: migrated[3].note,
    editedNote: migrated[4].note,
    poi: JSON.parse(migrated[4].poi),
  }
  assert.equal(manual.editedNote, '用户备注')
  assert.deepEqual(manual.poi, manualPoi)
  if (baseline) {
    assert.notEqual(manual.title, '手工安排 · 第 3 晚')
    assert.notEqual(manual.order, 42)
    assert.notEqual(manual.clearedNote, '')
  } else {
    assert.equal(manual.title, '手工安排 · 第 3 晚')
    assert.equal(manual.order, 42)
    assert.equal(manual.clearedNote, '')
    assert.equal(
      await page.locator(`[data-canvas-card="${stayId(2)}"] h3`).textContent(),
      manual.title,
    )
    assert.equal(
      await page.locator(`[data-canvas-card="${stayId(3)}"] [data-card-note-edit]`).textContent(),
      '＋ 备注',
    )
    assert.equal(
      await page.locator(`[data-canvas-card="${stayId(4)}"] [data-card-note-edit]`).textContent(),
      manual.editedNote,
    )
  }
  console.log(
    `${revision} hand-edited fields (${baseline ? 'title, cleared note and order overwritten' : 'all retained'}):`,
    manual,
  )
  const checklist = await api(`${builtin}/checklist`)
  assert.equal(checklist.items.length, 6)
  assert.deepEqual(
    checklist.items
      .filter((item) => item.done)
      .map((item) => item.id)
      .sort(),
    ['legacy-checklist-0', 'legacy-checklist-2'],
  )
  assert.deepEqual(await readOrdinary(), ordinaryBefore)
  console.log(
    'Built-in checklist: 6 items, 2 checked. Ordinary Chengdu canvas and checklist match pre-migration responses.',
  )

  // On the candidate recreate the stale text left by the historical migration while retaining its real marker and POI.
  if (!baseline) {
    await api(`${builtin}/items`, 'PUT', {
      items: [{ ...migrated[1], ...oldDisplay, poi: JSON.parse(migrated[1].poi) }],
    })
  }
  migrationWrites.length = 0
  await page.goto(`${app.url}/?view=trips`)
  await page.getByText('成都周末', { exact: true }).first().waitFor()
  await page.goto(workbench)
  await card.waitFor()
  assert.deepEqual(await displayFields(card), { ...oldDisplay, poi: importedLabel })
  assert.deepEqual(migrationWrites, [])
  assert.deepEqual(await api(`${builtin}/checklist`), checklist)
  console.log(
    'Completed marker: revisiting trips generated 0 migration PUT requests and kept the old card and checklist intact.',
  )

  await page.getByRole('button', { name: '编辑当前行程住宿' }).click()
  await page.locator(`[data-stay-editor-item="${stayId(1)}"]`).click()
  await page.locator('[data-stay-editor-title]').fill(name)
  await page.locator('[data-stay-editor-note]').fill(address)
  await page.getByRole('button', { name: '保存住宿', exact: true }).click()
  await page.locator('#workbench-stay-editor').waitFor({ state: 'hidden' })
  await page.reload()
  await card.waitFor()
  assert.deepEqual(await displayFields(card), { ...newDisplay, poi: importedLabel })
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), SERVER_MIGRATION_MARKER_KEY),
    'done',
  )
  assert.deepEqual(await readOrdinary(), ordinaryBefore)
  console.log(
    'Existing marked record: edited using the actual workbench dialog, title/note/POI verified after reload, marker retained.',
  )
})
