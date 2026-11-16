import type { ChatMessage } from '../shared/chat.ts'

export function threadPreview(messages: ChatMessage[]): string | undefined {
  const last = messages.findLast((message) => message.kind === 'text')
  return last?.text.split(/\r?\n/, 1)[0].trim() || undefined
}

export function dayLabel(at: number, previous: number | undefined, now = Date.now()): string | undefined {
  if (!Number.isFinite(at) || at <= 0) return undefined
  const date = new Date(at)
  // Out-of-range timestamps make an invalid date, whose ISO form throws.
  if (Number.isNaN(date.getTime())) return undefined
  if (previous && date.toDateString() === new Date(previous).toDateString()) return undefined
  const day =
    date.toDateString() === new Date(now).toDateString()
      ? 'Today'
      : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  return `${day} ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
}
