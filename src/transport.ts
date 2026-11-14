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
export function redact(text: string, secrets: string[]) {
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join('[redacted]').split(encodeURIComponent(secret)).join('[redacted]')
  }
  return text.replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer [redacted]')
}
const TIMEOUT_MS = 30_000
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const APP_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/
export const READ_METHODS = new Set(['EnsureSandBox', 'ListGrokBotAgents', 'listAgents', 'getAgentTranscriptTail'])

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
const CONNECT_CODES = new Set([
  'unauthenticated', 'permission_denied', 'unimplemented', 'not_found',
  'deadline_exceeded', 'unavailable', 'internal', 'unknown', 'data_loss'
])
function httpError(response: Response, data: any, method: string, secrets: string[]) {
  const detail = redact(String(data?.message ?? data?.error ?? data?.raw ?? response.statusText), secrets).slice(0, 300)
  return Object.assign(failure('gateway_error', `Request failed (${response.status})${detail ? `: ${detail}` : ''}`), {
    status: response.status,
    connectCode: CONNECT_CODES.has(data?.code) ? data.code : undefined,
    method,
    hibernated: response.headers.get('x-anyrun-error-source') === 'anyrun-proxy' &&
      response.headers.get('x-anyrun-failure-reason') === 'pod_hibernated'
  })
}
export async function request(
  url: string, headers: Record<string, string>, body: unknown, method: string,
  deps: Dependencies, secrets: string[], kind: 'backend' | 'gateway' = 'gateway'
) {
  assertAllowedCredentialUrl(url, kind)
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
      throw failure('not_signed_in', 'Open the Grok Bot app and sign in, then retry.')
    }
    // The status establishes rejection even if the response body cannot be read.
    if (method === 'sendPrompt' && response.status === 409) {
      void response.body?.cancel().catch(() => {})
      throw Object.assign(failure('server_bot', "This bot runs on Grok Bot's server. Open the Grok Bot app and sign in, then retry."), {
        status: response.status,
        method
      })
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
    const codes = ['timeout', 'response_too_large', 'unsupported_version', 'gateway_error', 'not_signed_in', 'server_bot']
    if (error instanceof Error && codes.includes((error as any).code)) throw error
    throw failure('connection_failed', 'Could not reach Grok Bot. Check the connection and try again')
  } finally {
    if (timer !== undefined) stop(timer)
  }
}
export function backendHeaders(account: Account, appVersion?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'connect-protocol-version': '1',
    authorization: `Bearer ${account.accessToken}`,
    'x-cursor-client-type': 'sand',
    'x-cursor-client-version': appVersion && APP_VERSION_PATTERN.test(appVersion) ? appVersion : '0.20.0',
    'x-sand-box-namespace': 'prod'
  }
  if (account.teamId) headers['x-cursor-team-id'] = account.teamId
  return headers
}
