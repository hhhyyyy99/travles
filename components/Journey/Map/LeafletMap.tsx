'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import L from 'leaflet';
import { tripPlan } from '@/data/trip-plan';
import { roadRoutes } from '@/data/road-routes';

interface LeafletMapProps {
  selectedDay: number;
  isOverview: boolean;
  onSelectDay: (dayIndex: number) => void;
  onOverviewChange: (isOverview: boolean) => void;
}

const legByDay: Record<number, number> = { 0: 0, 1: 1, 2: 2, 4: 3, 5: 4, 6: 5 };
const allKeys = ['airportN', 'nyingchi', 'suosong', 'basong', 'gongga', 'yamdrok', 'lhasa'];
const pointToDay: Record<string, number> = {
  airportN: 0,
  nyingchi: 0,
  suosong: 1,
  basong: 3,
  gongga: 4,
  yamdrok: 5,
  lhasa: 6,
};

function routeMidpoint(coords: [number, number][]): [number, number] {
  const lengths = coords.slice(1).map((point, i) => L.latLng(coords[i]).distanceTo(point));
  const halfway = lengths.reduce((a, b) => a + b, 0) / 2;
  let distance = 0;
  for (let i = 0; i < lengths.length; i++) {
    if (distance + lengths[i] >= halfway) return coords[i];
    distance += lengths[i];
  }
  return coords[Math.floor(coords.length / 2)];
}

