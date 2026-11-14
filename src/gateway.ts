import { randomUUID } from 'node:crypto'
import { toBot, toEntry } from '../shared/model'

export type Route = { gatewayUrl: string; gatewayToken: string; headers: Record<string, string> }
export type Account = { key: string; accessToken: string; teamId?: string }
export type Dependencies = {
  fetch?: typeof globalThis.fetch
  setTimeout?: typeof globalThis.setTimeout
  clearTimeout?: typeof globalThis.clearTimeout
}
const unsupported = () => failure('unsupported_version', 'This version of Grok Bot is not supported yet')
function failure(code: string, message: string) {
  return Object.assign(new Error(message), { code })
}
function record(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unsupported()
  return value as Record<string, any>
}
export function assertAllowedCredentialUrl(value: string, kind: 'backend' | 'gateway' = 'gateway'): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw failure('invalid_url', 'The connection URL is invalid')
  }
  const host = url.hostname.toLowerCase()
  const matches = (base: string) => host === base || host.endsWith(`.${base}`)
  if (url.protocol !== 'https:' || url.username || url.password ||
      !(matches('cursor.sh') || matches('cursor.com') || (kind === 'gateway' && host.endsWith('.cursorvm.com')))) {
    throw failure('invalid_url', 'The connection URL is not allowed')
  }
  return url
}
export function normalizeHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const entries = Object.entries(value)
    .filter(([, v]) => v != null && String(v) !== '')
    .map(([k, v]) => [k.toLowerCase(), String(v)])
  return Object.fromEntries(entries)
}
function redact(text: string, secrets: string[]) {
  for (const secret of secrets.filter(secret => secret.length >= 8).sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join('[redacted]').split(encodeURIComponent(secret)).join('[redacted]')
  }
  return text.replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer [redacted]')
}
const TIMEOUT_MS = 30_000
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const READ_METHODS = new Set(['EnsureSandBox', 'listAgents', 'getAgentTranscriptTail'])

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const decoder = new TextDecoder()
  let text = ''
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => {})
        throw failure('response_too_large', 'The response is too large')
      }
      text += decoder.decode(part.value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}
function parseBody(text: string, ok: boolean): any {
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    if (ok) throw unsupported()
    return { raw: text }
  }
}
function httpError(response: Response, data: any, method: string, secrets: string[]) {
  if (method === 'EnsureSandBox' && [401, 403].includes(response.status)) {
    return failure('not_signed_in', 'Open the Grok Bot app and sign in, then retry.')
  }
  const detail = redact(String(data?.message ?? data?.error ?? data?.raw ?? response.statusText), secrets).slice(0, 300)
  return Object.assign(failure('gateway_error', `Request failed (${response.status})${detail ? `: ${detail}` : ''}`), {
    status: response.status,
    method,
    hibernated: response.headers.get('x-anyrun-error-source') === 'anyrun-proxy' &&
      response.headers.get('x-anyrun-failure-reason') === 'pod_hibernated'
  })
}
async function request(url: string, headers: Record<string, string>, body: unknown, method: string, deps: Dependencies, secrets: string[]) {
  const controller = new AbortController()
  const start = deps.setTimeout ?? globalThis.setTimeout
  const stop = deps.clearTimeout ?? globalThis.clearTimeout
  let timer: ReturnType<typeof setTimeout> | undefined
  let writeSucceeded = false
  async function perform() {
    const response = await (deps.fetch ?? globalThis.fetch)(url, {
      method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: controller.signal
    })
    if (method === 'EnsureSandBox' && [401, 403].includes(response.status)) {
      void response.body?.cancel().catch(() => {})
      throw httpError(response, {}, method, secrets)
    }
    // A successful write must never invite a duplicate just because its body is unusable.
    if (response.ok && !READ_METHODS.has(method)) {
      writeSucceeded = true
      try {
        return parseBody(await readCapped(response), false)
      } catch {
        return {}
      }
    }
    const data = parseBody(await readCapped(response), response.ok)
    if (!response.ok) throw httpError(response, data, method, secrets)
    return data
  }
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = start(() => {
        controller.abort()
        reject(failure('timeout', 'The request timed out'))
      }, TIMEOUT_MS)
    })
    return await Promise.race([timeout, perform()])
  } catch (error) {
    // Never expose fetch errors: they may contain URLs or credential headers.
    if (writeSucceeded) return {}
    const codes = ['timeout', 'response_too_large', 'unsupported_version', 'gateway_error', 'not_signed_in']
    if (error instanceof Error && codes.includes((error as any).code)) throw error
    throw failure('connection_failed', 'Could not reach Grok Bot. Check the connection and try again')
  } finally {
    if (timer !== undefined) stop(timer)
  }
}
export async function ensureSandbox(account: Account, appVersion?: string, deps: Dependencies = {}): Promise<Route> {
  const headers: Record<string, string> = {
    'content-type': 'application/json', 'connect-protocol-version': '1', authorization: `Bearer ${account.accessToken}`,
    'x-cursor-client-type': 'sand', 'x-cursor-client-version': appVersion && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(appVersion) ? appVersion : '0.20.0',
    'x-sand-box-namespace': 'prod'
  }
  if (account.teamId) headers['x-cursor-team-id'] = account.teamId
  const url = 'https://api2.cursor.sh/aiserver.v1.GrokBotService/EnsureSandBox'
  assertAllowedCredentialUrl(url, 'backend')
  const r = record(await request(url, headers, {}, 'EnsureSandBox', deps, [account.accessToken]))
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
  return request(url, headers, body, method, deps, [route.gatewayToken, ...Object.values(extra)])
}

