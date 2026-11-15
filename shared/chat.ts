import type { Bot } from './roster.ts'

export type ChatMessage = { id: string; at: number; role: 'user' | 'bot'; kind: 'text' | 'activity' | 'unsupported'; text: string }
export type Thread = { messages: ChatMessage[]; hasMore: boolean }
export const refreshInterval = (state: Bot['state'], sending: boolean): number => state === 'working' || sending ? 2000 : 6000

export function parseThread(value: unknown): Thread {
  const raw = value as { messages?: unknown; hasMore?: unknown }
  if (!Array.isArray(raw?.messages)) throw new Error('Invalid messages')
  const messages: ChatMessage[] = []
  for (const entry of [...raw.messages].sort((a, b) => (Number(a?.at) || 0) - (Number(b?.at) || 0))) {
    if (entry?.kind === 'digest') continue
    const base = { id: String(entry?.id ?? messages.length), at: Number(entry?.at) || 0, role: entry?.role === 'user' ? 'user' as const : 'bot' as const }
    if (entry?.kind === 'text' && typeof entry.text === 'string') {
      messages.push({ ...base, kind: 'text', text: entry.text.length > 4000 ? entry.text.slice(0, 4000) + '… Open the full chat for the rest.' : entry.text })
    } else if (entry?.kind === 'activity') {
      const short = typeof entry.tool?.name === 'string' ? entry.tool.name.split(/[./:]/).pop()?.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60) : ''
      messages.push({ ...base, kind: 'activity', text: short ? `Used a tool: ${short}` : 'Used a tool' })
    } else messages.push({ ...base, kind: 'unsupported', text: 'This needs the full chat.' })
  }
  return { messages, hasMore: raw.hasMore === true }
}

export function collapseActivities(messages: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = []
  for (let i = 0; i < messages.length; i++) {
    const entry = messages[i]
    if (entry.kind !== 'activity') { result.push(entry); continue }
    let count = 1
    while (messages[i + count]?.kind === 'activity') count++
    result.push(count === 1 ? entry : { ...entry, text: `Used ${count} tools` })
    i += count - 1
  }
  return result
}

export type Attempt = { text: string; state: 'pending' | 'sent' | 'failed'; error?: string; baseline: Set<string> }
export type Composer = { draft: string; attempts: Attempt[]; sending: boolean }
export async function sendDraft(state: Composer, baseline: string[], send: (text: string) => Promise<unknown>, changed: () => void): Promise<void> {
  if (state.sending || !state.draft.trim() || state.draft.length > 16000) return
  const attempt: Attempt = { text: state.draft, state: 'pending', baseline: new Set(baseline) }
  state.attempts.push(attempt)
  state.draft = ''
  state.sending = true
  changed()
  try {
    await send(attempt.text)
    attempt.state = 'sent'
  } catch (error) {
    attempt.state = 'failed'
    attempt.error = error instanceof Error ? error.message : 'Could not send. Check the full chat before trying again.'
    state.draft = attempt.text + (state.draft ? '\n' + state.draft : '')
  } finally {
    state.sending = false
    changed()
  }
}
