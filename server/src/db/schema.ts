/**
 * Core table schema (ticket 02).
 *
 * The spec §Implementation Decisions fixes the full table list once:
 * trips / days / items / legs / messages / checklist / notes / gallery /
 * stash / favorites / ai_providers. All tables are created up front so later
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
    polyline TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    think TEXT,
    sources TEXT,
    applied_patch TEXT,
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
  `CREATE TABLE IF NOT EXISTS ai_providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    base_url TEXT NOT NULL,
    api_key TEXT NOT NULL DEFAULT '',
    model_id TEXT NOT NULL DEFAULT '',
    headers TEXT,
    protocol TEXT NOT NULL DEFAULT 'chat-completions',
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
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
]

/** Create every table/index if missing and enable FK cascade deletes. */
export async function ensureSchema(db: SqlDatabase): Promise<void> {
  await db.run('PRAGMA foreign_keys = ON')
  for (const statement of SCHEMA_STATEMENTS) {
    await db.run(statement)
  }
}
