/**
 * TripPatch validation + apply (ticket 08) — the server-side gate between
 * the model and the trip database.
 *
 * Flow: the projected end-state (current rows + ops applied in memory) is
 * validated FIRST; only a fully valid patch reaches the store, and the
 * writes then run inside the driver's transaction (all-or-nothing). A
 * rejected patch returns a readable Chinese error the chat route feeds back
 * to the model as the tool result — the model retries, the user's stream
 * never fails on a first invalid patch.
 *
 * Validation rules (spec: 日期连续、无重叠住宿、交通段可达 + referential
 * integrity):
 *
 * 1. References — add_item/move_item target existing or in-patch days;
 *    update/move/remove_item target existing or in-patch items; add_day/
 *    add_item ids must be fresh; remove_* targets must exist.
 * 2. Dates — among days with usable dates: no duplicates, strictly
 *    consecutive calendar days (日期连续、不重叠).
 * 3. Stays — at most one overnight stay (type 'stay') card per day.
 * 4. Reachability — for every adjacent card pair where at least one endpoint
 *    was ADDED or MOVED by this patch: both ends carry coordinates, OR the
 *    pair is flagged 待定 (either endpoint `pending` or `legPending`). Pairs
 *    the patch never repositioned are exempt (legacy/seed data stays valid).
 *
 * Legs are implied by adjacency: after the ops, every day whose card
 * POSITIONS changed (add/move/remove item) gets its leg rows rebuilt through
 * ticket 09's shared recompute (items-admin/legs.ts): a stored pair leg is
 * reused verbatim, a reversed stored leg keeps its numbers, otherwise the
 * pair is estimated (haversine × 1.2 road factor) when both ends carry POI
 * coordinates, and a coordinate-less (待定) pair degrades to an empty 0/0 leg
 * the canvas chip hides. Patch-applied days therefore always carry usable
 * estimated legs — never placeholder NULL rows.
 */
import { normalizeItemType, readActivityItemMetadata } from '@hailar/domain'
import type { ActivityItemMetadata, Day } from '@hailar/domain'
import { isValidDateString } from '../trips/dates.js'
import { mapLegRow, mapPoiRef } from '../days/repository.js'
import type { CanvasItem, CanvasLeg, ItemType, PoiRef } from '../days/types.js'
import { adjacentTripPairs, recomputeTripLegs } from '../items-admin/legs.js'
import { TripPatchIdConflictError } from './types.js'
import type { PatchPoiRef, TripPatchApplyResult, TripPatchItemUpsert, TripPatchStats, TripPatchStoreDriver } from './types.js'
import type { TripPatchInput } from './schema.js'
import { normalizeTripPatchTypes, parseTripPatchInput } from './schema.js'

const DAY_MS = 24 * 60 * 60 * 1000

type ProjectedItem = ActivityItemMetadata & {
  id: string
  dayId: string
  order: number
  seq: number
  type: ItemType
  title: string
  note: string
  poi: PatchPoiRef | null
  pending: boolean
  legPending: boolean
  /** True when this row was created or rewritten by the patch being validated. */
  fromPatch: boolean
}

type ProjectedDay = Pick<Day, 'title' | 'note'> & {
  id: string
  idx: number
  date: string
  theme: string
  items: ProjectedItem[]
  /** Items recorded for the cascade when the day is removed. */
  removed?: boolean
}

type Projection = {
  days: Map<string, ProjectedDay>
  /** Set of day ids whose adjacency changed (leg rebuild targets). */
  touchedDays: Set<string>
  /** Item ids whose POI changed; stored legs touching them cannot be reused. */
  invalidatedLegItems: Set<string>
  /** Explicit metadata supplied by item ops; loaded values never become write touches. */
  itemMetadataTouches: Map<string, ActivityItemMetadata>
  maxIdx: number
  seqCounter: number
}

// ---------------------------------------------------------------------------
// Current-state loading (tolerant, mirrors the workbench read mapping)
// ---------------------------------------------------------------------------

