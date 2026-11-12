# Guide parsing and confirmed import

This delivers the guide-entry slice of #6 and the parsing/import flow in #9, using the parser introduced in #12. Both creation methods remain available on the trip list. A guide is first previewed; confirmation creates a new itinerary and opens its existing workbench.

## Validation

- Full frontend and backend tests, TypeScript checks, Vite production build and backend build pass: `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm build:server`.
- Seven guide-import browser scenarios pass in both Vite development and production preview. The existing three current-trip-flow scenarios also pass, including sentence intake and date-pending display.
- The import integration suite uses real temporary SQLite files and local HTTP, and covers existing database compatibility, ordered canvas readback, all item types, pending and located items, unchanged existing trips, 100-activity bounds, persistent idempotency across connections, concurrent confirmation, content conflicts, deleted receipts and rollback after an actual SQL-trigger failure.
- Screenshots were opened and inspected at 1440×1100 and 390×844. Inputs, feedback, scrollable day lists, location warnings and confirmation controls render without horizontal page overflow at the narrow viewport.

## Browser scenarios

1. Paste text → preview two days and located/pending cards → edit title → confirm → read the committed canvas → return to the list without restoring an already-imported preview → reopen the itinerary with no automatic chat request or persisted chat message.
2. Submit an unreadable URL → focus the text fallback and retain the URL → paste text, which takes priority → discard the preview without writing a trip.
3. Commit confirmation but lose its response → retain the frozen payload across a visit to settings → retry with the same UUID → return the one existing itinerary.
4. Show parsing feedback, suppress duplicate submission and cancel the request; a late successful response cannot restore a preview or create an itinerary.
5. Reject empty/invalid input locally; model-configuration errors expose settings, and returning from settings preserves the original text and guide tab.
6. Switch creation methods by keyboard, retain both form inputs, and inspect/discard a preview at 390px without horizontal overflow.
7. Parse and confirm with `crypto.randomUUID` unavailable; `crypto.getRandomValues` still produces the required UUID.

## Reproduce

The browser harness starts a separate HTTP backend for each scenario, with an isolated temporary SQLite database. It injects deterministic model output and POI search; it does not use deployment databases, real provider credentials or an external map service. The existing workbench shows its offline-map fallback in the screenshot. Live provider/POI accuracy remains outside this deterministic verification.

Use `PLAYWRIGHT_CHROMIUM_EXECUTABLE` when the Playwright-pinned browser is not installed; this run used the installed Google Chrome.

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm build:server
PLAYWRIGHT_CHROMIUM_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' GUIDE_IMPORT_EVIDENCE_DIR=docs/evidence/guide-import node --test tests/app/21-guide-import.app.browser.cjs tests/app/17-current-trip-flows.app.browser.cjs
APP_MODE=preview PLAYWRIGHT_CHROMIUM_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node --test tests/app/21-guide-import.app.browser.cjs
```

## Visual evidence

- [Guide input, desktop](input-desktop.png)
- [Draft preview, desktop](preview-desktop.png)
- [Guide input, narrow viewport](input-mobile.png)
- [Draft preview, narrow viewport](preview-mobile.png)
- [Imported itinerary in the workbench](imported-workbench.png)

The draft and recovery attempt are retained only in the current page's memory while visiting settings. Reloading or closing the page clears an unconfirmed draft. Dates remain unspecified until the traveler chooses them; pending locations remain visibly unresolved. This change does not complete the remaining home-library or workbench redesign requirements in #6/#7.
