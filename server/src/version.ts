import { createRequire } from 'node:module'

/**
 * Resolve this package's version from server/package.json.
 *
 * createRequire keeps working in both run modes: tsx directly on src/, and the
 * tsc output in dist/ (both sit one level below the package root).
 */
export function readServerVersion(): string {
  try {
    const require = createRequire(import.meta.url)
    const pkg = require('../package.json') as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}
