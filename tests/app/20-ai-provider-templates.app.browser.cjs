const assert = require('node:assert/strict')
const { test } = require('node:test')
const { openApp } = require('../helpers/vite-app.cjs')

const capabilities = { streaming: true, functionCalling: true, degraded: false, testedAt: null }
const templates = [
  ['deepseek', 'DeepSeek', 'https://api.deepseek.com', 'deepseek-flash'],
  ['qwen', 'Qwen（通义千问）', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen-plus'],
  ['kimi', 'Kimi', 'https://api.moonshot.cn/v1', 'kimi-k3.1-pro'],
  ['siliconflow', 'SiliconFlow（硅基流动）', 'https://api.siliconflow.cn/v1', 'deepseek-ai/DeepSeek-V4-Flash'],
  ['openai', 'OpenAI', 'https://api.openai.com/v1', 'gpt-5.4-mini'],
  ['claude', 'Claude', 'https://api.anthropic.com/v1', 'claude-sonnet-4-6'],
  ['gemini', 'Gemini', 'https://generativelanguage.googleapis.com/v1beta/openai', 'gemini-3.8-flash'],
]
function publicProvider(input = {}) {
  return {
    id: 'provider-template-test', name: input.name || '已有配置', baseUrl: input.baseUrl || 'https://gateway.example/v1',
    modelId: input.modelId || 'custom-model', protocol: input.protocol || 'responses', thinking: input.thinking || 'high',
    isDefault: input.isDefault ?? true, hasApiKey: true, headers: {}, headerNames: [], capabilities,
    lastTestedAt: null, lastError: null, createdAt: '2026-11-12T00:00:00.000Z', updatedAt: '2026-11-12T00:00:00.000Z',
  }
}
function json(route, status, body) {
  return route.fulfill({ status, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
}
async function settings({ initialProviders = [], viewport, modelsGate } = {}) {
  const saves = []
  const probes = []
  const modelRequests = []
  let providers = initialProviders
  const app = await openApp({
    entry: '/?view=settings', viewport,
    setup: async ({ page }) => {
      await page.route('**/api/**', (route) => json(route, 404, { error: '未处理请求' }))
      await page.route('**/api/settings/ai-providers', (route) => {
        if (route.request().method() === 'GET') return json(route, 200, { providers })
        const input = route.request().postDataJSON()
        saves.push(input)
        const provider = publicProvider(input)
        providers = [provider]
        return json(route, 201, { provider, probe: { ok: true, capabilities } })
      })
      await page.route('**/api/settings/ai-providers/*', async (route) => {
        const pathname = new URL(route.request().url()).pathname
        const input = route.request().postDataJSON()
        if (pathname.endsWith('/models')) {
          modelRequests.push(input)
          if (modelsGate) await modelsGate
          return json(route, 200, { models: [{ id: 'deepseek-flash' }, { id: 'old-service-model' }] })
        }
        if (pathname.endsWith('/test')) {
          probes.push(input)
          return json(route, 200, { ok: true, capabilities })
        }
        saves.push(input)
        return json(route, 200, { provider: publicProvider(input), probe: { ok: true, capabilities } })
      })
    },
  })
  await app.page.locator('#ai-provider-name').waitFor()
  return { ...app, saves, probes, modelRequests }
}

test('seven public provider templates prefill editable connection fields without saving or probing', async () => {
  const { page, close, saves, probes, modelRequests } = await settings()
  try {
    await page.locator('#ai-provider-new').click()
    const select = page.getByRole('combobox', { name: '服务商模板', exact: true })
    assert.equal(await select.locator('option').count(), 8)
    for (const [id, name, baseUrl, modelId] of templates) {
      await select.selectOption(id)
      assert.equal(await page.locator('#ai-provider-name').inputValue(), name)
      assert.equal(await page.locator('#ai-provider-base-url').inputValue(), baseUrl)
      assert.equal(await page.locator('#ai-provider-model').inputValue(), modelId)
      assert.equal(await page.locator('#ai-provider-protocol-chat-completions').isChecked(), true)
      assert.equal(await page.locator('#ai-provider-thinking-off').isChecked(), true)
      assert.equal(await page.locator('#ai-provider-default').isChecked(), true)
      assert.equal(await page.locator('#ai-provider-key').inputValue(), '')
      assert.equal(await page.locator('#ai-provider-headers').inputValue(), '')
      assert.equal(await page.getByRole('link', { name: '接入文档' }).isVisible(), true)
    }
    assert.equal(saves.length, 0)
    assert.equal(probes.length, 0)
    assert.equal(modelRequests.length, 0)
  } finally { await close() }
})

test('Kimi K3 offers its supported effort choices and rejects a stale medium override', async () => {
  const { page, close, saves } = await settings()
  try {
    await page.locator('#ai-provider-template').selectOption('kimi')
    assert.equal(await page.locator('#ai-provider-thinking-medium').isDisabled(), true)
    assert.equal(await page.locator('#ai-provider-thinking-low').isEnabled(), true)
    assert.equal(await page.locator('#ai-provider-thinking-high').isEnabled(), true)
    await page.locator('#ai-provider-template').selectOption('openai')
    assert.equal(await page.locator('#ai-provider-thinking-medium').isEnabled(), true)
    await page.locator('#ai-provider-thinking-medium').click()
    await page.locator('#ai-provider-model').fill('kimi-k3.1-pro')
    await page.locator('#ai-provider-key').fill('test-key')
    await page.locator('#ai-provider-save').click()
    assert.ok((await page.locator('[role="alert"]').innerText()).includes('Kimi K3 不支持中档位'))
    assert.equal(saves.length, 0)
  } finally { await close() }
})

test('switching templates clears unsaved credentials, capabilities and the previous provider model list', async () => {
  const { page, close, saves } = await settings()
  try {
    await page.locator('#ai-provider-template').selectOption('deepseek')
    await page.locator('#ai-provider-key').fill('test-old-provider-key')
    await page.locator('#ai-provider-headers').fill('{"X-Workspace":"old-provider-header"}')
    await page.locator('#ai-provider-test').click()
    await page.locator('[data-capability-status]').waitFor()
    await page.locator('#ai-provider-models').click()
    await page.locator('#ai-provider-model-listbox').waitFor()
    await page.locator('#ai-provider-default').check()
    await page.locator('#ai-provider-template').selectOption('qwen')
    assert.equal(await page.locator('#ai-provider-key').inputValue(), '')
    assert.equal(await page.locator('#ai-provider-headers').inputValue(), '')
    assert.equal(await page.locator('[data-capability-status]').count(), 0)
    assert.equal(await page.locator('#ai-provider-default').isChecked(), true)
    await page.locator('#ai-provider-model').fill('')
    assert.equal(await page.locator('#ai-provider-model-listbox').count(), 0)
    await page.locator('#ai-provider-model').fill('qwen-plus')
    await page.locator('#ai-provider-save').click()
    assert.ok((await page.locator('[role="alert"]').innerText()).includes('API Key'))
    assert.equal(saves.length, 0)
    await page.locator('#ai-provider-template').selectOption('')
    assert.equal(await page.locator('#ai-provider-base-url').inputValue(), '')
    assert.equal(await page.locator('#ai-provider-name').inputValue(), '')
    assert.equal(await page.locator('#ai-provider-model').inputValue(), '')
  } finally { await close() }
})

test('a customized template saves through the existing API, with protocol and thinking independent', async () => {
  const { page, close, saves } = await settings()
  try {
    await page.locator('#ai-provider-template').selectOption('openai')
    await page.locator('#ai-provider-model').fill('my-custom-route')
    await page.locator('#ai-provider-base-url').fill('https://my-gateway.example/v1')
    await page.locator('#ai-provider-protocol-responses').click()
    await page.locator('#ai-provider-thinking-high').click()
    assert.equal(await page.locator('#ai-provider-protocol-responses').isChecked(), true)
    assert.equal(await page.locator('#ai-provider-thinking-high').isChecked(), true)
    await page.locator('#ai-provider-key').fill('test-new-provider-key')
    await page.locator('#ai-provider-save').click()
    await page.getByRole('heading', { name: '编辑 AI 配置', exact: true }).waitFor()
    assert.equal(saves.length, 1)
    assert.equal(saves[0].baseUrl, 'https://my-gateway.example/v1')
    assert.equal(saves[0].modelId, 'my-custom-route')
    assert.equal(saves[0].protocol, 'responses')
    assert.equal(saves[0].thinking, 'high')
    assert.equal(saves[0].apiKey, 'test-new-provider-key')
    assert.equal('templateId' in saves[0], false)
    assert.equal(await page.locator('#ai-provider-template').count(), 0)
    assert.equal(await page.locator('#ai-provider-key').inputValue(), '')
  } finally { await close() }
})

test('editing a saved custom provider never applies a template or replaces its stored connection fields', async () => {
  const existing = publicProvider()
  const { page, close, saves } = await settings({ initialProviders: [existing] })
  try {
    await page.locator('[data-provider-id="provider-template-test"] button').first().click()
    assert.equal(await page.locator('#ai-provider-template').count(), 0)
    assert.equal(await page.locator('#ai-provider-base-url').inputValue(), existing.baseUrl)
    assert.equal(await page.locator('#ai-provider-model').inputValue(), existing.modelId)
    assert.equal(await page.locator('#ai-provider-protocol-responses').isChecked(), true)
    assert.equal(await page.locator('#ai-provider-thinking-high').isChecked(), true)
    assert.equal(await page.locator('#ai-provider-key').inputValue(), '')
    await page.locator('#ai-provider-name').fill('只改名称')
    await page.locator('#ai-provider-save').click()
    await page.getByRole('status').waitFor()
    assert.equal(saves.length, 1)
    assert.equal(saves[0].baseUrl, existing.baseUrl)
    assert.equal(saves[0].modelId, existing.modelId)
    assert.equal('apiKey' in saves[0], false)
  } finally { await close() }
})

test('template selection is disabled while a provider request is pending', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const { page, close } = await settings({ modelsGate: gate })
  try {
    await page.locator('#ai-provider-template').selectOption('deepseek')
    await page.locator('#ai-provider-key').fill('test-key')
    const request = page.waitForRequest('**/api/settings/ai-providers/models')
    await page.locator('#ai-provider-models').click()
    await request
    assert.equal(await page.locator('#ai-provider-template').isDisabled(), true)
    release()
    await page.locator('#ai-provider-model-listbox').waitFor()
    await page.locator('#ai-provider-template').selectOption('gemini')
    assert.equal(await page.locator('#ai-provider-model').inputValue(), 'gemini-3.8-flash')
  } finally { release(); await close() }
})

test('the template control supports keyboard selection on a narrow viewport without horizontal overflow', async () => {
  const { page, close } = await settings({ viewport: { width: 390, height: 844 } })
  try {
    const select = page.getByRole('combobox', { name: '服务商模板', exact: true })
    await select.focus()
    // Native select type-ahead works across platforms without relying on
    // OS-specific popup arrow-key behavior in headless Chromium.
    await select.press('d')
    await select.press('Enter')
    assert.equal(await page.locator('#ai-provider-name').inputValue(), 'DeepSeek')
    const dimensions = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }))
    assert.ok(dimensions.scrollWidth <= dimensions.width)
    assert.equal(await select.evaluate((element) => element.getBoundingClientRect().height >= 44), true)
  } finally { await close() }
})
