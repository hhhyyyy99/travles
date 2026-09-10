/**
 * Typed port of `data/road-routes.js` (window.roadRoutes) — content byte-faithful.
 *
 * All coordinates are [lng, lat] (AMap order). Trip.js converted them to
 * [lat, lng] exactly once (`roadLines`, trip.js:84) — mirrored below for the
 * Leaflet boundary.
 */
import type { LatLng, LngLat, RoadRoutes } from '../domain/types'

export const roadRoutes: RoadRoutes = {
  provider: '示意连线 / 规划估算',
  retrieved: '2026-09-08',
  waypoints: [
    { coordinates: [119.826, 49.205] },
    { coordinates: [119.766, 49.212] },
    { coordinates: [119.62, 49.35] },
    { coordinates: [120.183, 50.243] },
    { coordinates: [120.78, 51.26] },
    { coordinates: [119.9, 51.34] },
    { coordinates: [119.28, 50.12] },
    { coordinates: [118.98, 49.88] },
    { coordinates: [117.452, 49.597] },
    { coordinates: [117.58, 48.97] },
  ],
  legs: [
    {
      distance: 6000,
      duration: 900,
      coordinates: [
        [119.826, 49.205],
        [119.766, 49.212],
      ],
      roads: ['机场路'],
    },
    {
      distance: 150000,
      duration: 9900,
      coordinates: [
        [119.766, 49.212],
        [119.62, 49.35],
        [120.183, 50.243],
      ],
      roads: ['G332'],
    },
    {
      distance: 220000,
      duration: 14400,
      coordinates: [
        [120.183, 50.243],
        [120.78, 51.26],
      ],
      roads: ['G332', 'S301'],
    },
    {
      distance: 250000,
      duration: 17100,
      coordinates: [
        [120.78, 51.26],
        [119.9, 51.34],
        [119.28, 50.12],
      ],
      roads: ['S201', 'G331'],
    },
    {
      distance: 220000,
      duration: 11700,
      coordinates: [
        [119.28, 50.12],
        [118.98, 49.88],
        [117.452, 49.597],
      ],
      roads: ['G331', 'G10'],
    },
    {
      distance: 240000,
      duration: 11700,
      coordinates: [
        [117.452, 49.597],
        [117.58, 48.97],
        [119.766, 49.212],
      ],
      roads: ['G10', 'G301'],
    },
    {
      distance: 6000,
      duration: 900,
      coordinates: [
        [119.766, 49.212],
        [119.826, 49.205],
      ],
      roads: ['机场路'],
    },
  ],
}

/**
 * Identity day-index → leg-index map (legacy trip.js:7). Days, estimates and
 * legs are index-locked; keep it an identity map (note A §7 gotcha 5).
 */
export const legByDay: Readonly<Record<number, number>> = { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6 }

/** [lng, lat] → [lat, lng] conversion done once (legacy trip.js:84). */
export function toLatLng(coordinates: LngLat[]): LatLng[] {
  return coordinates.map(([lng, lat]) => [lat, lng])
}

/** All 7 legs converted to leaflet [lat, lng] order. */
export const roadLines: LatLng[][] = roadRoutes.legs.map((leg) => toLatLng(leg.coordinates))