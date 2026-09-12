/**
 * Items-admin repository (ticket 09) — validation + tolerant mapping over any
 * ItemsAdminStoreDriver (spec 测试接缝 #2), mirroring DaysAdminRepository.
 *
 * Convention (容错读取、永不 throw):
 * - Driver failures surface as {ok:false, error:'保存失败', code:'storage'} —
 *   never a thrown error out of the repository.
 * - Move/copy/create/delete all follow the same shape: read the trip's items
 *   and legs, compute the new layout and the recomputed legs (items-admin/
 *   legs.ts), then persist order patches + the full leg replacement. A leg
 *   write failure rolls the whole mutation back as a storage error (drivers
 *   implement the two writes; SQLite drivers wrap them in one transaction —
 *   the memory driver exposes rows for tests to verify).
 * - Move semantics: `index` is the item's FINAL position inside the target
 *   day after removal (so "drop onto the 3rd remaining slot" is index 2),
 *   clamped to [0, count]. Cross-day drops renumber both days 0..n-1.
 */
import { randomUUID } from 'node:crypto'
import {
  mapItemRow,
  mapLegRow,
} from '../days/repository.js'
import type { CanvasItem, CanvasLeg, ItemImage, ItemRow, ItemType, PoiRef } from '../days/types.js'
import { recomputeTripLegs, type LegDayOrder } from './legs.js'
import type {
  ItemDeleteResult,
  ItemFullUpsert,
  ItemMoveInput,
  ItemMutationResult,
  ItemOrderPatch,
  ItemUpdateResult,
  ItemsAdminErrorCode,
  ItemsAdminStoreDriver,
} from './types.js'

const ITEM_TYPES: ItemType[] = ['traffic', 'stay', 'attraction', 'food', 'other']
const MAX_TITLE_LENGTH = 200
const MAX_NOTE_LENGTH = 2000
const MAX_IMAGES = 20
const MAX_ADDRESS_LENGTH = 500

/** Raw create payload (values unvalidated); the repository coerces/rejects. */
export interface ItemCreateInput {
  dayId?: unknown
  title?: unknown
  type?: unknown
  note?: unknown
  poi?: unknown
  images?: unknown
  index?: unknown
}

/** Raw field-edit payload; only the sent fields change. */
export interface ItemPatchInput {
  title?: unknown
  note?: unknown
  images?: unknown
  poi?: unknown
}

export class ItemsAdminRepository {
  constructor(private readonly driver: ItemsAdminStoreDriver) {}

  /**
   * Move a card within its day or across days (drag, 上移/下移, 移动到 all
   * land here). Legs between adjacent items are recomputed for the trip.
   */
  async moveItem(tripId: string, itemId: string, input: ItemMoveInput = {}): Promise<ItemMutationResult> {
    const loaded = await this.loadItems(tripId)
    if (!loaded.ok) return loaded
    const { items, legs: previousLegs, dayOrder } = loaded
    const moving = items.find((item) => item.id === itemId)
    if (!moving) return { ok: false, error: '卡片不存在', code: 'not_found' }

    const targetDayId = typeof input.dayId === 'string' && input.dayId.trim() ? input.dayId.trim() : moving.dayId
    if (!(await this.dayExistsSafe(tripId, targetDayId))) {
      return { ok: false, error: '日程不存在', code: 'not_found' }
    }

    // Remove everywhere, then re-insert at the (clamped) final index.
    const remaining = items.filter((item) => item.id !== itemId)
    const targetList = remaining.filter((item) => item.dayId === targetDayId)
    const index = clampIndex(input.index, targetList.length)
    const moved: CanvasItem = { ...moving, dayId: targetDayId }
    const nextItems = insertIntoList(remaining, targetList, index, moved)

    // A move only rewrites positions (order patches keep poi/images columns
    // untouched); copies and creates also upsert their new full row.
    return this.persistLayout(tripId, nextItems, previousLegs, dayOrder, [moving.dayId, targetDayId], insertedItem(nextItems, moved.id), false)
  }

