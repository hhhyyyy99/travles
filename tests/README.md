# Tests

Run `npm ci`, then `npx playwright install chromium` once (or set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE` to an existing Chromium binary).

- `npm test` — pure logic tests (`tests/*.test.ts`, loaded through tsx). These
  cover the accommodation core, AMap route-estimate formatting helpers,
  place-search duplicate/coordinate logic, and the print route-label
  precedence — migrated from the legacy `.test.cjs` modules with the same
  scenarios, imported from `src/domain` directly.
- `npm run test:browser` / `npm run test:app` — app browser suites
  (`tests/app/*.browser.cjs`) against a real Vite dev server on 127.0.0.1
  (ephemeral port, `--strictPort`). Assertions are on visible behavior,
  persistence after reload, and the external map provider request contract.
- `npm run test:app:prod` — the same suites against the production build
  preview (`APP_MODE=preview`, builds first).

Conventions (see `tests/helpers/vite-app.cjs`):
- Chromium headless, 8s default timeout, every non-127.0.0.1 request aborted.
- Provider fixtures (e.g. `tests/helpers/amap-stub.cjs`) replace external map
  services only — they never supply application state or accommodation logic.
  Live AMap credentials are not needed or included.
- Legacy-format localStorage payloads are seeded via `page.addInitScript` on
  the app origin; storage is origin-scoped, so dev/preview/legacy servers are
  deliberately isolated.
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE` optionally selects an existing Chromium
  executable (the pinned Playwright 1.62.1 browser revision may not match the
  machine cache).