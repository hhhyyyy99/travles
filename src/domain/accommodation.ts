/**
 * Authoritative accommodation state machine (ticket 04 part A).
 *
 * Pure, framework-free port of `accommodation.js` (window.tibetAccommodation):
 * defaults, normalizeBase, CRUD, stays overrides, route endpoint derivation
 * and invalidation. No hidden mutable state, no localStorage, no DOM — state
 * objects are passed in and replaced; every committed mutation returns
 * `{state, event}` where `event.routeDays` follows the legacy invalidation
 * rule (a changed night N affects route days N and N+1).
 *
 * Reference: migration-notes/B-accommodation-core.md — §1 domain model,
 * §2 storage/backup, §3.1–3.3 function contracts, §4 business rules.
 */
import { tripPlan } from '../data/itinerary'
import type {
  AccommodationBackup,
  AccommodationBackupBase,
  AccommodationBase,
  AccommodationChangeEvent,
  AccommodationDayRoute,
  AccommodationState,
  RouteEndpoint,
} from './types'

export const ACCOMMODATION_VERSION = 1 as const
export const ACCOMMODATION_BACKUP_FORMAT = 'hailar-slow-trip-accommodation' as const
export const ACCOMMODATION_MAX_BASES = 100

/* ------------------------------------------------------------------ *
 * Defaults (note B §1.1/§1.2 — hardcoded like the legacy module).
 * ------------------------------------------------------------------ */

/** Overnight days for the shipped plan: `points.length>1 && !last day` (accommodation.js L9–11). */
export const overnightDays: number[] = tripPlan.days
  .map((day, index) => (day.points.length > 1 && index < tripPlan.days.length - 1 ? index : null))
  .filter((index): index is number => index !== null)

/** Per-day default base id keyed by day index (literal array, L12 — index 6 is dead). */
export const defaultStayByDay: Array<string | null> = [
  'default-hailar',
  'default-erguna',
  'default-mordaoga',
  'default-heishantou',
  'default-manzhouli',
  'default-hailar',
  null,
]

/** [id, plan.points key, name, routeName] — exact legacy table (L13–19). */
const DEFAULT_DEFINITIONS: ReadonlyArray<readonly [string, string, string, string]> = [
  ['default-hailar', 'hailar', '海拉尔', '海拉尔市区'],
  ['default-erguna', 'erguna', '额尔古纳', '额尔古纳市'],
  ['default-mordaoga', 'mordaoga', '莫尔道嘎', '莫尔道嘎镇'],
  ['default-heishantou', 'heishantou', '黑山头', '黑山头镇'],
  ['default-manzhouli', 'manzhouli', '满洲里', '满洲里市'],
]

/** Default seeds — built from `plan.points[pointKey].xy` (L20–33), area type. */
export const defaultBases: AccommodationBase[] = DEFAULT_DEFINITIONS.map(([id, pointKey, name, routeName]) => {
  const point = tripPlan.points[pointKey]
  if (!point) throw new Error(`tripPlan.points 缺少默认基地坐标：${pointKey}`)
  return {
    id,
    name,
    routeName,
    type: 'area',
    lat: point.xy[0],
    lng: point.xy[1],
    address: point.name,
    notes: '',
    isDefault: true,
  }
})

const defaultById = new Map(defaultBases.map((base) => [base.id, base]))

/** Default base object for a night (or null for a dead index). */
export function defaultBaseFor(night: number): AccommodationBase | null {
  const id = defaultStayByDay[Number(night)]
  return id ? (defaultById.get(id) ?? null) : null
}

/** Default ids, used by storage/codec and id-set checks. */
export const defaultBaseIds: string[] = defaultBases.map((base) => base.id)
const defaultIdSet = new Set(defaultBaseIds)

/* ------------------------------------------------------------------ *
 * Coercion / validation (note B §1.3).
 * ------------------------------------------------------------------ */

export function validCoordinate(lat: number, lng: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
}

/**
 * `custom-<uuid>` or the Date/Math fallback (L52–55). A pure function of its
 * environment; callers may inject a factory for determinism in tests.
 */
