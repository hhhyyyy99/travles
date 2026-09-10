(() => {
  const plan = window.tripPlan;
  if (!plan) return;

  const STORAGE_KEY = 'hailar-slow-trip-accommodation-v1';
  const VERSION = 1;
  const overnightDays = plan.days
    .map((day, index) => day.points.length > 1 && index < plan.days.length - 1 ? index : null)
    .filter(index => index !== null);
  const defaultStayByDay = ['default-hailar', 'default-erguna', 'default-mordaoga', 'default-heishantou', 'default-manzhouli', 'default-hailar', null];
  const definitions = [
    ['default-hailar', 'hailar', '海拉尔', '海拉尔市区'],
    ['default-erguna', 'erguna', '额尔古纳', '额尔古纳市'],
    ['default-mordaoga', 'mordaoga', '莫尔道嘎', '莫尔道嘎镇'],
    ['default-heishantou', 'heishantou', '黑山头', '黑山头镇'],
    ['default-manzhouli', 'manzhouli', '满洲里', '满洲里市']
  ];
  const defaultBases = definitions.map(([id, pointKey, name, routeName]) => {
    const point = plan.points[pointKey];
    return {
      id,
      name,
      routeName,
      type: 'area',
      lat: point.xy[0],
      lng: point.xy[1],
      address: point.name,
      notes: '',
      isDefault: true
    };
  });
  const defaultById = new Map(defaultBases.map(base => [base.id, base]));
  const listeners = new Set();
  const routeStates = new Map();
  let currentDay = 0;
  let selectedBaseId = null;
  let editing = false;
  let map = null;
  let mapPickActive = false;
  let restoreAmapAfterPick = false;
  let mapMarkers = [];

  const $ = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
  const kindLabel = kind => kind === 'area' ? '住宿区域' : '酒店 / 民宿';
  const copy = value => JSON.parse(JSON.stringify(value));
  const validCoordinate = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
  let state = loadState();

  function idForBase() {
    if (window.crypto?.randomUUID) return `custom-${window.crypto.randomUUID()}`;
    return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function normalizeBase(value) {
    if (!value || typeof value !== 'object') return null;
    const name = String(value.name || '').trim();
    const type = value.type === 'area' ? 'area' : 'hotel';
    const latText = String(value.lat ?? '').trim();
    const lngText = String(value.lng ?? '').trim();
    if (!latText || !lngText) return null;
    const lat = Number(latText);
    const lng = Number(lngText);
    if (!name || !validCoordinate(lat, lng)) return null;
    return {
      id: String(value.id || idForBase()),
      name: name.slice(0, 120),
      type,
      lat,
      lng,
      address: String(value.address || '').trim().slice(0, 240),
      notes: String(value.notes || '').trim().slice(0, 600),
      createdAt: value.createdAt || new Date().toISOString(),
      isDefault: false
    };
  }

  function loadState() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      const bases = Array.isArray(raw.bases) ? raw.bases.map(normalizeBase).filter(Boolean) : [];
      const known = new Set([...defaultById.keys(), ...bases.map(base => base.id)]);
      const stays = {};
      if (raw.stays && typeof raw.stays === 'object') {
        Object.entries(raw.stays).forEach(([day, id]) => {
          const index = Number(day);
          if (overnightDays.includes(index) && known.has(id)) stays[index] = id;
        });
      }
      return {version: VERSION, bases, stays};
    } catch {
      return {version: VERSION, bases: [], stays: {}};
    }
  }

  function persist(next) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({version: VERSION, bases: next.bases, stays: next.stays}));
      return true;
    } catch {
      return false;
    }
  }

  function notify(change) {
    const payload = {...change, state: getState()};
    listeners.forEach(listener => listener(payload));
    document.dispatchEvent(new CustomEvent('accommodationchange', {detail: payload}));
    renderMarkers();
  }

  function commit(next, change) {
    if (!persist(next)) {
      setStatus('当前浏览器未允许保存，住宿安排未改变。');
      return {ok: false, error: '保存失败'};
    }
    state = next;
    notify(change);
    return {ok: true};
  }

  function getBase(id) {
    return defaultById.get(id) || state.bases.find(base => base.id === id) || null;
  }

  function getDayStay(dayIndex) {
    if (!overnightDays.includes(Number(dayIndex))) return null;
    const customId = state.stays[dayIndex];
    return getBase(customId || defaultStayByDay[dayIndex]);
  }

  function getEndpoint(dayIndex, side) {
    const index = Number(dayIndex);
    const day = plan.days[index];
    if (!day) return null;
    if (side === 'from' && index === 0) {
      const point = plan.points[day.points[0]];
      return {name: day.nav[0], routeName: day.nav[0], lat: point.xy[0], lng: point.xy[1], isCustom: false};
    }
    if (side === 'to' && index === plan.days.length - 1) {
      const point = plan.points[day.points.at(-1)];
      return {name: day.nav[1], routeName: day.nav[1], lat: point.xy[0], lng: point.xy[1], isCustom: false};
    }
    const stay = getDayStay(side === 'to' ? index : index - 1);
    if (!stay) return null;
    const stayDay = side === 'to' ? index : index - 1;
    const selectedId = state.stays[stayDay];
    return {
      id: stay.id,
      name: stay.name,
      routeName: stay.routeName || stay.address || stay.name,
      type: stay.type,
      lat: stay.lat,
      lng: stay.lng,
      address: stay.address,
      isCustom: !stay.isDefault,
      isChanged: Boolean(selectedId && selectedId !== defaultStayByDay[stayDay])
    };
  }

  function getDayRoute(dayIndex) {
    const index = Number(dayIndex);
    const day = plan.days[index];
    if (!day) return null;
    const from = getEndpoint(index, 'from');
    const to = getEndpoint(index, 'to');
    const via = day.points.slice(1, -1).map(key => {
      const point = plan.points[key];
      return {id: key, name: point.name, routeName: point.name, lat: point.xy[0], lng: point.xy[1], isCustom: false};
    });
    // The live route has two scenic destinations that are not represented by
    // the static overnight points. Keep them in the full stop list whenever a
    // lodging route is requested so changing a base cannot drop the day's
    // actual sightseeing destination.
    if (index === 1 || index === 2) {
      const pointKey = index === 1 ? 'erguna' : 'mordaoga';
      const point = plan.points[pointKey];
      via.push({id: `nav-${index}`, name: day.nav[1], routeName: day.nav[1], keyword: day.nav[1], lat: point.xy[0], lng: point.xy[1], isCustom: false});
    }
    return {from, to, via, stops: [from, ...via, to].filter(Boolean), hasCustomEndpoint: Boolean(from?.isCustom || to?.isCustom), hasChangedEndpoint: Boolean(from?.isChanged || to?.isChanged || from?.isCustom || to?.isCustom)};
  }

  function routeState(dayIndex) {
    const index = Number(dayIndex);
    if (!routeStates.has(index)) {
      routeStates.set(index, getDayRoute(index)?.hasChangedEndpoint ? {status: 'stale'} : {status: 'reference'});
    }
    return {...routeStates.get(index)};
  }

  function affectedRoutes(dayIndices) {
    const affected = new Set();
    dayIndices.map(Number).forEach(index => {
      if (!overnightDays.includes(index)) return;
      [index, index + 1].forEach(routeIndex => {
        if (routeIndex >= 0 && routeIndex < plan.days.length) affected.add(routeIndex);
      });
    });
    return [...affected].sort((a, b) => a - b);
  }

  function markRouteStatus(dayIndices, status, details = {}) {
    const indices = [...new Set(dayIndices.map(Number))];
    indices.forEach(index => routeStates.set(index, {status, ...details}));
    document.dispatchEvent(new CustomEvent('accommodationroutechange', {detail: {dayIndices: indices, status, details}}));
    return indices;
  }

  function setStatus(message) {
    const element = $('accommodation-dialog-status');
    if (element) element.textContent = message;
  }

  function dayLabel(dayIndex) {
    const day = plan.days[dayIndex];
    return `第 ${dayIndex + 1} 晚 · ${day.date} ${day.weekday}`;
  }

  function selectedDays() {
    return [...document.querySelectorAll('input[name="accommodation-nights"]:checked')]
      .map(input => Number(input.value)).filter(index => overnightDays.includes(index));
  }

  function renderNightChoices(checked = []) {
    const element = $('accommodation-night-choices');
    if (!element) return;
    element.innerHTML = overnightDays.map(index => {
      const stay = getDayStay(index);
      const isChecked = checked.includes(index);
      return `<label><input type="checkbox" name="accommodation-nights" value="${index}" ${isChecked ? 'checked' : ''}>${dayLabel(index)}<small>${escape(stay?.name || '未安排')}</small></label>`;
    }).join('');
  }

  function renderBaseList() {
    const element = $('accommodation-base-list');
    if (!element) return;
    const bases = [...defaultBases, ...state.bases];
    element.innerHTML = bases.map(base => {
      const selected = selectedBaseId === base.id;
      const location = base.address ? `${escape(base.address)} · ` : '';
      return `<article class="accommodation-option ${selected ? 'is-selected' : ''}" data-base-option="${escape(base.id)}"><div><strong>${escape(base.name)}</strong><small>${kindLabel(base.type)}${base.isDefault ? ' · 默认住宿' : ''}</small><p>${location}${base.lat.toFixed(5)}, ${base.lng.toFixed(5)}</p>${base.notes ? `<p>${escape(base.notes)}</p>` : ''}</div><button type="button" data-accommodation-select="${escape(base.id)}">${selected ? '已选择' : '选择'}</button></article>`;
    }).join('');
    const apply = $('accommodation-apply-selected');
    if (apply) apply.disabled = !selectedBaseId;
  }

  function resetEditor() {
    editing = false;
    $('accommodation-editor')?.setAttribute('hidden', '');
    $('accommodation-new-name').value = '';
    $('accommodation-new-type').value = 'hotel';
    $('accommodation-new-address').value = '';
    $('accommodation-new-notes').value = '';
    $('accommodation-new-lat').value = '';
    $('accommodation-new-lng').value = '';
    $('accommodation-location-summary').textContent = '尚未在地图上选择位置';
    $('accommodation-save-option').disabled = false;
    $('accommodation-save-apply').disabled = false;
  }

  function renderDialog() {
    renderBaseList();
    const current = getDayStay(currentDay);
    const selectedDaysForForm = current ? [currentDay] : [];
    renderNightChoices(selectedDaysForForm);
    const heading = $('accommodation-dialog-title');
    if (heading) heading.textContent = `第 ${currentDay + 1} 天 · 更换住宿`;
    const selectedLabel = $('accommodation-selected-label');
    if (selectedLabel) selectedLabel.textContent = selectedBaseId ? `已选择：${getBase(selectedBaseId)?.name || ''}` : '先选择一个已有基地，或新增住宿基地。';
    resetEditor();
    renderBaseList();
  }

  function openDialog(dayIndex = 0) {
    currentDay = overnightDays.includes(Number(dayIndex)) ? Number(dayIndex) : overnightDays[0];
    selectedBaseId = getDayStay(currentDay)?.id || null;
    renderDialog();
    const dialog = $('accommodation-dialog');
    if (dialog?.showModal) dialog.showModal();
    else dialog?.removeAttribute('hidden');
  }

  function closeDialog() {
    mapPickActive = false;
    $('accommodation-map-picker')?.setAttribute('hidden', '');
    const dialog = $('accommodation-dialog');
    if (dialog?.open) dialog.close();
    else dialog?.setAttribute('hidden', '');
  }

  function cancelMapPick() {
    mapPickActive = false;
    map?.getContainer().classList.remove('accommodation-picking');
    $('accommodation-map-picker')?.setAttribute('hidden', '');
    if (restoreAmapAfterPick) window.tibetAMap?.useReferenceMapForPicker(false);
    restoreAmapAfterPick = false;
  }

  function startMapPick() {
    if (!map) {
      setStatus('地图尚未就绪，暂时无法选择位置。');
      return;
    }
    restoreAmapAfterPick = Boolean(document.querySelector('.map-wrap.amap-active'));
    if (restoreAmapAfterPick) window.tibetAMap?.useReferenceMapForPicker(true);
    closeDialog();
    mapPickActive = true;
    $('accommodation-map-picker')?.removeAttribute('hidden');
    $('accommodation-map-picker')?.focus();
    map.getContainer().classList.add('accommodation-picking');
  }

  function completeMapPick(latlng) {
    mapPickActive = false;
    map.getContainer().classList.remove('accommodation-picking');
    $('accommodation-map-picker')?.setAttribute('hidden', '');
    $('accommodation-new-lat').value = Number(latlng.lat).toFixed(6);
    $('accommodation-new-lng').value = Number(latlng.lng).toFixed(6);
    $('accommodation-location-summary').textContent = `已选择 ${Number(latlng.lat).toFixed(6)}, ${Number(latlng.lng).toFixed(6)}`;
    $('accommodation-editor')?.removeAttribute('hidden');
    editing = true;
    const dialog = $('accommodation-dialog');
    if (dialog?.showModal) dialog.showModal();
    else dialog?.removeAttribute('hidden');
    if (restoreAmapAfterPick) window.tibetAMap?.useReferenceMapForPicker(false);
    restoreAmapAfterPick = false;
    setStatus('位置已选择，填写名称后保存。');
  }

  function selectBase(id) {
    const base = getBase(id);
    if (!base) return;
    selectedBaseId = id;
    renderBaseList();
    const selectedLabel = $('accommodation-selected-label');
    if (selectedLabel) selectedLabel.textContent = `已选择：${base.name}`;
    setStatus('已选择住宿基地，请选择应用的晚次。');
  }

  function prepareNewBase(input = {}) {
    editing = true;
    selectedBaseId = null;
    resetEditor();
    $('accommodation-editor')?.removeAttribute('hidden');
    renderNightChoices([currentDay]);
    $('accommodation-new-name').value = String(input.name || '').trim().slice(0, 120);
    $('accommodation-new-type').value = input.type === 'area' ? 'area' : 'hotel';
    $('accommodation-new-address').value = String(input.address || '').trim().slice(0, 240);
    $('accommodation-new-notes').value = String(input.notes || '').trim().slice(0, 600);
    const latValue = String(input.lat ?? '').trim();
    const lngValue = String(input.lng ?? '').trim();
    const lat = latValue === '' ? NaN : Number(latValue);
    const lng = lngValue === '' ? NaN : Number(lngValue);
    if (validCoordinate(lat, lng)) {
      $('accommodation-new-lat').value = lat.toFixed(6);
      $('accommodation-new-lng').value = lng.toFixed(6);
      $('accommodation-location-summary').textContent = input.locationLabel || `已确认 ${lat.toFixed(6)}, ${lng.toFixed(6)}`;
      setStatus('位置已确认，核对名称后保存。');
    } else {
      setStatus('填写名称并在地图上确认位置。');
    }
    window.lucide?.createIcons();
    return {ok: true};
  }

  function assign(id, dayIndices) {
    const base = getBase(id);
    const indices = [...new Set(dayIndices.map(Number))].filter(index => overnightDays.includes(index));
    if (!base || !indices.length) return {ok: false, error: '请选择住宿晚次'};
    const next = {version: VERSION, bases: copy(state.bases), stays: {...state.stays}};
    indices.forEach(index => {
      if (base.isDefault && id === defaultStayByDay[index]) delete next.stays[index];
      else next.stays[index] = id;
    });
    const changed = indices.filter(index => getDayStay(index)?.id !== id);
    if (!changed.length) return {ok: true, changed: []};
    const result = commit(next, {type: 'assign', dayIndices: changed, routeDays: affectedRoutes(changed)});
    if (result.ok) {
      const routes = result.routeDays || affectedRoutes(changed);
      routes.forEach(routeIndex => markRouteStatus([routeIndex], getDayRoute(routeIndex)?.hasChangedEndpoint ? 'stale' : 'reference'));
      result.changed = changed;
      result.routeDays = routes;
    }
    return result;
  }

  function saveNew(applyToNights) {
    const base = normalizeBase({
      id: idForBase(),
      name: $('accommodation-new-name').value,
      type: $('accommodation-new-type').value,
      address: $('accommodation-new-address').value,
      notes: $('accommodation-new-notes').value,
      lat: $('accommodation-new-lat').value,
      lng: $('accommodation-new-lng').value
    });
    if (!base) {
      setStatus('请填写基地名称，并在地图上确认有效位置。');
      return;
    }
    const next = {version: VERSION, bases: [...state.bases, base], stays: {...state.stays}};
    const nights = applyToNights ? selectedDays() : [];
    nights.forEach(index => { next.stays[index] = base.id; });
    const changed = nights.filter(index => getDayStay(index)?.id !== base.id);
    const result = commit(next, {type: 'create', base, dayIndices: changed, routeDays: affectedRoutes(changed)});
    if (!result.ok) return;
    markRouteStatus(affectedRoutes(changed), 'stale');
    selectedBaseId = base.id;
    if (applyToNights) {
      closeDialog();
      setStatus('');
    } else {
      editing = false;
      $('accommodation-editor')?.setAttribute('hidden', '');
      renderBaseList();
      setStatus('已保存为备选住宿基地。');
    }
  }

  function applySelected() {
    if (!selectedBaseId) return;
    const result = assign(selectedBaseId, selectedDays());
    if (!result.ok) {
      setStatus(result.error);
      return;
    }
    closeDialog();
  }

  function renderMarkers() {
    if (!map || !window.L) return;
    mapMarkers.forEach(marker => marker.remove());
    mapMarkers = [];
    state.bases.forEach(base => {
      const marker = L.circleMarker([base.lat, base.lng], {radius: 7, color: '#fff', weight: 2, fillColor: '#8b654f', fillOpacity: .95, className: 'accommodation-marker'})
        .addTo(map).bindTooltip(escape(base.name), {direction: 'top'});
      mapMarkers.push(marker);
    });
  }

  function attachMap(nextMap) {
    map = nextMap;
    map.on('click', event => { if (mapPickActive) completeMapPick(event.latlng); });
    renderMarkers();
  }

  function buildDialog() {
    document.body.insertAdjacentHTML('beforeend', `<dialog id="accommodation-dialog" aria-labelledby="accommodation-dialog-title"><form id="accommodation-form"><div class="dialog-heading"><h2 id="accommodation-dialog-title">更换住宿</h2><button type="button" id="accommodation-close" title="关闭" aria-label="关闭"><i data-lucide="x"></i></button></div><p class="accommodation-dialog-intro">自定义基地只保存在当前浏览器。必须确认地图位置后才能保存。</p><section class="accommodation-existing"><div class="accommodation-section-heading"><h3>已有住宿基地</h3><span id="accommodation-selected-label"></span></div><div id="accommodation-base-list"></div><button type="button" id="accommodation-apply-selected" class="accommodation-apply" disabled>应用到所选晚次</button></section><section class="accommodation-nights"><fieldset><legend>应用到住宿晚次</legend><div id="accommodation-night-choices"></div></fieldset></section><section class="accommodation-editor" id="accommodation-editor" hidden><div class="accommodation-section-heading"><h3>新增住宿基地</h3><button type="button" id="accommodation-cancel-new">取消</button></div><label>基地名称<input id="accommodation-new-name" maxlength="120" autocomplete="off" required></label><label>类型<select id="accommodation-new-type"><option value="hotel">酒店 / 民宿</option><option value="area">住宿区域</option></select></label><label>详细地址（选填）<input id="accommodation-new-address" maxlength="240" autocomplete="street-address"></label><label>备注（选填）<textarea id="accommodation-new-notes" maxlength="600" rows="3"></textarea></label><div class="accommodation-location"><div><strong>地图位置</strong><span id="accommodation-location-summary">尚未在地图上选择位置</span></div><button type="button" id="accommodation-pick-map"><i data-lucide="crosshair"></i>在地图上选点</button></div><div class="accommodation-coordinates"><label>纬度<input id="accommodation-new-lat" inputmode="decimal" readonly required></label><label>经度<input id="accommodation-new-lng" inputmode="decimal" readonly required></label></div><div class="accommodation-editor-actions"><button type="button" id="accommodation-save-option">仅保存为备选</button><button type="button" id="accommodation-save-apply">保存并应用</button></div></section><p id="accommodation-dialog-status" role="status" aria-live="polite"></p></form></dialog><div id="accommodation-map-picker" tabindex="-1" role="status" hidden>请在地图上点击住宿代表位置 <button type="button" id="accommodation-cancel-pick">取消选点</button></div>`);
    $('accommodation-close').onclick = closeDialog;
    $('accommodation-cancel-new').onclick = () => { resetEditor(); renderBaseList(); };
    $('accommodation-pick-map').onclick = startMapPick;
    $('accommodation-cancel-pick').onclick = cancelMapPick;
    $('accommodation-save-option').onclick = () => saveNew(false);
    $('accommodation-save-apply').onclick = () => saveNew(true);
    $('accommodation-apply-selected').onclick = applySelected;
    $('accommodation-base-list').addEventListener('click', event => {
      const button = event.target.closest('[data-accommodation-select]');
      if (!button) return;
      selectBase(button.dataset.accommodationSelect);
    });
    $('accommodation-form').addEventListener('submit', event => event.preventDefault());
    $('accommodation-editor')?.insertAdjacentHTML('beforebegin', '<button type="button" id="accommodation-add-toggle" class="accommodation-add"><i data-lucide="plus"></i>新增住宿基地</button>');
    $('accommodation-add-toggle').onclick = () => { editing = true; selectedBaseId = null; resetEditor(); $('accommodation-editor')?.removeAttribute('hidden'); renderNightChoices([currentDay]); setStatus('填写名称并在地图上确认位置。'); };
    document.addEventListener('click', event => {
      const button = event.target.closest('[data-accommodation-open]');
      if (button) openDialog(Number(button.dataset.accommodationOpen));
    });
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && mapPickActive) { event.preventDefault(); cancelMapPick(); } });
    window.lucide?.createIcons();
  }

  function getState() {
    const stays = {};
    overnightDays.forEach(index => { stays[index] = getDayStay(index)?.id || null; });
    return {version: VERSION, bases: copy(state.bases), stays, usedBaseIds: getUsedBaseIds(), baseCount: getBaseCount()};
  }

  function getUsedBaseIds() {
    return [...new Set(overnightDays.map(index => getDayStay(index)?.id).filter(Boolean))];
  }

  function getBaseCount() {
    return getUsedBaseIds().length;
  }

  window.tibetAccommodation = {
    version: VERSION,
    storageKey: STORAGE_KEY,
    overnightDays: [...overnightDays],
    listBases: () => [...defaultBases, ...state.bases].map(copy),
    getBase: id => { const base = getBase(id); return base ? copy(base) : null; },
    getState,
    getDayStay: index => copy(getDayStay(index)),
    getDayRoute,
    getRouteState: routeState,
    getAffectedRoutes: affectedRoutes,
    getUsedBaseIds,
    getBaseCount,
    assign,
    selectBase: id => {
      const base = getBase(id);
      if (!base) return {ok: false, error: '住宿基地不存在'};
      selectBase(id);
      return {ok: true, base: copy(base)};
    },
    prepareNewBase,
    saveBase: input => {
      const base = normalizeBase(input);
      if (!base) return {ok: false, error: '请填写基地名称和有效位置'};
      const persistedBase = {...base, id: input.id || base.id};
      const next = {version: VERSION, bases: [...state.bases, persistedBase], stays: {...state.stays}};
      const result = commit(next, {type: 'create', base: persistedBase, dayIndices: [], routeDays: []});
      return result.ok ? {...result, base: next.bases.at(-1)} : result;
    },
    markRouteStatus,
    onChange: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    open: openDialog,
    attachMap
  };

  buildDialog();
})();
