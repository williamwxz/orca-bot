import type { ChatMessage } from '../shared/chat.ts'
import { splitAttachments } from '../shared/attachments.ts'

export function threadPreview(messages: ChatMessage[]): string | undefined {
  const last = messages.findLast((message) => message.kind === 'text')
  if (!last) return undefined
  const { text, attachments } = splitAttachments(last.text)
  if (!attachments.length) return last.text.split(/\r?\n/, 1)[0].trim() || undefined
  const first = text.split(/\r?\n/, 1)[0].trim()
  if (first) return first
  return attachments.length === 1 ? `Sent ${attachments[0].name}` : `Sent ${attachments.length} files`
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
