import type { Mastra } from '@mastra/core'
import type { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { GuideParseRequestSchema, GuideParseResultSchema } from '@hailar/domain'
import type { AppEnv } from '../app.js'
import { readJsonBody } from '../http/body.js'
import { PARSE_LINK_WORKFLOW_ID } from './workflow.js'

/** Standalone preview for the future home entry. It never creates/edits a trip. */
export function registerGuideParsingRoutes(app: Hono<AppEnv>, mastra: Mastra): void {
  app.post('/api/ai/parse-guide', bodyLimit({
    maxSize: 90_000,
    onError: (c) => c.json({ error: '攻略正文过长，请缩短后重试。', code: 'invalid_request' }, 413),
  }), async (c) => {
    const input = GuideParseRequestSchema.safeParse(await readJsonBody(c))
    if (!input.success) return c.json({ error: '请提供有效的攻略链接或正文（最多 20000 字）。', code: 'invalid_request' }, 400)
    try {
      const run = await mastra.getWorkflow(PARSE_LINK_WORKFLOW_ID).createRun()
      const result = await run.start({ inputData: input.data })
      const parsed = GuideParseResultSchema.safeParse(result.status === 'success' ? result.result : null)
      if (!parsed.success) return c.json({ error: '攻略解析暂不可用，请稍后重试。', code: 'workflow_failed' }, 502)
      const output = parsed.data
      if (output.status === 'error') {
        const status = output.code === 'model_unconfigured' ? 503 : output.code === 'invalid_extraction' ? 422 : 502
        return c.json(output, status)
      }
      return c.json(output)
    } catch {
      return c.json({ error: '攻略解析暂不可用，请稍后重试。', code: 'workflow_failed' }, 502)
    }
  })
}
