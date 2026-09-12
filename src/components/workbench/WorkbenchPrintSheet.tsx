import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import {
  crossDayTransfer,
  dayDateLabel,
  formatLegDisplayLabel,
  formatLegLabel,
  legQuality,
  legsByPair,
  type WorkbenchDay,
  type WorkbenchItem,
  type WorkbenchLeg,
} from '../../domain/workbench'
import { fetchChecklist, fetchNotes, type ChecklistItem, type NoteItem } from '../../domain/tools'
import { formatTripSchedule, type TripSummary } from '../../domain/tripList'
import { fetchTripCanvas, type TripCanvasData } from '../../domain/workbench'

export type WorkbenchPrintSheetProps = {
  trip: TripSummary
  days: WorkbenchDay[]
  legs: WorkbenchLeg[]
}

export type WorkbenchPrintSheetHandle = {
  refresh: () => Promise<void>
}

type AuxiliaryState = {
  notes: NoteItem[] | null
  checklist: ChecklistItem[] | null
  notesFailed: boolean
  checklistFailed: boolean
}

type PrintSnapshot = Pick<TripCanvasData, 'trip' | 'days' | 'legs'>

/** Current-trip print projection; no legacy guide or browser accommodation state is read here. */
const WorkbenchPrintSheet = forwardRef<WorkbenchPrintSheetHandle, WorkbenchPrintSheetProps>(function WorkbenchPrintSheet(
  { trip, days, legs },
  ref,
) {
  const [snapshot, setSnapshot] = useState<PrintSnapshot>({ trip, days, legs })
  const [canvasFailed, setCanvasFailed] = useState(false)
  const [auxiliary, setAuxiliary] = useState<AuxiliaryState>({ notes: null, checklist: null, notesFailed: false, checklistFailed: false })
  const refreshSequence = useRef(0)

  useEffect(() => {
    setSnapshot({ trip, days, legs })
    setCanvasFailed(false)
  }, [trip, days, legs])

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current
    setAuxiliary((current) => ({ ...current, notes: null, checklist: null, notesFailed: false, checklistFailed: false }))
    const [canvas, notes, checklist] = await Promise.all([
      fetchTripCanvas(trip.id),
      fetchNotes(trip.id),
      fetchChecklist(trip.id),
    ])
    if (sequence !== refreshSequence.current) return
    if (canvas.ok) {
      setSnapshot(canvas.data)
      setCanvasFailed(false)
    } else {
      setCanvasFailed(true)
    }
    setAuxiliary({
      notes: notes.ok ? notes.data : null,
      checklist: checklist.ok ? checklist.data : null,
      notesFailed: !notes.ok,
      checklistFailed: !checklist.ok,
    })
  }, [trip.id])

  useImperativeHandle(ref, () => ({ refresh }), [refresh])
  useEffect(() => {
    void refresh()
  }, [refresh])

  const schedule = [...snapshot.days].sort((a, b) => a.index - b.index || a.id.localeCompare(b.id))
  const scheduleLabel = formatTripSchedule(snapshot.trip) || '日期待定'
  return (
    <div id="print-itinerary">
      <section className="print-sheet-header">
        <p className="eyebrow">TRIP WORKBENCH / CURRENT PLAN</p>
        <h1>{snapshot.trip.title || '未命名行程'}</h1>
        <p className="print-sheet-summary">{scheduleLabel}</p>
        <p className="print-sheet-note">
          {canvasFailed
            ? '当前服务器行程快照暂不可用，本次打印保留上次已加载内容。'
            : snapshot.trip.dateStatus === 'unspecified' || snapshot.trip.dateStatus === 'tentative'
            ? '日期待定；请先在圆周对话中确认出发日期，再安排具体天次。'
            : '行程内容来自当前服务器数据；路线出发前请以实时导航为准。'}
        </p>
      </section>

      <section className="print-days" aria-label="当前行程">
        {schedule.map((day, index) => {
          const previousDay = schedule[index - 1]
          const route = workbenchPrintRoute(day, legs, previousDay)
          const items = [...day.items].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
          return (
            <article className="print-day" data-print-day={day.id} data-day-index={day.index} key={day.id}>
              <header className="print-day-heading">
                <div>
                  <p className="eyebrow">
                    DAY {String(day.index + 1).padStart(2, '0')} {dayDateLabel(day.date) || '日期待定'}
                  </p>
                  <h2>{day.theme || `第 ${day.index + 1} 天`}</h2>
                </div>
                <span className="tag">{items.length} 项</span>
              </header>

              <div className={`print-route${route.status === 'pending' ? ' is-stale' : ''}`} data-route-status={route.status}>
                <span className="print-route-label">路线</span>
                <strong>{route.from || '起点待定'} → {route.to || '终点待定'}</strong>
                <b>{route.label}</b>
                <p>{route.note}</p>
              </div>

              <div className="print-workbench-cards">
                {items.length === 0 && <p className="print-workbench-unavailable">这一天还没有安排。</p>}
                {items.map((item, itemIndex) => (
                  <PrintItem key={item.id} item={item} order={itemIndex + 1} />
                ))}
              </div>
            </article>
          )
        })}
        {schedule.length === 0 && <p className="print-workbench-unavailable">当前行程还没有安排天次。</p>}
      </section>

      {auxiliary.notes !== null ? (
        <section className="print-workbench-notes" aria-label="行程便签">
          <h2>行程便签</h2>
          {auxiliary.notes.length > 0 ? (
            <ul>{auxiliary.notes.map((note) => <li key={note.id}>{note.content || '（空便签）'}</li>)}</ul>
          ) : (
            <p>暂无便签。</p>
          )}
        </section>
      ) : auxiliary.notesFailed ? (
        <p className="print-workbench-unavailable">便签数据暂不可用。</p>
      ) : null}

      {auxiliary.checklist !== null ? (
        <section className="print-workbench-checklist" aria-label="行前清单">
          <h2>行前清单</h2>
          {auxiliary.checklist.length > 0 ? (
            <ul>{auxiliary.checklist.map((item) => <li key={item.id}>{item.done ? '已完成 · ' : '待办 · '}{item.content}</li>)}</ul>
          ) : (
            <p>暂无清单。</p>
          )}
        </section>
      ) : auxiliary.checklistFailed ? (
        <p className="print-workbench-unavailable">清单数据暂不可用。</p>
      ) : null}
    </div>
  )
})

