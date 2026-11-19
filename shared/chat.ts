import type { Bot } from './roster.ts'
import { composeMessage } from './attachments.ts'
import type { Attachment } from './attachments.ts'

export type ChatMessage = {
  id: string
  at: number
  role: 'user' | 'bot'
  kind: 'text' | 'activity' | 'unsupported'
  text: string
}
export type Thread = { messages: ChatMessage[]; hasMore: boolean }
export const refreshInterval = (state: Bot['state'], sending: boolean): number =>
  state === 'working' || sending ? 2000 : 6000

export function parseThread(value: unknown): Thread {
  const raw = value as { messages?: unknown; hasMore?: unknown }
  if (!Array.isArray(raw?.messages)) throw new Error('Invalid messages')
  const messages: ChatMessage[] = []
  for (const entry of [...raw.messages].sort((a, b) => (Number(a?.at) || 0) - (Number(b?.at) || 0))) {
    if (entry?.kind === 'digest') continue
    const base = {
      id: String(entry?.id ?? messages.length),
      at: Number(entry?.at) || 0,
      role: entry?.role === 'user' ? ('user' as const) : ('bot' as const)
    }
    if (entry?.kind === 'text' && typeof entry.text === 'string') {
      messages.push({ ...base, kind: 'text', text: entry.text })
    } else if (entry?.kind === 'activity') {
      const short =
        typeof entry.tool?.name === 'string'
          ? entry.tool.name
              .split(/[./:]/)
              .pop()
              ?.replace(/[^a-zA-Z0-9_-]/g, '')
              .slice(0, 60)
          : ''
      messages.push({ ...base, kind: 'activity', text: short ? `Used a tool: ${short}` : 'Used a tool' })
    } else messages.push({ ...base, kind: 'unsupported', text: 'This needs the full chat.' })
  }
  return { messages, hasMore: raw.hasMore === true }
}

export function collapseActivities(messages: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = []
  for (let i = 0; i < messages.length; i++) {
    const entry = messages[i]
    if (entry.kind !== 'activity') {
      result.push(entry)
      continue
    }
    let count = 1
    while (messages[i + count]?.kind === 'activity') count++
    result.push(count === 1 ? entry : { ...entry, text: `Used ${count} tools` })
    i += count - 1
  }
  return result
}

/** text is what was sent, attachment tags included; draft is what the person typed. */
export type Attempt = {
  text: string
  state: 'pending' | 'sent' | 'failed'
  error?: string
  sentAt: number
  draft?: string
  attachments?: Attachment[]
}
export type Composer = {
  draft: string
  attempts: Attempt[]
  sending: boolean
  matchedIds?: Set<string>
  wait?: { since: number; sentAt: number; baseline: Set<string> }
  sendFailed?: boolean
}
export async function sendDraft(
  state: Composer,
  baseline: string[],
  send: (text: string) => Promise<unknown>,
  changed: () => void,
  now: () => number = Date.now,
  attachments: Attachment[] = []
): Promise<void> {
  if (state.sending || (!state.draft.trim() && !attachments.length)) return
  const text = composeMessage(state.draft, attachments)
  if (text.length > 16000) return
  const attempt: Attempt = {
    text,
    state: 'pending',
    sentAt: now(),
    ...(attachments.length ? { draft: state.draft, attachments } : {})
  }
  state.attempts.push(attempt)
  state.draft = ''
  state.sending = true
  changed()
  try {
    await send(attempt.text)
    attempt.state = 'sent'
    state.sendFailed = false
    state.wait = { since: state.wait?.since ?? now(), sentAt: attempt.sentAt, baseline: new Set(baseline) }
  } catch (error) {
    attempt.state = 'failed'
    state.sendFailed = true
    state.wait = undefined
    attempt.error =
      error instanceof Error ? error.message : 'Could not send. Check the full chat before trying again.'
    const typed = attempt.draft ?? attempt.text
    state.draft = typed + (state.draft && typed ? '\n' : '') + state.draft
  } finally {
    state.sending = false
    changed()
  }
}

// Persist consumed IDs across refreshes so one echo cannot remove two identical sends.
export function reconcileAttempts(
  attempts: Attempt[],
  messages: ChatMessage[],
  consumed: ReadonlySet<string> = new Set()
): { attempts: Attempt[]; matchedIds: Set<string> } {
  const matchedIds = new Set(consumed)
  const remaining = attempts.filter((attempt) => {
    if (attempt.state === 'failed') return true
    const echo = messages.find(
      (entry) =>
        entry.role === 'user' &&
        entry.kind === 'text' &&
        entry.text === attempt.text &&
        entry.at >= attempt.sentAt - 5000 &&
        !matchedIds.has(entry.id)
    )
    if (!echo) return true
    matchedIds.add(echo.id)
    return false
  })
  return { attempts: remaining, matchedIds }
}

export function elapsedTime(since: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - since) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}
export const displayText = (text: string): string =>
  text.length > 4000 ? text.slice(0, 4000) + '… Open the full chat for the rest.' : text
