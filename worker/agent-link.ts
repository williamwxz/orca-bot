import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { childEnvironment } from './child-environment.ts'
import { defaultCliDeps, ombBinary } from './omb-cli.ts'
import { claudeEnvironment, defaultServerDeps } from './omb-server.ts'
import type { EnvironmentDeps } from './child-environment.ts'

type Agent = 'claude' | 'codex'
type Entry = { port: number; bin: string }
type Record = Partial<{ [K in Agent]: Entry }>
export type LinkDeps = EnvironmentDeps & {
  exists: (path: string) => boolean
  read: () => string | undefined
  write: (record: string) => void
  execFile: (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<void>
  codexEntryExists: (file: string, env: NodeJS.ProcessEnv) => Promise<boolean>
  claudeEnv: () => NodeJS.ProcessEnv
  bin: string
}

export function defaultLinkDeps(): LinkDeps {
  if (process.env.NODE_TEST_CONTEXT) throw new Error('Tests must inject agent link dependencies')
  const cli = defaultCliDeps()
  const server = defaultServerDeps()
  const file = join(cli.home, '.bot-deck/agent-link.json')
  return {
    ...cli, bin: ombBinary(cli),
    claudeEnv: () => claudeEnvironment(server, false).env,
    read: () => { try { return fs.readFileSync(file, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new Error('Could not read setup.') } },
    write: (value) => {
      fs.mkdirSync(join(cli.home, '.bot-deck'), { recursive: true, mode: 0o700 })
      fs.writeFileSync(file, value, { mode: 0o600 })
      fs.chmodSync(file, 0o600)
    },
    execFile: (file, args, env) => new Promise((resolve, reject) => {
      execFile(file, args, { env, timeout: 10000 }, (error) => error ? reject(new Error('Command failed.')) : resolve())
    }),
    // Codex add replaces existing entries; refuse to overwrite one we do not own.
    codexEntryExists: (file, env) => new Promise((resolve, reject) => {
      execFile(file, ['mcp', 'list', '--json'], { env, timeout: 10000 }, (error, stdout) => {
        if (error) { reject(new Error('Could not check setup.')); return }
        try {
          const entries: unknown = JSON.parse(stdout)
          if (!Array.isArray(entries)) throw new Error()
          resolve(entries.some((entry) => entry?.name === 'bot-deck'))
        } catch { reject(new Error('Could not check setup.')) }
      })
    })
  }
}

function programs(deps: LinkDeps): Partial<{ [K in Agent]: string }> {
  const env = childEnvironment(deps)
  const paths = (env.PATH ?? '').split(deps.platform === 'win32' ? ';' : ':').filter(Boolean)
  const result: Partial<{ [K in Agent]: string }> = {}
  for (const agent of ['claude', 'codex'] as const) {
    const path = paths.map((dir) => join(dir, agent)).find(deps.exists)
    if (path) result[agent] = path
  }
  return result
}

export function findAgents(deps: LinkDeps = defaultLinkDeps()) {
  const found = programs(deps)
  return { claude: !!found.claude, codex: !!found.codex }
}

export async function syncAgentLinks(input: { enabled: boolean; owned: boolean; port: number }, deps: LinkDeps = defaultLinkDeps()): Promise<void> {
  if (!input.owned) return
  const found = programs(deps)
  let record: Record
  try {
    const raw = deps.read()
    record = raw === undefined ? {} : JSON.parse(raw)
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error()
    for (const agent of Object.keys(record)) {
      const entry = record[agent as Agent]
      if (!['claude', 'codex'].includes(agent) || !entry || !Number.isInteger(entry.port) || typeof entry.bin !== 'string') throw new Error()
    }
  } catch { throw new Error('Could not read Bot Deck setup.') }
  for (const agent of ['claude', 'codex'] as const) {
    const file = found[agent]
    if (!file) continue
    const previous = record[agent]
    if (input.enabled && previous?.port === input.port && previous.bin === deps.bin) continue
    if (!input.enabled && !previous) continue
    try {
      const env = agent === 'claude' ? deps.claudeEnv() : childEnvironment(deps)
      const scope = agent === 'claude' ? ['--scope', 'user'] : []
      if (previous) {
        await deps.execFile(file, ['mcp', 'remove', ...scope, 'bot-deck'], env)
        delete record[agent]
        deps.write(JSON.stringify(record))
      }
      if (input.enabled) {
        if (agent === 'codex' && !previous && await deps.codexEntryExists(file, env)) throw new Error()
        await deps.execFile(file, ['mcp', 'add', ...scope, 'bot-deck', agent === 'claude' ? '-e' : '--env', `OMB_PORT=${input.port}`, '--', deps.bin, 'mcp'], env)
        record[agent] = { port: input.port, bin: deps.bin }
        deps.write(JSON.stringify(record))
      }
    } catch { throw new Error(`Could not add Bot Deck to ${agent === 'claude' ? 'Claude' : 'Codex'}.`) }
  }
}
