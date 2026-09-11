const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openApp } = require('../helpers/vite-app.cjs');

// Ticket 04 part B — accommodation creation dialog, map picking, stay card and
// summary strip (app.html entry). All assertions are user-visible behaviour:
// the DOM/aria contract from note B §6 (accommodation-* ids/data-*/labels) and
// note A §5 (stay-card / #accommodation-count / #stay-note-text), driven like
// the legacy `createBase` helper flow (note D part 2 conventions: open the
// stay-card button → 新增住宿基地 → fill 基地名称 → 在地图上选点 → click #route-map
// → check nights → 保存并应用 / 仅保存为备选).

const MISSING_VALIDATION = '请填写基地名称，并在地图上确认有效位置。';
const WRITE_FAILURE_STATUS = '当前浏览器未允许保存，住宿安排未改变。';

async function waitForMap(page) {
  await page.waitForSelector('#route-map.leaflet-container');
}

async function openAccommodationDialog(page) {
  await page.locator('#day-detail [data-accommodation-open]').first().click();
  await page.locator('#accommodation-dialog').waitFor({ state: 'visible' });
}

/**
 * Legacy helper flow (tests/helpers/browser.cjs `createBase`): fill the name,
 * open the picker, click the Leaflet map to confirm a position, then save.
 * Returns after the editor is open again with coordinates set.
 */
async function createDraftWithPosition(page, name) {
  await page.getByRole('button', { name: '新增住宿基地' }).click();
  await page.locator('#accommodation-new-name').fill(name);
  await page.getByRole('button', { name: '在地图上选点' }).click();
  await page.locator('#accommodation-map-picker').waitFor({ state: 'visible' });
  await page.locator('#route-map').click({ position: { x: 250, y: 250 } });
  await page.locator('#accommodation-new-lat').waitFor({ state: 'visible' });
  assert.notEqual(await page.locator('#accommodation-new-lat').inputValue(), '', 'lat set after map pick');
  assert.notEqual(await page.locator('#accommodation-new-lng').inputValue(), '', 'lng set after map pick');
}

test('creating a base via the dialog applies to checked nights, updates count + stay note and survives reload', async () => {
  const { page, close } = await openApp({ amapConfig404: true });
  try {
    await waitForMap(page);
    await openAccommodationDialog(page);
    await createDraftWithPosition(page, '浏览器验收民宿');
    assert.match(await page.locator('#accommodation-location-summary').textContent(), /已选择 /);
    assert.equal(
      await page.locator('#accommodation-dialog-title').textContent(),
      '第 1 天 · 更换住宿',
      'dialog opens for the currently selected day',
    );
    await page.locator('input[name="accommodation-nights"][value="0"]').check();
    await page.locator('input[name="accommodation-nights"][value="5"]').check();
    await page.getByRole('button', { name: '保存并应用' }).click();
    await page.locator('#accommodation-dialog').waitFor({ state: 'hidden' });

    // stay card, count and stay-note all update. The custom base replaces the
    // 海拉尔 stays on both night 1 and night 6, so the distinct base count
    // stays 5 (legacy core:7 asserts exactly this).
    assert.equal(await page.locator('#day-detail .stay-card strong').textContent(), '浏览器验收民宿');
    assert.equal(await page.locator('#accommodation-count').textContent(), '5', 'custom replaces both hailar nights — still 5 distinct');
    // consecutive-only grouping: night 1 and night 6 are separated, so the
    // same custom base appears as two `1 晚` groups (trip.js:213–221)
    const noteText1 = await page.locator('#stay-note-text').textContent();
    assert.equal((noteText1.match(/浏览器验收民宿 1 晚/g) || []).length, 2, 'custom stay grouped per run');
    assert.ok(
      await page.locator('#stay-note-text small').textContent().then((t) => t.includes('10/2 · 10/7 · 10/3 · 10/4 · 10/5 · 10/6')),
      'trailing date small line stays',
    );
    // the same stay applies to both checked nights
    await page.locator('.day-button[data-day="5"]').click();
    assert.equal(await page.locator('#day-detail .stay-card strong').textContent(), '浏览器验收民宿', 'night 6 applied too');

    // persistence: reload restores the custom stay and the count
    await page.reload();
    await waitForMap(page);
    assert.equal(await page.locator('#day-detail .stay-card strong').textContent(), '浏览器验收民宿');
    assert.equal(await page.locator('#accommodation-count').textContent(), '5');
    const noteText2 = await page.locator('#stay-note-text').textContent();
    assert.equal((noteText2.match(/浏览器验收民宿 1 晚/g) || []).length, 2, 'stay-note grouping survives reload');
    await page.locator('.day-button[data-day="5"]').click();
    assert.equal(await page.locator('#day-detail .stay-card strong').textContent(), '浏览器验收民宿');
  } finally {
    await close();
  }
});

