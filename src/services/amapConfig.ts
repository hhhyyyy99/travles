/**
 * AMap local config discovery (ticket 03) — port of `amap-config.js`
 * (window.TIBET_AMAP_CONFIG) + the default-config hook of amap-integration.js:4–5.
 *
 * - When `window.TIBET_AMAP_CONFIG` is already set (test fixture or a classic
 *   script that ran earlier) it is read directly.
 * - Otherwise `/amap-config.js` is injected exactly once; when it is absent or
 *   404s (tests / plain static hosting) the promise resolves to `null` and the
 *   app stays on the reference (Leaflet) map — this module never throws and
 *   never routes the visitor toward credential forms.
 */

export interface AmapConfig {
  key: string
  securityJsCode: string
  /** Dead config today (`mapType`/`showRoadNet`/`serviceHost` are never consumed) — kept for the contract. */
  mapType?: string
  showRoadNet?: boolean
  serviceHost?: string
}

declare global {
  interface Window {
    TIBET_AMAP_CONFIG?: AmapConfig
  }
}

const CONFIG_SCRIPT_SRC = '/amap-config.js'
const CONFIG_LOAD_TIMEOUT_MS = 20000

function readGlobalConfig(): AmapConfig | null {
  const config = window.TIBET_AMAP_CONFIG
  if (!config || !config.key || !config.securityJsCode) return null
  return {
    key: config.key,
    securityJsCode: config.securityJsCode,
    mapType: config.mapType,
    showRoadNet: config.showRoadNet,
    serviceHost: config.serviceHost,
  }
}

let configPromise: Promise<AmapConfig | null> | null = null

function injectConfigScript(): Promise<AmapConfig | null> {
  return new Promise((resolve) => {
    const script = document.createElement('script')
    let timer = 0
    let settled = false
    const settle = (): void => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      script.remove()
      resolve(readGlobalConfig())
    }
    timer = window.setTimeout(settle, CONFIG_LOAD_TIMEOUT_MS)
    script.onload = settle
    script.onerror = (): void => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      script.remove()
      resolve(null)
    }
    script.src = CONFIG_SCRIPT_SRC
    document.head.append(script)
  })
}

/**
 * Resolve the AMap config (or `null`). Safe to call repeatedly; the script is
 * injected at most once per page. Never rejects.
 */
export function discoverAmapConfig(): Promise<AmapConfig | null> {
  const direct = readGlobalConfig()
  if (direct) return Promise.resolve(direct)
  if (!configPromise) configPromise = injectConfigScript()
  return configPromise
}