  /**
   * Copy a card to a (possibly different) day with a fresh id. Title, note,
   * POI and images carry over; the copy lands at `index` (default: end).
   */
  async copyItem(tripId: string, itemId: string, input: ItemMoveInput = {}): Promise<ItemMutationResult> {
    const loaded = await this.loadItems(tripId)
    if (!loaded.ok) return loaded
    const { items, legs: previousLegs, dayOrder } = loaded
    const source = items.find((item) => item.id === itemId)
    if (!source) return { ok: false, error: '卡片不存在', code: 'not_found' }

    const targetDayId = typeof input.dayId === 'string' && input.dayId.trim() ? input.dayId.trim() : source.dayId
    if (!(await this.dayExistsSafe(tripId, targetDayId))) {
      return { ok: false, error: '日程不存在', code: 'not_found' }
    }

    const copy: CanvasItem = {
      ...source,
      id: `item-${randomUUID()}`,
      dayId: targetDayId,
      pending: false,
    }
    const targetList = items.filter((item) => item.dayId === targetDayId)
    const index = input.index === undefined ? targetList.length : clampIndex(input.index, targetList.length)
    const nextItems = insertIntoList(items, targetList, index, copy)

    return this.persistLayout(tripId, nextItems, previousLegs, dayOrder, [targetDayId], insertedItem(nextItems, copy.id), true)
  }

  /**
   * Add a card to a day: free text (poi: null) or a searched POI. Lands at
   * `index` (default: end of the day) with a server-generated id.
   */
  async createItem(tripId: string, input: ItemCreateInput): Promise<ItemMutationResult> {
    const loaded = await this.loadItems(tripId)
    if (!loaded.ok) return loaded
    const { items, legs: previousLegs, dayOrder } = loaded

    const dayId = typeof input.dayId === 'string' && input.dayId.trim() ? input.dayId.trim() : ''
    if (!dayId) return { ok: false, error: '缺少目标日程', code: 'invalid' }
    if (!(await this.dayExistsSafe(tripId, dayId))) {
      return { ok: false, error: '日程不存在', code: 'not_found' }
    }

    const title = readTitle(input.title)
    if (title === null) return { ok: false, error: '标题不能为空（最多 200 字）', code: 'invalid' }
    const note = readNote(input.note)
    if (note === null) return { ok: false, error: '备注过长（最多 2000 字）', code: 'invalid' }
    const type = ITEM_TYPES.includes(input.type as ItemType) ? (input.type as ItemType) : 'other'
    const poi = readPoiInput(input.poi)
    if (poi === false) return { ok: false, error: 'POI 数据无效', code: 'invalid' }
    const images = readImagesInput(input.images)
    if (images === null) return { ok: false, error: '图片数据无效', code: 'invalid' }

    const created: CanvasItem = {
      id: `item-${randomUUID()}`,
      dayId,
      order: 0,
      type,
      title,
      note,
      poi,
      images,
      pending: false,
    }
    const targetList = items.filter((item) => item.dayId === dayId)
    const index = input.index === undefined ? targetList.length : clampIndex(input.index, targetList.length)
    const nextItems = insertIntoList(items, targetList, index, created)

    return this.persistLayout(tripId, nextItems, previousLegs, dayOrder, [dayId], insertedItem(nextItems, created.id), true)
  }

  /**
   * Edit a card's fields (one-line note, image URLs, title). Positions and
   * legs are unaffected — no reorder, no leg recompute.
   */
  async updateItem(tripId: string, itemId: string, patch: ItemPatchInput): Promise<ItemUpdateResult> {
    let row: ItemRow | null
    try {
      row = await this.driver.getItemRow(itemId)
    } catch {
      return { ok: false, error: '保存失败', code: 'storage' }
    }
    if (!row || asText(row?.id) !== itemId || asText(row?.trip_id) !== tripId) {
      return { ok: false, error: '卡片不存在', code: 'not_found' }
    }
    const current = mapItemRow(row)
    if (current === null) return { ok: false, error: '保存失败', code: 'storage' }

    let title = current.title
    if (patch.title !== undefined) {
      const next = readTitle(patch.title)
      if (next === null) return { ok: false, error: '标题不能为空（最多 200 字）', code: 'invalid' }
      title = next
    }
    let note = current.note
    if (patch.note !== undefined) {
      const next = readNote(patch.note)
      if (next === null) return { ok: false, error: '备注过长（最多 2000 字）', code: 'invalid' }
      note = next
    }
    let images = current.images
    if (patch.images !== undefined) {
      const next = readImagesInput(patch.images)
      if (next === null) return { ok: false, error: '图片数据无效', code: 'invalid' }
      images = next
    }
    let poi = current.poi
    if (patch.poi !== undefined) {
      if (current.type !== 'stay') return { ok: false, error: '只有住宿卡片可以编辑住宿位置', code: 'invalid' }
      const next = readPoiInput(patch.poi)
      if (next === false) return { ok: false, error: '住宿位置数据无效', code: 'invalid' }
      poi = next
    }

    const updated: CanvasItem = { ...current, title, note, images, poi }
    try {
      await this.driver.withTransaction(async (transactionDriver) => {
        await transactionDriver.upsertItemFull(tripId, itemToUpsert(updated))
      })
    } catch {
      return { ok: false, error: '保存失败', code: 'storage' }
    }
    return { ok: true, item: updated }
  }

