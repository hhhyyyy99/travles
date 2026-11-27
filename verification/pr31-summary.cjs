const { spawnSync } = require('node:child_process')
const { appendFileSync } = require('node:fs')

const preview = { APP_MODE: 'preview' }
const commands = [
  { args: ['typecheck'] },
  { args: ['test'], suites: 2 },
  { args: ['build'] },
  { args: ['build:server'] },
  { args: ['quality:changed', process.env.BASE_SHA] },
  { args: ['test:app:prod'], suites: 1 },
  {
    bin: 'node',
    args: ['--test', 'tests/app/20-workbench-canvas-zoom.app.browser.cjs'],
    env: preview,
    suites: 1,
  },
  {
    bin: 'node',
    args: ['--test', 'tests/app/26-trip-pinning.app.browser.cjs'],
    env: preview,
    suites: 1,
  },
]

const keys = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']
function parseCounts(text, suites) {
  const totals = Object.fromEntries(keys.map((key) => [key, 0]))
  const sections = Object.fromEntries(keys.map((key) => [key, 0]))
  for (const [, key, raw] of text.matchAll(
    /^(?:ℹ|#) (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$/gm,
  )) {
    totals[key] += Number(raw)
    sections[key]++
  }
  if (keys.some((key) => sections[key] !== suites)) return null
  if (totals.tests !== keys.slice(1).reduce((sum, key) => sum + totals[key], 0)) return null
  return totals
}

const rows = [
  '### Sanitized execution results',
  '',
  'Each row counts test cases, or one command for non-test steps. No logs or visual artifacts are attached.',
  '',
  '| Command | Result | Passed | Failed | Skipped | Cancelled | Todo |',
  '| --- | --- | ---: | ---: | ---: | ---: | ---: |',
]
let failed = false
for (const { bin = 'pnpm', args, env = {}, suites } of commands) {
  const command = [...Object.entries(env).map(([k, v]) => `${k}=${v}`), bin, ...args].join(' ')
  const result = spawnSync(bin, args, {
    env: { ...process.env, ...env, FORCE_COLOR: '0' },
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    timeout: 5 * 60 * 1000,
  })
  const commandOK = result.status === 0
  const totals = suites
    ? parseCounts(result.stdout ?? '', suites)
    : { pass: Number(commandOK), fail: Number(!commandOK), skipped: 0, cancelled: 0, todo: 0 }
  const success = commandOK && totals !== null && totals.fail === 0 && totals.cancelled === 0
  failed ||= !success
  const counts = keys.slice(1).map((key) => totals?.[key] ?? '—')
  const status = success ? 'PASS' : `FAIL (exit ${result.status ?? 'unavailable'})`
  rows.push(`| \`${command}\` | ${status} | ${counts.join(' | ')} |`)
}
const output = rows.join('\n') + '\n'
appendFileSync(process.env.GITHUB_STEP_SUMMARY, output)
process.stdout.write(output)
if (failed) process.exitCode = 1
