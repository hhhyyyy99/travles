import React from 'react';
import { PlaneLanding, PlaneTakeoff } from 'lucide-react';

export default function IntroSection() {
  return (
    <section className="intro">
      <div>
        <p className="eyebrow">2026 / OCTOBER · 林芝进，拉萨出</p>
        <h1>西藏，慢慢走。</h1>
        <p className="intro-copy">
          林芝、索松村、结巴村与羊湖。10 月 7 日抵达拉萨，8 日从容返程。
        </p>
      </div>
      <div className="flight">
        <p>
          <PlaneLanding />
          <span>
            10 月 02 日<strong>11:00 抵达林芝</strong>
          </span>
        </p>
        <p>
          <PlaneTakeoff />
          <span>
            10 月 08 日<strong>18:00 拉萨起飞</strong>
          </span>
        </p>
      </div>
    </section>
  );
}
