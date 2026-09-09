'use client';

import React, { useState, useEffect } from 'react';
import dynamic from 'next/dynamic';
import { Scan, RefreshCw, Settings2 } from 'lucide-react';
import { tripPlan } from '@/data/trip-plan';
import AMapDialog from './AMapDialog';
import AMapView from './AMapView';

// Dynamically import Leaflet with SSR disabled
const LeafletMap = dynamic(() => import('./LeafletMap'), {
  ssr: false,
  loading: () => (
    <div
      style={{
        display: 'grid',
        placeItems: 'center',
        height: '100%',
        color: '#64716b',
        fontSize: '13px',
      }}
    >
      地图加载中...
    </div>
  ),
});

interface RouteMapProps {
  selectedDay: number;
  onSelectDay: (dayIndex: number) => void;
}

export default function RouteMap({ selectedDay, onSelectDay }: RouteMapProps) {
  const [isOverview, setIsOverview] = useState(false);
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  // AMap state
  const [amapKey, setAmapKey] = useState('');
  const [securityJsCode, setSecurityJsCode] = useState('');
  const [isAMapConnected, setIsAMapConnected] = useState(false);
  const [showTraffic, setShowTraffic] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [statusText, setStatusText] = useState('高德未配置 · 当前为参考地图');

  // Auto-connect if environment variables are set
  useEffect(() => {
    const envKey = process.env.NEXT_PUBLIC_AMAP_KEY;
    const envSec = process.env.NEXT_PUBLIC_AMAP_SECURITY_JS_CODE;
    if (
      envKey &&
      envKey !== 'your_amap_web_js_api_key' &&
      envSec &&
      envSec !== 'your_amap_security_js_code'
    ) {
      setAmapKey(envKey);
      setSecurityJsCode(envSec);
      setIsAMapConnected(true);
      setShowTraffic(true);
      setStatusText('高德已连接 · 实时路况就绪');
    }
  }, []);

  const handleConnect = (key: string, sec: string) => {
    setAmapKey(key);
    setSecurityJsCode(sec);
    setIsAMapConnected(true);
    setShowTraffic(true);
    setStatusText('高德已连接 · 实时路况就绪');
  };

  const handleFitClick = () => {
    setIsOverview(true);
  };

  const handleSelectDayFromOverview = (dayIndex: number) => {
    setIsOverview(false);
    onSelectDay(dayIndex);
  };

  return (
    <>
      <div className="trip-map-toolbar">
        <span id="amap-state" role="status">
          {statusText}
        </span>
        <div>
          <label>
            <input
              id="traffic-toggle"
              type="checkbox"
              checked={showTraffic}
              disabled={!isAMapConnected}
              onChange={(e) => setShowTraffic(e.target.checked)}
            />
            实时路况
          </label>
          <button
            id="amap-refresh"
            title="刷新路线时间与路况"
            aria-label="刷新路线时间与路况"
            disabled={!isAMapConnected}
            onClick={() => setRefreshTrigger((c) => c + 1)}
          >
            <RefreshCw />
          </button>
          <button
            id="amap-settings"
            title="配置高德地图"
            aria-label="配置高德地图"
            onClick={() => setIsDialogOpen(true)}
          >
            <Settings2 />
          </button>
        </div>
      </div>

      <div className={`map-wrap ${isAMapConnected ? 'amap-active' : ''}`}>
        {isAMapConnected ? (
          <AMapView
            selectedDay={selectedDay}
            isOverview={isOverview}
            apiKey={amapKey}
            securityJsCode={securityJsCode}
            showTraffic={showTraffic}
            refreshTrigger={refreshTrigger}
            onSelectDay={onSelectDay}
            onSetStatusText={setStatusText}
          />
        ) : (
          <LeafletMap
            selectedDay={selectedDay}
            isOverview={isOverview}
            onSelectDay={onSelectDay}
            onOverviewChange={setIsOverview}
          />
        )}

        {!isAMapConnected && (
          <>
            <div className="map-title">
              <span>THE SLOW ROUTE</span>
              <strong>从山谷，到日光之城</strong>
            </div>

            <button
              className="fit-map"
              id="fit-map"
              title="查看全程"
              aria-label="查看全程"
              onClick={handleFitClick}
            >
              <Scan />
            </button>

            <div className="map-legend">
              <span className="line-sample" />
              {isOverview ? '全程参考路线 · 不含实时路况' : '道路路线 · 不含实时路况'}
            </div>

            {isOverview && (
              <div id="overview-times">
                {tripPlan.estimates.map((e, idx) => (
                  <button
                    key={idx}
                    data-route-day={e.day}
                    onClick={() => handleSelectDayFromOverview(e.day)}
                  >
                    <span>{e.title}</span>
                    <strong>{e.time}</strong>
                  </button>
                ))}
                <small>行程预估 · 点击查看路段</small>
              </div>
            )}
          </>
        )}
      </div>

      <AMapDialog
        isOpen={isDialogOpen}
        onClose={() => setIsDialogOpen(false)}
        onConnect={handleConnect}
        isConnected={isAMapConnected}
      />
    </>
  );
}
