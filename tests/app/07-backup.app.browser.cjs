const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { openApp } = require('../helpers/vite-app.cjs')

// Ticket 07 — accommodation backup export / import / restore (app.html entry,
// dev + preview via test:app / test:app:prod). Legacy scenarios migrated from
// tests/accommodation-backup.browser.cjs (note D part 2): real download via
// acceptDownloads, upload via #accommodation-backup-file, preview → confirm /
// 取消, invalid JSON / version / dangling stays rejection with exact strings,
// storage write failure, defaults-only restore route recovery. All assertions
// are user-visible (download payload, preview DOM, status strings, stay cards,
// route estimates) — no legacy globals.
//
// The backup entry lives INSIDE the shared accommodation dialog (ticket 07 —
// it must not depend on a manager page): #day-detail [data-accommodation-open]
// → #accommodation-backup-open → #accommodation-backup-dialog.

const STORAGE_KEY = 'hailar-slow-trip-accommodation-v1'

const base = (id, name) => ({
  id,
  name,
  type: 'hotel',
  lat: 49.31,
  lng: 119.71,
  address: '测试地址',
  notes: '测试备注',
  createdAt: '2026-09-10T00:00:00.000Z',
})

/** Legacy backup payload with explicit stays for all 6 nights. */
function backupPayload({ bases = [], stays = {}, ...extra } = {}) {
  return {
    format: 'hailar-slow-trip-accommodation',
    version: 1,
    bases,
    stays: {
      0: 'default-hailar',
      1: 'default-erguna',
      2: 'default-mordaoga',
      3: 'default-heishantou',
      4: 'default-manzhouli',
      5: 'default-hailar',
      ...stays,
    },
    ...extra,
  }
}

/** Seed localStorage with the legacy persisted payload (init self-contained). */
function seedStorage(payload) {
  const serialized = JSON.stringify(payload)

  return new Function(
    `if (!localStorage.getItem(${JSON.stringify(STORAGE_KEY)})) localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, ${JSON.stringify(serialized)});`,
  )
}

async function waitForMap(page) {
  await page.waitForSelector('#route-map.leaflet-container', { state: 'attached' })
}

async function openBackupDialog(page) {
  await page.locator('#day-detail [data-accommodation-open]').first().click()
  await page.locator('#accommodation-dialog').waitFor({ state: 'visible' })
  await page.locator('#accommodation-backup-open').click()
  await page.locator('#accommodation-backup-dialog').waitFor({ state: 'visible' })
}

async function importFile(page, name, payloadOrText, mimeType = 'application/json') {
  const buffer =
    typeof payloadOrText === 'string'
      ? Buffer.from(payloadOrText)
      : Buffer.from(JSON.stringify(payloadOrText))
  await page.locator('#accommodation-backup-file').setInputFiles({ name, mimeType, buffer })
}

