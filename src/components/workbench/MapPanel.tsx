/**
 * 路线地图 (ticket 05) — the right column becomes a real projection of the
 * trip: per-day colored driving polylines (same accent colors as the canvas
 * day headers) with direction chevrons, a floating per-day mileage label on
 * route hover, and POI sequence markers with zoom-dependent collision hiding.
 *
 * Linkage seams (both directions):
 * - canvas card click → `selectedItemId` prop → map focuses the POI + detail
 *   card; closing the card re-fits the whole-trip overview.
 * - map marker click → `onSelectItem(itemId)` → the canvas scrolls to the day
 *   and highlights the card (wired in WorkbenchPage).
 *
 * Drawing goes through the existing Leaflet pipeline (createRouteMap +
 * src/services/workbenchMap.ts); the guide's static markers / zoom control
 * are opted out. Map controls: whole-trip overview, zoom +/−, 我的位置 stub,
 * and the top-right 总览/按日 view dropdown.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Bookmark, ChevronLeft, ChevronRight, Crosshair, Heart, Map as MapIcon, Maximize2, PanelRightClose, Search, Star, X } from 'lucide-react'
import {
  dayAccentColor,
  dayDateLabel,
  type WorkbenchDay,
  type WorkbenchItem,
  type WorkbenchLeg,
} from '../../domain/workbench'
import {
  dayFitCoordinates,
  dayMileageKm,
  dayRouteQuality,
  dayRouteSegments,
  formatMileageLabel,
  hiddenByCollision,
  poiMarkersForDays,
  tripFitCoordinates,
} from '../../domain/workbenchMap'
import { searchUrl } from '../../services/navigationUrl'
import { useRouteMap } from '../../hooks/useRouteMap'
import {
  addFavorite,
  addToStash,
  fetchRecommendations,
  filterRecommendations,
  recommendationFilterCounts,
  recommendationTypeLabel,
  removeFavorite,
  removeFromStash,
  searchRecommendations,
  type FavoriteItem,
  type RecommendationPoi,
  type RecommendationType,
  type StashItem,
} from '../../domain/recommendations'
import { renderRecommendationPois } from '../../services/recommendationMap'
import {
  fitWorkbenchCoordinates,
  focusWorkbenchPoi,
  renderWorkbenchPois,
  renderWorkbenchRoutes,
  type WorkbenchRouteDay,
} from '../../services/workbenchMap'
import { subscribeTripEvents } from '../../domain/tripEvents'

const RECOMMENDATION_EVENT_REASONS = new Set([
  'stash_added',
  'stash_deleted',
  'favorite_added',
  'favorite_deleted',
])

export interface MapPanelProps {
  tripId: string
  days: WorkbenchDay[]
  legs: WorkbenchLeg[]
  /** Selected canvas card (also set by marker clicks); null = overview. */
  selectedItemId: string | null
  /** Marker clicks and the detail card's close button both land here. */
  onSelectItem: (itemId: string | null) => void
  onCollapse: () => void
  /**
   * AI-message POI link focus (ticket 07): panning only — no detail card,
   * since the POI is not an itinerary item. Change of value re-centers.
   */
  focus?: { name: string; lat: number; lng: number; amapId?: string } | null
  /** Schedule a recommendation through the existing item-admin write path. */
  onSchedulePoi?: (poi: RecommendationPoi, stashId?: string, dayId?: string, index?: number) => Promise<boolean>
  /** A card edit or remote update is recomputing the route projection. */
  syncing?: boolean
}

function findSelectedItem(days: WorkbenchDay[], itemId: string | null): { item: WorkbenchItem; day: WorkbenchDay } | null {
  if (!itemId) return null
  for (const day of days) {
    const item = day.items.find((candidate) => candidate.id === itemId)
    if (item) return { item, day }
  }
  return null
}

