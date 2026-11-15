import { randomUUID } from 'node:crypto'
import { getMainBotId, listServerBots, sendServerMessage, deleteServerBot } from './server.ts'
import { toBot, toEntry } from '../shared/model.ts'
import {
  assertAllowedCredentialUrl, normalizeHeaders, backendHeaders, request, READ_METHODS,
  type Account, type Dependencies
} from './transport.ts'
export {
  assertAllowedCredentialUrl, normalizeHeaders, backendHeaders, request, redact,
  type Account, type Dependencies
} from './transport.ts'


export type Route = { gatewayUrl: string; gatewayToken: string; headers: Record<string, string> }
const unsupported = () => failure('unsupported_version', 'This version of Grok Bot is not supported yet')
function failure(code: string, message: string) {
  return Object.assign(new Error(message), { code })
}
function record(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unsupported()
  return value as Record<string, any>
}
export async function ensureSandbox(account: Account, appVersion?: string, deps: Dependencies = {}): Promise<Route> {
  const headers = backendHeaders(account, appVersion)
  const url = 'https://api2.cursor.sh/aiserver.v1.GrokBotService/EnsureSandBox'
  assertAllowedCredentialUrl(url, 'backend')
  const r = record(await request(url, headers, {}, 'EnsureSandBox', deps, [account.accessToken], 'backend'))
  const gatewayUrl = r.gatewayUrl || r.gateway_url
  const gatewayToken = r.gatewayToken || r.gateway_token
  if (typeof gatewayUrl !== 'string' || !gatewayUrl || typeof gatewayToken !== 'string' || !gatewayToken) throw unsupported()
  assertAllowedCredentialUrl(gatewayUrl)
  let extra = normalizeHeaders(r.gatewayHeaders)
  if (!Object.keys(extra).length) extra = normalizeHeaders(r.gateway_headers)
  const token = r.anyrunNetworkToken || r.anyrun_network_token || r.networkToken
  if (!Object.keys(extra).length && token) extra = { 'x-anyrun-network-token': String(token) }
  return { gatewayUrl: gatewayUrl.replace(/\/$/, ''), gatewayToken, headers: extra }
}
export async function gatewayCall(route: Route, method: string, body: unknown, deps: Dependencies = {}) {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(method)) throw failure('invalid_params', 'Invalid gateway method')
  const url = `${route.gatewayUrl.replace(/\/$/, '')}/api/${method}`
  assertAllowedCredentialUrl(url)
  const extra = normalizeHeaders(route.headers)
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${route.gatewayToken}`,
    ...extra
  }
  return request(url, headers, body, method, deps, [route.gatewayToken, ...headerSecrets(extra)])
}
// Which of a route's own header values to strip from error text. A header that names a
// credential is always stripped, however short; any other value only when it is long enough
// that stripping it cannot garble an ordinary message ("1", "prod").
const CREDENTIAL_HEADER = /token|auth|secret|key|cookie|session/i
function headerSecrets(headers: Record<string, string>): string[] {
  return Object.entries(headers)
    .filter(([name, value]) => CREDENTIAL_HEADER.test(name) || value.length >= 8)
    .map(([, value]) => value)
}

type ClientOptions = Dependencies & {
  getRoute: () => Route | Promise<Route>
  // The session provider checks account identity before and after refresh and discards changed accounts.
  refreshRoute: () => Route | Promise<Route>
  getAccount?: () => { account: Account; appVersion?: string } | Promise<{ account: Account; appVersion?: string }>
  randomUUID?: () => string
}
export function createGatewayClient(options: ClientOptions) {
  let harnesses = new Map<string, string>()
  async function serverAccount() {
    if (!options.getAccount) throw failure('not_signed_in', 'Open the Grok Bot app and sign in, then retry.')
    return options.getAccount()
  }
  async function serverSend(agentId: string, text: string, messageId: string) {
    const { account, appVersion } = await serverAccount()
    return sendServerMessage(account, appVersion, { agentId, text, messageId }, options)
  }
  async function serverDelete(id: string) {
    const { account, appVersion } = await serverAccount()
    return deleteServerBot(account, appVersion, id, options)
  }
  let refreshing: Promise<Route> | undefined
  async function call(method: string, body: unknown) {
    const route = await options.getRoute()
    try {
      return await gatewayCall(route, method, body, options)
    } catch (error) {
      const e = error as any
      if (READ_METHODS.has(method) && e.status === 417 && e.hibernated) {
        refreshing ??= Promise.resolve()
          .then(() => options.refreshRoute())
          .finally(() => {
            refreshing = undefined
          })
        const refreshed = await refreshing
        return gatewayCall(refreshed, method, body, options)
      }
      throw error
    }
  }
  async function agents() {
    const raw = await call('listAgents', {})
    const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.agents) ? raw.agents : raw?.agent ? [raw.agent] : null
    if (!rows) throw unsupported()
    return rows.map(record).filter(isBot)
  }
  function rowId(row: Record<string, any>) {
    return row.id || row.agentId
  }
  function isBot(row: Record<string, any>) {
    const id = rowId(row)
    if (typeof id !== 'string' || !id) return false
    const members = row.memberIds || row.memberAgentIds || []
    return row.isGroup !== true && !(row.isGroup == null && Array.isArray(members) && members.length)
  }
  async function resolve(id: string) {
    const bot = (await agents()).find(r => rowId(r).toLowerCase() === id.toLowerCase())
    if (!bot) throw failure('invalid_params', 'Unknown bot id. Refresh the bot list')
    return bot
  }
  function text(value: string, label: string) {
    if (typeof value !== 'string' || !value.trim()) throw failure('invalid_params', `${label} is required`)
    return value.trim()
  }
  async function write(method: string, body: unknown) {
    try {
      return await call(method, body)
    } catch (error) {
      const e = error as any
      const ambiguousCodes = ['timeout', 'connection_failed', 'response_too_large', 'unsupported_version']
      if (e.status >= 500 || ambiguousCodes.includes(e.code)) {
        const error = failure('outcome_unknown', 'The outcome is unknown. Check Grok Bot before trying again')
        throw Object.assign(error, { delivery: 'unknown', status: e.status, method })
      }
      throw error
    }
  }
  async function tail(id: string, limit: number) {
    const r = record(await call('getAgentTranscriptTail', { id, limit }))
    if (!Array.isArray(r.entries)) throw unsupported()
    return r.entries.map(record)
  }
  return {
    async listBots() {
      const rows = await agents()
      let serverHarnesses = new Map<string, string>()
      let mainAgentId: string | undefined
      if (options.getAccount) {
        try {
          const { account, appVersion } = await serverAccount()
          // Independent optional reads: neither failure can discard the gateway roster.
          const [mainResult, rosterResult] = await Promise.allSettled([
            getMainBotId(account, appVersion, options),
            rows.some(row => row.harness == null)
              ? listServerBots(account, appVersion, options) : Promise.resolve([])
          ])
          if (mainResult.status === 'fulfilled') mainAgentId = mainResult.value
          if (rosterResult.status === 'fulfilled') {
            serverHarnesses = new Map(rosterResult.value.map(row => [row.agentId, row.harness]))
          }
        } catch { /* Account access is optional for these decorations too. */ }
      }
      const enriched = rows.map(row => ({
        ...row,
        main: mainAgentId !== undefined && rowId(row) === mainAgentId,
        harness: row.harness ?? serverHarnesses.get(rowId(row))
      }))
      harnesses = new Map(enriched.map(row => [rowId(row), row.harness]))
      return enriched.map(toBot)
    },
    async createBot(input: { name: string; instructions?: string }) {
      const r = await write('createAgent', {
        name: text(input.name, 'Name'),
        description: input.instructions ?? '',
        title: '',
        avatarShape: '',
        avatarColor: '',
        origin: 'user'
      })
      const bot = toBot(r?.agent ?? r)
      return bot.id ? bot : undefined
    },
    async updateBot(id: string, patch: { name?: string; instructions?: string; hidden?: boolean }) {
      const old = await resolve(id)
      id = rowId(old)
      const name = patch.name === undefined ? old.name || '' : text(patch.name, 'Name')
      const description = patch.instructions ?? old.description ?? ''
      await write('updateAgent', { id, profile: { name, description } })
      if (patch.hidden !== undefined) await write('setAgentHiddenFromSidebar', { id, isHidden: patch.hidden })
      return toBot({
        ...old,
        name,
        description,
        isHiddenFromSidebar: patch.hidden ?? old.isHiddenFromSidebar
      })
    },
    async deleteBot(id: string) {
      if (harnesses.get(id) === 'temporal') return serverDelete(id)
      const result = await write('deleteAgent', { id })
      if (Array.isArray(result?.refusedAgentIds) && result.refusedAgentIds.includes(id)) {
        if (options.getAccount) return serverDelete(id)
        throw failure('delete_refused', 'Grok Bot refused to delete this bot. Delete it in the Grok Bot app.')
      }
      if (Array.isArray(result?.failedAgentIds) && result.failedAgentIds.includes(id)) {
        throw failure('delete_failed', 'Grok Bot could not delete this bot. Try again, or delete it in the Grok Bot app.')
      }
    },
    async readThread(id: string, limit = 40) {
      const count = Math.min(200, Math.max(1, Number.isInteger(limit) ? limit : 40))
      return (await tail(id, count)).map(toEntry).filter(e => e.id)
    },
    async sendMessage(id: string, value: string): Promise<{ delivery: 'accepted' | 'unknown'; messageId?: string }> {
      const prompt = text(value, 'Message')
      const clientNonce = (options.randomUUID ?? randomUUID)()
      if (harnesses.get(id) === 'temporal') return serverSend(id, prompt, clientNonce)
      let r: any
      try {
        r = await write('sendPrompt', { agentId: id, prompt, clientNonce })
      } catch (error) {
        if ((error as any).code === 'server_bot' && options.getAccount) return serverSend(id, prompt, clientNonce)
        throw error
      }
      if (typeof r?.messageId === 'string') return { delivery: 'accepted', messageId: r.messageId }
      if (r?.accepted === true) {
        try {
          const entry = (await tail(id, 20)).find(e => e.clientNonce === clientNonce && typeof e.id === 'string' && e.id)
          if (entry) return { delivery: 'accepted', messageId: entry.id }
        } catch { /* A failed lookup cannot prove rejection. */ }
        // Unlike gbot, explicit acceptance is enough even when the transcript lags or lookup fails.
        return { delivery: 'accepted' }
      }
      return { delivery: 'unknown' }
    }
  }
}