test('saving as alternate keeps the dialog open, lists the base, and does not inflate the count', async () => {
  const { page, close } = await openApp({ amapConfig404: true });
  try {
    await waitForMap(page);
    await openAccommodationDialog(page);
    await createDraftWithPosition(page, '备选民宿');
    // alternate: no night is applied
    await page.locator('input[name="accommodation-nights"][value="0"]').uncheck();
    await page.getByRole('button', { name: '仅保存为备选' }).click();

    assert.equal(
      await page.locator('#accommodation-dialog-status').textContent(),
      '已保存为备选住宿基地。',
    );
    assert.ok(await page.locator('#accommodation-dialog').isVisible(), 'dialog stays open after alternate save');
    assert.equal(await page.locator('#accommodation-editor').isHidden(), true, 'editor hides after alternate save');
    assert.notEqual(await page.locator('#day-detail .stay-card strong').textContent(), '备选民宿');
    assert.equal(await page.locator('#accommodation-count').textContent(), '5', 'alternates never count');
    // still listed in the dialog base list
    assert.equal(
      await page.locator('#accommodation-base-list .accommodation-option', { hasText: '备选民宿' }).count(),
      1,
      'alternate base listed in the dialog',
    );

    await page.locator('#accommodation-close').click();
    await page.reload();
    await waitForMap(page);
    assert.equal(await page.locator('#accommodation-count').textContent(), '5', 'alternate persists but never counts');
    await openAccommodationDialog(page);
    assert.equal(
      await page.locator('#accommodation-base-list .accommodation-option', { hasText: '备选民宿' }).count(),
      1,
      'alternate survives reload and stays listed',
    );
  } finally {
    await close();
  }
});

test('selecting an existing base applies it to the open night and persists', async () => {
  const { page, close } = await openApp({ amapConfig404: true });
  try {
    await waitForMap(page);
    await page.locator('.day-button[data-day="2"]').click();
    await openAccommodationDialog(page);
    assert.equal(await page.locator('#accommodation-dialog-title').textContent(), '第 3 天 · 更换住宿');
    await page.locator('[data-accommodation-select="default-erguna"]').click();
    assert.match(await page.locator('#accommodation-selected-label').textContent(), /已选择：额尔古纳/);
    await page.locator('#accommodation-apply-selected').click();
    await page.locator('#accommodation-dialog').waitFor({ state: 'hidden' });

    assert.equal(await page.locator('#day-detail .stay-card strong').textContent(), '额尔古纳');
    // 莫尔道嘎 is no longer referenced → the distinct base count drops to 4
    assert.equal(await page.locator('#accommodation-count').textContent(), '4');
    assert.ok(!(await page.locator('#stay-note-text').textContent()).includes('莫尔道嘎 1 晚'), 'night 3 no longer grouped as mordaoga');
    assert.ok((await page.locator('#stay-note-text').textContent()).includes('额尔古纳 2 晚'), 'erguna nights grouped');

    await page.reload();
    await waitForMap(page);
    await page.locator('.day-button[data-day="2"]').click();
    assert.equal(await page.locator('#day-detail .stay-card strong').textContent(), '额尔古纳');
  } finally {
    await close();
  }
});

test('a name without a confirmed position cannot be saved (exact validation message)', async () => {
  const { page, close } = await openApp({ amapConfig404: true });
  try {
    await waitForMap(page);
    await openAccommodationDialog(page);
    await page.getByRole('button', { name: '新增住宿基地' }).click();
    await page.locator('#accommodation-new-name').fill('无位置民宿');
    await page.getByRole('button', { name: '保存并应用' }).click();
    assert.equal(await page.locator('#accommodation-dialog-status').textContent(), MISSING_VALIDATION);
    assert.ok(await page.locator('#accommodation-dialog').isVisible(), 'dialog stays open');
    assert.notEqual(await page.locator('#day-detail .stay-card strong').textContent(), '无位置民宿');

    // position confirmed, then the name cleared → same exact message
    await page.getByRole('button', { name: '在地图上选点' }).click();
    await page.locator('#accommodation-map-picker').waitFor({ state: 'visible' });
    await page.locator('#route-map').click({ position: { x: 250, y: 250 } });
    await page.locator('#accommodation-new-lat').waitFor({ state: 'visible' });
    await page.locator('#accommodation-new-name').fill('');
    await page.getByRole('button', { name: '保存并应用' }).click();
    assert.equal(await page.locator('#accommodation-dialog-status').textContent(), MISSING_VALIDATION);
    assert.ok(await page.locator('#accommodation-dialog').isVisible(), 'dialog still open');
  } finally {
    await close();
  }
});