test('export → import round-trip: real download, preview, confirm replaces everything and survives reload', async () => {
  const { page, close } = await openApp({
    amapConfig404: true,
    acceptDownloads: true,
    init: seedStorage({
      version: 1,
      bases: [base('custom-initial', '初始民宿')],
      stays: { 1: 'custom-initial' },
    }),
  })
  try {
    await waitForMap(page)
    // the seeded custom stay is on night 2 (day index 1)
    await page.locator('.day-button[data-day="1"]').click()
    assert.equal(await page.locator('#day-detail .stay-card strong').textContent(), '初始民宿')
    await openBackupDialog(page)
    await page.waitForFunction(
      () =>
        document.querySelector('#accommodation-backup-status')?.textContent ===
        '可导出当前安排，或选择备份文件进行预览。',
    )

    // export: real download with the legacy filename and payload
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: '导出当前备份' }).click(),
    ])
    assert.match(download.suggestedFilename(), /^hailar-accommodation-v1-\d{8}\.json$/)
    const exported = JSON.parse(await fs.readFile(await download.path(), 'utf8'))
    assert.equal(exported.format, 'hailar-slow-trip-accommodation')
    assert.equal(exported.version, 1)
    assert.deepEqual(
      exported.bases.map((item) => item.id),
      ['custom-initial'],
    )
    assert.equal(exported.stays['1'], 'custom-initial')
    assert.equal(Object.keys(exported.stays).length, 6, 'every overnight night explicit')
    assert.equal(Object.hasOwn(exported, 'amapKey'), false)

    // import a different backup: preview lists bases + nights, confirm replaces
    const replacement = backupPayload({
      bases: [base('custom-restored', '恢复后的酒店')],
      stays: { 1: 'custom-restored' },
    })
    await importFile(page, 'replacement.json', replacement)
    await page.getByText('将整体替换当前住宿安排，不会与现有数据自动合并。').waitFor()
    assert.match(
      await page.locator('#accommodation-backup-preview').innerText(),
      /文件格式 v1，包含 1 个自定义住宿基地和 6 晚住宿安排。/,
    )
    assert.match(await page.locator('#accommodation-backup-preview').innerText(), /第 2 晚/)
    assert.ok(
      (await page.locator('#accommodation-backup-preview').innerText()).includes('恢复后的酒店'),
      'preview lists the restored base',
    )
    assert.equal(await page.locator('#accommodation-backup-confirm').isEnabled(), true)
    assert.equal(
      await page.locator('#accommodation-backup-status').textContent(),
      '请检查预览，并确认是否替换当前安排。',
    )
    await page.getByRole('button', { name: '确认整体替换' }).click()
    await page.locator('#accommodation-backup-dialog').waitFor({ state: 'hidden' })

    // day 2 (index 1) now shows the restored base; 初始民宿 is gone everywhere
    await page.locator('.day-button[data-day="1"]').click()
    assert.equal(await page.locator('#day-detail .stay-card strong').textContent(), '恢复后的酒店')
    assert.equal(
      await page.locator('#accommodation-count').textContent(),
      '5',
      'hailar + erguna custom + mordaoga + heishantou + manzhouli',
    )
    await page.locator('.day-button[data-day="0"]').click()
    assert.equal(await page.locator('#day-detail .stay-card strong').textContent(), '海拉尔')

    // full replacement: the alternate 初始民宿 no longer exists in the base list
    await page.locator('#day-detail [data-accommodation-open]').first().click()
    assert.equal(
      await page
        .locator('#accommodation-base-list .accommodation-option', { hasText: '初始民宿' })
        .count(),
      0,
    )
    assert.equal(
      await page
        .locator('#accommodation-base-list .accommodation-option', { hasText: '恢复后的酒店' })
        .count(),
      1,
    )
    await page.locator('#accommodation-close').click()

    // persistence across reload
    await page.reload()
    await waitForMap(page)
    await page.locator('.day-button[data-day="1"]').click()
    assert.equal(await page.locator('#day-detail .stay-card strong').textContent(), '恢复后的酒店')
    assert.equal(await page.locator('#accommodation-count').textContent(), '5')
  } finally {
    await close()
  }
})

test('a legacy-format backup from the old site imports exactly like the legacy site did', async () => {
  const { page, close } = await openApp({
    amapConfig404: true,
    init: seedStorage({
      version: 1,
      bases: [base('custom-old', '老站点民宿')],
      stays: { 1: 'custom-old' },
    }),
  })
  try {
    await waitForMap(page)
    await page.locator('.day-button[data-day="1"]').click()
    assert.equal(await page.locator('#day-detail .stay-card strong').textContent(), '老站点民宿')
    await openBackupDialog(page)

    // byte-identical to what the legacy site exported (2-space JSON, same keys)
    const legacyFile = JSON.stringify(
      backupPayload({
        bases: [base('custom-legacy', '旧版本导入民宿')],
        stays: { 2: 'custom-legacy', 3: 'custom-legacy' },
      }),
      null,
      2,
    )
    await importFile(page, 'hailar-accommodation-v1-20260910.json', legacyFile)
    await page
      .locator('#accommodation-backup-preview')
      .getByText('旧版本导入民宿')
      .first()
      .waitFor()
    await page.getByRole('button', { name: '确认整体替换' }).click()
    await page.locator('#accommodation-backup-dialog').waitFor({ state: 'hidden' })

    await page.locator('.day-button[data-day="2"]').click()
    assert.equal(
      await page.locator('#day-detail .stay-card strong').textContent(),
      '旧版本导入民宿',
    )
    await page.locator('.day-button[data-day="3"]').click()
    assert.equal(
      await page.locator('#day-detail .stay-card strong').textContent(),
      '旧版本导入民宿',
    )
    // nights 1 and 6 went back to 海拉尔 defaults
    await page.locator('.day-button[data-day="0"]').click()
    assert.equal(await page.locator('#day-detail .stay-card strong').textContent(), '海拉尔')

    await page.reload()
    await waitForMap(page)
    await page.locator('.day-button[data-day="3"]').click()
    assert.equal(
      await page.locator('#day-detail .stay-card strong').textContent(),
      '旧版本导入民宿',
      'legacy import survives reload',
    )
  } finally {
    await close()
  }
})