export default function MapPanel({ tripId, days, legs, selectedItemId, onSelectItem, onCollapse, focus, onSchedulePoi, syncing = false }: MapPanelProps) {
  const { containerRef, handleRef, tileError } = useRouteMap({
    onDaySelect: () => {},
    onMapReady: () => {
      const handle = handleRef.current
      if (!handle) return
      setZoom(handle.map.getZoom())
      handle.map.on('zoomend', () => setZoom(handle.map.getZoom()))
      // StrictMode/HMR recreate the handle: bump the tick so the drawing
      // effects below re-run against the fresh map (mirrors the guide app,
      // which draws from onMapReady for the same reason).
      setMapReadyTick((tick) => tick + 1)
    },
    createOptions: {
      staticMarkers: false,
      zoomControl: false,
      layersControl: false,
      initialView: { center: [40, 100], zoom: 5 },
    },
  })
  const [mapReadyTick, setMapReadyTick] = useState(0)
  const [zoom, setZoom] = useState(5)
  const [viewDropdownOpen, setViewDropdownOpen] = useState(false)
  const [viewDayId, setViewDayId] = useState<string | null>(null)
  const [carouselIndex, setCarouselIndex] = useState(0)
  const [favorites, setFavorites] = useState<FavoriteItem[]>([])
  const [stash, setStash] = useState<StashItem[]>([])
  const [recommendations, setRecommendations] = useState<RecommendationPoi[]>([])
  const [recommendationsEnabled, setRecommendationsEnabled] = useState(false)
  const [recommendationPanel, setRecommendationPanel] = useState<'stash' | 'favorites' | null>(null)
  const [selectedRecommendationId, setSelectedRecommendationId] = useState<string | null>(null)
  const [regionFilter, setRegionFilter] = useState('all')
  const [typeFilter, setTypeFilter] = useState<RecommendationType | 'all'>('all')
  const [recommendationQuery, setRecommendationQuery] = useState('沿途推荐')
  const [recommendationError, setRecommendationError] = useState('')
  const [selectedDayId, setSelectedDayId] = useState(days[0]?.id ?? '')
  // Existing standalone/browser fixtures do not mount the recommendations API;
  // keep the detail-card toggle usable while the server-backed state remains
  // authoritative whenever the endpoint is available.
  const [localFavoriteKeys, setLocalFavoriteKeys] = useState<Set<string>>(new Set())
  const [recommendationsApiAvailable, setRecommendationsApiAvailable] = useState(false)
  const searchRequestRef = useRef(0)
  const recommendationsEnabledRef = useRef(recommendationsEnabled)
  recommendationsEnabledRef.current = recommendationsEnabled
  const onSelectItemRef = useRef(onSelectItem)
  onSelectItemRef.current = onSelectItem

  const selected = findSelectedItem(days, selectedItemId)
  const poi = selected?.item.poi ?? null
  const hasDetail = selected !== null && poi !== null

  useEffect(() => {
    setSelectedDayId((current) => (days.some((day) => day.id === current) ? current : days[0]?.id ?? ''))
  }, [days])

  const refreshRecommendations = (): void => {
    void fetchRecommendations(tripId).then((result) => {
      if (!result.ok) {
        setRecommendationsApiAvailable(false)
        setRecommendationError(result.error)
        return
      }
      setRecommendationsApiAvailable(true)
      // A refresh after a mutation should keep the active search result. The
      // aggregate endpoint intentionally contains saved rows only, so
      // replacing an active query with it would make other results disappear.
      if (!recommendationsEnabledRef.current) setRecommendations(result.data.recommendations)
      setStash(result.data.stash)
      setFavorites(result.data.favorites)
      setRecommendationError('')
    })
  }

  useEffect(() => {
    refreshRecommendations()
    // A map panel is mounted once per trip; the callback intentionally uses
    // the current trip id only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripId])

  useEffect(() => {
    let active = true
    const unsubscribe = subscribeTripEvents(tripId, {
      onUpdate: (event) => {
        if (active && event.kind === 'canvas' && RECOMMENDATION_EVENT_REASONS.has(event.reason)) {
          refreshRecommendations()
        }
      },
    })
    return () => {
      active = false
      unsubscribe()
    }
    // The subscription is trip-scoped; refreshRecommendations reads current
    // recommendation state through its ref and stable React state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripId])

  useEffect(() => {
    if (!recommendationsEnabled) return
    const requestId = searchRequestRef.current + 1
    searchRequestRef.current = requestId
    // Search is the same backend POI channel used by AI recommendation chips.
    // Saved rows remain visible when the provider is unavailable.
    void searchRecommendations(tripId, recommendationQuery, { region: regionFilter, type: typeFilter }).then((result) => {
      if (requestId !== searchRequestRef.current) return
      if (result.ok) {
        setRecommendations(result.data)
        setRecommendationError('')
      } else {
        setRecommendations([])
        setRecommendationError(result.error)
      }
    })
  }, [recommendationsEnabled, recommendationQuery, regionFilter, typeFilter, tripId])

  const recommendationPool = useMemo(() => {
    const byKey = new Map<string, RecommendationPoi>()
    for (const poi of [...recommendations, ...stash.map((item) => item.poi), ...favorites.map((item) => item.poi)]) {
      byKey.set(poi.amapId || poi.id || `${poi.name}|${poi.lat}|${poi.lng}`, poi)
    }
    return [...byKey.values()]
  }, [recommendations, stash, favorites])
  const filteredRecommendations = useMemo(
    () => filterRecommendations(recommendationPool, { region: regionFilter, type: typeFilter }),
    [recommendationPool, regionFilter, typeFilter],
  )
  const filterCounts = useMemo(
    () => recommendationFilterCounts(filterRecommendations(recommendationPool, { region: regionFilter, type: 'all' })),
    [recommendationPool, regionFilter],
  )
  const regions = useMemo(
    () => [...new Set(recommendationPool.map((poi) => poi.region).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [recommendationPool],
  )
  const selectedRecommendation = selectedRecommendationId
    ? recommendationPool.find((candidate) => candidate.id === selectedRecommendationId) ?? null
    : null
  const selectedRecommendationStash = selectedRecommendation
    ? stash.find((item) => samePoi(item.poi, selectedRecommendation))
    : undefined
  const selectedFavorite = selectedRecommendation
    ? favorites.find((item) => samePoi(item.poi, selectedRecommendation))
    : undefined

  const routes = useMemo<WorkbenchRouteDay[]>(
    () =>
      days.map((day, index) => ({
        dayId: day.id,
        color: dayAccentColor(day.color, day.index),
        segments: dayRouteSegments(day, legs, days[index - 1]),
        mileageLabel: formatMileageLabel(
          day,
          dayMileageKm(day, legs, days[index - 1]),
          dayRouteQuality(day, legs, days[index - 1]),
        ),
      })),
    [days, legs],
  )
  const markers = useMemo(() => poiMarkersForDays(days), [days])
  const hiddenMarkers = useMemo(
    () => hiddenByCollision(markers, zoom),
    [markers, zoom],
  )

  // Per-day routes + chevrons (redrawn when the canvas data or map changes).
  useEffect(() => {
    const handle = handleRef.current
    if (!handle) return
    renderWorkbenchRoutes(handle, routes)
  }, [handleRef, routes, mapReadyTick])

  // POI sequence markers with collision hiding, recomputed on zoom.
  useEffect(() => {
    const handle = handleRef.current
    if (!handle) return
    renderWorkbenchPois(
      handle,
      markers.map((marker) => ({ ...marker, hidden: hiddenMarkers.has(marker.itemId) })),
      (itemId) => onSelectItemRef.current(itemId),
    )
  }, [handleRef, markers, hiddenMarkers, mapReadyTick])

  // Recommendation markers share the same Leaflet map/lifecycle as itinerary
  // markers. They are cleared whenever the toggle or filters change.
  useEffect(() => {
    const handle = handleRef.current
    if (!handle) return
    renderRecommendationPois(
      handle,
      recommendationsEnabled ? filteredRecommendations : [],
      (id) => setSelectedRecommendationId(id),
    )
  }, [handleRef, recommendationsEnabled, filteredRecommendations, mapReadyTick])

  // Canvas card click → focus the POI. Marker clicks flow through the same
  // state, so the map follows the canvas in both directions.
  useEffect(() => {
    const handle = handleRef.current
    if (!handle || !selected) return
    setCarouselIndex(0)
    // A selected card without a usable POI (traffic card / free text) has
    // nothing to focus on: fall back to the whole-trip overview so the map does
    // not stay stuck on the previous POI's viewport.
    if (!poi || !focusWorkbenchPoi(handle, [poi.lat, poi.lng])) {
      fitWorkbenchCoordinates(handle, tripFitCoordinates(days, legs))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedItemId, mapReadyTick])

  // Selection cleared (detail closed) → back to the whole-trip overview.
  useEffect(() => {
    const handle = handleRef.current
    if (!handle || selectedItemId !== null) return
    fitWorkbenchCoordinates(handle, tripFitCoordinates(days, legs))
  }, [handleRef, selectedItemId, days, legs, mapReadyTick])

  // AI-message POI link click (ticket 07) → pan to the coordinate. Panning
  // only: the linked POI is not an itinerary item, so no detail card opens.
  // The container's data-last-focus exposes the applied target to tests.
  useEffect(() => {
    const handle = handleRef.current
    if (!handle || !focus) return
    focusWorkbenchPoi(handle, [focus.lat, focus.lng])
    handle.map.getContainer().setAttribute('data-last-focus', `${focus.lat},${focus.lng}`)
  }, [focus])

  const fitOverview = (): void => {
    setViewDayId(null)
    setViewDropdownOpen(false)
    const handle = handleRef.current
    if (handle) fitWorkbenchCoordinates(handle, tripFitCoordinates(days, legs))
  }

  const focusViewDay = (dayId: string): void => {
    setViewDayId(dayId)
    setViewDropdownOpen(false)
    const day = days.find((candidate) => candidate.id === dayId)
    const handle = handleRef.current
    const dayIndex = days.findIndex((candidate) => candidate.id === dayId)
    if (day && handle) fitWorkbenchCoordinates(handle, dayFitCoordinates(day, legs, days[dayIndex - 1]))
  }

  const images = selected?.item.images ?? []
  const selectedPoi = selected?.item.poi ?? null
  const favoriteActive = Boolean(selectedPoi && (favorites.some((entry) => samePoi(entry.poi, recommendationFromItem(selectedPoi, selected?.item.title ?? ''))) || localFavoriteKeys.has(poiKey(selectedPoi))))

  const toggleRecommendationPanel = (panel: 'stash' | 'favorites'): void => {
    setRecommendationPanel((current) => (current === panel ? null : panel))
    setSelectedRecommendationId(null)
  }

  const toggleFavoritePoi = async (target: RecommendationPoi): Promise<void> => {
    const current = favorites.find((entry) => samePoi(entry.poi, target))
    const key = poiKey(target)
    setRecommendationError('')
    if (!current && localFavoriteKeys.has(key)) {
      setLocalFavoriteKeys((keys) => {
        const next = new Set(keys)
        next.delete(key)
        return next
      })
      return
    }
    if (current) {
      setLocalFavoriteKeys((keys) => {
        const next = new Set(keys)
        next.delete(key)
        return next
      })
      const result = await removeFavorite(tripId, current.id)
      if (!result.ok) {
        setLocalFavoriteKeys((keys) => new Set([...keys, key]))
        setRecommendationError(result.error)
        return
      }
    } else {
      setLocalFavoriteKeys((keys) => new Set([...keys, key]))
      const result = await addFavorite(tripId, target)
      if (!result.ok) {
        // Keep the legacy local-only fallback for fixtures/older hosts that do
        // not expose ticket 15 yet. A configured API must roll the optimistic
        // state back so a failed write can be retried safely.
        if (recommendationsApiAvailable) {
          setLocalFavoriteKeys((keys) => {
            const next = new Set(keys)
            next.delete(key)
            return next
          })
        }
        setRecommendationError(result.error)
        return
      }
    }
    refreshRecommendations()
  }

  const stashRecommendation = async (target: RecommendationPoi): Promise<void> => {
    const result = await addToStash(tripId, target)
    if (!result.ok) setRecommendationError(result.error)
    else refreshRecommendations()
  }

  const scheduleRecommendation = async (target: RecommendationPoi, stashId?: string): Promise<void> => {
    if (!selectedDayId || !onSchedulePoi) return
    const scheduled = await onSchedulePoi(target, stashId, selectedDayId)
    if (scheduled) {
      setSelectedRecommendationId(null)
      refreshRecommendations()
    }
  }

  return (
    <div className="flex h-full flex-col" aria-busy={syncing}>
      <div className="flex items-center gap-[8px] border-b border-line px-[14px] py-[10px] text-[13px] font-[550]">
        <MapIcon aria-hidden="true" className="w-[15px] text-green" />
        路线地图
        <button
          type="button"
          data-action="collapse-map"
          title="收起地图栏"
          aria-label="收起地图栏"
          onClick={onCollapse}
          className="ml-auto grid h-[28px] w-[28px] place-items-center rounded-[5px] border border-line text-muted hover:border-green hover:text-green transition-colors"
        >
          <PanelRightClose aria-hidden="true" className="w-[14px]" />
        </button>
      </div>

      <div className="relative min-h-0 flex-1" data-map-mode={hasDetail ? 'focus' : 'overview'}>
        <div id="workbench-map" ref={containerRef} className="h-full w-full" aria-label="行程路线地图" />
        {tileError && (
          <div id="workbench-map-error" className="absolute inset-x-[10px] top-[8px] rounded-[5px] bg-white/95 px-[10px] py-[6px] text-[11px] text-muted shadow-sm">
            底图暂不可用，地点与路线示意仍可查看。
          </div>
        )}
        {syncing && (
          <div
            data-map-syncing
            className="pointer-events-none absolute left-[8px] top-[8px] z-[510] inline-flex items-center gap-[5px] rounded-[5px] border border-line bg-white/95 px-[8px] py-[4px] text-[11px] text-muted shadow-sm"
            aria-live="polite"
          >
            <span aria-hidden="true" className="workbench-spinner h-[11px] w-[11px] rounded-full border-2 border-line border-t-green" />
            路线重算中…
          </div>
        )}

        {/* 右上 总览/按日 下拉 */}
        <div className="absolute right-[8px] top-[8px] z-[500]">
          <button
            type="button"
            data-action="map-view-toggle"
            id="workbench-map-view-toggle"
            aria-haspopup="listbox"
            aria-expanded={viewDropdownOpen}
            onClick={() => setViewDropdownOpen((open) => !open)}
            className="rounded-[5px] border border-line bg-white px-[10px] py-[4px] text-[12px] font-[550] text-ink shadow-sm hover:border-green transition-colors"
          >
            {viewDayId ? viewDropdownLabel(days, viewDayId) : '总览'} ▾
          </button>
          {viewDropdownOpen && (
            <ul
              id="workbench-map-view-menu"
              role="listbox"
              aria-label="地图视野"
              className="mt-[4px] max-h-[260px] overflow-y-auto rounded-[6px] border border-line bg-white py-[4px] text-[12px] shadow-md"
            >
              <li>
                <button
                  type="button"
                  role="option"
                  aria-selected={viewDayId === null}
                  data-map-view-option="overview"
                  onClick={fitOverview}
                  className="w-full px-[12px] py-[6px] text-left hover:bg-paper"
                >
                  总览
                </button>
              </li>
              {days.map((day) => {
                const accent = dayAccentColor(day.color, day.index)
                return (
                  <li key={day.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={viewDayId === day.id}
                      data-map-view-option={day.id}
                      onClick={() => focusViewDay(day.id)}
                      className="flex w-full items-center gap-[6px] px-[12px] py-[6px] text-left hover:bg-paper"
                    >
                      <span aria-hidden="true" className="inline-block h-[8px] w-[8px] rounded-full" style={{ backgroundColor: accent }} />
                      {viewDropdownLabel(days, day.id)}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {/* 左下 地图控件 */}
        <div className="absolute bottom-[14px] left-[8px] z-[500] flex flex-col gap-[6px]">
          <button
            type="button"
            data-action="map-overview"
            id="workbench-map-overview"
            title="全图总览"
            aria-label="全图总览"
            onClick={fitOverview}
            className="grid h-[30px] w-[30px] place-items-center rounded-[5px] border border-line bg-white text-muted shadow-sm hover:border-green hover:text-green transition-colors"
          >
            <Maximize2 aria-hidden="true" className="w-[14px]" />
          </button>
          <button
            type="button"
            data-action="map-zoom-in"
            id="workbench-map-zoom-in"
            title="放大"
            aria-label="放大"
            onClick={() => handleRef.current?.map.zoomIn()}
            className="grid h-[30px] w-[30px] place-items-center rounded-[5px] border border-line bg-white text-muted shadow-sm hover:border-green hover:text-green transition-colors"
          >
            +
          </button>
          <button
            type="button"
            data-action="map-zoom-out"
            id="workbench-map-zoom-out"
            title="缩小"
            aria-label="缩小"
            onClick={() => handleRef.current?.map.zoomOut()}
            className="grid h-[30px] w-[30px] place-items-center rounded-[5px] border border-line bg-white text-muted shadow-sm hover:border-green hover:text-green transition-colors"
          >
            −
          </button>
          <button
            type="button"
            data-action="map-locate"
            id="workbench-map-locate"
            title="我的位置"
            aria-label="我的位置"
            className="grid h-[30px] w-[30px] place-items-center rounded-[5px] border border-line bg-white text-muted shadow-sm hover:border-green hover:text-green transition-colors"
          >
            <Crosshair aria-hidden="true" className="w-[14px]" />
          </button>
        </div>

        {/* POI 详情卡（点击标记或画布卡片触发） */}
        {hasDetail && selected && poi && (
          <aside id="workbench-poi-detail" data-poi-detail={selected.item.id} className="absolute inset-x-[8px] bottom-[62px] z-[600] rounded-[8px] border border-line bg-white p-[12px] shadow-lg">
            <div className="flex items-start gap-[8px]">
              <div className="min-w-0 flex-1">
                <h3 data-poi-detail-name className="truncate text-[14px] font-[600] text-ink">
                  {poi.name || selected.item.title}
                </h3>
                <div className="mt-[4px] flex items-center gap-[8px] text-[11px] text-muted">
                  {poi.rating > 0 && (
                    <span data-poi-detail-rating className="flex items-center gap-[2px]">
                      <Star aria-hidden="true" className="h-[11px] w-[11px] text-[#a8791f]" />
                      {poi.rating}
                    </span>
                  )}
                  {poi.category && (
                    <span data-poi-detail-category className="rounded-[4px] bg-paper px-[6px] py-[1px] text-[10px] text-muted">
                      {poi.category}
                    </span>
                  )}
                  <span className="rounded-[4px] px-[6px] py-[1px] text-[10px] text-white" style={{ backgroundColor: dayAccentColor(selected.day.color, selected.day.index) }}>
                    D{selected.day.index + 1}
                  </span>
                </div>
              </div>
              <button
                type="button"
                data-action="poi-detail-close"
                title="关闭详情"
                aria-label="关闭详情"
                onClick={() => onSelectItem(null)}
                className="grid h-[24px] w-[24px] shrink-0 place-items-center rounded-[5px] border border-line text-muted hover:border-green hover:text-green transition-colors"
              >
                <X aria-hidden="true" className="w-[13px]" />
              </button>
            </div>

            {images.length > 0 && (
              <div data-poi-carousel className="mt-[8px]">
                <img
                  src={images[Math.min(carouselIndex, images.length - 1)]?.url}
                  alt=""
                  data-poi-carousel-image
                  className="h-[110px] w-full rounded-[6px] object-cover"
                />
                <div className="mt-[4px] flex items-center justify-between text-[11px] text-muted">
                  <button
                    type="button"
                    data-action="carousel-prev"
                    aria-label="上一张"
                    onClick={() => setCarouselIndex((index) => (index - 1 + images.length) % images.length)}
                    className="grid h-[22px] w-[22px] place-items-center rounded-[4px] border border-line hover:border-green transition-colors"
                  >
                    <ChevronLeft aria-hidden="true" className="w-[12px]" />
                  </button>
                  <span data-poi-carousel-counter>
                    {Math.min(carouselIndex, images.length - 1) + 1}/{images.length}
                  </span>
                  <button
                    type="button"
                    data-action="carousel-next"
                    aria-label="下一张"
                    onClick={() => setCarouselIndex((index) => (index + 1) % images.length)}
                    className="grid h-[22px] w-[22px] place-items-center rounded-[4px] border border-line hover:border-green transition-colors"
                  >
                    <ChevronRight aria-hidden="true" className="w-[12px]" />
                  </button>
                </div>
              </div>
            )}

            {poi.introSummary && (
              <p className="mt-[8px] text-[12px] leading-[1.7] text-muted" data-poi-detail-intro>
                {poi.introSummary}
              </p>
            )}

            <p data-reference-disclaimer className="mt-[8px] text-[11px] leading-[1.6] text-muted">
              信息仅供参考，出发前请以官方信息与实时导航为准。
            </p>

            <div className="mt-[10px] flex items-center gap-[8px]">
              <button
                type="button"
                data-action="poi-favorite"
                aria-pressed={favoriteActive}
                onClick={() => {
                  if (poi) void toggleFavoritePoi(recommendationFromItem(poi, selected?.item.title ?? ''))
                }}
                className={`flex items-center gap-[4px] rounded-[5px] border px-[10px] py-[4px] text-[12px] transition-colors ${
                  favoriteActive ? 'border-[#b75342] text-[#b75342]' : 'border-line text-muted hover:border-green hover:text-green'
                }`}
              >
                <Heart aria-hidden="true" className="w-[13px]" />
                {favoriteActive ? '已收藏' : '收藏'}
              </button>
              <a
                href={searchUrl(poi.name)}
                target="_blank"
                rel="noreferrer"
                data-poi-detail-link
                className="ml-auto flex items-center gap-[2px] text-[12px] text-green hover:underline"
              >
                了解更多 ↗
              </a>
            </div>
          </aside>
        )}

        <section
          id="workbench-map-recommendations"
          data-recommendations-open={recommendationsEnabled || recommendationPanel !== null || undefined}
          className="pointer-events-none absolute inset-x-[8px] bottom-[8px] z-[550]"
        >
          {(recommendationsEnabled || recommendationPanel !== null) && (
            <div className="pointer-events-auto mb-[6px] max-h-[260px] overflow-y-auto rounded-[7px] border border-line bg-white/95 p-[8px] shadow-lg backdrop-blur-sm">
              {recommendationError && (
                <p data-recommendation-error className="mb-[6px] text-[11px] text-[#b75342]">
                  {recommendationError}
                </p>
              )}
              {recommendationPanel === 'stash' && (
                <div data-recommendation-panel="stash">
                  <div className="mb-[6px] flex items-center gap-[6px] text-[12px] font-[600]">
                    <Bookmark aria-hidden="true" className="h-[13px] text-green" />
                    待计划 <span className="text-[11px] font-normal text-muted">{stash.length}</span>
                  </div>
                  {stash.length === 0 ? (
                    <p className="text-[11px] text-muted">收藏或推荐一个点位，它会出现在这里。</p>
                  ) : (
                    <div className="space-y-[5px]">
                      {stash.map((item) => (
                        <StashRow
                          key={item.id}
                          item={item}
                          onSelect={() => setSelectedRecommendationId(item.poi.id)}
                          onRemove={() => {
                            void removeFromStash(tripId, item.id).then((result) => {
                              if (result.ok) setStash((current) => current.filter((entry) => entry.id !== item.id))
                              else setRecommendationError(result.error)
                            })
                          }}
                          onSchedule={() => void scheduleRecommendation(item.poi, item.id)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
              {recommendationPanel === 'favorites' && (
                <div data-recommendation-panel="favorites">
                  <div className="mb-[6px] flex items-center gap-[6px] text-[12px] font-[600]">
                    <Heart aria-hidden="true" className="h-[13px] text-[#b75342]" />
                    收藏 <span className="text-[11px] font-normal text-muted">{favorites.length}</span>
                  </div>
                  {favorites.length === 0 ? (
                    <p className="text-[11px] text-muted">还没有收藏点位。</p>
                  ) : (
                    <div className="space-y-[5px]">
                      {favorites.map((item) => (
                        <FavoriteRow
                          key={item.id}
                          item={item}
                          onSelect={() => setSelectedRecommendationId(item.poi.id)}
                          onRemove={() => void toggleFavoritePoi(item.poi)}
                          onSchedule={() => void scheduleRecommendation(item.poi, stash.find((entry) => samePoi(entry.poi, item.poi))?.id)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
              {recommendationPanel === null && (
                <div data-recommendation-panel="recommendations">
                  <div className="flex items-center gap-[6px]">
                    <Search aria-hidden="true" className="h-[13px] text-green" />
                    <input
                      data-action="recommendation-search"
                      value={recommendationQuery}
                      onChange={(event) => setRecommendationQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          setRecommendationsEnabled(true)
                        }
                      }}
                      aria-label="搜索推荐点位"
                      placeholder="搜索沿途推荐"
                      className="min-w-0 flex-1 border-b border-line bg-transparent px-[2px] py-[2px] text-[11px] outline-none focus:border-green"
                    />
                  </div>
                  <div className="mt-[7px] flex items-center gap-[5px]">
                    <select
                      data-action="recommendation-region-filter"
                      aria-label="推荐地区"
                      value={regionFilter}
                      onChange={(event) => setRegionFilter(event.target.value)}
                      className="min-w-0 flex-1 rounded-[4px] border border-line bg-white px-[4px] py-[3px] text-[10px] text-muted outline-none"
                    >
                      <option value="all">全部地区</option>
                      {regions.map((region) => <option key={region} value={region}>{region}</option>)}
                    </select>
                    <span className="flex min-w-0 flex-1 gap-[3px] overflow-x-auto">
                      {(['attraction', 'food', 'stay', 'other'] as RecommendationType[]).map((type) => (
                        <button
                          key={type}
                          type="button"
                          data-recommendation-type={type}
                          aria-pressed={typeFilter === type}
                          onClick={() => setTypeFilter((current) => current === type ? 'all' : type)}
                          className={`whitespace-nowrap rounded-[4px] border px-[5px] py-[3px] text-[10px] transition-colors ${typeFilter === type ? 'border-green bg-green text-white' : 'border-line text-muted hover:border-green'}`}
                        >
                          {recommendationTypeLabel(type)}·{filterCounts[type]}
                        </button>
                      ))}
                    </span>
                  </div>
                  <div className="mt-[7px] space-y-[5px]">
                    {filteredRecommendations.length === 0 ? (
                      <p className="text-[11px] text-muted">暂无符合条件的推荐点位。</p>
                    ) : filteredRecommendations.map((target) => (
                      <RecommendationRow
                        key={target.id}
                        poi={target}
                        saved={favorites.some((entry) => samePoi(entry.poi, target)) || localFavoriteKeys.has(poiKey(target))}
                        stashed={stash.some((entry) => samePoi(entry.poi, target))}
                        onSelect={() => setSelectedRecommendationId(target.id)}
                        onFavorite={() => void toggleFavoritePoi(target)}
                        onStash={() => void stashRecommendation(target)}
                        onSchedule={() => void scheduleRecommendation(target, stash.find((entry) => samePoi(entry.poi, target))?.id)}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {selectedRecommendation && (
            <div data-recommendation-detail className="pointer-events-auto mb-[6px] rounded-[7px] border border-green/30 bg-white/95 p-[8px] shadow-lg">
              <div className="flex items-start gap-[6px]">
                <div className="min-w-0 flex-1">
                  <p data-recommendation-detail-name className="truncate text-[12px] font-[600]">{selectedRecommendation.name}</p>
                  <p className="mt-[2px] text-[10px] text-muted">{selectedRecommendation.region || '沿途'} · {selectedRecommendation.category || recommendationTypeLabel(selectedRecommendation.type)}</p>
                </div>
                <button type="button" data-action="recommendation-detail-close" aria-label="关闭推荐详情" onClick={() => setSelectedRecommendationId(null)} className="grid h-[20px] w-[20px] place-items-center rounded-[4px] text-muted hover:text-ink"><X className="h-[12px]" /></button>
              </div>
              {selectedRecommendation.introSummary && <p className="mt-[5px] text-[11px] leading-[1.5] text-muted">{selectedRecommendation.introSummary}</p>}
              <div className="mt-[7px] flex items-center gap-[5px]">
                <select
                  data-action="recommendation-day-select"
                  aria-label="加入哪一天"
                  value={selectedDayId}
                  onChange={(event) => setSelectedDayId(event.target.value)}
                  className="min-w-0 flex-1 rounded-[4px] border border-line bg-white px-[5px] py-[3px] text-[10px] text-muted"
                >
                  {days.map((day) => <option key={day.id} value={day.id}>D{day.index + 1} {day.theme || day.date}</option>)}
                </select>
                <button type="button" data-action="recommendation-add" onClick={() => void scheduleRecommendation(selectedRecommendation, selectedRecommendationStash?.id)} className="rounded-[4px] bg-green px-[7px] py-[4px] text-[10px] text-white disabled:opacity-40" disabled={!selectedDayId || !onSchedulePoi}>加入行程</button>
                <button type="button" data-action="recommendation-favorite" aria-pressed={Boolean(selectedFavorite) || localFavoriteKeys.has(poiKey(selectedRecommendation))} onClick={() => void toggleFavoritePoi(selectedRecommendation)} className={`grid h-[24px] w-[24px] place-items-center rounded-[4px] border ${selectedFavorite || localFavoriteKeys.has(poiKey(selectedRecommendation)) ? 'border-[#b75342] text-[#b75342]' : 'border-line text-muted'}`} title={selectedFavorite || localFavoriteKeys.has(poiKey(selectedRecommendation)) ? '取消收藏' : '收藏'} aria-label={selectedFavorite || localFavoriteKeys.has(poiKey(selectedRecommendation)) ? '取消收藏' : '收藏'}><Heart className="h-[12px]" /></button>
              </div>
            </div>
          )}

          <div data-map-tool-bar className="pointer-events-auto ml-[44px] inline-flex w-fit max-w-[calc(100%-44px)] items-center gap-[5px] rounded-[7px] border border-line bg-white/95 p-[5px] shadow-md backdrop-blur-sm">
            <button type="button" data-action="map-recommend-toggle" aria-pressed={recommendationsEnabled} onClick={() => { setRecommendationsEnabled((current) => !current); setRecommendationPanel(null) }} className={`flex items-center gap-[4px] rounded-[5px] border px-[7px] py-[4px] text-[11px] ${recommendationsEnabled ? 'border-green bg-green text-white' : 'border-line text-muted hover:border-green'}`}><Search className="h-[12px]" />推荐</button>
            <button type="button" data-action="map-stash-toggle" aria-pressed={recommendationPanel === 'stash'} onClick={() => toggleRecommendationPanel('stash')} className={`flex items-center gap-[4px] rounded-[5px] border px-[7px] py-[4px] text-[11px] ${recommendationPanel === 'stash' ? 'border-green bg-green text-white' : 'border-line text-muted hover:border-green'}`}><Bookmark className="h-[12px]" />待计划 <span className="text-[10px]">{stash.length}</span></button>
            <button type="button" data-action="map-favorites-toggle" aria-pressed={recommendationPanel === 'favorites'} onClick={() => toggleRecommendationPanel('favorites')} className={`flex items-center gap-[4px] rounded-[5px] border px-[7px] py-[4px] text-[11px] ${recommendationPanel === 'favorites' ? 'border-green bg-green text-white' : 'border-line text-muted hover:border-green'}`}><Heart className="h-[12px]" />收藏 <span className="text-[10px]">{favorites.length}</span></button>
          </div>
        </section>
      </div>
    </div>
  )
}

function viewDropdownLabel(days: WorkbenchDay[], dayId: string): string {
  const day = days.find((candidate) => candidate.id === dayId)
  if (!day) return '总览'
  const date = dayDateLabel(day.date) || `D${day.index + 1}`
  return `${date} ${day.theme || ''}`.trim()
}

function samePoi(a: Pick<RecommendationPoi, 'amapId' | 'id' | 'name' | 'lat' | 'lng'>, b: Pick<RecommendationPoi, 'amapId' | 'id' | 'name' | 'lat' | 'lng'>): boolean {
  return Boolean(
    (a.amapId && b.amapId && a.amapId === b.amapId) ||
      (a.id && b.id && a.id === b.id) ||
      (a.name === b.name && a.lat === b.lat && a.lng === b.lng),
  )
}

function poiKey(poi: Pick<RecommendationPoi, 'amapId' | 'name' | 'lat' | 'lng'> & { id?: string }): string {
  return poi.amapId || poi.id || `${poi.name}|${poi.lat}|${poi.lng}`
}

function recommendationFromItem(poi: NonNullable<WorkbenchItem['poi']>, title: string): RecommendationPoi {
  return {
    id: poi.amapId || poi.name,
    amapId: poi.amapId,
    name: poi.name || title,
    lat: poi.lat,
    lng: poi.lng,
    category: poi.category,
    type: poi.category.includes('餐') ? 'food' : poi.category.includes('住') || poi.category.includes('酒店') ? 'stay' : 'attraction',
    region: '',
    rating: poi.rating,
    introSummary: poi.introSummary,
    address: '',
    images: [],
  }
}

function RecommendationRow({
  poi,
  saved,
  stashed,
  onSelect,
  onFavorite,
  onStash,
  onSchedule,
}: {
  poi: RecommendationPoi
  saved: boolean
  stashed: boolean
  onSelect: () => void
  onFavorite: () => void
  onStash: () => void
  onSchedule: () => void
}) {
  return (
    <div data-recommendation={poi.id} className="flex items-center gap-[5px] rounded-[5px] border border-line px-[6px] py-[5px]">
      <button type="button" data-action="recommendation-select" onClick={onSelect} className="min-w-0 flex-1 text-left">
        <span className="block truncate text-[11px] font-[550] text-ink">{poi.name}</span>
        <span className="block truncate text-[10px] text-muted">{poi.region || poi.category || recommendationTypeLabel(poi.type)}</span>
      </button>
      <button type="button" data-action="recommendation-schedule" onClick={onSchedule} className="rounded-[4px] bg-green px-[5px] py-[3px] text-[10px] text-white">加入</button>
      <button type="button" data-action="recommendation-favorite" aria-pressed={saved} onClick={onFavorite} className={`grid h-[22px] w-[22px] place-items-center rounded-[4px] border ${saved ? 'border-[#b75342] text-[#b75342]' : 'border-line text-muted'}`} title={saved ? '取消收藏' : '收藏'} aria-label={saved ? '取消收藏' : '收藏'}><Heart className="h-[11px]" /></button>
      {!stashed && <button type="button" data-action="recommendation-stash" onClick={onStash} className="grid h-[22px] w-[22px] place-items-center rounded-[4px] border border-line text-muted" title="加入待计划" aria-label="加入待计划"><Bookmark className="h-[11px]" /></button>}
    </div>
  )
}

function StashRow({
  item,
  onSelect,
  onRemove,
  onSchedule,
}: {
  item: StashItem
  onSelect: () => void
  onRemove: () => void
  onSchedule: () => void
}) {
  return (
    <div
      data-stash-item={item.id}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData('application/x-stash', JSON.stringify(item))
        event.dataTransfer.setData('text/plain', `stash:${item.id}`)
        event.dataTransfer.effectAllowed = 'copy'
      }}
      className="flex items-center gap-[5px] rounded-[5px] border border-line px-[6px] py-[5px]"
    >
      <button type="button" data-action="stash-select" onClick={onSelect} className="min-w-0 flex-1 truncate text-left text-[11px] font-[550]">{item.poi.name}</button>
      <button type="button" data-action="stash-schedule" onClick={onSchedule} className="rounded-[4px] bg-green px-[5px] py-[3px] text-[10px] text-white">加入</button>
      <button type="button" data-action="stash-remove" aria-label="移出待计划" onClick={onRemove} className="grid h-[22px] w-[22px] place-items-center rounded-[4px] border border-line text-muted"><X className="h-[11px]" /></button>
    </div>
  )
}

function FavoriteRow({
  item,
  onSelect,
  onRemove,
  onSchedule,
}: {
  item: FavoriteItem
  onSelect: () => void
  onRemove: () => void
  onSchedule: () => void
}) {
  return (
    <div data-favorite-item={item.id} className="flex items-center gap-[5px] rounded-[5px] border border-line px-[6px] py-[5px]">
      <button type="button" data-action="favorite-select" onClick={onSelect} className="min-w-0 flex-1 truncate text-left text-[11px] font-[550]">{item.poi.name}</button>
      <button type="button" data-action="favorite-schedule" onClick={onSchedule} className="rounded-[4px] bg-green px-[5px] py-[3px] text-[10px] text-white">加入</button>
      <button type="button" data-action="favorite-remove" aria-label="取消收藏" onClick={onRemove} className="grid h-[22px] w-[22px] place-items-center rounded-[4px] border border-line text-[#b75342]"><Heart className="h-[11px]" /></button>
    </div>
  )
}
