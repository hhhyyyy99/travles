/**
 * Core table schema (ticket 02).
 *
 * The spec §Implementation Decisions fixes the full table list once:
 * trips / days / items / legs / messages / checklist / notes / gallery /
 * stash / favorites / ai_providers (+ `app_meta`, ticket 03: startup-seed
 * markers). All tables are created up front so later
 * tickets (chat, workbench, settings) never churn migrations; only `trips`
 * carries behavior this ticket.
 *
 * Data shapes follow PRD §6. Values that arrive as structured objects
 * (PoiRef, Media[], TripPatch, custom headers) are stored as JSON text
 * columns — the JSON contract lives with the ticket that implements the
 * behavior, the columns reserve the storage now.
 *
 * Rows are intentionally tolerant (nullable titles/dates on trips) so the
 * repository's 容错读取 convention has real corrupt rows to survive.
 */
import type { SqlDatabase } from './driver.js'

export const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS trips (
    id TEXT PRIMARY KEY,
    title TEXT,
    start_date TEXT,
    end_date TEXT,
    visibility TEXT NOT NULL DEFAULT 'private',
    owner TEXT,
    share_token TEXT,
    planning_context TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS days (
    id TEXT PRIMARY KEY,
    trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    date TEXT,
    theme TEXT,
    color TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    day_id TEXT NOT NULL REFERENCES days(id) ON DELETE CASCADE,
    item_order INTEGER NOT NULL DEFAULT 0,
    type TEXT NOT NULL DEFAULT 'other',
    title TEXT NOT NULL DEFAULT '',
    note TEXT,
    poi TEXT,
    images TEXT,
    pending INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS legs (
    id TEXT PRIMARY KEY,
    trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    from_item_id TEXT,
    to_item_id TEXT,
    mode TEXT NOT NULL DEFAULT 'drive',
    distance_km REAL,
    duration_min REAL,
    polyline TEXT,
    quality TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    think TEXT,
    sources TEXT,
    applied_patch TEXT,
    -- Ticket 07: round metadata JSON (round/chips/poiLinks/thinkComplete).
    -- Nullable + added via the tolerant ALTER below for pre-07 databases.
    meta TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS checklist (
    id TEXT PRIMARY KEY,
    trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    content TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS gallery (
    id TEXT PRIMARY KEY,
    trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    item_id TEXT,
    url TEXT NOT NULL,
    caption TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS stash (
    id TEXT PRIMARY KEY,
    trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    poi TEXT NOT NULL,
    origin TEXT NOT NULL DEFAULT 'recommend',
    added_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS favorites (
    id TEXT PRIMARY KEY,
    trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    poi TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ai_providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    base_url TEXT NOT NULL,
    api_key TEXT NOT NULL DEFAULT '',
    model_id TEXT NOT NULL DEFAULT '',
    headers TEXT,
    protocol TEXT NOT NULL DEFAULT 'chat-completions',
    thinking TEXT NOT NULL DEFAULT 'off',
    is_default INTEGER NOT NULL DEFAULT 0,
    capabilities TEXT,
    last_tested_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS patch_confirmations (
    trip_id TEXT PRIMARY KEY REFERENCES trips(id) ON DELETE CASCADE,
    token TEXT NOT NULL,
    snapshot_hash TEXT NOT NULL,
    choices TEXT NOT NULL,
    created_at TEXT NOT NULL,
    consumed_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_days_trip ON days(trip_id)`,
  `CREATE INDEX IF NOT EXISTS idx_items_trip ON items(trip_id)`,
  `CREATE INDEX IF NOT EXISTS idx_items_day ON items(day_id)`,
  `CREATE INDEX IF NOT EXISTS idx_legs_trip ON legs(trip_id)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_trip ON messages(trip_id)`,
  `CREATE INDEX IF NOT EXISTS idx_checklist_trip ON checklist(trip_id)`,
  `CREATE INDEX IF NOT EXISTS idx_notes_trip ON notes(trip_id)`,
  `CREATE INDEX IF NOT EXISTS idx_gallery_trip ON gallery(trip_id)`,
  `CREATE INDEX IF NOT EXISTS idx_stash_trip ON stash(trip_id)`,
  `CREATE INDEX IF NOT EXISTS idx_favorites_trip ON favorites(trip_id)`,
  `CREATE INDEX IF NOT EXISTS idx_items_day_order ON items(day_id, item_order)`,
]

/** Create every table/index if missing and enable FK cascade deletes. */
export async function ensureSchema(db: SqlDatabase): Promise<void> {
  await db.run('PRAGMA foreign_keys = ON')
  for (const statement of SCHEMA_STATEMENTS) {
    await db.run(statement)
  }
  // Ticket 07: pre-existing databases created before the messages.meta column
  // existed get it additively here. SQLite has no ADD COLUMN IF NOT EXISTS,
  // so the duplicate-column error on fresh databases is expected and ignored.
  try {
    await db.run('ALTER TABLE messages ADD COLUMN meta TEXT')
  } catch {
    // Column already exists (fresh database or a previous run) — fine.
  }
  // Ticket 12: provider capability state is persisted so a restart keeps the
  // last successful probe and the explicit JSON-text fallback notice.
  for (const column of ['capabilities TEXT', 'last_tested_at TEXT', 'last_error TEXT', "thinking TEXT NOT NULL DEFAULT 'off'"]) {
    try {
      await db.run(`ALTER TABLE ai_providers ADD COLUMN ${column}`)
    } catch {
      // The column already exists on fresh databases or after a prior boot.
    }
  }
  try {
    await db.run('ALTER TABLE trips ADD COLUMN planning_context TEXT')
  } catch {
    // The column already exists on fresh databases or after a prior run.
  }
  try {
    await db.run('ALTER TABLE legs ADD COLUMN quality TEXT')
  } catch {
    // The column already exists on fresh databases or after a prior run.
  }
}
