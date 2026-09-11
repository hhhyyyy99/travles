/**
 * 工作台三栏骨架 (ticket 04; ticket 10 adds the canvas/list view toggle and
 * day management) — left AI chat (placeholder), center trip canvas or
 * single-day list, right map (placeholder). Each column collapses
 * independently; the AI column is drag-resizable via the edge handle; all
 * collapse/width state — and now the center view choice — is remembered per
 * trip through useWorkbenchLayout.
 *
 * Both center views are a pure projection of GET /api/trips/:id/canvas.
 * Day add/delete/theme-edit write through the ticket-10 day-admin routes;
 * theme edits and deletes update the local state optimistically and roll
 * back on failure (spec user story 41).
 */
import { useEffect, useRef, useState } from 'react'
import { LayoutGrid, List, MessageCircle, Map as MapIcon, PanelLeftClose, Sparkles } from 'lucide-react'
import {
  createWorkbenchDay,
  deleteWorkbenchDay,
  fetchTripCanvas,
  updateWorkbenchDay,
  type TripCanvasData,
  type WorkbenchDay,
} from '../../domain/workbench'
import type { ChatPoiLink } from '../../domain/chat'
import { AI_WIDTH_MAX, AI_WIDTH_MIN } from '../../domain/workbenchLayout'
import type { WorkbenchView } from '../../domain/workbenchLayout'
import { useWorkbenchLayout } from '../../hooks/useWorkbenchLayout'
import { useToolsPanel } from '../../hooks/useToolsPanel'
import WorkbenchTopbar from './WorkbenchTopbar'
import CanvasColumn from './CanvasColumn'
import ChatPanel from './ChatPanel'
import ListViewColumn from './ListViewColumn'
import ConfirmDialog from './ConfirmDialog'
import MapPanel from './MapPanel'
import ToolsRail from './ToolsRail'
import ToolsPanel from './ToolsPanel'

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; data: TripCanvasData }

