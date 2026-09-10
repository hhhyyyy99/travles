const test = require('node:test');
const assert = require('node:assert/strict');
const chromium = require('playwright').chromium;
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

async function openGuide(init, options = {}) {
  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + path.sep) || pathname === '/amap-config.js') {
      response.writeHead(404);
      response.end();
      return;
    }
    try {
      const body = await fs.readFile(file);
      response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined});
    const page = await browser.newPage({viewport: options.viewport || {width: 1280, height: 900}});
    page.setDefaultTimeout(8000);
    await page.route('**/*', route => route.request().url().startsWith('http://127.0.0.1:') ? route.continue() : route.abort());
    if (init) await page.addInitScript(init);
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    return {page, close: async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); }};
  } catch (error) {
    await browser?.close();
    server.close();
    throw error;
  }
}

async function openAccommodation(page) {
  await page.locator('#day-detail [data-accommodation-open]').click();
  await page.getByRole('button', {name: '新增住宿基地', exact: true}).click();
}

function amapStub() {
  window.AMap = {
    PlaceSearch: class {
      constructor() {}
      search(query, callback) {
        callback('complete', {poiList: {pois: [{id: 'poi-lodge', name: query === '附近旅店' ? '松林小院' : '额尔古纳湿地', address: '额尔古纳市河西', location: {lng: 119.8, lat: 49.2}}]}});
      }
    }
  };
}

test('search results require confirmation before saving, then prefill the existing editor', async () => {
  const guide = await openGuide(amapStub, {viewport: {width: 390, height: 844}});
  try {
    await openAccommodation(guide.page);
    await guide.page.locator('#accommodation-search-query').fill('附近旅店');
    await guide.page.locator('#accommodation-search-query').press('Enter');
    await assert.doesNotReject(() => guide.page.getByText('松林小院', {exact: true}).waitFor());
    assert.equal(await guide.page.evaluate(() => localStorage.getItem('hailar-slow-trip-accommodation-v1')), null);
    await guide.page.getByRole('button', {name: '确认此地点', exact: true}).click();
    assert.equal(await guide.page.locator('#accommodation-new-name').inputValue(), '松林小院');
    assert.equal(await guide.page.locator('#accommodation-new-address').inputValue(), '额尔古纳市河西');
    assert.equal(await guide.page.locator('#accommodation-new-lat').inputValue(), '49.198097');
    assert.equal(await guide.page.evaluate(() => localStorage.getItem('hailar-slow-trip-accommodation-v1')), null);
    await guide.page.getByRole('button', {name: '仅保存为备选', exact: true}).click();
    assert.equal(await guide.page.evaluate(() => JSON.parse(localStorage.getItem('hailar-slow-trip-accommodation-v1')).bases[0].name), '松林小院');
  } finally {
    await guide.close();
  }
});

test('nearby duplicate can be reused or deliberately continued as a new base', async () => {
  const init = () => {
    window.AMap = {
      PlaceSearch: class {
        search(query, callback) { callback('complete', {poiList: {pois: [{id: 'poi-lodge', name: '松林小院', address: '额尔古纳市河西', location: {lng: 119.8, lat: 49.2}}]}}); }
      }
    };
    localStorage.setItem('hailar-slow-trip-accommodation-v1', JSON.stringify({version: 1, bases: [{id: 'custom-existing', name: '松林小院', type: 'hotel', lat: 49.19, lng: 119.79, address: '旧地址', notes: '', createdAt: new Date().toISOString()}], stays: {}}));
  };
  const guide = await openGuide(init);
  try {
    await openAccommodation(guide.page);
    await guide.page.locator('#accommodation-search-query').fill('松林小院');
    await guide.page.getByRole('button', {name: '搜索地点', exact: true}).click();
    await guide.page.getByRole('button', {name: '确认此地点', exact: true}).click();
    await guide.page.getByRole('alert').waitFor();
    await guide.page.getByRole('button', {name: '使用已有：松林小院', exact: true}).click();
    assert.match(await guide.page.locator('#accommodation-selected-label').textContent(), /松林小院/);
    await guide.page.getByRole('button', {name: '确认此地点', exact: true}).click();
    await guide.page.getByRole('button', {name: '继续新增「松林小院」', exact: true}).click();
    assert.equal(await guide.page.locator('#accommodation-new-name').inputValue(), '松林小院');
    assert.equal(await guide.page.locator('#accommodation-new-lat').inputValue(), '49.198097');
  } finally {
    await guide.close();
  }
});

test('empty and failed place searches give distinct feedback while keeping the fallback available', async () => {
  const init = () => {
    window.AMap = {
      PlaceSearch: class {
        search(query, callback) {
          callback(query === '无结果' ? 'no_data' : 'error', {});
        }
      }
    };
  };
  const guide = await openGuide(init);
  try {
    await openAccommodation(guide.page);
    await guide.page.locator('#accommodation-search-query').fill('无结果');
    await guide.page.getByRole('button', {name: '搜索地点', exact: true}).click();
    await guide.page.getByText(/没有找到匹配地点/).waitFor();
    assert.equal(await guide.page.locator('#accommodation-editor').getAttribute('hidden'), null);
    await guide.page.locator('#accommodation-search-query').fill('服务失败');
    await guide.page.getByRole('button', {name: '搜索地点', exact: true}).click();
    await guide.page.getByText(/地点搜索暂时不可用/).waitFor();
    assert.equal(await guide.page.locator('#accommodation-new-name').inputValue(), '服务失败');
    assert.equal(await guide.page.locator('#accommodation-editor').getAttribute('hidden'), null);
  } finally {
    await guide.close();
  }
});

test('search failure preserves the query and opens manual map selection', async () => {
  const guide = await openGuide(() => { window.AMap = {}; });
  try {
    await openAccommodation(guide.page);
    await guide.page.getByLabel('基地名称', {exact: true}).fill('手填的酒店');
    await guide.page.getByLabel('详细地址（选填）', {exact: true}).fill('先填地址');
    await guide.page.getByLabel('备注（选填）', {exact: true}).fill('先填备注');
    await guide.page.locator('#accommodation-search-query').fill('没有配置的酒店');
    await guide.page.getByRole('button', {name: '搜索地点', exact: true}).click();
    await guide.page.getByText(/需要先连接高德地图/).waitFor();
    assert.equal(await guide.page.locator('#accommodation-search-query').inputValue(), '没有配置的酒店');
    assert.equal(await guide.page.locator('#accommodation-new-name').inputValue(), '手填的酒店');
    assert.equal(await guide.page.locator('#accommodation-new-address').inputValue(), '先填地址');
    assert.equal(await guide.page.locator('#accommodation-new-notes').inputValue(), '先填备注');
    assert.equal(await guide.page.locator('#accommodation-editor').getAttribute('hidden'), null);
  } finally {
    await guide.close();
  }
});
