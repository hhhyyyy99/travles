import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  printRouteInfo,
  printScheduleRows,
  printSheetSummary,
} from '../src/domain/printItinerary'
import { createInitialRouteStates } from '../src/domain/routeStates'
import type { AccommodationState, RouteState } from '../src/domain/types'

// Ticket 08 — pure print derivation suite: the exact 5-level route-label
// precedence of the legacy accommodation-print.js (note D §1.3), with the
// "unupdated route must never show a stale estimate as current" guard, plus
// schedule/stay/summary helpers. The DOM contract itself is covered by
// tests/app/08-print.app.browser.cjs.

const EMPTY: AccommodationState = { version: 1, bases: [], stays: {} }

/** State with a custom area base applied to nights 1 and 2 (legacy fixture shape). */
function customAreaState(): AccommodationState {
  return {
    version: 1,
    bases: [
      {
        id: 'custom-long-stay',
        name: '北境超长名称住宿基地示例用于换行测试',
        type: 'area',
        lat: 50.12,
        lng: 119.98,
        address: '额尔古纳市一条很长很长的代表地址，用于验证打印版不会裁切文本',
        notes: '这是需要完整保留在打印版中的入住备注，包含供暖、停车和晚间抵达说明。',
        createdAt: '2026-09-08T00:00:00.000Z',
        isDefault: false,
      },
    ],
    stays: { 1: 'custom-long-stay', 2: 'custom-long-stay' },
  }
}

function updatedState(day: number, extra: Partial<RouteState> = {}): Record<number, RouteState> {
  const states = createInitialRouteStates(7)
  states[day] = {
    ...states[day]!,
    status: 'updated',
    distance: 43210,
    duration: 5678,
    durationText: '1 小时 30 分钟',
    ...extra,
  }
  return states
}

test('updated route prints the resolved km + duration label', () => {
  const route = printRouteInfo(EMPTY, updatedState(0), 0)
  assert.equal(route.label, '已更新 43.2 km · 1 小时 30 分钟')
  assert.equal(route.status, 'updated')
  assert.equal(route.stale, false)
})

test('updated route falls back to 驾车时间已更新 without a duration text', () => {
  const route = printRouteInfo(EMPTY, updatedState(0, { durationText: undefined }), 0)
  assert.equal(route.label, '已更新 43.2 km · 驾车时间已更新')
})

test('pending state prints 路线未更新 with the re-querying note, never a stale estimate', () => {
  const states = createInitialRouteStates(7)
  states[3] = { ...states[3]!, status: 'pending', token: 1 }
  const route = printRouteInfo(EMPTY, states, 3)
  assert.equal(route.label, '路线未更新')
  // default stays are area-typed, so the faithful legacy note also carries the
  // representative-position disclaimer
  assert.equal(route.note, '住宿端点已变化，路线正在重新查询。 住宿区域按代表位置估算。')
  assert.equal(route.status, 'unupdated')
  assert.equal(route.stale, true)
  assert.equal(route.label.includes('约 250 km'), false, 'stale branch hides the static estimate')
})

test('unupdated service failure prints 路线未更新 with the before-departure note', () => {
  const states = createInitialRouteStates(7)
  states[2] = { ...states[2]!, status: 'unupdated', token: 1 }
  const route = printRouteInfo(EMPTY, states, 2)
  assert.equal(route.label, '路线未更新')
  assert.equal(route.note, '住宿端点已变化，当前没有可用的新路线结果，请出发前重新查询。 住宿区域按代表位置估算。')
  assert.equal(route.label.includes('约 220 km'), false)
})

test('a changed-endpoint day with reference status still prints 路线未更新 (stale guard)', () => {
  // Custom stay on nights 1+2 changes routes 1/2 (and 3 via the night-2 stay)
  // even while the route-state store still says 'reference' — the changed
  // endpoint must win over the static leg, not show 约 150/220 km as current.
  const state = customAreaState()
  const reference = createInitialRouteStates(7)
  const route1 = printRouteInfo(state, reference, 1)
  const route2 = printRouteInfo(state, reference, 2)
  const route3 = printRouteInfo(state, reference, 3)
  assert.equal(route1.label, '路线未更新')
  assert.equal(route2.label, '路线未更新')
  assert.equal(route3.label, '路线未更新')
  assert.equal(route1.stale, true)
  assert.equal(route1.status, 'unupdated')
  for (const route of [route1, route2, route3]) {
    assert.equal(route.label.match(/约 \d+ km/), null, 'no stale estimate as current')
  }
  // unchanged day 0 keeps its reference leg estimate
  const route0 = printRouteInfo(state, reference, 0)
  assert.equal(route0.label, '参考里程约 6 km')
  assert.equal(route0.status, 'reference')
})

test('changed-endpoint route names come from the accommodation route, not the plan nav', () => {
  const state = customAreaState()
  const reference = createInitialRouteStates(7)
  const route1 = printRouteInfo(state, reference, 1)
  // from = night-1 stay name (海拉尔), not the plan nav label
  assert.equal(route1.from, '海拉尔')
  assert.equal(route1.to, '北境超长名称住宿基地示例用于换行测试')
})

test('reference days print the G/S road-suffixed leg estimate', () => {
  const route1 = printRouteInfo(EMPTY, createInitialRouteStates(7), 1)
  assert.equal(route1.label, '参考里程约 150 km · G332')
  assert.equal(route1.note, '里程与时间为规划参考，出发前请以实时导航为准。 住宿区域按代表位置估算。')
  assert.equal(route1.status, 'reference')
  assert.equal(route1.stale, false)
})

test('area stays append the representative-position disclaimer', () => {
  const state = customAreaState()
  const route = printRouteInfo(state, createInitialRouteStates(7), 1)
  assert.ok(route.note.endsWith('住宿区域按代表位置估算。'), route.note)
})

test('stale schedule rows gain the re-query reminder as a third column', () => {
  const day = {
    date: '10.03',
    weekday: '周六',
    title: '莫尔格勒河，再看额尔古纳湿地',
    short: '海拉尔 → 额尔古纳',
    drive: '约 150 km / 2.5–3 小时',
    stay: '额尔古纳 · 1 晚',
    alt: '约 580–650 m',
    pace: '草原与湿地',
    points: ['hailar', 'morigele', 'erguna'],
    nav: ['海拉尔市区', '额尔古纳湿地景区'] as [string, string],
    cities: ['呼伦贝尔市', '呼伦贝尔市'] as [string, string],
    via: [{ keyword: '莫尔格勒河', city: '呼伦贝尔市' }],
    desc: 'desc',
    schedule: [
      ['09:00', '海拉尔出发', '走正常导航道路。'],
      ['10:30', '莫尔格勒河短暂停留', '约 1 小时左右离开。'],
    ],
    tip: 'tip',
  }
  const normal = printScheduleRows(day, false)
  assert.equal(normal[0]![2], '走正常导航道路。')
  const stale = printScheduleRows(day, true)
  assert.equal(stale[0]![2], '当前住宿端点的路线未更新，出发前请重新查询。')
})

test('header summary derives night count and used base count from the authoritative state', () => {
  const summary = printSheetSummary(customAreaState())
  assert.equal(summary.nightCount, 6)
  assert.equal(summary.usedBaseCount, 4, 'hailar + custom + heishantou + manzhouli — never the unused backup')
  assert.equal(summary.areaUsed, true)
  const defaults = printSheetSummary(EMPTY)
  assert.equal(defaults.usedBaseCount, 5)
  // all shipped defaults are area-typed → the header keeps the disclaimer
  assert.equal(defaults.areaUsed, true)
})