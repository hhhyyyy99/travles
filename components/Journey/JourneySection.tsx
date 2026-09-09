'use client';

import React, { useState } from 'react';
import { ArrowRight } from 'lucide-react';
import DaysPanel from './DaysPanel';
import RouteMap from './Map/RouteMap';
import NavigationCard from './NavigationCard';
import DayDetail from './DayDetail';

export default function JourneySection() {
  const [selectedDay, setSelectedDay] = useState(0);

  return (
    <section className="journey" id="journey">
      <DaysPanel selectedDay={selectedDay} onSelectDay={setSelectedDay} />

      <div className="route-panel">
        <RouteMap selectedDay={selectedDay} onSelectDay={setSelectedDay} />

        <div className="route-strip">
          <span>林芝米林机场</span>
          <ArrowRight />
          <span>林芝</span>
          <ArrowRight />
          <span>索松村</span>
          <ArrowRight />
          <span>结巴村</span>
          <ArrowRight />
          <span>贡嘎 · 羊湖</span>
          <ArrowRight />
          <span>拉萨</span>
          <ArrowRight />
          <span>贡嘎机场</span>
        </div>

        <article id="day-detail" aria-live="polite">
          <NavigationCard dayIndex={selectedDay} />
          <DayDetail dayIndex={selectedDay} />
        </article>
      </div>
    </section>
  );
}