  /** Remove a card; its day's remaining cards close the gap and legs recompute. */
  async deleteItem(tripId: string, itemId: string): Promise<ItemDeleteResult> {
    const loaded = await this.loadItems(tripId)
    if (!loaded.ok) return { ok: false, error: loaded.error, code: loaded.code }
    const { items, legs: previousLegs } = loaded
    const removing = items.find((item) => item.id === itemId)
    if (!removing) return { ok: false, error: '卡片不存在', code: 'not_found' }

    const nextItems = items.filter((item) => item.id !== itemId)
    const legs = renumberAndRecompute(nextItems, [removing.dayId], previousLegs, loaded.dayOrder)
    try {
      await this.driver.withTransaction(async (transactionDriver) => {
        await transactionDriver.deleteItemRow(tripId, itemId)
        await transactionDriver.updateItemOrders(tripId, orderPatchesForDay(nextItems, removing.dayId))
        await transactionDriver.replaceLegs(tripId, legs)
      })
    } catch {
      return { ok: false, error: '删除失败', code: 'storage' }
    }
    return { ok: true, legs }
  }

  // -------------------------------------------------------------------------
  // Shared plumbing
  // -------------------------------------------------------------------------

  /** Tolerant read of the trip's items + legs; driver failure → storage error. */
  private async loadItems(
    tripId: string,
  ): Promise<{ ok: true; items: CanvasItem[]; legs: CanvasLeg[]; dayOrder: LegDayOrder[] } | { ok: false; error: string; code: ItemsAdminErrorCode }> {
    let dayRows: Awaited<ReturnType<ItemsAdminStoreDriver['listDayRows']>>
    let itemRows: ItemRow[]
    let legRows: Awaited<ReturnType<ItemsAdminStoreDriver['listLegRows']>>
    try {
      ;[dayRows, itemRows, legRows] = await Promise.all([
        this.driver.listDayRows(tripId),
        this.driver.listItemRows(tripId),
        this.driver.listLegRows(tripId),
      ])
    } catch {
      return { ok: false, error: '保存失败', code: 'storage' }
    }
    const items = (Array.isArray(itemRows) ? itemRows : [])
      .map(mapItemRow)
      .filter((item): item is CanvasItem => item !== null)
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    const legs = (Array.isArray(legRows) ? legRows : [])
      .map(mapLegRow)
      .filter((leg): leg is CanvasLeg => leg !== null)
    const dayOrder = (Array.isArray(dayRows) ? dayRows : [])
      .map((row) => ({
        id: typeof row?.id === 'string' ? row.id : '',
        index: Number(row?.idx),
      }))
      .filter((day): day is LegDayOrder => day.id !== '' && Number.isInteger(day.index) && day.index >= 0)
    return { ok: true, items, legs, dayOrder }
  }

  private async dayExistsSafe(tripId: string, dayId: string): Promise<boolean> {
    try {
      return await this.driver.dayExists(tripId, dayId)
    } catch {
      return false
    }
  }

  /**
   * Persist a new layout: renumber every affected day, (optionally) upsert
   * the affected item's full row, write the order patches, recompute +
   * replace the legs, and report the affected item.
   */
  private async persistLayout(
    tripId: string,
    nextItems: CanvasItem[],
    previousLegs: CanvasLeg[],
    dayOrder: LegDayOrder[],
    affectedDayIds: string[],
    affectedItem: CanvasItem,
    upsertAffectedItem: boolean,
  ): Promise<ItemMutationResult> {
    const normalizedItems = renumberItems(nextItems, affectedDayIds)
    const finalItem = normalizedItems.find((item) => item.id === affectedItem.id) ?? affectedItem
    const nextLegs = recomputeTripLegs(normalizedItems, previousLegs, dayOrder)
    const orders = affectedDayIds.flatMap((dayId) => orderPatchesForDay(normalizedItems, dayId))
    try {
      await this.driver.withTransaction(async (transactionDriver) => {
        if (upsertAffectedItem) await transactionDriver.upsertItemFull(tripId, itemToUpsert(finalItem))
        await transactionDriver.updateItemOrders(tripId, orders)
        await transactionDriver.replaceLegs(tripId, nextLegs)
      })
    } catch {
      return { ok: false, error: '保存失败', code: 'storage' }
    }
    return { ok: true, item: finalItem, legs: nextLegs }
  }
}