test('keyboard-only map picking confirms the center and Escape cancels keeping the draft', async () => {
  const { page, close } = await openApp({ amapConfig404: true, viewport: { width: 390, height: 844 } });
  try {
    await waitForMap(page);
    await openAccommodationDialog(page);
    await page.getByRole('button', { name: '新增住宿基地' }).click();
    await page.locator('#accommodation-new-name').fill('键盘测试民宿');
    await page.getByRole('button', { name: '在地图上选点' }).click();
    await page.locator('#accommodation-map-picker').waitFor({ state: 'visible' });
    assert.match(await page.locator('#accommodation-map-picker').textContent(), /方向键平移，按 Enter 确认/);

    // ArrowRight pans the map, Enter confirms the center (legacy core:34)
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await page.locator('#accommodation-new-lat').waitFor({ state: 'visible' });
    assert.match(await page.locator('#accommodation-location-summary').textContent(), /已选择 /);

    // reopen the picker and cancel with Escape: draft preserved, nothing saved
    await page.getByRole('button', { name: '在地图上选点' }).click();
    await page.locator('#accommodation-map-picker').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    assert.ok(await page.locator('#accommodation-dialog').isVisible(), 'dialog reopens after cancel');
    assert.equal(await page.locator('#accommodation-new-name').inputValue(), '键盘测试民宿', 'draft name kept');
    assert.equal(
      await page.locator('#accommodation-dialog-status').textContent(),
      '已取消地图选点，已保留当前填写内容。',
    );
    assert.notEqual(await page.locator('#day-detail .stay-card strong').textContent(), '键盘测试民宿');

    // the kept draft can still be saved as an alternate
    await page.getByRole('button', { name: '仅保存为备选' }).click();
    assert.equal(
      await page.locator('#accommodation-dialog-status').textContent(),
      '已保存为备选住宿基地。',
    );
    await page.reload();
    await waitForMap(page);
    await openAccommodationDialog(page);
    assert.equal(
      await page.locator('#accommodation-base-list .accommodation-option', { hasText: '键盘测试民宿' }).count(),
      1,
      'alternate persisted',
    );
  } finally {
    await close();
  }
});

test('storage failure keeps the page state and shows the exact failure string without false success', async () => {
  const { page, close } = await openApp({
    amapConfig404: true,
    init: () => {
      Storage.prototype.setItem = function () {
        throw new Error('quota exceeded');
      };
    },
  });
  try {
    await waitForMap(page);
    await openAccommodationDialog(page);
    await createDraftWithPosition(page, '无法保存民宿');
    await page.getByRole('button', { name: '保存并应用' }).click();

    assert.equal(await page.locator('#accommodation-dialog-status').textContent(), WRITE_FAILURE_STATUS);
    assert.ok(await page.locator('#accommodation-dialog').isVisible(), 'dialog stays open on write failure');
    assert.notEqual(await page.locator('#day-detail .stay-card strong').textContent(), '无法保存民宿');
    assert.equal(await page.locator('#accommodation-count').textContent(), '5', 'the failed write never applied');
    await page.locator('#accommodation-close').click();
  } finally {
    await close();
  }
});

test('legacy-format storage payload (custom base + custom stay) renders and survives refresh', async () => {
  const { page, close } = await openApp({
    amapConfig404: true,
    init: () => {
      localStorage.setItem(
        'hailar-slow-trip-accommodation-v1',
        JSON.stringify({
          version: 1,
          bases: [
            {
              id: 'custom-old',
              name: '老民宿',
              type: 'hotel',
              lat: 49.19,
              lng: 119.79,
              address: '海拉尔区老城',
              notes: '暖气很足',
              createdAt: '2026-09-01T00:00:00.000Z',
              isDefault: false,
            },
          ],
          stays: { 0: 'custom-old' },
        }),
      );
    },
  });
  try {
    await waitForMap(page);
    assert.equal(await page.locator('#day-detail .stay-card strong').textContent(), '老民宿');
    assert.match(await page.locator('#day-detail .stay-card small').textContent(), /海拉尔区老城/);
    assert.equal(await page.locator('#accommodation-count').textContent(), '6');
    assert.match(await page.locator('#stay-note-text').textContent(), /老民宿 1 晚/);

    await page.reload();
    await waitForMap(page);
    assert.equal(await page.locator('#day-detail .stay-card strong').textContent(), '老民宿');
    assert.equal(await page.locator('#accommodation-count').textContent(), '6');
  } finally {
    await close();
  }
});