const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openApp } = require('../helpers/vite-app.cjs');
const { installAMapStub } = require('../helpers/amap-stub.cjs');

// Ticket 03 — AMap auto-load, driving routes, staleness, live panel (app.html).
// Provider boundary = tests/helpers/amap-stub.cjs (installed via addInitScript —
// `installAMapStub` is self-contained, which is what addInitScript can
// serialize). Every request is recorded on window.routeProvider.requests with
// the exact overload/waypoint shapes the fixture validates. All assertions are
// visible DOM / aria / route-state behavior, no component internals.

const UPDATED_LABEL = '已更新 43.2 km · 1 小时 35 分钟'; // stub distance 43210 / time 5678

function requestCount(page) {
  return page.evaluate(() => window.routeProvider.requests.length);
}

function dayEstimate(page) {
  return page.locator('#day-detail .route-estimate').textContent();
}

/** Wait for the boot day-0 query to settle, then speed up the provider. */
async function bootStub(page) {
  await page.waitForFunction(() => window.routeProvider.requests.length >= 1);
  await page.waitForFunction(() => document.querySelector('#amap-time-badge'));
  await page.evaluate(() => {
    window.routeProvider.delay = 10;
  });
}

async function waitForEstimate(page, text) {
  await page.waitForFunction(
    (expected) => document.querySelector('#day-detail .route-estimate')?.textContent === expected,
    text,
  );
}

function providerErrors(page) {
  return page.evaluate(() => window.routeProvider.errors.length);
}

test('configured AMap auto-loads; a daily select issues one keyword-waypoint query and updates the live panel', async () => {
  const { page, close } = await openApp({ init: installAMapStub });
  try {
    await bootStub(page);
    await page.waitForFunction(() => document.querySelector('.map-wrap')?.classList.contains('amap-active'));
    assert.equal(await page.locator('#amap-state').textContent(), '高德地图 · 当前路况');
    // no credential forms anywhere
    assert.equal(await page.locator('#amap-settings').count(), 0);
    assert.equal(await page.locator('#amap-dialog').count(), 0);
    assert.equal(await page.locator('#connect-amap').count(), 0);

    const before = await requestCount(page);
    await page.locator('.day-button[data-day="1"]').click();
    await page.waitForFunction((n) => window.routeProvider.requests.length === n + 1, before);

    // the new request uses the array overload with keyword waypoints (day 1 via)
    const request = await page.evaluate(() => window.routeProvider.requests.at(-1));
    assert.equal(request.coordinate, false, 'keyword-only stops take the array overload');
    assert.equal(Array.isArray(request.origin), true, 'array overload origin is the stops array');
    assert.equal(request.origin[0].keyword, '海拉尔市区');
    assert.equal(request.origin.at(-1).keyword, '额尔古纳湿地景区');
    assert.equal(request.waypoints.length, 1);
    assert.equal(request.waypoints[0].keyword, '莫尔格勒河');
    assert.equal(request.waypoints[0].city, '呼伦贝尔市');
    assert.equal(await providerErrors(page), 0, 'stub validated every overload argument');

    // route state + day-detail labels
    await waitForEstimate(page, UPDATED_LABEL);
    assert.equal((await dayEstimate(page)).includes('km · '), true, `unexpected estimate ${await dayEstimate(page)}`);
    assert.equal(await page.locator('#day-detail .day-stats span').first().textContent(), UPDATED_LABEL);
    // schedule row driving estimates were NOT rewritten on success
    const schedule = await page.locator('#day-detail .timeline').textContent();
    assert.equal(schedule.includes('路线未更新'), false);

    // navigation links reflect the resolved route (patched-href equivalents)
    const primaryHref = await page.locator('.navigation-primary').getAttribute('href');
    const currentHref = await page.locator('.navigation-current').getAttribute('href');
    assert.equal(primaryHref.startsWith('https://uri.amap.com/navigation?mode=car&policy=1&callnative=1&src=hailar-slow-trip'), true);
    assert.equal(primaryHref.includes('to=119.78%2C49.21%2C'), true, primaryHref);
    assert.equal(primaryHref.includes('from=119.82%2C49.22%2C'), true, primaryHref);
    assert.equal(currentHref.includes('to=119.78%2C49.21%2C'), true, currentHref);
    assert.equal(currentHref.includes('from='), false);

    // live panel DOM contract
    assert.equal(await page.locator('#live-status').textContent().then((t) => t.startsWith('高德路线查询成功 · ')), true);
    assert.equal(await page.locator('#live-title').textContent(), '10.03 · 高德驾车路线');
    assert.equal(await page.locator('#amap-time-badge strong').textContent(), '1 小时 35 分钟');
    assert.equal(await page.locator('#amap-time-badge small').textContent(), '本段预计驾驶');
    assert.equal(await page.locator('.live-metrics strong').nth(0).textContent(), '1 小时 35 分钟');
    assert.equal(await page.locator('.live-metrics strong').nth(1).textContent(), '43.2 km');
    assert.equal(await page.locator('.live-metrics strong').nth(2).textContent(), '暂无覆盖');
    assert.equal(await page.locator('.traffic-summary').textContent(), '未知 43.2 km');
    const resolved = await page.locator('.resolved-endpoints').textContent();
    assert.equal(resolved.startsWith('海拉尔市区 → 额尔古纳湿地景区。请核对具体入口；'), true);
    assert.equal(await page.locator('.road-details summary').textContent(), '沿途道路与转向');
    assert.equal(await page.locator('.road-details li strong').textContent(), '测试道路');
    // traffic toggle enabled + checked, refresh enabled
    assert.equal(await page.locator('#traffic-toggle').isEnabled(), true);
    assert.equal(await page.locator('#traffic-toggle').isChecked(), true);
    assert.equal(await page.locator('#amap-refresh').isEnabled(), true);
  } finally {
    await close();
  }
});