type ClientOptions = Dependencies & {
  getRoute: () => Route | Promise<Route>
  // The session provider checks account identity before and after refresh and discards changed accounts.
  refreshRoute: () => Route | Promise<Route>
  randomUUID?: () => string
}
export function createGatewayClient(options: ClientOptions) {
  let refreshing: Promise<Route> | undefined
  async function call(method: string, body: unknown) {
    const route = await options.getRoute()
    try {
      return await gatewayCall(route, method, body, options)
    } catch (error) {
      const e = error as any
      if (['listAgents', 'getAgentTranscriptTail'].includes(method) && e.status === 417 && e.hibernated) {
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
    return rows.map(record).filter(r => typeof (r.id || r.agentId) === 'string' && (r.id || r.agentId)).filter(r => {
      const members = r.memberIds || r.memberAgentIds || []
      return r.isGroup !== true && !(r.isGroup == null && Array.isArray(members) && members.length)
    })
  }
  async function resolve(id: string) {
    const bot = (await agents()).find(r => (r.id || r.agentId).toLowerCase() === id.toLowerCase())
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
      if (e.status >= 500 || ['timeout', 'connection_failed', 'response_too_large', 'unsupported_version'].includes(e.code)) {
        throw Object.assign(failure('outcome_unknown', 'The outcome is unknown. Check Grok Bot before trying again'), { delivery: 'unknown', status: e.status, method })
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
      return (await agents()).map(toBot)
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
      id = old.id || old.agentId
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
      await write('deleteAgent', { id })
    },
    async readThread(id: string, limit = 40) {
      const count = Math.min(200, Math.max(1, Number.isInteger(limit) ? limit : 40))
      return (await tail(id, count)).map(toEntry).filter(e => e.id)
    },
    async sendMessage(id: string, value: string): Promise<{ delivery: 'accepted' | 'unknown'; messageId?: string }> {
      const prompt = text(value, 'Message')
      const clientNonce = (options.randomUUID ?? randomUUID)()
      const r = await write('sendPrompt', { agentId: id, prompt, clientNonce })
      if (typeof r?.messageId === 'string') return { delivery: 'accepted', messageId: r.messageId }
      if (r?.accepted === true) {
        try {
          const entry = (await tail(id, 20)).find(e => e.clientNonce === clientNonce && typeof e.id === 'string' && e.id)
          if (entry) return { delivery: 'accepted', messageId: entry.id }
        } catch { /* A failed lookup cannot prove rejection. */ }
      }
      return { delivery: 'unknown' }
    }
  }
}
