const assert = require('node:assert/strict')
const { test } = require('node:test')
const { tsImport } = require('tsx/esm/api')
const { openApp } = require('../helpers/vite-app.cjs')

test('home pins and unpins without navigating, restores normal order, and preserves each card', async (t) => {
  const [{ createApp }, { createSqliteTripRepository }] = await Promise.all([
    tsImport('../../server/src/app.ts', __filename),
    tsImport('../../server/src/trips/factory.ts', __filename),
  ])
  const store = await createSqliteTripRepository(':memory:')
  t.after(() => store.close())
  const backend = await createApp({ tripRepository: store.repository })
  const fixture = [
    ['lake', '湖边周末', '2026-10-02', '2026-10-03', null],
    ['mountain', '山间散步', '2026-11-06', '2026-11-08', 0],
    ['city', '城市漫游', '2026-12-05', '2026-12-06', 1],
  ]
  for (const [index, [id, title, start, end, pinned]] of fixture.entries()) {
    const created = `2026-09-0${index + 1}T00:00:00Z`
    await store.db.run(
      'INSERT INTO trips (id, title, start_date, end_date, is_pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, title, start, end, pinned, created, created],
    )
  }
  let rejectPin = true
  const { page, url, close } = await openApp({
    entry: '/?view=trips',
    amapConfig404: true,
    setup: async ({ page }) => {
      await page.route('**/api/trips**', async (route) => {
        const request = route.request()
        const { pathname } = new URL(request.url())
        if (rejectPin && pathname.endsWith('/pin')) {
          await route.fulfill({ status: 500, json: { error: '保存置顶状态失败' } })
          return
        }
        const response = await backend.request(pathname, {
          method: request.method(),
          body: request.postData(),
          headers: request.headers(),
        })
        await route.fulfill({
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body: await response.text(),
        })
      })
    },
  })
  t.after(close)
  const expectOrder = (ids) =>
    page.waitForFunction((expected) => {
      const actual = Array.from(
        document.querySelectorAll('#trip-list > li'),
        (row) => row.dataset.tripId,
      )
      return actual.join(',') === expected.join(',')
    }, ids)
  const card = (id) => page.locator(`#trip-list > [data-trip-id="${id}"]`)
  const details = () =>
    Promise.all(
      fixture.map(async ([id]) => [
        await card(id).getByRole('heading').innerText(),
        await card(id).locator('.trip-badge').innerText(),
      ]),
    )
  const normal = ['city', 'lake', 'mountain']
  const pinned = ['mountain', 'city', 'lake']
  await expectOrder(normal)
  const before = await details()
  await card('city').getByText('已置顶', { exact: true }).waitFor()

  const pin = page.getByRole('button', { name: '置顶 山间散步', exact: true })
  await pin.click()
  await page.getByRole('alert').filter({ hasText: '保存置顶状态失败' }).waitFor()
  await expectOrder(normal)
  assert.equal(page.url(), `${url}/?view=trips`)
  assert.equal(await card('mountain').getByText('已置顶', { exact: true }).count(), 0)

  rejectPin = false
  await pin.click()
  await expectOrder(pinned)
  assert.equal(page.url(), `${url}/?view=trips`)
  assert.equal(await page.locator('#workbench-topbar').count(), 0)
  await card('mountain').getByText('已置顶', { exact: true }).waitFor()
  assert.deepEqual(await details(), before)

  await page.reload()
  await expectOrder(pinned)
  await card('mountain').getByText('已置顶', { exact: true }).waitFor()
  await page.getByRole('button', { name: '取消置顶 山间散步', exact: true }).press('Enter')
  await expectOrder(normal)
  assert.equal(page.url(), `${url}/?view=trips`)
  await card('mountain').getByText('已置顶', { exact: true }).waitFor({ state: 'detached' })
  await page.reload()
  await expectOrder(normal)
  await pin.waitFor()
  await card('city').getByText('已置顶', { exact: true }).waitFor()
  assert.deepEqual(await details(), before)
})
