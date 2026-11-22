import { execFileSync } from 'node:child_process'
import { lstat, readFile } from 'node:fs/promises'
import { ESLint } from 'eslint'
import * as prettier from 'prettier'

const [base] = process.argv.slice(2)
if (!base || process.argv.length !== 3) {
  console.error('Usage: pnpm quality:changed <base-commit>')
  process.exit(2)
}

const revision = execFileSync(
  'git',
  ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`],
  { encoding: 'utf8' },
).trim()
const changed = execFileSync(
  'git',
  ['diff', '--name-only', '-z', '--diff-filter=ACMRT', revision, '--'],
  { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
)
  .split('\0')
  .filter(Boolean)

const linter = new ESLint({ globInputPaths: false })
const lintFiles = []
let checkedFormat = 0
let failed = false

for (const file of changed) {
  // A deleted worktree path or symlink is not a source file to check.
  const info = await lstat(file).catch((error) => {
    if (error.code !== 'ENOENT') throw error
    return null
  })
  if (!info?.isFile()) continue

  if (/\.(?:[cm]?[jt]s|[jt]sx)$/.test(file) && !(await linter.isPathIgnored(file))) {
    lintFiles.push(file)
  }

  const { ignored, inferredParser } = await prettier.getFileInfo(file, {
    ignorePath: ['.gitignore', '.prettierignore'],
  })
  if (ignored || !inferredParser) continue

  checkedFormat++
  const options = await prettier.resolveConfig(file, { editorconfig: true })
  const source = await readFile(file, 'utf8')
  if (!(await prettier.check(source, { ...options, filepath: file }))) {
    console.error(`Prettier: ${JSON.stringify(file)}`)
    failed = true
  }
}

if (lintFiles.length > 0) {
  const results = await linter.lintFiles(lintFiles)
  const formatter = await linter.loadFormatter('stylish')
  process.stdout.write(await formatter.format(results))
  failed ||= results.some(({ errorCount, warningCount }) => errorCount + warningCount > 0)
}

console.log(`Checked ${lintFiles.length} file(s) with ESLint and ${checkedFormat} with Prettier.`)
if (failed) process.exitCode = 1
