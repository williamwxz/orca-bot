import { createHmac, randomBytes } from 'node:crypto'
import { candidates, canonical, definition, identity, uniqueName } from './import-tools.ts'
import type { Candidate, ImportDeps } from './import-tools.ts'
import type { HostPrefs } from './host-prefs.ts'
import { visibleBot } from '../shared/appearance.ts'

export type Connector = {
  name: string
  fingerprint: string
  rawName: string
  provider: string
  enabled: boolean
  present: boolean
  bots: string[]
  bot?: string
}
export type Connectors = { connectors: Connector[]; bots: { id: string; name: string }[] }
export type ConnectorRef = Pick<Connector, 'name' | 'fingerprint'>
export type ConnectorAction =
  | ({ action: 'toggle'; enabled: boolean } & ConnectorRef)
  | { action: 'group'; provider: string; enabled: boolean; targets: ConnectorRef[] }
  | ({ action: 'assign'; bots: string[] } & ConnectorRef)
  | ({ action: 'remove' } & ConnectorRef)
type Local = Candidate & { fingerprint: string }
type Server = { name: string; enabled: boolean; bot?: string; [key: string]: unknown }
type Bot = {
  id: string
  name: string
  chiefOfStaff?: boolean
  mcpServers?: string[] | null
  hidden?: boolean
  sidebarHidden?: boolean
  defaultBot?: { person?: unknown }
}
const valid = (name: unknown): name is string =>
  typeof name === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(name)
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const providerOf = (c: Candidate) => (c.source.startsWith('Claude Code') ? 'Claude Code' : c.source)
const changed = 'Connector list changed. Refresh and try again.'
const busy = 'A bot is currently working. Retry once all bots are idle.'
const serves = (server: Server, bot: Bot) => !server.bot || server.bot === bot.id
const enabledFor = (servers: Server[], bot: Bot) =>
  servers.filter((s) => s.enabled && serves(s, bot)).map((s) => s.name)