test('route failure marks 路线未更新; the next select with a working provider retries to updated', async () => {
  const { page, close } = await openApp({ init: installAMapStub });
  try {
    await bootStub(page);
    await page.evaluate(() => {
      window.routeProvider.mode = 'failure';
    });

    await page.locator('.day-button[data-day="2"]').click();
    await waitForEstimate(page, '路线未更新');
    assert.equal(await page.locator('#live-status').textContent(), '未取得路线。请检查地点名称、Key 服务权限与配额，然后刷新重试。');
    assert.equal(await page.locator('#live-results .live-metrics').count(), 0);

    await page.evaluate(() => {
      window.routeProvider.mode = 'success';
    });
    await page.locator('.day-button[data-day="2"]').click();
    await waitForEstimate(page, UPDATED_LABEL);
    assert.equal(await page.locator('#live-status').textContent().then((t) => t.startsWith('高德路线查询成功 · ')), true);
  } finally {
    await close();
  }
});

test('no route data keeps reference map + itinerary intact and shows no fabricated distance', async () => {
  const { page, close } = await openApp({ init: installAMapStub });
  try {
    await bootStub(page);
    // force the failure AFTER boot so the failing query is deterministic
    await page.evaluate(() => {
      window.routeProvider.mode = 'failure';
    });
    await page.locator('.day-button[data-day="1"]').click();
    await waitForEstimate(page, '路线未更新');
    assert.equal(await page.locator('#live-status').textContent(), '未取得路线。请检查地点名称、Key 服务权限与配额，然后刷新重试。');
    // reference map still mounted (hidden under amap canvas) + itinerary alive
    assert.equal(await page.locator('#route-map.leaflet-container').count(), 1);
    assert.equal(await page.locator('#amap-canvas').isVisible(), true);
    assert.equal(await page.locator('#map-error').count(), 1);
    // no fabricated distance anywhere in the route estimate / stats
    assert.doesNotMatch(await dayEstimate(page), /[\d.]+\s*km/);
    assert.equal(await page.locator('#day-detail .day-stats span').first().textContent(), '路线未更新');
    assert.equal(await page.locator('#live-results .live-metrics').count(), 0);
    assert.equal(await page.locator('#amap-time-badge').count(), 0);
    assert.equal(await page.locator('#distance-summary').textContent(), '约 1,000–1,100 km');

    await page.locator('.day-button[data-day="4"]').click();
    assert.equal(await page.locator('#day-detail h2').textContent(), '186彩带河后，进满洲里');
    assert.equal(await page.locator('.day-button[aria-pressed="true"]').getAttribute('data-day'), '4');
  } finally {
    await close();
  }
});

