import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { agents, agentKeys, MCP_ENTRY_NAME } from '../shared/agents.ts'
import { opencodeEntries, replaceConfigAtomically } from './agent-config.ts'
import type { Agent } from '../shared/agents.ts'
import { join } from 'node:path'
import { childEnvironment } from './child-environment.ts'
import { defaultCliDeps, ombBinary } from './omb-cli.ts'
import { claudeEnvironment, defaultServerDeps } from './omb-server.ts'
import type { EnvironmentDeps } from './child-environment.ts'

type Entry = { port: number; bin: string }
type Record = Partial<{ [K in Agent]: Entry }>
export type LinkDeps = EnvironmentDeps & {
  exists: (path: string) => boolean
  read: () => string | undefined
  write: (record: string) => void
  execFile: (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<void>
  codexEntryExists: (file: string, env: NodeJS.ProcessEnv) => Promise<boolean>
  listAgent?: (file: string, env: NodeJS.ProcessEnv) => Promise<string>
  readConfig?: (path: string) => string | undefined
  replaceConfig?: (path: string, value: string) => void
  claudeEnv: () => NodeJS.ProcessEnv
  bin: string
}

export function defaultLinkDeps(): LinkDeps {
  if (process.env.NODE_TEST_CONTEXT) throw new Error('Tests must inject agent link dependencies')
  const cli = defaultCliDeps()
  const server = defaultServerDeps()
  const file = join(cli.home, '.orca-bot/agent-link.json')
  return {
    ...cli,
    bin: ombBinary(cli),
    claudeEnv: () => claudeEnvironment(server, false).env,
    read: () => {
      try {
        return fs.readFileSync(file, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw new Error('Could not read setup.')
      }
    },
    write: (value) => {
      fs.mkdirSync(join(cli.home, '.orca-bot'), { recursive: true, mode: 0o700 })
      fs.writeFileSync(file, value, { mode: 0o600 })
      fs.chmodSync(file, 0o600)
    },
    execFile: (file, args, env) =>
      new Promise((resolve, reject) => {
        execFile(file, args, { env, timeout: 10000 }, (error) =>
          error ? reject(new Error('Command failed.')) : resolve()
        )
      }),
    readConfig: (path) => {
      try {
        return fs.readFileSync(path, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw new Error('Could not read setup.')
      }
    },
    replaceConfig: (path, value) => replaceConfigAtomically(path, value, `${path}.${randomUUID()}.tmp`, fs),
    listAgent: (file, env) =>
      new Promise((resolve, reject) => {
        execFile(file, ['mcp', 'list'], { env, timeout: 10000, maxBuffer: 1024 * 1024 }, (error, stdout) =>
          error ? reject(new Error('Could not check setup.')) : resolve(stdout)
        )
      }),
    // Codex add replaces existing entries; refuse to overwrite one we do not own.
    codexEntryExists: (file, env) =>
      new Promise((resolve, reject) => {
        execFile(file, ['mcp', 'list', '--json'], { env, timeout: 10000 }, (error, stdout) => {
          if (error) {
            reject(new Error('Could not check setup.'))
            return
          }
          try {
            const entries: unknown = JSON.parse(stdout)
            if (!Array.isArray(entries)) throw new Error()
            resolve(entries.some((entry) => entry?.name === MCP_ENTRY_NAME))
          } catch {
            reject(new Error('Could not check setup.'))
          }
        })
      })
  }
}

function programs(deps: LinkDeps): Partial<{ [K in Agent]: string }> {
  const env = childEnvironment(deps)
  const paths = (env.PATH ?? '').split(deps.platform === 'win32' ? ';' : ':').filter(Boolean)
  const result: Partial<{ [K in Agent]: string }> = {}
  for (const agent of agentKeys) {
    const path = paths.map((dir) => join(dir, agents[agent].program)).find(deps.exists)
    if (path) result[agent] = path
  }
  return result
}

export function findAgents(deps: LinkDeps = defaultLinkDeps()) {
  const found = programs(deps)
  return Object.fromEntries(agentKeys.map((agent) => [agent, !!found[agent]])) as Partial<{
    [K in Agent]: boolean
  }>
}

export async function syncAgentLinks(
  input: { enabled: boolean; owned: boolean; port: number },
  deps: LinkDeps = defaultLinkDeps()
): Promise<void> {
  if (!input.owned) return
  const found = programs(deps)
  let record: Record
  try {
    const raw = deps.read()
    record = raw === undefined ? {} : JSON.parse(raw)
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error()
    for (const agent of Object.keys(record)) {
      const entry = record[agent as Agent]
      if (
        !agentKeys.includes(agent as Agent) ||
        !entry ||
        !Number.isInteger(entry.port) ||
        typeof entry.bin !== 'string'
      )
        throw new Error()
    }
  } catch {
    throw new Error('Could not read Bot Team for Orca setup.')
  }
  for (const agent of agentKeys) {
    const file = found[agent]
    if (!file) continue
    const previous = record[agent]
    if (input.enabled && previous?.port === input.port && previous.bin === deps.bin) continue
    if (!input.enabled && !previous) continue
    try {
      const spec = agents[agent]
      const env = spec.environment === 'claude' ? deps.claudeEnv() : childEnvironment(deps)
      if (previous) {
        if (spec.remove) await deps.execFile(file, [...spec.remove], env)
        else {
          try {
            if (!deps.readConfig || !deps.replaceConfig) throw new Error()
            const path = join(deps.home, spec.config)
            const raw = JSON.parse(deps.readConfig(path) ?? '')
            const entries = opencodeEntries(raw)
            const entry = entries?.[MCP_ENTRY_NAME]
            if (
              !entry ||
              entry.type !== 'local' ||
              !Array.isArray(entry.command) ||
              entry.command.length !== 2 ||
              entry.command[0] !== previous.bin ||
              entry.command[1] !== 'mcp'
            )
              throw new Error()
            delete entries![MCP_ENTRY_NAME]
            deps.replaceConfig(path, JSON.stringify(raw, null, 2) + '\n')
          } catch {
            throw new Error(`Remove ${MCP_ENTRY_NAME} from opencode by hand.`)
          }
        }
        delete record[agent]
        deps.write(JSON.stringify(record))
      }
      if (input.enabled) {
        if (!previous) {
          if (spec.check === 'codex' && (await deps.codexEntryExists(file, env))) throw new Error()
          if (spec.check === 'config') {
            if (!deps.readConfig) throw new Error()
            const raw = deps.readConfig(join(deps.home, spec.config))
            if (raw !== undefined) {
              const entries = opencodeEntries(JSON.parse(raw))
              if (!entries || Object.hasOwn(entries, MCP_ENTRY_NAME)) throw new Error()
            }
          }
          if (spec.check === 'list') {
            if (!deps.listAgent || !antigravityListIsEmpty(await deps.listAgent(file, env))) throw new Error()
          }
        }
        await deps.execFile(file, spec.add(input.port, deps.bin), env)
        record[agent] = { port: input.port, bin: deps.bin }
        deps.write(JSON.stringify(record))
      }
    } catch (error) {
      if (error instanceof Error && error.message === `Remove ${MCP_ENTRY_NAME} from opencode by hand.`)
        throw error
      throw new Error(`Could not add Bot Team for Orca to ${agents[agent].label}.`)
    }
  }
}

// Only the observed empty-state sentence is trusted; unknown output fails closed.
function antigravityListIsEmpty(output: string): boolean {
  return output.trim() === 'No MCP servers configured.'
}
