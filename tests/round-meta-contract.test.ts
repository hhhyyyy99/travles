import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeRoundMeta, roundMetaInputSchema } from '@hailar/domain'

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
