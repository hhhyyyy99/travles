const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openApp } = require('../helpers/vite-app.cjs');

// Ticket 04 part C1 — accommodation change events → route requery lifecycle
// (pending → updated / unupdated), exact legacy status copy, selection safety,
// and boot with legacy-format stays overrides (app.html entry).
//
// Provider boundary = tests/helpers/amap-stub.cjs via addInitScript. Every
// AMap Driving.search is recorded on window.routeProvider.requests with the
// exact overload/waypoint shapes; the fixture additionally validates that the
// coordinate overload receives two LngLat endpoints and that every waypoint is
// either an LngLat or a `{keyword, city}` object. Coordinate conversions run
// through the real vendored coordtransform (WGS-84 → GCJ-02) at the AMap edge.
//
// init functions must be self-contained (addInitScript serializes only the
// function source), so the storage seed is generated at describe time and the
// AMap stub body is inlined into each init function; page.evaluate closures
// likewise receive any fixture coordinates as explicit arguments.

const UPDATED_LABEL = '已更新 43.2 km · 1 小时 35 分钟'; // stub distance 43210 / time 5678

// 自定义 base fixtures (WGS-84 lat/lng) — used as changed endpoints.
const CUSTOM_A = { id: 'custom-a', name: '草原民宿', type: 'area', lat: 49.6, lng: 119.9, address: '海拉尔区近郊' };
const CUSTOM_B = { id: 'custom-b', name: '湖边小筑', type: 'hotel', lat: 50.1, lng: 119.5, address: '额尔古纳河边' };

const STORAGE_KEY = 'hailar-slow-trip-accommodation-v1';

/** Body of tests/helpers/amap-stub.cjs, inlined so init functions stay self-contained. */
const AMAP_STUB_BODY = `
  class LngLat {
    constructor(lng, lat) { this.lng = lng; this.lat = lat; }
    getLng() { return this.lng; }
    getLat() { return this.lat; }
  }
  const requests = [];
  window.routeProvider = {requests, mode: 'success', delay: 40, distance: 43210, errors: []};
  class Driving {
    search(...args) {
      const callback = args.at(-1);
      const coordinate = !Array.isArray(args[0]);
      if (coordinate && (!(args[0] instanceof LngLat) || !(args[1] instanceof LngLat))) {
        window.routeProvider.errors.push('Coordinate overload needs two LngLat endpoints');
        throw new Error('Invalid coordinate endpoints');
      }
      const waypoints = coordinate ? args[2].waypoints || [] : args[0].slice(1, -1);
      if (waypoints.some(p => !(p instanceof LngLat) && (!p || typeof p.keyword !== 'string'))) {
        window.routeProvider.errors.push('Invalid waypoint'); throw new Error('Invalid waypoint');
      }
      const request = {coordinate, waypoints, origin: args[0], destination: args[1], mode: window.routeProvider.mode, distance: window.routeProvider.distance, delay: window.routeProvider.delay};
      requests.push(request);
      const origin = coordinate ? args[0] : new LngLat(119.82,49.22);
      const destination = coordinate ? args[1] : new LngLat(119.78,49.21);
      const route = {distance: request.distance, time: 5678, steps: [{path:[origin, destination],road:'测试道路',instruction:'继续行驶'}]};
      setTimeout(() => { request.completed = true; callback(request.mode === 'failure' ? 'error' : 'complete', {routes: request.mode === 'failure' ? [] : [route]}); }, request.delay);
    }
  }
  class Map { add() {} remove() {} addControl() {} setFitView() {} setZoomAndCenter() {} destroy() {} }
  class Traffic {reload(){} show(){} hide(){}}
  class Shape {constructor(options) {this.options=options;}}
  class AutoComplete {on(){}}
  window.AMap={LngLat,Driving,Map,TileLayer:{Traffic},ToolBar:Shape,Scale:Shape,Marker:Shape,Polyline:Shape,Pixel:class{},AutoComplete,DrivingPolicy:{REAL_TRAFFIC:0}};
  window.TIBET_AMAP_CONFIG={key:'local-test-only',securityJsCode:'local-test-only'};
`;

