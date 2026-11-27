const { spawnSync } = require('node:child_process')

// Only pass runtime settings required by the local app, pnpm and Chromium.
// Do not pass through tokens, model configuration or map configuration.
const env = Object.fromEntries(
  ['HOME', 'PATH', 'CI', 'LANG', 'TMPDIR', 'PLAYWRIGHT_BROWSERS_PATH']
    .filter((name) => process.env[name] !== undefined)
    .map((name) => [name, process.env[name]]),
)
env.APP_MODE = 'preview'
env.FORCE_COLOR = '0'

// The public runner log never receives raw test stdout/stderr, even on failure.
const result = spawnSync('pnpm', ['run', 'test:app'], {
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
  env,
})
const output = result.stdout ?? ''
const count = (key) => {
  const match = output.match(new RegExp(`^ℹ ${key} (\\d+)$`, 'm'))
  return match ? Number(match[1]) : undefined
}
const total = count('tests')
const passed = count('pass')
const failed = count('fail')
const cancelled = count('cancelled')
const skipped = count('skipped')
const todo = count('todo')
if ([total, passed, failed, cancelled, skipped, todo].some((value) => value === undefined)) {
  console.log('Failure summary: the Chromium command did not emit complete test counts.')
  process.exit(1)
}
console.log(`Chromium production suite: total=${total} passed=${passed} failed=${failed} cancelled=${cancelled} skipped=${skipped} todo=${todo}`)
if (failed === 1 && cancelled === 0 && skipped === 0 && todo === 0 && passed === total - 1) {
  const details = output.split('✖ failing tests:')[1] ?? ''
  if (
    /^test at tests\/app\/07-backup\.app\.browser\.cjs:\d+:\d+$/m.test(details) &&
    /invalid JSON and unsupported versions are rejected with exact messages and data intact/.test(details) &&
    /^\s*actual: '',$/m.test(details) &&
    /^\s*expected: '(无法导入：备份文件不是有效的 JSON。|无法导入：备份版本不受支持，仅支持 v1。)',$/m.test(details)
  ) {
    console.log('Failure summary: the legacy accommodation backup test read an empty status instead of an expected validation error.')
  } else {
    console.log('Failure summary: a Chromium test failed; details withheld from this public log.')
  }
} else if (result.status !== 0 || passed !== total) {
  console.log('Failure summary: the suite did not pass in full; details withheld from this public log.')
}
process.exitCode = result.status === 0 && passed === total && total > 0 ? 0 : 1