async function loadProjection(store: TripPatchStoreDriver, tripId: string): Promise<Projection> {
  const [dayRows, itemRows] = await Promise.all([store.listDayRows(tripId), store.listItemRows(tripId)])
  const days = new Map<string, ProjectedDay>()
  let maxIdx = -1
  for (const row of Array.isArray(dayRows) ? dayRows : []) {
    const id = typeof row?.id === 'string' ? row.id : ''
    if (!id) continue
    const idx = Number(row?.idx)
    const day: ProjectedDay = {
      id,
      idx: Number.isInteger(idx) && idx >= 0 ? idx : 0,
      date: typeof row?.date === 'string' && isValidDateString(row.date) ? row.date : '',
      theme: typeof row?.theme === 'string' ? row.theme : '',
      ...(typeof row?.title === 'string' ? { title: row.title } : {}),
      ...(typeof row?.note === 'string' ? { note: row.note } : {}),
      items: [],
    }
    days.set(id, day)
    maxIdx = Math.max(maxIdx, day.idx)
  }
  let seq = 0
  for (const row of Array.isArray(itemRows) ? itemRows : []) {
    const id = typeof row?.id === 'string' ? row.id : ''
    const dayId = typeof row?.day_id === 'string' ? row.day_id : ''
    if (!id || !dayId) continue
    const day = days.get(dayId)
    if (!day) continue // orphan row — out of scope for patch validation
    const order = Number(row?.item_order)
    const type = normalizeItemType(row?.type) ?? (typeof row?.type === 'string' ? (row.type as ItemType) : 'other')
    day.items.push({
      id,
      dayId,
      order: Number.isFinite(order) ? order : 0,
      seq: seq++,
      type,
      title: typeof row?.title === 'string' ? row.title : '',
      note: typeof row?.note === 'string' ? row.note : '',
      ...readActivityItemMetadata({ timeRange: row.time_range, cost: row.cost }),
      poi: mapPoiRef(row?.poi),
      pending: row?.pending === 1 || row?.pending === true,
      legPending: false,
      fromPatch: false,
    })
  }
  return {
    days, touchedDays: new Set(), invalidatedLegItems: new Set(), itemMetadataTouches: new Map(),
    maxIdx, seqCounter: seq,
  }
}

function sortedItems(day: ProjectedDay): ProjectedItem[] {
  return [...day.items].sort((a, b) => a.order - b.order || a.seq - b.seq)
}

/** Keep projected positions deterministic after an insertion, move, or remove. */
function reindexItems(day: ProjectedDay): ProjectedItem[] {
  const items = sortedItems(day)
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (item) item.order = index
  }
  day.items = items
  return items
}

// ---------------------------------------------------------------------------
// Validation: apply ops to the projection, checking integrity as we go
// ---------------------------------------------------------------------------

type ValidationFailure = { ok: false; error: string }

function fail(opIndex: number, why: string): ValidationFailure {
  return { ok: false, error: `第 ${opIndex + 1} 个操作被拒绝：${why}` }
}

function hasCoords(item: ProjectedItem): boolean {
  return item.poi !== null && Number.isFinite(item.poi.lat) && Number.isFinite(item.poi.lng)
}

