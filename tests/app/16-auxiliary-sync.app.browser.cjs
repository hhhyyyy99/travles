// Ticket 16 — open auxiliary panels consume committed SSE updates. The test
// uses a browser-side EventSource seam and mutable API responses to model a
// second workbench changing notes and pending recommendations.
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { openApp } = require('../helpers/vite-app.cjs')

const TRIP_ID = 'trip-auxiliary-sync'
const EVENT_SOURCE_INIT = `
  (() => {
    const sources = []
    class MockEventSource {
      constructor(url) {
        this.url = url
        this.closed = false
        this.listeners = new Map()
        sources.push(this)
      }
      addEventListener(type, listener) {
        const listeners = this.listeners.get(type) || []
        listeners.push(listener)
        this.listeners.set(type, listeners)
      }
      removeEventListener(type, listener) {
        const listeners = this.listeners.get(type) || []
        this.listeners.set(type, listeners.filter((entry) => entry !== listener))
      }
      close() {
        this.closed = true
      }
      emit(type, data) {
        for (const listener of this.listeners.get(type) || []) listener({ data })
      }
    }
    window.EventSource = MockEventSource
    window.__emitTripUpdate = (event) => {
      const data = JSON.stringify(event)
      for (const source of sources) source.emit('trip.updated', data)
    }
  })()
`

const trip = {
  id: TRIP_ID,
  title: '辅助面板同步测试',
  startDate: '2026-10-02',
  endDate: '2026-10-03',
  days: 2,
  nights: 1,
  createdAt: '2026-09-12T00:00:00.000Z',
  updatedAt: '2026-09-12T00:00:00.000Z',
}

const canvas = {
  trip,
  days: [
    { id: 'day-1', index: 0, date: '2026-10-02', theme: '抵达', color: '#c26d4f', items: [] },
    { id: 'day-2', index: 1, date: '2026-10-03', theme: '草原', color: '#3f7d5c', items: [] },
  ],
  legs: [],
}

const remoteStash = {
  id: 'stash-remote',
  origin: 'recommend',
  addedAt: '2026-09-12T00:00:00.000Z',
  poi: {
    id: 'poi-remote',
    amapId: 'amap-remote',
    name: '远端加入的观景点',
    lat: 49.3,
    lng: 119.8,
    category: '景点',
    type: 'attraction',
    region: '额尔古纳',
    rating: 4.5,
    introSummary: '第二个浏览器刚刚收藏的点位',
    address: '额尔古纳沿线',
    images: [],
  },
}

function json(body, status = 200) {
  return { status, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
}

function pathSegments(url) {
  return url.pathname.split('/').filter(Boolean)
}

async function mockApi({ page, state }) {
  await page.route('**/api/trips', (route) => route.fulfill(json({ trips: [trip] })))
  await page.route('**/api/trips/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const segments = pathSegments(url)
    if (segments[2] !== TRIP_ID) return route.fulfill(json({ error: '行程不存在' }, 404))

    if (url.pathname.endsWith('/canvas')) return route.fulfill(json(canvas))
    if (url.pathname.endsWith('/messages')) return route.fulfill(json({ messages: [] }))
    if (url.pathname.endsWith('/recommendations/search')) return route.fulfill(json({ recommendations: [], pois: [] }))
    if (url.pathname.endsWith('/recommendations')) {
      return route.fulfill(json({ recommendations: [], pois: [], stash: state.stash, favorites: [] }))
    }
    if (url.pathname.endsWith('/notes') && request.method() === 'GET') {
      return route.fulfill(json({ notes: state.notes }))
    }
    if (segments[3] === 'notes' && segments.length === 4 && request.method() === 'POST') {
      const note = { id: `note-${state.notes.length + 1}`, content: '', createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z' }
      state.notes.push(note)
      return route.fulfill(json({ note }, 201))
    }
    if (url.pathname.endsWith('/checklist') && request.method() === 'GET') return route.fulfill(json({ items: [] }))
    if (url.pathname.endsWith('/gallery') && request.method() === 'GET') return route.fulfill(json({ images: [] }))
    return route.fulfill(json({ error: '未处理请求' }, 404))
  })
}

function emit(page, reason, revision) {
  return page.evaluate(({ tripId, reason, revision }) => {
    window.__emitTripUpdate({
      id: `${tripId}:${revision}`,
      tripId,
      kind: 'canvas',
      reason,
      revision,
      at: new Date().toISOString(),
    })
  }, { tripId: TRIP_ID, reason, revision })
}

test('open tools and map panels refresh remote auxiliary changes without losing a note draft', async () => {
  const state = {
    notes: [{ id: 'note-remote', content: '初始内容', createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z' }],
    stash: [],
  }
  const { page, close } = await openApp({
    entry: `/?view=workbench&trip=${TRIP_ID}`,
    init: EVENT_SOURCE_INIT,
    setup: ({ page: setupPage }) => mockApi({ page: setupPage, state }),
  })

  try {
    await page.locator('#workbench-topbar').waitFor()
    await page.locator('#tools-rail [data-tool="notes"]').click()
    const editor = page.locator('[data-note-id="note-remote"] textarea')
    await editor.waitFor()

    state.notes[0].content = '远端已更新'
    await emit(page, 'note_updated', 1)
    await page.waitForFunction(() => document.querySelector('[data-note-id="note-remote"] textarea')?.value === '远端已更新')

    await editor.fill('本地未保存草稿')
    state.notes[0].content = '远端再次更新'
    await emit(page, 'note_updated', 2)
    await page.waitForTimeout(100)
    assert.equal(await editor.inputValue(), '本地未保存草稿')

    state.stash = [remoteStash]
    await emit(page, 'stash_added', 3)
    await page.locator('[data-action="map-stash-toggle"]').click()
    await page.locator('[data-stash-item="stash-remote"]').waitFor()
  } finally {
    await close()
  }
})
