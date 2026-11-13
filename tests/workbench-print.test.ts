import { test } from 'node:test'
import assert from 'node:assert/strict'

import { workbenchPrintRoute } from '../src/components/workbench/WorkbenchPrintSheet'
import type { PoiRef, WorkbenchDay, WorkbenchItem, WorkbenchLeg } from '../src/domain/workbench'

function poi(name: string, lat: number, lng: number): PoiRef {
  return { amapId: '', name, lat, lng, category: '景点', rating: 0, introSummary: '' }
}

function item(id: string, dayId: string, order: number, title: string, point: PoiRef | null, type: WorkbenchItem['type'] = 'attraction'): WorkbenchItem {
  return { id, dayId, order, type, title, note: '', poi: point, images: [], pending: false }
}

function day(id: string, index: number, items: WorkbenchItem[]): WorkbenchDay {
  return { id, index, date: '', theme: `第 ${index + 1} 天`, color: '', items }
}

test('workbench print route derives custom current cards and explicit quality', () => {
  const first = day('custom-1', 0, [item('a', 'custom-1', 0, '自定义起点', poi('自定义起点', 49.2, 119.7))])
  const second = day('custom-2', 1, [
    item('b', 'custom-2', 0, '当前住宿', poi('当前住宿', 49.3, 119.8), 'stay'),
    item('c', 'custom-2', 1, '当前景点', poi('当前景点', 49.4, 119.9)),
  ])
  const bridge: WorkbenchLeg = {
    id: 'bridge',
    fromItemId: 'a',
    toItemId: 'b',
    mode: 'drive',
    distanceKm: 22.2,
    durationMin: 24,
    polyline: [[119.7, 49.2], [119.8, 49.3]],
    quality: 'reference',
    distanceMeters: 22200,
    durationSeconds: 1440,
    formattedDistance: '22.2 千米',
    formattedDuration: '24 分钟',
  }
  const inside: WorkbenchLeg = {
    id: 'inside',
    fromItemId: 'b',
    toItemId: 'c',
    mode: 'drive',
    distanceKm: 10,
    durationMin: 12,
    polyline: [[119.8, 49.3], [119.9, 49.4]],
    quality: 'measured',
  }
  const route = workbenchPrintRoute(second, [bridge, inside], first)
  assert.deepEqual({ from: route.from, to: route.to, status: route.status }, { from: '自定义起点', to: '当前景点', status: 'estimate' })
  assert.match(route.label, /约 32\.2 千米 · 36 分钟/)
  assert.match(route.note, /规划参考/)
})

test('workbench print route never invents a route label for a missing leg', () => {
  const current = day('custom-1', 0, [item('a', 'custom-1', 0, '待定起点', null), item('b', 'custom-1', 1, '待定终点', null)])
  const route = workbenchPrintRoute(current, [])
  assert.equal(route.status, 'pending')
  assert.equal(route.label, '路线待查询')
})

test('workbench print route marks a partial route instead of calling it measured', () => {
  const current = day('custom-1', 0, [
    item('a', 'custom-1', 0, '起点', poi('起点', 49.2, 119.7)),
    item('b', 'custom-1', 1, '中点', poi('中点', 49.3, 119.8)),
    item('c', 'custom-1', 2, '终点', poi('终点', 49.4, 119.9)),
  ])
  const route = workbenchPrintRoute(current, [{
    id: 'a-b', fromItemId: 'a', toItemId: 'b', mode: 'drive', distanceKm: 10, durationMin: 12,
    polyline: [[119.7, 49.2], [119.8, 49.3]], quality: 'measured',
  }])
  assert.equal(route.status, 'partial')
  assert.match(route.label, /部分路线/)
  assert.match(route.label, /^约 /)
  assert.match(route.note, /仅部分路段/)
})