export default function LeafletMap({
  selectedDay,
  isOverview,
  onSelectDay,
  onOverviewChange,
}: LeafletMapProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const fullRouteLayerRef = useRef<L.LayerGroup | null>(null);
  const selectedLayerRef = useRef<L.LayerGroup | null>(null);
  const timeLabelLayerRef = useRef<L.LayerGroup | null>(null);
  const [mapError, setMapError] = useState(false);

  // Road lines in [lat, lng]
  const roadLinesRef = useRef<[number, number][][]>(
    roadRoutes.legs.map((leg) =>
      leg.coordinates.map(([lng, lat]) => [lat, lng] as [number, number])
    )
  );

  const showTimeLabels = useCallback((indices: number[]) => {
    if (!timeLabelLayerRef.current) return;
    timeLabelLayerRef.current.clearLayers();
    indices.forEach((index) => {
      const estimate = tripPlan.estimates[index];
      const coords = roadLinesRef.current[index];
      if (!estimate || !coords) return;
      const midpoint = routeMidpoint(coords);
      const isAltAnchor = index === 0 || index === 3;
      L.marker(midpoint, {
        icon: L.divIcon({
          className: `route-time-marker route-time-${index}`,
          html: `<small>${estimate.title}</small><strong>${estimate.time}</strong><span>行程预估</span>`,
          iconSize: [116, 57],
          iconAnchor: [58, isAltAnchor ? -12 : 70],
        }),
        keyboard: false,
        interactive: false,
        zIndexOffset: 800,
      }).addTo(timeLabelLayerRef.current!);
    });
  }, []);

  // Initialize Map
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const map = L.map(mapContainerRef.current, {
      zoomControl: false,
      scrollWheelZoom: false,
      minZoom: 5,
      maxZoom: 16,
    }).setView([29.7, 92.5], 7);

    mapRef.current = map;

    const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · Routing: OSRM',
      maxZoom: 19,
    }).addTo(map);

    const satellite = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      {
        attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
        maxNativeZoom: 17,
      }
    );

    L.control
      .layers({ 道路地图: tiles, 卫星地图: satellite }, undefined, {
        position: 'topright',
      })
      .addTo(map);

    L.control.zoom({ position: 'bottomright' }).addTo(map);

    let tileErrors = 0;
    tiles.on('tileerror', () => {
      tileErrors++;
      if (tileErrors >= 3) setMapError(true);
    });
    tiles.on('tileload', () => {
      tileErrors = 0;
      setMapError(false);
    });

    const fullRouteLayer = L.layerGroup().addTo(map);
    fullRouteLayerRef.current = fullRouteLayer;

    const selectedLayer = L.layerGroup().addTo(map);
    selectedLayerRef.current = selectedLayer;

    const timeLabelLayer = L.layerGroup().addTo(map);
    timeLabelLayerRef.current = timeLabelLayer;

    roadLinesRef.current.forEach((coords) => {
      L.polyline(coords, { color: '#fff', weight: 8, opacity: 1 }).addTo(
        fullRouteLayer
      );
      L.polyline(coords, { color: '#2474db', weight: 5, opacity: 0.85 }).addTo(
        fullRouteLayer
      );
    });

    // Base point markers
    allKeys.forEach((k) => {
      const p = tripPlan.points[k];
      if (!p) return;
      L.circleMarker(p.xy, {
        radius: 6,
        color: '#fff',
        weight: 2,
        fillColor: '#c36a4f',
        fillOpacity: 1,
      })
        .addTo(map)
        .bindTooltip(p.name, { permanent: false, direction: 'top' })
        .on('click', () => {
          const day = pointToDay[k];
          if (day !== undefined) {
            onSelectDay(day);
            onOverviewChange(false);
          }
        });
    });

    const resizeObserver = new ResizeObserver(() => {
      map.invalidateSize();
    });
    resizeObserver.observe(mapContainerRef.current);

    return () => {
      resizeObserver.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, [onOverviewChange, onSelectDay]);

  // Handle isOverview or selectedDay updates
  useEffect(() => {
    const map = mapRef.current;
    const fullRouteLayer = fullRouteLayerRef.current;
    const selectedLayer = selectedLayerRef.current;
    if (!map || !fullRouteLayer || !selectedLayer) return;

    if (isOverview) {
      if (!map.hasLayer(fullRouteLayer)) {
        fullRouteLayer.addTo(map);
      }
      selectedLayer.clearLayers();
      showTimeLabels([]);

      const allCoords = roadLinesRef.current.flat();
      map.fitBounds(L.latLngBounds(allCoords), {
        paddingTopLeft: [50, 70],
        paddingBottomRight: [50, 65],
        animate: false,
      });
    } else {
      if (map.hasLayer(fullRouteLayer)) {
        map.removeLayer(fullRouteLayer);
      }
      selectedLayer.clearLayers();

      const d = tripPlan.days[selectedDay];
      const legIndex = legByDay[selectedDay];
      const road = legIndex !== undefined ? roadLinesRef.current[legIndex] : undefined;
      const coords = d.points
        .map((k) => tripPlan.points[k]?.xy)
        .filter(Boolean) as [number, number][];

      if (road) {
        L.polyline(road, { color: '#fff', weight: 9 }).addTo(selectedLayer);
        L.polyline(road, { color: '#1768d1', weight: 6 }).addTo(selectedLayer);
      }

      coords.forEach((xy) => {
        L.circleMarker(xy, {
          radius: 8,
          color: '#fff',
          weight: 3,
          fillColor: '#1768d1',
          fillOpacity: 1,
        }).addTo(selectedLayer);
      });

      if (coords.length === 1) {
        map.setView(coords[0], 12, { animate: false });
      } else if (road && road.length > 0) {
        map.fitBounds(L.latLngBounds(road), {
          padding: [60, 65],
          maxZoom: 11,
          animate: false,
        });
      } else if (coords.length > 1) {
        map.fitBounds(L.latLngBounds(coords), {
          padding: [60, 65],
          maxZoom: 11,
          animate: false,
        });
      }

      showTimeLabels(road && legIndex !== undefined ? [legIndex] : []);
    }
  }, [isOverview, selectedDay, showTimeLabels]);

  return (
    <>
      <div
        id="route-map"
        ref={mapContainerRef}
        aria-label="林芝至拉萨自驾路线地图"
      />
      {mapError && (
        <div id="map-error">底图暂不可用，地点与路线示意仍可查看。</div>
      )}
    </>
  );
}
