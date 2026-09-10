# Tests

Run `npm install`, then `npx playwright install chromium` once.

- `npm test` runs the existing Node behavior tests.
- `npm run test:browser` runs browser workflows against temporary localhost servers. External network requests are blocked and route scenarios use a deterministic AMap provider fixture.
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE` optionally selects an existing Chromium executable. Tests otherwise use Playwright's installed browser.

Tests assert visible behavior, persistence after reload, and the external map provider request contract. Provider fixtures never supply application state or replace accommodation operations. Live AMap credentials are not needed or included.
