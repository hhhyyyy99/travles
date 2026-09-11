/**
 * 右栏地图占位 (ticket 04) — an explicit empty state; route rendering lands in
 * ticket 05. The header carries the column's collapse control.
 */
import { Map as MapIcon, PanelRightClose } from 'lucide-react'

export default function MapPanelPlaceholder({ onCollapse }: { onCollapse: () => void }) {
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
