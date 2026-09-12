import type {
  FavoriteInsert,
  FavoriteRow,
  RecommendationsStoreDriver,
  StashInsert,
  StashRow,
} from './types.js'

/** In-memory recommendation store used by API/repository tests. */
export class MemoryRecommendationsStoreDriver implements RecommendationsStoreDriver {
  readonly stashRows = new Map<string, StashRow>()
  readonly favoriteRows = new Map<string, FavoriteRow>()
  nextWriteError: Error | null = null

  private failNextWrite(): void {
    if (!this.nextWriteError) return
    const error = this.nextWriteError
    this.nextWriteError = null
    throw error
  }

  async listStashRows(tripId: string): Promise<StashRow[]> {
    return [...this.stashRows.values()].filter((row) => row.trip_id === tripId)
  }

  async insertStashRow(tripId: string, item: StashInsert): Promise<void> {
    this.failNextWrite()
    this.stashRows.set(item.id, {
      id: item.id,
      trip_id: tripId,
      poi: item.poi,
      origin: item.origin,
      added_at: item.addedAt,
    })
  }

  async deleteStashRow(tripId: string, stashId: string): Promise<boolean> {
    this.failNextWrite()
    const row = this.stashRows.get(stashId)
    if (!row || row.trip_id !== tripId) return false
    this.stashRows.delete(stashId)
    return true
  }

  async listFavoriteRows(tripId: string): Promise<FavoriteRow[]> {
    return [...this.favoriteRows.values()].filter((row) => row.trip_id === tripId)
  }

  async insertFavoriteRow(tripId: string, favorite: FavoriteInsert): Promise<void> {
    this.failNextWrite()
    this.favoriteRows.set(favorite.id, {
      id: favorite.id,
      trip_id: tripId,
      poi: favorite.poi,
      created_at: favorite.createdAt,
    })
  }

  async deleteFavoriteRow(tripId: string, favoriteId: string): Promise<boolean> {
    this.failNextWrite()
    const row = this.favoriteRows.get(favoriteId)
    if (!row || row.trip_id !== tripId) return false
    this.favoriteRows.delete(favoriteId)
    return true
  }
}
