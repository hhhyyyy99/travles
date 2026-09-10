const {days,points}=window.tripPlan;
const icon=name=>`<i data-lucide="${name}"></i>`;
const searchUrl=name=>`https://uri.amap.com/search?keyword=${encodeURIComponent(name)}&callnative=0`;
const legByDay = {0:0,1:1,2:2,3:3,4:4,5:5,6:6};
function navigationUrl(dayIndex, currentLocation = false) {
  const d = days[dayIndex];
  if (d.points.length < 2) return searchUrl(d.nav[1]);
  const endpoint = (key, name) => {
    const [lat, lng] = points[key].xy;
    const converted = coordtransform.wgs84togcj02(lng, lat);
    return `${converted[0].toFixed(6)},${converted[1].toFixed(6)},${name}`;
  };
  const params = new URLSearchParams({
    to: endpoint(d.points.at(-1), d.nav[1]),
    mode: 'car', policy: '1', src: 'hailar-slow-trip', callnative: '1'
  });
  if (!currentLocation) params.set('from', endpoint(d.points[0], d.nav[0]));
  if(d.points.length>2)params.set('via',endpoint(d.points[1],points[d.points[1]].name));
  return `https://uri.amap.com/navigation?${params}`;
}
function navigationPanel(dayIndex) {
  const d = days[dayIndex];
  const leg = window.roadRoutes.legs[legByDay[dayIndex]];
  const localDay = d.points.length < 2;
  const roads = leg ? leg.roads.filter(r=>/^[GS]\d/.test(r)).join(' → ') : '';
  return `<div class="navigation-panel"><div><span class="eyebrow">${localDay ? '当地休整日' : '驾车路线'}</span><strong>${d.nav[0]} → ${d.nav[1]}</strong><p>${leg ? `参考里程约 ${(leg.distance/1000).toFixed(0)} km${roads?' · '+roads:''}` : '市内目的地 · 以高德实时规划为准'}</p></div><div class="navigation-actions"><a class="navigation-primary" href="${navigationUrl(dayIndex)}" target="_blank" rel="noopener">${icon(localDay?'map-pin':'navigation')}${localDay?'查看当天住处':'高德路线规划'}</a>${localDay?'':`<a class="navigation-current" href="${navigationUrl(dayIndex,true)}" target="_blank" rel="noopener">${icon('locate-fixed')}从当前位置导航</a>`}</div><p class="navigation-note">${localDay?'当天不安排长途驾驶，景区内交通以观光车及酒店接驳为准。':'起终点为区域参考位置，请在高德中确认酒店、景区入口或航站楼。手机可调起高德；当前位置导航需要手机定位。'}</p></div>`;
}
function detail(d,index){return `<div class="detail-heading"><div><p class="eyebrow">DAY ${String(index+1).padStart(2,'0')} / ${d.date} ${d.weekday}</p><h2>${d.title}</h2></div><span class="tag">${d.pace}</span></div><p class="day-desc">${d.desc}</p><div class="day-stats"><span>${icon('car-front')}${d.drive}</span><span>${icon('bed-double')}${d.stay}</span><span>${icon('mountain')}${d.alt}</span></div><div class="timeline">${d.schedule.map(s=>`<div class="time-row"><time>${s[0]}</time><div><strong>${s[1]}</strong><p>${s[2]}</p></div></div>`).join('')}</div><p class="day-tip">${d.tip}</p><div class="day-links"><a href="${searchUrl(d.nav[1])}" target="_blank" rel="noopener">${icon('map-pin')}高德查看目的地${icon('arrow-up-right')}</a><a href="${searchUrl(d.nav[0])}" target="_blank" rel="noopener">查看出发地${icon('arrow-up-right')}</a></div>`;}
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
    const estimate=routeEstimates[index];
    L.marker(routeMidpoint(roadLines[index]),{
      icon:L.divIcon({className:`route-time-marker route-time-${index}`,html:`<small>${estimate.title}</small><strong>${estimate.time}</strong><span>行程预估</span>`,iconSize:[116,57],iconAnchor:[58,index===0||index===3?-12:70]}),
      keyboard:false,interactive:false,zIndexOffset:800
    }).addTo(timeLabelLayer);
  });
}
roadLines.forEach(coords=>{
  L.polyline(coords,{color:'#fff',weight:8,opacity:1}).addTo(fullRouteLayer);
  L.polyline(coords,{color:'#2474db',weight:5,opacity:.85}).addTo(fullRouteLayer);
});
const selectedLayer=L.layerGroup().addTo(map),markers={};
allKeys.forEach((k,i)=>{const p=points[k];markers[k]=L.circleMarker(p.xy,{radius:6,color:'#fff',weight:2,fillColor:'#c36a4f',fillOpacity:1}).addTo(map).bindTooltip(p.name,{permanent:false,direction:'top'}).on('click',()=>choose({airportH:0,hailar:0,morigele:1,erguna:1,mordaoga:2,shiwei:3,heishantou:3,caidaihe:4,manzhouli:4,hulunlake:5}[k],false));});
function fit(){if(!map.hasLayer(fullRouteLayer))fullRouteLayer.addTo(map);map.fitBounds(L.latLngBounds(roadLines.flat()),{paddingTopLeft:[50,70],paddingBottomRight:[50,65],animate:false});showTimeLabels([]);showOverviewTimes();}
function showOverviewTimes(){
  document.getElementById('overview-times')?.remove();
  const element=document.createElement('div');element.id='overview-times';
  element.innerHTML=routeEstimates.map(e=>`<button data-route-day="${e.day}"><span>${e.title}</span><strong>${e.time}</strong></button>`).join('')+'<small>行程预估 · 点击查看路段</small>';
  element.querySelectorAll('button').forEach(b=>b.onclick=()=>choose(Number(b.dataset.routeDay)));
  document.querySelector('.map-wrap').append(element);
}
document.getElementById('days').innerHTML=days.map((d,i)=>`<button class="day-button" aria-pressed="${i===0}" data-day="${i}"><span class="day-num">${String(i+1).padStart(2,'0')}</span><span class="day-copy"><small>${d.date} ${d.weekday}</small><strong>${d.short}</strong><em>${d.pace}</em></span>${icon('chevron-right')}</button>`).join('');
function choose(i,focus=true){
  document.getElementById('overview-times')?.remove();
  const d=days[i];
  document.querySelectorAll('.day-button').forEach((b,j)=>b.setAttribute('aria-pressed',String(i===j)));
  document.getElementById('day-detail').innerHTML=navigationPanel(i)+detail(d,i);
  selectedLayer.clearLayers();
  const coords=d.points.map(k=>points[k].xy), road=roadLines[legByDay[i]];
  if(focus)map.removeLayer(fullRouteLayer);
  if(road){
    L.polyline(road,{color:'#fff',weight:9}).addTo(selectedLayer);
    L.polyline(road,{color:'#1768d1',weight:6}).addTo(selectedLayer);
  }
  d.points.forEach(k=>L.circleMarker(points[k].xy,{radius:8,color:'#fff',weight:3,fillColor:'#1768d1',fillOpacity:1}).addTo(selectedLayer));
  if(focus){
    if(coords.length===1)map.setView(coords[0],12,{animate:false});
    else map.fitBounds(L.latLngBounds(road||coords),{padding:[60,65],maxZoom:11,animate:false});
  }
  document.querySelector('.map-legend').innerHTML=road?'<span class="line-sample"></span>行程连线示意 · 非道路导航':'市区目的地 · 高德实时规划路线';
  showTimeLabels(road?[legByDay[i]]:[]);
  lucide.createIcons();
  window.tibetAMap?.select(i);
}
document.querySelectorAll('.day-button').forEach(b=>b.addEventListener('click',()=>choose(Number(b.dataset.day))));
document.getElementById('fit-map').onclick=()=>{if(window.tibetAMap?.overview())return;fit();document.querySelector('.map-legend').innerHTML='<span class="line-sample"></span>全程参考连线 · 非道路导航';};
let tileErrors=0;tiles.on('tileerror',()=>{if(++tileErrors>=3)document.getElementById('map-error').hidden=false;});tiles.on('tileload',()=>{tileErrors=0;document.getElementById('map-error').hidden=true;});
const checklist=['确认海拉尔机场同点取还车','订好 6 晚住宿、莫尔道嘎与黑山头问供暖','确认额尔古纳湿地、莫尔道嘎开放时间','准备证件与防风保暖衣物','下载离线地图、检查天气路况','确认 10/8 还车与航站楼时间'];
let saved=[];try{saved=JSON.parse(localStorage.getItem('hailar-slow-trip-checklist-oct7-v2')||'[]');if(!Array.isArray(saved))saved=[];}catch{}
document.getElementById('checklist').innerHTML=checklist.map((t,i)=>`<label><input type="checkbox" value="${i}" ${saved.includes(i)?'checked':''}>${t}</label>`).join('');
function updateChecks(){const values=[...document.querySelectorAll('.checklist input:checked')].map(e=>Number(e.value));document.getElementById('check-count').textContent=`${values.length} / 6`;try{localStorage.setItem('hailar-slow-trip-checklist-oct7-v2',JSON.stringify(values));}catch{document.getElementById('save-status').textContent='当前浏览器未允许保存，勾选仅在本页有效。';}}
document.getElementById('checklist').addEventListener('change',updateChecks);updateChecks();
document.getElementById('print-itinerary').innerHTML=days.map((d,i)=>`<article>${detail(d,i)}</article>`).join('');
document.getElementById('print').onclick=()=>window.print();
let detailOpenState=[];window.addEventListener('beforeprint',()=>{detailOpenState=[...document.querySelectorAll('details')].map(d=>d.open);document.querySelectorAll('details').forEach(d=>d.open=true);});window.addEventListener('afterprint',()=>document.querySelectorAll('details').forEach((d,i)=>d.open=detailOpenState[i]));
const observer=new ResizeObserver(()=>{map.invalidateSize();});observer.observe(document.getElementById('route-map'));
choose(0,false);fit();lucide.createIcons();
window.tibetTrip = {days, points, routeEstimates, routeMidpoints:roadLines.map(routeMidpoint),overviewStops:window.tripPlan.overviewStops,showOverviewTimes};
