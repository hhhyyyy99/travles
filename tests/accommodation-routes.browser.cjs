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
    const forestWaypoint=await page.evaluate(() => window.routeProvider.requests.filter(r=>r.coordinate).flatMap(r=>r.waypoints).find(p=>p.keyword?.includes('森林公园')));
    assert.equal(forestWaypoint.location, undefined);
    await page.locator('[data-day="2"]').click();
    assert.match(await page.locator('.navigation-note').innerText(), /省略该途经点|没有使用镇中心坐标/);
    const d2Url=await page.locator('.navigation-primary').getAttribute('href');
    assert.equal(new URL(d2Url).searchParams.has('via'), false);
    assert.equal(await page.locator('.navigation-place-links a').count(), 1);
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

async function staleNormalScenario(action, expected) {
  const init = `(${installAMapStub.toString()})(); window.routeProvider.delay=600; window.routeProvider.distance=11111;`;
  const guide = await openGuide({init});
  try {
    const {page}=guide;
    await page.waitForFunction(() => Boolean(window.tibetAccommodation?.getBackup));
    await action(page);
    await page.waitForTimeout(750);
    const result=await page.evaluate(() => ({
      status: window.tibetAccommodation.getRouteState(0).status,
      estimate: document.querySelector('#day-detail .route-estimate')?.textContent || '',
      oldRequestDone: window.routeProvider.requests.some(request => request.distance === 11111 && request.completed),
      liveResults: document.querySelector('#live-results')?.textContent || ''
    }));
    assert.equal(result.oldRequestDone, true);
    assert.equal(result.status, expected.status);
    assert.match(result.estimate, expected.estimate);
    if (expected.distance) assert.match(result.liveResults, expected.distance);
  } finally { await guide.close(); }
}

test('the delayed initial normal response cannot revive a route after each lodging mutation', async () => {
  const applyCustom = async page => page.evaluate(() => {
    window.routeProvider.delay=10;
    window.routeProvider.distance=22222;
    const saved=window.tibetAccommodation.saveBase({id:'custom-delayed', name:'延迟响应住宿', type:'hotel', lat:49.31, lng:119.71, address:'测试地址', notes:''});
    if (!saved.ok) throw new Error(saved.error);
    const assigned=window.tibetAccommodation.assign('custom-delayed',[0]);
    if (!assigned.ok) throw new Error(assigned.error);
  });
  const edit = page => page.evaluate(() => {
    window.routeProvider.delay=10;
    window.routeProvider.distance=22222;
    const saved=window.tibetAccommodation.saveBase({id:'custom-delayed', name:'延迟响应住宿', type:'hotel', lat:49.31, lng:119.71, address:'测试地址', notes:''});
    if (!saved.ok) throw new Error(saved.error);
    if (!window.tibetAccommodation.assign('custom-delayed',[0]).ok) throw new Error('assign failed');
    if (!window.tibetAccommodation.updateBase('custom-delayed',{lat:49.32,lng:119.72}).ok) throw new Error('update failed');
  });
  const backup={format:'hailar-slow-trip-accommodation',version:1,bases:[{id:'custom-delayed', name:'延迟响应住宿', type:'hotel', lat:49.31, lng:119.71, address:'测试地址', notes:''}],stays:{0:'custom-delayed',1:'default-erguna',2:'default-mordaoga',3:'default-heishantou',4:'default-manzhouli',5:'default-hailar'}};
  const replace = page => page.evaluate(value => {
    window.routeProvider.delay=10;
    window.routeProvider.distance=22222;
    const result=window.tibetAccommodation.replaceState(value);
    if (!result.ok) throw new Error(result.error);
  }, backup);
  const restore = page => page.evaluate(() => {
    window.routeProvider.delay=10;
    window.routeProvider.distance=22222;
    const saved=window.tibetAccommodation.saveBase({id:'custom-delayed', name:'延迟响应住宿', type:'hotel', lat:49.31, lng:119.71, address:'测试地址', notes:''});
    if (!saved.ok) throw new Error(saved.error);
    if (!window.tibetAccommodation.assign('custom-delayed',[0]).ok) throw new Error('assign failed');
    if (!window.tibetAccommodation.restoreDay(0).ok) throw new Error('restore failed');
  });
  await staleNormalScenario(applyCustom, {status:'updated', estimate:/已更新/, distance:/22\.2/});
  await staleNormalScenario(edit, {status:'updated', estimate:/已更新/, distance:/22\.2/});
  await staleNormalScenario(replace, {status:'updated', estimate:/已更新/, distance:/22\.2/});
  await staleNormalScenario(restore, {status:'reference', estimate:/参考里程/});
});
