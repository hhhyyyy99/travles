// Provider boundary fixture: validates the documented AMap overloads and emits
// deterministic route responses; no application state or UI is stubbed.
function installAMapStub() {
  class LngLat {
    constructor(lng, lat) { this.lng = lng; this.lat = lat; }
    getLng() { return this.lng; }
    getLat() { return this.lat; }
  }
  const requests = [];
  window.routeProvider = {requests, mode: 'success', delay: 40, distance: 43210, errors: []};
  class Driving {
    search(...args) {
      const callback = args.at(-1);
      const coordinate = !Array.isArray(args[0]);
      if (coordinate && (!(args[0] instanceof LngLat) || !(args[1] instanceof LngLat))) {
        window.routeProvider.errors.push('Coordinate overload needs two LngLat endpoints');
        throw new Error('Invalid coordinate endpoints');
      }
      const waypoints = coordinate ? args[2].waypoints || [] : args[0].slice(1, -1);
      if (waypoints.some(p => !(p instanceof LngLat) && (!p || typeof p.keyword !== 'string'))) {
        window.routeProvider.errors.push('Invalid waypoint'); throw new Error('Invalid waypoint');
      }
      const request = {coordinate, waypoints, origin: args[0], destination: args[1], mode: window.routeProvider.mode, distance: window.routeProvider.distance, delay: window.routeProvider.delay};
      requests.push(request);
      const origin = coordinate ? args[0] : new LngLat(119.82,49.22);
      const destination = coordinate ? args[1] : new LngLat(119.78,49.21);
      const route = {distance: request.distance, time: 5678, steps: [{path:[origin, destination],road:'测试道路',instruction:'继续行驶'}]};
      setTimeout(() => { request.completed = true; callback(request.mode === 'failure' ? 'error' : 'complete', {routes: request.mode === 'failure' ? [] : [route]}); }, request.delay);
    }
  }
  class Map {
    add() {} remove() {} addControl() {} setFitView() {} setZoomAndCenter() {} destroy() {}
  }
  class Traffic {reload(){} show(){} hide(){}}
  class Shape {constructor(options) {this.options=options;}}
  class AutoComplete {on(){}}
  // Place search (ticket 05): deterministic responses driven by placeProvider,
  // mirroring routeProvider's mode/delay knobs. `pois` may be an array or a
  // function of the query, so suites can script per-query responses (and
  // slow-vs-fast races for the stale-result guard).
  window.placeProvider = {requests: [], mode: 'success', delay: 40, pois: null};
  class PlaceSearch {
    constructor(options) { this.options = options || {}; }
    search(query, callback) {
      const provider = window.placeProvider;
      const request = {query, city: this.options.city, citylimit: this.options.citylimit, pageSize: this.options.pageSize, mode: provider.mode, delay: provider.delay};
      provider.requests.push(request);
      setTimeout(() => {
        request.completed = true;
        if (provider.mode === 'no_data') return callback('no_data', {});
        if (provider.mode === 'error') return callback('error', {});
        const pois = typeof provider.pois === 'function'
          ? provider.pois(query)
          : (provider.pois || [{id: 'poi-default', name: query, address: '测试地址', location: {lng: 119.8, lat: 49.2}}]);
        callback('complete', {poiList: {pois}});
      }, provider.delay || 40);
    }
  }
  window.AMap={LngLat,Driving,Map,TileLayer:{Traffic},ToolBar:Shape,Scale:Shape,Marker:Shape,Polyline:Shape,Pixel:class{},AutoComplete,PlaceSearch,DrivingPolicy:{REAL_TRAFFIC:0}};
  window.TIBET_AMAP_CONFIG={key:'local-test-only',securityJsCode:'local-test-only'};
}
module.exports = {installAMapStub};
