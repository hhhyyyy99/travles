(() => {
  const staleStatuses = new Set(['stale', 'pending', 'unupdated']);

  const escape = window.TibetAMapUtils.escapeHtml;
  const text = value => String(value ?? '').trim();
  const typeLabel = type => type === 'area' ? '住宿区域' : '酒店 / 民宿';

  function overnightDaysFor(accommodation, days) {
    if (Array.isArray(accommodation?.overnightDays)) return accommodation.overnightDays;
    return days.map((day, index) => day.points?.length > 1 && index < days.length - 1 ? index : null)
      .filter(index => index !== null);
  }

  function usedBaseCount(accommodation, stays) {
    if (typeof accommodation?.getBaseCount === 'function') return accommodation.getBaseCount();
    return new Set(stays.map(stay => stay?.id || stay?.name).filter(Boolean)).size;
  }

  function routeInfo({accommodation, day, dayIndex, stay, roadRoutes}) {
    const route = accommodation?.getDayRoute?.(dayIndex);
    const state = accommodation?.getRouteState?.(dayIndex) || {status: 'reference'};
    const updated = state.status === 'updated' && Number.isFinite(Number(state.distance));
    const changed = Boolean(route?.hasChangedEndpoint);
    const stale = !updated && (staleStatuses.has(state.status) || changed);
    const localDay = day.points?.length < 2;
    const from = route?.from?.name || day.nav?.[0] || '';
    const to = route?.to?.name || day.nav?.[1] || '';
    let label;
    let note = '';

    if (updated) {
      const distance = (Number(state.distance) / 1000).toFixed(1);
      label = `已更新 ${distance} km · ${text(state.durationText) || '驾车时间已更新'}`;
    } else if (stale) {
      label = '路线未更新';
      note = state.status === 'pending'
        ? '住宿端点已变化，路线正在重新查询。'
        : '住宿端点已变化，当前没有可用的新路线结果，请出发前重新查询。';
    } else if (localDay) {
      label = '当天不安排长途驾驶';
      note = '市内移动以当天安排为准。';
    } else {
      const leg = roadRoutes?.legs?.[dayIndex];
      const roads = leg?.roads?.filter(road => /^[GS]\d/.test(road)).join(' → ');
      label = leg
        ? `参考里程约 ${(leg.distance / 1000).toFixed(0)} km${roads ? ` · ${roads}` : ''}`
        : text(day.drive) || '以高德实时规划为准';
      note = '里程与时间为规划参考，出发前请以实时导航为准。';
    }

    if (stay?.type === 'area' || route?.from?.type === 'area' || route?.to?.type === 'area') {
      note = `${note ? `${note} ` : ''}住宿区域按代表位置估算。`;
    }

    return {from, to, label, note, stale, status: updated ? 'updated' : stale ? 'unupdated' : state.status};
  }

  function scheduleFor(day, stale) {
    if (!stale) return day.schedule || [];
    return (day.schedule || []).map(([time, title]) => [
      time,
      title,
      '当前住宿端点的路线未更新，出发前请重新查询。'
    ]);
  }

  function stayMarkup(stay, dayIndex) {
    if (!stay) return '';
    const address = text(stay.address);
    const notes = text(stay.notes);
    const areaNote = stay.type === 'area' ? '<p class="print-stay-disclaimer">住宿区域，路线按代表位置估算。</p>' : '';
    return `<section class="print-stay" data-stay-id="${escape(stay.id || '')}"><p class="print-stay-label">第 ${dayIndex + 1} 晚住宿</p><strong>${escape(stay.name || '未命名住宿')}</strong><span>${escape(typeLabel(stay.type))}</span>${areaNote}${address ? `<p><b>地址</b>${escape(address)}</p>` : ''}${notes ? `<p><b>备注</b>${escape(notes)}</p>` : ''}</section>`;
  }

  function render({target, days = [], accommodation, roadRoutes} = {}) {
    if (!target) return;
    const overnightDays = overnightDaysFor(accommodation, days);
    const staysByDay = new Map(overnightDays.map(index => [index, accommodation?.getDayStay?.(index)]));
    const stays = overnightDays.map(index => staysByDay.get(index)).filter(Boolean);
    const areaUsed = stays.some(stay => stay.type === 'area');
    const count = usedBaseCount(accommodation, stays);
    const dayMarkup = days.map((day, dayIndex) => {
      const stay = staysByDay.get(dayIndex);
      const route = routeInfo({accommodation, day, dayIndex, stay, roadRoutes});
      const schedule = scheduleFor(day, route.stale);
      return `<article class="print-day" data-day-index="${dayIndex}"><header class="print-day-heading"><div><p class="eyebrow">DAY ${String(dayIndex + 1).padStart(2, '0')} / ${escape(day.date)} ${escape(day.weekday)}</p><h2>${escape(day.title)}</h2></div><span class="tag">${escape(day.pace)}</span></header><div class="print-route ${route.stale ? 'is-stale' : ''}" data-route-status="${escape(route.status)}"><span class="print-route-label">路线</span><strong>${escape(route.from)} → ${escape(route.to)}</strong><b>${escape(route.label)}</b>${route.note ? `<p>${escape(route.note)}</p>` : ''}</div>${stayMarkup(stay, dayIndex)}<p class="print-day-description">${escape(day.desc)}</p><div class="print-timeline">${schedule.map(([time, title, description]) => `<div class="print-time-row"><time>${escape(time)}</time><div><strong>${escape(title)}</strong><p>${escape(description)}</p></div></div>`).join('')}</div><p class="print-day-tip">${escape(day.tip)}</p></article>`;
    }).join('');
    const headerNote = areaUsed
      ? '住宿内容来自当前浏览器的行程安排；住宿区域按代表位置估算。'
      : '住宿内容来自当前浏览器的行程安排。';
    target.innerHTML = `<section class="print-sheet-header"><p class="eyebrow">TRIP ITINERARY / ACCOMMODATION</p><h1>呼伦贝尔自驾行程</h1><p class="print-sheet-summary">${overnightDays.length} 晚 · ${count} 处实际使用的住宿基地</p><p class="print-sheet-note">${headerNote}</p></section><section class="print-days" aria-label="住宿与每日行程">${dayMarkup}</section>`;
  }

  window.tibetAccommodationPrint = {render};
})();
