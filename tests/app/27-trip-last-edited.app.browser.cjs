const assert = require('node:assert/strict')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { test } = require('node:test')
const { tsImport } = require('tsx/esm/api')
const { openApp } = require('../helpers/vite-app.cjs')

const previous = '2025-06-07T08:09:00.000Z'

test('home shows persisted edit time after saving an activity note and handles old timestamps', async (t) => {
  const [{ createApp }, { createSqliteTripRepository }] = await Promise.all([
    tsImport('../../server/src/app.ts', __filename),
    tsImport('../../server/src/trips/factory.ts', __filename),
  ])
  const directory = await mkdtemp(join(tmpdir(), 'last-edited-browser-'))
  const databaseUrl = `file:${join(directory, 'trips.db')}`
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = await createSqliteTripRepository(databaseUrl)
  try {
    await store.db.run(
      `INSERT INTO trips (id, title, start_date, end_date, created_at, updated_at)
      VALUES ('target', '示例行程', '2026-11-10', '2026-11-10', ?, ?),
             ('missing', '缺少时间的行程', '2026-11-10', '2026-11-10', ?, ''),
             ('invalid', '时间无效的行程', '2026-11-10', '2026-11-10', ?, '2026-02-30T00:00:00.000Z')`,
      [previous, previous, previous, previous],
    )
    await store.db.run(
      "INSERT INTO days (id, trip_id, idx, date) VALUES ('day', 'target', 0, '2026-11-10')",
    )
    await store.db.run(
      "INSERT INTO items (id, trip_id, day_id, title, note) VALUES ('item', 'target', 'day', '示例活动', '原备注')",
    )
  } finally {
    await store.close()
  }
  const backend = await createApp({ databaseUrl })
  const { page, close } = await openApp({
    entry: '/?view=trips',
    amapConfig404: true,
    setup: async ({ page }) => {
      await page.route('**/api/trips**', async (route) => {
        const request = route.request()
        const { pathname } = new URL(request.url())
        if (pathname.endsWith('/events')) return route.abort()
        const response = await backend.request(pathname, {
          method: request.method(),
          headers: request.headers(),
          body: request.postData(),
        })
        await route.fulfill({
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body: await response.text(),
        })
      })
    },
  })
  try {
    const target = page.locator('#trip-list [data-trip-id="target"]')
    const time = target.locator('time')
    await time.waitFor()
    assert.equal(await time.getAttribute('datetime'), previous)
    const beforeLabel = await time.innerText()
    for (const id of ['missing', 'invalid']) {
      const legacy = page.locator(`#trip-list [data-trip-id="${id}"]`)
      await legacy.getByText('最后编辑：暂无记录', { exact: true }).waitFor()
      assert.equal(await legacy.locator('time').count(), 0)
    }

    await target.getByRole('heading').click()
    const activity = page.locator('[data-canvas-card="item"]')
    await activity.getByText('原备注', { exact: true }).waitFor()
    await page.locator('#workbench-back').click()
    await time.waitFor()
    assert.equal(await time.getAttribute('datetime'), previous)

    await target.getByRole('heading').click()
    await activity.locator('[data-card-note-edit]').click()
    await page.locator('[data-card-note-input]').fill('保存后的示例备注')
    const saved = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/trips/target/items/item' &&
        response.request().method() === 'PATCH',
    )
    await page.locator('[data-action="save-note"]').click()
    assert.equal((await saved).status(), 200)
    await activity.getByText('保存后的示例备注', { exact: true }).waitFor()
    await page.locator('#workbench-back').click()
    await time.waitFor()
    const edited = await time.getAttribute('datetime')
    assert.ok(Date.parse(edited) > Date.parse(previous))
    assert.notEqual(await time.innerText(), beforeLabel)

    await target.getByRole('button', { name: '置顶 示例行程', exact: true }).click()
    await target.getByText('已置顶', { exact: true }).waitFor()
    assert.equal(await time.getAttribute('datetime'), edited)
    await target.getByRole('button', { name: '取消置顶 示例行程', exact: true }).click()
    await target.getByText('已置顶', { exact: true }).waitFor({ state: 'detached' })
    await page.reload()
    await time.waitFor()
    assert.equal(await time.getAttribute('datetime'), edited)
  } finally {
    await close()
  }
})
