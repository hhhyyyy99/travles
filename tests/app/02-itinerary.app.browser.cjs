const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openApp } = require('../helpers/vite-app.cjs');

// Ticket 02 — itinerary + Leaflet reference map (app.html entry).
// All assertions are user-visible behaviour: DOM ids/classes/data-*/aria from
// the fidelity contract (note A §5) + map drawing, no component internals.

const ROUTE_MAP_LABEL = '海拉尔出发呼伦贝尔环线自驾路线地图';
const FIT_LEGEND = '全程参考连线 · 非道路导航';
const DAY_LEGEND = '行程连线示意 · 非道路导航';

async function pressedDay(page) {
  return page.locator('.day-button[aria-pressed="true"]').getAttribute('data-day');
}
function detailTitle(page) {
  return page.locator('#day-detail h2').textContent();
}
async function waitForMap(page) {
  await page.waitForSelector('#route-map.leaflet-container');
}

test('initial state: day 0 selected, day-0 detail + navigation panel, summary values', async () => {
  const { page, close } = await openApp();
  try {
    await waitForMap(page);
    assert.equal(await pressedDay(page), '0', 'day 0 pressed on load');
    assert.equal(await detailTitle(page), '初到海拉尔，落地只休息');
    assert.ok(await page.locator('#day-detail .navigation-panel').isVisible(), 'navigation panel rendered');
    assert.equal(
      await page.locator('#day-detail .navigation-panel strong').textContent(),
      '海拉尔东山机场 → 海拉尔市区',
    );
    assert.equal(await page.locator('#day-detail .route-estimate').textContent(), '参考里程约 6 km');
    assert.equal(await page.locator('.navigation-primary').textContent(), '高德路线规划');
    assert.equal(await page.locator('#overview-times').isVisible(), true, 'overview times shown after boot fit');
    // summary strip
    assert.equal(await page.locator('#distance-summary').textContent(), '约 1,000–1,100 km');
    assert.equal(await page.locator('#accommodation-count').textContent(), '5');
    assert.equal(await page.locator('.summary').textContent().then((t) => t.includes('7 天 6 晚')), true);
    assert.equal(await page.locator('.map-legend').textContent(), FIT_LEGEND);
  } finally {
    await close();
  }
});

test('clicking a day moves aria-pressed, renders its detail and draws its polyline', async () => {
  const { page, close } = await openApp();
  try {
    await waitForMap(page);
    await page.locator('.day-button[data-day="2"]').click();
    assert.equal(await pressedDay(page), '2');
    assert.equal(await detailTitle(page), '把时间留给莫尔道嘎');
    assert.equal(
      await page.locator('#day-detail .navigation-panel strong').textContent(),
      '额尔古纳市 → 莫尔道嘎国家森林公园',
    );
    assert.equal(
      await page.locator('#day-detail .route-estimate').textContent(),
      '参考里程约 220 km · G332 → S301',
    );
    // selected-day polylines (white 9 + blue 6) draw into the overlay pane
    const paths = await page.locator('#route-map .leaflet-overlay-pane svg path').count();
    assert.ok(paths >= 1, `expected >= 1 svg polyline, got ${paths}`);
  } finally {
    await close();
  }
});

test('overview-times buttons jump to the right day', async () => {
  const { page, close } = await openApp();
  try {
    await waitForMap(page);
    assert.equal(await page.locator('#overview-times').isVisible(), true);
    await page.locator('#overview-times [data-route-day="3"]').click();
    assert.equal(await pressedDay(page), '3');
    assert.equal(await detailTitle(page), '室韦界河边走走，再去黑山头');
    assert.equal(await page.locator('.map-legend').textContent(), DAY_LEGEND);
  } finally {
    await close();
  }
});

