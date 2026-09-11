/**
 * 工作台三栏骨架 (ticket 04) — left AI chat (placeholder), center trip canvas
 * (read-only), right map (placeholder). Each column collapses independently;
 * the AI column is drag-resizable via the edge handle; all collapse/width
 * state is remembered per trip through useWorkbenchLayout.
 *
 * The canvas is a pure projection of GET /api/trips/:id/canvas — no local
 * editing in this ticket (drag/editing is ticket 09, map rendering 05, chat 06).
 */
import { useEffect, useRef, useState } from 'react'
import { MessageCircle, Map as MapIcon, PanelLeftClose, Sparkles } from 'lucide-react'
import { fetchTripCanvas, type TripCanvasData } from '../../domain/workbench'
import { AI_WIDTH_MAX, AI_WIDTH_MIN } from '../../domain/workbenchLayout'
import { useWorkbenchLayout } from '../../hooks/useWorkbenchLayout'
import WorkbenchTopbar from './WorkbenchTopbar'
import CanvasColumn from './CanvasColumn'
import ChatPanelPlaceholder from './ChatPanelPlaceholder'
import MapPanelPlaceholder from './MapPanelPlaceholder'

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; data: TripCanvasData }

export default function WorkbenchPage({ tripId, onBack }: { tripId: string; onBack: () => void }) {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const { layout, toggle, resizeAi } = useWorkbenchLayout(tripId)

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    void fetchTripCanvas(tripId).then((result) => {
      if (cancelled) return
      if (result.ok) setState({ status: 'ready', data: result.data })
      else setState({ status: 'error', error: result.error })
    })
    return () => {
      cancelled = true
    }
  }, [tripId])

  return (
    <div className="flex h-screen min-h-0 flex-col bg-paper text-ink">
      {state.status === 'ready' && <WorkbenchTopbar trip={state.data.trip} onBack={onBack} />}
      {state.status !== 'ready' && (
        <header className="flex h-[60px] shrink-0 items-center gap-[16px] border-b border-line bg-white px-[16px]">
          <button
            id="workbench-back"
            type="button"
            title="返回行程列表"
            aria-label="返回行程列表"
            onClick={onBack}
            className="grid h-[36px] w-[36px] place-items-center rounded-[5px] border border-line text-muted hover:border-green hover:text-green transition-colors"
          >
            ←
          </button>
          {state.status === 'loading' && <span className="text-[13px] text-muted">加载行程中…</span>}
          {state.status === 'error' && (
            <span id="workbench-load-error" className="text-[13px] text-red">
              {state.error}
            </span>
          )}
        </header>
      )}

      <div className="flex min-h-0 flex-1">
        {/* 左栏 AI —— 可拖拽调宽、可收起 */}
        {layout.aiCollapsed ? (
          <CollapsedRail
            id="workbench-rail-ai"
            label="圆周 AI"
            icon={<MessageCircle aria-hidden="true" className="w-[16px]" />}
            onExpand={() => toggle('ai')}
          />
        ) : (
          <>
            <div
              id="workbench-column-ai"
              className="flex shrink-0 flex-col border-r border-line bg-white"
              style={{ width: layout.aiWidth }}
            >
              <ChatPanelPlaceholder onCollapse={() => toggle('ai')} />
            </div>
            <AiResizeHandle width={layout.aiWidth} onResize={resizeAi} />
          </>
        )}

        {/* 中栏 行程画布 —— 可收起 */}
        {layout.canvasCollapsed ? (
          <CollapsedRail
            id="workbench-rail-canvas"
            label="行程画布"
            icon={<Sparkles aria-hidden="true" className="w-[16px]" />}
            onExpand={() => toggle('canvas')}
          />
        ) : (
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center border-b border-line bg-white px-[14px] py-[8px] text-[13px] font-[550]">
              行程画布
              <button
                type="button"
                data-action="collapse-canvas"
                title="收起画布栏"
                aria-label="收起画布栏"
                onClick={() => toggle('canvas')}
                className="ml-auto grid h-[28px] w-[28px] place-items-center rounded-[5px] border border-line text-muted hover:border-green hover:text-green transition-colors"
              >
                <PanelLeftClose aria-hidden="true" className="w-[14px]" />
              </button>
            </div>
            {state.status === 'ready' ? (
              <CanvasColumn days={state.data.days} legs={state.data.legs} />
            ) : (
              <div className="grid flex-1 place-items-center text-[13px] text-muted">
                {state.status === 'loading' ? '加载行程中…' : state.error}
              </div>
            )}
          </div>
        )}

        {/* 右栏 地图 —— 可收起（渲染留给 ticket 05） */}
        {layout.mapCollapsed ? (
          <CollapsedRail
            id="workbench-rail-map"
            label="路线地图"
            icon={<MapIcon aria-hidden="true" className="w-[16px]" />}
            onExpand={() => toggle('map')}
          />
        ) : (
          <div
            id="workbench-column-map"
            className="flex w-[320px] shrink-0 flex-col border-l border-line bg-white"
          >
            <MapPanelPlaceholder onCollapse={() => toggle('map')} />
          </div>
        )}
      </div>
    </div>
  )
}

/** Slim vertical rail standing in for a collapsed column. */
function CollapsedRail({
  id,
  label,
  icon,
  onExpand,
}: {
  id: string
  label: string
  icon: React.ReactNode
  onExpand: () => void
}) {
  return (
    <div id={id} className="flex w-[44px] shrink-0 flex-col items-center gap-[10px] border-r border-line bg-white py-[12px]">
      <button
        type="button"
        data-action="expand"
        title={`展开${label}`}
        aria-label={`展开${label}`}
        onClick={onExpand}
        className="grid h-[30px] w-[30px] place-items-center rounded-[5px] border border-line text-muted hover:border-green hover:text-green transition-colors"
      >
        {icon}
      </button>
      <span className="text-[11px] text-muted [writing-mode:vertical-rl]">{label}</span>
    </div>
  )
}

/** Drag handle on the AI column's right edge (drag-resizable, clamped). */
function AiResizeHandle({ width, onResize }: { width: number; onResize: (width: number) => void }) {
  const startX = useRef(0)
  const startWidth = useRef(0)
  const [dragging, setDragging] = useState(false)

  return (
    <div
      id="workbench-ai-resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="拖拽调整 AI 栏宽度"
      onPointerDown={(event) => {
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        startX.current = event.clientX
        startWidth.current = width
        setDragging(true)
      }}
      onPointerMove={(event) => {
        if (!dragging) return
        onResize(startWidth.current + (event.clientX - startX.current))
      }}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
      className={`w-[5px] shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-green/30 ${
        dragging ? 'bg-green/40' : ''
      }`}
    />
  )
}

// Layout clamp bounds re-exported for tests/docs parity.
export { AI_WIDTH_MIN, AI_WIDTH_MAX }
