/**
 * Pure port of `amap-utils.js` (window.TibetAMapUtils) — route-estimate
 * helpers used by the AMap live layer and the day-detail rendering.
 *
 * Byte-faithful to the legacy module (amap-utils.js:12–29): statuses, colors,
 * duration formatting, traffic coverage accounting and escapeHtml.
 */

export const statuses = ['畅通', '缓行', '拥堵', '严重拥堵', '未知'] as const

export type TrafficStatus = (typeof statuses)[number]

export const colors: Record<TrafficStatus, string> = {
  畅通: '#259b57',
  缓行: '#dfaa23',
  拥堵: '#e44b45',
  严重拥堵: '#a41d32',
  未知: '#8b949b',
}

/** Legacy HTML escaper (amap-utils.js:14–19) — kept for parity with the old test. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (character) => {
    const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
    return map[character] ?? character
  })
}

/** Seconds → 「N 分钟」 / 「N 小时 M 分钟」; never invents a missing estimate (amap-utils.js:5–9). */
export function duration(seconds: unknown): string {
  if (seconds == null || seconds === '' || !Number.isFinite(Number(seconds)) || Number(seconds) < 0) return '暂无时间'
  const minutes = Math.max(1, Math.ceil(Number(seconds) / 60))
  return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ''}`
}

export interface TrafficSegment {
  status: string
  distance: number
  /** segments keep their original tmc fields (path etc.) for drawing. */
  [key: string]: unknown
}

export interface TrafficResult {
  totals: Record<string, number>
  segments: TrafficSegment[]
  known: boolean
}

export interface TrafficRouteLike {
  distance?: number
  steps?: Array<{ tmcs?: Array<{ status?: string; distance?: number; path?: unknown }> }>
}

/** Coverage accounting: 未知 swallows the unreported distance (amap-utils.js:21–28). */
export function traffic(route: TrafficRouteLike): TrafficResult {
  const totals: Record<string, number> = Object.fromEntries(statuses.map((status) => [status, 0]))
  const segments: TrafficSegment[] = []
  for (const step of route.steps ?? []) {
    if (!step.tmcs?.length) continue
    for (const segment of step.tmcs) {
      const status = statuses.includes(segment.status as TrafficStatus) ? (segment.status as string) : '未知'
      const distance = Math.max(0, Number(segment.distance) || 0)
      totals[status] = (totals[status] ?? 0) + distance
      segments.push({ ...segment, status, distance })
    }
  }
  const accounted = Object.values(totals).reduce((a, b) => a + b, 0)
  totals['未知'] = (totals['未知'] ?? 0) + Math.max(0, (Number(route.distance) || 0) - accounted)
  return { totals, segments, known: statuses.slice(0, 4).some((status) => (totals[status] ?? 0) > 0) }
}