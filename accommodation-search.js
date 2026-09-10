(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.tibetAccommodationSearch = api;
})(typeof window !== 'undefined' ? window : globalThis, function (host) {
  const DUPLICATE_DISTANCE_METERS = 1500;
  const resultLimit = 8;

  function number(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function coordinates(location) {
    if (!location) return null;
    const lng = number(location.getLng?.() ?? location.lng ?? location[0]);
    const lat = number(location.getLat?.() ?? location.lat ?? location[1]);
    return lng !== null && lat !== null ? {lng, lat} : null;
  }

  function normalizePoi(poi, transform = host.coordtransform?.gcj02towgs84) {
    const point = coordinates(poi?.location);
    const name = String(poi?.name || '').trim();
    if (!point || !name) return null;
    const converted = typeof transform === 'function' ? transform(point.lng, point.lat) : [point.lng, point.lat];
    const lng = number(converted?.[0]);
    const lat = number(converted?.[1]);
    if (lng === null || lat === null) return null;
    return {
      id: String(poi.id || `amap-${name}-${point.lng}-${point.lat}`),
      name: name.slice(0, 120),
      address: String(poi.address || poi.pname || poi.adname || '').trim().slice(0, 240),
      type: 'hotel',
      lat,
      lng,
      source: 'amap',
      sourceLocation: {lat: point.lat, lng: point.lng},
      city: String(poi.cityname || poi.city || '').trim()
    };
  }

  function distanceMeters(first, second) {
    const a = coordinates({lat: first?.lat, lng: first?.lng});
    const b = coordinates({lat: second?.lat, lng: second?.lng});
    if (!a || !b) return Infinity;
    const radius = 6371008.8;
    const toRadians = value => value * Math.PI / 180;
    const dLat = toRadians(b.lat - a.lat);
    const dLng = toRadians(b.lng - a.lng);
    const latA = toRadians(a.lat);
    const latB = toRadians(b.lat);
    const haversine = Math.sin(dLat / 2) ** 2 + Math.cos(latA) * Math.cos(latB) * Math.sin(dLng / 2) ** 2;
    return 2 * radius * Math.asin(Math.sqrt(Math.min(1, haversine)));
  }

  function normalizedName(value) {
    return String(value || '').trim().replace(/\s+/g, '').toLocaleLowerCase();
  }

  function findDuplicates(candidate, bases, threshold = DUPLICATE_DISTANCE_METERS) {
    const name = normalizedName(candidate?.name);
    if (!name) return [];
    return (Array.isArray(bases) ? bases : []).filter(base => (
      normalizedName(base?.name) === name && distanceMeters(candidate, base) <= threshold
    ));
  }

  function placeSearchReady(AMap) {
    if (AMap?.PlaceSearch) return Promise.resolve(AMap);
    if (typeof AMap?.plugin !== 'function') {
      const error = new Error('高德地点搜索不可用');
      error.code = 'unavailable';
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (AMap.PlaceSearch) resolve(AMap);
        else {
          const error = new Error('高德地点搜索插件未就绪');
          error.code = 'unavailable';
          reject(error);
        }
      };
      try {
        AMap.plugin('AMap.PlaceSearch', finish);
      } catch (error) {
        if (!settled) {
          settled = true;
          error.code = error.code || 'unavailable';
          reject(error);
        }
      }
    });
  }

  function searchPlaces(keyword, options = {}) {
    const query = String(keyword || '').trim();
    if (!query) {
      const error = new Error('请输入住宿名称或区域');
      error.code = 'empty';
      return Promise.reject(error);
    }
    const AMap = options.AMap || host.AMap;
    return placeSearchReady(AMap).then(ready => new Promise((resolve, reject) => {
      let service;
      try {
        service = options.placeSearch || new ready.PlaceSearch({city: '全国', citylimit: false, pageSize: resultLimit});
        service.search(query, (status, result) => {
          if (status !== 'complete') {
            const error = new Error('高德地点搜索失败');
            error.code = status === 'no_data' ? 'no-results' : 'network';
            reject(error);
            return;
          }
          const pois = result?.poiList?.pois || result?.pois || [];
          const normalized = pois.map(poi => normalizePoi(poi, options.transform || host.coordtransform?.gcj02towgs84)).filter(Boolean).slice(0, resultLimit);
          resolve(normalized);
        });
      } catch (error) {
        error.code = error.code || 'network';
        reject(error);
      }
    }));
  }

  const api = {
    duplicateDistanceMeters: DUPLICATE_DISTANCE_METERS,
    coordinates,
    distanceMeters,
    findDuplicates,
    normalizePoi,
    placeSearchReady,
    searchPlaces
  };

  if (!host.document) return api;

  const escape = host.TibetAMapUtils.escapeHtml;

  function setStatus(message) {
    const element = host.document.getElementById('accommodation-search-status');
    if (element) element.textContent = message;
  }

  function showManualFallback(message, query) {
    const accommodation = host.tibetAccommodation;
    const value = id => host.document.getElementById(id)?.value || '';
    const summary = host.document.getElementById('accommodation-location-summary')?.textContent || '';
    if (accommodation?.prepareNewBase) accommodation.prepareNewBase({
      name: value('accommodation-new-name') || query,
      type: value('accommodation-new-type'),
      address: value('accommodation-new-address'),
      notes: value('accommodation-new-notes'),
      lat: value('accommodation-new-lat'),
      lng: value('accommodation-new-lng'),
      locationLabel: summary
    });
    setStatus(`${message} 可继续在地图上选点，已填写的内容不会丢失。`);
  }

  function renderResults(results) {
    const list = host.document.getElementById('accommodation-search-results');
    if (!list) return;
    list.innerHTML = results.map((result, index) => `<article class="accommodation-search-result"><div><strong>${escape(result.name)}</strong><small>${escape(result.address || '已返回地图位置')}</small></div><button type="button" data-accommodation-search-confirm="${index}">确认此地点</button></article>`).join('');
  }

  function renderDuplicates(candidate, duplicates) {
    const element = host.document.getElementById('accommodation-search-duplicates');
    if (!element) return;
    element.innerHTML = `<strong>发现可能重复的住宿基地</strong><p>名称相同且位置相近。可以使用已有基地，也可以继续新增以保留不同酒店。</p>${duplicates.map(base => `<button type="button" data-accommodation-search-reuse="${escape(base.id)}">使用已有：${escape(base.name)}</button>`).join('')}<button type="button" data-accommodation-search-continue="true">继续新增「${escape(candidate.name)}」</button>`;
    element.removeAttribute('hidden');
  }

  function hideDuplicates() {
    const element = host.document.getElementById('accommodation-search-duplicates');
    if (element) {
      element.setAttribute('hidden', '');
      element.replaceChildren();
    }
  }

  function continueWithResult(result) {
    hideDuplicates();
    host.tibetAccommodation?.prepareNewBase?.({
      name: result.name,
      type: result.type,
      address: result.address,
      lat: result.lat,
      lng: result.lng,
      locationLabel: `已确认高德地点 · ${result.address || `${result.lat.toFixed(6)}, ${result.lng.toFixed(6)}`}`
    });
    setStatus('地点已确认，核对名称和住宿晚次后保存。');
  }

  function confirmResult(result) {
    const accommodation = host.tibetAccommodation;
    const duplicates = findDuplicates(result, accommodation?.listBases?.() || []);
    if (duplicates.length) {
      renderDuplicates(result, duplicates);
      setStatus('请确认是使用已有基地，还是继续新增。');
      return;
    }
    continueWithResult(result);
  }

  function mount() {
    const dialog = host.document.getElementById('accommodation-dialog');
    const form = host.document.getElementById('accommodation-form');
    if (!dialog || !form || host.document.getElementById('accommodation-search')) return;
    form.insertAdjacentHTML('afterbegin', `<section class="accommodation-search" id="accommodation-search"><div class="accommodation-section-heading"><h3>搜索住宿地点</h3><span>高德地点</span></div><label for="accommodation-search-query">名称或区域<input id="accommodation-search-query" type="search" maxlength="120" autocomplete="off" placeholder="例如：额尔古纳湿地附近"></label><button type="button" id="accommodation-search-submit" class="accommodation-search-submit"><i data-lucide="search"></i>搜索地点</button><p id="accommodation-search-status" role="status" aria-live="polite"></p><div id="accommodation-search-results" aria-live="polite"></div><div id="accommodation-search-duplicates" role="alert" hidden></div></section>`);
    const queryInput = host.document.getElementById('accommodation-search-query');
    const submit = host.document.getElementById('accommodation-search-submit');
    let results = [];
    let pendingResult = null;
    const runSearch = async () => {
      const query = queryInput.value.trim();
      if (!query) {
        setStatus('请输入住宿名称或区域。');
        queryInput.focus();
        return;
      }
      submit.disabled = true;
      hideDuplicates();
      renderResults([]);
      pendingResult = null;
      setStatus('正在搜索高德地点…');
      try {
        results = await searchPlaces(query);
        if (!results.length) {
          setStatus('没有找到匹配地点。请修改关键词，或继续在地图上选点。');
          return;
        }
        renderResults(results);
        setStatus(`找到 ${results.length} 个地点，请确认位置后再保存。`);
      } catch (error) {
        results = [];
        renderResults([]);
        if (error.code === 'empty') setStatus(error.message);
        else if (error.code === 'unavailable') showManualFallback('地点搜索需要先连接高德地图。', query);
        else if (error.code === 'no-results') setStatus('没有找到匹配地点。请修改关键词，或继续在地图上选点。');
        else showManualFallback('地点搜索暂时不可用。', query);
      } finally {
        submit.disabled = false;
      }
    };
    submit.addEventListener('click', runSearch);
    queryInput.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        runSearch();
      }
    });
    host.document.getElementById('accommodation-search-results').addEventListener('click', event => {
      const button = event.target.closest('[data-accommodation-search-confirm]');
      if (!button) return;
      const result = results[Number(button.dataset.accommodationSearchConfirm)];
      if (result) {
        pendingResult = result;
        confirmResult(result);
      }
    });
    host.document.getElementById('accommodation-search-duplicates').addEventListener('click', event => {
      const reuse = event.target.closest('[data-accommodation-search-reuse]');
      if (reuse) {
        const selected = host.tibetAccommodation?.selectBase?.(reuse.dataset.accommodationSearchReuse);
        if (selected?.ok) {
          hideDuplicates();
          setStatus('已选择已有基地，请选择住宿晚次并应用。');
        }
        return;
      }
      if (event.target.closest('[data-accommodation-search-continue]')) {
        if (pendingResult) continueWithResult(pendingResult);
      }
    });
    host.lucide?.createIcons();
  }

  api.mount = mount;
  if (host.document.readyState === 'loading') host.document.addEventListener('DOMContentLoaded', mount, {once: true});
  else mount();
  return api;
});