test('preview then cancel writes nothing and resets the file input', async () => {
  const { page, close } = await openApp({
    amapConfig404: true,
    init: seedStorage({
      version: 1,
      bases: [base('custom-keep', '保留民宿')],
      stays: { 1: 'custom-keep' },
    }),
  })
  try {
    await waitForMap(page)
    await openBackupDialog(page)
    const cancelled = backupPayload({
      bases: [base('custom-cancelled', '取消的酒店')],
      stays: { 1: 'custom-cancelled' },
    })
    await importFile(page, 'cancelled.json', cancelled)
    await page.getByText('取消的酒店').waitFor()
    assert.equal(await page.locator('#accommodation-backup-confirm').isEnabled(), true)

    await page
      .locator('#accommodation-backup-dialog')
      .getByRole('button', { name: '取消', exact: true })
      .click()
    await page.locator('#accommodation-backup-dialog').waitFor({ state: 'hidden' })

    // nothing written: dialog base list still has the old base, stays untouched
    await page.locator('#day-detail [data-accommodation-open]').first().click()
    assert.equal(
      await page
        .locator('#accommodation-base-list .accommodation-option', { hasText: '保留民宿' })
        .count(),
      1,
    )
    assert.equal(
      await page
        .locator('#accommodation-base-list .accommodation-option', { hasText: '取消的酒店' })
        .count(),
      0,
    )
    await page.locator('#accommodation-close').click()

    // reopening the backup dialog shows no stale preview and a disabled confirm
    await openBackupDialog(page)
    assert.equal(
      await page.locator('#accommodation-backup-preview').count(),
      0,
      'preview reset after cancel',
    )
    assert.equal(await page.locator('#accommodation-backup-confirm').isDisabled(), true)
    assert.equal(
      await page.locator('#accommodation-backup-file').inputValue(),
      '',
      'file input cleared',
    )
  } finally {
    await close()
  }
})

test('invalid JSON and unsupported versions are rejected with exact messages and data intact', async () => {
  const { page, close } = await openApp({
    amapConfig404: true,
    init: seedStorage({
      version: 1,
      bases: [base('custom-keep', '保留民宿')],
      stays: { 1: 'custom-keep' },
    }),
  })
  try {
    await waitForMap(page)
    assert.equal(await page.locator('#accommodation-count').textContent(), '5')
    await openBackupDialog(page)

    const status = page.locator('#accommodation-backup-status')
    // Uploading finishes before the browser has read and validated the file.
    await importFile(page, 'broken.json', '{not valid json')
    await status
      .and(page.getByText('无法导入：备份文件不是有效的 JSON。', { exact: true }))
      .waitFor({ state: 'visible' })
    assert.equal(await page.locator('#accommodation-backup-confirm').isDisabled(), true)

    await importFile(page, 'version99.json', backupPayload({ version: 99 }))
    await status
      .and(page.getByText('无法导入：备份版本不受支持，仅支持 v1。', { exact: true }))
      .waitFor({ state: 'visible' })
    assert.equal(await page.locator('#accommodation-backup-confirm').isDisabled(), true)

    // current data untouched
    await page.locator('#accommodation-backup-close').click()
    assert.equal(await page.locator('#accommodation-count').textContent(), '5')
    await page.locator('.day-button[data-day="1"]').click()
    assert.equal(await page.locator('#day-detail .stay-card strong').textContent(), '保留民宿')
  } finally {
    await close()
  }
})

test('dangling stay reference is rejected with the exact night message and data intact', async () => {
  const { page, close } = await openApp({
    amapConfig404: true,
    init: seedStorage({
      version: 1,
      bases: [base('custom-keep', '保留民宿')],
      stays: { 1: 'custom-keep' },
    }),
  })
  try {
    await waitForMap(page)
    await openBackupDialog(page)
    const dangling = backupPayload({
      bases: [base('custom-dangling', '悬空民宿')],
      stays: { 1: 'missing-base' },
    })
    await importFile(page, 'dangling.json', dangling)
    await page.waitForFunction(
      () =>
        document.querySelector('#accommodation-backup-status')?.textContent ===
        '无法导入：第 2 晚引用了不存在的住宿基地。',
    )
    assert.equal(
      await page.locator('#accommodation-backup-status').textContent(),
      '无法导入：第 2 晚引用了不存在的住宿基地。',
    )
    assert.equal(await page.locator('#accommodation-backup-confirm').isDisabled(), true)

    await page.locator('#accommodation-backup-close').click()
    await page.locator('.day-button[data-day="1"]').click()
    assert.equal(
      await page.locator('#day-detail .stay-card strong').textContent(),
      '保留民宿',
      'data intact after dangling rejection',
    )
    assert.equal(await page.locator('#accommodation-count').textContent(), '5')
  } finally {
    await close()
  }
})

