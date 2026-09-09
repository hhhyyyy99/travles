'use client';

import React from 'react';
import { tripPlan } from '@/data/trip-plan';
import { CarFront, BedDouble, Mountain, MapPin, ArrowUpRight } from 'lucide-react';

interface DayDetailProps {
  dayIndex: number;
}

function searchUrl(name: string) {
  return `https://uri.amap.com/search?keyword=${encodeURIComponent(name)}&callnative=0`;
}

export default function DayDetail({ dayIndex }: DayDetailProps) {
  const d = tripPlan.days[dayIndex];

  return (
    <>
      <div className="detail-heading">
        <div>
          <p className="eyebrow">
            DAY {String(dayIndex + 1).padStart(2, '0')} / {d.date} {d.weekday}
          </p>
          <h2>{d.title}</h2>
        </div>
        <span className="tag">{d.pace}</span>
      </div>

      <p className="day-desc">{d.desc}</p>

      <div className="day-stats">
        <span>
          <CarFront />
          {d.drive}
        </span>
        <span>
          <BedDouble />
          {d.stay}
        </span>
        <span>
          <Mountain />
          {d.alt}
        </span>
      </div>

      <div className="timeline">
        {d.schedule.map((s, idx) => (
          <div className="time-row" key={idx}>
            <time>{s[0]}</time>
            <div>
              <strong>{s[1]}</strong>
              <p>{s[2]}</p>
            </div>
          </div>
        ))}
      </div>

      <p className="day-tip">{d.tip}</p>

      <div className="day-links">
        <a href={searchUrl(d.nav[1])} target="_blank" rel="noopener noreferrer">
          <MapPin />
          高德查看目的地
          <ArrowUpRight />
        </a>
        <a href={searchUrl(d.nav[0])} target="_blank" rel="noopener noreferrer">
          查看出发地
          <ArrowUpRight />
        </a>
      </div>
    </>
  );
}