export function customBaseId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return `custom-${globalThis.crypto.randomUUID()}`
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Single coercer (L57–78). Accepts raw editor/manager input incl. string
 * lat/lng; returns `null` when the base is rejected. `isDefault` is always
 * forced to false (customs). Field order matches the legacy literal so the
 * persisted JSON is byte-compatible.
 */
export function normalizeBase(value: unknown, idFactory: () => string = customBaseId): AccommodationBase | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const name = String(record.name ?? '').trim()
  const type = record.type === 'area' ? 'area' : 'hotel'
  const latText = String(record.lat ?? '').trim()
  const lngText = String(record.lng ?? '').trim()
  if (!latText || !lngText) return null
  const lat = Number(latText)
  const lng = Number(lngText)
  if (!name || !validCoordinate(lat, lng)) return null
  return {
    id: String(record.id || idFactory()),
    name: name.slice(0, 120),
    type,
    lat,
    lng,
    address: String(record.address ?? '').trim().slice(0, 240),
    notes: String(record.notes ?? '').trim().slice(0, 600),
    createdAt: record.createdAt ? String(record.createdAt) : new Date().toISOString(),
    isDefault: false,
  }
}

const copyBase = (base: AccommodationBase): AccommodationBase => ({ ...base })

/* ------------------------------------------------------------------ *
 * Selectors (note B §3.1 reads / §4.1 / §4.4).
 * ------------------------------------------------------------------ */

/** Defaults first, then customs (L201). Copies — the domain never hands out live objects. */
export function getBase(state: AccommodationState, id: string): AccommodationBase | null {
  const base = defaultById.get(id) ?? state.bases.find((item) => item.id === id)
  return base ? copyBase(base) : null
}

/** `listBases` — defaults + customs, deep-ish copies (legacy L381 rendering order). */
export function listBases(state: AccommodationState): AccommodationBase[] {
  return [...defaultBases, ...state.bases].map(copyBase)
}

/**
 * Stay for an overnight night; `null` when the day has no overnight or the
 * override/base cannot resolve. Absent override ⇒ default stay (L205–209).
 */
export function getDayStay(state: AccommodationState, dayIndex: number): AccommodationBase | null {
  const index = Number(dayIndex)
  if (!overnightDays.includes(index)) return null
  const customId = state.stays[index]
  const base = getBase(state, customId || defaultStayByDay[index] || '')
  return base ? copyBase(base) : null
}

/** Ticket-named alias for `getDayStay`. */
export function selectedStay(state: AccommodationState, night: number): AccommodationBase | null {
  return getDayStay(state, night)
}

/** Overnight nights whose stay is this base id (L339). */
export function usedDaysForBase(state: AccommodationState, id: string): number[] {
  return overnightDays.filter((index) => getDayStay(state, index)?.id === id)
}

/** Ticket-named alias for `usedDaysForBase`. */
export function stayFor(state: AccommodationState, baseId: string): number[] {
  return usedDaysForBase(state, baseId)
}

/** Distinct base ids actually referenced by the 6 nights — alternates excluded by construction (L709). */
export function usedBaseIds(state: AccommodationState): string[] {
  return [...new Set(overnightDays.map((index) => getDayStay(state, index)?.id).filter(Boolean) as string[])]
}

/** `inUseBaseCount` / `getBaseCount` (L713). */
export function inUseBaseCount(state: AccommodationState): number {
  return usedBaseIds(state).length
}

export const getBaseCount = inUseBaseCount

/** Base objects (defaults + customs) currently referenced by a night. */
export function basesInUse(state: AccommodationState): AccommodationBase[] {
  return usedBaseIds(state)
    .map((id) => getBase(state, id))
    .filter((base): base is AccommodationBase => Boolean(base))
}

/** Custom bases not referenced by any night — the 备选 list (manager partition). */
export function alternateBases(state: AccommodationState): AccommodationBase[] {
  return state.bases.filter((base) => usedDaysForBase(state, base.id).length === 0)
}

/** Consecutive same-stay night grouping for the stay-note summary (trip.js:213–221). */
export interface StayNoteGroup {
  id: string
  name: string
  count: number
}

