// Ticket 09 — cutover acceptance: the root entry serves the React app,
// production assets load, and the accommodation main flow works through it.
const test = require('node:test')
const assert = require('node:assert/strict')
const { openApp } = require('../helpers/vite-app.cjs')

test('root entry renders the full React app with both map and detail', async () => {
  const { page, close } = await openApp()
  try {
    await page.locator('#route-map').waitFor()
    await page.locator('#days .day-button').first().waitFor()
    await page.locator('#day-detail').waitFor()
    assert.equal(await page.locator('#days').count(), 1)
    assert.ok((await page.locator('#day-detail').textContent()).length > 50)
  } finally {
    await close()
  }
})

test('production preview serves the entry with hashed assets and vendor script', async () => {
  const { page, close } = await openApp({ mode: 'preview' })
  try {
    await page.goto(`${page.url().replace(/\/$/, '')}/`)
    await page.locator('#route-map').waitFor()
    // vendored classic script must load from /vendor/coordtransform.js
    const hasTransform = await page.evaluate(() => typeof window.coordtransform?.wgs84togcj02 === 'function')
    assert.equal(hasTransform, true)
    const assets = await page.evaluate(() =>
      performance.getEntriesByType('resource').map((r) => r.name).filter((n) => n.includes('/assets/')),
    )
    assert.ok(assets.length >= 2, `expected hashed css+js assets, got ${assets.length}`)
  } finally {
    await close()
  }
})

test('accommodation save through the root entry survives reload (preview)', async () => {
  const { page, close } = await openApp({ mode: 'preview' })
  try {
    await page.locator('#route-map').waitFor()
    await page.locator('#day-detail [data-accommodation-open]').click()
    await page.getByRole('button', { name: '新增住宿基地', exact: true }).click()
    await page.getByLabel('基地名称', { exact: true }).fill('cutover 测试基地')
    await page.getByRole('button', { name: '在地图上选点', exact: true }).click()
    await page.locator('#route-map').click({ position: { x: 260, y: 260 } })
    await page.getByRole('button', { name: '保存并应用', exact: true }).click()
    await page.waitForSelector('#day-detail .stay-card :text("cutover 测试基地")')
    await page.reload()
    await page.locator('#route-map').waitFor()
    await page.waitForSelector('#day-detail .stay-card :text("cutover 测试基地")')
  } finally {
    await close()
  }
})

test('legacy-format accommodation storage renders through the root entry', async () => {
  await openApp({
    init: () => {
      localStorage.setItem(
        'hailar-slow-trip-accommodation-v1',
        JSON.stringify({
          version: 1,
          bases: [
            {
              id: 'legacy-1',
              name: '旧版基地',
              type: 'hotel',
              lat: 49.21,
              lng: 119.77,
              address: '旧地址',
              notes: '旧备注',
              createdAt: '2026-09-01T00:00:00.000Z',
              isDefault: false,
            },
          ],
          stays: { 0: 'legacy-1', 1: 'legacy-1' },
        }),
      )
    },
  }).then(async ({ page, close }) => {
    try {
      await page.locator('#route-map').waitFor()
      await page.waitForSelector('#day-detail .stay-card :text("旧版基地")')
      assert.equal(await page.locator('#accommodation-count').textContent(), '5') // legacy-1 + 4 default bases for nights 2–5
    } finally {
      await close()
    }
  })
})