const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openApp } = require('../helpers/vite-app.cjs');

const CHECKLIST_KEY = 'hailar-slow-trip-checklist-oct7-v2';
const SAVE_FAILURE_STATUS = '当前浏览器未允许保存，勾选仅在本页有效。';
const DEFAULT_STATUS = '勾选状态保存在当前浏览器。';

function countText(page) {
  return page.locator('#check-count').textContent();
}
function checkbox(page, value) {
  return page.locator('#checklist input[value="' + value + '"]');
}
function gridColumns(page) {
  return page.locator('#checklist').evaluate((el) => {
    return getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length;
  });
}

test('toggling checklist boxes updates the N / 6 count', async () => {
  const { page, close } = await openApp();
  try {
    assert.equal(await countText(page), '0 / 6');
    await checkbox(page, '0').check();
    await checkbox(page, '3').check();
    await checkbox(page, '5').check();
    assert.equal(await countText(page), '3 / 6');
    await checkbox(page, '0').uncheck();
    assert.equal(await countText(page), '2 / 6');
  } finally {
    await close();
  }
});

test('checklist state is restored after a reload', async () => {
  const { page, close } = await openApp();
  try {
    for (const value of ['1', '2', '4']) await checkbox(page, value).check();
    assert.equal(await countText(page), '3 / 6');
    await page.reload();
    assert.equal(await countText(page), '3 / 6');
    for (const value of ['1', '2', '4']) {
      assert.equal(await checkbox(page, value).isChecked(), true, `item ${value} restored`);
    }
    assert.equal(await checkbox(page, '0').isChecked(), false, 'untouched item stays unchecked');
  } finally {
    await close();
  }
});

test('legacy-format storage seed [0,3,5] shows 3 / 6 and survives refresh', async () => {
  const { page, close } = await openApp({
    init: () => localStorage.setItem('hailar-slow-trip-checklist-oct7-v2', '[0,3,5]'),
  });
  try {
    assert.equal(await countText(page), '3 / 6');
    for (const value of ['0', '3', '5']) {
      assert.equal(await checkbox(page, value).isChecked(), true);
    }
    await page.reload();
    assert.equal(await countText(page), '3 / 6', 'seed survives reload');
  } finally {
    await close();
  }
});

test('corrupt stored JSON renders the page with count 0 / 6', async () => {
  const { page, close } = await openApp({
    init: () => localStorage.setItem('hailar-slow-trip-checklist-oct7-v2', 'not-json'),
  });
  try {
    assert.equal(await countText(page), '0 / 6');
    assert.equal(await page.locator('#checklist input').count(), 6);
  } finally {
    await close();
  }
});

test('string-valued storage ["0"] leaves item 0 unchecked with count 0 / 6', async () => {
  const { page, close } = await openApp({
    init: () => localStorage.setItem('hailar-slow-trip-checklist-oct7-v2', '["0"]'),
  });
  try {
    assert.equal(await checkbox(page, '0').isChecked(), false);
    assert.equal(await countText(page), '0 / 6');
  } finally {
    await close();
  }
});

test('storage write failure shows the exact status string and keeps the page working', async () => {
  const { page, close } = await openApp({
    init: () => {
      Storage.prototype.setItem = function () {
        throw new Error('quota exceeded');
      };
    },
  });
  try {
    await checkbox(page, '2').check();
    assert.equal(await page.locator('#save-status').textContent(), SAVE_FAILURE_STATUS);
    assert.equal(await countText(page), '1 / 6');
    assert.equal(await checkbox(page, '2').isChecked(), true, 'in-page state kept');
    assert.notEqual(await page.locator('#save-status').textContent(), DEFAULT_STATUS);
  } finally {
    await close();
  }
});

test('Tailwind utilities actually style the checklist (3 columns + theme colors)', async () => {
  const { page, close } = await openApp();
  try {
    assert.equal(await gridColumns(page), 3, 'desktop checklist is a 3-column grid');
    const bodyBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.equal(bodyBackground, 'rgb(248, 250, 249)', 'body uses theme --paper #f8faf9');
  } finally {
    await close();
  }
});

test('mobile 390x844 viewport: two checklist columns, topbar brand caption hidden, count works', async () => {
  const { page, close } = await openApp({ viewport: { width: 390, height: 844 } });
  try {
    assert.equal(await gridColumns(page), 2, 'mobile checklist is a 2-column grid');
    const captionDisplay = await page.evaluate(() => {
      const span = document.querySelector('.brand span');
      return span ? getComputedStyle(span).display : 'missing';
    });
    assert.equal(captionDisplay, 'none', '"旅行手册 / 呼伦贝尔" caption hidden on mobile');
    await checkbox(page, '5').check();
    assert.equal(await countText(page), '1 / 6');
  } finally {
    await close();
  }
});
