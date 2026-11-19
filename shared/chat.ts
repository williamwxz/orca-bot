import type { Bot } from './roster.ts'
import { splitAttachments } from './attachments.ts'
import type { SentFile, Uploaded } from './attachments.ts'

export type ChatMessage = {
  id: string
  at: number
  role: 'user' | 'bot'
  kind: 'text' | 'activity' | 'notice' | 'unsupported'
  text: string
  /** Files sent with the message, by name. Their server paths are removed before this leaves the worker. */
  attachments?: SentFile[]
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
      // Attachment tags hold the server's file paths: keep the names, drop the tags.
      const { text, attachments } = splitAttachments(entry.text)
      messages.push(
        attachments.length
          ? { ...base, kind: 'text', text, attachments }
          : { ...base, kind: 'text', text: entry.text }
      )
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
    } else {
      const notice = settledNotice(entry)
      messages.push(
        notice
          ? { ...base, kind: 'notice', text: notice }
          : { ...base, kind: 'unsupported', text: 'This needs the full chat.' }
      )
    }
  }
  return { messages, hasMore: raw.hasMore === true }
}

/**
 * A card that asks nothing and is already settled, such as "Skill … enabled" after a bot
 * learns a skill, reads as one line. A card that still needs an answer stays in the full chat.
 */
function settledNotice(entry: { kind?: unknown; card?: unknown }): string | undefined {
  if (entry?.kind !== 'options') return undefined
  const card = entry.card as { title?: unknown; subtitle?: unknown; options?: unknown; answered?: unknown }
  if (!card || typeof card !== 'object') return undefined
  if (!Array.isArray(card.options) || card.options.length || typeof card.answered !== 'string') return undefined
  if (typeof card.title !== 'string' || !card.title.trim()) return undefined
  const detail = typeof card.subtitle === 'string' ? card.subtitle.split('\n')[0].trim() : ''
  return [card.title.trim(), detail].filter(Boolean).join(' \u2014 ').slice(0, 300)
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

export type Attempt = {
  text: string
  state: 'pending' | 'sent' | 'failed'
  error?: string
  sentAt: number
  attachments?: Uploaded[]
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
  send: (text: string, attachments: string[]) => Promise<unknown>,
  changed: () => void,
  now: () => number = Date.now,
  attachments: Uploaded[] = []
): Promise<void> {
  if (state.sending || (!state.draft.trim() && !attachments.length) || state.draft.length > 16000) return
  // With files the server stores the trimmed text, so the pending copy matches its echo.
  const attempt: Attempt = attachments.length
    ? { text: state.draft.trim(), state: 'pending', sentAt: now(), attachments }
    : { text: state.draft, state: 'pending', sentAt: now() }
  state.attempts.push(attempt)
  state.draft = ''
  state.sending = true
  changed()
  try {
    await send(attempt.text, attachments.map((file) => file.id))
    attempt.state = 'sent'
    state.sendFailed = false
    state.wait = { since: state.wait?.since ?? now(), sentAt: attempt.sentAt, baseline: new Set(baseline) }
  } catch (error) {
    attempt.state = 'failed'
    state.sendFailed = true
    state.wait = undefined
    attempt.error =
      error instanceof Error ? error.message : 'Could not send. Check the full chat before trying again.'
    state.draft = attempt.text + (state.draft && attempt.text ? '\n' : '') + state.draft
  } finally {
    state.sending = false
    changed()
  }
}

const sameFiles = (a: SentFile[] = [], b: SentFile[] = []): boolean =>
  a.length === b.length && a.every((file, i) => file.kind === b[i].kind && file.name === b[i].name)

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
        sameFiles(entry.attachments, attempt.attachments) &&
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
