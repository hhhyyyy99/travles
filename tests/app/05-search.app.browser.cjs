const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openApp } = require('../helpers/vite-app.cjs');
const { installAMapStub } = require('../helpers/amap-stub.cjs');

// Ticket 05 — accommodation place search in the dialog (app.html entry).
// Migrated scenarios from the legacy tests/accommodation-search.browser.cjs
// plus the speed-triggered stale-result rejection and keyboard focus flow.
// The AMap fixture now also stubs PlaceSearch (tests/helpers/amap-stub.cjs);
// `window.placeProvider` drives mode/delay/pois per scenario.

const STORAGE_KEY = 'hailar-slow-trip-accommodation-v1';

async function waitForMap(page) {
  await page.waitForSelector('#route-map.leaflet-container');
}

async function openAccommodationDialog(page) {
  await page.locator('#day-detail [data-accommodation-open]').first().click();
  await page.locator('#accommodation-dialog').waitFor({ state: 'visible' });
}

/** init script = AMap stub source + extra statements (self-contained for addInitScript). */
function initWith(extra) {
  return new Function(`${installAMapStub.toString()}\ninstallAMapStub();\n(${extra.toString()})();`);
}

test('search results require confirmation before saving, then prefill the existing editor', async () => {
  const { page, close } = await openApp({ init: installAMapStub, viewport: { width: 390, height: 844 } });
  try {
    await openAccommodationDialog(page);
    await page.getByRole('button', { name: '新增住宿基地', exact: true }).click();
    await page.evaluate(() => {
      window.placeProvider.delay = 20;
      window.placeProvider.pois = (query) => [{ id: 'poi-lodge', name: query === '附近旅店' ? '松林小院' : '额尔古纳湿地', address: '额尔古纳市河西', location: { lng: 119.8, lat: 49.2 } }];
    });
    await page.locator('#accommodation-search-query').fill('附近旅店');
    await page.locator('#accommodation-search-query').press('Enter');
    await page.getByText('松林小院', { exact: true }).waitFor();
    assert.equal(
      await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY),
      null,
      'unconfirmed search results never persist',
    );

    await page.getByRole('button', { name: '确认此地点', exact: true }).click();
    assert.equal(await page.locator('#accommodation-new-name').inputValue(), '松林小院');
    assert.equal(await page.locator('#accommodation-new-address').inputValue(), '额尔古纳市河西');
    assert.equal(await page.locator('#accommodation-new-lat').inputValue(), '49.198097', 'WGS-84 boundary conversion');
    assert.match(await page.locator('#accommodation-location-summary').textContent(), /已确认高德地点/);
    assert.equal(
      await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY),
      null,
      'confirming a result only prefills the editor',
    );

    await page.getByRole('button', { name: '仅保存为备选', exact: true }).click();
    assert.equal(
      await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).bases[0].name, STORAGE_KEY),
      '松林小院',
    );
  } finally {
    await close();
  }
});