function validateOps(projection: Projection, ops: TripPatchInput['ops']): ValidationFailure | { ok: true } {
  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i] as { op: string; [key: string]: unknown }
    switch (op.op) {
      case 'add_day': {
        if (projection.days.has(op.dayId as string)) return fail(i, `天「${op.dayId}」已存在`)
        const date = op.date as string | undefined
        if (date !== undefined && !isValidDateString(date)) return fail(i, '日期格式无效（需要 YYYY-MM-DD）')
        projection.days.set(op.dayId as string, {
          id: op.dayId as string,
          idx: ++projection.maxIdx,
          date: date ?? '',
          theme: (op.theme as string | undefined) ?? '',
          ...(op.title !== undefined ? { title: op.title as string } : {}),
          ...(op.note !== undefined ? { note: op.note as string } : {}),
          items: [],
        })
        break
      }
      case 'update_day': {
        const day = projection.days.get(op.dayId as string)
        if (!day) return fail(i, `天「${op.dayId}」不存在`)
        const date = op.date as string | undefined
        if (date !== undefined) {
          if (!isValidDateString(date)) return fail(i, '日期格式无效（需要 YYYY-MM-DD）')
          day.date = date
        }
        if (op.theme !== undefined) day.theme = op.theme as string
        if (op.title !== undefined) day.title = op.title as string
        if (op.note !== undefined) day.note = op.note as string
        break
      }
      case 'remove_day': {
        const day = projection.days.get(op.dayId as string)
        if (!day) return fail(i, `天「${op.dayId}」不存在`)
        for (const neighbor of neighboringDays(projection, day.id)) {
          markDayItems(neighbor)
          projection.touchedDays.add(neighbor.id)
        }
        projection.days.delete(day.id)
        break
      }
      case 'add_item': {
        const day = projection.days.get(op.dayId as string)
        if (!day) return fail(i, `天「${op.dayId}」不存在`)
        if (findItem(projection, op.itemId as string)) return fail(i, `卡片「${op.itemId}」已存在`)
        const item: ProjectedItem = {
          id: op.itemId as string,
          dayId: day.id,
          order: 0,
          seq: projection.seqCounter++,
          type: normalizeItemType(op.type) ?? 'other',
          title: op.title as string,
          note: (op.note as string | undefined) ?? '',
          ...readActivityItemMetadata(op),
          poi: (op.poi as PatchPoiRef | null | undefined) ?? null,
          pending: (op.pending as boolean | undefined) ?? false,
          legPending: (op.legPending as boolean | undefined) ?? false,
          fromPatch: true,
        }
        projection.itemMetadataTouches.set(item.id, readActivityItemMetadata(op))
        const items = reindexItems(day)
        const requested = (op.order as number | undefined) ?? items.length
        const index = Math.max(0, Math.min(items.length, requested))
        items.splice(index, 0, item)
        for (let position = 0; position < items.length; position += 1) {
          const current = items[position]
          if (current) current.order = position
        }
        day.items = items
        projection.touchedDays.add(day.id)
        break
      }
      case 'update_item': {
        const found = findItem(projection, op.itemId as string)
        if (!found) return fail(i, `卡片「${op.itemId}」不存在`)
        const item = found.item
        const metadata = readActivityItemMetadata(op)
        Object.assign(item, metadata)
        projection.itemMetadataTouches.set(item.id, { ...projection.itemMetadataTouches.get(item.id), ...metadata })
        if (op.title !== undefined) item.title = op.title as string
        if (op.note !== undefined) item.note = (op.note as string | null) ?? ''
        if (op.type !== undefined) item.type = normalizeItemType(op.type) ?? item.type
        if (op.pending !== undefined) item.pending = op.pending as boolean
        if (op.poi !== undefined) {
          const nextPoi = (op.poi as PatchPoiRef | null) ?? null
          item.poi = nextPoi === null ? null : preserveAccommodationMetadata(item.poi, nextPoi)
          // A stored route's numbers are tied to the old coordinates. Rebuild
          // this day and exclude every old leg touching the changed card.
          projection.touchedDays.add(found.day.id)
          projection.invalidatedLegItems.add(item.id)
          item.fromPatch = true
        }
        if (op.legPending !== undefined) item.legPending = op.legPending as boolean
        break
      }
      case 'move_item': {
        const found = findItem(projection, op.itemId as string)
        if (!found) return fail(i, `卡片「${op.itemId}」不存在`)
        const target = projection.days.get(op.dayId as string)
        if (!target) return fail(i, `天「${op.dayId}」不存在`)
        const item = found.item
        const sourceItems = reindexItems(found.day).filter((entry) => entry.id !== item.id)
        for (let position = 0; position < sourceItems.length; position += 1) {
          const current = sourceItems[position]
          if (current) current.order = position
        }
        found.day.items = sourceItems
        item.dayId = target.id
        const targetItems = found.day === target ? sourceItems : reindexItems(target)
        const requested = (op.order as number | undefined) ?? targetItems.length
        const index = Math.max(0, Math.min(targetItems.length, requested))
        item.order = index
        item.seq = projection.seqCounter++
        item.fromPatch = true
        targetItems.splice(index, 0, item)
        for (let position = 0; position < targetItems.length; position += 1) {
          const current = targetItems[position]
          if (current) current.order = position
        }
        target.items = targetItems
        markDayItems(found.day)
        markDayItems(target)
        projection.touchedDays.add(target.id)
        projection.touchedDays.add(found.day.id)
        break
      }
      case 'remove_item': {
        const found = findItem(projection, op.itemId as string)
        if (!found) return fail(i, `卡片「${op.itemId}」不存在`)
        found.day.items = reindexItems(found.day).filter((entry) => entry.id !== op.itemId)
        reindexItems(found.day)
        markDayItems(found.day)
        projection.touchedDays.add(found.day.id)
        break
      }
      default:
        return fail(i, '未知操作类型')
    }
  }
  return { ok: true }
}

