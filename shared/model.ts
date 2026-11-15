// Pure data shapes and helpers shared by the worker and the panel. No Node or DOM APIs here.

export type Bot = {
  id: string
  name: string
  instructions: string
  avatarShape: string
  avatarColor: string
  serverRun: boolean
  hidden: boolean
}

export type Entry = {
  id: string
  ts: number
  role: 'user' | 'bot' | 'event'
  type: 'text' | 'widget' | 'form' | 'email' | 'file' | 'event' | 'other'
  text: string
  streaming?: boolean
  widget?: { options: { label: string; value: string }[]; responded?: string }
  email?: { to: string; subject: string }
  routine?: { id: string; name: string; action: string }
}

/** Compare server timestamps to the transcript baseline, and local time only to the timeout. */
export function waitingState(entries: Entry[], newestTsAtSend: number, startedAt: number, now: number): 'working' | 'slow' | 'done' {
  if (entries.some(entry => entry.role === 'bot' && entry.ts > newestTsAtSend && !entry.streaming)) return 'done'
  return now - startedAt >= 180_000 ? 'slow' : 'working'
}

export type Routine = { id: string; name: string; lastAction: string; ts: number }

const MAX_TEXT = 20_000

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(part => str(part) || str(obj(part).text) || str(obj(part).content)).filter(Boolean).join('\n')
  return str(obj(value).text) || str(obj(value).content)
}

const FALLBACK_COLORS = ['teal', 'blue', 'violet', 'pink', 'red', 'orange', 'yellow']

function hash(text: string): number {
  let value = 0
  for (const char of text) value = (value * 31 + char.charCodeAt(0)) >>> 0
  return value
}

export function toBot(raw: unknown): Bot {
  const r = obj(raw)
  return {
    id: str(r.id) || str(r.agentId),
    name: str(r.name) || 'Untitled bot',
    instructions: str(r.description),
    avatarShape: str(r.avatarShape) || 'square',
    // Grok Bot leaves the colour unset for many bots: pick a stable one from the id instead.
    avatarColor: str(r.avatarColor) || FALLBACK_COLORS[hash(str(r.id) || str(r.agentId)) % FALLBACK_COLORS.length],
    serverRun: r.harness === 'temporal',
    hidden: Boolean(r.isHiddenFromSidebar ?? r.hiddenFromSidebar)
  }
}

/** One transcript entry, reduced to what the panel draws. */
export function toEntry(raw: unknown): Entry {
  const r = obj(raw)
  const base = { id: str(r.id), ts: typeof r.timestampMs === 'number' ? r.timestampMs : 0 }
  const clip = (text: string) => (text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '\n…' : text)

  if (r.kind === 'message') {
    return {
      ...base,
      role: r.role === 'user' ? 'user' : 'bot',
      type: 'text',
      text: clip(str(r.text) || str(r.prompt) || str(r.message) || contentText(r.content) || contentText(obj(r.message).content) || str(r.preview)),
      streaming: r.isStreaming === true
    }
  }

  if (r.kind === 'event') {
    const event = obj(r.event)
    if (event.type === 'automation-changed') {
      const routine = {
        id: str(event.automationId),
        name: str(event.automationName) || str(event.automationId),
        action: str(event.action)
      }
      return {
        ...base,
        role: 'event',
        type: 'event',
        text: `Routine ${routine.action}: ${routine.name}`,
        routine
      }
    }
    return { ...base, role: 'event', type: 'event', text: str(event.type) || 'Event' }
  }

  if (r.kind === 'send-message') {
    const message = obj(r.message)
    switch (message.type) {
      case 'text':
        return { ...base, role: 'bot', type: 'text', text: clip(contentText(message.content)) }
      case 'widget': {
        const widget = obj(message.widget)
        const options = Array.isArray(widget.options) ? widget.options : []
        return {
          ...base,
          role: 'bot',
          type: 'widget',
          text: str(widget.prompt),
          widget: {
            options: options
              .map((option) => ({ label: str(obj(option).label), value: str(obj(option).value) }))
              .filter((option) => option.label && option.value),
            responded: typeof r.respondedValue === 'string' ? r.respondedValue : undefined
          }
        }
      }
      case 'user-form':
        return {
          ...base,
          role: 'bot',
          type: 'form',
          text: str(obj(message.formRequest).title) || 'The bot asked for input'
        }
      case 'email-draft': {
        const draft = obj(message.draft)
        return {
          ...base,
          role: 'bot',
          type: 'email',
          text: clip(str(draft.body)),
          email: {
            to: Array.isArray(draft.to) ? draft.to.map(str).join(', ') : '',
            subject: str(draft.subject)
          }
        }
      }
      case 'attachment':
        return {
          ...base,
          role: 'bot',
          type: 'file',
          text: str(message.file_name) || str(message.alt) || 'Attachment'
        }
      default:
        return { ...base, role: 'bot', type: 'other', text: str(message.type) || 'Message' }
    }
  }

  return { ...base, role: 'event', type: 'other', text: str(r.kind) || 'Entry' }
}

/** The routines a thread mentions, newest state first. Deleted ones are dropped. */
export function routinesFrom(entries: Entry[]): Routine[] {
  const byId = new Map<string, Routine>()
  for (const entry of entries) {
    if (!entry.routine) continue
    byId.set(entry.routine.id, {
      id: entry.routine.id,
      name: entry.routine.name,
      lastAction: entry.routine.action,
      ts: entry.ts
    })
  }
  return [...byId.values()]
    .filter((routine) => !/^(deleted|removed)$/.test(routine.lastAction))
    .sort((a, b) => b.ts - a.ts)
}

export type ScheduleRequest = { name: string; task: string; when: string; timeZone: string }

/** Grok Bot creates routines from chat, so scheduling is a clearly worded message to the bot. */
export function scheduleMessage({ name, task, when, timeZone }: ScheduleRequest): string {
  return [
    'Please create a scheduled routine.',
    `Name: ${name.trim()}`,
    `When: ${when.trim()} (time zone: ${timeZone})`,
    `Task: ${task.trim()}`,
    'Confirm once it is scheduled.'
  ].join('\n')
}

export function removeRoutineMessage(name: string): string {
  return `Please delete the scheduled routine "${name}" and confirm once it is removed.`
}