/** Build a self-contained addInitScript: install the AMap stub then seed storage. */
function initWithSeed(stays) {
  const seed = JSON.stringify({ version: 1, bases: [CUSTOM_A, CUSTOM_B], stays });
  // eslint-disable-next-line no-new-func
  return new Function(
    `${AMAP_STUB_BODY}\nlocalStorage.setItem(${JSON.stringify(STORAGE_KEY)}, JSON.parse(${JSON.stringify(JSON.stringify(seed))}));`,
  );
}

/** Extend the boot delay (applied after the stub install inside the init script). */
function initWithSeedAndDelay(stays, delay) {
  const seed = JSON.stringify({ version: 1, bases: [CUSTOM_A, CUSTOM_B], stays });
  // eslint-disable-next-line no-new-func
  return new Function(
    `${AMAP_STUB_BODY}\nwindow.routeProvider.delay = ${delay};\nlocalStorage.setItem(${JSON.stringify(STORAGE_KEY)}, JSON.parse(${JSON.stringify(JSON.stringify(seed))}));`,
  );
}

async function waitForMap(page) {
  await page.waitForSelector('#route-map.leaflet-container', { state: 'attached' });
}

async function waitForEstimate(page, text) {
  await page.waitForFunction(
    (expected) => document.querySelector('#day-detail .route-estimate')?.textContent === expected,
    text,
  );
}

function requestCount(page) {
  return page.evaluate(() => window.routeProvider.requests.length);
}

async function openAccommodationDialog(page) {
  await page.locator('#day-detail [data-accommodation-open]').first().click();
  await page.locator('#accommodation-dialog').waitFor({ state: 'visible' });
}

async function applyStay(page, baseId) {
  await openAccommodationDialog(page);
  await page.locator(`[data-accommodation-select="${baseId}"]`).click();
  await page.locator('#accommodation-apply-selected').click();
  await page.locator('#accommodation-dialog').waitFor({ state: 'hidden' });
}

test('changing a stay re-queries exactly the affected days with NEW endpoints (LngLat coordinate overload) and transitions to updated', async () => {
  const { page, close } = await openApp({ init: initWithSeed({}) });
  try {
    await waitForMap(page);
    await page.waitForFunction(() => window.routeProvider.requests.length >= 1);
    await page.waitForFunction(() => document.querySelector('#amap-time-badge'));
    // no override at boot → the boot query stays the plain keyword day-0 one
    assert.equal(await page.evaluate(() => window.routeProvider.requests[0].coordinate), false, 'default boot stays keyword');

    // apply 草原民宿 to night 2 (莫尔道嘎) — affects route days {2, 3}
    await page.locator('.day-button[data-day="2"]').click();
    await page.waitForFunction(() => window.routeProvider.requests.length >= 2);
    const boot = await requestCount(page);
    await applyStay(page, 'custom-a');

    await page.waitForFunction((n) => window.routeProvider.requests.length === n + 2, boot);
    const requests = await page.evaluate(() => window.routeProvider.requests.slice(-2));
    for (const request of requests) {
      assert.equal(request.coordinate, true, 'changed-endpoint days use the coordinate overload');
    }

    // in-page overload validation: two LngLat endpoints, keyword-only waypoints
    const inPage = await page.evaluate((customA) => {
      const slice = window.routeProvider.requests.slice(-2);
      const lngLatCheck = (request) =>
        request.coordinate &&
        request.origin instanceof window.AMap.LngLat &&
        request.destination instanceof window.AMap.LngLat &&
        request.waypoints.every(
          (point) => point instanceof window.AMap.LngLat || typeof point.keyword === 'string',
        );
      // day 2 = 额尔古纳 → 草原民宿 (via = only the keyword-only nav stop 莫尔道嘎国家森林公园);
      // day 3 = 草原民宿 → 黑山头 with the 室韦口岸 via keyword.
      const [day2, day3] = slice;
      const expectedDest = window.coordtransform.wgs84togcj02(customA.lng, customA.lat);
      return {
        day2Ok: lngLatCheck(day2) && day2.waypoints.length === 1,
        day3Ok: lngLatCheck(day3),
        day2Keywords: day2.waypoints.map((point) => point.keyword),
        day3Keywords: day3.waypoints.map((point) => point.keyword),
        destGcj: [day2.destination.getLng(), day2.destination.getLat()],
        expectedDestGcj: expectedDest,
      };
    }, CUSTOM_A);
    assert.equal(inPage.day2Ok, true, 'day-2 request carries two LngLat endpoints + the keyword-only nav stop');
    assert.equal(inPage.day3Ok, true, 'day-3 request carries LngLat endpoints + keyword waypoints only');
    assert.deepEqual(inPage.destGcj, inPage.expectedDestGcj, 'day-2 destination is the GCJ-02 of 草原民宿');
    assert.deepEqual(inPage.day2Keywords, ['莫尔道嘎国家森林公园'], 'day-2 keeps the keyword-only nav via');
    assert.deepEqual(inPage.day3Keywords, ['室韦口岸'], 'day-3 keeps the 室韦口岸 via keyword');

    // status lifecycle: pending → updated on the selected day
    await waitForEstimate(page, UPDATED_LABEL);
    assert.equal(await page.locator('#day-detail .navigation-panel strong').textContent(), '额尔古纳 → 草原民宿');
    assert.equal(await page.locator('.map-legend').textContent(), '高德路线已更新');
    assert.equal(await page.locator('#day-detail .day-stats span').first().textContent(), UPDATED_LABEL);
    // untouched day keeps its plan display names and reference legend (React
    // marks any selected day updated once its own AMap query settles — 03 lock)
    await page.locator('.day-button[data-day="0"]').click();
    await waitForEstimate(page, UPDATED_LABEL);
    assert.equal(await page.locator('#day-detail .navigation-panel strong').textContent(), '海拉尔东山机场 → 海拉尔市区');
    assert.equal(await page.locator('.map-legend').textContent(), '行程连线示意 · 非道路导航');
  } finally {
    await close();
  }
});

