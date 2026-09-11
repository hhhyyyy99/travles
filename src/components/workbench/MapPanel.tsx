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
import { ChevronLeft, ChevronRight, Crosshair, Heart, Map as MapIcon, Maximize2, PanelRightClose, Star, X } from 'lucide-react'
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
  dayRouteSegments,
  formatMileageLabel,
  hiddenByCollision,
  poiMarkersForDays,
  tripFitCoordinates,
} from '../../domain/workbenchMap'
import { searchUrl } from '../../services/navigationUrl'
import { useRouteMap } from '../../hooks/useRouteMap'
import {
  fitWorkbenchCoordinates,
  focusWorkbenchPoi,
  renderWorkbenchPois,
  renderWorkbenchRoutes,
  type WorkbenchRouteDay,
} from '../../services/workbenchMap'

export interface MapPanelProps {
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
}

function findSelectedItem(days: WorkbenchDay[], itemId: string | null): { item: WorkbenchItem; day: WorkbenchDay } | null {
  if (!itemId) return null
  for (const day of days) {
    const item = day.items.find((candidate) => candidate.id === itemId)
    if (item) return { item, day }
  }
  return null
}

export default function MapPanel({ days, legs, selectedItemId, onSelectItem, onCollapse, focus }: MapPanelProps) {
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
  const [favorites, setFavorites] = useState<Set<string>>(new Set())
  const onSelectItemRef = useRef(onSelectItem)
  onSelectItemRef.current = onSelectItem

  const selected = findSelectedItem(days, selectedItemId)
  const poi = selected?.item.poi ?? null
  const hasDetail = selected !== null && poi !== null

  const routes = useMemo<WorkbenchRouteDay[]>(
    () =>
      days.map((day) => ({
        dayId: day.id,
        color: dayAccentColor(day.color, day.index),
        segments: dayRouteSegments(day, legs),
        mileageLabel: formatMileageLabel(day, dayMileageKm(day, legs)),
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

  // Canvas card click → focus the POI. Marker clicks flow through the same
  // state, so the map follows the canvas in both directions.
  useEffect(() => {
    const handle = handleRef.current
    if (!handle || !selected || !poi) return
    setCarouselIndex(0)
    focusWorkbenchPoi(handle, [poi.lat, poi.lng])
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
  useEffect(() => {
    const handle = handleRef.current
    if (!handle || !focus) return
    focusWorkbenchPoi(handle, [focus.lat, focus.lng])
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
    if (day && handle) fitWorkbenchCoordinates(handle, dayFitCoordinates(day, legs))
  }

  const images = selected?.item.images ?? []
  const favoriteActive = selectedItemId !== null && favorites.has(selectedItemId)

  return (
    <div className="flex h-full flex-col">
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
          <aside id="workbench-poi-detail" data-poi-detail={selected.item.id} className="absolute inset-x-[8px] bottom-[8px] z-[600] rounded-[8px] border border-line bg-white p-[12px] shadow-lg">
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

            <div className="mt-[10px] flex items-center gap-[8px]">
              <button
                type="button"
                data-action="poi-favorite"
                aria-pressed={favoriteActive}
                onClick={() =>
                  setFavorites((current) => {
                    const next = new Set(current)
                    if (selectedItemId === null) return next
                    if (next.has(selectedItemId)) next.delete(selectedItemId)
                    else next.add(selectedItemId)
                    return next
                  })
                }
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