function findItem(
  projection: Projection,
  itemId: string,
): { day: ProjectedDay; item: ProjectedItem } | null {
  for (const day of projection.days.values()) {
    const item = day.items.find((entry) => entry.id === itemId)
    if (item) return { day, item }
  }
  return null
}

/**
 * SQLite keys are global within each table, while the normal projection only
 * loads rows for the requested trip. Check ids against the whole database
 * before any write so a model cannot accidentally reuse another trip's id.
 */
async function validateGlobalIds(
  store: TripPatchStoreDriver,
  tripId: string,
  ops: TripPatchInput['ops'],
): Promise<ValidationFailure | { ok: true }> {
  const addedDayIds = new Set<string>()
  const addedItemIds = new Set<string>()

  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i]
    if (!op) continue
    if (op.op === 'add_day') {
      if (addedDayIds.has(op.dayId)) return fail(i, `天「${op.dayId}」在同一 patch 中重复创建，id 必须全局唯一`)
      addedDayIds.add(op.dayId)
      const owner = await store.getDayTripId(op.dayId)
      if (owner !== null) {
        return fail(i, owner === tripId
          ? `天「${op.dayId}」已存在，add_day 需要使用全新的 id`
          : `天「${op.dayId}」与其他行程冲突（该 id 已被占用），请换一个新的 dayId`)
      }
      continue
    }
    if (op.op === 'add_item') {
      if (addedItemIds.has(op.itemId)) return fail(i, `卡片「${op.itemId}」在同一 patch 中重复创建，id 必须全局唯一`)
      addedItemIds.add(op.itemId)
      const owner = await store.getItemTripId(op.itemId)
      if (owner !== null) {
        return fail(i, owner === tripId
          ? `卡片「${op.itemId}」已存在，add_item 需要使用全新的 id`
          : `卡片「${op.itemId}」与其他行程冲突（该 id 已被占用），请换一个新的 itemId`)
      }
    }
  }
  return { ok: true }
}

/** 日期连续且不重叠：有日期的天排序后必须逐日紧邻、无重复。 */
function validateDates(projection: Projection): ValidationFailure | { ok: true } {
  const dated = [...projection.days.values()]
    .filter((day) => isValidDateString(day.date))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  for (let i = 1; i < dated.length; i += 1) {
    const previous = Date.parse(`${dated[i - 1]?.date ?? ''}T00:00:00Z`)
    const current = Date.parse(`${dated[i]?.date ?? ''}T00:00:00Z`)
    if (!Number.isFinite(previous) || !Number.isFinite(current)) continue
    if (current - previous !== DAY_MS) {
      return {
        ok: false,
        error: `日期不连续：「${dated[i - 1]?.date}」和「${dated[i]?.date}」之间存在间隔或重复，行程日期必须逐日连续。`,
      }
    }
  }
  return { ok: true }
}

/** 每天最多一个过夜住宿卡。 */
function validateStays(projection: Projection): ValidationFailure | { ok: true } {
  for (const day of projection.days.values()) {
    const stays = day.items.filter((item) => item.type === 'stay')
    if (stays.length > 1) {
      return {
        ok: false,
        error: `天「${day.date || day.theme || day.id}」有 ${stays.length} 张住宿卡（${stays
          .map((item) => item.title)
          .join('、')}），每天最多一个过夜住宿。`,
      }
    }
  }
  return { ok: true }
}

