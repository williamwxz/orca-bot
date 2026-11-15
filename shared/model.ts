// Pure data shapes and helpers shared by the worker and the panel. No Node or DOM APIs here.

export type Bot = {
  id: string
  name: string
  instructions: string
  avatarShape: string
  avatarColor: string
  serverRun: boolean
  hidden: boolean
  main: boolean
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

// Desktop bundle: Dn (FNV-1a), Nn/Pn (shape mixer), kn/An/Mn (colour PRNG).
const DEFAULT_SHAPES = ['blob', 'pebble', 'squircle', 'tablet', 'wedge', 'hex', 'cloud', 'teardrop']
const DEFAULT_COLORS = ['brown', 'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'violet', 'magenta', 'gray']

function avatarHash(id: string): number {
  let value = 2166136261
  for (let i = 0; i < id.length; i++) value = Math.imul(value ^ id.charCodeAt(i), 16777619)
  return value >>> 0
}

export function defaultAvatar(id: string): { shape: string; color: string } {
  const seed = avatarHash(id)
  let mixed = Math.imul(seed ^ seed >>> 16, 73244475)
  mixed = Math.imul(mixed ^ mixed >>> 13, 3266489909)
  const shape = DEFAULT_SHAPES[((mixed ^ mixed >>> 16) >>> 0) % DEFAULT_SHAPES.length]
  // The desktop's two version-1 XOR salts cancel before the first PRNG draw.
  const step = seed + 1831565813 | 0
  let random = Math.imul(step ^ step >>> 15, 1 | step)
  random = random + Math.imul(random ^ random >>> 7, 61 | random) ^ random
  const unit = ((random ^ random >>> 14) >>> 0) / 4294967296
  return { shape, color: DEFAULT_COLORS[Math.floor(unit * DEFAULT_COLORS.length)] }
}

/** The worker marks only the runtime-settings ID; names and roster roles are irrelevant. */
export function mainBot(bots: Bot[]): Bot | null {
  return bots.find(bot => bot.main) ?? null
}

/** Search applies to the header too; the main bot never repeats in ordinary rows. */
export function sidebarBots(bots: Bot[], query: string): { main: Bot | null; visible: Bot[]; hidden: Bot[] } {
  const matches = filterBots(bots, query)
  const main = mainBot(bots)
  return {
    main: main && matches.includes(main) ? main : null,
    visible: matches.filter(bot => bot !== main && !bot.hidden),
    hidden: matches.filter(bot => bot !== main && bot.hidden)
  }
}

export function filterBots(bots: Bot[], query: string): Bot[] {
  const term = query.trim().toLowerCase()
  return bots.filter(bot => bot.name.toLowerCase().includes(term))
}

// Original palette approximations; neutral UI surfaces still use Orca's theme.
export const AVATAR_COLORS: Record<string, string> = {
  black: '#17181a', brown: '#91603b', red: '#e92340', orange: '#f56b0b',
  yellow: '#ffc247', green: '#08ba70', cyan: '#0bb5a3', blue: '#157bdc',
  violet: '#8850e9', magenta: '#e82b88', gray: '#737780',
  teal: '#159b8d', pink: '#e82b88', purple: '#8850e9'
}
export function avatarHue(color: string): string {
  return Object.hasOwn(AVATAR_COLORS, color) ? AVATAR_COLORS[color] : AVATAR_COLORS.gray
}

/** Choose the higher-contrast foreground using WCAG relative luminance. */
export function readableAvatarText(color: string): string {
  const hex = avatarHue(color)
  const channels = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
  return (luminance + 0.05) / 0.05 > 1.05 / (luminance + 0.05) ? '#000000' : '#ffffff'
}

export function toBot(raw: unknown): Bot {
  const r = obj(raw)
  return {
    id: str(r.id) || str(r.agentId),
    name: str(r.name) || 'Untitled bot',
    instructions: str(r.description),
    avatarShape: str(r.avatarShape) || defaultAvatar(str(r.id) || str(r.agentId)).shape,
    avatarColor: str(r.avatarColor) || defaultAvatar(str(r.id) || str(r.agentId)).color,
    serverRun: r.harness === 'temporal',
    main: r.main === true,
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
