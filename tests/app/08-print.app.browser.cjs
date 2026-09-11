const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { openApp } = require('../helpers/vite-app.cjs');
const { installAMapStub } = require('../helpers/amap-stub.cjs');

// Ticket 08 — print / save-as-PDF itinerary with accommodation. Migration of
// the legacy tests/accommodation-print.browser.cjs (note D part 2 §print:8)
// onto the React app: the print sheet is rendered from the SINGLE
// authoritative accommodation state, keeps the legacy print markup contract
// (data-day-index / data-stay-id / data-route-status + is-stale), never shows
// a stale estimate for an unupdated route, renders long names/addresses/notes
// unclipped, and restores interactive page + details state after printing.
// Runs under both `test:app` (dev) and `test:app:prod` (preview).

// Legacy fixture: an area-typed long-text base on nights 1+2 plus an unused
// backup base (note D part 2 — print:8 seeds exactly this).
const SEED = JSON.stringify({
  version: 1,
  bases: [
    {
      id: 'custom-long-stay',
      name: '北境超长名称住宿基地示例用于换行测试',
      type: 'area',
      lat: 50.12,
      lng: 119.98,
      address: '额尔古纳市一条很长很长的代表地址，用于验证打印版不会裁切文本',
      notes: '这是需要完整保留在打印版中的入住备注，包含供暖、停车和晚间抵达说明。',
    },
    {
      id: 'unused-backup',
      name: '只保存为备选的基地',
      type: 'hotel',
      lat: 50.2,
      lng: 120.1,
    },
  ],
  stays: { 1: 'custom-long-stay', 2: 'custom-long-stay' },
});

function seedInit() {
  localStorage.setItem('hailar-slow-trip-accommodation-v1', '{"version": 1, "bases": [{"id": "custom-long-stay", "name": "北境超长名称住宿基地示例用于换行测试", "type": "area", "lat": 50.12, "lng": 119.98, "address": "额尔古纳市一条很长很长的代表地址，用于验证打印版不会裁切文本", "notes": "这是需要完整保留在打印版中的入住备注，包含供暖、停车和晚间抵达说明。"}, {"id": "unused-backup", "name": "只保存为备选的基地", "type": "hotel", "lat": 50.2, "lng": 120.1}], "stays": {"1": "custom-long-stay", "2": "custom-long-stay"}}');
}

async function readPrintSheet(page) {
  return page.evaluate(() => {
    const print = document.querySelector('#print-itinerary');
    const stale = [...print.querySelectorAll('.print-route.is-stale')];
    return {
      display: getComputedStyle(print).display,
      bodyText: print.innerText,
      customCards: print.querySelectorAll('[data-stay-id="custom-long-stay"]').length,
      usedCount: print.querySelector('.print-sheet-summary')?.textContent,
      actionButtons: print.querySelectorAll('button, input, select, textarea').length,
      dayCount: print.querySelectorAll('.print-day').length,
      dayIndices: [...print.querySelectorAll('.print-day')].map((day) => day.getAttribute('data-day-index')),
      routeStatuses: [...print.querySelectorAll('.print-route')].map((route) => route.getAttribute('data-route-status')),
      staleCount: stale.length,
      staleText: stale.map((element) => element.innerText).join('\n'),
      // scoped to the stale rows (legacy print:8 semantics) — an unchanged
      // reference day (e.g. day 4) legitimately keeps its static estimate
      oldEstimateVisible: stale.some(
        (element) => element.innerText.includes('约 220 km') || element.innerText.includes('约 250 km'),
      ),
      longTextVisible:
        print.innerText.includes('北境超长名称住宿基地示例用于换行测试') &&
        print.innerText.includes('供暖、停车和晚间抵达说明'),
      addressVisible: print.innerText.includes('额尔古纳市一条很长很长的代表地址，用于验证打印版不会裁切文本'),
      backupHidden: !print.innerText.includes('只保存为备选的基地'),
      horizontalOverflow: print.scrollWidth > print.clientWidth,
    };
  });
}

test('print mode renders current accommodation details and suppresses stale estimates', async () => {
  const { page, close } = await openApp({ init: seedInit, viewport: { width: 1100, height: 900 }, amapConfig404: true });
  try {
    await page.waitForSelector('#print-itinerary .print-day', { state: 'attached' });
    await page.emulateMedia({ media: 'print' });

    const result = await readPrintSheet(page);
    assert.equal(result.display, 'block');
    assert.match(result.usedCount, /6 晚 · 4 处实际使用的住宿基地/);
    assert.equal(result.customCards, 2, 'custom stay renders on both its nights');
    assert.equal(result.dayCount, 7, 'full 7-day itinerary');
    assert.deepEqual(result.dayIndices, ['0', '1', '2', '3', '4', '5', '6']);
    assert.equal(result.actionButtons, 0, 'no interactive controls inside the print sheet');
    assert.ok(result.staleCount >= 2, `expected ≥2 stale rows, got ${result.staleCount}`);
    assert.match(result.staleText, /路线未更新/);
    assert.equal(result.oldEstimateVisible, false, 'stale estimates 约 220 km / 约 250 km must not appear');
    // the two custom nights carry the area type + the changed endpoints → the
    // un-updated family, never a stale km
    assert.ok(result.routeStatuses.filter((status) => status === 'unupdated').length >= 2, 'custom nights print unupdated');
    assert.equal(result.longTextVisible, true, 'long name + notes');
    assert.equal(result.addressVisible, true, 'long address');
    assert.equal(result.backupHidden, true, 'unused backup base hidden');
    assert.equal(result.horizontalOverflow, false, `no horizontal overflow, got ${result.horizontalOverflow}`);

    const pdfPath = path.join(os.tmpdir(), 'travles-08-print.pdf');
    const shotPath = path.join(os.tmpdir(), 'travles-08-print.png');
    await page.screenshot({ path: shotPath, fullPage: true });
    await page.pdf({ path: pdfPath, format: 'A4', printBackground: true });
    assert.ok((await page.locator('#print-itinerary').boundingBox())?.height > 0, 'print sheet has height');

    // mobile viewport: same sheet, no overflow
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileOverflow = await page
      .locator('#print-itinerary')
      .evaluate((element) => element.scrollWidth > element.clientWidth);
    assert.equal(mobileOverflow, false, 'mobile print sheet has no horizontal overflow');
    const mobileText = await page.locator('#print-itinerary').innerText();
    assert.ok(mobileText.includes('北境超长名称住宿基地示例用于换行测试'), 'long name visible on mobile too');
  } finally {
    await close();
  }
});