export function stayNoteGroups(state: AccommodationState): StayNoteGroup[] {
  const groups: StayNoteGroup[] = []
  overnightDays.forEach((index) => {
    const stay = getDayStay(state, index)
    if (!stay) return
    const last = groups[groups.length - 1]
    if (last?.id === stay.id) last.count += 1
    else groups.push({ id: stay.id, name: stay.name, count: 1 })
  })
  return groups
}

/** `name N 晚` groups joined by ` → ` — the `#stay-note-text` prefix (trip.js:221). */
export function stayNoteText(state: AccommodationState): string {
  return stayNoteGroups(state).map((group) => `${group.name} ${group.count} 晚`).join(' → ')
}

/* ------------------------------------------------------------------ *
 * Route endpoint derivation (note B §1.6 / §4.4 + gotchas 9, 13, 14).
 * ------------------------------------------------------------------ */

export function getEndpoint(state: AccommodationState, dayIndex: number, side: 'from' | 'to'): RouteEndpoint | null {
  const index = Number(dayIndex)
  const day = tripPlan.days[index]
  if (!day) return null
  if (side === 'from' && index === 0) {
    const firstKey = day.points[0]
    const point = firstKey ? tripPlan.points[firstKey] : undefined
    if (!point) return null
    return { name: day.nav[0], routeName: day.nav[0], lat: point.xy[0], lng: point.xy[1], isCustom: false, kind: 'point' }
  }
  if (side === 'to' && index === tripPlan.days.length - 1) {
    const lastKey = day.points[day.points.length - 1]
    const point = lastKey ? tripPlan.points[lastKey] : undefined
    if (!point) return null
    return { name: day.nav[1], routeName: day.nav[1], lat: point.xy[0], lng: point.xy[1], isCustom: false, kind: 'point' }
  }
  const stayDay = side === 'to' ? index : index - 1
  const stay = getDayStay(state, stayDay)
  if (!stay) return null
  const selectedId = state.stays[stayDay]
  return {
    id: stay.id,
    name: stay.name,
    routeName: stay.routeName || stay.address || stay.name,
    type: stay.type,
    lat: stay.lat,
    lng: stay.lng,
    address: stay.address,
    isCustom: !stay.isDefault,
    isChanged: Boolean(selectedId && selectedId !== defaultStayByDay[stayDay]),
    kind: 'base',
  }
}

/**
 * Full per-day route (L240–261). `stops` = `[from, ...via, to]` filtered.
 * Days 1–2 append a keyword-only scenic nav stop (gotcha 9).
 */
export function getDayRoute(state: AccommodationState, dayIndex: number): AccommodationDayRoute | null {
  const index = Number(dayIndex)
  const day = tripPlan.days[index]
  if (!day) return null
  const from = getEndpoint(state, index, 'from')
  const to = getEndpoint(state, index, 'to')
  const via: RouteEndpoint[] = day.points.slice(1, -1).map((key): RouteEndpoint | null => {
    const point = tripPlan.points[key]
    if (!point) return null
    return { id: key, name: point.name, routeName: point.name, lat: point.xy[0], lng: point.xy[1], isCustom: false, kind: 'point' }
  }).filter((point): point is RouteEndpoint => point !== null)
  if (index === 1 || index === 2) {
    // These live-route destinations are scenic keywords, not the nearby
    // overnight town centers stored in plan.points — keep them keyword-only
    // until AMap resolves a real representative point (legacy comment L250–257).
    via.push({
      id: `nav-${index}`,
      name: day.nav[1],
      routeName: day.nav[1],
      keyword: day.nav[1],
      city: day.cities?.[1],
      isCustom: false,
      keywordOnly: true,
      kind: 'keyword',
    })
  }
  return {
    from,
    to,
    via,
    stops: [from, ...via, to].filter((stop): stop is RouteEndpoint => Boolean(stop)),
    hasCustomEndpoint: Boolean(from?.isCustom || to?.isCustom),
    hasChangedEndpoint: Boolean(from?.isChanged || to?.isChanged || from?.isCustom || to?.isCustom),
  }
}

/** Ticket-named alias for `getDayRoute`. */
export function dayRouteEndpoints(dayIndex: number, state: AccommodationState): AccommodationDayRoute | null {
  return getDayRoute(state, dayIndex)
}

