/**
 * 左栏 AI 对话占位 (ticket 04) — an explicit empty state; the real chat lands
 * in ticket 06. The header carries the column's collapse control.
 */
import { MessageCircle, PanelLeftClose } from 'lucide-react'

export default function ChatPanelPlaceholder({ onCollapse }: { onCollapse: () => void }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-[8px] border-b border-line px-[14px] py-[10px] text-[13px] font-[550]">
        <MessageCircle aria-hidden="true" className="w-[15px] text-green" />
        圆周 AI
        <button
          type="button"
          data-action="collapse-ai"
          title="收起 AI 栏"
          aria-label="收起 AI 栏"
          onClick={onCollapse}
          className="ml-auto grid h-[28px] w-[28px] place-items-center rounded-[5px] border border-line text-muted hover:border-green hover:text-green transition-colors"
        >
          <PanelLeftClose aria-hidden="true" className="w-[14px]" />
        </button>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-[10px] px-[24px] text-center">
        <MessageCircle aria-hidden="true" className="w-[34px] text-line" />
        <p className="text-[13px] text-muted leading-[1.8]">
          和圆周说一句话，一起规划这段旅程。
          <br />
          对话能力即将到来。
        </p>
      </div>
    </div>
  )
}
