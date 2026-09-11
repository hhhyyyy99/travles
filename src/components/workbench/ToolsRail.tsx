/**
 * 工具入口 (ticket 14) — slim vertical rail on the canvas's left edge
 * (PRD F11: 画布左侧竖排), one icon button per dockable panel. Clicking the
 * active tool again closes the panel (aria-pressed tracks the open state).
 */
import { StickyNote, ListChecks, Images } from 'lucide-react'
import type { ToolPanelId } from '../../domain/workbenchTools'

const TOOLS: Array<{ id: ToolPanelId; label: string; icon: React.ReactNode }> = [
  { id: 'notes', label: '便签', icon: <StickyNote aria-hidden="true" className="w-[16px]" /> },
  { id: 'checklist', label: '清单', icon: <ListChecks aria-hidden="true" className="w-[16px]" /> },
  { id: 'gallery', label: '图库', icon: <Images aria-hidden="true" className="w-[16px]" /> },
]

export default function ToolsRail({
  active,
  onToggle,
}: {
  active: ToolPanelId | null
  onToggle: (panel: ToolPanelId) => void
}) {
  return (
    <div
      id="tools-rail"
      role="toolbar"
      aria-label="行程工具"
      className="flex w-[44px] shrink-0 flex-col items-center gap-[8px] border-r border-line bg-white py-[10px]"
    >
      {TOOLS.map((tool) => (
        <button
          key={tool.id}
          type="button"
          data-tool={tool.id}
          data-tool-active={active === tool.id || undefined}
          title={active === tool.id ? `收起${tool.label}` : `展开${tool.label}`}
          aria-label={active === tool.id ? `收起${tool.label}面板` : `展开${tool.label}面板`}
          aria-pressed={active === tool.id}
          onClick={() => onToggle(tool.id)}
          className={`grid h-[30px] w-[30px] place-items-center rounded-[5px] border transition-colors ${
            active === tool.id
              ? 'border-green bg-green/10 text-green'
              : 'border-line text-muted hover:border-green hover:text-green'
          }`}
        >
          {tool.icon}
        </button>
      ))}
      <span className="mt-[2px] text-[11px] text-muted [writing-mode:vertical-rl]">工具</span>
    </div>
  )
}
