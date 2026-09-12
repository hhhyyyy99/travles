import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { searchAmapPoi } from './search.js'
import type { PoiSearch } from './types.js'

export const SEARCH_POI_TOOL_NAME = 'search_poi'

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
    execute: async (input) => ({ ok: true as const, pois: await provider(input) }),
  })
}
