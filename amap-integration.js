(() => {
  const $ = id => document.getElementById(id);
  const utils = window.TibetAMapUtils;
  let map, trafficLayer, overlays = [], selectedDay = 0, wholeTrip = false;
  let requestId = 0, queryTimer, refreshTimer, loading = false;
  const overrides = new Map();
  const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const routePanel = document.querySelector('.route-panel');
  routePanel.insertAdjacentHTML('afterbegin', `<div class="trip-map-toolbar"><span id="amap-state" role="status">高德未配置 · 当前为参考地图</span><div><label><input id="traffic-toggle" type="checkbox" checked disabled>实时路况</label><button id="amap-refresh" title="刷新路线时间与路况" aria-label="刷新路线时间与路况" disabled><i data-lucide="refresh-cw"></i></button><button id="amap-settings" title="配置高德地图" aria-label="配置高德地图"><i data-lucide="settings-2"></i></button></div></div>`);
  document.querySelector('.map-wrap').insertAdjacentHTML('afterbegin', '<div id="amap-canvas" aria-label="高德地图与实时交通" hidden></div>');
  document.querySelector('.route-strip').insertAdjacentHTML('afterend', `<section class="amap-live" aria-label="高德路线与路况"><div class="live-header"><h2 id="live-title">高德驾车时间与路况</h2><button id="connect-amap">连接高德地图</button></div><p id="live-status" role="status">尚未连接，暂无法获取实时驾驶时间与路况。</p><form id="route-endpoints" hidden><label>出发地<input id="route-from" required maxlength="120" autocomplete="off"></label><label>目的地<input id="route-to" required maxlength="120" autocomplete="off"></label><button type="submit">规划路线</button></form><div id="live-results"></div><p class="traffic-disclaimer">当前路况不代表 10 月出发当天；无覆盖路段标为未知。驾驶时间不含游览、休息、停车与景区排队。</p></section>`);
  document.body.insertAdjacentHTML('beforeend', `<dialog id="amap-dialog" aria-labelledby="amap-dialog-title"><form id="amap-form"><div class="dialog-heading"><h2 id="amap-dialog-title">连接高德地图</h2><button type="button" id="amap-close" title="关闭" aria-label="关闭"><i data-lucide="x"></i></button></div><p>填写高德开放平台「Web端（JS API）」凭据。本页输入仅在当前标签页生效，不保存到浏览器。</p><label>JS API Key<input id="amap-key" type="password" autocomplete="off" required spellcheck="false"></label><label>安全密钥 securityJsCode<input id="amap-security" type="password" autocomplete="off" required spellcheck="false"></label><p id="amap-form-status" role="status"></p><div class="dialog-actions"><a href="https://console.amap.com/dev/key/app" target="_blank" rel="noopener">申请 Key</a><button type="submit" id="amap-connect">连接地图</button></div></form></dialog>`);
  const openSettings = () => {
    $('amap-dialog').showModal();
    if(map) {
      $('amap-form-status').textContent='当前标签页已连接。更换凭据前请刷新页面，避免混用不同应用的权限。';
      $('amap-connect').disabled=true;
    }
  };
  $('traffic-toggle').checked=false;
  $('amap-settings').onclick = openSettings;
  $('connect-amap').onclick = openSettings;
  $('amap-close').onclick = () => $('amap-dialog').close();
  $('amap-refresh').onclick = () => { trafficLayer?.reload(); query(); };
  $('traffic-toggle').onchange = event => {
    if (event.target.checked) trafficLayer.show(); else trafficLayer.hide();
  };
  $('route-endpoints').onsubmit = event => {
    event.preventDefault();
    overrides.set(selectedDay, [$('route-from').value.trim(), $('route-to').value.trim()]);
    wholeTrip = false;
    query();
  };
  function status(message) { $('live-status').textContent = message; }
  function clearRoute() {
    if (overlays.length) map.remove(overlays);
    overlays = [];
    $('live-results').replaceChildren();
    document.getElementById('amap-time-badge')?.remove();
    document.getElementById('overview-times')?.remove();
  }
  function endpoints() {
    const d = window.tibetTrip.days[selectedDay];
    return overrides.get(selectedDay) || d.nav.map(n => n.replace('巴松措景区游客中心','巴松措景区'));
  }
  function renderForm() {
    const names = endpoints();
    $('route-from').value = names[0];
    $('route-to').value = names[1];
    $('route-endpoints').hidden = !map || wholeTrip;
    $('live-title').textContent = wholeTrip ? '全程路线 · 按当前路况估算' : `${window.tibetTrip.days[selectedDay].date} · 高德驾车路线`;
  }
  function line(path, color, weight = 6) {
    if (!Array.isArray(path) || path.length < 2) return;
    overlays.push(new AMap.Polyline({path, strokeColor:color, strokeWeight:weight, isOutline:true, outlineColor:'#fff', borderWeight:1, lineJoin:'round', zIndex:60}));
  }
  function showRoute(route, result) {
    const path = (route.steps || []).flatMap(step => step.path || []);
    line(path, utils.colors['未知']);
    const traffic = utils.traffic(route);
    const queryTime=new Date().toLocaleTimeString('zh-CN',{hour12:false});
    const timeText=utils.duration(route.time);
    const timeContent=`<small>${wholeTrip?'全程驾驶合计':'本段预计驾驶'}</small><strong>${timeText}</strong><span>高德估算 · ${queryTime}</span>`;
    const badge=document.createElement('div');
    badge.id='amap-time-badge';
    badge.className='map-time-badge';
    badge.innerHTML=timeContent;
    document.querySelector('.map-wrap').append(badge);
    traffic.segments.forEach(segment => line(segment.path, utils.colors[segment.status]));
    if (path.length) {
      if(!wholeTrip)overlays.push(new AMap.Marker({position:path[Math.floor(path.length/2)],anchor:'bottom-center',offset:new AMap.Pixel(0,-14),content:`<div class="amap-route-time">${timeContent}</div>`,zIndex:200}));
      if(wholeTrip)window.tibetTrip.showOverviewTimes();
      // Default SDK marker URLs inherit file:// when the guide is opened locally.
      overlays.push(new AMap.Marker({position:path[0],anchor:'center',content:'<div class="trip-endpoint trip-endpoint-start" role="img" aria-label="起点" title="起点">起</div>',zIndex:210}));
      overlays.push(new AMap.Marker({position:path.at(-1),anchor:'center',content:'<div class="trip-endpoint trip-endpoint-end" role="img" aria-label="终点" title="终点">终</div>',zIndex:210}));
      if(!wholeTrip) {
        const position=(point,name)=>`${point.getLng?.() ?? point.lng ?? point[0]},${point.getLat?.() ?? point.lat ?? point[1]},${name}`;
        const params=new URLSearchParams({mode:'car',policy:'1',callnative:'1',src:'tibet-slow-trip',to:position(path.at(-1),$('route-to').value)});
        const day=window.tibetTrip.days[selectedDay];
        if(day.points.length>2){const via=window.tibetTrip.points[day.points[1]];const xy=coordtransform.wgs84togcj02(via.xy[1],via.xy[0]);params.set('via',`${xy[0]},${xy[1]},${via.name}`);}
        const currentLink=document.querySelector('.navigation-current');
        if(currentLink)currentLink.href=`https://uri.amap.com/navigation?${params}`;
        params.set('from',position(path[0],$('route-from').value));
        document.querySelector('.navigation-primary').href=`https://uri.amap.com/navigation?${params}`;
      }
    }
    map.add(overlays);
    if (overlays.length) map.setFitView(overlays, false, wholeTrip?(innerWidth<720?[100,45,210,45]:[90,55,70,230]):[70,55,70,55]);
    const timestamp = new Date().toLocaleString('zh-CN', {hour12:false});
    status(`高德路线查询成功 · ${timestamp}（本地时间）`);
    const rows = Object.entries(traffic.totals).filter(([,distance])=>distance>0);
    $('live-results').innerHTML = `<div class="live-metrics"><div><span>预计驾驶</span><strong>${utils.duration(route.time)}</strong></div><div><span>路线距离</span><strong>${(Number(route.distance)/1000).toFixed(1)} km</strong></div><div><span>路况数据</span><strong>${traffic.known?'已返回分段路况':'暂无覆盖'}</strong></div></div><div class="traffic-summary">${rows.map(([name,distance])=>`<span><b style="background:${utils.colors[name]}"></b>${name} ${(distance/1000).toFixed(1)} km</span>`).join('')}</div><p class="resolved-endpoints">${escape(result.start?.name || $('route-from').value)} → ${escape(result.end?.name || $('route-to').value)}。请核对具体入口；可修改上方酒店或航站楼名称重新规划。</p><details class="road-details"><summary>沿途道路与转向</summary><ol>${(route.steps||[]).map(step=>`<li><strong>${escape(step.road || '连接道路')}</strong><span>${escape(step.instruction || '')}</span></li>`).join('')}</ol></details>`;
  }
  function query() {
    if (!map) return;
    clearTimeout(queryTimer);
    const version = ++requestId;
    clearRoute();
    renderForm();
    $('amap-refresh').disabled = true;
    const day = window.tibetTrip.days[selectedDay];
    if (!wholeTrip && day.points.length < 2 && !overrides.has(selectedDay)) {
      status('今天留在结巴村与巴松措休息，不安排长途驾驶；景区内按接驳安排出行。');
      const p=window.tibetTrip.points[day.points[0]].xy;
      map.setZoomAndCenter(12, coordtransform.wgs84togcj02(p[1],p[0]));
      const badge=document.createElement('div');badge.id='amap-time-badge';badge.className='map-time-badge';badge.innerHTML='<small>10/5 · 结巴村与巴松措</small><strong>无长途驾驶</strong><span>湖边休息日</span>';document.querySelector('.map-wrap').append(badge);
      $('amap-refresh').disabled = false;
      return;
    }
    status('正在获取高德路线、预计驾驶时间与路况…');
    const names=endpoints();
    const stops=wholeTrip?window.tibetTrip.overviewStops.map(s=>({...s})):[{keyword:names[0],city:day.cities[0]},...(day.via||[]).map(s=>({...s})),{keyword:names[1],city:day.cities[1]}];
    // Search without automatic drawing so stale callbacks cannot replace the selected day.
    const driving = new AMap.Driving({extensions:'all', policy:AMap.DrivingPolicy.REAL_TRAFFIC});
    queryTimer = setTimeout(()=>{
      if(version!==requestId)return;
      requestId++;
      status('路线查询超时，请刷新重试；暂不显示时间与路况。');
      $('amap-refresh').disabled=false;
    },wholeTrip?60000:20000);
    const onResult = (state,result)=>{
      if(version!==requestId)return;
      clearTimeout(queryTimer);
      $('amap-refresh').disabled=false;
      if(state!=='complete'||!result?.routes?.length) {
        status('未取得路线。请检查地点名称、Key 服务权限与配额，然后刷新重试。');
        return;
      }
      showRoute(result.routes[0],result);
    };
    if(wholeTrip){
      const planned=window.tibetTrip.days.filter(d=>d.points.length>1);
      const collected=[];
      const next=index=>{
        if(version!==requestId)return;
        if(index===planned.length){
          const combined=collected.reduce((total,r)=>({distance:total.distance+r.distance,time:total.time+r.time,steps:[...total.steps,...r.steps]}),{distance:0,time:0,steps:[]});
          onResult('complete',{routes:[combined],start:{name:'林芝米林机场'},end:{name:'拉萨贡嘎国际机场'}});
          return;
        }
        status(`正在查询第 ${index+1}/${planned.length} 段高德路线…`);
        const d=planned[index];
        const segment=[{keyword:d.nav[0],city:d.cities[0]},...(d.via||[]).map(s=>({...s})),{keyword:d.nav[1],city:d.cities[1]}];
        try{driving.search(segment,(state,result)=>{
          if(version!==requestId)return;
          if(state!=='complete'||!result?.routes?.length){onResult(state,result);return;}
          collected.push(result.routes[0]);
          setTimeout(()=>next(index+1),600);
        });}catch{onResult('error',null);}
      };
      next(0);
    }else{
      try { driving.search(stops,onResult); }
      catch { onResult('error',null); }
    }
  }
  function loadSDK(config) {
    return new Promise((resolve,reject)=>{
      if(window.AMap?.Driving) { resolve(); return; }
      window._AMapSecurityConfig = {securityJsCode:config.securityJsCode};
      const script = document.createElement('script');
      const callback = `tibetAmapReady${Date.now()}`;
      const timer = setTimeout(()=>finish(new Error('高德加载超时，请检查网络、Key 类型与域名白名单。')),20000);
      function finish(error) {
        clearTimeout(timer);
        window[callback] = () => {};
        if(error) {script.remove();reject(error);} else resolve();
      }
      window[callback] = () => window.AMap?.Driving ? finish() : finish(new Error('高德插件未就绪，请检查 Key 与安全密钥后刷新页面。'));
      script.onerror = () => finish(new Error('无法加载高德地图，请检查网络与域名白名单。'));
      script.src = `https://webapi.amap.com/maps?${new URLSearchParams({v:'2.0',key:config.key,plugin:'AMap.Driving,AMap.ToolBar,AMap.Scale',callback})}`;
      document.head.append(script);
    });
  }
  async function connect(config) {
    if(loading)return;
    loading=true;
    $('amap-connect').disabled=true;
    $('amap-form-status').textContent='正在连接高德地图…';
    try {
      await loadSDK(config);
      if(!map) {
        $('amap-canvas').hidden=false;
        map = new AMap.Map('amap-canvas',{viewMode:'2D',center:[92.5,29.7],zoom:7,resizeEnable:true});
        map.addControl(new AMap.ToolBar({position:'RB'}));
        map.addControl(new AMap.Scale());
        trafficLayer = new AMap.TileLayer.Traffic({autoRefresh:true,interval:180});
        map.add(trafficLayer);
        document.querySelector('.map-wrap').classList.add('amap-active');
        $('traffic-toggle').disabled=false;
        $('traffic-toggle').checked=true;
        refreshTimer=setInterval(()=>{if(!document.hidden)query();},180000);
      }
      $('amap-state').textContent='高德地图 · 当前路况';
      $('connect-amap').hidden=true;
      $('amap-dialog').close();
      $('amap-key').value='';
      $('amap-security').value='';
      $('amap-form-status').textContent='';
      query();
    } catch(error) {
      $('amap-form-status').textContent=error.message;
      $('amap-state').textContent='高德连接失败 · 当前为参考地图';
      status(error.message);
    } finally {
      loading=false;
      $('amap-connect').disabled=false;
    }
  }
  $('amap-form').onsubmit=event=>{
    event.preventDefault();
    if(window.AMap && !map) {
      $('amap-form-status').textContent='SDK 已加载但未能初始化，请刷新页面后重新填写凭据。';
      return;
    }
    connect({key:$('amap-key').value.trim(),securityJsCode:$('amap-security').value.trim()});
  };
  window.tibetAMap = {
    select(index) {selectedDay=index;wholeTrip=false;renderForm();if(map)query();},
    overview() {if(!map)return false;wholeTrip=true;query();return true;}
  };
  window.addEventListener('beforeunload',()=>{clearInterval(refreshTimer);clearTimeout(queryTimer);map?.destroy();});
  const config=window.TIBET_AMAP_CONFIG;
  if(config?.key&&config?.securityJsCode)connect(config);
  lucide.createIcons();
})();
