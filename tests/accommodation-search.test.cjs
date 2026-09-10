const test = require('node:test');
const assert = require('node:assert/strict');
const search = require('../accommodation-search.js');

test('normalizes an AMap point to the canonical WGS-84 shape once', () => {
  const result = search.normalizePoi({
    id: 'poi-1',
    name: '松林小院',
    address: '额尔古纳市河西',
    location: {lng: 119.8, lat: 49.2}
  }, (lng, lat) => [lng - 0.01, lat - 0.02]);

  assert.deepEqual(result, {
    id: 'poi-1',
    name: '松林小院',
    address: '额尔古纳市河西',
    type: 'hotel',
    lat: 49.18,
    lng: 119.78999999999999,
    source: 'amap',
    sourceLocation: {lat: 49.2, lng: 119.8},
    city: ''
  });
});

test('same-name bases within the duplicate radius are candidates for reuse', () => {
  const candidate = {name: '松林小院', lat: 49.2, lng: 119.8};
  const nearby = {id: 'custom-near', name: ' 松林小院 ', lat: 49.2005, lng: 119.8};
  const farAway = {id: 'custom-far', name: '松林小院', lat: 49.24, lng: 119.8};

  assert.deepEqual(search.findDuplicates(candidate, [nearby, farAway]).map(base => base.id), ['custom-near']);
  assert.equal(search.distanceMeters(candidate, farAway) > search.duplicateDistanceMeters, true);
});

test('PlaceSearch results are normalized and no-data is surfaced without inventing a position', async () => {
  class PlaceSearch {
    search(query, callback) {
      assert.equal(query, '额尔古纳湿地');
      callback('complete', {poiList: {pois: [{name: '额尔古纳湿地', location: {lng: 119.9, lat: 50.1}}]}});
    }
  }
  const [result] = await search.searchPlaces('额尔古纳湿地', {
    AMap: {PlaceSearch},
    transform: (lng, lat) => [lng - 0.01, lat - 0.01]
  });
  assert.equal(result.name, '额尔古纳湿地');
  assert.equal(result.lat, 50.09);
  assert.equal(result.lng, 119.89);

  class EmptyPlaceSearch {
    search(query, callback) { callback('no_data', {}); }
  }
  await assert.rejects(
    search.searchPlaces('不存在的住宿', {AMap: {PlaceSearch: EmptyPlaceSearch}}),
    error => error.code === 'no-results'
  );
});

test('search remains explicitly unavailable when the AMap plugin is not loaded', async () => {
  await assert.rejects(search.searchPlaces('海拉尔酒店', {AMap: {}}), error => error.code === 'unavailable');
});
