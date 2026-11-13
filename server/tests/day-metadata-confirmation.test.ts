import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { MastraLanguageModel } from '@mastra/core/agent'
import { MockMemory } from '@mastra/core/memory'
import { InMemoryStore } from '@mastra/core/storage'
import { createApp } from '../src/app.js'
import { createSqliteDatabase } from '../src/db/driver.js'
import { ensureSchema } from '../src/db/schema.js'
import { TripRepository } from '../src/trips/repository.js'
import { SqliteTripStoreDriver } from '../src/trips/driver-sqlite.js'
import { createSqliteTripPatchStore } from '../src/trip-patch/store-sqlite.js'
import { createSqliteDaysAdminStore } from '../src/days-admin/driver-sqlite.js'
import { MemoryMessageStoreDriver } from '../src/chat/driver-memory.js'

const choice = '确认方案：调整整日安排'
const json = (body: unknown, method = 'POST'): RequestInit => ({ method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

/** Only the external language model is scripted; confirmation, HTTP and storage are real. */
function explainingModel() {
  let calls = 0
  const model: MastraLanguageModel = {
    specificationVersion: 'v2', provider: 'test.day-metadata', modelId: 'metadata-confirmation', supportedUrls: Promise.resolve({}),
    doGenerate: async () => { throw new Error('streaming only') },
    doStream: async () => {
      calls += 1
      const parts = calls === 1 ? [
        { type: 'stream-start', warnings: [] },
        { type: 'tool-call', toolCallId: 'explain', toolName: 'emit_round_meta', input: JSON.stringify({
          round: 'patch-explain', impacts: ['整日安排需要调整'], conflicts: [], chips: [{ label: '调整整日安排', value: choice }], thinkComplete: true,
        }) },
        { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
      ] : [
        { type: 'stream-start', warnings: [] }, { type: 'text-start', id: 'reply' },
        { type: 'text-delta', id: 'reply', delta: '请先确认调整方案。' }, { type: 'text-end', id: 'reply' },
        { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
      ]
      return { stream: new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close() } }) }
    },
  } as unknown as MastraLanguageModel
  return { model, calls: () => calls }
}

for (const field of ['title', 'note'] as const) {
  for (const through of ['HTTP', 'SQL'] as const) {
    test(`explain then change only Day.${field} through ${through} rejects stale confirmation before the model can write`, async (t) => {
      const db = createSqliteDatabase(':memory:')
      t.after(() => db.close())
      await ensureSchema(db)
      const repository = new TripRepository(new SqliteTripStoreDriver(db))
      const patchStore = createSqliteTripPatchStore(db)
      const scripted = explainingModel()
      const app = await createApp({
        tripRepository: repository, daysAdminStore: createSqliteDaysAdminStore(db), tripPatchStore: patchStore,
        messageStore: new MemoryMessageStoreDriver(), plannerModel: scripted.model,
        plannerMemory: new MockMemory({ storage: new InMemoryStore(), enableMessageHistory: true }),
      })
      const created = await repository.create({ title: '成都旅行', startDate: '2026-10-02', endDate: '2026-10-02' })
      assert.ok(created.ok)
      const tripId = created.trip.id
      await db.run('INSERT INTO days (id, trip_id, idx, date, theme, color, title, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', ['day', tripId, 0, '2026-10-02', '原主题', '原颜色', '原名称', '原备注'])
      const response = await app.request(`/api/trips/${tripId}/messages`, json({ content: '帮我重新安排这一天' }))
      assert.equal(response.status, 200)
      assert.match(await response.text(), /patch-explain/)
      const pending = await patchStore.getPatchConfirmation(tripId)
      assert.ok(pending)
      assert.ok(pending.choices.includes(choice))
      const modelCalls = scripted.calls()
      const before = (await db.run('SELECT * FROM days')).rows[0]!
      const tripBefore = (await db.run('SELECT * FROM trips')).rows
      if (through === 'HTTP') {
        const changed = await app.request(`/api/trips/${tripId}/days/day`, json({ [field]: '  新内容\n' }, 'PATCH'))
        assert.equal(changed.status, 200)
        assert.equal((await changed.json() as { day: Record<string, unknown> }).day[field], '  新内容\n')
      } else {
        // Isolate the snapshot field itself: no schedule or Trip timestamp mutation can invalidate this confirmation.
        await db.run(`UPDATE days SET ${field} = ? WHERE id = ?`, ['  新内容\n', 'day'])
        assert.deepEqual((await db.run('SELECT * FROM trips')).rows, tripBefore)
      }
      const after = (await db.run('SELECT * FROM days')).rows[0]!
      assert.deepEqual(after, { ...before, [field]: '  新内容\n' })
      const stale = await app.request(`/api/trips/${tripId}/messages`, json({ content: choice }))
      assert.equal(stale.status, 409)
      assert.equal((await stale.json() as { code: string }).code, 'confirmation_stale')
      assert.equal(scripted.calls(), modelCalls, 'stale confirmation is rejected before any model/tool execution')
      assert.deepEqual((await db.run('SELECT * FROM days')).rows, [after], 'old proposal cannot overwrite current metadata')
    })
  }
}
