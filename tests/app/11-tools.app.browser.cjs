// Ticket 14 — canvas-side tools: 便签 / 清单 / 图库 dockable panels.
// Runs against the real Vite app with the trips/canvas + tools APIs mocked at
// the route level (Playwright directly, no @playwright/test), asserting:
// panels open/close with reload persistence, checklist toggle of the migrated
// legacy rows, notes add/edit, and gallery card-image aggregation + upload.
const test = require('node:test')
const assert = require('node:assert/strict')
const { openApp } = require('../helpers/vite-app.cjs')

const LAYOUT_KEY = 'journey-workbench-layout-v1'
const TOOLS_KEY = 'journey-workbench-tools-v1'
const TRIP_ID = 'trip-tools-1'

// One-time storage reset: addInitScript runs before EVERY navigation, so a
// bare removeItem would wipe persisted state on each reload. sessionStorage
// survives reloads within the tab, making this guard run only once.
const CLEAR_STATE_INIT = `
  if (!window.sessionStorage.getItem('tools-state-cleared')) {
    window.localStorage.removeItem('${LAYOUT_KEY}')
    window.localStorage.removeItem('${TOOLS_KEY}')
    window.sessionStorage.setItem('tools-state-cleared', '1')
  }
`

// Tiny cover image as a data URI (data URIs never hit the network, so the
// catch-all "abort non-127.0.0.1" route keeps applying).
const COVER_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="%233f7d5c"/></svg>'
const COVER_URI = `data:image/svg+xml;utf8,${COVER_SVG}`

// 1x1 red PNG for the upload test.
const UPLOAD_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const tripPayload = {
  id: TRIP_ID,
  title: '工具面板行程',
  startDate: '2026-10-02',
  endDate: '2026-10-04',
  days: 3,
  nights: 2,
  createdAt: '2026-09-12T00:00:00.000Z',
  updatedAt: '2026-09-12T00:00:00.000Z',
}

const canvasPayload = {
  trip: tripPayload,
  days: [
    {
      id: 'day-1',
      index: 0,
      date: '2026-10-02',
      theme: '抵达海拉尔',
      color: '#c26d4f',
      items: [
        {
          id: 'item-stay',
          dayId: 'day-1',
          order: 0,
          type: 'stay',
          title: '海拉尔全季酒店',
          note: '',
          poi: null,
          images: [{ url: COVER_URI, caption: '酒店外观' }],
          pending: false,
        },
      ],
    },
  ],
  legs: [],
}

// ---------------------------------------------------------------------------
// In-memory "server" state mutated by the route handlers, so reloads observe
// the same persistence semantics the real backend provides.
// ---------------------------------------------------------------------------

const CHECKLIST_CONTENTS = [
  '确认海拉尔机场同点取还车',
  '订好 6 晚住宿、莫尔道嘎与黑山头问供暖',
  '确认额尔古纳湿地、莫尔道嘎开放时间',
  '准备证件与防风保暖衣物',
  '下载离线地图、检查天气路况',
  '确认 10/8 还车与航站楼时间',
]

