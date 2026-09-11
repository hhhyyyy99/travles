/**
 * Document-global print behavior (ticket 08) — port of trip.js:254:
 * `beforeprint` snapshots the open state of ALL `<details>` elements in the
 * document (including the AMap live panel's `.road-details`), opens them so
 * print shows full content; `afterprint` restores them by index.
 *
 * Listeners are added exactly once per mount and removed on unmount, so
 * repeated printing (or a React StrictMode double-mount in dev) never
 * accumulates handlers. `window.__tibetPrintHandlerCount` mirrors the live
 * listener-bundle count — a QA seam the app browser suite reads to assert
 * the no-accumulation contract directly.
 */
import { useCallback, useEffect } from 'react'

declare global {
  interface Window {
    /** QA seam: number of active beforeprint/afterprint listener bundles. */
    __tibetPrintHandlerCount?: number
  }
}

export function usePrint(): () => void {
  useEffect(() => {
    window.__tibetPrintHandlerCount = (window.__tibetPrintHandlerCount ?? 0) + 1

    let detailOpenState: boolean[] = []
    const beforePrint = () => {
      const details = [...document.querySelectorAll('details')]
      detailOpenState = details.map((element) => element.open)
      details.forEach((element) => {
        element.open = true
      })
    }
    const afterPrint = () => {
      document.querySelectorAll('details').forEach((element, index) => {
        element.open = detailOpenState[index] ?? element.open
      })
    }
    window.addEventListener('beforeprint', beforePrint)
    window.addEventListener('afterprint', afterPrint)
    return () => {
      window.__tibetPrintHandlerCount = Math.max(0, (window.__tibetPrintHandlerCount ?? 1) - 1)
      window.removeEventListener('beforeprint', beforePrint)
      window.removeEventListener('afterprint', afterPrint)
    }
  }, [])

  return useCallback(() => {
    window.print()
  }, [])
}