test('stay change settles the per-day overview-times labels and legend to the updated copy', async () => {
  const { page, close } = await openApp({ init: initWithSeed({}) });
  try {
    await waitForMap(page);
    await page.waitForFunction(() => document.querySelector('#amap-time-badge'));
    await page.locator('.day-button[data-day="2"]').click();
    const before = await requestCount(page);
    await applyStay(page, 'custom-a');
    await page.waitForFunction((n) => window.routeProvider.requests.length >= n + 2, before);
    await waitForEstimate(page, UPDATED_LABEL);

    // whole-trip view re-shows #overview-times with the new per-day labels
    await page.locator('#fit-map').click();
    await page.waitForSelector('#overview-times', { timeout: 20000 });
    await page.waitForFunction(() => document.querySelectorAll('#overview-times [data-route-day]').length === 7);
    // day 2 changed: resolved endpoint names + real duration; day 4 reference: static
    assert.equal(await page.locator('#overview-times [data-route-day="2"]').textContent(), '额尔古纳 → 草原民宿1 小时 35 分钟');
    assert.equal(await page.locator('#overview-times [data-route-day="4"]').textContent(), '黑山头 → 满洲里3–3.5 小时');
  } finally {
    await close();
  }
});

test('a failed accommodation re-query keeps the stay, shows 路线未更新 and no fabricated distance', async () => {
  const { page, close } = await openApp({ init: initWithSeed({ 0: 'custom-a' }) });
  try {
    await waitForMap(page);
    // boot re-queries the affected days {0,1} and settles to updated
    await page.waitForFunction(() => document.querySelector('#amap-time-badge'));
    await waitForEstimate(page, UPDATED_LABEL);

    // now switch to 湖边小筑 on night 0 while the provider fails
    await page.evaluate(() => {
      window.routeProvider.mode = 'failure';
    });
    await applyStay(page, 'custom-b');

    // wait for the failed leg to finish (the stale copy 路线未更新 shows
    // immediately, so sync on the live-status instead)
    await page.waitForFunction(() =>
      document.querySelector('#live-status')?.textContent?.startsWith('未取得路线'),
    );
    await waitForEstimate(page, '路线未更新');
    assert.equal(await page.locator('#day-detail .navigation-panel strong').textContent(), '海拉尔东山机场 → 湖边小筑');
    assert.equal(await page.locator('.map-legend').textContent(), '住宿已更换 · 路线未更新');
    // the STAY is never rolled back on failure
    assert.equal(await page.locator('#day-detail .stay-card strong').textContent(), '湖边小筑');
    assert.equal(await page.locator('#day-detail .day-stats span').first().textContent(), '路线未更新');
    // no fabricated distance anywhere in the estimate / stats / live panel
    assert.doesNotMatch(await page.locator('#day-detail .route-estimate').textContent(), /[\d.]+\s*km/);
    assert.equal(await page.locator('#live-results .live-metrics').count(), 0);
    assert.equal(await page.locator('#amap-time-badge').count(), 0);
    assert.equal(await page.locator('#live-status').textContent(), '未取得路线。请检查地点名称、Key 服务权限与配额，然后刷新重试。');
    // distance-summary is C2 — stays at the hardcoded reference for now
    assert.equal(await page.locator('#distance-summary').textContent(), '约 1,000–1,100 km');

    // recovery: a following successful select retries the day to updated
    await page.evaluate(() => {
      window.routeProvider.mode = 'success';
    });
    await page.locator('.day-button[data-day="0"]').click();
    await waitForEstimate(page, UPDATED_LABEL);
  } finally {
    await close();
  }
});

