import { backendHeaders, redact, request, type Account, type Dependencies } from './gateway'

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
async function call(account: Account, appVersion: string | undefined, method: string, body: unknown, deps: Dependencies) {
  const read = method === 'ListGrokBotAgents'
  try {
    return await request(
      `https://api2.cursor.sh/aiserver.v1.GrokBotService/${method}`,
      backendHeaders(account, appVersion), body, method, deps, [account.accessToken], 'backend'
    )
  } catch (error) {
    const e = error as any
    if (e.connectCode === 'unimplemented') {
      throw failure('unsupported_version', 'This version of Grok Bot is not supported yet')
    }
    if (['unauthenticated', 'permission_denied'].includes(e.connectCode)) {
      throw read
        ? failure('not_signed_in', 'Open the Grok Bot app and sign in, then retry.')
        : failure('server_refused', `Grok Bot refused the request: ${e.message}`)
    }
    if (method === 'DeleteGrokBotAgent' && e.connectCode === 'not_found') return {}
    if (!read && (e.status >= 500 ||
        ['timeout', 'connection_failed', 'response_too_large', 'unsupported_version'].includes(e.code) ||
        ['deadline_exceeded', 'unavailable', 'internal', 'unknown', 'data_loss'].includes(e.connectCode))) {
      throw unknownOutcome()
    }
    throw error
  }
}
export async function listServerBots(account: Account, appVersion: string | undefined, deps: Dependencies): Promise<ServerBot[]> {
  const result = await call(account, appVersion, 'ListGrokBotAgents', {}, deps)
  if (!Array.isArray(result?.agents)) {
    throw failure('unsupported_version', 'This version of Grok Bot is not supported yet')
  }
  return result.agents.filter((row: any) => row && typeof row.agentId === 'string' &&
    typeof row.id === 'string' && typeof row.harness === 'string')
    .map((row: any) => ({ agentId: row.agentId, id: row.id, harness: row.harness }))
}
// Accept the enum's short names and protobuf-JSON prefixed names; unknown values stay unknown.
const ACCEPTED = new Set<unknown>([
  1, 2, 3, 'ACCEPTED_BOX', 'ACCEPTED_TEMPORAL', 'DUPLICATE',
  'GROK_BOT_USER_MESSAGE_DELIVERY_ACCEPTED_BOX',
  'GROK_BOT_USER_MESSAGE_DELIVERY_ACCEPTED_TEMPORAL',
  'GROK_BOT_USER_MESSAGE_DELIVERY_DUPLICATE'
])
export async function sendServerMessage(
  account: Account, appVersion: string | undefined, input: ServerMessage, deps: Dependencies
): Promise<{ delivery: 'accepted' | 'unknown' }> {
  const result = await call(account, appVersion, 'SendGrokBotUserMessage', {
    agentId: input.agentId,
    messageId: input.messageId,
    text: input.text,
    sentAtMs: String(Date.now())
  }, deps)
  if (result?.refusal != null || [4, 'REFUSED', 'GROK_BOT_USER_MESSAGE_DELIVERY_REFUSED'].includes(result?.delivery)) {
    const detail = typeof result?.refusal?.message === 'string' ? result.refusal.message : ''
    throw failure('server_refused', `Grok Bot refused the message${detail ? `: ${redact(detail, [account.accessToken]).slice(0, 300)}` : ''}`)
  }
  // Acceptance is not proof of a transcript entry id; do not return the nonce as one.
  return { delivery: ACCEPTED.has(result?.delivery) ? 'accepted' : 'unknown' }
}
export async function deleteServerBot(account: Account, appVersion: string | undefined, agentId: string, deps: Dependencies): Promise<void> {
  await call(account, appVersion, 'DeleteGrokBotAgent', { id: agentId }, deps)
}