test('fit-map switches to the whole-trip overview legend and re-shows overview times', async () => {
  const { page, close } = await openApp();
  try {
    await waitForMap(page);
    await page.locator('.day-button[data-day="2"]').click();
    assert.equal(await page.locator('.map-legend').textContent(), DAY_LEGEND);
    // the layers toggle overlaps the fit button centre (legacy layout quirk);
    // click the visible left edge of the button, like a user would.
    await page.locator('#fit-map').click({ position: { x: 2, y: 18 } });
    assert.equal(await page.locator('.map-legend').textContent(), FIT_LEGEND);
    assert.equal(await page.locator('#overview-times').isVisible(), true, 'overview times re-shown after fit');
  } finally {
    await close();
  }
});

test('tile failure shows the fallback banner while the itinerary stays interactive', async () => {
  const { page, close } = await openApp();
  try {
    // external network is aborted by the helper -> OSM tiles error
    await page.waitForSelector('#map-error:not([hidden])', { timeout: 8000 });
    assert.equal(
      await page.locator('#map-error').textContent(),
      '底图暂不可用，地点与路线示意仍可查看。',
    );
    await page.locator('.day-button[data-day="4"]').click();
    assert.equal(await pressedDay(page), '4');
    assert.equal(await detailTitle(page), '186彩带河后，进满洲里');
  } finally {
    await close();
  }
});

test('mobile 390x844: day switching works and the detail stays readable without overflow', async () => {
  const { page, close } = await openApp({ viewport: { width: 390, height: 844 } });
  try {
    await waitForMap(page);
    await page.locator('.day-button[data-day="5"]').click();
    assert.equal(await pressedDay(page), '5');
    assert.equal(await detailTitle(page), '看呼伦湖，回到海拉尔');
    assert.ok(await page.locator('#day-detail .day-tip').isVisible(), 'tip block visible');
    assert.ok(await page.locator('#day-detail .day-links').isVisible(), 'day links visible');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    assert.ok(overflow <= 1, `no horizontal page overflow, overflow=${overflow}px`);
  } finally {
    await close();
  }
});

test('day buttons are keyboard operable with a visible focus ring', async () => {
  const { page, close } = await openApp();
  try {
    await waitForMap(page);
    // Tab until the first day-button receives keyboard focus
    let focused = null;
    for (let i = 0; i < 60; i += 1) {
      focused = await page.evaluate(() => {
        const el = document.activeElement;
        return el && el.classList && el.classList.contains('day-button')
          ? el.getAttribute('data-day')
          : null;
      });
      if (focused !== null) break;
      await page.keyboard.press('Tab');
    }
    assert.notEqual(focused, null, 'a day button is focusable via keyboard');

    const focusState = await page.evaluate(() => {
      const el = document.activeElement;
      const style = getComputedStyle(el);
      return {
        matches: el.matches(':focus-visible'),
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        outlineColor: style.outlineColor,
      };
    });
    assert.equal(focusState.matches, true, 'focus-visible applies after keyboard focus');
    assert.equal(focusState.outlineStyle, 'solid');
    assert.notEqual(focusState.outlineWidth, '0px', 'focus outline is visible');

    // Tab on to day 2 and select it with Enter
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    assert.equal(await pressedDay(page), '0', 'focus stays on day 0 before Enter');
    await page.keyboard.press('Enter');
    assert.equal(await pressedDay(page), '2', 'Enter selects the focused day');
    assert.equal(await detailTitle(page), '把时间留给莫尔道嘎');
  } finally {
    await close();
  }
});

test('a11y labels are present on the itinerary containers', async () => {
  const { page, close } = await openApp();
  try {
    assert.equal(await page.locator('#days').getAttribute('aria-label'), '选择每日行程');
    assert.equal(await page.locator('#route-map').getAttribute('aria-label'), ROUTE_MAP_LABEL);
    assert.equal(await page.locator('#fit-map').getAttribute('aria-label'), '查看全程');
    assert.equal(await page.locator('#day-detail').getAttribute('aria-live'), 'polite');
    assert.equal(await page.locator('#route-map').getAttribute('aria-label'), ROUTE_MAP_LABEL);
  } finally {
    await close();
  }
});