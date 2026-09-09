import React from 'react';
import { tripPlan } from '@/data/trip-plan';
import { CarFront, BedDouble, Mountain } from 'lucide-react';

export default function PrintItinerary() {
  return (
    <div id="print-itinerary">
      {tripPlan.days.map((d, index) => (
        <article key={index}>
          <div className="detail-heading">
            <div>
              <p className="eyebrow">
                DAY {String(index + 1).padStart(2, '0')} / {d.date} {d.weekday}
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
            {d.schedule.map((s, sIndex) => (
              <div className="time-row" key={sIndex}>
                <time>{s[0]}</time>
                <div>
                  <strong>{s[1]}</strong>
                  <p>{s[2]}</p>
                </div>
              </div>
            ))}
          </div>
          <p className="day-tip">{d.tip}</p>
        </article>
      ))}
    </div>
  );
}
