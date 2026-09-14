// Model ID combobox: after fetching the model list, the field becomes a
// filterable dropdown. Items are clickable to fill the input; typing filters
// locally; typing an id not in the list still saves.
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { openApp } = require('../helpers/vite-app.cjs')

const PROVIDER_ID = 'ai-provider-combobox'

const MODELS = [
  { id: 'gpt-4o' },
  { id: 'gpt-4o-mini' },
  { id: 'o3-mini' },
  { id: 'claude-3-5-sonnet' },
]

function okProvider(modelId, overrides = {}) {
  return {
    id: PROVIDER_ID,
    name: '组合框配置',
    baseUrl: 'https://model.example.test/v1',
    modelId,
    protocol: 'chat-completions',
    thinking: 'off',
    isDefault: true,
    hasApiKey: true,
    headers: {},
    headerNames: [],
    capabilities: { streaming: true, functionCalling: true, degraded: false, testedAt: null },
    lastTestedAt: null,
    lastError: null,
    createdAt: '2026-09-12T00:00:00.000Z',
    updatedAt: '2026-09-12T00:00:00.000Z',
    ...overrides,
  }
}

function json(route, status, body) {
  return route.fulfill({ status, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
}

async function newForm(page) {
  await page.locator('#ai-provider-new').click()
  await page.locator('#ai-provider-name').fill('组合框配置')
  await page.locator('#ai-provider-base-url').fill('https://model.example.test/v1')
  await page.locator('#ai-provider-model').fill('placeholder-model')
  await page.locator('#ai-provider-key').fill('sk-test-secret')
}

test('model list becomes a filterable dropdown; click fills, filter narrows, custom id saves', async () => {
  const saved = []
  const { page, close } = await openApp({
    entry: '/?view=settings',
    setup: async ({ page }) => {
      await page.route('**/api/**', (route) => json(route, 404, { error: '未处理请求' }))
      await page.route('**/api/settings/ai-providers', async (route) => {
        const request = route.request()
        if (request.method() === 'GET') return json(route, 200, { providers: [] })
        const body = request.postDataJSON()
        saved.push(body)
        return json(route, 201, { provider: okProvider(body.modelId), probe: { ok: true, capabilities: { streaming: true, functionCalling: true, degraded: false, testedAt: null } } })
      })
      // Registered after the general route so it wins for the models path.
      await page.route('**/api/settings/ai-providers/models', async (route) => {
        const request = route.request()
        if (request.method() !== 'POST') return route.fallback()
        return json(route, 200, { models: MODELS })
      })
    },
  })
  try {
    await newForm(page)

    // Fetch models: the dropdown appears. Clear the prefilled guess so the
    // full list is visible (empty keyword shows everything).
    await page.locator('#ai-provider-models').click()
    const listbox = page.locator('#ai-provider-model-listbox')
    await listbox.waitFor()
    await page.locator('#ai-provider-model').fill('')
    await listbox.waitFor()
    assert.equal(await listbox.locator('[role="option"]').count(), MODELS.length, 'all models render in the dropdown')

    // Click an item: the input adopts that model id and the dropdown closes.
    await listbox.locator('[role="option"]', { hasText: 'o3-mini' }).click()
    assert.equal(await page.locator('#ai-provider-model').inputValue(), 'o3-mini', 'clicking an option fills the input')
    assert.equal(await listbox.count(), 0, 'dropdown closes after selecting')

    // Type a keyword: the dropdown reopens and filters locally.
    await page.locator('#ai-provider-model').fill('gpt')
    await listbox.waitFor()
    const filtered = listbox.locator('[role="option"]')
    assert.equal(await filtered.count(), 2, 'keyword filters the list to gpt models')
    for (const text of await filtered.allInnerTexts()) assert.ok(text.startsWith('gpt'), 'every filtered option matches the keyword')

    // Empty keyword shows the full list again.
    await page.locator('#ai-provider-model').fill('')
    assert.equal(await listbox.locator('[role="option"]').count(), MODELS.length, 'empty keyword shows all models')

    // Hand-type an id absent from the list and save: it must persist.
    await page.locator('#ai-provider-model').fill('my-custom-route-9')
    await page.locator('#ai-provider-save').click()
    await page.locator(`#ai-provider-list [data-provider-id="${PROVIDER_ID}"]`).waitFor()
    assert.equal(saved.length, 1)
    assert.equal(saved[0]?.modelId, 'my-custom-route-9', 'a hand-typed id outside the list still saves')
  } finally {
    await close()
  }
})

test('model list fetch failure keeps manual entry working', async () => {
  const { page, close } = await openApp({
    entry: '/?view=settings',
    setup: async ({ page }) => {
      await page.route('**/api/**', (route) => json(route, 404, { error: '未处理请求' }))
      await page.route('**/api/settings/ai-providers', async (route) => {
        const request = route.request()
        if (request.method() === 'GET') return json(route, 200, { providers: [] })
        return json(route, 201, { provider: okProvider(request.postDataJSON().modelId), probe: { ok: true, capabilities: { streaming: true, functionCalling: true, degraded: false, testedAt: null } } })
      })
      await page.route('**/api/settings/ai-providers/models', async (route) => {
        const request = route.request()
        if (request.method() !== 'POST') return route.fallback()
        return json(route, 500, { error: '网关无响应' })
      })
    },
  })
  try {
    await newForm(page)
    await page.locator('#ai-provider-models').click()
    // Error is surfaced, the alert region shows it, and no dropdown appears.
    await page.locator('[role="alert"]').waitFor()
    assert.equal(await page.locator('#ai-provider-model-listbox').count(), 0, 'no dropdown when the fetch fails')
    assert.ok((await page.locator('[role="alert"]').innerText()).includes('网关无响应'), 'failure message is visible to the user')
    // Manual entry is unblocked.
    assert.equal(await page.locator('#ai-provider-model').isEnabled(), true)
  } finally {
    await close()
  }
})
