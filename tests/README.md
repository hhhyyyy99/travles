# Tests

Install workspace dependencies with `pnpm install --frozen-lockfile`. Browser tests use
Playwright Chromium: run `pnpm exec playwright install chromium` once, or set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE` to an existing Chromium binary.

## Commands

- `pnpm test`: frontend domain tests followed by all `server/tests/*.test.ts`.
- `pnpm typecheck`: strict frontend and server TypeScript checks.
- `pnpm build && pnpm test:app`: browser suites against real Vite dev servers.
  Build first because a few legacy compatibility cases also open preview mode.
- `pnpm test:app:prod`: builds the frontend and runs the browser suites in preview mode.
- `pnpm build:server`: compile the production Node service.

The root browser commands bound suite concurrency to four processes. Each Vite dev
server uses a separate temporary optimizer cache, removed when its fixture closes.

## Testing boundaries

1. **Agent HTTP/SSE:** inject a model or run a local mock model provider, then drive
   the real Hono/Mastra app. Assert round metadata, confirmation, tool execution,
   TripPatch validation/retry and persisted messages. Do not mock business tools.
2. **Repository:** inject the in-memory driver or use a temporary SQLite file.
   Cover tolerant codecs, invalid writes, transactions and persistence.
3. **Workbench UI:** Playwright mocks the backend API/SSE for focused canvas,
   map and chat linkage cases; realtime acceptance also runs the actual backend
   with isolated temporary data and two independent browser contexts.

External model and map services use local fixtures. No production model credentials
or AMap keys are needed. New integration fixtures must isolate ports, database files
and browser storage, and close their servers and SSE connections after each test.

## Existing guide fixtures

`tests/helpers/vite-app.cjs` starts Vite on a free loopback port with `--strictPort`,
launches headless Chromium and uses an 8-second default browser action timeout.
External requests are aborted; `tests/helpers/amap-stub.cjs` replaces the map
provider only. The application still owns all itinerary and accommodation logic.

The default app shell probes `/api/trips`: the trip list appears when the backend
responds, otherwise the original guide appears. Existing guide cases therefore
expect no backend on port 4310. Use a separate `SERVER_PORT` for local manual QA;
workbench suites use explicit `?view=workbench&trip=<id>` entry points.

Legacy localStorage data is seeded with `page.addInitScript` before navigation.
Storage is origin-scoped, so data on different dev/preview ports is independent.
The optional `setup({ page, server })` hook installs API routes before navigation.
