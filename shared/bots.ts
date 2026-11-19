/** A bot is a Hermes profile. `id` is the profile's name, which Hermes uses to address it. */
export type Bot = {
  id: string
  name: string
  model: string
  /** The last line of its Bot Chat, shortened. */
  preview: string
  /** When its Bot Chat last changed, in milliseconds; 0 when it has none yet. */
  lastActive: number
  /** A reply is being written now (known only for bots opened in this panel). */
  working: boolean
}

export type ChatMessage = {
  /** Stable across polls: the row's ID in Hermes, or a key for a row that has none. */
  id: string
  /** Milliseconds; 0 when Hermes recorded no time. */
  at: number
  role: 'user' | 'bot'
  kind: 'text' | 'activity' | 'notice'
  text: string
}

/** The reply being written: text so far and the tool running now. Not yet in the stored history. */
export type Live = { text: string; tool?: string; startedAt: number }

/**
 * One page of a Bot Chat, oldest first. `chat` names the conversation: when it changes (the chat
 * was archived or replaced in Hermes) what was shown before belongs to another one. Absent while
 * the bot has no Bot Chat. `older` fetches the page before; absent at the start. `live` is present
 * while the bot is replying.
 */
export type Thread = { chat?: string; messages: ChatMessage[]; older?: string; live?: Live }

export type Status = { state: 'running' | 'unavailable'; message: string; version?: string }

export const PAGE_SIZE = 60
export const MAX_PAGE_SIZE = 200
export const MAX_MESSAGE = 16000
/** A message longer than this is shown cut, with a note to open it in Hermes. */
export const MAX_SHOWN = 20000
export const BOT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/

const object = (v: unknown): Record<string, any> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {}
const ms = (seconds: unknown): number =>
  typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0

/** `sandbox-test` reads as "Sandbox Test"; the default profile is Hermes itself. */
export function botName(row: { name: string; display_name?: unknown; is_default?: unknown }): string {
  if (typeof row.display_name === 'string' && row.display_name.trim()) return row.display_name.trim().slice(0, 80)
  if (row.is_default === true || row.name === 'default') return 'Hermes'
  return row.name
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ')
}

/** The roster from Hermes' `profiles.list`. Paths and install IDs in the reply are left behind. */
export function botsView(raw: unknown, working: (id: string) => boolean = () => false): Bot[] {
  const rows = object(raw).profiles
  const bots: Bot[] = []
  for (const entry of Array.isArray(rows) ? rows : []) {
    const row = object(entry)
    if (typeof row.name !== 'string' || !BOT_ID.test(row.name)) continue
    const chat = object(row.canonical_session)
    bots.push({
      id: row.name,
      name: botName(row as { name: string }),
      model: typeof row.model === 'string' ? row.model.slice(0, 80) : '',
      preview: typeof chat.preview === 'string' ? chat.preview.replace(/\s+/g, ' ').trim().slice(0, 140) : '',
      lastActive: ms(chat.last_active),
      working: working(row.name)
    })
  }
  // Most recently active first; bots never talked to keep Hermes' own order after them.
  return bots
    .map((bot, index) => ({ bot, index }))
    .sort((a, b) => b.bot.lastActive - a.bot.lastActive || a.index - b.index)
    .map(({ bot }) => bot)
}

const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,60}$/

/**
 * A tool call as one line: the tool's name and nothing else. Hermes' preview beside it is built
 * from the call's arguments (a command, a path, a query), which stay in Hermes.
 */
export function toolLine(name: unknown): string {
  return `Used ${typeof name === 'string' && TOOL_NAME.test(name) ? name : 'a tool'}`
}

/**
 * Stored rows from Hermes' `session.transcript`, as chat messages. An assistant row with no text
 * is the call behind the tool row that follows it, so it is skipped; hidden rows stay hidden.
 */
export function rowsView(raw: unknown): ChatMessage[] {
  const rows = object(raw).rows
  const messages: ChatMessage[] = []
  let position = 0
  for (const entry of Array.isArray(rows) ? rows : []) {
    position++
    const row = object(entry)
    if (row.display_kind === 'hidden' || row.display_kind === 'failed_turn') continue
    const at = ms(row.timestamp)
    const id = Number.isInteger(row.row_id) ? `r${row.row_id}` : `t${typeof row.tool_call_id === 'string' ? row.tool_call_id.slice(0, 80) : `${at}-${position}`}`
    if (row.row_kind === 'compaction') {
      messages.push({ id, at, role: 'bot', kind: 'notice', text: 'Earlier messages were summarized here to save context.' })
      continue
    }
    if (row.role === 'tool') {
      messages.push({ id, at, role: 'bot', kind: 'activity', text: toolLine(row.name) })
      continue
    }
    if (row.role !== 'user' && row.role !== 'assistant') continue
    const text = typeof row.text === 'string' ? row.text : ''
    if (!text.trim()) continue
    messages.push({
      id,
      at,
      role: row.role === 'user' ? 'user' : 'bot',
      kind: 'text',
      text: text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN)}\n\n… Open the bot in Hermes for the rest.` : text
    })
  }
  return messages
}

/** Messages the panel already holds plus a newer or older page, without repeats, oldest first. */
export function mergeMessages(held: ChatMessage[], page: ChatMessage[], where: 'older' | 'newer'): ChatMessage[] {
  const known = new Set(held.map((m) => m.id))
  const fresh = page.filter((m) => !known.has(m.id))
  if (where === 'older') return [...fresh, ...held]
  // A newer page can restate a held row (its text finished); the page's copy wins.
  const restated = new Map(page.map((m) => [m.id, m]))
  return [...held.map((m) => restated.get(m.id) ?? m), ...fresh]
}

export function elapsed(since: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - since) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}
