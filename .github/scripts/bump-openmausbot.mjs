// Moves the tested OpenMausBot pin to a newer npm release: the version constant, the
// install manifest, a lockfile regenerated with --ignore-scripts (so nothing from the
// package runs here), and the README's install step. It never lowers the pin.
// Usage: node .github/scripts/bump-openmausbot.mjs [version]   (default: npm's latest)
// Prints `bumped=<version>`, or `bumped=` when there is nothing newer.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const VERSION_FILE = join(root, 'shared/omb-version.ts')
const ASSETS = join(root, 'worker/install-assets')
const README = join(root, 'README.md')
const SEMVER = /^\d+\.\d+\.\d+$/

function compare(a, b) {
  const [left, right] = [a, b].map((v) => v.split('.').map(Number))
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return Math.sign(left[i] - right[i])
  return 0
}

function replaceOnce(file, pattern, replacement) {
  const source = readFileSync(file, 'utf8')
  const matches = source.match(new RegExp(pattern.source, pattern.flags + 'g'))
  if (matches?.length !== 1) throw new Error(`${file}: expected one match for ${pattern}`)
  writeFileSync(file, source.replace(pattern, replacement))
}

const current = readFileSync(VERSION_FILE, 'utf8').match(
  /TESTED_OPENMAUSBOT_VERSION = '([^']+)'/
)?.[1]
if (!current || !SEMVER.test(current)) throw new Error('Could not read the current pin.')

const target =
  process.argv[2] ??
  execFileSync('npm', ['view', 'openmausbot', 'version'], { encoding: 'utf8' }).trim()
if (!SEMVER.test(target)) throw new Error(`Refusing unexpected version "${target}".`)

if (compare(target, current) <= 0) {
  console.error(`OpenMausBot ${current} is pinned; npm offers ${target}. Nothing to do.`)
  console.log('bumped=')
  process.exit(0)
}

replaceOnce(
  VERSION_FILE,
  /TESTED_OPENMAUSBOT_VERSION = '[^']+'/,
  `TESTED_OPENMAUSBOT_VERSION = '${target}'`
)
replaceOnce(join(ASSETS, 'package.json'), /"openmausbot": "[^"]+"/, `"openmausbot": "${target}"`)
replaceOnce(README, /`openmausbot@\d+\.\d+\.\d+`/, `\`openmausbot@${target}\``)

execFileSync(
  'npm',
  ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
  { cwd: ASSETS, stdio: ['ignore', 'ignore', 'inherit'] }
)

const lock = JSON.parse(readFileSync(join(ASSETS, 'package-lock.json'), 'utf8'))
if (lock.packages?.['node_modules/openmausbot']?.version !== target)
  throw new Error('The regenerated lockfile does not resolve the new version.')

console.error(`Bumped OpenMausBot ${current} -> ${target}.`)
console.log(`bumped=${target}`)
