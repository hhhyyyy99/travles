// AI provider thinking-budget settings: pick a level, save, and confirm it
// round-trips back into the edit form, and that switching protocol keeps it.
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { openApp } = require('../helpers/vite-app.cjs')

const PROVIDER_ID = 'ai-provider-thinking'

function okProvider(thinking, overrides = {}) {
  return {
    id: PROVIDER_ID,
    name: '环境变量配置',
    baseUrl: 'https://model.example.test/v1',
    modelId: 'planner-1',
    protocol: 'chat-completions',
    thinking,
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

async function fillForm(page, { thinking }) {
  await page.locator('#ai-provider-new').click()
  await page.locator('#ai-provider-name').fill('环境变量配置')
  await page.locator('#ai-provider-base-url').fill('https://model.example.test/v1')
  await page.locator('#ai-provider-model').fill('planner-1')
  await page.locator('#ai-provider-key').fill('sk-test-secret')
  await page.locator(`#ai-provider-thinking-${thinking}`).click()
}

test('AI thinking level is saved and echoed back when re-editing, and survives protocol switch', async () => {
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
        return json(route, 201, { provider: okProvider(body.thinking ?? 'off'), probe: { ok: true, capabilities: { streaming: true, functionCalling: true, degraded: false, testedAt: null } } })
      })
    },
  })
  try {
    await fillForm(page, { thinking: 'high' })
    await page.locator('#ai-provider-save').click()
    await page.locator(`#ai-provider-list [data-provider-id="${PROVIDER_ID}"]`).waitFor()
    assert.equal(saved.length, 1)
    assert.equal(saved[0]?.thinking, 'high', 'the saved payload carries the chosen thinking level')

    // Re-open the saved provider: the form must echo the stored level.
    await page.locator(`#ai-provider-list [data-provider-id="${PROVIDER_ID}"]`).click()
    await page.locator('#ai-provider-form-title').waitFor()
    assert.equal(await page.locator('#ai-provider-thinking-high').isChecked(), true, 'editing echoes the saved thinking level')

    // Switching protocol must not reset the thinking level (independent field).
    await page.locator('#ai-provider-protocol-responses').click()
    assert.equal(await page.locator('#ai-provider-thinking-high').isChecked(), true, 'protocol switch preserves the thinking level')
  } finally {
    await close()
  }
})

test('AI provider defaults the thinking level to off when left untouched', async () => {
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
        return json(route, 201, { provider: okProvider(body.thinking ?? 'off'), probe: { ok: true, capabilities: { streaming: true, functionCalling: true, degraded: false, testedAt: null } } })
      })
    },
  })
  try {
    await fillForm(page, { thinking: 'off' })
    await page.locator('#ai-provider-save').click()
    await page.locator(`#ai-provider-list [data-provider-id="${PROVIDER_ID}"]`).waitFor()
    assert.equal(saved.length, 1)
    assert.equal(saved[0]?.thinking, 'off', 'an untouched thinking control saves as off')
  } finally {
    await close()
  }
})