/** `${id|name}|lat|lng` signature of a route (L276) — used by replaceState. */
export function routeSignature(route: AccommodationDayRoute | null): string {
  if (!route) return ''
  return [route.from, route.to]
    .map((point) => (point ? `${point.id || point.name}|${point.lat ?? ''}|${point.lng ?? ''}` : ''))
    .join('>')
}

/** `{N, N+1}` ∩ [0, days.length), sorted numeric (L311–320). */
export function affectedRoutes(dayIndices: number[]): number[] {
  const affected = new Set<number>()
  dayIndices.map(Number).forEach((index) => {
    if (!overnightDays.includes(index)) return
    ;[index, index + 1].forEach((routeIndex) => {
      if (routeIndex >= 0 && routeIndex < tripPlan.days.length) affected.add(routeIndex)
    })
  })
  return [...affected].sort((a, b) => a - b)
}

export const getAffectedRoutes = affectedRoutes

/* ------------------------------------------------------------------ *
 * Mutations — pure: state in, state (+event) out (note B §3.2).
 * ------------------------------------------------------------------ */

/** Committed mutation: a new state plus the change event. */
export interface AccommodationCommittedResult {
  ok: true
  committed: true
  state: AccommodationState
  event: AccommodationChangeEvent
  dayIndices: number[]
  routeDays: number[]
  changed?: number[]
  base?: AccommodationBase
  previousBase?: AccommodationBase
}

/** No-op (legacy `{ok:true, changed:[]}` — nothing persisted, nothing notified). */
export interface AccommodationNoopResult {
  ok: true
  committed: false
  changed: []
}

export interface AccommodationErrorResult {
  ok: false
  error: string
}

export type AccommodationMutationResult = AccommodationCommittedResult | AccommodationNoopResult | AccommodationErrorResult

export type AccommodationValidationResult =
  | { ok: true; value: AccommodationBackup }
  | { ok: false; errors: string[]; error: string }

/**
 * Apply a base to nights (L521–540, `assign`). Overrides only in `stays`;
 * assigning a default base to its own default night deletes the entry (undo).
 */
export function applyStays(state: AccommodationState, dayIndices: number[], baseId: string): AccommodationMutationResult {
  const base = getBase(state, baseId)
  const indices = [...new Set(dayIndices.map(Number))].filter((index) => overnightDays.includes(index))
  if (!base || !indices.length) return { ok: false, error: '请选择住宿晚次' }
  const nextStays = { ...state.stays }
  indices.forEach((index) => {
    if (base.isDefault && baseId === defaultStayByDay[index]) delete nextStays[index]
    else nextStays[index] = baseId
  })
  const changed = indices.filter((index) => getDayStay(state, index)?.id !== baseId)
  if (!changed.length) return { ok: true, committed: false, changed: [] }
  const next: AccommodationState = { version: 1, bases: state.bases, stays: nextStays }
  const routeDays = affectedRoutes(changed)
  return {
    ok: true,
    committed: true,
    state: next,
    event: { type: 'assign', dayIndices: changed, routeDays, changed, base: copyBase(base) },
    dayIndices: changed,
    routeDays,
    changed,
    base: copyBase(base),
  }
}

/** Legacy-name alias (note B §3.2 `assign(id, dayIndices)`). */
export function assign(state: AccommodationState, baseId: string, dayIndices: number[]): AccommodationMutationResult {
  return applyStays(state, dayIndices, baseId)
}

/**
 * Edit a custom base in place (L542–563). Only a lat/lng change invalidates
 * routes. id and createdAt are preserved; every referencing night updates
 * implicitly because stays store only base ids.
 */
