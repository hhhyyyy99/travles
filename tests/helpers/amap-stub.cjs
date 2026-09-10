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
      const request = {coordinate, waypoints, origin: args[0], destination: args[1], mode: window.routeProvider.mode};
      requests.push(request);
      const origin = coordinate ? args[0] : new LngLat(119.82,49.22);
      const destination = coordinate ? args[1] : new LngLat(119.78,49.21);
      const route = {distance: window.routeProvider.distance, time: 5678, steps: [{path:[origin, destination],road:'测试道路',instruction:'继续行驶'}]};
      setTimeout(() => { request.completed = true; callback(request.mode === 'failure' ? 'error' : 'complete', {routes: request.mode === 'failure' ? [] : [route]}); }, window.routeProvider.delay);
    }
  }
  class Map {
    add() {} remove() {} addControl() {} setFitView() {} setZoomAndCenter() {} destroy() {}
  }
  class Traffic {reload(){} show(){} hide(){}}
  class Shape {constructor(options) {this.options=options;}}
  class AutoComplete {on(){}}
  window.AMap={LngLat,Driving,Map,TileLayer:{Traffic},ToolBar:Shape,Scale:Shape,Marker:Shape,Polyline:Shape,Pixel:class{},AutoComplete,DrivingPolicy:{REAL_TRAFFIC:0}};
  window.TIBET_AMAP_CONFIG={key:'local-test-only',securityJsCode:'local-test-only'};
}
module.exports = {installAMapStub};
