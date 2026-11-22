type Coordinates = { lat: number; lng: number }

/** Missing and malformed stored fields must not become zero-valued endpoints. */
export function readRoutePoint(value: unknown): Coordinates | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  try {
    const poi = JSON.parse(value) as
      | (Partial<Record<'lat' | 'lng', unknown>> & {
          location?: Partial<Record<'lat' | 'lng', unknown>>
        })
      | null
    const lat = readCoordinate(poi?.location?.lat ?? poi?.lat)
    const lng = readCoordinate(poi?.location?.lng ?? poi?.lng)
    return lat === undefined || lng === undefined ? undefined : { lat, lng }
  } catch {
    return undefined
  }
}

function readCoordinate(value: unknown): number | undefined {
  const numeric = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof numeric === 'number' && Number.isFinite(numeric) ? numeric : undefined
}

export function validRoutePoint(point: Coordinates): Coordinates | null {
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return null
  if (point.lat < -90 || point.lat > 90 || point.lng < -180 || point.lng > 180) return null
  if (point.lat === 0 && point.lng === 0) return null
  return { lat: point.lat, lng: point.lng }
}

/** Compare ordered WGS-84 endpoints without rounding or using display names. */
export function drivingRouteKey(
  from: Coordinates | null | undefined,
  to: Coordinates | null | undefined,
): string | null {
  const start = from && validRoutePoint(from)
  const end = to && validRoutePoint(to)
  return start && end ? JSON.stringify([start.lat, start.lng, end.lat, end.lng]) : null
}
