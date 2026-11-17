import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootPath = fileURLToPath(new URL('../', import.meta.url))
const packageJson = JSON.parse(readFileSync(join(rootPath, 'package.json'), 'utf8'))
const lockfile = JSON.parse(readFileSync(join(rootPath, 'package-lock.json'), 'utf8'))
const banned = /(?:^|[\/])(?:@playwright[\/][^\/]+|playwright(?:-core)?)(?:$|[\/])/i
const failures = []

for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
  for (const name of Object.keys(packageJson[section] ?? {})) {
    if (banned.test(name)) failures.push(`package.json ${section}: ${name}`)
  }
}

for (const name of Object.keys(lockfile.packages ?? {})) {
  if (banned.test(name)) failures.push(`package-lock.json package: ${name}`)
}

for (const path of [
  'playwright.config.js',
  'playwright.config.ts',
  'tests/e2e',
  'node_modules/.bin/playwright',
  'node_modules/@playwright',
  'node_modules/playwright',
  'node_modules/playwright-core',
]) {
  if (existsSync(join(rootPath, path))) failures.push(`present: ${path}`)
}

if (failures.length) {
  console.error(`Standalone Playwright tooling found:\n${failures.join('\n')}`)
  process.exitCode = 1
} else {
  console.log('Standalone Playwright tooling absent from Frontline.')
}
