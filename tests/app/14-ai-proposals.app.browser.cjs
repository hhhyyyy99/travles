// Ticket 13 — proposal-only AI flows. The browser test keeps the mock API
// stateful so canceling leaves the canvas unchanged and confirmation redraws it.
const test = require('node:test')
const assert = require('node:assert/strict')
const { openApp } = require('../helpers/vite-app.cjs')

const TRIP_ID = 'trip-ai-proposals-1'
const tripPayload = {
  id: TRIP_ID,
  title: '呼伦贝尔慢游',
  startDate: '2026-10-02',
  endDate: '2026-10-03',
  days: 2,
  nights: 1,
  createdAt: '2026-09-12T00:00:00.000Z',
  updatedAt: '2026-09-12T00:00:00.000Z',
}

function freshHarness() {
  return {
    calls: { proposal: [], apply: [], cancel: [] },
    state: {
      nextProposal: 0,
      failApplyOnce: false,
      days: [
        {
          id: 'day-1', index: 0, date: '2026-10-02', theme: '抵达海拉尔', color: '#c26d4f',
          items: [
            { id: 'item-a', dayId: 'day-1', order: 0, type: 'attraction', title: '莫尔格勒河', note: '', poi: { name: '莫尔格勒河', lat: 49.4, lng: 119.8 }, images: [], pending: false },
            { id: 'item-b', dayId: 'day-1', order: 1, type: 'food', title: '草原晚餐', note: '', poi: null, images: [], pending: false },
          ],
        },
        { id: 'day-2', index: 1, date: '2026-10-03', theme: '穿越草原', color: '#3f7d5c', items: [] },
      ],
      legs: [],
      proposals: new Map(),
    },
  }
}

function json(route, status, body) {
  return route.fulfill({ status, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
}

async function mockApi(harness, { page }) {
  const { state, calls } = harness
  await page.route('**/api/trips', (route) => json(route, 200, { trips: [tripPayload] }))
  await page.route('**/api/trips/*/canvas', (route) => json(route, 200, { trip: tripPayload, days: state.days, legs: state.legs }))
  await page.route('**/api/trips/*/messages', (route) => {
    if (route.request().method() === 'GET') return json(route, 200, { messages: [] })
    return json(route, 200, {})
  })
  await page.route('**/api/trips/*/ai/proposals', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    const input = route.request().postDataJSON() || {}
    const id = `proposal-${++state.nextProposal}`
    const kind = input.kind
    const targetDayId = kind === 'day-optimize' ? input.dayId : undefined
    const patch = kind === 'parse'
      ? { ops: [{ op: 'add_item', itemId: `parsed-${id}`, dayId: 'day-1', order: 2, type: 'attraction', title: '额尔古纳湿地', pending: true }] }
      : { ops: [{ op: 'move_item', itemId: 'item-b', dayId: targetDayId || 'day-1', order: 0 }] }
    const proposal = {
      id, tripId: TRIP_ID, kind, targetDayId,
      title: kind === 'parse' ? '攻略解析建议' : kind === 'day-optimize' ? 'D1 天级优化建议' : '全局路线优化建议',
      summary: kind === 'parse' ? '解析出 1 个待确认景点。' : '减少折返，调整卡片顺序。',
      diff: [{ action: kind === 'parse' ? 'add' : 'move', label: kind === 'parse' ? '新增额尔古纳湿地' : '调整草原晚餐顺序', detail: '确认后才会写入' }],
      items: kind === 'parse' ? [{ itemId: `parsed-${id}`, dayId: 'day-1', order: 2, type: 'attraction', title: '额尔古纳湿地', pending: true }] : undefined,
      patch, createdAt: '2026-09-12T00:00:00.000Z',
    }
    state.proposals.set(id, proposal)
    calls.proposal.push({ kind, input })
    return json(route, 201, { proposal })
  })
  await page.route('**/api/trips/*/ai/proposals/*/apply', async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2)
    const proposal = state.proposals.get(id)
    if (!proposal) return json(route, 404, { error: '建议不存在' })
    calls.apply.push(id)
    if (state.failApplyOnce) {
      state.failApplyOnce = false
      return json(route, 422, { error: 'TripPatch 校验失败', guidance: '请重试' })
    }
    const op = proposal.patch.ops[0]
    if (op.op === 'add_item') {
      const day = state.days.find((entry) => entry.id === op.dayId)
      day.items.push({ id: op.itemId, dayId: op.dayId, order: op.order, type: op.type, title: op.title, note: '', poi: null, images: [], pending: true })
    } else {
      const day = state.days.find((entry) => entry.id === op.dayId)
      const item = day.items.find((entry) => entry.id === op.itemId)
      day.items = [item, ...day.items.filter((entry) => entry.id !== op.itemId)].map((entry, index) => ({ ...entry, order: index }))
    }
    state.proposals.delete(id)
    return json(route, 200, { proposalId: id, appliedPatch: { summary: '建议已应用', stats: { itemsUpdated: 1 }, patch: proposal.patch } })
  })
  await page.route('**/api/trips/*/ai/proposals/*', async (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback()
    const id = new URL(route.request().url()).pathname.split('/').at(-1)
    calls.cancel.push(id)
    state.proposals.delete(id)
    return json(route, 200, { ok: true })
  })
}

