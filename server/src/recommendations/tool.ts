import { GeographicCheckSchema } from '@hailar/domain'
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { searchAmapPoi } from './search.js'
import { normalizePoi } from './repository.js'
import { drivingRouteKey, pendingRoute, routeAmapLeg } from './route.js'
import type { DrivingRouteCheck, PoiSearch, RouteLegSearch } from './types.js'

export const SEARCH_POI_TOOL_NAME = 'search_poi'
export const ROUTE_CHECKS_CONTEXT_KEY = 'chat.routeChecks'

const searchPoiInputSchema = z.object({
  query: z.string().max(120).default('').describe('关键词，例如「额尔古纳湿地」或「沿途观景营地」'),
  region: z.string().max(80).optional().describe('地区筛选，例如「额尔古纳」'),
  type: z.enum(['attraction', 'food', 'stay', 'other']).optional().describe('点位类型'),
})

/** Mastra tool and HTTP search route share the same injected provider. */
export function createSearchPoiTool(provider: PoiSearch = searchAmapPoi) {
  return createTool({
    id: SEARCH_POI_TOOL_NAME,
    description: '检索高德 POI 推荐。需要给用户推荐景点、餐饮、住宿或沿途点位时先调用；不要凭空编造坐标。',
    inputSchema: searchPoiInputSchema,
    execute: async (input) => {
      try {
        const pois = await provider(input)
        return { ok: true as const, pois: (Array.isArray(pois) ? pois : []).map(normalizePoi).filter((poi) => poi !== null) }
      } catch {
        return { ok: false as const, pois: [], error: '推荐点位暂不可用。' }
      }
    },
  })
}

const stayReferenceInputSchema = z.object({
  query: z.string().max(120).default('酒店').describe('住宿关键词，例如「额尔古纳民宿」'),
  region: z.string().max(80).optional().describe('住宿地区，例如「室韦」'),
  nights: z.number().int().min(1).max(30).optional().describe('参考入住晚数'),
})

/** Reuse the shared POI channel for AI follow-up chips asking for lodging. */
export function createSearchStayReferenceTool(provider: PoiSearch = searchAmapPoi) {
  return createTool({
    id: 'search_stay_reference',
    description: '检索住宿参考。需要酒店或民宿建议时调用；只返回搜索到的参考点位，不代表已经预订。',
    inputSchema: stayReferenceInputSchema,
    execute: async (input) => {
      try {
        const pois = await provider({ query: input.query || '酒店', ...(input.region ? { region: input.region } : {}), type: 'stay' })
        const stays = (Array.isArray(pois) ? pois : []).map(normalizePoi).filter((poi) => poi !== null)
        return { ok: true as const, stays, recommendations: stays }
      } catch {
        return { ok: false as const, stays: [], recommendations: [], error: '住宿参考暂不可用。' }
      }
    },
  })
}

const routePointSchema = z.object({
  name: z.string().max(160).optional(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
})
const routePairSchema = z.object({ from: routePointSchema, to: routePointSchema })
const routeLegsInputSchema = z
  .object({
    from: routePointSchema.optional(),
    to: routePointSchema.optional(),
    legs: z.array(routePairSchema).max(20).optional(),
  })
  .refine((input) => Array.isArray(input.legs) ? input.legs.length > 0 : input.from !== undefined && input.to !== undefined, {
    message: '请提供 from/to 或至少一组 legs。',
  })

/** Route lookup tool; no-key responses stay pending instead of fake metrics. */
export function createRouteLegsTool(provider: RouteLegSearch = routeAmapLeg) {
  return createTool({
    id: 'route_legs',
    description: '查询相邻地点的驾车距离、时长和路线。没有路线服务或坐标不可用时返回 pending，不要把估算当成实测。',
    inputSchema: routeLegsInputSchema,
    execute: async (input, context) => {
      const pairs = input.legs ?? [{ from: input.from!, to: input.to! }]
      const legs = await Promise.all(
        pairs.map(async (pair) => {
          try {
            return await provider(pair)
          } catch {
            return pendingRoute('路线服务暂不可用。')
          }
        }),
      )
      const checks = context?.requestContext?.get(ROUTE_CHECKS_CONTEXT_KEY) as DrivingRouteCheck[] | undefined
      if (checks) {
        for (const [index, leg] of legs.entries()) {
          // A zero can be a rounded sub-minute result or coerced missing provider data.
          if (leg?.status !== 'ok' || leg.source !== 'amap' || !(leg.durationMin && leg.durationMin > 0)) continue
          const pair = pairs[index]!
          const parsed = GeographicCheckSchema.safeParse({
            from: pair.from.name, to: pair.to.name, durationMin: leg.durationMin, source: 'amap', estimated: false,
          })
          const routeKey = drivingRouteKey(pair.from, pair.to)
          if (routeKey && parsed.success) checks.push({ routeKey, value: parsed.data })
        }
      }
      return { ok: true as const, legs, ...(legs.length === 1 ? { leg: legs[0] } : {}) }
    },
  })
}
