const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openApp } = require('../helpers/vite-app.cjs');

// Ticket 06 — accommodation base manager (app.html entry): edit a shared base
// propagates to every referencing night + summary + route re-query (stub);
// in-use delete blocked with the exact legacy message; default bases keep no
// edit/delete; the alternate (备选) group lists unused customs; single-night
// restore touches only that night; persistence across reload; write-failure
// shows the exact failure string. Legacy manager conventions (note D part 2)
// are mirrored: `data-manager-base` cards, `data-manager-edit/-delete/-restore`,
// `#accommodation-manager-status` (data-state error|ok).

const STORAGE_KEY = 'hailar-slow-trip-accommodation-v1';
const WRITE_FAILURE_STATUS = '当前浏览器未允许保存，住宿安排未改变。';
const UPDATED_LABEL = '已更新 43.2 km · 1 小时 35 分钟'; // stub distance 43210 / time 5678

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

/** Seed storage with custom-a on the given nights (self-contained init body). */
function initWithSeed(stays) {
  const seed = JSON.stringify({
    version: 1,
    bases: [{ id: 'custom-a', name: '草原民宿', type: 'area', lat: 49.6, lng: 119.9, address: '海拉尔区近郊', notes: '', createdAt: '2026-09-01T00:00:00.000Z' }],
    stays,
  });
  // eslint-disable-next-line no-new-func
  return new Function(
    `localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, JSON.parse(${JSON.stringify(JSON.stringify(seed))}));`,
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

async function waitForStatus(page, text) {
  await page.waitForFunction(
    (expected) => {
      const current = document.querySelector('#accommodation-manager-status')?.textContent || '';
      return current === expected || current.includes(expected);
    },
    text,
  );
}

async function openAccommodationDialog(page) {
  await page.locator('#day-detail [data-accommodation-open]').first().click();
  await page.locator('#accommodation-dialog').waitFor({ state: 'visible' });
}

async function openManager(page) {
  await openAccommodationDialog(page);
  await page.getByRole('button', { name: '管理住宿基地' }).click();
  await page.locator('#accommodation-manager-dialog').waitFor({ state: 'visible' });
}

/**
 * Legacy createBase helper flow (tests/helpers/browser.cjs): fill the name,
 * pick a position on the Leaflet map, then save-and-apply to the given nights.
 */
async function createBaseWithNights(page, name, nights) {
  await page.getByRole('button', { name: '新增住宿基地' }).click();
  await page.locator('#accommodation-new-name').fill(name);
  await page.getByRole('button', { name: '在地图上选点' }).click();
  await page.locator('#accommodation-map-picker').waitFor({ state: 'visible' });
  await page.locator('#route-map').click({ position: { x: 250, y: 250 } });
  await page.locator('#accommodation-new-lat').waitFor({ state: 'visible' });
  await page.locator('input[name="accommodation-nights"][value="0"]').uncheck();
  for (const night of nights) await page.locator(`input[name="accommodation-nights"][value="${night}"]`).check();
  await page.getByRole('button', { name: '保存并应用' }).click();
  await page.locator('#accommodation-dialog').waitFor({ state: 'hidden' });
}

/** The visible manager card for a base name. */
function managerCard(page, name) {
  return page.locator('#accommodation-manager-dialog [data-manager-base]').filter({ hasText: name });
}

test('editing a shared base propagates to all nights, summary and (stale) route, and survives reload', async () => {
  const { page, close } = await openApp({ amapConfig404: true });
  try {
    await waitForMap(page);
    await openAccommodationDialog(page);
    await createBaseWithNights(page, '北岸民宿', [0, 5]);

    await openManager(page);
    const card = managerCard(page, '北岸民宿');
    assert.equal(await card.count(), 1);
    assert.match(await card.innerText(), /正在使用/);
    assert.match(await card.innerText(), /第 1 晚/);
    assert.match(await card.innerText(), /第 6 晚/);

    await card.getByRole('button', { name: '编辑', exact: true }).click();
    await page.getByLabel('编辑基地名称', { exact: true }).fill('北岸改名民宿');
    await page.getByLabel('编辑备注（选填）', { exact: true }).fill('编辑后的入住提示');
    await page.getByLabel('编辑纬度', { exact: true }).fill('49.7001');
    await page.getByLabel('编辑经度', { exact: true }).fill('119.8002');
    await page.getByRole('button', { name: '保存修改', exact: true }).click();
    await waitForStatus(page, '住宿基地已更新。');
    await page.waitForFunction(
      (expected) => window.localStorage.getItem('hailar-slow-trip-accommodation-v1')?.includes(expected),
      '北岸改名民宿',
    );

    // both referencing nights + stay note show the new name; count unchanged (5 distinct)
    assert.equal(await page.locator('#day-detail .stay-card strong').textContent(), '北岸改名民宿');
    assert.ok((await page.locator('#stay-note-text').textContent()).includes('北岸改名民宿 1 晚'));
    assert.equal(await page.locator('#accommodation-count').textContent(), '5');

    // close the manager, then check night 6 and the stale route on night 1
    await page.locator('#accommodation-manager-close').click();
    await page.locator('.day-button[data-day="5"]').click();
    assert.equal(await page.locator('#day-detail .stay-card strong').textContent(), '北岸改名民宿');
    await page.locator('.day-button[data-day="0"]').click();
    await waitForEstimate(page, '路线未更新');
    assert.match(await page.locator('.map-legend').textContent(), /住宿已更换 · 路线未更新/);

    // persistence: reload keeps the rename on both nights and in the manager
    await page.reload();
    await waitForMap(page);
    assert.equal(await page.locator('#day-detail .stay-card strong').textContent(), '北岸改名民宿');
    assert.equal(await page.locator('#accommodation-count').textContent(), '5');
    await page.locator('.day-button[data-day="5"]').click();
    assert.equal(await page.locator('#day-detail .stay-card strong').textContent(), '北岸改名民宿');
    await openManager(page);
    assert.equal(await managerCard(page, '北岸改名民宿').count(), 1);
    await page.locator('#accommodation-manager-close').click();
  } finally {
    await close();
  }
});

test('editing a base re-queries the affected route days with the new coordinates (AMap stub)', async () => {
  const { page, close } = await openApp({
    init: new Function(
      `${AMAP_STUB_BODY}
localStorage.setItem("hailar-slow-trip-accommodation-v1", JSON.stringify({version: 1, bases: [{id: 'custom-a', name: '草原民宿', type: 'area', lat: 49.6, lng: 119.9, address: '海拉尔区近郊', notes: '', createdAt: '2026-09-01T00:00:00.000Z'}], stays: {2: 'custom-a'}}));`,
    ),
  });
  try {
    await waitForMap(page);
    // boot: night 2 is a changed endpoint → its requery settles alongside the boot query
    await page.waitForFunction(() => window.routeProvider.requests.length >= 2);
    await page.waitForFunction(() => document.querySelector('#amap-time-badge'));
    // selected day 0 is unchanged → reference estimate stays; the changed day 2 updates
    await waitForEstimate(page, '参考里程约 6 km');
    await page.locator('.day-button[data-day="2"]').click();
    await waitForEstimate(page, UPDATED_LABEL);
    const before = await page.evaluate(() => window.routeProvider.requests.length);

    await openManager(page);
    const card = managerCard(page, '草原民宿');
    await card.getByRole('button', { name: '编辑', exact: true }).click();
    await page.getByLabel('编辑基地名称', { exact: true }).fill('草原改名民宿');
    await page.getByLabel('编辑纬度', { exact: true }).fill('50.1234');
    await page.getByLabel('编辑经度', { exact: true }).fill('119.5678');
    await page.getByRole('button', { name: '保存修改', exact: true }).click();
    await waitForStatus(page, '住宿基地已更新。');

    // routeDays {2,3}: day 2 ends at the edited base, day 3 starts from it
    await page.waitForFunction((n) => window.routeProvider.requests.length === n + 2, before);
    const check = await page.evaluate(() => {
      const slice = window.routeProvider.requests.slice(-2);
      const gcj = window.coordtransform.wgs84togcj02(119.5678, 50.1234);
      const near = (lngLat, target) =>
        lngLat instanceof window.AMap.LngLat &&
        Math.abs(lngLat.getLng() - target[0]) < 1e-6 &&
        Math.abs(lngLat.getLat() - target[1]) < 1e-6;
      return {
        coordinate: slice.every((request) => request.coordinate),
        day2Dest: near(slice[0].destination, gcj),
        day3Origin: near(slice[1].origin, gcj),
      };
    });
    assert.equal(check.coordinate, true, 'both re-queries use the coordinate overload');
    assert.equal(check.day2Dest, true, 'day-2 destination is the edited GCJ-02 position');
    assert.equal(check.day3Origin, true, 'day-3 origin is the edited GCJ-02 position');
    await waitForEstimate(page, UPDATED_LABEL);
    assert.equal(await page.locator('#day-detail .navigation-panel strong').textContent(), '额尔古纳 → 草原改名民宿');
  } finally {
    await close();
  }
});

test('in-use delete is blocked with the exact message; restore moves the base to 备选 and deletion then works', async () => {
  const { page, close } = await openApp({ amapConfig404: true });
  try {
    page.on('dialog', (dialog) => dialog.accept());
    await waitForMap(page);
    await openAccommodationDialog(page);
    await createBaseWithNights(page, '只住一晚的民宿', [0]);
    await openManager(page);

    const usedCard = managerCard(page, '只住一晚的民宿');
    await usedCard.getByRole('button', { name: '删除', exact: true }).click();
    await waitForStatus(page, '该基地正在使用，请先替换第 1 晚住宿');
    assert.equal(await page.locator('#accommodation-manager-status').getAttribute('data-state'), 'error');
    assert.equal(await managerCard(page, '只住一晚的民宿').count(), 1, 'base still listed after blocked delete');
    assert.ok(await page.evaluate(() => window.localStorage.getItem('hailar-slow-trip-accommodation-v1').includes('只住一晚的民宿')));

    // restore only night 1 → the base becomes a 备选
    await page.locator('[data-manager-restore="0"]').last().click();
    await waitForStatus(page, '已恢复默认住宿。');
    assert.equal(await page.locator('#day-detail .stay-card strong').textContent(), '海拉尔');
    assert.ok((await page.locator('#accommodation-manager-backup-list').innerText()).includes('只住一晚的民宿'));
    assert.ok(!(await page.locator('#accommodation-manager-used-list').innerText()).includes('只住一晚的民宿'));

    // now the alternate can be deleted
    await page
      .locator('#accommodation-manager-backup-list [data-manager-base]')
      .filter({ hasText: '只住一晚的民宿' })
      .getByRole('button', { name: '删除', exact: true })
      .click();
    await waitForStatus(page, '住宿基地“只住一晚的民宿”已删除。');
    assert.equal(await managerCard(page, '只住一晚的民宿').count(), 0);
    assert.equal(await page.evaluate(() => window.localStorage.getItem('hailar-slow-trip-accommodation-v1').includes('只住一晚的民宿')), false);
    assert.equal(await page.locator('#accommodation-count').textContent(), '5');
  } finally {
    await close();
  }
});

test('default bases are immutable; restore touches only the selected night and persists', async () => {
  // Seed after the first load (reload must not re-apply the init script).
  const { page, close } = await openApp({ amapConfig404: true });
  try {
    await waitForMap(page);
    await page.evaluate((seed) => localStorage.setItem('hailar-slow-trip-accommodation-v1', seed), JSON.stringify({
      version: 1,
      bases: [{ id: 'custom-a', name: '草原民宿', type: 'area', lat: 49.6, lng: 119.9, address: '海拉尔区近郊', notes: '', createdAt: '2026-09-01T00:00:00.000Z' }],
      stays: { 1: 'custom-a' },
    }));
    await page.reload();
    await waitForMap(page);
    // custom-a replaces 额尔古纳 on night 2 → still 5 distinct bases
    assert.equal(await page.locator('#accommodation-count').textContent(), '5');
    await openManager(page);

    // default base card: no edit / no delete, immutable note, associated night kept
    const defaultCard = page.locator('[data-manager-base="default-erguna"]');
    assert.match(await defaultCard.innerText(), /默认住宿不可编辑或删除/);
    assert.equal(await defaultCard.getByRole('button', { name: '编辑', exact: true }).count(), 0);
    assert.equal(await defaultCard.getByRole('button', { name: '删除', exact: true }).count(), 0);
    // 海拉尔 (still on nights 1 and 6) keeps its associated nights on the card
    assert.match(await page.locator('[data-manager-base="default-hailar"]').innerText(), /关联晚次/);

    // the used custom card lives in 正在使用
    assert.ok((await page.locator('#accommodation-manager-used-list').innerText()).includes('草原民宿'));

    // restore night 2 (index 1): only that night back to default-erguna
    await page.locator('[data-manager-restore="1"]').last().click();
    await waitForStatus(page, '已恢复默认住宿。');
    const seedState = await page.evaluate(() => JSON.parse(localStorage.getItem('hailar-slow-trip-accommodation-v1')));
    assert.ok(seedState.bases.some((base) => base.id === 'custom-a'), 'base kept as alternate');
    assert.equal(seedState.stays['1'], undefined, 'only the restored night is affected');
    assert.equal(await page.locator('#accommodation-count').textContent(), '5');
    assert.ok((await page.locator('#accommodation-manager-backup-list').innerText()).includes('草原民宿'));

    await page.locator('#accommodation-manager-close').click();
    await page.locator('.day-button[data-day="1"]').click();
    assert.equal(await page.locator('#day-detail .stay-card strong').textContent(), '额尔古纳');
    await page.locator('.day-button[data-day="0"]').click();
    assert.equal(await page.locator('#day-detail .stay-card strong').textContent(), '海拉尔', 'other nights untouched');

    await page.reload();
    await waitForMap(page);
    await page.locator('.day-button[data-day="1"]').click();
    assert.equal(await page.locator('#day-detail .stay-card strong').textContent(), '额尔古纳', 'restore survives reload');
  } finally {
    await close();
  }
});

test('manager is keyboard-operable on mobile: initial focus, editor focus, Escape close', async () => {
  const { page, close } = await openApp({ amapConfig404: true, viewport: { width: 390, height: 844 }, init: initWithSeed({ 0: 'custom-a' }) });
  try {
    await waitForMap(page);
    await openManager(page);
    assert.equal(
      await page.evaluate(() => document.activeElement?.id),
      'accommodation-manager-close',
      'close button receives initial focus',
    );
    // editor opens with focus on the name field
    await managerCard(page, '草原民宿').getByRole('button', { name: '编辑', exact: true }).click();
    assert.equal(
      await page.evaluate(() => document.activeElement?.id),
      'accommodation-manager-edit-name',
      'name field receives focus inside the editor',
    );
    // Escape closes the manager dialog entirely
    await page.keyboard.press('Escape');
    await page.locator('#accommodation-manager-dialog').waitFor({ state: 'hidden' });
    assert.ok(await page.locator('#accommodation-dialog').isHidden(), 'accommodation dialog stays closed');

    // reopen: trigger entry is reachable by keyboard (focus + Enter)
    await openAccommodationDialog(page);
    await page.getByRole('button', { name: '管理住宿基地' }).focus();
    await page.keyboard.press('Enter');
    await page.locator('#accommodation-manager-dialog').waitFor({ state: 'visible' });
    assert.equal(
      await page.locator('#accommodation-manager-default-list').innerText().then((text) => text.includes('默认住宿不可编辑或删除')),
      true,
      'default section renders on mobile',
    );
    await page.locator('#accommodation-manager-close').click();
  } finally {
    await close();
  }
});

test('storage write failure on edit keeps the current arrangement and shows the exact failure string', async () => {
  const { page, close } = await openApp({
    amapConfig404: true,
    init: () => {
      localStorage.setItem(
        'hailar-slow-trip-accommodation-v1',
        JSON.stringify({ version: 1, bases: [{ id: 'custom-a', name: '草原民宿', type: 'area', lat: 49.6, lng: 119.9, address: '海拉尔区近郊', notes: '', createdAt: '2026-09-01T00:00:00.000Z' }], stays: { 0: 'custom-a' } }),
      );
      Storage.prototype.setItem = function () {
        throw new Error('quota exceeded');
      };
    },
  });
  try {
    await waitForMap(page);
    assert.equal(await page.locator('#day-detail .stay-card strong').textContent(), '草原民宿');
    await openManager(page);
    const card = managerCard(page, '草原民宿');
    await card.getByRole('button', { name: '编辑', exact: true }).click();
    await page.getByLabel('编辑基地名称', { exact: true }).fill('改名失败民宿');
    await page.getByRole('button', { name: '保存修改', exact: true }).click();

    assert.equal(await page.locator('#accommodation-manager-status').textContent(), WRITE_FAILURE_STATUS);
    assert.equal(await page.locator('#accommodation-manager-status').getAttribute('data-state'), 'error');
    assert.ok(await page.locator('#accommodation-manager-editor').isVisible(), 'editor stays open with the draft');
    assert.equal(await page.getByLabel('编辑基地名称', { exact: true }).inputValue(), '改名失败民宿', 'draft kept');
    assert.equal(await page.locator('#day-detail .stay-card strong').textContent(), '草原民宿', 'page arrangement unchanged');
    assert.equal(await page.locator('#accommodation-count').textContent(), '6');
  } finally {
    await close();
  }
});
