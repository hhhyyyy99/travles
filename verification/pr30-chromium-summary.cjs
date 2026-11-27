const { spawnSync } = require('node:child_process')
const { appendFileSync } = require('node:fs')

const env = Object.fromEntries(
  ['HOME', 'PATH', 'CI', 'LANG', 'TMPDIR', 'PLAYWRIGHT_BROWSERS_PATH']
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]),
)
env.FORCE_COLOR = '0'

function report(line) {
  console.log(line)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`)
}

function verify(label, command, args, expected, extraEnv = {}) {
  const child = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: { ...env, ...extraEnv },
  })
  const keys = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']
  const values = keys.map((key) => {
    const matches = [...(child.stdout ?? '').matchAll(new RegExp(`^ℹ ${key} (\\d+)$`, 'gm'))]
    return matches.length === 1 ? Number(matches[0][1]) : undefined
  })
  const commandText = [command, ...args].join(' ')
  if (values.some((value) => value === undefined)) {
    report(`- **${label}** — \`${commandText}\`: no complete counts; raw output withheld.`)
    return false
  }
  const [total, passed, failed, cancelled, skipped, todo] = values
  report(
    `- **${label}** — \`${commandText}\`: total=${total}, passed=${passed}, failed=${failed}, skipped=${skipped}, cancelled=${cancelled}, todo=${todo}.`,
  )
  return (
    child.status === 0 &&
    total === expected &&
    passed === total &&
    failed === 0 &&
    skipped === 0 &&
    cancelled === 0 &&
    todo === 0
  )
}

report('### Production Chromium test results')
report('')
const full = verify('Full production suite', 'pnpm', ['test:app:prod'], 138)
const pin = verify(
  'Home pinning',
  'node',
  ['--test', 'tests/app/26-trip-pinning.app.browser.cjs'],
  1,
  { APP_MODE: 'preview' },
)
const ai = verify(
  'Existing AI creation',
  'node',
  ['--test', 'tests/app/17-current-trip-flows.app.browser.cjs'],
  3,
  { APP_MODE: 'preview' },
)
const guides = verify(
  'Existing guide import',
  'node',
  ['--test', 'tests/app/21-guide-import.app.browser.cjs'],
  7,
  { APP_MODE: 'preview' },
)
report('')
if (pin)
  report(
    'Verified pin/unpin, no navigation on click or Enter, both states across a reload, stable order with another pinned trip, unchanged ordering on a failed write, and preserved card titles and schedules.',
  )
if (!full || !pin || !ai || !guides) process.exitCode = 1
