// Runs the gbot CLI (github.com/ScriptedAlchemy/grok-bot-cli). gbot talks to Grok Bot with the
// desktop app's own signed-in session, so this plugin never sees or stores a credential.
import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

const NAMES = process.platform === 'win32' ? ['gbot.cmd', 'grok-bot.cmd'] : ['gbot', 'grok-bot']

// Orca may start the worker with a GUI app's short PATH, so also look where npm usually links.
function searchDirs(): string[] {
  const home = homedir()
  return [
    ...(process.env.PATH ?? '').split(delimiter),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(home, '.local', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.volta', 'bin')
  ].filter(Boolean)
}

export class GbotError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export function findGbot(configured: string): string {
  const candidates = configured.trim()
    ? [configured.trim()]
    : searchDirs().flatMap((dir) => NAMES.map((name) => join(dir, name)))
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // try the next one
    }
  }
  throw new GbotError(
    'unavailable',
    configured.trim()
      ? `gbot was not found at ${configured.trim()}. Fix the path in this plugin's settings.`
      : 'gbot was not found. Install it with: npm install --global grok-bot-cli'
  )
}

function failureMessage(stdout: string, stderr: string): string {
  try {
    const parsed = JSON.parse(stdout)
    const error = parsed?.error
    if (typeof error === 'string') return error
    if (typeof error?.message === 'string') return error.message
  } catch {
    // not JSON
  }
  return (stderr.trim() || stdout.trim() || 'gbot failed').split('\n').slice(-3).join('\n')
}

/** Runs `gbot <args> --json` and returns the parsed result. Arguments are never shell-parsed. */
export function runGbot(
  bin: string,
  args: string[],
  { timeoutMs = 30_000, signal }: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      {
        timeout: timeoutMs,
        signal,
        maxBuffer: 16 * 1024 * 1024,
        // gbot is a Node script: make sure `env node` resolves from the same folders.
        env: { ...process.env, PATH: searchDirs().join(delimiter) }
      },
      (error, stdout, stderr) => {
        if (error) {
          const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
          reject(
            new GbotError(
              missing ? 'unavailable' : 'action_failed',
              missing ? `Could not run ${bin}` : failureMessage(stdout, stderr)
            )
          )
          return
        }
        try {
          resolve(stdout.trim() ? JSON.parse(stdout) : null)
        } catch {
          reject(new GbotError('action_failed', 'gbot printed something that is not JSON'))
        }
      }
    )
  })
}