export function updateBase(state: AccommodationState, id: string, input: unknown): AccommodationMutationResult {
  const previous = getBase(state, id)
  if (!previous) return { ok: false, error: '住宿基地不存在' }
  if (previous.isDefault) return { ok: false, error: '默认住宿不可编辑' }
  if (!input || typeof input !== 'object') return { ok: false, error: '请输入住宿基地信息' }
  const updated = normalizeBase({ ...previous, ...(input as Record<string, unknown>), id: previous.id, createdAt: previous.createdAt })
  if (!updated) return { ok: false, error: '请填写基地名称和有效位置' }
  const previousIndex = state.bases.findIndex((base) => base.id === id)
  if (previousIndex < 0) return { ok: false, error: '住宿基地不存在' }
  const nextBases = [...state.bases]
  nextBases[previousIndex] = updated
  const usedDays = usedDaysForBase(state, id)
  const locationChanged = previous.lat !== updated.lat || previous.lng !== updated.lng
  const routeDays = locationChanged ? affectedRoutes(usedDays) : []
  const next: AccommodationState = { version: 1, bases: nextBases, stays: state.stays }
  return {
    ok: true,
    committed: true,
    state: next,
    event: {
      type: 'update',
      base: copyBase(updated),
      previousBase: copyBase(previous),
      dayIndices: usedDays,
      routeDays,
    },
    dayIndices: usedDays,
    routeDays,
    base: copyBase(updated),
    previousBase: copyBase(previous),
  }
}

/** Delete an unused custom base (L565–579). In-use → exact legacy message. */
export function deleteBase(state: AccommodationState, id: string): AccommodationMutationResult {
  const base = getBase(state, id)
  if (!base) return { ok: false, error: '住宿基地不存在' }
  if (base.isDefault) return { ok: false, error: '默认住宿不可删除' }
  const usedDays = usedDaysForBase(state, id)
  if (usedDays.length) {
    return { ok: false, error: `该基地正在使用，请先替换第 ${usedDays.map((index) => index + 1).join('、')} 晚住宿` }
  }
  const next: AccommodationState = {
    version: 1,
    bases: state.bases.filter((item) => item.id !== id),
    stays: state.stays,
  }
  return {
    ok: true,
    committed: true,
    state: next,
    event: { type: 'delete', base: copyBase(base), dayIndices: [], routeDays: [] },
    dayIndices: [],
    routeDays: [],
    base: copyBase(base),
  }
}

/**
 * Restore a single night (L582–595) — removes only that night's override;
 * other nights stay untouched. No-op when already default.
 */
export function restoreDay(state: AccommodationState, dayIndex: number): AccommodationMutationResult {
  const index = Number(dayIndex)
  if (!overnightDays.includes(index)) return { ok: false, error: '该日没有住宿安排' }
  const current = getDayStay(state, index)
  const defaultId = defaultStayByDay[index]
  if (!current || current.id === defaultId) return { ok: true, committed: false, changed: [] }
  const nextStays = { ...state.stays }
  delete nextStays[index]
  const next: AccommodationState = { version: 1, bases: state.bases, stays: nextStays }
  const routeDays = affectedRoutes([index])
  return {
    ok: true,
    committed: true,
    state: next,
    event: { type: 'restore', dayIndices: [index], routeDays, changed: [index] },
    changed: [index],
    dayIndices: [index],
    routeDays,
  }
}

/**
 * Manual create — save-and-apply writes the stays overrides in the SAME
 * commit (gotcha 23). The returned error mirrors the programmatic `saveBase`
 * string; the dialog status `请填写基地名称，并在地图上确认有效位置。` is UI copy.
 */
export function createBase(
  state: AccommodationState,
  input: unknown,
  options: { applyToNights?: number[] } = {},
): AccommodationMutationResult {
  const base = normalizeBase(input)
  if (!base) return { ok: false, error: '请填写基地名称和有效位置' }
  const nights = options.applyToNights
    ? [...new Set(options.applyToNights.map(Number))].filter((index) => overnightDays.includes(index))
    : []
  const nextStays = { ...state.stays }
  nights.forEach((index) => {
    nextStays[index] = base.id
  })
  const changed = nights.filter((index) => getDayStay(state, index)?.id !== base.id)
  const next: AccommodationState = { version: 1, bases: [...state.bases, base], stays: nextStays }
  const routeDays = affectedRoutes(changed)
  return {
    ok: true,
    committed: true,
    state: next,
    event: { type: 'create', base: copyBase(base), dayIndices: changed, routeDays, changed },
    dayIndices: changed,
    routeDays,
    changed,
    base: copyBase(base),
  }
}

