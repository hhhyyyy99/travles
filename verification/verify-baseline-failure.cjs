const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')

const log = readFileSync(process.argv[2], 'utf8')
assert.match(log, /tests 1\b/)
assert.match(log, /fail 1\b/)
assert.match(log, /AssertionError \[ERR_ASSERTION\]/)
assert.match(log, /empty chat suggestions send their visible text to the manually created trip/)
assert.match(log, /^[ \t]*\+\s+content: '第一次去呼伦贝尔，7 天怎么安排不赶？',$/m)
assert.match(log, /^[ \t]*\+\s+label: '第一次去呼伦贝尔，7 天怎么安排不赶？',$/m)
assert.match(log, /^[ \t]*-\s+content: '这趟行程怎么安排才不赶？',$/m)
assert.match(log, /^[ \t]*-\s+label: '这趟行程怎么安排才不赶？',$/m)
assert.match(log, /^[ \t]+path: '\/api\/trips\/trip-manual-chengdu\/messages'$/m)
console.log(
  'Expected baseline failure confirmed: the visible label and posted content both contain the hardcoded destination and duration, while the trip path is correct.',
)
