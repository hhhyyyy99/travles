const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require('playwright');

const root = path.resolve(__dirname, '..');
const MIME = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png'};

async function openGuide() {
  const server = http.createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    const relative = pathname === '/' ? '/index.html' : pathname;
    const file = path.resolve(root, `.${relative}`);
    if (!file.startsWith(`${root}${path.sep}`) || relative.split('/').some(segment => segment.startsWith('.'))) {
      response.writeHead(404); response.end(); return;
    }
    try {
      const data = await fs.readFile(file);
      response.writeHead(200, {'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store'});
      response.end(data);
    } catch {
      response.writeHead(404); response.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined});
    const page = await browser.newPage({acceptDownloads: true, viewport: {width: 1280, height: 900}});
    page.setDefaultTimeout(8000);
    await page.route('**/*', route => route.request().url().startsWith('http://127.0.0.1:') ? route.continue() : route.abort());
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => Boolean(window.tibetAccommodation?.getBackup));
    return {page, close: async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); }};
  } catch (error) {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    throw error;
  }
}

const base = (id, name) => ({id, name, type: 'hotel', lat: 49.31, lng: 119.71, address: '测试地址', notes: '测试备注', createdAt: '2026-09-10T00:00:00.000Z'});

test('住宿备份可以预览、取消、整体恢复，并拒绝无效或失败写入', async t => {
  const guide = await openGuide();
  t.after(guide.close);
  const {page} = guide;
  await page.evaluate(() => localStorage.clear());

  const initial = await page.evaluate(() => {
    const saved = window.tibetAccommodation.saveBase({id: 'custom-initial', name: '初始民宿', type: 'hotel', lat: 49.31, lng: 119.71, address: '初始地址', notes: '初始备注', createdAt: '2026-09-10T00:00:00.000Z'});
    if (!saved.ok) throw new Error(saved.error);
    const assigned = window.tibetAccommodation.assign('custom-initial', [1, 2]);
    if (!assigned.ok) throw new Error(assigned.error);
    return window.tibetAccommodation.getState();
  });
  assert.deepEqual(initial.bases.map(item => item.id), ['custom-initial']);
  assert.equal(initial.stays[1], 'custom-initial');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', {name: '导出或恢复住宿备份'}).click().then(() => page.getByRole('button', {name: '导出当前备份'}).click())
  ]);
  const exported = JSON.parse(await fs.readFile(await download.path(), 'utf8'));
  assert.equal(exported.format, 'hailar-slow-trip-accommodation');
  assert.equal(exported.version, 1);
  assert.deepEqual(exported.bases.map(item => item.id), ['custom-initial']);
  assert.equal(exported.stays['1'], 'custom-initial');
  assert.equal(Object.hasOwn(exported, 'amapKey'), false);

  const replacement = {
    format: 'hailar-slow-trip-accommodation',
    version: 1,
    bases: [base('custom-restored', '恢复后的酒店')],
    stays: {'0': 'default-hailar', '1': 'custom-restored', '2': 'default-mordaoga', '3': 'default-heishantou', '4': 'default-manzhouli', '5': 'default-hailar'}
  };
  const initialSnapshot = JSON.stringify(initial);
  await page.locator('#accommodation-backup-file').setInputFiles({name: 'replacement.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(replacement))});
  await assert.doesNotReject(() => page.getByText('将整体替换当前住宿安排').waitFor());
  assert.match(await page.locator('#accommodation-backup-preview').innerText(), /恢复后的酒店/);
  await page.getByRole('button', {name: '确认整体替换'}).click();
  const restored = await page.evaluate(() => window.tibetAccommodation.getState());
  assert.deepEqual(restored.bases.map(item => item.id), ['custom-restored']);
  assert.equal(restored.stays[1], 'custom-restored');
  assert.equal(restored.stays[2], 'default-mordaoga');
  assert.notEqual(JSON.stringify(restored), initialSnapshot);
  await page.reload();
  await page.waitForFunction(() => Boolean(window.tibetAccommodation?.getBackup));
  assert.deepEqual(await page.evaluate(() => window.tibetAccommodation.getState()), restored);

  await page.getByRole('button', {name: '导出或恢复住宿备份'}).click();
  await page.locator('#accommodation-backup-file').setInputFiles({name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({...replacement, version: 99}))});
  await page.getByText(/版本不受支持/).waitFor();
  assert.deepEqual(await page.evaluate(() => window.tibetAccommodation.getState()), restored);

  const dangling = {...replacement, stays: {...replacement.stays, '1': 'missing-base'}};
  await page.locator('#accommodation-backup-file').setInputFiles({name: 'dangling.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(dangling))});
  await page.getByText(/不存在的住宿基地/).waitFor();
  assert.deepEqual(await page.evaluate(() => window.tibetAccommodation.getState()), restored);

  const cancelled = {...replacement, bases: [base('custom-cancelled', '取消的酒店')], stays: {...replacement.stays, '1': 'custom-cancelled'}};
  await page.locator('#accommodation-backup-file').setInputFiles({name: 'cancelled.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(cancelled))});
  await page.getByText('取消的酒店').waitFor();
  await page.getByRole('button', {name: '取消', exact: true}).click();
  assert.deepEqual(await page.evaluate(() => window.tibetAccommodation.getState()), restored);

  const failedWrite = await page.evaluate(next => {
    const original = localStorage.setItem;
    Object.defineProperty(localStorage, 'setItem', {configurable: true, value() { throw new Error('quota'); }});
    const result = window.tibetAccommodation.replaceState(next);
    delete localStorage.setItem;
    return {result, state: window.tibetAccommodation.getState()};
  }, cancelled);
  assert.equal(failedWrite.result.ok, false);
  assert.deepEqual(failedWrite.state, restored);

  const invalidCoordinate = await page.evaluate(next => window.tibetAccommodation.validateBackup({...next, bases: [{...next.bases[0], lat: ''}]}), replacement);
  assert.equal(invalidCoordinate.ok, false);
  assert.match(invalidCoordinate.error, /位置无效/);
});