test('nearby duplicate can be reused or deliberately continued as a new base', async () => {
  const init = initWith(() => {
    localStorage.setItem(
      'hailar-slow-trip-accommodation-v1',
      JSON.stringify({
        version: 1,
        bases: [{ id: 'custom-existing', name: '松林小院', type: 'hotel', lat: 49.19, lng: 119.79, address: '旧地址', notes: '', createdAt: new Date().toISOString() }],
        stays: {},
      }),
    );
  });
  const { page, close } = await openApp({ init });
  try {
    await openAccommodationDialog(page);
    await page.evaluate(() => {
      window.placeProvider.delay = 20;
      window.placeProvider.pois = (query) => [{ id: 'poi-lodge', name: '松林小院', address: '额尔古纳市河西', location: { lng: 119.8, lat: 49.2 } }];
    });
    await page.locator('#accommodation-search-query').fill('松林小院');
    await page.getByRole('button', { name: '搜索地点', exact: true }).click();
    await page.getByRole('button', { name: '确认此地点', exact: true }).click();
    await page.getByRole('alert').waitFor();

    // reuse the existing base: nothing new persisted, shared apply flow works
    await page.getByRole('button', { name: '使用已有：松林小院', exact: true }).click();
    assert.match(await page.locator('#accommodation-selected-label').textContent(), /已选择：松林小院/);
    assert.equal(
      await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).bases.length, STORAGE_KEY),
      1,
      'reuse never creates a base',
    );
    await page.getByRole('button', { name: '应用到所选晚次', exact: true }).click();
    await page.locator('#accommodation-dialog').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).stays['0'], STORAGE_KEY), 'custom-existing');

    // deliberately continue as a NEW base: duplicate prompt again, prefill works
    await openAccommodationDialog(page);
    await page.locator('#accommodation-search-query').fill('松林小院');
    await page.getByRole('button', { name: '搜索地点', exact: true }).click();
    await page.getByRole('button', { name: '确认此地点', exact: true }).click();
    await page.getByRole('alert').waitFor();
    await page.getByRole('button', { name: '继续新增「松林小院」', exact: true }).click();
    assert.equal(await page.locator('#accommodation-new-name').inputValue(), '松林小院');
    assert.equal(await page.locator('#accommodation-new-lat').inputValue(), '49.198097');
    assert.equal(
      await page.locator('#accommodation-search-status').textContent(),
      '地点已确认，核对名称和住宿晚次后保存。',
    );
    assert.equal(
      await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).bases.length, STORAGE_KEY),
      1,
      'continue-new still requires the shared save flow to persist',
    );
    await page.getByRole('button', { name: '仅保存为备选', exact: true }).click();
    assert.equal(
      await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).bases.length, STORAGE_KEY),
      2,
      'continue-new persists as a distinct base',
    );
  } finally {
    await close();
  }
});

test('empty and failed place searches give distinct feedback while keeping the fallback available', async () => {
  const { page, close } = await openApp({ init: installAMapStub });
  try {
    await openAccommodationDialog(page);
    await page.getByRole('button', { name: '新增住宿基地', exact: true }).click();
    await page.locator('#accommodation-search-query').fill('无结果');
    await page.evaluate(() => { window.placeProvider.delay = 20; window.placeProvider.mode = 'no_data'; });
    await page.getByRole('button', { name: '搜索地点', exact: true }).click();
    await page.getByText(/没有找到匹配地点/).waitFor();
    assert.ok(await page.locator('#accommodation-editor').isVisible(), 'manual editor stays available');

    await page.locator('#accommodation-search-query').fill('服务失败');
    await page.evaluate(() => { window.placeProvider.mode = 'error'; });
    await page.getByRole('button', { name: '搜索地点', exact: true }).click();
    await page.getByText(/地点搜索暂时不可用/).waitFor();
    assert.equal(await page.locator('#accommodation-new-name').inputValue(), '服务失败', 'draft falls back to the query');
    assert.ok(await page.locator('#accommodation-editor').isVisible(), 'editor stays open for manual picking');
  } finally {
    await close();
  }
});

test('search failure preserves the query and draft; manual map picking still saves', async () => {
  const { page, close } = await openApp({
    amapConfig404: true,
    init: () => { window.AMap = {}; },
  });
  try {
    await waitForMap(page);
    await openAccommodationDialog(page);
    await page.getByRole('button', { name: '新增住宿基地', exact: true }).click();
    await page.getByLabel('基地名称', { exact: true }).fill('手填的酒店');
    await page.getByLabel('详细地址（选填）', { exact: true }).fill('先填地址');
    await page.getByLabel('备注（选填）', { exact: true }).fill('先填备注');
    await page.locator('#accommodation-search-query').fill('没有配置的酒店');
    await page.getByRole('button', { name: '搜索地点', exact: true }).click();
    await page.getByText(/需要先连接高德地图/).waitFor();
    assert.equal(await page.locator('#accommodation-search-query').inputValue(), '没有配置的酒店', 'query kept');
    assert.equal(await page.locator('#accommodation-new-name').inputValue(), '手填的酒店');
    assert.equal(await page.locator('#accommodation-new-address').inputValue(), '先填地址');
    assert.equal(await page.locator('#accommodation-new-notes').inputValue(), '先填备注');
    assert.ok(await page.locator('#accommodation-editor').isVisible());

    // the preserved draft still saves after a manual map pick
    await page.getByRole('button', { name: '在地图上选点' }).click();
    await page.locator('#accommodation-map-picker').waitFor({ state: 'visible' });
    await page.locator('#route-map').click({ position: { x: 250, y: 250 } });
    await page.locator('#accommodation-new-lat').waitFor({ state: 'visible' });
    await page.getByRole('button', { name: '仅保存为备选', exact: true }).click();
    assert.equal(
      await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).bases[0].name, STORAGE_KEY),
      '手填的酒店',
    );
  } finally {
    await close();
  }
});

