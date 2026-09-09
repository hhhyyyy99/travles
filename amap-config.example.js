// Shared by index.html and trip.html. Apply for a Web (JS API) key, not a Web Service key.
// Local preview: fill key and securityJsCode, then reload the page.
// Public deployment: use a security proxy; browser configuration is not secret storage.
window.TIBET_AMAP_CONFIG = {
  key: 'YOUR_AMAP_KEY_HERE',
  securityJsCode: 'YOUR_SECURITY_JS_CODE_HERE',
  mapType: 'satellite', // 'satellite' or 'standard' (index.html)
  showRoadNet: true, // Road and place labels on satellite imagery (index.html)
  serviceHost: '' // Optional security proxy URL ending in /_AMapService (index.html)
};