test('out-of-order responses: only the latest selection lands, the delayed one never overrides', async () => {
  const { page, close } = await openApp({ init: installAMapStub });
  try {
    await bootStub(page);
    await page.evaluate(() => {
      window.routeProvider.delay = 400; // first select will be slow
      window.routeProvider.distance = 11111;
    });
    await page.locator('.day-button[data-day="1"]').click(); // slow request A
    await page.evaluate(() => {
      window.routeProvider.delay = 10;
      window.routeProvider.distance = 22222;
    });
    await page.locator('.day-button[data-day="2"]').click(); // fast request B (latest)

    await waitForEstimate(page, '已更新 22.2 km · 1 小时 35 分钟');
    assert.equal(
      await page.locator('#day-detail .navigation-panel strong').textContent(),
      '额尔古纳市 → 莫尔道嘎国家森林公园',
    );
    // let A's 400ms timer fire: the stale response must not replace day 2
    await page.waitForTimeout(700);
    assert.equal(await dayEstimate(page), '已更新 22.2 km · 1 小时 35 分钟');
    assert.equal(await requestCount(page), 3, 'exactly boot + A + B');
    assert.equal(await page.locator('#amap-time-badge').count(), 1);
  } finally {
    await close();
  }
});

test('fit-map with AMap connected runs the whole-trip query over keyword stops and re-shows overview times', async () => {
  const { page, close } = await openApp({ init: installAMapStub });
  try {
    await bootStub(page);
    const before = await requestCount(page);
    await page.locator('#fit-map').click();

    await page.waitForSelector('#amap-time-badge', { timeout: 20000 });
    await page.waitForFunction((n) => window.routeProvider.requests.length === n + 7, before);
    assert.equal(await page.locator('#live-title').textContent(), '全程路线 · 按当前路况估算');
    assert.equal(await page.locator('#amap-time-badge small').textContent(), '全程驾驶合计');
    assert.equal(await page.locator('#overview-times').isVisible(), true);

    const requests = await page.evaluate(() => window.routeProvider.requests.slice(-7));
    for (const request of requests) {
      assert.equal(request.coordinate, false, 'whole-trip legs use the keyword overload');
      // Array overload: the stub records origin = args[0] = the FULL stops
      // array; waypoints are the middle stops sliced out of that same array.
      assert.equal(Array.isArray(request.origin), true, 'array overload origin is the stops array');
      for (const waypoint of request.waypoints) {
        assert.equal(typeof waypoint.keyword, 'string');
      }
    }
    // Preserve the no-LngLat-waypoints intent: the stub's instance check only
    // exists in the page context, so run it there (serialized copies can't).
    const nonKeywordWaypoints = await page.evaluate(() =>
      window.routeProvider.requests
        .slice(-7)
        .flatMap((request) => request.waypoints)
        .some((waypoint) => waypoint instanceof window.AMap.LngLat),
    );
    assert.equal(nonKeywordWaypoints, false, 'whole-trip legs carry keyword waypoints, not LngLat');
    const keywords = requests.flatMap((request) => request.origin.map((stop) => stop.keyword));
    for (const expected of ['海拉尔东山机场', '莫尔格勒河', '室韦口岸', '186彩带河景区', '呼伦湖旅游景区']) {
      assert.equal(keywords.includes(expected), true, `overview stops missing ${expected}`);
    }
    // combined metrics: 7 × 43210 m → 302.5 km; 7 × 5678 s → 11 小时 3 分钟
    assert.equal(await page.locator('.live-metrics strong').nth(1).textContent(), '302.5 km');
    assert.equal(await page.locator('.live-metrics strong').nth(0).textContent(), '11 小时 3 分钟');
  } finally {
    await close();
  }
});