/** 交通段可达：patch 触及的相邻卡片对，两端有坐标，或已标记待定。 */
function validateReachability(projection: Projection): ValidationFailure | { ok: true } {
  for (const { from, to } of projectedAdjacentPairs(projection)) {
    if (!from.fromPatch && !to.fromPatch) continue // untouched legacy pair — exempt
    if (hasCoords(from) && hasCoords(to)) continue
    if (from.pending || to.pending || from.legPending || to.legPending) continue
    return {
      ok: false,
      error: `交通段不可达：相邻卡片「${from.title}」→「${to.title}」缺少坐标且未标记待定。请补充 POI 坐标，或将无坐标卡片 pending/legPending 置为 true。`,
    }
  }
  return { ok: true }
}

function projectedAdjacentPairs(projection: Projection): Array<{ from: ProjectedItem; to: ProjectedItem }> {
  const byId = new Map<string, ProjectedItem>()
  const items: CanvasItem[] = []
  for (const day of projection.days.values()) {
    for (const item of sortedItems(day)) {
      byId.set(item.id, item)
      items.push(toCanvasItem(item))
    }
  }
  const order = [...projection.days.values()].map((day) => ({ id: day.id, index: day.idx }))
  return adjacentTripPairs(items, order)
    .map((pair) => ({ from: byId.get(pair.from.id), to: byId.get(pair.to.id) }))
    .filter((pair): pair is { from: ProjectedItem; to: ProjectedItem } => pair.from !== undefined && pair.to !== undefined)
}

function markDayItems(day: ProjectedDay): void {
  for (const item of day.items) item.fromPatch = true
}

function neighboringDays(projection: Projection, dayId: string): ProjectedDay[] {
  const ordered = [...projection.days.values()].sort((a, b) => a.idx - b.idx || a.id.localeCompare(b.id))
  const index = ordered.findIndex((day) => day.id === dayId)
  if (index < 0) return []
  return [ordered[index - 1], ordered[index + 1]].filter((day): day is ProjectedDay => day !== undefined)
}

// ---------------------------------------------------------------------------
// Apply: replay the validated ops as store writes, rebuild adjacency legs
// ---------------------------------------------------------------------------

function itemUpsert(item: ProjectedItem, metadata: ActivityItemMetadata | undefined): TripPatchItemUpsert {
  return {
    id: item.id,
    dayId: item.dayId,
    itemOrder: item.order,
    // Position/POI rebuilds also upsert siblings. Only operation-supplied
    // metadata may overwrite their current stored values.
    ...metadata,
    type: item.type,
    title: item.title,
    note: item.note,
    // Canonical storage shape (same JSON the workbench read mapper expects):
    // {name, location: {lat, lng}, amapId, category, rating, introSummary}.
    poi: item.poi === null ? null : JSON.stringify(toPoiStorage(item.poi)),
    pending: item.pending,
  }
}

/** Next date after the latest dated day ('' when none) — mirrors days-admin. */
function nextDateAfter(days: Iterable<ProjectedDay>): string {
  let max: string | null = null
  for (const day of days) {
    if (isValidDateString(day.date) && (max === null || day.date > max)) max = day.date
  }
  if (max === null) return ''
  const next = new Date(Date.parse(`${max}T00:00:00Z`) + DAY_MS)
  return Number.isFinite(next.getTime()) ? next.toISOString().slice(0, 10) : ''
}

/**
 * Projected (post-patch) item → the CanvasItem shape ticket 09's recompute
 * reads. Only id/dayId/order/poi influence the derivation; the rest is
 * carried verbatim so the reuse/estimate rules see exactly what the canvas
 * read model would see.
 */
function toCanvasItem(item: ProjectedItem): CanvasItem {
  return {
    id: item.id,
    dayId: item.dayId,
    order: item.order,
    type: item.type,
    title: item.title,
    note: item.note,
    ...readActivityItemMetadata(item),
    poi: item.poi === null ? null : toPoiRef(item.poi),
    images: [],
    pending: item.pending,
  }
}

