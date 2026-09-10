const {test} = require('node:test');
const assert = require('node:assert/strict');
const {openGuide} = require('./helpers/browser.cjs');
const {installAMapStub} = require('./helpers/amap-stub.cjs');

test('configured AMap starts automatically without asking the visitor to connect', async () => {
  const guide = await openGuide({init: installAMapStub});
  try {
    const {page} = guide;
    await page.waitForFunction(() => document.querySelector('.map-wrap').classList.contains('amap-active'));
    assert.equal(await page.locator('#connect-amap').isVisible(), false);
    assert.equal(await page.locator('#amap-settings').isVisible(), false);
    assert.equal(await page.locator('#amap-dialog').isVisible(), false);
  } finally { await guide.close(); }
});

test('configured AMap retries loading with saved credentials rather than opening a credential dialog', async () => {
  const guide = await openGuide({init: () => {window.TIBET_AMAP_CONFIG = {key:'test-only',securityJsCode:'test-only'};}});
  try {
    const {page} = guide;
    await page.waitForFunction(() => document.getElementById('amap-state').textContent.includes('失败'));
    assert.equal(await page.locator('#amap-settings').isVisible(), false);
    assert.equal(await page.locator('#connect-amap').innerText(), '重试加载地图');
    await page.evaluate(installAMapStub);
    await page.getByRole('button', {name:'重试加载地图',exact:true}).click();
    await page.waitForFunction(() => document.querySelector('.map-wrap').classList.contains('amap-active'));
    assert.equal(await page.locator('#amap-dialog').isVisible(), false);
    assert.equal(await page.locator('#connect-amap').isVisible(), false);
  } finally { await guide.close(); }
});
