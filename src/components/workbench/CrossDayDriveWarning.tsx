import { AlertTriangle } from 'lucide-react'
import { legQuality, type CrossDayTransfer } from '../../domain/workbench'

export default function CrossDayDriveWarning({ warning }: { warning: CrossDayTransfer }) {
  const estimated = warning.estimated || legQuality(warning.leg) !== 'measured'
  return (
    <aside
      data-cross-day-warning={warning.id}
      role="note"
      className="flex w-[230px] shrink-0 self-center flex-col gap-[5px] rounded-[8px] border border-[#b75342]/45 bg-[#fff5f2] px-[10px] py-[9px] text-[11px] text-[#7e3c32]"
    >
      <div className="flex items-center gap-[5px] font-[600]">
        <AlertTriangle aria-hidden="true" className="w-[13px] shrink-0" />
        <span className="whitespace-nowrap">{estimated ? '跨天驾车估算' : '跨天长途驾驶'}</span>
      </div>
      <p className="break-words leading-[1.45]">{warning.fromTitle} → {warning.toTitle}</p>
      <p className="leading-[1.45]">{estimated ? '约 ' : ''}{trimNumber(warning.distanceKm)} 千米 · {formatDuration(warning.durationMin)}，超过 6 小时</p>
      <p className="text-[#96665d] leading-[1.45]">{estimated ? '坐标估算，未核实实际路况。' : '路线服务已返回结果。'}建议拆成两段，增加中途休息或过夜点。</p>
    </aside>
  )
}

function trimNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, '')
}

function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const rest = Math.round(minutes % 60)
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`
}
