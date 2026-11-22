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
import { readActivityItemMetadata } from '@hailar/domain'
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
  refreshWorkbenchLegs,
  tempItemId,
  updateWorkbenchDay,
  updateWorkbenchItem,
  type TripCanvasData,
  type WorkbenchDay,
  type WorkbenchItem,
  type WorkbenchItemCreateInput,
  type WorkbenchItemPatch,
} from '../../domain/workbench'
import type { ChatPoiLink } from '../../domain/chat'
import {
  applyAiProposal,
  cancelAiProposal,
  createAiProposal,
  type AiProposalState,
  type ProposalRequest,
} from '../../domain/aiProposals'
import { subscribeTripEvents } from '../../domain/tripEvents'
import { AI_WIDTH_MAX, AI_WIDTH_MIN } from '../../domain/workbenchLayout'
import type { WorkbenchView } from '../../domain/workbenchLayout'
import { useWorkbenchLayout } from '../../hooks/useWorkbenchLayout'
import { useToolsPanel } from '../../hooks/useToolsPanel'
import WorkbenchTopbar from './WorkbenchTopbar'
import StayEditor from './StayEditor'
import AddCardDialog from './AddCardDialog'
import CanvasColumn from './CanvasColumn'
import ChatPanel from './ChatPanel'
import ListViewColumn from './ListViewColumn'
import ConfirmDialog from './ConfirmDialog'
import MapPanel from './MapPanel'
import ToolsRail from './ToolsRail'
import ToolsPanel from './ToolsPanel'
import { recommendationCardInput, stashCardInput, removeFromStash, type RecommendationPoi, type StashItem } from '../../domain/recommendations'
import { usePrint } from '../../hooks/usePrint'
import WorkbenchPrintSheet, { type WorkbenchPrintSheetHandle } from './WorkbenchPrintSheet'

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; data: TripCanvasData }

type MobilePane = 'chat' | 'canvas' | 'map'