/**
 * Programmatic create-as-alternate (L747–756 `saveBase`): appends to bases
 * without touching stays; protects default ids and duplicate ids.
 */
export function saveBase(state: AccommodationState, input: unknown): AccommodationMutationResult {
  const base = normalizeBase(input)
  const inputId = (input as Record<string, unknown> | null)?.id
  if (inputId && defaultIdSet.has(String(inputId))) return { ok: false, error: '默认住宿不可覆盖' }
  if (!base) return { ok: false, error: '请填写基地名称和有效位置' }
  const persistedBase = { ...base, id: inputId ? String(inputId) : base.id }
  if (state.bases.some((item) => item.id === persistedBase.id)) return { ok: false, error: '住宿基地标识已存在' }
  const next: AccommodationState = { version: 1, bases: [...state.bases, persistedBase], stays: state.stays }
  return {
    ok: true,
    committed: true,
    state: next,
    event: { type: 'create', base: copyBase(persistedBase), dayIndices: [], routeDays: [] },
    dayIndices: [],
    routeDays: [],
    base: copyBase(persistedBase),
  }
}

/** Ticket-named alias for `saveBase` (saved without applying to nights). */
export const saveAsAlternate = saveBase

/* ------------------------------------------------------------------ *
 * Backup validation + full replace (note B §2.1/§2.2 — used by part C
 * backup, but replaceState is part of the authoritative core).
 * ------------------------------------------------------------------ */

/**
 * Export payload (L263–274 `getBackup`): every overnight night explicit
 * (defaults resolved, so the file round-trips through `validateBackup`), the
 * `isDefault`/`routeName` flags stripped, and nothing else — no amapKey, no
 * app settings. Field order matches the stored custom-base literal so exports
 * are byte-compatible with the legacy site.
 */
export function backupFor(state: AccommodationState): AccommodationBackup {
  const stays: Record<number, string> = {}
  overnightDays.forEach((index) => {
    const stay = getDayStay(state, index)
    stays[index] = stay?.id ?? defaultStayByDay[index] ?? ''
  })
  return {
    format: ACCOMMODATION_BACKUP_FORMAT,
    version: ACCOMMODATION_VERSION,
    bases: state.bases.map((base) => ({
      id: base.id,
      name: base.name,
      type: base.type,
      lat: base.lat,
      lng: base.lng,
      address: base.address,
      notes: base.notes,
      createdAt: base.createdAt,
    })),
    stays,
  }
}

/** Legacy names (`getBackup` / `exportBackup` in note B §3.1). */
export const getBackup = backupFor
export const exportBackup = backupFor

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

export function validBackupId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
}

export function invalidBackup(...errors: string[]): { ok: false; errors: string[]; error: string } {
  return { ok: false, errors, error: errors[0] || '备份文件无效' }
}

