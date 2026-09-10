// Publish the tested standalone Hailar guide alongside the Next.js Tibet route.
// An explicit allowlist prevents local notes, tests or credentials from leaking.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const files = [
  'index.html', 'trip.html', 'trip.css', 'trip-plan.js', 'trip.js',
  'amap-utils.js', 'amap-integration.js',
  'accommodation.js', 'accommodation-search.js', 'accommodation-search.css',
  'accommodation-manager.js', 'accommodation-manager.css',
  'accommodation-backup.js', 'accommodation-print.js',
  'data/hailar-road-routes.js',
];
function prepareGuide({source = root, destination = path.join(root, 'public/hailar'), env = process.env} = {}) {
  fs.mkdirSync(destination, {recursive: true});
  for (const name of files) {
    const target = path.join(destination, name);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.copyFileSync(path.join(source, name), target);
  }
  fs.cpSync(path.join(source, 'vendor'), path.join(destination, 'vendor'), {recursive: true});
  const target = path.join(destination, 'amap-config.js');
  if (env.NEXT_PUBLIC_AMAP_KEY && env.NEXT_PUBLIC_AMAP_SECURITY_JS_CODE) {
    fs.writeFileSync(target, `window.TIBET_AMAP_CONFIG = ${JSON.stringify({key:env.NEXT_PUBLIC_AMAP_KEY, securityJsCode:env.NEXT_PUBLIC_AMAP_SECURITY_JS_CODE})};\n`);
  } else if (fs.existsSync(path.join(source, 'amap-config.js'))) {
    fs.copyFileSync(path.join(source, 'amap-config.js'), target);
  } else {
    fs.writeFileSync(target, 'window.TIBET_AMAP_CONFIG = {};\n');
  }
}
if (require.main === module) prepareGuide();
module.exports = {prepareGuide};
