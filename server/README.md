# @hailar/server

Hono + Mastra backend for the journey-planner workspace. Dev: `pnpm dev`
(listens on `SERVER_PORT`, default 4310; the Vite app proxies `/api`).

## Model configuration (tickets 06 and 12)

The `planner` agent talks to any OpenAI-compatible Chat Completions endpoint
(Mastra model routing's OpenAI-compatible config). Deployments can configure a
provider in the AI settings page, or keep using environment variables as a
bootstrap fallback:

| Variable | Meaning |
| --- | --- |
| `AI_BASE_URL` | Provider base URL, e.g. `https://api.example.com/v1` (required; Mastra appends `/chat/completions`) |
| `AI_API_KEY` | Bearer API key for that endpoint (required) |
| `AI_MODEL` | Model id, default `gpt-4o-mini` |
| `AI_PROTOCOL` | `chat-completions` (default) or `responses` |

The settings page exposes `GET/POST /api/settings/ai-providers` plus update,
default, test, and model-list routes. Saving a provider runs connectivity and
capability probes. Providers without function calling are marked as degraded;
the planner sends a JSON tool-call instruction and parses that response on the
server. API keys and custom request-header values stay server-side and are
never included in settings responses.

Without a saved provider or `AI_BASE_URL`/`AI_API_KEY`, the server starts fine,
but chat requests answer `503` with guidance instead of opening a stream.

## Recommendation and route services (ticket 15)

`AMAP_WEB_KEY` (or the legacy alias `AMAP_KEY`) enables the server-side
`search_poi`, `search_stay_reference`, and `route_legs` tools. POI and route
coordinates are converted at the AMap boundary; without the key, route lookup
returns an explicit `pending` result and does not invent measured metrics.
`POST /api/trips/:id/legs/refresh` re-queries adjacent canvas cards and keeps
existing estimates when routing is pending. Refreshes use up to four provider
lookups at once, cap each lookup at 2.5 seconds and the whole request at 8
seconds, and cache successful ordered coordinate pairs for ten minutes.

Agent memory (one thread per trip, `thread = trip-<tripId>`) lives in the same
SQLite database as the rest of the app data (`TRIPS_DB_PATH`, default
`server/data/trips.db`) via `LibSQLStore`.

## Chat SSE protocol

`POST /api/trips/:id/messages` answers `text/event-stream`:
`start {round}` → `delta {text}`* → `done {userMessage, assistantMessage}`,
or in-stream `error {code, message, guidance}` + `close {}`. The full schema
lives in `.scratch/journey-planner-page/issues/06-mastra-chat-loop.md` and at
the top of `src/chat/routes.ts`.
