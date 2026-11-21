import type { Leg } from '@hailar/domain'

type LegMetricProjection = Pick<Leg, 'distanceMeters' | 'durationSeconds' | 'formattedDistance' | 'formattedDuration'>

/**
 * Aliases of the currently available legacy scalars, not recovered provider
 * precision or stronger route verification. Call before tolerant coercion.
 * Old writes may already have lost invalid-vs-zero provenance; no read can
 * recover that history from the current columns.
 */
export function projectLegMetrics(
  distanceKm: unknown,
  durationMin: unknown,
  quality: unknown,
  polyline: Leg['polyline'],
): LegMetricProjection {
  // Known empty constructions, including historical rows without provenance.
  const quantified = quality === 'reference' || quality === 'estimate' || quality === 'measured'
  if (distanceKm === 0 && durationMin === 0 && (quality === 'pending' || (!quantified && polyline === null))) return {}

  const distanceMeters = convertMetric(distanceKm, 1000)
  const durationSeconds = convertMetric(durationMin, 60)
  return {
    ...(distanceMeters === undefined ? {} : { distanceMeters, formattedDistance: `${String(distanceKm)} 千米` }),
    ...(durationSeconds === undefined ? {} : { durationSeconds, formattedDuration: `${String(durationMin)} 分钟` }),
  }
}

function convertMetric(value: unknown, factor: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  const converted = value * factor
  return Number.isFinite(converted) ? converted : undefined
}
