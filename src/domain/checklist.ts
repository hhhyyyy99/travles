/**
 * Checklist domain — pure logic, no React, no DOM access.
 *
 * Storage contract (byte-compatible with the legacy site, trip.js:247–251):
 * - key: `hailar-slow-trip-checklist-oct7-v2`
 * - payload: a plain JSON array of checked indices (numbers), no version field
 * - load: JSON.parse(getItem(key) || '[]'); non-array -> []; parse failure -> []
 *   (never throws); values normalized to numbers
 * - count denominator is hardcoded 6, not checklist.length
 * - every render/change persists the cleaned selection (normalize-on-next-write)
 */

export const CHECKLIST_STORAGE_KEY = 'hailar-slow-trip-checklist-oct7-v2'

export const CHECKLIST_ITEMS = [
  '确认海拉尔机场同点取还车',
  '订好 6 晚住宿、莫尔道嘎与黑山头问供暖',
  '确认额尔古纳湿地、莫尔道嘎开放时间',
  '准备证件与防风保暖衣物',
  '下载离线地图、检查天气路况',
  '确认 10/8 还车与航站楼时间',
] as const

export const CHECKLIST_DENOMINATOR = 6

export const CHECKLIST_DEFAULT_STATUS = '勾选状态保存在当前浏览器。'
export const CHECKLIST_SAVE_FAILURE_STATUS = '当前浏览器未允许保存，勾选仅在本页有效。'

export interface ChecklistStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** Legacy-tolerant read: never throws, non-array -> [], parse failure -> []. */
export function loadChecklist(storage: ChecklistStorage): number[] {
  let raw: string | null = null
  try {
    raw = storage.getItem(CHECKLIST_STORAGE_KEY)
  } catch {
    // storage read denied — treat as empty
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw ?? '[]')
  } catch {
    parsed = []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.filter((value): value is number => typeof value === 'number')
}

/** Valid checked indices: integers in 0..5, deduplicated, ascending (canonical form). */
export function normalizeChecklist(indices: Iterable<number>): number[] {
  const seen = new Set<number>()
  for (const index of indices) {
    if (Number.isInteger(index) && index >= 0 && index < CHECKLIST_ITEMS.length) {
      seen.add(index)
    }
  }
  return [...seen].sort((a, b) => a - b)
}

/** Writes the canonical payload; returns false when storage refuses (legacy try/catch). */
export function saveChecklist(storage: ChecklistStorage, indices: Iterable<number>): boolean {
  try {
    storage.setItem(CHECKLIST_STORAGE_KEY, JSON.stringify(normalizeChecklist(indices)))
    return true
  } catch {
    return false
  }
}