test('absent amap config (amap-config.js 404s) keeps the reference map fully working with no AMap map', async () => {
  const { page, close } = await openApp({ amapConfig404: true });
  try {
    await page.waitForSelector('#route-map.leaflet-container');
    await page.waitForFunction(() => document.getElementById('amap-state')?.textContent === '高德未配置 · 当前为参考地图');
    assert.equal(await page.locator('#live-status').textContent(), '尚未连接，暂无法获取实时驾驶时间与路况。');
    assert.equal(await page.locator('.map-wrap.amap-active').count(), 0);
    assert.equal(await page.locator('#amap-canvas').isHidden(), true);
    assert.equal(await page.locator('#connect-amap').count(), 0);
    assert.equal(await page.locator('#amap-settings').count(), 0);
    assert.equal(await page.evaluate(() => typeof window.routeProvider), 'undefined');
    // itinerary + reference map work normally
    assert.equal(await page.locator('#day-detail .route-estimate').textContent(), '参考里程约 6 km');
    assert.equal(await page.locator('#overview-times').isVisible(), true);
    await page.locator('.day-button[data-day="3"]').click();
    assert.equal(await page.locator('#day-detail h2').textContent(), '室韦界河边走走，再去黑山头');
    assert.equal(await page.locator('.map-legend').textContent(), '行程连线示意 · 非道路导航');
  } finally {
    await close();
  }
});

test('SDK load failure retries with the same config instead of opening a credential form', async () => {
  const { page, close } = await openApp({
    init: () => {
      window.TIBET_AMAP_CONFIG = { key: 'test-only', securityJsCode: 'test-only' };
    },
  });
  try {
    // the SDK script request is aborted by the helper → onerror failure
    await page.waitForFunction(() => document.getElementById('amap-state')?.textContent === '高德加载失败 · 当前为参考地图');
    assert.equal(await page.locator('#live-status').textContent(), '无法加载高德地图，请检查网络与域名白名单。');
    assert.equal(await page.locator('#connect-amap').innerText(), '重试加载地图');
    assert.equal(await page.locator('#amap-settings').count(), 0);
    assert.equal(await page.locator('#amap-dialog').count(), 0);

    await page.evaluate(installAMapStub);
    await page.getByRole('button', { name: '重试加载地图', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.map-wrap')?.classList.contains('amap-active'));
    assert.equal(await page.locator('#amap-state').textContent(), '高德地图 · 当前路况');
    assert.equal(await page.locator('#connect-amap').count(), 0);
    assert.ok((await requestCount(page)) >= 1, 'retry queried the current day');
  } finally {
    await close();
  }
});

test('StrictMode double-mount produces exactly the expected request set (no duplicate maps/queries)', async () => {
  const { page, close } = await openApp({ init: installAMapStub });
  try {
    await bootStub(page);
    // boot settled → exactly one boot query despite the StrictMode double-mount
    assert.equal(await requestCount(page), 1, 'StrictMode double-mount must not duplicate the boot query');

    // Each user select is not double-invoked by StrictMode; capture the count
    // BEFORE the click, require the request to land, then assert the exact
    // count only after the response settled (no replay race, no strays).
    let before = await requestCount(page);
    await page.locator('.day-button[data-day="1"]').click();
    await page.waitForFunction((n) => window.routeProvider.requests.length >= n + 1, before);
    await waitForEstimate(page, UPDATED_LABEL);
    assert.equal(await requestCount(page), before + 1, 'one request per daily select');

    before = await requestCount(page);
    await page.locator('.day-button[data-day="2"]').click();
    await page.waitForFunction((n) => window.routeProvider.requests.length >= n + 1, before);
    await waitForEstimate(page, UPDATED_LABEL);
    assert.equal(await requestCount(page), before + 1, 'one request per daily select');

    // whole-trip sequence settles → exactly one boot + one per select + 7 legs
    before = await requestCount(page);
    await page.locator('#fit-map').click();
    await page.waitForFunction((n) => window.routeProvider.requests.length === n + 7, before, { timeout: 20000 });
    await page.waitForTimeout(800); // no stray timers/refresh fire
    assert.equal(await requestCount(page), 10);
    assert.equal(await page.locator('#amap-time-badge').count(), 1);
    assert.equal(await page.locator('#live-results .live-metrics').count(), 1);
    assert.equal(await page.locator('#amap-canvas .amap-logo, #amap-canvas .amap-container').count(), 0, 'stub map creates no DOM');
  } finally {
    await close();
  }
});