/** Full backup validation — exact messages from note B §2.1. */
export function validateBackup(input: string | unknown): AccommodationValidationResult {
  let source: unknown = input
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source)
    } catch {
      return invalidBackup('备份文件不是有效的 JSON。')
    }
  }
  if (!isPlainObject(source)) return invalidBackup('备份文件必须是一个 JSON 对象。')
  if (!hasOnlyKeys(source, ['format', 'version', 'bases', 'stays'])) return invalidBackup('备份包含无法识别的字段。')
  if (source.format !== ACCOMMODATION_BACKUP_FORMAT) return invalidBackup('备份格式不受支持。')
  if (source.version !== ACCOMMODATION_VERSION) return invalidBackup(`备份版本不受支持，仅支持 v${ACCOMMODATION_VERSION}。`)
  if (!Array.isArray(source.bases) || source.bases.length > ACCOMMODATION_MAX_BASES) {
    return invalidBackup(`自定义住宿基地最多支持 ${ACCOMMODATION_MAX_BASES} 个。`)
  }
  if (!isPlainObject(source.stays)) return invalidBackup('每晚住宿选择格式无效。')

  const bases: AccommodationBackupBase[] = []
  const ids = new Set(defaultIdSet)
  const rawBases = source.bases as unknown[]
  for (let index = 0; index < rawBases.length; index += 1) {
    const value = rawBases[index]
    if (!isPlainObject(value) || !hasOnlyKeys(value, ['id', 'name', 'type', 'lat', 'lng', 'address', 'notes', 'createdAt'])) {
      return invalidBackup(`第 ${index + 1} 个住宿基地包含无效字段。`)
    }
    if (!validBackupId(value.id) || ids.has(value.id)) return invalidBackup(`第 ${index + 1} 个住宿基地的标识无效或重复。`)
    if (typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 120) {
      return invalidBackup(`第 ${index + 1} 个住宿基地的名称无效。`)
    }
    if (value.type !== 'hotel' && value.type !== 'area') return invalidBackup(`第 ${index + 1} 个住宿基地的类型无效。`)
    if (
      typeof value.lat !== 'number' ||
      typeof value.lng !== 'number' ||
      !validCoordinate(value.lat, value.lng)
    ) {
      return invalidBackup(`第 ${index + 1} 个住宿基地的位置无效。`)
    }
    if (value.address !== undefined && (typeof value.address !== 'string' || value.address.length > 240)) {
      return invalidBackup(`第 ${index + 1} 个住宿基地的地址过长或无效。`)
    }
    if (value.notes !== undefined && (typeof value.notes !== 'string' || value.notes.length > 600)) {
      return invalidBackup(`第 ${index + 1} 个住宿基地的备注过长或无效。`)
    }
    if (value.createdAt !== undefined && (typeof value.createdAt !== 'string' || value.createdAt.length > 80 || Number.isNaN(Date.parse(value.createdAt)))) {
      return invalidBackup(`第 ${index + 1} 个住宿基地的创建时间无效。`)
    }
    const base: AccommodationBackupBase = {
      id: value.id,
      name: value.name.trim(),
      type: value.type,
      lat: value.lat,
      lng: value.lng,
      address: (value.address || '').trim(),
      notes: (value.notes || '').trim(),
      createdAt: value.createdAt || new Date().toISOString(),
    }
    ids.add(base.id)
    bases.push(base)
  }

  const expectedDays = overnightDays.map(String)
  const stayKeys = Object.keys(source.stays)
  if (stayKeys.length !== expectedDays.length || expectedDays.some((day) => !Object.prototype.hasOwnProperty.call(source.stays, day))) {
    return invalidBackup('备份没有完整包含每晚住宿选择。')
  }
  if (stayKeys.some((day) => !expectedDays.includes(day))) return invalidBackup('备份包含不存在的住宿晚次。')
  const stays: Record<number, string> = {}
  for (const day of expectedDays) {
    const id = source.stays[day]
    if (!validBackupId(id) || !ids.has(id)) return invalidBackup(`第 ${Number(day) + 1} 晚引用了不存在的住宿基地。`)
    stays[Number(day)] = id
  }
  return { ok: true, value: { format: ACCOMMODATION_BACKUP_FORMAT, version: 1, bases, stays } }
}

export type ReplaceStateResult = AccommodationCommittedResult | { ok: false; errors: string[]; error: string }

/**
 * Whole replacement (L281–301): validates, rebuilds with all nights
 * explicit, computes `routeDays` = days whose route signature changed.
 * The legacy persist step + `{ok:false,error:'保存失败',errors:[...]}` on
 * write failure lives in the provider (storage write is not pure).
 */
export function replaceState(state: AccommodationState, input: string | unknown): ReplaceStateResult {
  const validation = validateBackup(input)
  if (!validation.ok) return validation
  const next: AccommodationState = {
    version: 1,
    bases: validation.value.bases.map((base) => ({ ...base, isDefault: false })),
    stays: { ...validation.value.stays },
  }
  const before = tripPlan.days.map((_, index) => routeSignature(getDayRoute(state, index)))
  const routeDays = tripPlan.days
    .map((_, index) => index)
    .filter((index) => before[index] !== routeSignature(getDayRoute(next, index)))
  return {
    ok: true,
    committed: true,
    state: next,
    event: { type: 'restore', dayIndices: [...overnightDays], routeDays },
    dayIndices: [...overnightDays],
    routeDays,
  }
}

/** Legacy alias `importState` (note B §2.2). */
export const importState = replaceState