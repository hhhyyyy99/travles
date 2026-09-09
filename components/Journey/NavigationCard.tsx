'use client';

import React from 'react';
import { tripPlan } from '@/data/trip-plan';
import { roadRoutes } from '@/data/road-routes';
import { wgs84togcj02 } from '@/lib/coordtransform';
import { Navigation, MapPin, LocateFixed } from 'lucide-react';

const legByDay: Record<number, number> = { 0: 0, 1: 1, 2: 2, 4: 3, 5: 4, 6: 5 };

function searchUrl(name: string) {
  return `https://uri.amap.com/search?keyword=${encodeURIComponent(name)}&callnative=0`;
}

export function getNavigationUrl(dayIndex: number, currentLocation = false): string {
  const d = tripPlan.days[dayIndex];
  if (d.points.length < 2) return searchUrl(d.nav[1]);

  const endpoint = (key: string, name: string) => {
    const point = tripPlan.points[key];
    if (!point) return '';
    const [lat, lng] = point.xy;
    const [gcjLng, gcjLat] = wgs84togcj02(lng, lat);
    return `${gcjLng.toFixed(6)},${gcjLat.toFixed(6)},${name}`;
  };

  const params = new URLSearchParams({
    to: endpoint(d.points[d.points.length - 1], d.nav[1]),
    mode: 'car',
    policy: '1',
    src: 'tibet-slow-trip',
    callnative: '1',
  });

  if (!currentLocation) {
    params.set('from', endpoint(d.points[0], d.nav[0]));
  }
  if (d.points.length > 2) {
    const viaKey = d.points[1];
    params.set('via', endpoint(viaKey, tripPlan.points[viaKey]?.name || ''));
  }

  return `https://uri.amap.com/navigation?${params.toString()}`;
}

interface NavigationCardProps {
  dayIndex: number;
}

export default function NavigationCard({ dayIndex }: NavigationCardProps) {
  const d = tripPlan.days[dayIndex];
  const legIndex = legByDay[dayIndex];
  const leg = legIndex !== undefined ? roadRoutes.legs[legIndex] : undefined;
  const localDay = d.points.length < 2;

  const mainRoads = leg?.roads.filter((r) => /^[GS]\d/.test(r)).join(' → ') || '';
  const roadMileage = leg
    ? `道路里程约 ${(leg.distance / 1000).toFixed(0)} km${mainRoads ? ` · ${mainRoads}` : ''}`
    : '市内目的地 · 以高德实时规划为准';

  return (
    <div className="navigation-panel">
      <div>
        <span className="eyebrow">{localDay ? '湖边休息日' : '驾车路线'}</span>
        <strong>
          {d.nav[0]} → {d.nav[1]}
        </strong>
        <p>{roadMileage}</p>
      </div>

      <div className="navigation-actions">
        <a
          className="navigation-primary"
          href={getNavigationUrl(dayIndex, false)}
          target="_blank"
          rel="noopener noreferrer"
        >
          {localDay ? <MapPin /> : <Navigation />}
          {localDay ? '查看结巴村' : '高德路线规划'}
        </a>
        {!localDay && (
          <a
            className="navigation-current"
            href={getNavigationUrl(dayIndex, true)}
            target="_blank"
            rel="noopener noreferrer"
          >
            <LocateFixed />
            从当前位置导航
          </a>
        )}
      </div>

      <p className="navigation-note">
        {localDay
          ? '当天不安排长途驾驶，景区内交通以观光车及酒店接驳为准。'
          : '起终点为区域参考位置，请在高德中确认酒店、景区入口或航站楼。手机可调起高德；当前位置导航需要手机定位。'}
      </p>
    </div>
  );
}
