/**
 * 右栏地图占位 (ticket 04; ticket 07 adds the POI-focus prop) — an explicit
 * empty state; route rendering lands in ticket 05. The header carries the
 * column's collapse control.
 *
 * ## POI-focus contract (ticket 07 → ticket 05)
 * The workbench owns the focus state; ChatPanel raises it via its
 * `onFocusPoi` prop when a POI link inside an AI message is clicked, and the
 * target (`{name, lat, lng, amapId?}` — same shape as the SSE meta payload's
 * `poiLinks` entries, see src/domain/chat.ts) is passed down here as `focus`.
 * Ticket 05's MapPanel should take the same prop and center the map on the
 * point + open the POI detail card; this placeholder surfaces the target in
 * the DOM (`data-map-focus` on #map-focus-target) and logs to the console so
 * the wiring stays testable before the real map exists.
 */
import { useEffect } from 'react'
import { MapPin, Map as MapIcon, PanelRightClose } from 'lucide-react'
import type { ChatPoiLink } from '../../domain/chat'

export default function MapPanelPlaceholder({
  onCollapse,
  focus,
}: {
  onCollapse: () => void
  focus?: ChatPoiLink | null
}) {
  useEffect(() => {
    if (focus) console.info('[map] focus poi (ticket 05 will render this):', focus)
  }, [focus])

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
      {focus != null && (
        <div
          id="map-focus-target"
          data-map-focus={focus.name}
          data-map-focus-lat={focus.lat}
          data-map-focus-lng={focus.lng}
          {...(focus.amapId ? { 'data-map-focus-amap-id': focus.amapId } : {})}
          className="mx-[12px] mt-[12px] flex items-center gap-[8px] rounded-[6px] border border-green/30 bg-green/5 px-[10px] py-[8px] text-[12px] text-ink"
        >
          <MapPin aria-hidden="true" className="w-[14px] shrink-0 text-green" />
          <span>
            地图将定位到：<span className="font-[550]">{focus.name}</span>
          </span>
        </div>
      )}
      <div className="flex flex-1 flex-col items-center justify-center gap-[10px] px-[24px] text-center">
        <MapIcon aria-hidden="true" className="w-[34px] text-line" />
        <p className="text-[13px] text-muted leading-[1.8]">
          按日着色的驾车路线
          <br />
          将在这里显示。
        </p>
      </div>
    </div>
  )
}
