import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeRoundMeta, roundMetaInputSchema, RoundMetaPayloadSchema } from '@hailar/domain'
import { longDriveWarnings, detectTimeConstraintConflicts } from '../server/src/chat/analysis.js'
import { normalizeChatMeta } from '../src/domain/chat'

test('round metadata retains valid structured content and normalizes empty fields', () => {
  const input = {
    round: 'clarify',
    chips: [{ label: '自驾', value: '自驾' }],
    poiLinks: [{ name: '海拉尔', lat: 49.2, lng: 119.7 }],
    thinkComplete: true,
    sources: [],
  }
  assert.equal(roundMetaInputSchema.safeParse(input).success, true)
  assert.deepEqual(normalizeRoundMeta(input), {
    round: 'clarify',
    chips: input.chips,
    poiLinks: input.poiLinks,
    thinkComplete: true,
  })
})

test('round metadata rejects invalid round types and invalid coordinates', () => {
  assert.equal(roundMetaInputSchema.safeParse({ round: 'unknown' }).success, false)
  assert.equal(roundMetaInputSchema.safeParse({ round: 'qa', poiLinks: [{ name: 'x', lat: 91, lng: 0 }] }).success, false)
  assert.deepEqual(normalizeRoundMeta({ round: 'unknown' }), { round: 'qa' })
})

test('persisted metadata accepts server-appended warnings and conflicts beyond tool limits', () => {
  const items = Array.from({ length: 22 }, (_, index) => ({
    id: `i${index}`, trip_id: 't1', day_id: 'd1', item_order: index,
    type: 'attraction', title: `地点${index}`, note: '', poi: null, images: '[]', pending: 0,
  }))
  const legs = items.slice(1).map((item, index) => ({
    id: `l${index}`, trip_id: 't1', from_item_id: `i${index}`, to_item_id: item.id,
    mode: 'drive', distance_km: 500, duration_min: 420, polyline: null,
  }))
  const warnings = longDriveWarnings(legs, items)
  assert.equal(warnings.length, 21)
  const modelMeta = normalizeRoundMeta({
    round: 'patch-explain', conflicts: Array.from({ length: 12 }, (_, i) => `模型冲突${i}`),
  })
  const serverConflicts = detectTimeConstraintConflicts('安排7天，2026-10-02到2026-10-05')
  assert.ok(serverConflicts.length > 0)
  const persisted = {
    ...modelMeta, warnings,
    conflicts: [...(modelMeta.conflicts ?? []), ...serverConflicts.map((conflict) => conflict.message)],
  }
  assert.deepEqual(RoundMetaPayloadSchema.parse(persisted), persisted)
  assert.deepEqual(normalizeChatMeta(persisted), persisted)
  assert.equal(roundMetaInputSchema.safeParse({ round: 'qa', warnings }).success, false)
  assert.equal(roundMetaInputSchema.safeParse({ round: 'qa', conflicts: persisted.conflicts }).success, false)
})
