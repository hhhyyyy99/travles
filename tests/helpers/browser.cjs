const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
async function openGuide(options = {}) {
  const root = path.resolve(__dirname, '../..');
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + path.sep) || pathname === '/amap-config.js') { res.writeHead(404); return res.end(); }
    try {
      const data = await fs.readFile(file);
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(data);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined});
    const page = await browser.newPage({viewport: options.viewport || {width: 1280, height: 900}});
    page.setDefaultTimeout(8000);
    await page.route('**/*', route => route.request().url().startsWith('http://127.0.0.1:') ? route.continue() : route.abort());
    if (options.init) await page.addInitScript(options.init);
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    return {page, close: async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); }};
  } catch (error) { await browser?.close(); server.close(); throw error; }
}
async function createBase(page, name, {nights = [0], apply = true} = {}) {
  await page.locator('#day-detail [data-accommodation-open]').click();
  await page.getByRole('button', {name: '新增住宿基地', exact: true}).click();
  await page.getByLabel('基地名称', {exact: true}).fill(name);
  await page.getByRole('button', {name: '在地图上选点', exact: true}).click();
  await page.locator('#route-map').click({position: {x: 250, y: 250}});
  for (let i = 0; i < 6; i++) await page.locator(`input[name="accommodation-nights"][value="${i}"]`).setChecked(nights.includes(i));
  await page.getByRole('button', {name: apply ? '保存并应用' : '仅保存为备选', exact: true}).click();
}
module.exports = {openGuide, createBase};
