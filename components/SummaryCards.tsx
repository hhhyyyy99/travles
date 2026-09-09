import React from 'react';
import { CalendarDays, CarFront, BedDouble, Coffee } from 'lucide-react';

export default function SummaryCards() {
  return (
    <div className="summary">
      <span>
        <CalendarDays />
        <b>7 天 6 晚</b>
      </span>
      <span>
        <CarFront />
        约 <b>1,050–1,200 km</b>
      </span>
      <span>
        <BedDouble />
        <b>5 处住宿基地</b>
      </span>
      <span className="pace">
        <Coffee />
        景观优先 · 留一天湖边休息
      </span>
    </div>
  );
}
