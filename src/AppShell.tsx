import { useEffect, useState } from 'react'
import App from './App'
import TripListPage from './components/TripListPage'
import { probeTripsApi } from './domain/tripList'
import { AccommodationProvider } from './hooks/useAccommodation'
import { RouteStatesProvider } from './hooks/useRouteStates'
import { AmapLiveProvider } from './hooks/useAmapLive'

type AppView = 'loading' | 'trips' | 'guide'

/**
 * Ticket 02 shell: the trip list is the default view; the existing Hailar
 * guide app stays reachable (header button) and completely unchanged — the
 * back button below is rendered as an overlay sibling, not inside App.
 *
 * View selection:
 * - `?view=trips` / `?view=guide` force a view (deterministic entry points
 *   for tests and bookmarks).
 * - Otherwise the trips API is probed briefly: backend reachable → trip
 *   list; standalone frontend (no backend, e.g. the browser test harness) →
 *   the guide, preserving its historical default behavior.
 */
function viewFromUrl(): AppView | null {
  const param = new URLSearchParams(window.location.search).get('view')
  return param === 'trips' || param === 'guide' ? param : null
}

export default function AppShell() {
  const [view, setView] = useState<AppView>(() => viewFromUrl() ?? 'loading')

  useEffect(() => {
    if (view !== 'loading') return
    let cancelled = false
    void probeTripsApi().then((available) => {
      if (!cancelled) setView(available ? 'trips' : 'guide')
    })
    return () => {
      cancelled = true
    }
  }, [view])

  if (view === 'loading') {
    return (
      <div className="min-h-screen grid place-items-center bg-paper text-muted text-[13px]">加载中…</div>
    )
  }

  if (view === 'trips') {
    return <TripListPage onOpenGuide={() => setView('guide')} />
  }

  return (
    <>
      <button
        id="back-to-trips"
        type="button"
        title="返回行程列表"
        onClick={() => setView('trips')}
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
