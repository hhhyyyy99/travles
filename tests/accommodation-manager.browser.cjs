const {test} = require('node:test');
const assert = require('node:assert/strict');
const {openGuide, createBase} = require('./helpers/browser.cjs');

test('manager edits a shared base, protects used deletion, restores nights, then deletes backup', async () => {
  const guide = await openGuide();
  try {
    const {page} = guide;
    page.on('dialog', dialog => dialog.accept());
    await createBase(page, '北岸民宿', {nights: [0, 5]});

    await page.getByRole('button', {name: '住宿基地', exact: true}).click();
    const manager = page.locator('#accommodation-manager-dialog');
    assert.equal(await manager.isVisible(), true);
    const baseCard = manager.locator('[data-manager-base]').filter({hasText: '北岸民宿'});
    assert.equal(await baseCard.count(), 1);
    assert.match(await baseCard.innerText(), /第 1 晚/);
    assert.match(await baseCard.innerText(), /第 6 晚/);

    await baseCard.getByRole('button', {name: '编辑', exact: true}).click();
    await page.getByLabel('编辑基地名称', {exact: true}).fill('北岸改名民宿');
    await page.getByLabel('编辑备注（选填）', {exact: true}).fill('编辑后的入住提示');
    await page.getByLabel('编辑纬度', {exact: true}).fill('49.7001');
    await page.getByLabel('编辑经度', {exact: true}).fill('119.8002');
    await page.getByRole('button', {name: '保存修改', exact: true}).click();
    await page.waitForFunction(() => window.tibetAccommodation.getBase(window.tibetAccommodation.getState().usedBaseIds.find(id => id.startsWith('custom-')))?.name === '北岸改名民宿');
    assert.match(await page.locator('#day-detail .stay-card').innerText(), /北岸改名民宿/);
    assert.match(await page.locator('#day-detail .route-estimate').innerText(), /路线未更新/);

    const renamedCard = manager.locator('[data-manager-base]').filter({hasText: '北岸改名民宿'});
    await renamedCard.getByRole('button', {name: '删除', exact: true}).click();
    assert.match(await page.locator('#accommodation-manager-status').innerText(), /正在使用/);
    assert.ok(await page.evaluate(() => window.tibetAccommodation.listBases().some(base => base.name === '北岸改名民宿')));

    await page.locator('[data-manager-restore="0"]').last().click();
    await page.locator('[data-manager-restore="5"]').last().click();
    await page.waitForFunction(() => window.tibetAccommodation.getState().usedBaseIds.every(id => !id.startsWith('custom-')));
    const backupCard = manager.locator('[data-manager-base]').filter({hasText: '北岸改名民宿'});
    await backupCard.getByRole('button', {name: '删除', exact: true}).click();
    assert.equal(await manager.locator('[data-manager-base]').filter({hasText: '北岸改名民宿'}).count(), 0);
    assert.equal(await page.evaluate(() => window.tibetAccommodation.listBases().some(base => base.name === '北岸改名民宿')), false);
    assert.match(await manager.innerText(), /默认住宿不可编辑或删除/);
  } finally {
    await guide.close();
  }
});

test('manager keeps default bases immutable and restores a single night', async () => {
  const guide = await openGuide();
  try {
    const {page} = guide;
    await createBase(page, '只住一晚的民宿', {nights: [1]});
    await page.getByRole('button', {name: '住宿基地', exact: true}).click();
    const manager = page.locator('#accommodation-manager-dialog');
    const defaultCard = manager.locator('[data-manager-base="default-erguna"]');
    assert.match(await defaultCard.innerText(), /默认住宿不可编辑或删除/);
    assert.equal(await defaultCard.getByRole('button', {name: '编辑', exact: true}).count(), 0);
    assert.equal(await defaultCard.getByRole('button', {name: '删除', exact: true}).count(), 0);

    await page.locator('[data-manager-restore="1"]').last().click();
    await page.waitForFunction(() => window.tibetAccommodation.getDayStay(1).id === 'default-erguna');
    assert.match(await page.locator('#day-detail .stay-card').innerText(), /额尔古纳/);
  } finally {
    await guide.close();
  }
});