/** Flat PatchPoiRef → the canonical PoiRef read shape (defaults filled). */
function toPoiRef(poi: PatchPoiRef): PoiRef {
  return {
    amapId: poi.amapId ?? '',
    name: poi.name,
    lat: poi.lat,
    lng: poi.lng,
    ...(poi.address !== undefined ? { address: poi.address } : {}),
    ...(poi.accommodationBaseId !== undefined ? { accommodationBaseId: poi.accommodationBaseId } : {}),
    ...(poi.accommodationType !== undefined ? { accommodationType: poi.accommodationType } : {}),
    ...(poi.accommodationNotes !== undefined ? { accommodationNotes: poi.accommodationNotes } : {}),
    ...(poi.accommodationMigrationVersion !== undefined
      ? { accommodationMigrationVersion: poi.accommodationMigrationVersion }
      : {}),
    category: poi.category ?? '',
    rating: poi.rating ?? 0,
    introSummary: poi.introSummary ?? '',
  }
}

/** Flat PatchPoiRef → the canonical nested POI storage JSON (days read mapper convention). */
function toPoiStorage(poi: PatchPoiRef): {
  amapId: string
  name: string
  location: { lat: number; lng: number }
  address?: string
  category: string
  rating: number
  introSummary: string
  accommodationBaseId?: string
  accommodationType?: 'area' | 'hotel'
  accommodationNotes?: string
  accommodationMigrationVersion?: number
} {
  return {
    amapId: poi.amapId ?? '',
    name: poi.name,
    location: { lat: poi.lat, lng: poi.lng },
    ...(poi.address !== undefined ? { address: poi.address } : {}),
    category: poi.category ?? '',
    rating: poi.rating ?? 0,
    introSummary: poi.introSummary ?? '',
    ...(poi.accommodationBaseId !== undefined ? { accommodationBaseId: poi.accommodationBaseId } : {}),
    ...(poi.accommodationType !== undefined ? { accommodationType: poi.accommodationType } : {}),
    ...(poi.accommodationNotes !== undefined ? { accommodationNotes: poi.accommodationNotes } : {}),
    ...(poi.accommodationMigrationVersion !== undefined
      ? { accommodationMigrationVersion: poi.accommodationMigrationVersion }
      : {}),
  }
}

/** Preserve migration metadata when AI updates only the visible POI fields. */
function preserveAccommodationMetadata(current: PatchPoiRef | null, next: PatchPoiRef): PatchPoiRef {
  if (!current) return next
  return {
    ...next,
    ...(next.accommodationBaseId === undefined && current.accommodationBaseId !== undefined
      ? { accommodationBaseId: current.accommodationBaseId }
      : {}),
    ...(next.accommodationType === undefined && current.accommodationType !== undefined
      ? { accommodationType: current.accommodationType }
      : {}),
    ...(next.accommodationNotes === undefined && current.accommodationNotes !== undefined
      ? { accommodationNotes: current.accommodationNotes }
      : {}),
    ...(next.accommodationMigrationVersion === undefined && current.accommodationMigrationVersion !== undefined
      ? { accommodationMigrationVersion: current.accommodationMigrationVersion }
      : {}),
  }
}

/**
 * Stored legs available to the recompute's reuse rules (ticket 09). Rows
 * written as placeholders by an older patch applier (NULL distance/duration)
 * are excluded on purpose: reusing them verbatim would freeze the NULLs
 * forever instead of letting the estimate fallback fill real numbers.
 */
function usableStoredLegs(rows: Awaited<ReturnType<TripPatchStoreDriver['listLegRows']>>): CanvasLeg[] {
  const legs: CanvasLeg[] = []
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row === null || typeof row !== 'object') continue
    if (row.distance_km === null || row.distance_km === undefined) continue
    if (row.duration_min === null || row.duration_min === undefined) continue
    const leg = mapLegRow(row)
    if (leg !== null) legs.push(leg)
  }
  return legs
}

