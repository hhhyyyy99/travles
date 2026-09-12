import type { PoiSearch, RecommendationPoi } from './types.js'

/**
 * Server-side `search_poi` adapter. It talks to the AMap Web Service when a
 * key is configured and otherwise returns an empty result set; the workbench
 * remains usable with saved stash/favorite rows and injected test providers.
 */
export const searchAmapPoi: PoiSearch = async ({ query, region, type }) => {
  const key = process.env.AMAP_WEB_KEY ?? process.env.AMAP_KEY
  if (!key) return []
  const params = new URLSearchParams({
    key,
    keywords: query || type || '景点',
    offset: '20',
    page: '1',
    extensions: 'all',
  })
  if (region) params.set('city', region)
  const response = await fetch(`https://restapi.amap.com/v3/place/text?${params.toString()}`)
  if (!response.ok) throw new Error(`AMap HTTP ${response.status}`)
  const payload = (await response.json()) as { status?: string; pois?: Array<Record<string, unknown>> }
  if (payload.status !== '1' || !Array.isArray(payload.pois)) return []
  return payload.pois
    .map((poi) => normalizeAmapPoi(poi, type))
    .filter((poi): poi is RecommendationPoi => poi !== null)
}

function normalizeAmapPoi(poi: Record<string, unknown>, requestedType?: RecommendationPoi['type'] | null): RecommendationPoi | null {
  const name = text(poi.name)
  const location = text(poi.location)
  const coordinateParts = location.split(',')
  const lng = Number(coordinateParts[0])
  const lat = Number(coordinateParts[1])
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) return null
  const category = text(poi.type)
  const type = requestedType ?? classifyType(category)
  return {
    id: text(poi.id) || `amap-${name}-${location}`,
    amapId: text(poi.id),
    name,
    lat,
    lng,
    category,
    type,
    region: text(poi.adname) || text(poi.cityname) || text(poi.pname),
    rating: finite(poi.rating),
    introSummary: text(poi.businessarea) || text(poi.address),
    address: text(poi.address),
    images: [],
  }
}

function classifyType(category: string): RecommendationPoi['type'] {
  if (/餐饮|美食|咖啡|餐厅|火锅/.test(category)) return 'food'
  if (/酒店|住宿|民宿|旅馆/.test(category)) return 'stay'
  if (/景点|公园|风景|自然/.test(category)) return 'attraction'
  return 'other'
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function finite(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}
