const {test} = require('node:test');
const assert = require('node:assert/strict');
const {openGuide, createBase} = require('./helpers/browser.cjs');
const {installAMapStub} = require('./helpers/amap-stub.cjs');

test('changed routes preserve scenic stops and use confirmed coordinates at provider boundary', async () => {
  const guide = await openGuide({init:installAMapStub});
  try {
    const {page}=guide;
    await page.waitForFunction(() => document.getElementById('live-status').textContent.includes('成功'));
    await page.locator('[data-day="1"]').click();
    await createBase(page,'额尔古纳验收住宿',{nights:[1]});
    await page.waitForFunction(() => window.routeProvider.requests.filter(r=>r.coordinate).length >= 2);
    assert.deepEqual(await page.evaluate(() => window.routeProvider.errors), []);
    const stops=await page.evaluate(() => window.routeProvider.requests.filter(r=>r.coordinate).map(r=>r.waypoints.map(p=>p.keyword||'coordinate')));
    assert.ok(stops.some(list => list.some(p=>p.includes('湿地'))), JSON.stringify(stops));
    assert.ok(stops.some(list => list.some(p=>p.includes('森林公园'))), JSON.stringify(stops));
  } finally {await guide.close();}
});

test('a completed changed route does not revive original overview estimates', async () => {
  const guide=await openGuide({init:installAMapStub});
  try {
    const {page}=guide;
    await createBase(page,'已计算住宿',{nights:[0]});
    await page.waitForFunction(() => document.querySelector('#day-detail .route-estimate').textContent.includes('已更新'));
    await page.getByRole('button',{name:'查看全程',exact:true}).click();
    await page.waitForFunction(() => document.getElementById('overview-times'));
    assert.doesNotMatch(await page.locator('#overview-times [data-route-day="0"]').innerText(), /很短/);
  } finally {await guide.close();}
});

test('route failure retains accommodation and marks estimates unavailable', async () => {
  const guide=await openGuide({init:installAMapStub});
  try {
    const {page}=guide;
    await page.evaluate(()=>{window.routeProvider.mode='failure';});
    await createBase(page,'查询失败住宿',{nights:[0]});
    await page.waitForFunction(() => document.getElementById('live-status').textContent.includes('未取得'));
    assert.match(await page.locator('#day-detail .stay-card').innerText(), /查询失败住宿/);
    assert.match(await page.locator('#day-detail .route-estimate').innerText(), /未更新/);
  } finally {await guide.close();}
});

test('late responses cannot replace a newer accommodation route or change the selected day', async () => {
  const guide=await openGuide({init:installAMapStub});
  try {
    const {page}=guide;
    await page.waitForFunction(() => document.getElementById('live-status').textContent.includes('成功'));
    await page.evaluate(()=>{window.routeProvider.delay=1500;window.routeProvider.distance=11111;});
    await createBase(page,'旧请求住宿',{nights:[0]});
    await page.evaluate(()=>{window.routeProvider.delay=10;window.routeProvider.distance=22222;});
    await createBase(page,'最新请求住宿',{nights:[0]});
    await page.waitForFunction(() => document.querySelector('#day-detail .route-estimate').textContent.includes('22.2'));
    await page.locator('[data-day="5"]').click();
    await page.waitForFunction(() => window.routeProvider.requests.every(r=>r.completed));
    assert.equal(await page.locator('[data-day="5"]').getAttribute('aria-pressed'), 'true');
    await page.locator('[data-day="0"]').click();
    await page.waitForFunction(() => document.querySelector('#day-detail .route-estimate').textContent.includes('22.2'));
    assert.match(await page.locator('#day-detail .stay-card').innerText(), /最新请求住宿/);
    assert.doesNotMatch(await page.locator('#day-detail .route-estimate').innerText(), /11.1/);
  } finally {await guide.close();}
});