async function rebuildLegsForTrip(
  store: TripPatchStoreDriver,
  tripId: string,
  projection: Projection,
  previousLegs: CanvasLeg[],
  invalidatedLegItems: ReadonlySet<string>,
  stats: TripPatchStats,
): Promise<void> {
  const items = [...projection.days.values()].flatMap((day) => sortedItems(day)).map(toCanvasItem)
  const dayOrder = [...projection.days.values()].map((day) => ({ id: day.id, index: day.idx }))
  const ids = new Set<string>()
  for (const item of items) ids.add(item.id)
  for (const leg of previousLegs) {
    ids.add(leg.fromItemId)
    ids.add(leg.toItemId)
  }
  await store.deleteLegsForItems(tripId, [...ids])
  const reusableLegs = previousLegs.filter(
    (leg) => !invalidatedLegItems.has(leg.fromItemId) && !invalidatedLegItems.has(leg.toItemId),
  )
  // Recompute same-day pairs and the bridges between consecutive days from
  // one projected snapshot so deleting/moving a card cannot leave a stale
  // boundary leg behind.
  for (const leg of recomputeTripLegs(items, reusableLegs, dayOrder)) {
    await store.upsertLegRow(tripId, {
      id: leg.id,
      fromItemId: leg.fromItemId,
      toItemId: leg.toItemId,
      mode: leg.mode,
      distanceKm: leg.distanceKm,
      durationMin: leg.durationMin,
      polyline: leg.polyline === null ? null : JSON.stringify(leg.polyline),
      quality: leg.quality,
    })
    stats.legsWritten += 1
  }
}

/**
 * Validate + apply one TripPatch. Throws nothing except what the store
 * raises for `storage` classification; logical problems come back as
 * {ok:false, error} so the model can retry.
 */
