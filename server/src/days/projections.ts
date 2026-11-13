import type { Day } from '@hailar/domain'

/** Optional aliases use raw, trusted values, never the legacy decoder's fallbacks. */
export function projectDayIdentity(
  storedTripId: unknown,
  storedIndex: unknown,
  expectedTripId?: string,
): Pick<Day, 'tripId' | 'dayNumber'> {
  const tripId = typeof storedTripId === 'string' && storedTripId.trim() !== ''
    && (expectedTripId === undefined || storedTripId === expectedTripId)
    ? storedTripId
    : undefined
  // SQLite INTEGER columns return numbers. Null, text and other corrupt values
  // must not acquire day 1 merely because a tolerant legacy reader uses 0.
  const dayNumber = typeof storedIndex === 'number' && Number.isSafeInteger(storedIndex)
    && storedIndex >= 0 && Number.isSafeInteger(storedIndex + 1)
    ? storedIndex + 1
    : undefined
  return {
    ...(tripId !== undefined ? { tripId } : {}),
    ...(dayNumber !== undefined ? { dayNumber } : {}),
  }
}
