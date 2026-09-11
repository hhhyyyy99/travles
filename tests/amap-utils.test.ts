import { test } from 'node:test'
import assert from 'node:assert/strict'
import { colors, duration, escapeHtml, statuses, traffic } from '../src/domain/amapUtils'

// Replacement for tests/amap-utils.test.cjs (ticket 03): the loading target
// changed from the legacy UMD `amap-utils.js` to the new TS module; every
// legacy scenario is preserved verbatim (missing coverage, partial coverage,
// duration, escapeHtml), plus the statuses/colors surface is asserted.

test('statuses and colors expose the five legacy traffic states', () => {
  assert.deepEqual(statuses, ['畅通', '缓行', '拥堵', '严重拥堵', '未知'])
  assert.equal(colors['畅通'], '#259b57')
  assert.equal(colors['缓行'], '#dfaa23')
  assert.equal(colors['拥堵'], '#e44b45')
  assert.equal(colors['严重拥堵'], '#a41d32')
  assert.equal(colors['未知'], '#8b949b')
})

test('missing traffic coverage is unknown, not clear', () => {
  const result = traffic({ distance: 10000, steps: [{ path: [] }] })
  assert.equal(result.totals['未知'], 10000)
  assert.equal(result.known, false)
})

test('partial traffic coverage preserves the unreported distance', () => {
  const result = traffic({
    distance: 10000,
    steps: [{ tmcs: [{ status: '畅通', distance: 5000 }, { status: '拥堵', distance: 2000 }, { status: '未支持', distance: 1000 }] }],
  })
  assert.equal(result.totals['畅通'], 5000)
  assert.equal(result.totals['拥堵'], 2000)
  assert.equal(result.totals['未知'], 3000)
  assert.equal(result.known, true)
})

test('duration converts seconds and never invents a missing estimate', () => {
  assert.equal(duration(5400), '1 小时 30 分钟')
  assert.equal(duration(undefined), '暂无时间')
  assert.equal(duration(null), '暂无时间')
})

test('escapeHtml is shared by browser renderers and preserves text boundaries', () => {
  assert.equal(escapeHtml(`<住宿 & "测试">'`), '&lt;住宿 &amp; &quot;测试&quot;&gt;&#39;')
  assert.equal(escapeHtml(null), '')
})