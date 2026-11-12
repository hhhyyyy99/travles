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

## Guide parsing workflow (part of #5)

`POST /api/ai/parse-guide` runs the registered Mastra `parse_link_workflow`:
source loading → schema-validated extraction → POI matching. Send either
`{"text":"第一天成都人民公园喝茶，第二天返回市区。"}` or
`{"url":"https://example.com/travel-guide"}`. A supplied nonblank `text` takes
precedence, so the same request can be retried with pasted content after a
blocked URL. Text is limited to 20,000 characters.

A successful response is `{status:"ready", source, draft}`. The draft retains
source ordering with ordinal day numbers and `dateStatus:"unspecified"`;
parsing does not create/edit trips, write chat history or confirm travel dates.
The tool-free extraction agent uses the currently selected saved provider (or
the existing environment fallback), independently of planner conversation
memory. Its JSON output must pass the shared `@hailar/domain` schemas.

Unavailable, blocked, oversized or unreadable articles return HTTP 200 with
`{status:"text_required", code:"source_unavailable", guidance}` so clients can
offer a paste-text retry. Public HTTP/HTTPS URLs only are accepted; redirects
are checked again and DNS resolution is pinned to prevent requests to local
or private services. Article loading is bounded to 10 seconds and 1 MiB.

Only unambiguous, exact local POI matches receive provider coordinates. No map
key, lookup errors or unmatched places leave cards intact with `poi:null` and
`pending:true`. Lookups use four workers, at most 30 distinct queries, a
2-second per-query deadline and an 8-second stage deadline. Coordinates keep
the existing WGS-84 contract; the workflow does not invent or double-convert
them. Extraction has a 60-second model deadline. Invalid requests return 400
(or 413 for oversized HTTP bodies); model configuration, extraction and
availability errors use 503, 422 and 502 respectively.

This backend preview endpoint is separate from the existing trip proposal
confirmation APIs. The home-page parsing UI and committing a preview to a trip
remain subsequent work; existing `/api/trips/:id/ai/proposals` behavior is
preserved.

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