/** Credentials and the HMAC key stay on this host. Only opaque references cross RPC. */
export function createConnectors(deps: ImportDeps, prefs: HostPrefs) {
  let tail: Promise<unknown> = Promise.resolve()
  let restrictedPort: number | undefined
  let serverGeneration = 0
  const exclusive = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = tail.then(operation, operation)
    tail = next.catch(() => {})
    return next
  }
  const digest = (value: unknown) => {
    let key = prefs.read()?.connectorKey
    if (!key) key = prefs.write({ connectorKey: randomBytes(32).toString('hex') }).connectorKey
    if (!key) throw new Error('Could not save connector identity.')
    return createHmac('sha256', Buffer.from(key, 'hex')).update(canonical(value)).digest('hex')
  }
  async function readBots(port: number): Promise<Bot[]> {
    const reply = await deps.request(port, '/api/bots?messages=0', 'GET')
    if (
      !object(reply) ||
      !Array.isArray(reply.bots) ||
      reply.bots.some(
        (b) =>
          !object(b) ||
          typeof b.id !== 'string' ||
          !b.id ||
          typeof b.name !== 'string' ||
          (b.mcpServers != null &&
            (!Array.isArray(b.mcpServers) || b.mcpServers.some((n) => !valid(n))))
      )
    )
      throw new Error('Invalid bots.')
    return reply.bots as Bot[]
  }
  async function readServers(port: number) {
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !(await deps.owned(port)))
      throw new Error('MCP connectors require an OpenMausBot server started by this plugin.')
    const reply = await deps.request(port, '/api/mcp/servers', 'GET')
    if (
      !object(reply) ||
      !Array.isArray(reply.servers) ||
      reply.servers.some(
        (s) =>
          !object(s) ||
          !valid(s.name) ||
          typeof s.enabled !== 'boolean' ||
          (s.bot != null && typeof s.bot !== 'string')
      )
    )
      throw new Error('Invalid servers.')
    return reply.servers as Server[]
  }
  async function readState(port: number) {
    return { servers: await readServers(port), bots: await readBots(port) }
  }
  async function patchBot(port: number, bot: Bot, names: string[]) {
    if (names.length > 20) throw new Error('A bot would exceed the 20 connector limit.')
    await deps.request(port, `/api/bots/${encodeURIComponent(bot.id)}`, 'PATCH', {
      mcpServers: names
    })
    bot.mcpServers = names
  }
  async function readDefaults(port: number) {
    const reply = await deps.request(port, '/api/bot-defaults', 'GET')
    if (!object(reply) || !object(reply.defaults) || !object(reply.defaults.profile))
      throw new Error('Invalid bot defaults.')
    return { ...reply.defaults, profile: reply.defaults.profile }
  }
  async function restrictDefaults(port: number, exclude: string[] = []) {
    const generation = serverGeneration
    const defaults = await readDefaults(port)
    const current = defaults.profile.mcpServers
    if (current != null && (!Array.isArray(current) || current.some((n) => typeof n !== 'string')))
      throw new Error('Invalid bot defaults.')
    const allowed = current == null ? [] : (current as string[]).filter((n) => !exclude.includes(n))
    if (current == null || canonical(current) !== canonical(allowed)) {
      // The server replaces the whole template. Preserve memory, skills, routines and profile fields.
      await deps.request(port, '/api/config', 'PATCH', {
        newBotDefaults: {
          ...defaults,
          profile: { ...defaults.profile, mcpServers: allowed }
        }
      })
    }
    if (generation === serverGeneration) restrictedPort = port
  }
  async function disable(port: number, servers: Server[]) {
    const results = await Promise.allSettled(
      servers.map((s) =>
        deps.request(port, `/api/mcp/servers/${s.name}`, 'PATCH', { enabled: false })
      )
    )
    if (results.some((r) => r.status === 'rejected'))
      throw new Error(
        'Could not revoke connector access. Stop OpenMausBot and retry when it is available.'
      )
    for (const s of servers) s.enabled = false
  }
  async function protect(
    port: number,
    state: { servers: Server[]; bots: Bot[] },
    extra: string[] = [],
    defaults = false
  ) {
    const provenance = prefs.read()?.connectors ?? {}
    const excluded = new Set([
      ...state.servers
        .filter((s) => s.enabled && Object.hasOwn(provenance, s.name))
        .map((s) => s.name),
      ...extra
    ])
    if (!excluded.size && !defaults) return
    try {
      await restrictDefaults(port, extra)
      for (const bot of state.bots) {
        if (bot.mcpServers == null)
          await patchBot(
            port,
            bot,
            enabledFor(state.servers, bot).filter((n) => !excluded.has(n))
          )
      }
    } catch (error) {
      // A new unrestricted bot must not keep access if materialization/default protection fails.
      await disable(
        port,
        state.servers.filter((s) => s.enabled && excluded.has(s.name))
      )
      throw error
    }
  }
  async function reconcileState(port: number, state: { servers: Server[]; bots: Bot[] }) {
    const current = prefs.read()?.connectors ?? {}
    const enabled = state.servers.filter((s) => s.enabled && Object.hasOwn(current, s.name))
    if (!enabled.length) return
    const excluded = new Set(enabled.map((s) => s.name))
    // An unrestricted bot can indicate externally changed creation defaults.
    if (state.bots.some((bot) => bot.mcpServers == null)) restrictedPort = undefined
    for (const bot of state.bots) {
      if (bot.mcpServers != null) continue
      try {
        await patchBot(
          port,
          bot,
          enabledFor(state.servers, bot).filter((n) => !excluded.has(n))
        )
      } catch (error) {
        // Only a confirmed, still-unrestricted bot warrants emergency revocation.
        // A failed read or an ambiguously successful PATCH must not disable the team.
        const confirmed = await readBots(port)
        if (confirmed.some((b) => b.id === bot.id && b.mcpServers == null))
          await disable(port, enabled)
        throw error
      }
    }
    if (restrictedPort !== port) await restrictDefaults(port)
  }
  async function snapshot(port: number, discovered?: Local[]) {
    const state = await readState(port)
    await reconcileState(port, state)
    const local =
      discovered ??
      (await candidates(deps)).map((c) => ({
        ...c,
        fingerprint: digest({
          definition: c.definition,
          provider: providerOf(c),
          rawName: c.rawName
        })
      }))
    const provenance = prefs.read()?.connectors ?? {}
    const matched = new Set<string>()
    const available = new Map<string, Local>()
    const taken = new Set(state.servers.map((s) => s.name))
    const rows: Connector[] = state.servers.map((s) => {
      const recorded = Object.hasOwn(provenance, s.name) ? provenance[s.name] : undefined
      const c = local.find(
        (c) =>
          !matched.has(c.fingerprint) &&
          (recorded
            ? recorded.fingerprint === c.fingerprint
            : (() => {
                const d = definition({ ...s, enabled: true })
                return d && identity(d) === identity(c.definition)
              })())
      )
      if (c) matched.add(c.fingerprint)
      return {
        name: s.name,
        fingerprint: digest({
          name: s.name,
          definition: definition({ ...s, enabled: true }),
          bot: s.bot,
          provenance: recorded
        }),
        rawName: c?.rawName ?? s.name,
        provider: c ? providerOf(c) : 'OpenMausBot',
        enabled: s.enabled,
        present: true,
        ...(s.bot ? { bot: s.bot } : {}),
        bots: state.bots
          .filter(
            (b) =>
              visibleBot(b) &&
              serves(s, b) &&
              (b.mcpServers == null ? s.enabled : b.mcpServers.includes(s.name))
          )
          .map((b) => b.id)
      }
    })
    for (const c of local) {
      if (matched.has(c.fingerprint)) continue
      const name = taken.has(c.name) ? uniqueName(c.name, providerOf(c), taken) : c.name
      taken.add(name)
      available.set(name, c)
      rows.push({
        name,
        fingerprint: c.fingerprint,
        rawName: c.rawName,
        provider: providerOf(c),
        enabled: false,
        present: false,
        bots: []
      })
    }
    return {
      ...state,
      local,
      available,
      public: {
        connectors: rows,
        bots: state.bots
          .filter(visibleBot)
          .map((b) => ({ id: b.id, name: b.chiefOfStaff ? `Chief of Staff · ${b.name}` : b.name }))
      }
    }
  }
  async function safe<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op()
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      if (
        [
          busy,
          changed,
          'MCP connectors require an OpenMausBot server started by this plugin.',
          'A bot would exceed the 20 connector limit.',
          'The connector conflicts with the current server configuration. Refresh and try again.',
          'Could not revoke connector access. Stop OpenMausBot and retry when it is available.'
        ].includes(message)
      )
        throw new Error(message)
      throw new Error(
        'Could not finish updating MCP connectors. Some changes may have applied; refresh and retry.'
      )
    }
  }
  return {
    reset() {
      restrictedPort = undefined
      serverGeneration++
    },
    reconcile: (
      port: number,
      write: (operation: () => Promise<void>) => Promise<void> = (operation) => operation()
    ): Promise<void> =>
      safe(async () => {
        const generation = serverGeneration
        const provenance = prefs.read()?.connectors ?? {}
        if (!Object.keys(provenance).length) return
        const servers = await readServers(port)
        const managed = servers.filter((s) => s.enabled && Object.hasOwn(provenance, s.name))
        if (!managed.length) return
        const bots = await readBots(port)
        const unrestricted = bots.some((b) => b.mcpServers == null)
        let defaultsNeedWrite = false
        if (restrictedPort !== port) {
          const defaults = await readDefaults(port)
          defaultsNeedWrite = defaults.profile.mcpServers == null
          if (!defaultsNeedWrite && generation === serverGeneration) restrictedPort = port
        }
        if ((!unrestricted && !defaultsNeedWrite) || generation !== serverGeneration) return
        // Read-only polls never take the lifecycle lock. Recheck under it only when a write is needed.
        await write(() =>
          exclusive(async () => {
            if (generation !== serverGeneration) return
            const fresh = await readState(port)
            await reconcileState(port, fresh)
          })
        )
      }),
    list: (port: number): Promise<Connectors> =>
      exclusive(() => safe(async () => (await snapshot(port)).public)),
    act: (port: number, input: ConnectorAction): Promise<Connectors> =>
      exclusive(() =>
        safe(async () => {
          const state = await snapshot(port)
          if (!input || !['toggle', 'group', 'assign', 'remove'].includes(input.action))
            throw new Error()
          const targets = state.public.connectors.filter((c) =>
            input.action === 'group'
              ? c.provider === input.provider && !c.bot
              : c.name === input.name
          )
          const expected = input.action === 'group' ? input.targets : [input]
          if (
            !targets.length ||
            !Array.isArray(expected) ||
            targets.length !== expected.length ||
            targets.some(
              (c) => !expected.some((e) => e?.name === c.name && e.fingerprint === c.fingerprint)
            )
          )
            throw new Error(changed)
          if (
            (input.action === 'toggle' || input.action === 'group') &&
            typeof input.enabled !== 'boolean'
          )
            throw new Error()
          if (
            input.action === 'assign' &&
            (targets[0].bot ||
              !targets[0].enabled ||
              !Array.isArray(input.bots) ||
              input.bots.some((id) => !state.public.bots.some((b) => b.id === id)))
          )
            throw new Error()
          const targetNames = new Set(targets.map((c) => c.name))
          const enabling = (input.action === 'toggle' || input.action === 'group') && input.enabled
          const newlyEnabled = targets.filter((c) => enabling && !c.enabled).map((c) => c.name)
          const botPlans = state.bots.map((b) => {
            const before = b.mcpServers ?? enabledFor(state.servers, b)
            let after = before.filter((n) => !newlyEnabled.includes(n))
            if (input.action === 'remove') after = after.filter((n) => !targetNames.has(n))
            if (input.action === 'assign' && visibleBot(b)) {
              after = after.filter((n) => !targetNames.has(n))
              if (input.bots.includes(b.id)) after.push(targets[0].name)
            }
            after = [...new Set(after)]
            if (after.length > 20) throw new Error('A bot would exceed the 20 connector limit.')
            return { bot: b, after }
          })
          if ((input.action === 'assign' || input.action === 'remove') && !targets[0].present)
            throw new Error()
          if (enabling) await restrictDefaults(port, newlyEnabled)
          if (input.action === 'remove')
            await deps.request(port, `/api/mcp/servers/${targets[0].name}`, 'PATCH', {
              enabled: false
            })
          if (enabling || input.action === 'assign' || input.action === 'remove') {
            for (const { bot, after } of botPlans) {
              if (bot.mcpServers == null || canonical(bot.mcpServers) !== canonical(after))
                await patchBot(port, bot, after)
            }
          }
          for (const row of targets) {
            if (input.action === 'remove') {
              await deps.request(port, `/api/mcp/servers/${row.name}`, 'DELETE')
              const provenance = { ...prefs.read()?.connectors }
              delete provenance[row.name]
              prefs.write({ connectors: provenance })
            } else if (input.action === 'toggle' || input.action === 'group') {
              if (row.enabled === input.enabled) continue
              let name = row.name
              if (!row.present) {
                const c = state.available.get(row.name)!
                const reply = await deps.request(port, '/api/mcp/servers/import', 'POST', {
                  json: JSON.stringify({ mcpServers: { [name]: c.definition } })
                })
                const added = object(reply) && Array.isArray(reply.added) ? reply.added : []
                if (
                  added.length !== 1 ||
                  !valid(added[0]) ||
                  state.servers.some((s) => s.name === added[0])
                ) {
                  // Only remove newly observed servers, never a name that existed before this import.
                  const fresh = await readState(port)
                  for (const s of fresh.servers.filter(
                    (s) =>
                      !state.servers.some((old) => old.name === s.name) &&
                      (s.name === name || added.includes(s.name))
                  ))
                    await deps.request(port, `/api/mcp/servers/${s.name}`, 'DELETE')
                  throw new Error(changed)
                }
                name = added[0]
                try {
                  prefs.write({
                    connectors: {
                      ...prefs.read()?.connectors,
                      [name]: {
                        provider: providerOf(c),
                        rawName: c.rawName,
                        fingerprint: c.fingerprint
                      }
                    }
                  })
                } catch (error) {
                  await deps.request(port, `/api/mcp/servers/${name}`, 'DELETE')
                  throw error
                }
              }
              if (input.enabled && name !== row.name) {
                await restrictDefaults(port, [name])
                for (const bot of await readBots(port)) {
                  const allowed = bot.mcpServers ?? enabledFor(state.servers, bot)
                  if (bot.mcpServers == null || allowed.includes(name))
                    await patchBot(
                      port,
                      bot,
                      allowed.filter((n) => n !== name)
                    )
                }
              }
              await deps.request(port, `/api/mcp/servers/${name}`, 'PATCH', {
                enabled: input.enabled
              })
              if (input.enabled) {
                // Recheck after enabling, not just before: creation can race the enabling request.
                try {
                  const fresh = await readState(port)
                  await protect(port, fresh, [...newlyEnabled, name], true)
                } catch (error) {
                  await disable(port, [{ name, enabled: true }])
                  throw error
                }
              }
            }
          }
          return (await snapshot(port, state.local)).public
        })
      )
  }
}