test('storage write failure during restore keeps the page state and shows the exact failure string', async () => {
  const { page, close } = await openApp({
    amapConfig404: true,
    // the seed writes at init time; the setItem patch is applied AFTER load so
    // the boot read and seed both succeed, then every write refuses
    init: seedStorage({
      version: 1,
      bases: [base('custom-keep', '保留民宿')],
      stays: { 1: 'custom-keep' },
    }),
  })
  try {
    await waitForMap(page)
    await page.evaluate(() => {
      Storage.prototype.setItem = function () {
        throw new Error('quota exceeded')
      }
    })
    await openBackupDialog(page)
    const failing = backupPayload({
      bases: [base('custom-failing', '失败酒店')],
      stays: { 1: 'custom-failing' },
    })
    await importFile(page, 'failing.json', failing)
    await page.getByText('失败酒店').waitFor()
    await page.getByRole('button', { name: '确认整体替换' }).click()

    assert.equal(
      await page.locator('#accommodation-backup-status').textContent(),
      '恢复失败：保存失败',
    )
    assert.ok(
      await page.locator('#accommodation-backup-dialog').isVisible(),
      'dialog stays open on write failure',
    )

    // page state intact — the failed restore never applied
    await page.locator('#accommodation-backup-close').click()
    await page.locator('.day-button[data-day="1"]').click()
    assert.equal(await page.locator('#day-detail .stay-card strong').textContent(), '保留民宿')
    assert.equal(await page.locator('#accommodation-count').textContent(), '5')
  } finally {
    await close()
  }
})

test('defaults-only restore puts every route back to reference (route recovery consistent)', async () => {
  const { page, close } = await openApp({
    amapConfig404: true,
    init: seedStorage({
      version: 1,
      bases: [base('custom-route', '路线民宿')],
      stays: { 0: 'custom-route' },
    }),
  })
  try {
    await waitForMap(page)
    // a changed-endpoint stay at boot shows 路线未更新 (no AMap configured)
    assert.match(await page.locator('#day-detail .route-estimate').textContent(), /路线未更新/)
    assert.equal(await page.locator('#distance-summary').textContent(), '路线未更新')

    // restore the defaults-only backup → every night back to the defaults
    await openBackupDialog(page)
    await importFile(page, 'defaults.json', backupPayload({}))
    await page.getByText('确认后将整体替换当前住宿安排，不会与现有数据自动合并。').waitFor()
    assert.match(
      await page.locator('#accommodation-backup-preview').innerText(),
      /包含 0 个自定义住宿基地和 6 晚住宿安排。/,
    )
    await page.getByRole('button', { name: '确认整体替换' }).click()
    await page.locator('#accommodation-backup-dialog').waitFor({ state: 'hidden' })

    // day 0 estimate back to the reference leg — no stale / 路线未更新 copy
    await page.waitForFunction(() =>
      /参考里程/.test(document.querySelector('#day-detail .route-estimate')?.textContent || ''),
    )
    assert.doesNotMatch(
      await page.locator('#day-detail .route-estimate').textContent(),
      /路线未更新/,
    )
    assert.equal(await page.locator('#day-detail .stay-card strong').textContent(), '海拉尔')
    assert.equal(await page.locator('#accommodation-count').textContent(), '5')
    assert.doesNotMatch(await page.locator('#distance-summary').textContent(), /路线未更新/)

    // every other day's estimate is the reference one too (day 6 = local day)
    for (const day of [1, 2, 3, 4, 5]) {
      await page.locator(`.day-button[data-day="${day}"]`).click()
      const text = await page.locator('#day-detail .route-estimate').textContent()
      assert.match(text, /参考里程/)
      assert.doesNotMatch(text, /路线未更新/)
    }
    await page.reload()
    await waitForMap(page)
    assert.equal(
      await page.locator('#accommodation-count').textContent(),
      '5',
      'defaults restore survives reload',
    )
  } finally {
    await close()
  }
})