// ---------------------------------------------------------------------------
// Tolerant helpers (degrade, never throw)
// ---------------------------------------------------------------------------

/** Renumber the affected days 0..n-1 (other days keep their orders). */
function renumberItems(items: CanvasItem[], affectedDayIds: string[]): CanvasItem[] {
  return items.map((item) => {
    if (!affectedDayIds.includes(item.dayId)) return item
    const dayItems = items.filter((entry) => entry.dayId === item.dayId)
    const position = dayItems.findIndex((entry) => entry.id === item.id)
    return position === item.order ? item : { ...item, order: Math.max(0, position) }
  })
}

/** Renumber the affected days, then recompute the trip's legs. */
function renumberAndRecompute(
  items: CanvasItem[],
  affectedDayIds: string[],
  previousLegs: CanvasLeg[],
  dayOrder: LegDayOrder[],
): CanvasLeg[] {
  return recomputeTripLegs(renumberItems(items, affectedDayIds), previousLegs, dayOrder)
}

/** Order patches (0..n-1) for one day's items after a layout change. */
function orderPatchesForDay(items: CanvasItem[], dayId: string): ItemOrderPatch[] {
  return items
    .filter((item) => item.dayId === dayId)
    .map((item, position) => ({ id: item.id, dayId, itemOrder: position }))
}

/** Insert `item` into the full list at `index` within `targetList`'s frame. */
function insertIntoList(items: CanvasItem[], targetList: CanvasItem[], index: number, item: CanvasItem): CanvasItem[] {
  if (targetList.length === 0) return [...items, item]
  const anchor = targetList[Math.min(index, targetList.length - 1)]!
  const anchorPosition = items.findIndex((entry) => entry.id === anchor.id)
  if (anchorPosition === -1) return [...items, item]
  const insertAt = index >= targetList.length ? anchorPosition + 1 : anchorPosition
  return [...items.slice(0, insertAt), item, ...items.slice(insertAt)]
}

/** Non-negative integer index clamped to the list; non-integers → end. */
function clampIndex(value: unknown, listLength: number): number {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num) || !Number.isInteger(num) || num < 0) return listLength
  return Math.min(num, listLength)
}

/** Tolerant CanvasItem → full upsert row (poi/images serialized to JSON text). */
function itemToUpsert(item: CanvasItem): ItemFullUpsert {
  return {
    id: item.id,
    dayId: item.dayId,
    itemOrder: item.order,
    type: item.type,
    title: item.title,
    note: item.note,
    poiJson: item.poi === null ? null : JSON.stringify(item.poi),
    imagesJson: item.images.length === 0 ? null : JSON.stringify(item.images),
  }
}

/** Required title: trimmed, 1..200 chars; null = reject. */
function readTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_TITLE_LENGTH) return null
  return trimmed
}

/** Optional one-line note: absent → ''; too long → reject (null). */
function readNote(value: unknown): string | null {
  if (value === undefined) return ''
  if (typeof value !== 'string' || value.length > MAX_NOTE_LENGTH) return null
  return value
}

/**
 * PoiRef coercion: undefined → null (plain-text card); a usable object →
 * PoiRef (name required, numbers finite-or-0); anything else → false (reject).
 */
function readPoiInput(value: unknown): PoiRef | null | false {
  if (value === undefined) return null
  if (value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  if (!name || name.length > MAX_TITLE_LENGTH) return false
  const address = asText(record.address)
  if (address.length > MAX_ADDRESS_LENGTH) return false
  return {
    amapId: asText(record.amapId),
    name,
    lat: asFiniteNumber(record.lat),
    lng: asFiniteNumber(record.lng),
    ...(address ? { address } : {}),
    category: asText(record.category),
    rating: asFiniteNumber(record.rating),
    introSummary: asText(record.introSummary),
  }
}

/** Images coercion: undefined → []; [{url, caption?}] filtered; non-array → reject. */
function readImagesInput(value: unknown): ItemImage[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value)) return null
  const images: ItemImage[] = []
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const url = typeof record.url === 'string' ? record.url.trim() : ''
    if (!url) continue
    images.push({ url, caption: asText(record.caption) })
    if (images.length >= MAX_IMAGES) break
  }
  return images
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asFiniteNumber(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : 0
}

/** The inserted item as it sits in the final layout (with its new order). */
function insertedItem(items: CanvasItem[], id: string): CanvasItem {
  return items.find((item) => item.id === id) ?? { ...items[0]! }
}