test('smart parse previews structured items, cancel leaves canvas unchanged, confirm redraws it', async () => {
  const harness = freshHarness()
  const { page, close } = await openApp({ entry: `/?view=workbench&trip=${TRIP_ID}`, amapConfig404: true, setup: (ctx) => mockApi(harness, ctx) })
  try {
    await page.locator('#chat-list').waitFor()
    await page.locator('#chat-input').fill('D1 下午去莫尔格勒河，晚上住宿待定')
    await page.locator('[data-action="ai-parse"]').click()
    await page.locator('[data-ai-proposal-kind="parse"]').waitFor()
    assert.ok((await page.locator('[data-ai-proposal-items]').textContent()).includes('1 个行程项'))
    assert.equal(await page.locator('[data-canvas-card="parsed-proposal-1"]').count(), 0)

    await page.locator('[data-ai-proposal-cancel]').click()
    assert.equal(await page.locator('[data-ai-proposal]').count(), 0)
    assert.equal(harness.calls.apply.length, 0)

    await page.locator('[data-action="ai-parse"]').click()
    await page.locator('[data-ai-proposal-confirm]').click()
    await page.locator('[data-canvas-card="parsed-proposal-2"]').waitFor()
    assert.equal(harness.calls.apply.length, 1)
    assert.ok((await page.locator('[data-ai-proposal-applied]').textContent()).includes('建议已应用'))
  } finally {
    await close()
  }
})

test('route optimize and the day wand both target their requested scope', async () => {
  const harness = freshHarness()
  const { page, close } = await openApp({ entry: `/?view=workbench&trip=${TRIP_ID}`, amapConfig404: true, setup: (ctx) => mockApi(harness, ctx) })
  try {
    await page.locator('#workbench-topbar').waitFor()
    await page.locator('[data-action="route-optimize"]').click()
    await page.locator('[data-ai-proposal-kind="optimize"]').waitFor()
    assert.equal(harness.calls.proposal[0].kind, 'optimize')
    await page.locator('[data-ai-proposal-cancel]').click()
    assert.equal(harness.calls.apply.length, 0)

    await page.locator('[data-action="view-list"]').click()
    await page.locator('[data-list-day="day-1"]').waitFor()
    await page.locator('[data-action="optimize-day"][data-day-id="day-1"]').click()
    await page.locator('[data-ai-proposal-kind="day-optimize"]').waitFor()
    assert.equal(harness.calls.proposal[1].input.dayId, 'day-1')
    await page.locator('[data-ai-proposal-confirm]').click()
    await page.locator('[data-ai-proposal-status="applied"]').waitFor()
    assert.equal(harness.calls.apply.length, 1)
    assert.equal(harness.state.days[0].items[0].id, 'item-b')
    assert.equal(harness.state.days[1].items.length, 0, 'day wand did not touch another day')
  } finally {
    await close()
  }
})

test('an apply failure keeps the original parse request available for retry', async () => {
  const harness = freshHarness()
  harness.state.failApplyOnce = true
  const { page, close } = await openApp({ entry: `/?view=workbench&trip=${TRIP_ID}`, amapConfig404: true, setup: (ctx) => mockApi(harness, ctx) })
  try {
    const text = 'D1 下午去莫尔格勒河，晚上住宿待定'
    await page.locator('#chat-list').waitFor()
    await page.locator('#chat-input').fill(text)
    await page.locator('[data-action="ai-parse"]').click()
    await page.locator('[data-ai-proposal-confirm]').click()
    await page.locator('[data-ai-proposal-status="error"]').waitFor()
    await page.locator('[data-ai-proposal-retry]').click()
    await page.locator('[data-ai-proposal-status="ready"]').waitFor()
    assert.equal(harness.calls.proposal[1].input.text, text)
  } finally {
    await close()
  }
})
