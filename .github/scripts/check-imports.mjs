// No dependencies. Include type-only and multiline imports (and re-exports),
// which runtime tests can miss. HEAD, rather than the index or disk alone,
// ensures an accidentally uncommitted dependency cannot make this check pass.
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join, posix, relative } from 'node:path'

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const committed = new Set(
  execFileSync('git', ['ls-tree', '-r', '--name-only', '-z', 'HEAD'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
)
const failures = []
let checked = 0

function walk(folder) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const file = join(folder, entry.name)
    if (entry.isDirectory()) {
      walk(file)
    } else if (entry.isFile() && /\.(?:[cm]?[jt]sx?|html)$/.test(entry.name)) {
      const source = relative(root, file).split('\\').join('/')
      // Static import/from syntax, including multiline named imports.
      const imports = /\b(?:import|export)\s+(?:[^'";]*?\s+from\s*)?(['"])(\.\.?\/[^'"\r\n]+\.ts)\1/g
      for (const match of readFileSync(file, 'utf8').matchAll(imports)) {
        const target = posix.normalize(posix.join(posix.dirname(source), match[2]))
        checked++
        if (!committed.has(target)) {
          failures.push(`${source}: ${match[2]} -> ${target} is not committed in HEAD`)
        } else {
          try {
            if (!lstatSync(join(root, target)).isFile()) throw new Error('not a regular file')
          } catch {
            failures.push(`${source}: ${match[2]} -> ${target} is not a regular file on disk`)
          }
        }
      }
    }
  }
}

for (const folder of ['worker', 'panel', 'shared']) walk(join(root, folder))
if (failures.length) {
  console.error(failures.join('\n'))
  process.exitCode = 1
} else {
  console.log(`Checked ${checked} relative TypeScript imports: all targets are committed files.`)
}