export default function WorkbenchPage({ tripId, onBack, initialPrompt }: { tripId: string; onBack: () => void; initialPrompt?: string }) {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const routeRefreshSequence = useRef(0)
  const routeRefreshInFlight = useRef<Promise<void> | null>(null)
  const routeRefreshQueued = useRef(false)
  const routeTripId = useRef(tripId)
  routeTripId.current = tripId
  // Canvas ↔ map linkage (ticket 05): one shared selection — canvas card
  // clicks focus the map POI, map marker clicks highlight + scroll the canvas.
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null)
  const { layout, toggle, resizeAi, setView } = useWorkbenchLayout(tripId)
  const { open: toolsOpen, toggle: toggleTools, close: closeTools } = useToolsPanel(tripId)
  const [actionError, setActionError] = useState('')
  const [pendingDelete, setPendingDelete] = useState<WorkbenchDay | null>(null)
  const [stayEditorOpen, setStayEditorOpen] = useState(false)
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
  const [compactViewport, setCompactViewport] = useState(false)
  const [mobilePane, setMobilePane] = useState<MobilePane>('canvas')
  const [canvasSyncing, setCanvasSyncing] = useState(false)
  const [pendingMutationCount, setPendingMutationCount] = useState(0)
  const print = usePrint()
  const printSheetRef = useRef<WorkbenchPrintSheetHandle>(null)
  const isBusy = canvasSyncing || pendingMutationCount > 0
  // Ignore a canvas response that started before a newer read or local write.
  // SSE invalidation is asynchronous, so an older response could otherwise
  // overwrite an optimistic card edit after it has settled.
  const canvasReadSeqRef = useRef(0)
  const localWriteEpochRef = useRef(0)

  // Latest ready data for async handlers (avoids stale-closure rollbacks).
  const readyData = state.status === 'ready' ? state.data : null
  const dataRef = useRef<TripCanvasData | null>(readyData)
  dataRef.current = readyData

  useEffect(() => {
    routeRefreshSequence.current += 1
    let cancelled = false
    setState({ status: 'loading' })
    setActionError('')
    setSelectedItemId(null)
    setProposalState({ status: 'idle' })
    const requestSeq = ++canvasReadSeqRef.current
    const writeEpoch = localWriteEpochRef.current
    void fetchTripCanvas(tripId).then((result) => {
      if (cancelled || requestSeq !== canvasReadSeqRef.current || writeEpoch !== localWriteEpochRef.current) return
      if (result.ok) setState({ status: 'ready', data: result.data })
      else setState({ status: 'error', error: result.error })
    })
    return () => {
      cancelled = true
    }
  }, [tripId])

  // The desktop three-column layout becomes a single full-width pane below
  // 1024px. Keep the media query in JS because tab selection controls which
  // stateful panel is mounted in the compact layout.
  useEffect(() => {
    const media = window.matchMedia('(max-width: 1023px)')
    const sync = () => setCompactViewport(media.matches)
    sync()
    media.addEventListener?.('change', sync)
    return () => media.removeEventListener?.('change', sync)
  }, [])

  // Any committed write from another tab/process instance invalidates the
  // current projection. A fresh canvas read keeps cards, legs, and the trip
  // badge on one authoritative snapshot.
  useEffect(() => {
    let active = true
    const unsubscribe = subscribeTripEvents(tripId, {
      onUpdate: (event) => {
        if (!active || (event.kind !== 'canvas' && event.kind !== 'trip')) return
        setCanvasSyncing(true)
        const requestSeq = ++canvasReadSeqRef.current
        const writeEpoch = localWriteEpochRef.current
        void fetchTripCanvas(tripId).then((result) => {
          if (!active || requestSeq !== canvasReadSeqRef.current || writeEpoch !== localWriteEpochRef.current) return
          if (result.ok) setState({ status: 'ready', data: result.data })
        }).finally(() => {
          if (active && requestSeq === canvasReadSeqRef.current) setCanvasSyncing(false)
        })
      },
      onReconnect: () => {
        if (!active) return
        setCanvasSyncing(true)
        const requestSeq = ++canvasReadSeqRef.current
        const writeEpoch = localWriteEpochRef.current
        void fetchTripCanvas(tripId).then((result) => {
          if (!active || requestSeq !== canvasReadSeqRef.current || writeEpoch !== localWriteEpochRef.current) return
          if (result.ok) setState({ status: 'ready', data: result.data })
        }).finally(() => {
          if (active && requestSeq === canvasReadSeqRef.current) setCanvasSyncing(false)
        })
      },
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [tripId])

  /** Local day-list patch on the ready state (no-op when not ready). */
  const patchDays = (update: (days: WorkbenchDay[]) => WorkbenchDay[]) => {
    setState((prev) =>
      prev.status === 'ready' ? { ...prev, data: { ...prev.data, days: update(prev.data.days) } } : prev,
    )
  }

  /** Replace the legs list on the ready state (map redraws from it). */
  const patchLegs = (legs: TripCanvasData['legs']) => {
    setState((prev) => (prev.status === 'ready' ? { ...prev, data: { ...prev.data, legs } } : prev))
  }

  /**
   * Route lookup is deliberately best-effort and backgrounded. A missing API
   * or provider leaves the optimistic estimate visible; a late response from
   * an older edit cannot overwrite the latest canvas.
   */
  const requestRouteRefresh = () => {
    // Coalesce rapid drag/add operations into one follow-up pass. The token
    // advances immediately so an in-flight response cannot win over a newer
    // optimistic layout.
    ++routeRefreshSequence.current
    routeRefreshQueued.current = true
    if (routeRefreshInFlight.current) return
    const run = async (): Promise<void> => {
      while (routeRefreshQueued.current) {
        routeRefreshQueued.current = false
        const sequence = routeRefreshSequence.current
        const result = await refreshWorkbenchLegs(routeTripId.current)
        if (sequence === routeRefreshSequence.current && result.ok) patchLegs(result.data.legs)
      }
    }
    const inFlight = run()
    routeRefreshInFlight.current = inFlight
    void inFlight.then(
      () => {
        if (routeRefreshInFlight.current === inFlight) routeRefreshInFlight.current = null
      },
      () => {
        if (routeRefreshInFlight.current === inFlight) routeRefreshInFlight.current = null
      },
    )
  }

  // ---- AI plan round (ticket 08) ---------------------------------------------
  // The chat panel calls this when an `applied_patch` SSE event arrives: the
  // trip changed server-side, so refetch /canvas and reproject all columns.
  const handleTripPatched = () => {
    setCanvasSyncing(true)
    const requestSeq = ++canvasReadSeqRef.current
    const writeEpoch = localWriteEpochRef.current
    void fetchTripCanvas(tripId).then((result) => {
      if (requestSeq !== canvasReadSeqRef.current || writeEpoch !== localWriteEpochRef.current) return
      if (result.ok) {
        setState({ status: 'ready', data: result.data })
        requestRouteRefresh()
      }
      // Refetch failures keep the current canvas — the chat card still reports
      // the write; a later event or manual refresh recovers.
    }).finally(() => {
      if (requestSeq === canvasReadSeqRef.current) setCanvasSyncing(false)
    })
  }

  const withPendingMutation = async <T,>(task: () => Promise<T>): Promise<T> => {
    localWriteEpochRef.current += 1
    setPendingMutationCount((count) => count + 1)
    try {
      return await task()
    } finally {
      setPendingMutationCount((count) => Math.max(0, count - 1))
    }
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
  const handleAddDay = () => withPendingMutation(async () => {
    setActionError('')
    const result = await createWorkbenchDay(tripId)
    if (!result.ok) {
      setActionError(result.error)
      return
    }
    patchDays((days) => [...days, result.data].sort((a, b) => a.index - b.index))
  })

  /** Optimistic theme edit; reverts the day's theme when the write fails. */
  const handleThemeSave = (dayId: string, theme: string) => withPendingMutation(async () => {
    const previous = dataRef.current?.days.find((day) => day.id === dayId)?.theme ?? ''
    setActionError('')
    patchDays((days) => days.map((day) => (day.id === dayId ? { ...day, theme } : day)))
    const result = await updateWorkbenchDay(tripId, dayId, { theme })
    if (!result.ok) {
      patchDays((days) => days.map((day) => (day.id === dayId ? { ...day, theme: previous } : day)))
      setActionError(result.error)
    }
  })

  /** Optimistic day delete; restores the whole day (with its cards) on failure. */
  const handleDeleteDay = (day: WorkbenchDay) => setPendingDelete(day)

  const confirmDeleteDay = () => withPendingMutation(async () => {
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
  })

  const pendingDeleteLabel = pendingDelete
    ? `${pendingDelete.date ? pendingDelete.date : `D${pendingDelete.index + 1}`}${pendingDelete.theme ? ` ${pendingDelete.theme}` : ''}`
    : ''

  // ---- Card editing (ticket 09) ---------------------------------------------
  // Every edit is optimistic (spec user story 41): patch the local days
  // first, send the request, and on success adopt the recomputed legs from
  // the response (map follows without a second canvas read). Any failure
  // restores the pre-edit snapshot and shows the error — no silent loss.

  /** Shared rollback: restore the snapshot and surface the server error. */
  const rollback = (snapshot: TripCanvasData | null, error: string) => {
    if (snapshot) setState({ status: 'ready', data: snapshot })
    setActionError(error)
  }

  type ItemMutationResult<T> = { ok: true; data: T } | { ok: false; error: string }

  /** Shared optimistic item-write lifecycle used by layout and field edits. */
  const runItemMutation = async <T,>(
    snapshot: TripCanvasData | null,
    optimistic: () => void,
    request: () => Promise<ItemMutationResult<T>>,
    reconcile: (data: T) => void,
  ): Promise<T | null> => {
    setActionError('')
    optimistic()
    const result = await request()
    if (!result.ok) {
      rollback(snapshot, result.error)
      return null
    }
    reconcile(result.data)
    return result.data
  }

  const findItem = (days: WorkbenchDay[], itemId: string): WorkbenchItem | undefined =>
    days.flatMap((day) => day.items).find((item) => item.id === itemId)

  const handleMoveItem = (itemId: string, toDayId: string, toIndex: number) =>
    withPendingMutation(() => runItemMutation(
      dataRef.current,
      () => patchDays((days) => applyItemMove(days, itemId, toDayId, toIndex)),
      () => moveWorkbenchItem(tripId, itemId, { dayId: toDayId, index: toIndex }),
      (data) => {
        patchDays((days) => applyItemReplace(days, itemId, data.item))
        patchLegs(data.legs)
        requestRouteRefresh()
      },
    ))

  const handleCopyItem = (itemId: string, toDayId: string, toIndex?: number) => withPendingMutation(async () => {
    const snapshot = dataRef.current
    const source = snapshot ? findItem(snapshot.days, itemId) : undefined
    if (!source) return null
    const temp: WorkbenchItem = { ...source, id: tempItemId('pending-copy'), dayId: toDayId, pending: true }
    return runItemMutation(
      snapshot,
      () => patchDays((days) => applyItemInsert(days, temp, toDayId, toIndex)),
      () => copyWorkbenchItem(tripId, itemId, { dayId: toDayId, index: toIndex }),
      (data) => {
        patchDays((days) => applyItemReplace(days, temp.id, data.item))
        patchLegs(data.legs)
        requestRouteRefresh()
      },
    )
  })

  const handleCreateCard = (input: WorkbenchItemCreateInput): Promise<WorkbenchItem | null> => withPendingMutation(async () => {
    const snapshot = dataRef.current
    setAddCardDay(null)
    const temp: WorkbenchItem = {
      id: tempItemId('pending-add'),
      dayId: input.dayId,
      order: 0,
      type: input.type ?? 'other',
      title: input.title,
      ...readActivityItemMetadata(input),
      note: input.note ?? '',
      poi: input.poi ?? null,
      images: input.images ?? [],
      pending: true,
    }
    const result = await runItemMutation(
      snapshot,
      () => patchDays((days) => applyItemInsert(days, temp, input.dayId, input.index)),
      () => createWorkbenchItem(tripId, input),
      (data) => {
        patchDays((days) => applyItemReplace(days, temp.id, data.item))
        patchLegs(data.legs)
        requestRouteRefresh()
      },
    )
    return result?.item ?? null
  })

  /** Manual scheduling retains the existing two-request compensation flow. */
  const scheduleCard = async (input: WorkbenchItemCreateInput, stashId?: string): Promise<boolean> => {
    const created = await handleCreateCard(input)
    if (!created || !stashId) return created !== null
    const removed = await removeFromStash(tripId, stashId)
    if (!removed.ok) {
      setActionError(removed.error)
      // The card write already succeeded, but the stash delete did not. Try
      // to undo the card so a retry cannot create a duplicate scheduled item.
      const deleted = await deleteWorkbenchItem(tripId, created.id)
      if (deleted.ok) {
        patchDays((days) => applyItemRemove(days, created.id))
        patchLegs(deleted.data.legs)
        requestRouteRefresh()
      } else {
        // If the compensating delete also failed, reload the authoritative
        // canvas so the optimistic view cannot diverge from the server.
        void fetchTripCanvas(tripId).then((result) => {
          if (result.ok) setState({ status: 'ready', data: result.data })
        })
      }
      return false
    }
    return true
  }

  const handleSchedulePoi = async (poi: RecommendationPoi, stashId?: string, dayId?: string, index?: number): Promise<boolean> => {
    const targetDayId = dayId ?? dataRef.current?.days[0]?.id
    return targetDayId ? scheduleCard(recommendationCardInput(poi, targetDayId, index), stashId) : false
  }

  const handleScheduleStash = async (item: StashItem, dayId?: string, index?: number): Promise<boolean> => {
    const targetDayId = dayId ?? dataRef.current?.days[0]?.id
    return targetDayId ? scheduleCard(stashCardInput(item, targetDayId, index), item.id) : false
  }

  const handleDeleteItem = (itemId: string) =>
    withPendingMutation(() => runItemMutation(
      dataRef.current,
      () => patchDays((days) => applyItemRemove(days, itemId)),
      () => deleteWorkbenchItem(tripId, itemId),
      (data) => {
        patchLegs(data.legs)
        requestRouteRefresh()
      },
    ))

  const handleNoteSave = (itemId: string, note: string) =>
    withPendingMutation(() => runItemMutation(
      dataRef.current,
      () => patchDays((days) => applyItemPatch(days, itemId, { note })),
      () => updateWorkbenchItem(tripId, itemId, { note }),
      (data) => {
        // Server normalization (e.g. image captions) wins on field edits.
        patchDays((days) => applyItemReplace(days, itemId, data))
      },
    ))

  const handleImageAdd = (itemId: string, url: string) => withPendingMutation(async () => {
    const snapshot = dataRef.current
    const current = snapshot ? findItem(snapshot.days, itemId) : undefined
    if (!current) return
    const images = [...current.images, { url, caption: '' }]
    await runItemMutation(
      snapshot,
      () => patchDays((days) => applyItemPatch(days, itemId, { images })),
      () => updateWorkbenchItem(tripId, itemId, { images }),
      (data) => patchDays((days) => applyItemReplace(days, itemId, data)),
    )
  })

  const handleStaySave = (itemId: string, patch: WorkbenchItemPatch): Promise<boolean> =>
    withPendingMutation(async () => {
      const result = await runItemMutation(
        dataRef.current,
        () => patchDays((days) => applyItemPatch(days, itemId, patch)),
        () => updateWorkbenchItem(tripId, itemId, patch),
        (data) => {
          patchDays((days) => applyItemReplace(days, itemId, data))
          requestRouteRefresh()
        },
      )
      return result !== null
    })

  const aiVisible = compactViewport ? mobilePane === 'chat' : !layout.aiCollapsed
  const canvasVisible = compactViewport ? mobilePane === 'canvas' : !layout.canvasCollapsed
  const mapVisible = compactViewport ? mobilePane === 'map' : !layout.mapCollapsed
  const printCurrentTrip = () => {
    const refresh = printSheetRef.current?.refresh()
    if (refresh) void refresh.then(() => print())
    else print()
  }
  const plannerInitialPrompt = initialPrompt ?? (state.status === 'ready' && state.data.trip.planningContext?.source !== 'guide'
    ? state.data.trip.planningContext?.originalSentence : undefined)

  return (
    <>
      <div
      className={`workbench-shell flex h-screen min-h-0 flex-col bg-paper text-ink ${compactViewport ? 'workbench-compact' : ''}`}
      data-workbench-mode={compactViewport ? 'tabs' : 'columns'}
      aria-busy={state.status === 'loading' || isBusy}
    >
      {state.status === 'ready' && (
        <WorkbenchTopbar
          trip={state.data.trip}
          onBack={onBack}
          onOptimize={() => void handleProposalRequest({ kind: 'optimize' })}
          optimizing={proposalState.status === 'loading' && proposalState.request.kind === 'optimize'}
          onPrint={printCurrentTrip}
          onOpenStays={() => setStayEditorOpen(true)}
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

      {compactViewport && <MobileWorkbenchTabs active={mobilePane} onChange={setMobilePane} />}

      <div className={`flex min-h-0 flex-1 ${compactViewport ? 'flex-col' : ''}`} data-workbench-panels>
        {/* 左栏 AI —— 可拖拽调宽、可收起 */}
        {aiVisible ? (
          <>
            <div
              id="workbench-column-ai"
              className={`flex min-h-0 shrink-0 flex-col border-r border-line bg-white ${compactViewport ? 'w-full flex-1 border-r-0' : ''}`}
              style={compactViewport ? undefined : { width: layout.aiWidth }}
            >
              <ChatPanel
                tripId={tripId}
                initialPrompt={plannerInitialPrompt}
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
            {!compactViewport && <AiResizeHandle width={layout.aiWidth} onResize={resizeAi} />}
          </>
        ) : (
          <CollapsedRail
            id="workbench-rail-ai"
            label="圆周 AI"
            icon={<MessageCircle aria-hidden="true" className="w-[16px]" />}
            onExpand={() => toggle('ai')}
          />
        )}

        {/* 中栏 行程画布 —— 可收起 */}
        {canvasVisible ? (
          <div id="workbench-column-canvas" className={`flex min-h-0 min-w-0 flex-1 flex-col ${compactViewport ? 'w-full' : ''}`}>
            <div className="flex shrink-0 items-center border-b border-line bg-white px-[14px] py-[8px] text-[13px] font-[550]">
              行程画布
              <ViewToggle view={layout.view} onChange={setView} />
              {isBusy && (
                <span data-workbench-syncing className="ml-[10px] inline-flex items-center gap-[5px] text-[11px] font-normal text-muted" aria-live="polite">
                  <span aria-hidden="true" className="workbench-spinner h-[11px] w-[11px] rounded-full border-2 border-line border-t-green" />
                  正在同步路线
                </span>
              )}
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
              <div className="flex min-h-0 min-w-0 flex-1" data-workbench-updating={canvasSyncing || undefined}>
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
                    syncing={isBusy}
                    onCardClick={setSelectedItemId}
                    highlightItemId={selectedItemId}
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
                    onDropStash={(item, dayId, index) => void handleScheduleStash(item, dayId, index)}
                    onNoteSave={handleNoteSave}
                    onImageAdd={handleImageAdd}
                    syncing={isBusy}
                  />
                )}
              </div>
            ) : (
              <WorkbenchLoadingSkeleton error={state.status === 'error' ? state.error : undefined} />
            )}
          </div>
        ) : (
          <CollapsedRail
            id="workbench-rail-canvas"
            label="行程画布"
            icon={<Sparkles aria-hidden="true" className="w-[16px]" />}
            onExpand={() => toggle('canvas')}
          />
        )}

        {/* 右栏 地图 —— 可收起（ticket 05：真实路线投影 + 画布联动） */}
        {mapVisible ? (
          <div
            id="workbench-column-map"
            className={`flex min-h-0 shrink-0 flex-col border-l border-line bg-white ${compactViewport ? 'w-full flex-1 border-l-0' : 'w-[320px]'}`}
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
              onScheduleStash={handleScheduleStash}
              syncing={isBusy}
            />
          </div>
        ) : (
          <CollapsedRail
            id="workbench-rail-map"
            label="路线地图"
            icon={<MapIcon aria-hidden="true" className="w-[16px]" />}
            onExpand={() => toggle('map')}
          />
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
      {state.status === 'ready' && <WorkbenchPrintSheet ref={printSheetRef} trip={state.data.trip} days={state.data.days} legs={state.data.legs} />}
      {state.status === 'ready' && stayEditorOpen && (
        <StayEditor
          days={state.data.days}
          onSave={handleStaySave}
          onClose={() => setStayEditorOpen(false)}
        />
      )}
    </>
  )
}

function MobileWorkbenchTabs({ active, onChange }: { active: MobilePane; onChange: (pane: MobilePane) => void }) {
  const tabs: { id: MobilePane; label: string; icon: React.ReactNode }[] = [
    { id: 'chat', label: '圆周 AI', icon: <MessageCircle aria-hidden="true" className="w-[15px]" /> },
    { id: 'canvas', label: '行程画布', icon: <Sparkles aria-hidden="true" className="w-[15px]" /> },
    { id: 'map', label: '路线地图', icon: <MapIcon aria-hidden="true" className="w-[15px]" /> },
  ]
  return (
    <nav
      id="workbench-mobile-tabs"
      role="tablist"
      aria-label="工作台视图"
      className="flex h-[46px] shrink-0 items-center gap-[4px] border-b border-line bg-white px-[8px]"
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={active === tab.id}
          aria-controls={`workbench-column-${tab.id === 'chat' ? 'ai' : tab.id}`}
          data-workbench-mobile-tab={tab.id}
          onClick={() => onChange(tab.id)}
          className={`flex h-[32px] min-w-0 flex-1 items-center justify-center gap-[5px] rounded-[5px] px-[8px] text-[12px] transition-colors ${
            active === tab.id ? 'bg-green text-white' : 'text-muted hover:bg-paper hover:text-ink'
          }`}
        >
          {tab.icon}
          {tab.label}
        </button>
      ))}
    </nav>
  )
}

