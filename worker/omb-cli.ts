import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { childEnvironment } from './child-environment.ts'
import { join } from 'node:path'
import { TESTED_OPENMAUSBOT_VERSION, compareVersions } from '../shared/omb-version.ts'

export class CliFailure extends Error {
  code: number | string | undefined
  stdout: string
  constructor(code: number | string | undefined, stdout: string) {
    super('Command failed.')
    this.code = code
    this.stdout = stdout
  }
}

export type CliDeps = {
  execFile: (
    file: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; timeout: number },
    input?: string
  ) => Promise<string>
  exists: (path: string) => boolean
  readdir?: (path: string) => string[]
  sleep: (ms: number) => Promise<void>
  userInfo: () => { username: string; shell: string | null }
  home: string
  platform: string
  env: NodeJS.ProcessEnv
}

export function defaultCliDeps(): CliDeps {
  if (process.env.NODE_TEST_CONTEXT) throw new Error('Tests must inject CLI dependencies')
  return {
    execFile: (file, args, options, input) =>
      new Promise((resolve, reject) => {
        const child = execFile(file, args, options, (error, stdout) => {
          // Command errors can contain the pairing URL in argv, stdout or stderr.
          if (error) reject(new CliFailure(error.code, stdout))
          else resolve(stdout)
        })
        if (input !== undefined) {
          child.stdin?.on('error', () => reject(new CliFailure(undefined, '')))
          child.stdin?.end(input)
        }
      }),
    exists: (path) => {
      try {
        fs.accessSync(path, fs.constants.X_OK)
        return fs.statSync(path).isFile()
      } catch {
        return false
      }
    },
    readdir: (path) => fs.readdirSync(path),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    userInfo,
    home: homedir(),
    platform: process.platform,
    env: { ...process.env }
  }
}

export function pinnedOmbBinary(deps: Pick<CliDeps, 'home'>): string {
  return join(deps.home, '.orca-bot/openmausbot', TESTED_OPENMAUSBOT_VERSION, 'node_modules/.bin/openmausbot')
}

export function ombBinary(deps: CliDeps): string {
  const pinned = pinnedOmbBinary(deps)
  if (!deps.readdir || deps.exists(pinned)) return pinned
  try {
    const versions = deps
      .readdir(join(deps.home, '.orca-bot/openmausbot'))
      .filter((entry) => /^\d+(\.\d+)*$/.test(entry))
      .sort((a, b) => compareVersions(b, a) ?? 0)
    for (const version of versions) {
      const candidate = join(deps.home, '.orca-bot/openmausbot', version, 'node_modules/.bin/openmausbot')
      if (deps.exists(candidate)) return candidate
    }
  } catch {
    /* Missing install root falls back to the pinned binary path. */
  }
  return pinned
}

export function cliOptions(deps: CliDeps, timeout = 10000) {
  return { timeout, env: childEnvironment(deps) }
}