test('a stale slow response never overwrites the current query after a fast query change', async () => {
  const { page, close } = await openApp({ init: installAMapStub });
  try {
    await openAccommodationDialog(page);
    await page.getByRole('button', { name: '新增住宿基地', exact: true }).click();
    await page.evaluate(() => {
      window.placeProvider.delay = 350;
      window.placeProvider.pois = (query) => [
        { id: `poi-${query}`, name: query === '旧关键词' ? '旧结果' : '新结果', address: '测试地址', location: { lng: 119.8, lat: 49.2 } },
      ];
    });
    await page.locator('#accommodation-search-query').fill('旧关键词');
    await page.locator('#accommodation-search-query').press('Enter');
    await page.evaluate(() => { window.placeProvider.delay = 20; });
    await page.locator('#accommodation-search-query').fill('新关键词');
    await page.locator('#accommodation-search-query').press('Enter');

    await page.getByText('新结果', { exact: true }).waitFor();
    await page.waitForTimeout(500); // let the stale 350 ms response land
    const names = await page.locator('#accommodation-search-results .accommodation-search-result strong').allTextContents();
    assert.deepEqual(names, ['新结果'], 'stale response discarded');
    assert.equal(
      await page.locator('#accommodation-search-status').textContent(),
      '找到 1 个地点，请确认位置后再保存。',
    );
    await page.getByRole('button', { name: '确认此地点', exact: true }).click();
    assert.equal(await page.locator('#accommodation-new-name').inputValue(), '新结果', 'draft reflects only the current query');

    const requests = await page.evaluate(() => window.placeProvider.requests.map((request) => request.query));
    assert.deepEqual(requests, ['旧关键词', '新关键词']);
  } finally {
    await close();
  }
});

test('closing the dialog discards in-flight search results', async () => {
  const { page, close } = await openApp({ init: installAMapStub });
  try {
    await openAccommodationDialog(page);
    await page.evaluate(() => {
      window.placeProvider.delay = 300;
      window.placeProvider.pois = [{ id: 'poi-slow', name: '慢结果', address: '测试地址', location: { lng: 119.8, lat: 49.2 } }];
    });
    await page.locator('#accommodation-search-query').fill('慢关键词');
    await page.locator('#accommodation-search-query').press('Enter');
    await page.locator('#accommodation-close').click();
    await page.waitForTimeout(450); // in-flight + stale window
    await openAccommodationDialog(page);
    assert.equal(await page.locator('#accommodation-search-results .accommodation-search-result').count(), 0);
    assert.equal(await page.locator('#accommodation-search-status').textContent(), '', 'no stale status either');
  } finally {
    await close();
  }
});

test('keyboard focus flow: Enter runs the search and empty queries return focus to the input', async () => {
  const { page, close } = await openApp({ init: installAMapStub });
  try {
    await openAccommodationDialog(page);
    await page.locator('#accommodation-search-query').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#accommodation-search-status').textContent(), '请输入住宿名称或区域。');
    assert.equal(
      await page.evaluate(() => document.activeElement && document.activeElement.id),
      'accommodation-search-query',
      'focus returns to the query input',
    );

    await page.evaluate(() => {
      window.placeProvider.delay = 20;
      window.placeProvider.pois = [{ id: 'poi-kb', name: '键盘民宿', address: '测试地址', location: { lng: 119.8, lat: 49.2 } }];
    });
    await page.locator('#accommodation-search-query').fill('键盘民宿');
    await page.keyboard.press('Enter');
    await page.getByText('键盘民宿', { exact: true }).waitFor();
    assert.equal(await page.locator('#accommodation-search-results .accommodation-search-result').count(), 1);
  } finally {
    await close();
  }
});
