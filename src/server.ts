import { backendHeaders, redact, request, type Account, type Dependencies } from './transport.ts'

export type ServerBot = { agentId: string; id: string; harness: string }
export type ServerMessage = { agentId: string; text: string; messageId: string }

function failure(code: string, message: string) {
  return Object.assign(new Error(message), { code })
}
function unknownOutcome() {
  return Object.assign(failure('outcome_unknown', 'The outcome is unknown. Check Grok Bot before trying again'), {
    delivery: 'unknown'
  })
}
const UNKNOWN_TRANSPORT_CODES = new Set([
  'timeout', 'connection_failed', 'response_too_large', 'unsupported_version'
])
const UNKNOWN_CONNECT_CODES = new Set([
  'deadline_exceeded', 'unavailable', 'internal', 'unknown', 'data_loss'
])
function mapBackendError(error: unknown, method: string) {
  const e = error as any
  const read = method === 'ListGrokBotAgents'
  if (e.connectCode === 'unimplemented') {
    throw failure('unsupported_version', 'This version of Grok Bot is not supported yet')
  }
  if (['unauthenticated', 'permission_denied'].includes(e.connectCode)) {
    if (read) {
      throw failure('not_signed_in', 'Open the Grok Bot app and sign in, then retry.')
    }
    throw failure('server_refused', `Grok Bot refused the request: ${e.message}`)
  }
  if (method === 'DeleteGrokBotAgent' && e.connectCode === 'not_found') return {}
  const ambiguous = e.status >= 500 ||
    UNKNOWN_TRANSPORT_CODES.has(e.code) || UNKNOWN_CONNECT_CODES.has(e.connectCode)
  if (!read && ambiguous) throw unknownOutcome()
  throw error
}
async function call(
  account: Account, appVersion: string | undefined, method: string, body: unknown, deps: Dependencies
) {
  try {
    return await request(
      `https://api2.cursor.sh/aiserver.v1.GrokBotService/${method}`,
      backendHeaders(account, appVersion), body, method, deps, [account.accessToken], 'backend'
    )
  } catch (error) {
    return mapBackendError(error, method)
  }
}
function isServerBot(row: any): row is ServerBot {
  return row && typeof row.agentId === 'string' &&
    typeof row.id === 'string' && typeof row.harness === 'string'
}
export async function listServerBots(account: Account, appVersion: string | undefined, deps: Dependencies): Promise<ServerBot[]> {
  const result = await call(account, appVersion, 'ListGrokBotAgents', {}, deps)
  if (!Array.isArray(result?.agents)) {
    throw failure('unsupported_version', 'This version of Grok Bot is not supported yet')
  }
  return result.agents.filter(isServerBot).map((row: ServerBot) => ({
    agentId: row.agentId,
    id: row.id,
    harness: row.harness
  }))
}
// Accept the enum's short names and protobuf-JSON prefixed names; unknown values stay unknown.
const ACCEPTED = new Set<unknown>([
  1, 2, 3, 'ACCEPTED_BOX', 'ACCEPTED_TEMPORAL', 'DUPLICATE',
  'GROK_BOT_USER_MESSAGE_DELIVERY_ACCEPTED_BOX',
  'GROK_BOT_USER_MESSAGE_DELIVERY_ACCEPTED_TEMPORAL',
  'GROK_BOT_USER_MESSAGE_DELIVERY_DUPLICATE'
])
const REFUSED = new Set<unknown>([4, 'REFUSED', 'GROK_BOT_USER_MESSAGE_DELIVERY_REFUSED'])
function refusalMessage(refusal: any, account: Account): string {
  const detail = typeof refusal?.message === 'string' ? refusal.message : ''
  const safeDetail = redact(detail, [account.accessToken]).slice(0, 300)
  return `Grok Bot refused the message${detail ? `: ${safeDetail}` : ''}`
}
export async function sendServerMessage(
  account: Account, appVersion: string | undefined, input: ServerMessage, deps: Dependencies
): Promise<{ delivery: 'accepted' | 'unknown' }> {
  const result = await call(account, appVersion, 'SendGrokBotUserMessage', {
    agentId: input.agentId,
    messageId: input.messageId,
    text: input.text,
    sentAtMs: String(Date.now())
  }, deps)
  if (result?.refusal != null || REFUSED.has(result?.delivery)) {
    throw failure('server_refused', refusalMessage(result?.refusal, account))
  }
  // Acceptance is not proof of a transcript entry id; do not return the nonce as one.
  return { delivery: ACCEPTED.has(result?.delivery) ? 'accepted' : 'unknown' }
}
export async function deleteServerBot(account: Account, appVersion: string | undefined, agentId: string, deps: Dependencies): Promise<void> {
  await call(account, appVersion, 'DeleteGrokBotAgent', { id: agentId }, deps)
}
