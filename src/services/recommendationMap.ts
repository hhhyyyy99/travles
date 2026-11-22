/** Leaflet boundary for ticket 15 recommendation markers. */
import L from 'leaflet'
import { escapeHtml } from '../domain/amapUtils'
import type { RouteMapHandle } from './map'
import type { RecommendationPoi } from '../domain/recommendations'

export type RecommendationMarker = RecommendationPoi & { saved?: boolean }

export function renderRecommendationPois(
  handle: RouteMapHandle,
  pois: Array<RecommendationMarker | null>,
  onPoiClick: (id: string) => void,
): void {
  handle.workbenchRecommendationLayer.clearLayers()
  for (const poi of pois) {
    if (poi === null) continue
    const marker = L.marker([poi.lat, poi.lng], {
      icon: L.divIcon({
        className: `wb-recommendation-marker${poi.saved ? ' wb-recommendation-marker-saved' : ''}`,
        html: `<button type="button" class="wb-recommendation-marker-dot" data-recommendation-marker="${escapeHtml(poi.id)}" title="${escapeHtml(poi.name)}">${poi.saved ? '★' : '推荐'}</button>`,
        iconSize: [34, 24],
        iconAnchor: [17, 12],
      }),
      keyboard: false,
      zIndexOffset: 500,
    })
    marker.on('click', () => onPoiClick(poi.id))
    marker.addTo(handle.workbenchRecommendationLayer)
  }
}