export async function applyTripPatch(
  store: TripPatchStoreDriver,
  tripId: string,
  rawPatch: unknown,
): Promise<TripPatchApplyResult> {
  const parsed = parseTripPatchInput(rawPatch)
  if (!parsed.ok) return { ok: false, error: parsed.error, code: 'invalid' }
  const ops = parsed.value.ops

  let projection: Projection
  try {
    projection = await loadProjection(store, tripId)
  } catch {
    return { ok: false, error: '读取当前行程失败，请稍后重试。', code: 'storage' }
  }

  const reference = projection
  const integrity = validateOps(reference, ops)
  if (!integrity.ok) return { ok: false, error: integrity.error, code: 'invalid' }
  let globalIntegrity: ValidationFailure | { ok: true }
  try {
    globalIntegrity = await validateGlobalIds(store, tripId, ops)
  } catch {
    return { ok: false, error: '读取行程 id 归属失败，请稍后重试。', code: 'storage' }
  }
  if (!globalIntegrity.ok) return { ok: false, error: globalIntegrity.error, code: 'invalid' }
  for (const check of [validateDates, validateStays, validateReachability]) {
    const result = check(reference)
    if (!result.ok) return { ok: false, error: result.error, code: 'invalid' }
  }

  const stats: TripPatchStats = {
    daysAdded: 0,
    daysUpdated: 0,
    daysRemoved: 0,
    itemsAdded: 0,
    itemsUpdated: 0,
    itemsRemoved: 0,
    legsWritten: 0,
  }

  try {
    await store.withTransaction(async (transactionStore) => {
      const previousLegs = usableStoredLegs(await transactionStore.listLegRows(tripId))
      for (const op of ops) {
        switch (op.op) {
          case 'add_day': {
            const day = reference.days.get(op.dayId)
            if (!day) throw new Error('patch projection drifted') // cannot happen post-validation
            await transactionStore.upsertDayRow(tripId, {
              id: day.id,
              idx: day.idx,
              date: day.date || nextDateAfter(reference.days.values()),
              theme: day.theme,
              ...(op.title !== undefined ? { title: op.title } : {}),
              ...(op.note !== undefined ? { note: op.note } : {}),
            })
            stats.daysAdded += 1
            break
          }
          case 'update_day': {
            const day = reference.days.get(op.dayId)
            if (!day) throw new Error('patch projection drifted')
            await transactionStore.upsertDayRow(tripId, {
              id: day.id, idx: day.idx, date: day.date, theme: day.theme,
              // Never replay metadata from the loaded projection: another
              // writer may have changed an omitted field before this transaction.
              ...(op.title !== undefined ? { title: op.title } : {}),
              ...(op.note !== undefined ? { note: op.note } : {}),
            })
            stats.daysUpdated += 1
            break
          }
          case 'remove_day': {
            const itemIds = (await transactionStore.listItemRows(tripId))
              .filter((row) => typeof row?.id === 'string' && row.day_id === op.dayId)
              .map((row) => row.id as string)
            await transactionStore.deleteLegsForItems(tripId, itemIds)
            await transactionStore.deleteItemsForDay(tripId, op.dayId)
            await transactionStore.deleteDayRow(tripId, op.dayId)
            stats.daysRemoved += 1
            break
          }
          case 'add_item': {
            const found = findItem(reference, op.itemId)
            if (!found) throw new Error('patch projection drifted')
            await transactionStore.upsertItemRow(tripId, itemUpsert(found.item, reference.itemMetadataTouches.get(found.item.id)))
            stats.itemsAdded += 1
            break
          }
          case 'update_item': {
            const found = findItem(reference, op.itemId)
            if (!found) throw new Error('patch projection drifted')
            await transactionStore.upsertItemRow(tripId, itemUpsert(found.item, reference.itemMetadataTouches.get(found.item.id)))
            stats.itemsUpdated += 1
            break
          }
          case 'move_item': {
            const found = findItem(reference, op.itemId)
            if (!found) throw new Error('patch projection drifted')
            await transactionStore.upsertItemRow(tripId, itemUpsert(found.item, reference.itemMetadataTouches.get(found.item.id)))
            break
          }
          case 'remove_item': {
            await transactionStore.deleteLegsForItems(tripId, [op.itemId])
            await transactionStore.deleteItemsById(tripId, [op.itemId])
            stats.itemsRemoved += 1
            break
          }
        }
      }
      // Positional operations shift neighboring cards as well as the card in
      // the op. Persist the complete final order for each touched day so the
      // database order matches the validated projection (upsert preserves
      // existing images in both store implementations).
      for (const dayId of reference.touchedDays) {
        const day = reference.days.get(dayId)
        if (!day) continue
        for (const item of sortedItems(day)) {
          await transactionStore.upsertItemRow(tripId, itemUpsert(item, reference.itemMetadataTouches.get(item.id)))
        }
      }
      // Rebuild all adjacency legs whenever a card/day layout changed. A
      // boundary can change even when its surviving endpoint cards did not.
      const layoutChanged = ops.some((op) =>
        op.op === 'add_item' || op.op === 'move_item' || op.op === 'remove_item' || op.op === 'remove_day',
      ) || reference.touchedDays.size > 0
      if (layoutChanged) {
        await rebuildLegsForTrip(transactionStore, tripId, reference, previousLegs, reference.invalidatedLegItems, stats)
      }
    })
  } catch (error) {
    if (error instanceof TripPatchIdConflictError) {
      const label = error.entity === 'day' ? '天' : error.entity === 'item' ? '卡片' : '交通段'
      return {
        ok: false,
        error: `${label}「${error.id}」与其他行程冲突（该 id 已被占用），请换一个新的 id。`,
        code: 'invalid',
      }
    }
    return { ok: false, error: '写入行程失败，请稍后重试。', code: 'storage' }
  }

  const summary = buildSummary(stats)
  // Keep the submitted record's existing shape while exposing legacy type names.
  return { ok: true, summary, stats, patch: normalizeTripPatchTypes(rawPatch as TripPatchInput) }
}

/** Chinese one-liner for the chat summary card / SSE payload. */
export function buildSummary(stats: TripPatchStats): string {
  const parts: string[] = []
  if (stats.daysAdded > 0) parts.push(`新增 ${stats.daysAdded} 天`)
  if (stats.daysUpdated > 0) parts.push(`更新 ${stats.daysUpdated} 天`)
  if (stats.daysRemoved > 0) parts.push(`删除 ${stats.daysRemoved} 天`)
  if (stats.itemsAdded > 0) parts.push(`新增 ${stats.itemsAdded} 张卡片`)
  if (stats.itemsUpdated > 0) parts.push(`更新 ${stats.itemsUpdated} 张卡片`)
  if (stats.itemsRemoved > 0) parts.push(`删除 ${stats.itemsRemoved} 张卡片`)
  return parts.length > 0 ? `已写入行程：${parts.join('、')}` : '已写入行程'
}
