import { useEffect, useState } from 'react'
import App from './App'
import TripListPage from './components/TripListPage'
import WorkbenchPage from './components/workbench/WorkbenchPage'
import AiSettingsPage from './components/AiSettingsPage'
import { probeTripsApi } from './domain/tripList'
import { AccommodationProvider } from './hooks/useAccommodation'
import { RouteStatesProvider } from './hooks/useRouteStates'
import { AmapLiveProvider } from './hooks/useAmapLive'

type AppView = 'loading' | 'trips' | 'workbench' | 'settings' | 'guide'

/**
 * Ticket 02 shell: the trip list is the default view; the existing Hailar
 * guide app stays reachable (header button) and completely unchanged — the
 * back button below is rendered as an overlay sibling, not inside App.
 *
 * View selection:
 * - `?view=trips|workbench|guide` forces a view (`?trip=<id>` picks the trip
 *   for the workbench — deterministic entry points for tests and bookmarks).
 * - Otherwise the trips API is probed briefly: backend reachable → trip
 *   list; standalone frontend (no backend, e.g. the browser test harness) →
 *   the guide, preserving its historical default behavior.
 * - Ticket 04: clicking a trip row on the list opens the workbench for that
 *   trip; the workbench's back button returns to the list.
 */
function viewFromUrl(): { view: AppView; tripId: string | null } | null {
  const params = new URLSearchParams(window.location.search)
  const param = params.get('view')
  if (param !== 'trips' && param !== 'guide' && param !== 'workbench' && param !== 'settings') return null
  return { view: param, tripId: params.get('trip') }
}

export default function AppShell() {
  const [state, setState] = useState<{ view: AppView; tripId: string | null; initialPrompt?: string }>(() => viewFromUrl() ?? {
    view: 'loading',
    tripId: null,
  })
  const [activeTripId, setActiveTripId] = useState<string | null>(null)
  const { view } = state

  useEffect(() => {
    if (view !== 'loading') return
    let cancelled = false
    void probeTripsApi().then((available) => {
      if (!cancelled) setState({ view: available ? 'trips' : 'guide', tripId: null })
    })
    return () => {
      cancelled = true
    }
  }, [view])

  const openTrip = (tripId: string, initialPrompt?: string) => {
    setActiveTripId(tripId)
    setState({ view: 'workbench', tripId, initialPrompt })
  }
  const backToTrips = () => {
    setActiveTripId(null)
    setState({ view: 'trips', tripId: null })
  }

  if (view === 'loading') {
    return (
      <div className="min-h-screen grid place-items-center bg-paper text-muted text-[13px]">加载中…</div>
    )
  }

  if (view === 'workbench') {
    const tripId = activeTripId ?? state.tripId
    if (tripId) {
      return <WorkbenchPage tripId={tripId} onBack={backToTrips} initialPrompt={state.initialPrompt} />
    }
    // ?view=workbench without a trip id falls back to the list.
    return <TripListPage onOpenGuide={() => setState({ view: 'guide', tripId: null })} onOpenSettings={() => setState({ view: 'settings', tripId: null })} onOpenTrip={openTrip} />
  }

  if (view === 'settings') {
    return <AiSettingsPage onBack={backToTrips} />
  }

  if (view === 'trips') {
    return (
      <TripListPage
        onOpenGuide={() => setState({ view: 'guide', tripId: null })}
        onOpenSettings={() => setState({ view: 'settings', tripId: null })}
        onOpenTrip={openTrip}
      />
    )
  }

  return (
    <>
      <button
        id="back-to-trips"
        type="button"
        title="返回行程列表"
        onClick={backToTrips}
        className="fixed left-[18px] bottom-[18px] z-[60] h-[38px] px-[14px] rounded-[5px] border border-line bg-white text-[13px] text-muted hover:text-green hover:border-green transition-colors shadow-sm"
      >
        ← 行程列表
      </button>
      <AccommodationProvider>
        <RouteStatesProvider>
          <AmapLiveProvider>
            <App />
          </AmapLiveProvider>
        </RouteStatesProvider>
      </AccommodationProvider>
    </>
  )
}
