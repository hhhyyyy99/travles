const {test} = require('node:test');
const assert = require('node:assert/strict');
const {openGuide, createBase} = require('./helpers/browser.cjs');

test('map-picked accommodation persists across nights and never shows stale distance', async () => {
  const guide = await openGuide();
  try {
    const {page} = guide;
    await createBase(page, '浏览器验收民宿', {nights: [0, 5]});
    await page.reload();
    assert.match(await page.locator('#day-detail').innerText(), /浏览器验收民宿/);
    assert.match(await page.locator('#day-detail .day-stats').innerText(), /路线未更新/);
    assert.doesNotMatch(await page.locator('#day-detail .day-stats').innerText(), /10–15/);
    await page.locator('[data-day="6"]').click();
    assert.match(await page.locator('.navigation-panel').innerText(), /浏览器验收民宿 → 海拉尔东山机场/);
    assert.equal(await page.locator('#accommodation-count').innerText(), '5');
    assert.doesNotMatch(await page.locator('.summary').innerText(), /1,000–1,100/);
  } finally { await guide.close(); }
});

test('a name without a confirmed map position cannot be saved', async () => {
  const guide = await openGuide();
  try {
    const {page} = guide;
    await page.locator('#day-detail [data-accommodation-open]').click();
    await page.getByRole('button', {name: '新增住宿基地', exact: true}).click();
    await page.getByLabel('基地名称', {exact: true}).fill('没有位置的酒店');
    await page.getByRole('button', {name: '保存并应用', exact: true}).click();
    assert.equal(await page.locator('#accommodation-dialog').isVisible(), true);
    assert.match(await page.locator('#accommodation-dialog-status').innerText(), /位置/);
    await page.getByRole('button', {name: '关闭', exact: true}).click();
    assert.doesNotMatch(await page.locator('#day-detail').innerText(), /没有位置的酒店/);
  } finally { await guide.close(); }
});

test('selecting another default base survives reload and invalidates the old route', async () => {
  const guide = await openGuide();
  try {
    const {page} = guide;
    await page.locator('#day-detail [data-accommodation-open]').click();
    await page.locator('[data-accommodation-select="default-erguna"]').click();
    await page.getByRole('button', {name: '应用到所选晚次', exact: true}).click();
    await page.reload();
    assert.match(await page.locator('#day-detail .stay-card').innerText(), /额尔古纳/);
    assert.match(await page.locator('.route-estimate').innerText(), /路线未更新/);
  } finally { await guide.close(); }
});

test('storage failure leaves the existing itinerary unchanged', async () => {
  const guide = await openGuide({init: () => {Storage.prototype.setItem = () => {throw new DOMException('Full', 'QuotaExceededError');};}});
  try {
    const {page} = guide;
    await createBase(page, '不能保存的民宿');
    assert.equal(await page.locator('#accommodation-dialog').isVisible(), true);
    assert.match(await page.locator('#accommodation-dialog-status').innerText(), /保存/);
    await page.getByRole('button', {name: '关闭', exact: true}).click();
    assert.doesNotMatch(await page.locator('#day-detail').innerText(), /不能保存的民宿/);
  } finally { await guide.close(); }
});
