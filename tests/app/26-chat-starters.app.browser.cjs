const assert = require('node:assert/strict')
const { test } = require('node:test')
const { openApp } = require('../helpers/vite-app.cjs')

const title = '成都周末行程'
const tripId = 'trip-manual-chengdu'
const startDate = '2026-12-05'
const endDate = '2026-12-06'

function isPostTo(request, pathname) {
  return request.method() === 'POST' && new URL(request.url()).pathname === pathname
}

test('empty chat suggestions send their visible text to the manually created trip', async () => {
  const { page, close } = await openApp({
    entry: '/?view=trips',
    amapConfig404: true,
    setup: async ({ page }) => {
      let trip
      await page.route('**/api/trips', (route) => {
        if (route.request().method() !== 'POST') {
          return route.fulfill({ json: { trips: trip ? [trip] : [] } })
        }
        trip = {
          ...route.request().postDataJSON(),
          id: tripId,
          days: 2,
          nights: 1,
          createdAt: '',
          updatedAt: '',
        }
        return route.fulfill({ status: 201, json: { trip } })
      })
      await page.route(`**/api/trips/${tripId}/canvas`, (route) =>
        route.fulfill({ json: { trip, days: [], legs: [] } }),
      )
      await page.route('**/api/trips/*/messages', (route) =>
        route.request().method() === 'GET'
          ? route.fulfill({ json: { messages: [] } })
          : route.fulfill({ status: 503, json: { error: 'No AI provider in this test' } }),
      )
    },
  })

  try {
    await page.locator('#trip-list-empty').waitFor()
    const form = page.locator('#trip-create-form')
    await form.getByLabel('行程标题').fill(title)
    await form.getByLabel('开始日期').fill(startDate)
    await form.getByLabel('结束日期').fill(endDate)
    const [create] = await Promise.all([
      page.waitForRequest((request) => isPostTo(request, '/api/trips')),
      form.getByRole('button', { name: '创建行程' }).click(),
    ])
    assert.deepEqual(create.postDataJSON(), { title, startDate, endDate })

    const row = page.getByRole('heading', { name: title, exact: true })
    const expectedStarters = [
      '这趟行程怎么安排才不赶？',
      '沿路有哪些值得吃的和值得带的？',
      '帮我把路线顺一顺，少绕路、多玩几个地方',
    ]
    for (const [index, expected] of expectedStarters.entries()) {
      await row.click()
      await page.getByRole('heading', { name: title, exact: true }).waitFor()
      const chip = page.locator('[data-chat-starters]').getByRole('button').nth(index)
      await chip.waitFor({ state: 'visible' })
      const label = await chip.innerText()
      const [send] = await Promise.all([
        page.waitForRequest(
          (request) =>
            request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/messages'),
        ),
        chip.click(),
      ])
      assert.deepEqual(
        { label, path: new URL(send.url()).pathname, content: send.postDataJSON().content },
        { label: expected, path: `/api/trips/${tripId}/messages`, content: expected },
      )
      await page.getByRole('button', { name: '返回行程列表' }).click()
    }
  } finally {
    await close()
  }
})