export default function WorkbenchPage({ tripId, onBack }: { tripId: string; onBack: () => void }) {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  // Canvas ↔ map linkage (ticket 05): one shared selection — canvas card
  // clicks focus the map POI, map marker clicks highlight + scroll the canvas.
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null)
  const { layout, toggle, resizeAi, setView } = useWorkbenchLayout(tripId)
  const { open: toolsOpen, toggle: toggleTools, close: closeTools } = useToolsPanel(tripId)
  const [actionError, setActionError] = useState('')
  const [pendingDelete, setPendingDelete] = useState<WorkbenchDay | null>(null)
  // Ticket 07: POI focus target raised by the chat panel's inline POI links.
  // The map panel receives it as a prop and centers/opens the POI detail;
  // the placeholder logs it until ticket 05's real panel lands.
  const [mapFocus, setMapFocus] = useState<ChatPoiLink | null>(null)

  // Latest ready data for async handlers (avoids stale-closure rollbacks).
  const readyData = state.status === 'ready' ? state.data : null
  const dataRef = useRef<TripCanvasData | null>(readyData)
  dataRef.current = readyData

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    setActionError('')
    setSelectedItemId(null)
    void fetchTripCanvas(tripId).then((result) => {
      if (cancelled) return
      if (result.ok) setState({ status: 'ready', data: result.data })
      else setState({ status: 'error', error: result.error })
    })
    return () => {
      cancelled = true
    }
  }, [tripId])

  /** Local day-list patch on the ready state (no-op when not ready). */
  const patchDays = (update: (days: WorkbenchDay[]) => WorkbenchDay[]) => {
    setState((prev) =>
      prev.status === 'ready' ? { ...prev, data: { ...prev.data, days: update(prev.data.days) } } : prev,
    )
  }

  // ---- AI plan round (ticket 08) ---------------------------------------------
  // The chat panel calls this when an `applied_patch` SSE event arrives: the
  // trip changed server-side, so refetch /canvas and reproject all columns.
  const handleTripPatched = () => {
    void fetchTripCanvas(tripId).then((result) => {
      if (result.ok) setState({ status: 'ready', data: result.data })
      // Refetch failures keep the current canvas — the chat card still reports
      // the write; a manual refresh recovers.
    })
  }

  // ---- Day management (ticket 10) -------------------------------------------

  /** Append a day; the server answers with the created day (next date). */
  const handleAddDay = async () => {
    setActionError('')
    const result = await createWorkbenchDay(tripId)
    if (!result.ok) {
      setActionError(result.error)
      return
    }
    patchDays((days) => [...days, result.data].sort((a, b) => a.index - b.index))
  }

  /** Optimistic theme edit; reverts the day's theme when the write fails. */
  const handleThemeSave = async (dayId: string, theme: string) => {
    const previous = dataRef.current?.days.find((day) => day.id === dayId)?.theme ?? ''
    setActionError('')
    patchDays((days) => days.map((day) => (day.id === dayId ? { ...day, theme } : day)))
    const result = await updateWorkbenchDay(tripId, dayId, { theme })
    if (!result.ok) {
      patchDays((days) => days.map((day) => (day.id === dayId ? { ...day, theme: previous } : day)))
      setActionError(result.error)
    }
  }

  /** Optimistic day delete; restores the whole day (with its cards) on failure. */
  const handleDeleteDay = (day: WorkbenchDay) => setPendingDelete(day)

  const confirmDeleteDay = async () => {
    const day = pendingDelete
    if (!day) return
    setPendingDelete(null)
    const snapshot = dataRef.current
    setActionError('')
    patchDays((days) => days.filter((entry) => entry.id !== day.id))
    const result = await deleteWorkbenchDay(tripId, day.id)
    if (!result.ok) {
      if (snapshot) setState({ status: 'ready', data: snapshot })
      setActionError(result.error)
    }
  }

  const pendingDeleteLabel = pendingDelete
    ? `${pendingDelete.date ? pendingDelete.date : `D${pendingDelete.index + 1}`}${pendingDelete.theme ? ` ${pendingDelete.theme}` : ''}`
    : ''

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
              <ChatPanel tripId={tripId} onCollapse={() => toggle('ai')} onFocusPoi={setMapFocus} onTripPatched={handleTripPatched} />
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
              <ViewToggle view={layout.view} onChange={setView} />
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
            {actionError && (
              <p data-workbench-action-error className="shrink-0 bg-[#fdf3f1] px-[14px] py-[6px] text-[12px] text-[#b75342]">
                {actionError}
              </p>
            )}
            {state.status === 'ready' ? (
              <div className="flex min-h-0 flex-1">
                {/* 画布左缘「工具」入口 + 停靠面板（ticket 14） */}
                <ToolsRail active={toolsOpen} onToggle={toggleTools} />
                {toolsOpen !== null && (
                  <ToolsPanel tripId={tripId} panel={toolsOpen} days={state.data.days} onClose={closeTools} />
                )}
                {layout.view === 'list' ? (
                  <ListViewColumn
                    days={state.data.days}
                    legs={state.data.legs}
                    onAddDay={handleAddDay}
                    onThemeSave={handleThemeSave}
                    onDeleteDay={handleDeleteDay}
                  />
                ) : (
                  <CanvasColumn
                    days={state.data.days}
                    legs={state.data.legs}
                    onAddDay={handleAddDay}
                    onThemeSave={handleThemeSave}
                    onDeleteDay={handleDeleteDay}
                    onCardClick={setSelectedItemId}
                    highlightItemId={selectedItemId}
                  />
                )}
              </div>
            ) : (
              <div className="grid flex-1 place-items-center text-[13px] text-muted">
                {state.status === 'loading' ? '加载行程中…' : state.error}
              </div>
            )}
          </div>
        )}

        {/* 右栏 地图 —— 可收起（ticket 05：真实路线投影 + 画布联动） */}
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
            <MapPanel
              days={state.status === 'ready' ? state.data.days : []}
              legs={state.status === 'ready' ? state.data.legs : []}
              selectedItemId={selectedItemId}
              onSelectItem={setSelectedItemId}
              onCollapse={() => toggle('map')}
              focus={mapFocus}
            />
          </div>
        )}
      </div>

      {/* 删天确认（ticket 10）——明确提示该天的卡片会一并删除 */}
      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除这一天？"
        message={
          pendingDelete
            ? `确定删除「${pendingDeleteLabel}」吗？这一天内的 ${pendingDelete.items.length} 张卡片会一并删除，且无法撤销。`
            : ''
        }
        onConfirm={confirmDeleteDay}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  )
}

/** 画布 / 列表 二态切换器（ticket 10），选择按行程记忆。 */
function ViewToggle({ view, onChange }: { view: WorkbenchView; onChange: (view: WorkbenchView) => void }) {
  return (
    <span id="workbench-view-toggle" className="ml-[12px] flex items-center gap-[2px] rounded-[6px] border border-line p-[2px]">
      <button
        type="button"
        data-action="view-canvas"
        aria-pressed={view === 'canvas'}
        title="画布视图"
        onClick={() => onChange('canvas')}
        className={`flex h-[24px] items-center gap-[4px] rounded-[4px] px-[8px] text-[12px] transition-colors ${
          view === 'canvas' ? 'bg-green text-white' : 'text-muted hover:text-ink'
        }`}
      >
        <LayoutGrid aria-hidden="true" className="w-[13px]" />
        画布
      </button>
      <button
        type="button"
        data-action="view-list"
        aria-pressed={view === 'list'}
        title="列表视图"
        onClick={() => onChange('list')}
        className={`flex h-[24px] items-center gap-[4px] rounded-[4px] px-[8px] text-[12px] transition-colors ${
          view === 'list' ? 'bg-green text-white' : 'text-muted hover:text-ink'
        }`}
      >
        <List aria-hidden="true" className="w-[13px]" />
        列表
      </button>
    </span>
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