export default WorkbenchPrintSheet

function PrintItem({ item, order }: { item: WorkbenchItem; order: number }) {
  const image = item.images[0]
  return (
    <article className={`print-workbench-item${item.type === 'stay' ? ' print-stay' : ''}`} data-print-item={item.id} data-print-item-type={item.type}>
      <span className="print-workbench-item-order">{order}</span>
      <div>
        <strong>{item.title || '未命名安排'}</strong>
        {item.poi && <p>{item.poi.name}{item.poi.category ? ` · ${item.poi.category}` : ''}{item.poi.address ? ` · ${item.poi.address}` : ''}</p>}
        {item.note && <p><b>备注</b>{item.note}</p>}
        {item.poi?.accommodationNotes && <p><b>住宿备注</b>{item.poi.accommodationNotes}</p>}
        {item.pending && <p className="print-workbench-pending">待定，需出发前确认</p>}
      </div>
      {image && <img src={image.url} alt="" />}
    </article>
  )
}

export type WorkbenchPrintRoute = {
  from: string
  to: string
  label: string
  note: string
  status: 'measured' | 'estimate' | 'partial' | 'pending'
}

/** Derive one printable route block from the supplied current day/card/leg rows. */
export function workbenchPrintRoute(day: WorkbenchDay, legs: WorkbenchLeg[], previousDay?: WorkbenchDay): WorkbenchPrintRoute {
  const items = [...day.items].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  const incoming = previousDay ? crossDayTransfer(previousDay, day, legs) : null
  const lookup = legsByPair(legs)
  const routeLegs = [
    ...(incoming ? [incoming.leg] : []),
    ...items.slice(1).map((item, index) => lookup.get(`${items[index]?.id}|${item.id}`) ?? null),
  ]
  const usable = routeLegs.filter((leg): leg is WorkbenchLeg => leg !== null && formatLegLabel(leg) !== '')
  const from = incoming?.fromTitle ?? items[0]?.title ?? ''
  const to = items.at(-1)?.title ?? incoming?.toTitle ?? ''
  if (usable.length === 0) {
    return { from, to, label: '路线待查询', note: '当前没有完整路线数据，出发前请使用实时导航。', status: 'pending' }
  }
  const complete = usable.length === routeLegs.length
  const status = complete
    ? usable.some((leg) => legQuality(leg) !== 'measured') ? 'estimate' : 'measured'
    : 'partial'
  const summaryLeg: WorkbenchLeg = {
    ...usable[0]!,
    distanceKm: usable.reduce((sum, leg) => sum + leg.distanceKm, 0),
    durationMin: usable.reduce((sum, leg) => sum + leg.durationMin, 0),
    quality: status === 'measured' ? 'measured' : 'estimate',
  }
  const label = formatLegDisplayLabel(summaryLeg)
  return {
    from,
    to,
    label: label ? `${label}${complete ? '' : '（部分路线）'}` : '路线待查询',
    note: status === 'measured'
      ? '路线来自已测量的路线服务结果。'
      : complete
        ? '距离与时长为规划参考，路线服务返回后会更新。'
        : '仅部分路段有数据，完整路线返回后会更新；出发前请使用实时导航。',
    status,
  }
}
