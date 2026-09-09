'use client';

import React from 'react';
import { tripPlan } from '@/data/trip-plan';
import { ChevronRight, BedDouble } from 'lucide-react';

interface DaysPanelProps {
  selectedDay: number;
  onSelectDay: (dayIndex: number) => void;
}

export default function DaysPanel({ selectedDay, onSelectDay }: DaysPanelProps) {
  return (
    <aside className="days-panel">
      <div className="section-label">
        <h2>这一路</h2>
        <span>01 — 07</span>
      </div>

      <div id="days" aria-label="选择每日行程">
        {tripPlan.days.map((d, i) => {
          const isSelected = selectedDay === i;
          return (
            <button
              key={i}
              className="day-button"
              aria-pressed={isSelected}
              data-day={i}
              onClick={() => onSelectDay(i)}
            >
              <span className="day-num">{String(i + 1).padStart(2, '0')}</span>
              <span className="day-copy">
                <small>
                  {d.date} {d.weekday}
                </small>
                <strong>{d.short}</strong>
                <em>{d.pace}</em>
              </span>
              <ChevronRight />
            </button>
          );
        })}
      </div>

      <div className="stay-note">
        <BedDouble />
        <p>
          林芝 1 晚 → 索松村 1 晚<br />
          结巴村 2 晚 → 贡嘎 1 晚 → 拉萨 1 晚
          <small>10/2 · 10/3 · 10/4–5 · 10/6 · 10/7</small>
        </p>
      </div>
    </aside>
  );
}