test('topbar print button calls window.print and the sheet derives from the current stay state', async () => {
  const { page, close } = await openApp({ amapConfig404: true });
  try {
    const button = page.locator('#print');
    assert.equal(await button.getAttribute('aria-label'), '打印或存为 PDF');
    assert.equal(await button.getAttribute('title'), '打印或存为 PDF');
    await page.evaluate(() => {
      window.__printCalls = 0;
      window.print = () => {
        window.__printCalls += 1;
      };
    });
    await button.click();
    assert.equal(await page.evaluate(() => window.__printCalls), 1, 'button triggers window.print once');

    // default state → default stays render in the sheet (legacy fallback)
    const body = await page.locator('#print-itinerary').innerText();
    assert.ok(body.includes('第 1 晚住宿'), 'default night-1 stay label present');
    assert.ok(body.includes('海拉尔'), 'default stay name present');
  } finally {
    await close();
  }
});

test('beforeprint/afterprint open and restore ALL details incl. AMap road-details; no listener accumulation', async () => {
  const { page, close } = await openApp({ amapConfig404: true });
  try {
    await page.waitForSelector('#print-itinerary .print-day', { state: 'attached' });
    // notes-grid details all start open; close the first one to simulate a
    // user-collapsed section, and inject a live-panel-style road-details
    // (what the AMap panel adds at runtime — must be covered by the global
    // snapshot too, gotcha 11).
    await page.locator('.notes-grid details summary').first().click();
    await page.evaluate(() => {
      const road = document.createElement('details');
      road.className = 'road-details';
      road.innerHTML = '<summary>沿途道路与转向</summary><ol><li>测试道路</li></ol>';
      document.body.appendChild(road);
    });
    const initial = await page.evaluate(() =>
      [...document.querySelectorAll('details')].map((element) => element.open),
    );
    assert.equal(initial[0], false, 'first note collapsed by user');
    assert.equal(initial[initial.length - 1], false, 'road-details starts closed');
    assert.equal(initial.filter(Boolean).length, initial.length - 2);

    for (let cycle = 1; cycle <= 3; cycle += 1) {
      await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
      const during = await page.evaluate(() => [...document.querySelectorAll('details')].map((element) => element.open));
      assert.ok(during.every(Boolean), `cycle ${cycle}: all details open during print`);
      await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
      const restored = await page.evaluate(() =>
        [...document.querySelectorAll('details')].map((element) => element.open),
      );
      assert.deepEqual(restored, initial, `cycle ${cycle}: states restored by index`);
    }
    assert.equal(
      await page.evaluate(() => window.__tibetPrintHandlerCount ?? 0),
      1,
      'repeated printing never accumulates listeners',
    );
  } finally {
    await close();
  }
});

test('AMap-updated route prints 已更新 and the live panel road-details join the print snapshot', async () => {
  // Combined init: deterministic AMap provider (routeProvider stub) + the
  // long-text fixture. The stub resolves day-0 with a fixed distance, which
  // must show as the updated label — not the static estimate.
  const { page, close } = await openApp({
    init: `(${installAMapStub.toString()})(); localStorage.setItem('hailar-slow-trip-accommodation-v1', ${JSON.stringify(SEED)});`,
    viewport: { width: 1100, height: 900 },
  });
  try {
    await page.waitForSelector('#print-itinerary .print-day', { state: 'attached' });
    await page.locator('.road-details').waitFor({ state: 'attached' });
    await page.emulateMedia({ media: 'print' });
    const result = await readPrintSheet(page);
    assert.ok(result.bodyText.includes('已更新 43.2 km'), 'updated label printed');
    // day 0 only: its updated label must replace the static estimate (day 6 —
    // the unchanged airport leg — legitimately keeps 参考里程约 6 km)
    const day0Route = await page.evaluate(() => {
      const route = document.querySelector('[data-day-index="0"] .print-route');
      return { status: route.getAttribute('data-route-status'), text: route.querySelector('b').textContent };
    });
    assert.equal(day0Route.status, 'updated');
    assert.match(day0Route.text, /^已更新 43\.2 km/);
    assert.equal(day0Route.text.includes('参考里程约'), false, 'static estimate replaced for the updated day');
  } finally {
    await close();
  }
});