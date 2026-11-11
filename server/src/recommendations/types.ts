/**
 * Recommendation / stash / favorite storage contracts (ticket 15).
 *
 * POI data is intentionally kept as an opaque JSON value at the driver
 * boundary. The repository owns validation and tolerant decoding so corrupt
 * rows cannot take the workbench down.
 */

import type { RecommendationOrigin, RecommendationPoi } from '@hailar/domain'
export type {
  FavoriteItem,
  RecommendationOrigin,
  RecommendationPoi,
  RecommendationsSnapshot,
  StashItem,
} from '@hailar/domain'

export interface StashRow {
  id: unknown
  trip_id: unknown
  poi: unknown
  origin: unknown
  added_at: unknown
}

export interface FavoriteRow {
  id: unknown
  trip_id: unknown
  poi: unknown
  created_at: unknown
}

export interface StashInsert {
  id: string
  poi: string
  origin: RecommendationOrigin
  addedAt: string
}

export interface FavoriteInsert {
  id: string
  poi: string
  createdAt: string
}

export interface RecommendationsStoreDriver {
  listStashRows(tripId: string): Promise<StashRow[]>
  insertStashRow(tripId: string, item: StashInsert): Promise<void>
  deleteStashRow(tripId: string, stashId: string): Promise<boolean>
  listFavoriteRows(tripId: string): Promise<FavoriteRow[]>
  insertFavoriteRow(tripId: string, favorite: FavoriteInsert): Promise<void>
  deleteFavoriteRow(tripId: string, favoriteId: string): Promise<boolean>
}

export type RecommendationsErrorCode = 'invalid' | 'not_found' | 'storage'

export type RecommendationWriteResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: string; code: RecommendationsErrorCode }

export type PoiSearchInput = {
  query: string
  region?: string
  type?: RecommendationPoi['type'] | null
}

export type PoiSearch = (input: PoiSearchInput) => Promise<RecommendationPoi[]>

export type RoutePoint = {
  name?: string
  lat: number
  lng: number
}

export type RouteLegResult = {
  status: 'ok' | 'pending'
  source: 'amap' | 'pending'
  distanceKm: number | null
  durationMin: number | null
  polyline: Array<[number, number]> | null
  reason?: string
}

export type RouteLegSearch = (input: { from: RoutePoint; to: RoutePoint }) => Promise<RouteLegResult>
