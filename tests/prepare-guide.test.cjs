const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {prepareGuide} = require('../scripts/prepare-guide.cjs');

test('published guide includes every local HTML asset and uses deployment configuration', () => {
  const destination=fs.mkdtempSync(path.join(os.tmpdir(),'published-guide-'));
  try {
    prepareGuide({destination,env:{NEXT_PUBLIC_AMAP_KEY:'test-key',NEXT_PUBLIC_AMAP_SECURITY_JS_CODE:'test-code'}});
    const html=fs.readFileSync(path.join(destination,'index.html'),'utf8');
    const assets=[...html.matchAll(/(?:src|href)="([^"#]+\.(?:js|css))"/g)].map(m=>m[1]);
    for(const name of assets) assert.ok(fs.existsSync(path.join(destination,name)), name);
    const context={window:{}};
    vm.runInNewContext(fs.readFileSync(path.join(destination,'amap-config.js'),'utf8'),context);
    assert.equal(context.window.TIBET_AMAP_CONFIG.key,'test-key');
    assert.equal(context.window.TIBET_AMAP_CONFIG.securityJsCode,'test-code');
    assert.equal(fs.existsSync(path.join(destination,'.scratch')),false);
  } finally {fs.rmSync(destination,{recursive:true,force:true});}
});
