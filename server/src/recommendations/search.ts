import type { PoiSearch, RecommendationPoi } from './types.js'
import { gcj02ToWgs84LngLat } from './geo.js'

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
    keywords: query || typeKeyword(type) || '景点',
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
  const sourceLng = Number(coordinateParts[0])
  const sourceLat = Number(coordinateParts[1])
  if (!name || !Number.isFinite(sourceLat) || !Number.isFinite(sourceLng)) return null
  const [lng, lat] = gcj02ToWgs84LngLat(sourceLng, sourceLat)
  const category = text(poi.type)
  const type = requestedType ?? classifyType(category)
  const business = poi.biz_ext !== null && typeof poi.biz_ext === 'object' ? (poi.biz_ext as Record<string, unknown>) : {}
  const rating = finite(poi.rating) || finite(business.rating)
  return {
    id: text(poi.id) || `amap-${name}-${sourceLng},${sourceLat}`,
    amapId: text(poi.id),
    name,
    lat,
    lng,
    category,
    type,
    region: text(poi.adname) || text(poi.cityname) || text(poi.pname),
    rating,
    introSummary: text(poi.businessarea) || text(poi.address),
    address: text(poi.address),
    images: extractImages(poi.photos),
  }
}

function extractImages(value: unknown): Array<{ url: string; caption: string }> {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => {
      if (entry === null || typeof entry !== 'object') return null
      const record = entry as Record<string, unknown>
      const url = text(record.url)
      return url ? { url, caption: text(record.title) } : null
    })
    .filter((entry): entry is { url: string; caption: string } => entry !== null)
    .slice(0, 12)
}

function typeKeyword(type: RecommendationPoi['type'] | null | undefined): string {
  if (type === 'stay') return '酒店 民宿 住宿'
  if (type === 'food') return '餐饮 美食'
  if (type === 'attraction') return '景点 风景区'
  return ''
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