test('out-of-order reply: two rapid stay-saves — the latest request wins, the delayed one never lands', async () => {
  const { page, close } = await openApp({ init: initWithSeed({}) });
  try {
    await waitForMap(page);
    await page.waitForFunction(() => document.querySelector('#amap-time-badge'));
    await page.locator('.day-button[data-day="0"]').click();
    await page.waitForFunction(() => window.routeProvider.requests.length >= 2);

    // first save: slow (will be superseded)
    await page.evaluate(() => {
      window.routeProvider.delay = 500;
      window.routeProvider.distance = 11111;
    });
    const beforeFirst = await requestCount(page);
    await applyStay(page, 'custom-a');
    await page.waitForFunction((n) => window.routeProvider.requests.length === n + 2, beforeFirst);

    // second save (latest): fast
    await page.evaluate(() => {
      window.routeProvider.delay = 10;
      window.routeProvider.distance = 22222;
    });
    await applyStay(page, 'custom-b');

    await waitForEstimate(page, '已更新 22.2 km · 1 小时 35 分钟');
    assert.equal(await page.locator('#day-detail .navigation-panel strong').textContent(), '海拉尔东山机场 → 湖边小筑');
    assert.equal(await page.locator('.map-legend').textContent(), '高德路线已更新');

    // the latest request carries the SECOND base's coordinates (generation-gated);
    // for a night-0 change day 1 is requested last, so its ORIGIN is 湖边小筑
    const latest = await page.evaluate((customB) => {
      const target = window.routeProvider.requests.at(-1);
      const expected = window.coordtransform.wgs84togcj02(customB.lng, customB.lat);
      return target.origin.getLng() === expected[0] && Math.abs(target.origin.getLat() - expected[1]) < 1e-6;
    }, CUSTOM_B);
    assert.equal(latest, true, 'latest request originates from 湖边小筑');

    // let the delayed first-save responses fire: they must NOT overwrite
    await page.waitForTimeout(800);
    assert.equal(await page.locator('#day-detail .route-estimate').textContent(), '已更新 22.2 km · 1 小时 35 分钟');
    assert.equal(await page.locator('.map-legend').textContent(), '高德路线已更新');
  } finally {
    await close();
  }
});

