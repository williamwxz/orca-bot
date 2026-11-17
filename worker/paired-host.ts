import type { OrcaWorkerApi } from 'orca/worker'
import type { CliDeps } from './omb-cli.ts'
import { defaultCliDeps } from './omb-cli.ts'
import { TESTED_OPENMAUSBOT_VERSION } from '../shared/omb-version.ts'
import { callOrca } from './orca-cli.ts'
import { RELAYED } from './relay-frames.ts'
import { createTerminalLink, defaultLinkDeps } from './terminal-link.ts'
import type { LinkDeps } from './terminal-link.ts'

const LOCAL = 'local'
const relayed = new Set<string>(RELAYED)
export type Host = { id: string; name: string }
/** `selected` is `local`, a paired server's id, or empty while the person has not chosen yet. */
export type Hosts = { selected: string; hosts: Host[]; message: string }
export type BridgeDeps = { call(args: string[]): Promise<any>; link?: (orca: OrcaWorkerApi) => Partial<LinkDeps> }
export function bridgeDeps(cli: CliDeps = defaultCliDeps()): BridgeDeps {
  return { call: args => callOrca(args, cli) }
}

async function listHosts(deps: BridgeDeps): Promise<Host[]> {
  const result = await deps.call(['environment', 'list', '--json'])
  if (!Array.isArray(result?.environments) || result.environments.some((host: any) => typeof host?.id !== 'string' || typeof host?.name !== 'string')) throw new Error('Could not read Orca’s paired servers.')
  return result.environments.map((host: Host) => ({ id: host.id, name: host.name }))
}

export async function readHosts(saved: unknown, deps: BridgeDeps): Promise<Hosts> {
  let hosts: Host[] = [], failed = false
  try { hosts = await listHosts(deps) } catch { failed = true }
  if (saved === LOCAL) return { selected: LOCAL, hosts, message: '' }
  if (typeof saved === 'string' && saved) {
    if (hosts.some(host => host.id === saved)) return { selected: saved, hosts, message: '' }
    // Never fall back to a different bot team than the one the person chose.
    return { selected: saved, hosts, message: failed ? 'Could not read Orca’s paired servers. Check that Orca’s command line tool is installed, then retry.' : 'The chosen Orca server is no longer paired. Choose where your bots run.' }
  }
  // Not knowing which servers exist is not the same as having none: never start bots here on a guess.
  if (failed) return { selected: '', hosts, message: 'Could not read Orca’s paired servers. Choose This computer, or press Retry.' }
  // Ask once instead of guessing: starting bots here downloads OpenMausBot.
  return hosts.length ? { selected: '', hosts, message: 'Choose where your bots run.' } : { selected: LOCAL, hosts, message: '' }
}

export function registerPairedHost(orca: OrcaWorkerApi, local: (api: OrcaWorkerApi) => void, deps: BridgeDeps = bridgeDeps()): void {
  const handlers = new Map<string, (input: any, context: any) => unknown>()
  const link = createTerminalLink({ ...defaultLinkDeps(deps.call, orca.storage), ...deps.link?.(orca) })
  let cached: Promise<Hosts> | undefined
  const read = () => orca.storage.get('botHost').then(saved => readHosts(saved, deps))
  const current = () => cached ??= read()
  const request = async (name: string, input: unknown, context: unknown): Promise<any> => {
    if (name === 'status' && (input as { retry?: boolean } | undefined)?.retry) cached = undefined
    const state = await current()
    if (state.selected === LOCAL) return handlers.get(name)?.(input, context)
    const host = state.hosts.find(item => item.id === state.selected)
    if (!host) throw new Error(state.message)
    if (name === 'setup.get') return { answered: true, agents: { claude: false, codex: false } }
    if (name === 'tools.find') return { tools: [] }
    if (name === 'chat.open') return { message: `The Bot Dashboard runs on ${host.name}. Open it in Orca there.` }
    if (!relayed.has(name)) throw new Error(`Manage setup, tool imports and the server in Orca on ${host.name}.`)
    const output = await link.request(host, name, input)
    if (name === 'status' && output?.state === 'running') return { ...output, message: [`Connected to ${host.name}.`, output.message].filter(Boolean).join(' ') }
    return output
  }
  const proxy = {
    ...orca,
    panels: { ...orca.panels, handle: (name: string, handler: any) => {
      handlers.set(name, handler)
      return orca.panels.handle(name, async (input, context) => {
        try { return await request(name, input, context) }
        catch (error) {
          if (name !== 'status') throw error
          return { state: 'start_failed', message: error instanceof Error ? error.message : 'Could not connect to the bot host.', testedVersion: TESTED_OPENMAUSBOT_VERSION }
        }
      })
    } },
    commands: { ...orca.commands, register: (id: string, handler: any) => orca.commands.register(id, async (args, context) => {
      if ((await current()).selected === LOCAL) return handler(args, context)
      if (id === 'orcabot.open') return request('chat.open', {}, context)
      throw new Error('Manage the bot server and its tools in Orca on the bot host.')
    }) }
  } as OrcaWorkerApi
  local(proxy)
  // Where the bots run is this computer's own choice; these two never reach a server.
  orca.panels.handle('hosts.get', () => cached = read())
  orca.panels.handle('hosts.select', async (input) => {
    const id = (input as { id?: unknown } | undefined)?.id
    if (typeof id !== 'string' || !id) throw new Error('Choose where your bots run.')
    if (id !== LOCAL && !(await listHosts(deps)).some(host => host.id === id)) throw new Error('That Orca server is not paired with this computer.')
    await orca.storage.set('botHost', id)
    // Leave nothing running on a server the person moved away from.
    if (id === LOCAL) await link.disconnect().catch(() => {})
    return cached = read()
  })
}
