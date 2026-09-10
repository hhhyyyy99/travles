const test = require('node:test');
const assert = require('node:assert/strict');
const {duration,traffic} = require('../amap-utils.js');
test('missing traffic coverage is unknown, not clear',()=>{
  const result=traffic({distance:10000,steps:[{path:[]} ]});
  assert.equal(result.totals['未知'],10000);
  assert.equal(result.known,false);
});
test('partial traffic coverage preserves the unreported distance',()=>{
  const result=traffic({distance:10000,steps:[{tmcs:[{status:'畅通',distance:5000},{status:'拥堵',distance:2000},{status:'未支持',distance:1000}]}]});
  assert.equal(result.totals['畅通'],5000);
  assert.equal(result.totals['拥堵'],2000);
  assert.equal(result.totals['未知'],3000);
  assert.equal(result.known,true);
});
test('duration converts seconds and never invents a missing estimate',()=>{
  assert.equal(duration(5400),'1 小时 30 分钟');
  assert.equal(duration(undefined),'暂无时间');
  assert.equal(duration(null),'暂无时间');
});
