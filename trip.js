const {days,points}=window.tripPlan;
const accommodation=window.tibetAccommodation;
let selectedDay=0;
const icon=name=>`<i data-lucide="${name}"></i>`;
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const searchUrl=name=>`https://uri.amap.com/search?keyword=${encodeURIComponent(name)}&callnative=0`;
const legByDay = {0:0,1:1,2:2,3:3,4:4,5:5,6:6};
function navigationUrl(dayIndex, currentLocation = false) {
  const d = days[dayIndex];
  const route = accommodation?.getDayRoute(dayIndex);
  if (!route) return searchUrl(d.nav[1]);
  const endpoint = (point, name) => {
    const [lat, lng] = point.lat != null ? [point.lat, point.lng] : points[point.key].xy;
    const converted = coordtransform.wgs84togcj02(lng, lat);
    return `${converted[0].toFixed(6)},${converted[1].toFixed(6)},${name}`;
  };
  const changedEndpoint=route.hasChangedEndpoint;
  const legacyFrom={lat:points[d.points[0]].xy[0],lng:points[d.points[0]].xy[1],name:d.nav[0]};
  const legacyTo={lat:points[d.points.at(-1)].xy[0],lng:points[d.points.at(-1)].xy[1],name:d.nav[1]};
  const from=changedEndpoint?route.from:legacyFrom;
  const to=changedEndpoint?route.to:legacyTo;
  const params = new URLSearchParams({
    to: endpoint(to, to.name),
    mode: 'car', policy: '1', src: 'hailar-slow-trip', callnative: '1'
  });
  if (!currentLocation) params.set('from', endpoint(from, from.name));
  const via=changedEndpoint?route.via[0]:d.points.length>2?{lat:points[d.points[1]].xy[0],lng:points[d.points[1]].xy[1],name:points[d.points[1]].name}:null;
  if(via)params.set('via',endpoint(via,via.name));
  return `https://uri.amap.com/navigation?${params}`;
}
function navigationPanel(dayIndex) {
  const d = days[dayIndex];
  const route = accommodation?.getDayRoute(dayIndex);
  const routeState = accommodation?.getRouteState(dayIndex) || {status:'reference'};
  const stale = routeState.status === 'stale' || routeState.status === 'pending' || routeState.status === 'unupdated';
  const leg = route?.hasChangedEndpoint || stale ? null : window.roadRoutes.legs[legByDay[dayIndex]];
  const localDay = d.points.length < 2;
  const roads = leg ? leg.roads.filter(r=>/^[GS]\d/.test(r)).join(' → ') : '';
  const fromName = route?.from?.name || d.nav[0];
  const toName = route?.to?.name || d.nav[1];
  const routeDescription = routeState.status === 'updated' && Number.isFinite(routeState.distance)
    ? `已更新 ${(routeState.distance/1000).toFixed(1)} km · ${routeState.durationText || '驾车时间已更新'}`
    : stale ? '路线未更新' : leg ? `参考里程约 ${(leg.distance/1000).toFixed(0)} km${roads?' · '+roads:''}` : '市内目的地 · 以高德实时规划为准';
  const routeNote = stale
    ? `住宿端点已变化，${routeState.status === 'pending' ? '正在重新查询路线。' : '当前没有可用的新路线结果，请连接高德地图后重试。'}${route?.from?.type === 'area' || route?.to?.type === 'area' ? '住宿区域按代表位置估算。' : ''}`
    : localDay ? '当天不安排长途驾驶，景区内交通以观光车及酒店接驳为准。' : '起终点为区域参考位置，请在高德中确认酒店、景区入口或航站楼。手机可调起高德；当前位置导航需要手机定位。';
  return `<div class="navigation-panel"><div><span class="eyebrow">${stale ? '路线状态' : localDay ? '当地休整日' : '驾车路线'}</span><strong>${escapeHtml(fromName)} → ${escapeHtml(toName)}</strong><p class="route-estimate ${stale ? 'is-stale' : ''}">${routeDescription}</p></div><div class="navigation-actions"><a class="navigation-primary" href="${navigationUrl(dayIndex)}" target="_blank" rel="noopener">${icon(localDay?'map-pin':'navigation')}${localDay?'查看当天住处':'高德路线规划'}</a>${localDay?'':`<a class="navigation-current" href="${navigationUrl(dayIndex,true)}" target="_blank" rel="noopener">${icon('locate-fixed')}从当前位置导航</a>`}</div><p class="navigation-note">${routeNote}</p></div>`;
}
function detail(d,index){
  const stay=accommodation?.getDayStay(index);
  const routeState=accommodation?.getRouteState(index) || {status:'reference'};
  const routeChanged=routeState.status === 'stale' || routeState.status === 'pending' || routeState.status === 'unupdated';
  const stayName=stay?.name || d.stay;
  const stayMeta=stay ? `${stay.type === 'area' ? '住宿区域 · ' : ''}${stay.address ? escapeHtml(stay.address) : '已确认地图位置'}` : '';
  const driveText=routeChanged ? '路线未更新' : routeState.status === 'updated' && Number.isFinite(routeState.distance) ? `已更新 ${(routeState.distance/1000).toFixed(1)} km · ${routeState.durationText || '驾车时间已更新'}` : d.drive;
  const schedule=d.schedule.map(row=>routeChanged ? [row[0],row[1],String(row[2]).replace(/约[^，。]*驾驶/g,'路线未更新，待重新查询')] : row);
  const accommodationCard=stay ? `<div class="stay-card"><div><span class="eyebrow">本晚住宿</span><strong>${escapeHtml(stayName)}</strong><small>${stayMeta}</small>${stay.notes ? `<p>${escapeHtml(stay.notes)}</p>` : ''}</div><button type="button" data-accommodation-open="${index}">${icon('replace')}更换住宿</button></div>` : '';
  return `<div class="detail-heading"><div><p class="eyebrow">DAY ${String(index+1).padStart(2,'0')} / ${d.date} ${d.weekday}</p><h2>${escapeHtml(d.title)}</h2></div><span class="tag">${escapeHtml(d.pace)}</span></div><p class="day-desc">${escapeHtml(d.desc)}</p><div class="day-stats"><span>${icon('car-front')}${escapeHtml(driveText)}</span><span>${icon('bed-double')}${escapeHtml(stayName)}</span><span>${icon('mountain')}${escapeHtml(d.alt)}</span></div>${accommodationCard}<div class="timeline">${schedule.map(s=>`<div class="time-row"><time>${escapeHtml(s[0])}</time><div><strong>${escapeHtml(s[1])}</strong><p>${escapeHtml(s[2])}</p></div></div>`).join('')}</div><p class="day-tip">${escapeHtml(d.tip)}</p><div class="day-links"><a href="${searchUrl(stay?.name || d.nav[1])}" target="_blank" rel="noopener">${icon('map-pin')}高德查看目的地${icon('arrow-up-right')}</a><a href="${searchUrl(stay?.name || d.nav[0])}" target="_blank" rel="noopener">查看出发地${icon('arrow-up-right')}</a></div>`;
}
const map=L.map('route-map',{zoomControl:false,scrollWheelZoom:false,minZoom:5,maxZoom:16}).setView([49.5,119.5],7);
const tiles=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · Routing: OSRM',maxZoom:19}).addTo(map);
const satellite=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{attribution:'Imagery © Esri, Maxar, Earthstar Geographics',maxNativeZoom:17});
L.control.layers({'道路地图':tiles,'卫星地图':satellite},null,{position:'topright'}).addTo(map);
L.control.zoom({position:'bottomright'}).addTo(map);
const allKeys=['airportH','hailar','morigele','erguna','mordaoga','shiwei','heishantou','caidaihe','manzhouli','hulunlake'];
const bounds=L.latLngBounds(allKeys.map(k=>points[k].xy));
const roadLines = window.roadRoutes.legs.map(leg=>leg.coordinates.map(([lng,lat])=>[lat,lng]));
const fullRouteLayer=L.layerGroup().addTo(map);
const timeLabelLayer=L.layerGroup().addTo(map);
const routeEstimates=window.tripPlan.estimates;
function routeGeometry(index){
  const route=accommodation?.getDayRoute(index);
  const state=accommodation?.getRouteState(index) || {status:'reference'};
  if(route?.hasChangedEndpoint){
    return state.status==='updated' && Array.isArray(state.coordinates) && state.coordinates.length>1 ? state.coordinates : null;
  }
  return state.status==='stale'||state.status==='pending'||state.status==='unupdated' ? null : roadLines[legByDay[index]];
}
function routeIsStale(index){
  const status=accommodation?.getRouteState(index)?.status;
  return !routeGeometry(index) || status==='stale'||status==='pending'||status==='unupdated';
}
function routeMidpoint(coords) {
  const lengths=coords.slice(1).map((point,i)=>L.latLng(coords[i]).distanceTo(point));
  const halfway=lengths.reduce((a,b)=>a+b,0)/2;
  let distance=0;
  for(let i=0;i<lengths.length;i++){
    if(distance+lengths[i]>=halfway)return coords[i];
    distance+=lengths[i];
  }
  return coords[Math.floor(coords.length/2)];
}
function showTimeLabels(indices) {
  timeLabelLayer.clearLayers();
  indices.forEach(index=>{
    const geometry=routeGeometry(index);
    if(!geometry)return;
    const estimate=routeEstimates[index];
    const route=accommodation?.getDayRoute(index);
    const state=accommodation?.getRouteState(index) || {};
    const changed=Boolean(route?.hasChangedEndpoint);
    const title=changed ? `${escapeHtml(route.from.name)} → ${escapeHtml(route.to.name)}` : estimate.title;
    const time=changed ? (state.durationText || '已更新') : estimate.time;
    L.marker(routeMidpoint(geometry),{
      icon:L.divIcon({className:`route-time-marker route-time-${index}`,html:`<small>${title}</small><strong>${time}</strong><span>${changed?'高德路线':'行程预估'}</span>`,iconSize:[116,57],iconAnchor:[58,index===0||index===3?-12:70]}),
      keyboard:false,interactive:false,zIndexOffset:800
    }).addTo(timeLabelLayer);
  });
}
function renderFullRoute(){
  fullRouteLayer.clearLayers();
  days.forEach((_,index)=>{
    const coords=routeGeometry(index);
    if(!coords)return;
    L.polyline(coords,{color:'#fff',weight:8,opacity:1}).addTo(fullRouteLayer);
    L.polyline(coords,{color:'#2474db',weight:5,opacity:.85}).addTo(fullRouteLayer);
  });
}
renderFullRoute();
const selectedLayer=L.layerGroup().addTo(map),markers={};
allKeys.forEach((k,i)=>{const p=points[k];markers[k]=L.circleMarker(p.xy,{radius:6,color:'#fff',weight:2,fillColor:'#c36a4f',fillOpacity:1}).addTo(map).bindTooltip(p.name,{permanent:false,direction:'top'}).on('click',()=>choose({airportH:0,hailar:0,morigele:1,erguna:1,mordaoga:2,shiwei:3,heishantou:3,caidaihe:4,manzhouli:4,hulunlake:5}[k],false));});
function fit(){
  renderFullRoute();
  if(!map.hasLayer(fullRouteLayer))fullRouteLayer.addTo(map);
  const visible=days.flatMap((_,index)=>routeGeometry(index)||[]);
  const fallback=days.flatMap((_,index)=>{
    const route=accommodation?.getDayRoute(index);
    return route ? [route.from,...route.via,route.to].filter(Boolean).map(point=>[point.lat,point.lng]) : [];
  });
  const coords=visible.length>1?visible:fallback;
  if(coords.length)map.fitBounds(L.latLngBounds(coords),{paddingTopLeft:[50,70],paddingBottomRight:[50,65],animate:false});
  showTimeLabels([]);showOverviewTimes();
}
function showOverviewTimes(){
  document.getElementById('overview-times')?.remove();
  const element=document.createElement('div');element.id='overview-times';
  element.innerHTML=routeEstimates.map(e=>{
    const route=accommodation?.getDayRoute(e.day);
    const state=accommodation?.getRouteState(e.day) || {};
    const changed=Boolean(route?.hasChangedEndpoint);
    const stale=routeIsStale(e.day);
    const title=changed ? stale ? '路线未更新' : `${escapeHtml(route.from.name)} → ${escapeHtml(route.to.name)}` : e.title;
    const time=changed ? stale ? '待查询' : (state.durationText || '已更新') : e.time;
    return `<button data-route-day="${e.day}"><span>${title}</span><strong>${time}</strong></button>`;
  }).join('')+'<small>行程预估 · 点击查看路段</small>';
  element.querySelectorAll('button').forEach(b=>b.onclick=()=>choose(Number(b.dataset.routeDay)));
  document.querySelector('.map-wrap').append(element);
}
document.getElementById('days').innerHTML=days.map((d,i)=>`<button class="day-button" aria-pressed="${i===0}" data-day="${i}"><span class="day-num">${String(i+1).padStart(2,'0')}</span><span class="day-copy"><small>${d.date} ${d.weekday}</small><strong>${d.short}</strong><em>${d.pace}</em></span>${icon('chevron-right')}</button>`).join('');
function choose(i,focus=true,options={}){
  document.getElementById('overview-times')?.remove();
  selectedDay=i;
  const d=days[i];
  document.querySelectorAll('.day-button').forEach((b,j)=>b.setAttribute('aria-pressed',String(i===j)));
  document.getElementById('day-detail').innerHTML=navigationPanel(i)+detail(d,i);
  selectedLayer.clearLayers();
  const route=accommodation?.getDayRoute(i);
  const coords=route?[route.from,...route.via,route.to].filter(Boolean).map(point=>[point.lat,point.lng]):d.points.map(k=>points[k].xy);
  const road=routeGeometry(i);
  if(focus)map.removeLayer(fullRouteLayer);
  if(road){
    L.polyline(road,{color:'#fff',weight:9}).addTo(selectedLayer);
    L.polyline(road,{color:'#1768d1',weight:6}).addTo(selectedLayer);
  }
  coords.forEach((point,index)=>L.circleMarker(point,{radius:8,color:'#fff',weight:3,fillColor:index===0?'#236a51':index===coords.length-1?'#b75342':'#1768d1',fillOpacity:1}).addTo(selectedLayer));
  if(focus){
    if(coords.length===1)map.setView(coords[0],12,{animate:false});
    else map.fitBounds(L.latLngBounds(road||coords),{padding:[60,65],maxZoom:11,animate:false});
  }
  document.querySelector('.map-legend').innerHTML=road?route?.hasChangedEndpoint?'<span class="line-sample"></span>高德路线已更新':'<span class="line-sample"></span>行程连线示意 · 非道路导航':route?.hasChangedEndpoint?'<span class="line-sample"></span>住宿已更换 · 路线未更新':'市区目的地 · 高德实时规划路线';
  showTimeLabels(road?[legByDay[i]]:[]);
  lucide.createIcons();
  if(!options.skipAmap)window.tibetAMap?.select(i);
}
document.querySelectorAll('.day-button').forEach(b=>b.addEventListener('click',()=>choose(Number(b.dataset.day))));
document.getElementById('fit-map').onclick=()=>{if(window.tibetAMap?.overview())return;fit();document.querySelector('.map-legend').innerHTML='<span class="line-sample"></span>全程参考连线 · 非道路导航';};
let tileErrors=0;tiles.on('tileerror',()=>{if(++tileErrors>=3)document.getElementById('map-error').hidden=false;});tiles.on('tileload',()=>{tileErrors=0;document.getElementById('map-error').hidden=true;});
function updateAccommodationSummary(){
  if(!accommodation)return;
  const count=document.getElementById('accommodation-count');
  if(count)count.textContent=String(accommodation.getBaseCount());
  const distance=document.getElementById('distance-summary');
  if(distance){
    let changed=false, complete=true, total=0;
    days.forEach((_,index)=>{
      const route=accommodation.getDayRoute(index);
      const state=accommodation.getRouteState(index);
      if(route?.hasChangedEndpoint){
        changed=true;
        if(state.status==='updated' && Number.isFinite(state.distance)) total+=state.distance;
        else complete=false;
      }else if(window.roadRoutes?.legs[index]) total+=Number(window.roadRoutes.legs[index].distance)||0;
    });
    distance.textContent=changed ? complete ? `约 ${Math.round(total/1000)} km` : '路线未更新' : '约 1,000–1,100 km';
  }
  const summary=document.getElementById('stay-note-text');
  if(!summary)return;
  const groups=[];
  accommodation.overnightDays.forEach(index=>{
    const stay=accommodation.getDayStay(index);
    if(!stay)return;
    const last=groups.at(-1);
    if(last?.id===stay.id)last.count+=1;
    else groups.push({id:stay.id,name:stay.name,count:1});
  });
  summary.innerHTML=groups.map(group=>`${escapeHtml(group.name)} ${group.count} 晚`).join(' → ')+'<small>10/2 · 10/7 · 10/3 · 10/4 · 10/5 · 10/6</small>';
}
function renderPrintItinerary(){
  const target=document.getElementById('print-itinerary');
  if(!target)return;
  if(window.tibetAccommodationPrint?.render){
    window.tibetAccommodationPrint.render({target,days,accommodation,roadRoutes:window.roadRoutes});
    return;
  }
  target.innerHTML=days.map((d,i)=>`<article>${detail(d,i)}</article>`).join('');
}
function refreshAccommodationView(change={}){
  updateAccommodationSummary();
  renderPrintItinerary();
  renderFullRoute();
  choose(selectedDay,false,{skipAmap:true});
  if(change.routeDays?.length)window.tibetAMap?.accommodationChanged(change.routeDays);
}
accommodation?.onChange(refreshAccommodationView);
document.addEventListener('accommodationroutechange',()=>{
  renderPrintItinerary();
  renderFullRoute();
  choose(selectedDay,false,{skipAmap:true});
});
const checklist=['确认海拉尔机场同点取还车','订好 6 晚住宿、莫尔道嘎与黑山头问供暖','确认额尔古纳湿地、莫尔道嘎开放时间','准备证件与防风保暖衣物','下载离线地图、检查天气路况','确认 10/8 还车与航站楼时间'];
let saved=[];try{saved=JSON.parse(localStorage.getItem('hailar-slow-trip-checklist-oct7-v2')||'[]');if(!Array.isArray(saved))saved=[];}catch{}
document.getElementById('checklist').innerHTML=checklist.map((t,i)=>`<label><input type="checkbox" value="${i}" ${saved.includes(i)?'checked':''}>${t}</label>`).join('');
function updateChecks(){const values=[...document.querySelectorAll('.checklist input:checked')].map(e=>Number(e.value));document.getElementById('check-count').textContent=`${values.length} / 6`;try{localStorage.setItem('hailar-slow-trip-checklist-oct7-v2',JSON.stringify(values));}catch{document.getElementById('save-status').textContent='当前浏览器未允许保存，勾选仅在本页有效。';}}
document.getElementById('checklist').addEventListener('change',updateChecks);updateChecks();
renderPrintItinerary();
document.getElementById('print').onclick=()=>window.print();
let detailOpenState=[];window.addEventListener('beforeprint',()=>{detailOpenState=[...document.querySelectorAll('details')].map(d=>d.open);document.querySelectorAll('details').forEach(d=>d.open=true);});window.addEventListener('afterprint',()=>document.querySelectorAll('details').forEach((d,i)=>d.open=detailOpenState[i]));
const observer=new ResizeObserver(()=>{map.invalidateSize();});observer.observe(document.getElementById('route-map'));
choose(0,false);fit();updateAccommodationSummary();lucide.createIcons();
window.tibetTrip = {days, points, routeEstimates, routeMidpoints:roadLines.map(routeMidpoint),overviewStops:window.tripPlan.overviewStops,showOverviewTimes,getMap:()=>map,getDayRoute:dayIndex=>accommodation?.getDayRoute(dayIndex),refreshAccommodation:refreshAccommodationView};
accommodation?.attachMap(map);