test('switching the selected day mid-flight: a late response for the previous day never attaches to the new day', async () => {
  const { page, close } = await openApp({ init: initWithSeedAndDelay({ 0: 'custom-a' }, 400) });
  try {
    await waitForMap(page);
    // boot re-queries for days {0,1} are in flight (slow); don't wait for the badge
    await page.waitForFunction(() => window.routeProvider.requests.length >= 2);

    // switch selection away while they are in flight, then make the new query fast
    await page.locator('.day-button[data-day="2"]').click();
    await page.evaluate(() => {
      window.routeProvider.delay = 10;
      window.routeProvider.distance = 33333;
    });
    await page.locator('.day-button[data-day="2"]').click();
    await waitForEstimate(page, '已更新 33.3 km · 1 小时 35 分钟');

    // let every delayed boot response arrive — none may touch day 2's display
    await page.waitForTimeout(800);
    assert.equal(await page.locator('#day-detail .route-estimate').textContent(), '已更新 33.3 km · 1 小时 35 分钟');
    assert.equal(await page.locator('.day-button[aria-pressed="true"]').getAttribute('data-day'), '2');
    assert.equal(await page.locator('.map-legend').textContent(), '行程连线示意 · 非道路导航');
    assert.equal(await page.locator('#day-detail .navigation-panel strong').textContent(), '额尔古纳市 → 莫尔道嘎国家森林公园');

    // the previously-selected changed day still settled to updated (its own state)
    await page.evaluate(() => {
      window.routeProvider.distance = 43210;
    });
    await page.locator('.day-button[data-day="1"]').click();
    await waitForEstimate(page, '已更新 43.2 km · 1 小时 35 分钟');
  } finally {
    await close();
  }
});

test('boot with a legacy-format stays override queries the affected days and settles (reference status elsewhere)', async () => {
  const { page, close } = await openApp({ init: initWithSeed({ 2: 'custom-a' }) });
  try {
    await waitForMap(page);
    // affected days {2,3} get boot queries; the selected day-0 reference query completes
    await page.waitForFunction(() => window.routeProvider.requests.length >= 3);
    await page.waitForFunction(() => document.querySelector('#amap-time-badge'));

    const inPage = await page.evaluate((customA) => {
      const coordinate = window.routeProvider.requests.filter((request) => request.coordinate);
      const lngLat = (request) =>
        request.origin instanceof window.AMap.LngLat && request.destination instanceof window.AMap.LngLat;
      // day 2 = 额尔古纳 → 草原民宿 (via = the day-2 keyword-only nav stop)
      const target = window.coordtransform.wgs84togcj02(customA.lng, customA.lat);
      const day2 = coordinate.find(
        (request) =>
          lngLat(request) &&
          request.destination.getLng() === target[0] &&
          Math.abs(request.destination.getLat() - target[1]) < 1e-6,
      );
      return {
        coordinateCount: coordinate.length,
        day2Destination: Boolean(day2),
        day2Via: day2 ? day2.waypoints.map((point) => point.keyword) : [],
        day3Via: coordinate
          .flatMap((request) => request.waypoints.map((point) => point.keyword))
          .filter((keyword) => keyword === '室韦口岸'),
      };
    }, CUSTOM_A);
    assert.equal(inPage.coordinateCount, 2, 'exactly the affected days {2,3} use the coordinate overload');
    assert.equal(inPage.day2Destination, true, 'day-2 boot query targets 草原民宿');
    assert.deepEqual(inPage.day2Via, ['莫尔道嘎国家森林公园'], 'day-2 boot query keeps the keyword-only nav via');
    assert.deepEqual(inPage.day3Via, ['室韦口岸'], 'day-3 boot query keeps the 室韦口岸 via keyword');

    // the affected days settle to updated with the new endpoint names
    await page.locator('.day-button[data-day="2"]').click();
    await waitForEstimate(page, UPDATED_LABEL);
    assert.equal(await page.locator('#day-detail .navigation-panel strong').textContent(), '额尔古纳 → 草原民宿');
    assert.equal(await page.locator('.map-legend').textContent(), '高德路线已更新');
    await page.locator('.day-button[data-day="3"]').click();
    await waitForEstimate(page, UPDATED_LABEL);
    assert.equal(await page.locator('#day-detail .navigation-panel strong').textContent(), '草原民宿 → 黑山头');

    // reference days untouched (display names + reference legend; the select
    // query still marks them updated — React 03 lock)
    await page.locator('.day-button[data-day="0"]').click();
    await waitForEstimate(page, UPDATED_LABEL);
    assert.equal(await page.locator('#day-detail .navigation-panel strong').textContent(), '海拉尔东山机场 → 海拉尔市区');
    assert.equal(await page.locator('.map-legend').textContent(), '行程连线示意 · 非道路导航');
  } finally {
    await close();
  }
});