function freshState() {
  return {
    notes: [{ id: 'note-seed', content: '车牌：蒙E 88888', createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z' }],
    checklist: CHECKLIST_CONTENTS.map((content, index) => ({
      id: `legacy-checklist-${index}`,
      content,
      done: index === 0,
      createdAt: `2026-09-01T00:00:0${index}.000Z`,
    })),
    gallery: [],
    counter: 0,
  }
}

/** Mocks the trips list + canvas + tools APIs with mutable in-memory state. */
async function mockToolsApi({ page, state }) {
  const json = (body, status = 200) => ({ status, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
  const segments = (url) => url.pathname.split('/').filter(Boolean) // api, trips, :id, ...

  await page.route('**/api/trips', (route) => route.fulfill(json({ trips: [tripPayload] })))
  await page.route('**/api/trips/*/canvas', (route) => {
    const segs = segments(new URL(route.request().url()))
    if (segs[2] !== TRIP_ID) return route.fulfill(json({ error: '行程不存在' }, 404))
    return route.fulfill(json(canvasPayload))
  })

  // Notes: list+create first, then the :noteId routes (LIFO wins for item URLs).
  await page.route('**/api/trips/*/notes', (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const segs = segments(url)
    if (segs[2] !== TRIP_ID) return route.fulfill(json({ error: '行程不存在' }, 404))
    if (request.method() === 'GET') return route.fulfill(json({ notes: state.notes }))
    if (request.method() === 'POST') {
      const note = {
        id: `note-${++state.counter}`,
        content: '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      state.notes.push(note)
      return route.fulfill(json({ note }, 201))
    }
    return route.fulfill(json({ error: '不支持' }, 405))
  })
  await page.route('**/api/trips/*/notes/*', (route) => {
    const request = route.request()
    const segs = segments(new URL(request.url()))
    const note = state.notes.find((entry) => entry.id === segs[4])
    if (!note) return route.fulfill(json({ error: '便签不存在' }, 404))
    if (request.method() === 'PATCH') {
      note.content = JSON.parse(request.postData()).content
      note.updatedAt = new Date().toISOString()
      return route.fulfill(json({ note }))
    }
    if (request.method() === 'DELETE') {
      state.notes = state.notes.filter((entry) => entry.id !== note.id)
      return route.fulfill(json({ ok: true }))
    }
    return route.fulfill(json({ error: '不支持' }, 405))
  })

  // Checklist: list+create, then :entryId routes.
  await page.route('**/api/trips/*/checklist', (route) => {
    const request = route.request()
    const segs = segments(new URL(request.url()))
    if (segs[2] !== TRIP_ID) return route.fulfill(json({ error: '行程不存在' }, 404))
    if (request.method() === 'GET') return route.fulfill(json({ items: state.checklist }))
    if (request.method() === 'POST') {
      const item = {
        id: `checklist-${++state.counter}`,
        content: JSON.parse(request.postData()).content,
        done: false,
        createdAt: new Date().toISOString(),
      }
      state.checklist.push(item)
      return route.fulfill(json({ item }, 201))
    }
    return route.fulfill(json({ error: '不支持' }, 405))
  })
  await page.route('**/api/trips/*/checklist/*', (route) => {
    const request = route.request()
    const segs = segments(new URL(request.url()))
    const item = state.checklist.find((entry) => entry.id === segs[4])
    if (!item) return route.fulfill(json({ error: '清单条目不存在' }, 404))
    if (request.method() === 'PATCH') {
      const patch = JSON.parse(request.postData())
      if (typeof patch.done === 'boolean') item.done = patch.done
      if (typeof patch.content === 'string') item.content = patch.content
      return route.fulfill(json({ item }))
    }
    if (request.method() === 'DELETE') {
      state.checklist = state.checklist.filter((entry) => entry.id !== item.id)
      return route.fulfill(json({ ok: true }))
    }
    return route.fulfill(json({ error: '不支持' }, 405))
  })

  // Gallery: list+create, then :imageId delete.
  await page.route('**/api/trips/*/gallery', (route) => {
    const request = route.request()
    const segs = segments(new URL(request.url()))
    if (segs[2] !== TRIP_ID) return route.fulfill(json({ error: '行程不存在' }, 404))
    if (request.method() === 'GET') return route.fulfill(json({ images: state.gallery }))
    if (request.method() === 'POST') {
      const body = JSON.parse(request.postData())
      if (typeof body.url !== 'string' || !/^(data:image\/|https?:)/.test(body.url)) {
        return route.fulfill(json({ error: '图片必须是 http(s) 链接或 5MB 以内的图片数据' }, 400))
      }
      const image = {
        id: `img-${++state.counter}`,
        itemId: body.itemId ?? null,
        url: body.url,
        caption: body.caption ?? '',
        createdAt: new Date().toISOString(),
      }
      state.gallery.push(image)
      return route.fulfill(json({ image }, 201))
    }
    return route.fulfill(json({ error: '不支持' }, 405))
  })
  await page.route('**/api/trips/*/gallery/*', (route) => {
    const request = route.request()
    const segs = segments(new URL(request.url()))
    if (request.method() === 'DELETE') {
      state.gallery = state.gallery.filter((image) => image.id !== segs[4])
      return route.fulfill(json({ ok: true }))
    }
    return route.fulfill(json({ error: '不支持' }, 405))
  })
}

async function openWorkbench({ state } = {}) {
  const appState = state ?? freshState()
  const { page, close } = await openApp({
    entry: `/?view=workbench&trip=${TRIP_ID}`,
    init: CLEAR_STATE_INIT,
    setup: ({ page }) => mockToolsApi({ page, state: appState }),
  })
  await page.locator('#workbench-topbar').waitFor()
  return { page, close, state: appState }
}

test('the tools rail opens each docked panel and the open panel survives a reload', async () => {
  const { page, close } = await openWorkbench()
  try {
    // Rail present, panel closed initially.
    await page.locator('#tools-rail').waitFor()
    assert.equal(await page.locator('#tools-panel').count(), 0)
    assert.equal(await page.locator('#tools-rail [data-tool="notes"]').getAttribute('aria-pressed'), 'false')

    // Open 便签.
    await page.locator('#tools-rail [data-tool="notes"]').click()
    await page.locator('#tools-panel[data-tools-panel="notes"]').waitFor()
    assert.equal(await page.locator('#tools-rail [data-tool="notes"]').getAttribute('aria-pressed'), 'true')

    // Reload — the open panel is remembered per trip.
    await page.reload()
    await page.locator('#tools-panel[data-tools-panel="notes"]').waitFor()

    // Switch to 清单, then close via the panel header button.
    await page.locator('#tools-rail [data-tool="checklist"]').click()
    await page.locator('#tools-panel[data-tools-panel="checklist"]').waitFor()
    await page.locator('[data-action="close-tools"]').click()
    assert.equal(await page.locator('#tools-panel').count(), 0)

    // Reopening the closed panel works.
    await page.locator('#tools-rail [data-tool="checklist"]').click()
    await page.locator('#tools-panel[data-tools-panel="checklist"]').waitFor()
  } finally {
    await close()
  }
})

test('notes: seeded note renders, add/edit/delete round-trips through the API', async () => {
  const { page, close, state } = await openWorkbench()
  try {
    await page.locator('#tools-rail [data-tool="notes"]').click()
    await page.locator('#tools-panel[data-tools-panel="notes"]').waitFor()

    // Seeded note (would come from the server).
    const seed = page.locator('[data-note-id="note-seed"] textarea')
    await seed.waitFor()
    assert.equal(await seed.inputValue(), '车牌：蒙E 88888')

    // Add → empty note appears (server assigns the id).
    await page.locator('[data-action="add-note"]').click()
    await page.locator('#tools-panel textarea').nth(1).waitFor()
    assert.equal(state.notes.length, 2)

    // Edit on blur → PATCH reaches the "server".
    const editor = page.locator('#tools-panel textarea').nth(1)
    await editor.click()
    await editor.fill('带抓绒外套')
    await page.locator('#workbench-topbar').click() // blur the textarea
    await page.waitForTimeout(100)
    assert.equal(state.notes.find((note) => note.id !== 'note-seed')?.content, '带抓绒外套')

    // Delete the edited note.
    await page.locator('[data-action="delete-note"]').nth(1).click()
    await page.waitForTimeout(100)
    assert.equal(state.notes.length, 1)
    assert.equal(await page.locator('[data-note-id]').count(), 1)
  } finally {
    await close()
  }
})

test('checklist: migrated legacy items are visible, toggleable, and the state persists', async () => {
  const { page, close, state } = await openWorkbench()
  try {
    await page.locator('#tools-rail [data-tool="checklist"]').click()
    await page.locator('#tools-panel[data-tools-panel="checklist"]').waitFor()

    // The six migrated legacy items are all listed.
    const items = page.locator('[data-checklist-id^="legacy-checklist-"]')
    assert.equal(await items.count(), 6)
    assert.equal(await items.nth(0).getAttribute('data-checklist-done'), 'true')
    assert.equal(await items.nth(1).getAttribute('data-checklist-done'), null)
    assert.ok((await page.locator('[data-checklist-progress]').textContent()).includes('1/6 已完成'))

    // Toggle legacy-checklist-1 → PATCH {done:true} lands on the server state.
    await items.nth(1).locator('[data-action="toggle-checklist"]').click()
    await page.waitForTimeout(100)
    assert.equal(state.checklist.find((item) => item.id === 'legacy-checklist-1')?.done, true)
    assert.ok((await page.locator('[data-checklist-progress]').textContent()).includes('2/6 已完成'))

    // Add a new entry, then delete it again.
    await page.locator('#tools-checklist-input').fill('给车加满防冻玻璃水')
    await page.locator('[data-action="add-checklist"]').click()
    await page.locator('[data-checklist-id="checklist-1"]').waitFor()
    assert.equal(state.checklist.length, 7)
    await page.locator('[data-checklist-id="checklist-1"] [data-action="delete-checklist"]').click()
    await page.waitForTimeout(100)
    assert.equal(state.checklist.length, 6)

    // Reload — the panel reopens with the toggled legacy item still done.
    await page.reload()
    await page.locator('#tools-panel[data-tools-panel="checklist"]').waitFor()
    assert.equal(
      await page.locator('[data-checklist-id="legacy-checklist-1"]').getAttribute('data-checklist-done'),
      'true',
    )
  } finally {
    await close()
  }
})

test('gallery: card images are aggregated from the canvas and uploads round-trip', async () => {
  const { page, close, state } = await openWorkbench()
  try {
    await page.locator('#tools-rail [data-tool="gallery"]').click()
    await page.locator('#tools-panel[data-tools-panel="gallery"]').waitFor()

    // The card cover from the canvas appears in the 卡片图片 section.
    const cardImage = page.locator('[data-gallery-card-image="item-stay"]')
    await cardImage.waitFor()
    assert.equal(await cardImage.getAttribute('src'), COVER_URI)
    assert.equal(await page.locator('[data-gallery-upload-id]').count(), 0)

    // Upload a PNG → POST /gallery → the upload renders.
    await page.locator('#tools-gallery-upload').setInputFiles({
      name: 'grassland.png',
      mimeType: 'image/png',
      buffer: UPLOAD_PNG,
    })
    await page.locator('[data-gallery-upload-id="img-1"]').waitFor()
    assert.equal(state.gallery.length, 1)
    assert.match(state.gallery[0]?.url ?? '', /^data:image\/png;base64,/)

    // Delete the upload — the card image stays.
    await page.locator('[data-gallery-upload-id="img-1"] [data-action="delete-gallery"]').click()
    await page.waitForTimeout(100)
    assert.equal(state.gallery.length, 0)
    assert.equal(await page.locator('[data-gallery-upload-id]').count(), 0)
    await cardImage.waitFor()

    // Reload — the panel reopens and the card image is still aggregated.
    await page.reload()
    await page.locator('#tools-panel[data-tools-panel="gallery"]').waitFor()
    await page.locator('[data-gallery-card-image="item-stay"]').waitFor()
  } finally {
    await close()
  }
})
