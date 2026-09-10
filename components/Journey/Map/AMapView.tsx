'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { tripPlan } from '@/data/trip-plan';
import { trafficColors, duration as formatDuration, traffic as calculateTraffic, TrafficResult, TrafficStatus } from '@/lib/amap-utils';
import { wgs84togcj02 } from '@/lib/coordtransform';

interface AMapViewProps {
  selectedDay: number;
  isOverview: boolean;
  apiKey: string;
  securityJsCode: string;
  showTraffic: boolean;
  refreshTrigger: number;
  onSelectDay: (dayIndex: number) => void;
  onSetStatusText: (text: string) => void;
}

declare global {
  interface Window {
    _AMapSecurityConfig?: {
      securityJsCode?: string;
      serviceHost?: string;
    };
    AMap?: any;
  }
}

export default function AMapView({
  selectedDay,
  isOverview,
  apiKey,
  securityJsCode,
  showTraffic,
  refreshTrigger,
  onSelectDay,
  onSetStatusText,
}: AMapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const trafficLayerRef = useRef<any>(null);
  const overlaysRef = useRef<any[]>([]);
  const drivingRef = useRef<any>(null);

  const [fromInput, setFromInput] = useState('');
  const [toInput, setToInput] = useState('');
  const [routeResult, setRouteResult] = useState<{
    route: any;
    result: any;
    trafficData: TrafficResult;
    queryTime: string;
  } | null>(null);

  // Initialize AMap JS API
  useEffect(() => {
    if (!apiKey || !securityJsCode || !containerRef.current) return;

    window._AMapSecurityConfig = {
      securityJsCode,
    };

    const scriptId = 'amap-sdk-script';
    let script = document.getElementById(scriptId) as HTMLScriptElement;

    const initMap = () => {
      if (!window.AMap || !containerRef.current) return;
      if (!mapRef.current) {
        const map = new window.AMap.Map(containerRef.current, {
          zoom: 7,
          center: [92.5, 29.7],
          viewMode: '2D',
        });
        mapRef.current = map;

        const trafficLayer = new window.AMap.TileLayer.Traffic({
          zIndex: 10,
          opacity: 0.8,
          autoRefresh: true,
          interval: 180,
        });
        trafficLayerRef.current = trafficLayer;
        trafficLayer.setMap(map);
        if (!showTraffic) trafficLayer.hide();

        drivingRef.current = new window.AMap.Driving({
          policy: window.AMap.DrivingPolicy.LEAST_TIME,
          showTraffic: true,
        });

        onSetStatusText('高德已连接 · 实时路况与路线已就绪');
      }
    };

    if (!window.AMap) {
      if (!script) {
        script = document.createElement('script');
        script.id = scriptId;
        script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(
          apiKey
        )}&plugin=AMap.Driving,AMap.MoveAnimation`;
        script.onload = () => initMap();
        document.head.appendChild(script);
      } else {
        script.addEventListener('load', initMap);
      }
    } else {
      initMap();
    }

    return () => {
      // Keep script cached, cleanup overlays
      if (overlaysRef.current.length && mapRef.current) {
        mapRef.current.remove(overlaysRef.current);
        overlaysRef.current = [];
      }
    };
  }, [apiKey, securityJsCode, onSetStatusText]);

  // Traffic layer toggle
  useEffect(() => {
    if (trafficLayerRef.current) {
      if (showTraffic) {
        trafficLayerRef.current.show();
      } else {
        trafficLayerRef.current.hide();
      }
    }
  }, [showTraffic]);

  // Query route
  const queryRoute = useCallback(() => {
    const map = mapRef.current;
    const driving = drivingRef.current;
    if (!map || !driving || !window.AMap) return;

    if (overlaysRef.current.length) {
      map.remove(overlaysRef.current);
      overlaysRef.current = [];
    }
    setRouteResult(null);

    const d = tripPlan.days[selectedDay];
    const origin = fromInput || d.nav[0];
    const destination = toInput || d.nav[1];

    const originCity = d.cities[0] || '林芝市';
    const destCity = d.cities[1] || '林芝市';

    const opts: any = {};
    if (d.via && d.via.length > 0) {
      opts.waypoints = d.via.map((v) => ({ keyword: v.keyword, city: v.city }));
    }

    onSetStatusText(`正在规划：${origin} → ${destination}...`);

    driving.search(
      [{ keyword: origin, city: originCity }],
      [{ keyword: destination, city: destCity }],
      opts,
      (status: string, result: any) => {
        if (status === 'complete' && result.routes && result.routes.length > 0) {
          const route = result.routes[0];
          const trafficData = calculateTraffic(route);
          const queryTime = new Date().toLocaleTimeString('zh-CN', { hour12: false });

          setRouteResult({ route, result, trafficData, queryTime });
          onSetStatusText(`高德路线查询成功 · ${queryTime}`);

          const newOverlays: any[] = [];
          const path = (route.steps || []).flatMap((s: any) => s.path || []);

          // Base polyline
          newOverlays.push(
            new window.AMap.Polyline({
              path,
              strokeColor: trafficColors['未知'],
              strokeWeight: 6,
              isOutline: true,
              outlineColor: '#fff',
              borderWeight: 1,
              lineJoin: 'round',
              zIndex: 60,
            })
          );

          // Traffic colored segments
          trafficData.segments.forEach((seg) => {
            if (seg.path) {
              newOverlays.push(
                new window.AMap.Polyline({
                  path: seg.path,
                  strokeColor: trafficColors[seg.status as TrafficStatus] || trafficColors['未知'],
                  strokeWeight: 6,
                  isOutline: true,
                  outlineColor: '#fff',
                  borderWeight: 1,
                  lineJoin: 'round',
                  zIndex: 70,
                })
              );
            }
          });

          if (path.length > 0) {
            // Start marker
            newOverlays.push(
              new window.AMap.Marker({
                position: path[0],
                anchor: 'center',
                content:
                  '<div class="trip-endpoint trip-endpoint-start" role="img" aria-label="起点" title="起点">起</div>',
                zIndex: 210,
              })
            );

            // End marker
            newOverlays.push(
              new window.AMap.Marker({
                position: path[path.length - 1],
                anchor: 'center',
                content:
                  '<div class="trip-endpoint trip-endpoint-end" role="img" aria-label="终点" title="终点">终</div>',
                zIndex: 210,
              })
            );
          }

          map.add(newOverlays);
          overlaysRef.current = newOverlays;
          if (newOverlays.length) {
            map.setFitView(newOverlays, false, [70, 55, 70, 55]);
          }
        } else {
          onSetStatusText(`高德路线规划未获取到结果: ${status}`);
        }
      }
    );
  }, [selectedDay, fromInput, toInput, onSetStatusText]);

  // Sync inputs on day change
  useEffect(() => {
    const d = tripPlan.days[selectedDay];
    setFromInput(d.nav[0]);
    setToInput(d.nav[1]);
  }, [selectedDay]);

  // Trigger query on day change or refresh
  useEffect(() => {
    if (mapRef.current && window.AMap) {
      queryRoute();
    }
  }, [selectedDay, refreshTrigger, queryRoute]);

  const handleCustomSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    queryRoute();
  };

  return (
    <>
      <div id="amap-canvas" ref={containerRef} aria-label="高德地图与实时交通" />

      {/* Live traffic and routing panel rendered below the strip */}
      <section className="amap-live" aria-label="高德路线与路况">
        <div className="live-header">
          <h2 id="live-title">
            {tripPlan.days[selectedDay].date} · 高德驾车路线
          </h2>
        </div>

        <form id="route-endpoints" onSubmit={handleCustomSubmit}>
          <label>
            出发地
            <input
              id="route-from"
              required
              maxLength={120}
              autoComplete="off"
              value={fromInput}
              onChange={(e) => setFromInput(e.target.value)}
            />
          </label>
          <label>
            目的地
            <input
              id="route-to"
              required
              maxLength={120}
              autoComplete="off"
              value={toInput}
              onChange={(e) => setToInput(e.target.value)}
            />
          </label>
          <button type="submit">重新规划</button>
        </form>

        {routeResult && (
          <div id="live-results">
            <div className="live-metrics">
              <div>
                <span>预计驾驶</span>
                <strong>{formatDuration(routeResult.route.time)}</strong>
              </div>
              <div>
                <span>路线距离</span>
                <strong>
                  {(Number(routeResult.route.distance) / 1000).toFixed(1)} km
                </strong>
              </div>
              <div>
                <span>路况数据</span>
                <strong>
                  {routeResult.trafficData.known ? '已返回分段路况' : '暂无覆盖'}
                </strong>
              </div>
            </div>

            <div className="traffic-summary">
              {Object.entries(routeResult.trafficData.totals)
                .filter(([, distance]) => distance > 0)
                .map(([name, distance]) => (
                  <span key={name}>
                    <b style={{ background: trafficColors[name as TrafficStatus] }} />
                    {name} {(distance / 1000).toFixed(1)} km
                  </span>
                ))}
            </div>

            <p className="resolved-endpoints">
              {routeResult.result.start?.name || fromInput} →{' '}
              {routeResult.result.end?.name || toInput}。请核对具体入口；可修改上方酒店或航站楼名称重新规划。
            </p>

            <details className="road-details">
              <summary>沿途道路与转向</summary>
              <ol>
                {(routeResult.route.steps || []).map((step: any, sIdx: number) => (
                  <li key={sIdx}>
                    <strong>{step.road || '连接道路'}</strong>
                    <span>{step.instruction || ''}</span>
                  </li>
                ))}
              </ol>
            </details>
          </div>
        )}

        <p className="traffic-disclaimer">
          当前路况不代表 10 月出发当天；无覆盖路段标为未知。驾驶时间不含游览、休息、停车与景区排队。
        </p>
      </section>
    </>
  );
}
