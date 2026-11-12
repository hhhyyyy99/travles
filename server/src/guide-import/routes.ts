import type { Hono } from 'hono'
import { GuideImportRequestSchema } from '@hailar/domain'
import type { AppEnv } from '../app.js'
import type { SqlDatabase } from '../db/driver.js'
import { readJsonBody } from '../http/body.js'
import { GuideImportConflict, importGuide } from './repository.js'

export function registerGuideImportRoutes(app: Hono<AppEnv>, resolveDatabase: () => SqlDatabase | null): void {
  app.post('/api/trips/from-guide', async (c) => {
    const parsed = GuideImportRequestSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) {
      return c.json({ error: '攻略导入内容无效，请检查标题、天数和活动（最多 100 条）。', code: 'invalid_request' }, 400)
    }
    try {
      const db = resolveDatabase()
      if (!db) throw new Error('Guide import database unavailable')
      const trip = await importGuide(db, parsed.data)
      return c.json({ trip }, 201)
    } catch (error) {
      if (error instanceof GuideImportConflict) return c.json({ error: error.message, code: 'import_conflict' }, 409)
      return c.json({ error: '保存失败，请重试。', code: 'storage_error' }, 500)
    }
  })
}