function WorkbenchLoadingSkeleton({ error }: { error?: string }) {
  if (error) {
    return (
      <div id="workbench-loading" data-workbench-loading className="flex flex-1 flex-col items-center justify-center gap-[12px] px-[20px] text-center text-[13px] text-red">
        <p data-workbench-load-error>{error}</p>
        <p className="text-[12px] text-muted">请返回行程列表后重试。</p>
      </div>
    )
  }
  return (
    <div id="workbench-loading" data-workbench-loading className="flex min-h-0 flex-1 flex-col gap-[14px] overflow-hidden p-[16px]" aria-live="polite">
      <div data-workbench-skeleton className="h-[18px] w-[38%] rounded-[4px] bg-line/70" />
      <div className="grid min-h-0 flex-1 gap-[12px] sm:grid-cols-2">
        {[0, 1].map((column) => (
          <div key={column} className="flex min-h-[220px] flex-col gap-[12px] rounded-[8px] border border-line bg-white p-[12px]">
            <div className="h-[16px] w-[45%] rounded-[4px] bg-line/70" />
            {[0, 1, 2].map((row) => (
              <div key={row} className="h-[56px] shrink-0 rounded-[6px] bg-paper">
                <div className="mx-[10px] pt-[12px]">
                  <div className="h-[10px] w-[70%] rounded-[3px] bg-line/70" />
                  <div className="mt-[8px] h-[8px] w-[45%] rounded-[3px] bg-line/50" />
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
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
