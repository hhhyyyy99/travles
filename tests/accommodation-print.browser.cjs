const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {openGuide} = require('./helpers/browser.cjs');

test('print mode renders current accommodation details and suppresses stale estimates', async t => {
  const guide = await openGuide({
    viewport: {width: 1100, height: 900},
    init: () => {
    localStorage.setItem('hailar-slow-trip-accommodation-v1', JSON.stringify({
      version: 1,
      bases: [{
        id: 'custom-long-stay',
        name: '北境超长名称住宿基地示例用于换行测试',
        type: 'area',
        lat: 50.12,
        lng: 119.98,
        address: '额尔古纳市一条很长很长的代表地址，用于验证打印版不会裁切文本',
        notes: '这是需要完整保留在打印版中的入住备注，包含供暖、停车和晚间抵达说明。'
      }, {
        id: 'unused-backup',
        name: '只保存为备选的基地',
        type: 'hotel',
        lat: 50.2,
        lng: 120.1
      }],
      stays: {1: 'custom-long-stay', 2: 'custom-long-stay'}
    }));
    }
  });
  t.after(() => guide.close());
  const {page} = guide;
  await page.waitForSelector('#print-itinerary .print-day', {state: 'attached'});
  await page.emulateMedia({media: 'print'});

  const result = await page.evaluate(() => {
    const print = document.querySelector('#print-itinerary');
    const stale = [...print.querySelectorAll('.print-route.is-stale')];
    return {
      display: getComputedStyle(print).display,
      bodyText: print.innerText,
      customCards: print.querySelectorAll('[data-stay-id="custom-long-stay"]').length,
      usedCount: print.querySelector('.print-sheet-summary')?.textContent,
      actionButtons: print.querySelectorAll('button, input, select, textarea').length,
      staleCount: stale.length,
      staleText: stale.map(element => element.innerText).join('\n'),
      oldEstimateVisible: stale.some(element => element.innerText.includes('约 220 km') || element.innerText.includes('约 250 km')),
      longTextVisible: print.innerText.includes('北境超长名称住宿基地示例用于换行测试') && print.innerText.includes('供暖、停车和晚间抵达说明'),
      addressVisible: print.innerText.includes('额尔古纳市一条很长很长的代表地址，用于验证打印版不会裁切文本'),
      backupHidden: !print.innerText.includes('只保存为备选的基地'),
      horizontalOverflow: print.scrollWidth > print.clientWidth
    };
  });

  assert.equal(result.display, 'block');
  assert.match(result.usedCount, /4 处实际使用的住宿基地/);
  assert.equal(result.customCards, 2);
  assert.equal(result.actionButtons, 0);
  assert.ok(result.staleCount >= 2);
  assert.match(result.staleText, /路线未更新/);
  assert.equal(result.oldEstimateVisible, false);
  assert.equal(result.longTextVisible, true);
  assert.equal(result.addressVisible, true);
  assert.equal(result.backupHidden, true);
  assert.equal(result.horizontalOverflow, false);

  const screenshotPath = path.join('/private/tmp', 'travles-accommodation-05-print.png');
  await page.screenshot({path: screenshotPath, fullPage: true});
  await page.pdf({path: path.join('/private/tmp', 'travles-accommodation-05-print.pdf'), format: 'A4', printBackground: true});
  assert.ok((await page.locator('#print-itinerary').boundingBox())?.height > 0);

  await page.setViewportSize({width: 390, height: 844});
  const mobileOverflow = await page.locator('#print-itinerary').evaluate(element => element.scrollWidth > element.clientWidth);
  assert.equal(mobileOverflow, false);
});
