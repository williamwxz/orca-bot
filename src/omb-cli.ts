import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { childEnvironment } from './child-environment.ts'
import { join } from 'node:path'
import { TESTED_OPENMAUSBOT_VERSION } from '../shared/omb-version.ts'

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
  execFile: (file: string, args: string[], options: { env: NodeJS.ProcessEnv; timeout: number }) => Promise<string>
  exists: (path: string) => boolean
  sleep: (ms: number) => Promise<void>
  userInfo: () => { username: string; shell: string | null }
  home: string
  platform: string
  env: NodeJS.ProcessEnv
}

export function defaultCliDeps(): CliDeps {
  if (process.env.NODE_TEST_CONTEXT) throw new Error('Tests must inject CLI dependencies')
  return {
    execFile: (file, args, options) => new Promise((resolve, reject) => {
      execFile(file, args, options, (error, stdout) => {
        // Command errors can contain the pairing URL in argv, stdout or stderr.
        if (error) reject(new CliFailure(error.code, stdout))
        else resolve(stdout)
      })
    }),
    exists: (path) => {
      try {
        fs.accessSync(path, fs.constants.X_OK)
        return fs.statSync(path).isFile()
      } catch {
        return false
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    userInfo,
    home: homedir(),
    platform: process.platform,
    env: { ...process.env }
  }
}

export function ombBinary(deps: CliDeps): string {
  return join(deps.home, '.bot-deck/openmausbot', TESTED_OPENMAUSBOT_VERSION, 'node_modules/.bin/openmausbot')
}

export function cliOptions(deps: CliDeps, timeout = 10000) {
  return { timeout, env: childEnvironment(deps) }
}
