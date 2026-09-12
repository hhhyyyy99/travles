/**
 * 工作台三栏骨架 (ticket 04; ticket 10 adds the canvas/list view toggle and
 * day management; ticket 09 adds card editing) — left AI chat, center trip
 * canvas or single-day list, right map. Each column collapses independently;
 * the AI column is drag-resizable via the edge handle; all collapse/width
 * state — and the center view choice — is remembered per trip through
 * useWorkbenchLayout.
 *
 * Both center views are a pure projection of GET /api/trips/:id/canvas.
 * Day management (ticket 10) and card editing (ticket 09) write through the
 * item-admin / day-admin routes with optimistic local updates: edits apply
 * immediately, the mutation response carries the recomputed legs (so the map
 * follows without a second read), and any failure restores the pre-edit
 * snapshot and surfaces the error (spec user stories 40/41).
 */
import { useEffect, useRef, useState } from 'react'
import { LayoutGrid, List, MessageCircle, Map as MapIcon, PanelLeftClose, Sparkles } from 'lucide-react'
import {
  applyItemInsert,
  applyItemMove,
  applyItemPatch,
  applyItemRemove,
  applyItemReplace,
  copyWorkbenchItem,
  createWorkbenchDay,
  createWorkbenchItem,
  deleteWorkbenchDay,
  deleteWorkbenchItem,
  fetchTripCanvas,
  moveWorkbenchItem,
  tempItemId,
  updateWorkbenchDay,
  updateWorkbenchItem,
  type TripCanvasData,
  type WorkbenchDay,
  type WorkbenchItem,
  type WorkbenchItemCreateInput,
} from '../../domain/workbench'
import type { ChatPoiLink } from '../../domain/chat'
import {
  applyAiProposal,
  cancelAiProposal,
  createAiProposal,
  type AiProposalState,
  type ProposalRequest,
} from '../../domain/aiProposals'
import { AI_WIDTH_MAX, AI_WIDTH_MIN } from '../../domain/workbenchLayout'
import type { WorkbenchView } from '../../domain/workbenchLayout'
import { useWorkbenchLayout } from '../../hooks/useWorkbenchLayout'
import { useToolsPanel } from '../../hooks/useToolsPanel'
import WorkbenchTopbar from './WorkbenchTopbar'
import AddCardDialog from './AddCardDialog'
import CanvasColumn from './CanvasColumn'
import ChatPanel from './ChatPanel'
import ListViewColumn from './ListViewColumn'
import ConfirmDialog from './ConfirmDialog'
import MapPanel from './MapPanel'
import ToolsRail from './ToolsRail'
import ToolsPanel from './ToolsPanel'
import { recommendationCardInput, removeFromStash, type RecommendationPoi } from '../../domain/recommendations'

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
  // 添加卡片弹窗 (ticket 09) — open for a specific day (day-column "+" or the
  // selected card's toolbar "添加").
  const [addCardDay, setAddCardDay] = useState<string | null>(null)
  // Ticket 13: one active proposal at a time. Generation is read-only; only
  // the explicit confirm action below calls the server apply route.
  const [proposalState, setProposalState] = useState<AiProposalState>({ status: 'idle' })

  // Latest ready data for async handlers (avoids stale-closure rollbacks).
  const readyData = state.status === 'ready' ? state.data : null
  const dataRef = useRef<TripCanvasData | null>(readyData)
  dataRef.current = readyData

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    setActionError('')
    setSelectedItemId(null)
    setProposalState({ status: 'idle' })
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

  const handleProposalRequest = async (request: ProposalRequest) => {
    if (proposalState.status === 'loading' || proposalState.status === 'applying') return
    setActionError('')
    setProposalState({ status: 'loading', request })
    const result = await createAiProposal(tripId, request)
    if (result.ok) setProposalState({ status: 'ready', request, proposal: result.data })
    else setProposalState({ status: 'error', request, error: result.error })
  }

  const handleProposalRetry = () => {
    if (proposalState.status !== 'error') return
    void handleProposalRequest(proposalState.request)
  }

  const handleProposalCancel = () => {
    const current = proposalState
    setProposalState({ status: 'idle' })
    if ('proposal' in current && current.proposal) {
      void cancelAiProposal(tripId, current.proposal.id)
    }
  }

  const handleProposalApply = async () => {
    if (proposalState.status !== 'ready') return
    const proposal = proposalState.proposal
    setProposalState({ status: 'applying', request: proposalState.request, proposal })
    const result = await applyAiProposal(tripId, proposal.id)
    if (result.ok) {
      setProposalState({ status: 'applied', record: result.data.appliedPatch })
      handleTripPatched()
    } else {
      setProposalState({ status: 'error', request: proposalState.request, error: result.error, proposal })
    }
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

  // ---- Card editing (ticket 09) ---------------------------------------------
  // Every edit is optimistic (spec user story 41): patch the local days
  // first, send the request, and on success adopt the recomputed legs from
  // the response (map follows without a second canvas read). Any failure
  // restores the pre-edit snapshot and shows the error — no silent loss.

  /** Replace the legs list on the ready state (map redraws from it). */
  const patchLegs = (legs: TripCanvasData['legs']) => {
    setState((prev) => (prev.status === 'ready' ? { ...prev, data: { ...prev.data, legs } } : prev))
  }

  /** Shared rollback: restore the snapshot and surface the server error. */
  const rollback = (snapshot: TripCanvasData | null, error: string) => {
    if (snapshot) setState({ status: 'ready', data: snapshot })
    setActionError(error)
  }

  const findItem = (days: WorkbenchDay[], itemId: string): WorkbenchItem | undefined =>
    days.flatMap((day) => day.items).find((item) => item.id === itemId)

  const handleMoveItem = async (itemId: string, toDayId: string, toIndex: number) => {
    const snapshot = dataRef.current
    setActionError('')
    patchDays((days) => applyItemMove(days, itemId, toDayId, toIndex))
    const result = await moveWorkbenchItem(tripId, itemId, { dayId: toDayId, index: toIndex })
    if (!result.ok) {
      rollback(snapshot, result.error)
      return
    }
    patchLegs(result.data.legs)
  }

  const handleCopyItem = async (itemId: string, toDayId: string, toIndex?: number) => {
    const snapshot = dataRef.current
    const source = snapshot ? findItem(snapshot.days, itemId) : undefined
    if (!source) return
    const temp: WorkbenchItem = { ...source, id: tempItemId('pending-copy'), dayId: toDayId, pending: true }
    setActionError('')
    patchDays((days) => applyItemInsert(days, temp, toDayId, toIndex))
    const result = await copyWorkbenchItem(tripId, itemId, { dayId: toDayId, index: toIndex })
    if (!result.ok) {
      rollback(snapshot, result.error)
      return
    }
    patchDays((days) => applyItemReplace(days, temp.id, result.data.item))
    patchLegs(result.data.legs)
  }

  const handleCreateCard = async (input: WorkbenchItemCreateInput): Promise<boolean> => {
    const snapshot = dataRef.current
    setAddCardDay(null)
    const temp: WorkbenchItem = {
      id: tempItemId('pending-add'),
      dayId: input.dayId,
      order: 0,
      type: input.type ?? 'other',
      title: input.title,
      note: input.note ?? '',
      poi: input.poi ?? null,
      images: input.images ?? [],
      pending: true,
    }
    setActionError('')
    patchDays((days) => applyItemInsert(days, temp, input.dayId, input.index))
    const result = await createWorkbenchItem(tripId, input)
    if (!result.ok) {
      rollback(snapshot, result.error)
      return false
    }
    patchDays((days) => applyItemReplace(days, temp.id, result.data.item))
    patchLegs(result.data.legs)
    return true
  }

  /** Schedule a recommendation/stash item through the same card API as manual adds. */
  const handleSchedulePoi = async (poi: RecommendationPoi, stashId?: string, dayId?: string, index?: number): Promise<boolean> => {
    const targetDayId = dayId ?? dataRef.current?.days[0]?.id
    if (!targetDayId) return false
    const created = await handleCreateCard(recommendationCardInput(poi, targetDayId, index))
    if (!created || !stashId) return created
    const removed = await removeFromStash(tripId, stashId)
    if (!removed.ok) {
      setActionError(removed.error)
      return false
    }
    return true
  }

  const handleDeleteItem = async (itemId: string) => {
    const snapshot = dataRef.current
    setActionError('')
    patchDays((days) => applyItemRemove(days, itemId))
    const result = await deleteWorkbenchItem(tripId, itemId)
    if (!result.ok) {
      rollback(snapshot, result.error)
      return
    }
    patchLegs(result.data.legs)
  }

  const handleNoteSave = async (itemId: string, note: string) => {
    const snapshot = dataRef.current
    setActionError('')
    patchDays((days) => applyItemPatch(days, itemId, { note }))
    const result = await updateWorkbenchItem(tripId, itemId, { note })
    if (!result.ok) {
      rollback(snapshot, result.error)
      return
    }
    // Server normalization (e.g. image captions) wins on field edits.
    patchDays((days) => applyItemPatch(days, itemId, result.data))
  }

  const handleImageAdd = async (itemId: string, url: string) => {
    const snapshot = dataRef.current
    const current = snapshot ? findItem(snapshot.days, itemId) : undefined
    if (!current) return
    const images = [...current.images, { url, caption: '' }]
    setActionError('')
    patchDays((days) => applyItemPatch(days, itemId, { images }))
    const result = await updateWorkbenchItem(tripId, itemId, { images })
    if (!result.ok) {
      rollback(snapshot, result.error)
      return
    }
    patchDays((days) => applyItemPatch(days, itemId, result.data))
  }

  return (
    <div className="flex h-screen min-h-0 flex-col bg-paper text-ink">
      {state.status === 'ready' && (
        <WorkbenchTopbar
          trip={state.data.trip}
          onBack={onBack}
          onOptimize={() => void handleProposalRequest({ kind: 'optimize' })}
          optimizing={proposalState.status === 'loading' && proposalState.request.kind === 'optimize'}
        />
      )}
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
              <ChatPanel
                tripId={tripId}
                onCollapse={() => toggle('ai')}
                onFocusPoi={setMapFocus}
                onTripPatched={handleTripPatched}
                proposalState={proposalState}
                onRequestProposal={(request) => void handleProposalRequest(request)}
                onApplyProposal={() => void handleProposalApply()}
                onCancelProposal={handleProposalCancel}
                onRetryProposal={handleProposalRetry}
              />
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
                    onOptimizeDay={(day) => void handleProposalRequest({ kind: 'day-optimize', dayId: day.id })}
                  />
                ) : (
                  <CanvasColumn
                    days={state.data.days}
                    legs={state.data.legs}
                    onAddDay={handleAddDay}
                    onThemeSave={handleThemeSave}
                    onDeleteDay={handleDeleteDay}
                    onOptimizeDay={(day) => void handleProposalRequest({ kind: 'day-optimize', dayId: day.id })}
                    onCardClick={setSelectedItemId}
                    highlightItemId={selectedItemId}
                    onMoveItem={handleMoveItem}
                    onCopyItem={handleCopyItem}
                    onDeleteItem={handleDeleteItem}
                    onAddCard={setAddCardDay}
                    onDropStash={(stashId, poi, dayId, index) => void handleSchedulePoi(poi, stashId, dayId, index)}
                    onNoteSave={handleNoteSave}
                    onImageAdd={handleImageAdd}
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
              tripId={tripId}
              days={state.status === 'ready' ? state.data.days : []}
              legs={state.status === 'ready' ? state.data.legs : []}
              selectedItemId={selectedItemId}
              onSelectItem={setSelectedItemId}
              onCollapse={() => toggle('map')}
              focus={mapFocus}
              onSchedulePoi={handleSchedulePoi}
            />
          </div>
        )}
      </div>

      {/* 添加卡片（ticket 09）——搜索 POI 或自由文本，两种模式 */}
      {state.status === 'ready' && addCardDay !== null && (
        <AddCardDialog
          days={state.data.days}
          defaultDayId={addCardDay}
          onSubmit={(input) => void handleCreateCard(input)}
          onClose={() => setAddCardDay(null)}
        />
      )}

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
