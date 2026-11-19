import { randomUUID } from 'node:crypto'
import { createGateway, HermesError } from './hermes-gateway.ts'
import type { Gateway, GatewayEvent } from './hermes-gateway.ts'
import { BOT_ID, MAX_MESSAGE, MAX_PAGE_SIZE, PAGE_SIZE, botsView, rowsView, toolLine } from '../shared/bots.ts'
import type { Bot, Live, Status, Thread } from '../shared/bots.ts'

/** Hermes' Bot Mode keeps one conversation per bot, found by this exact title on the bot's profile. */
export const BOT_CHAT = 'Bot Chat'
const DEFAULT_PROFILE = 'default'
const CURSOR = /^[\x21-\x7e]{1,2000}$/
/** How long a bot's model and preview are reused before asking its connection again. */
const DETAIL_AGE = 8000
/** The same for a bot that is not replying: asking opens a connection, so it is done less often. */
const QUIET_DETAIL_AGE = 60000
const COLD_WAIT = 4000
const MAX_BOTS = 60
/** Bots asked for their details at once; the rest wait their turn. */
const REFRESH_AT_ONCE = 4

export type HermesDeps = { gateway: Gateway; now(): number; id(): string; wait(ms: number, done: (value?: unknown) => void): void }
export const defaultHermesDeps = (): HermesDeps => ({ gateway: createGateway(), now: Date.now, id: randomUUID, wait: (ms, done) => void setTimeout(done, ms) })

type Chat = {
  /** The Bot Chat's identity in Hermes' registry: it stays the same when the chat is compacted. */
  registry: string
  /** The conversation to read and resume: the newest segment after a compaction, else the same ID. */
  resolved: string
  /** The ID Hermes runs it under once attached: what prompts are sent to and events arrive for. */
  live?: string
  attaching?: Promise<string>
}

/**
 * The bots of the Hermes install on this machine: the roster, each bot's Bot Chat (the same
 * conversation Hermes Desktop shows), and sending to it. Everything else stays in Hermes.
 */
export function createHermes(deps: HermesDeps = defaultHermesDeps()) {
  const { gateway } = deps
  const chats = new Map<string, Chat>()
  const lives = new Map<string, Live>()
  const details = new Map<string, { row: any; at: number }>()
  const refreshing = new Map<string, Promise<void>>()
  const creating = new Map<string, Promise<Chat>>()
  let refreshSlots = REFRESH_AT_ONCE
  const refreshQueue: (() => void)[] = []

  /** A reply is being written: its connection must stay open until it ends. */
  const begin = (bot: string, live: Live) => {
    lives.set(bot, live)
    gateway.hold(bot)
  }
  const end = (bot: string) => {
    lives.delete(bot)
    gateway.release(bot)
  }

  gateway.onEvent((profile, event: GatewayEvent) => {
    const chat = chats.get(profile)
    // Only the attached Bot Chat's own events count; another session on the profile is not this chat.
    if (!chat?.live || event.sessionId !== chat.live) return
    if (event.type === 'message.start') begin(profile, { text: '', startedAt: deps.now() })
    else if (event.type === 'message.complete' || event.type === 'error') end(profile)
    else {
      const live = lives.get(profile)
      if (!live) return
      if (event.type === 'message.delta' && typeof event.payload.text === 'string') live.text = (live.text + event.payload.text).slice(-MAX_MESSAGE)
      else if (event.type === 'tool.start') live.tool = toolLine(event.payload.name)
      else if (event.type === 'tool.complete') live.tool = undefined
    }
  })
  // The socket that carried a chat's events is gone: it can no longer say a reply ended, and its
  // live ID means nothing on the next socket. Forget both, even if a new connection opens at once.
  gateway.onDrop((profile) => {
    lives.delete(profile)
    gateway.release(profile)
    const chat = chats.get(profile)
    if (chat) chat.live = undefined
  })

  const known = (botId: unknown): string => {
    if (typeof botId !== 'string' || !BOT_ID.test(botId)) throw new Error('Unknown bot.')
    return botId
  }
  const chatOf = (row: any): Pick<Chat, 'registry' | 'resolved'> | undefined =>
    typeof row?.id === 'string' && row.id ? { registry: row.id, resolved: typeof row.resolved_id === 'string' && row.resolved_id ? row.resolved_id : row.id } : undefined

  /** Takes what Hermes' registry says about a bot's chat: the same one, a new one, or none. */
  function adopt(bot: string, found: Pick<Chat, 'registry' | 'resolved'> | undefined): Chat | undefined {
    const held = chats.get(bot)
    if (!found) {
      // Archived or deleted in Hermes: nothing here may keep reading or sending to the old one.
      if (held) {
        chats.delete(bot)
        end(bot)
      }
      return undefined
    }
    if (held?.registry === found.registry && held.resolved === found.resolved) return held
    // A different chat, or the same one compacted onto a new segment: attach again from scratch.
    const chat: Chat = { ...found }
    chats.set(bot, chat)
    end(bot)
    return chat
  }

  /** The bot's Bot Chat from the registry, by its exact title. A failed lookup never reads as "none". */
  async function lookup(bot: string): Promise<Chat | undefined> {
    const reply = await gateway.request(bot, 'session.list', { profile: bot, title: BOT_CHAT, limit: 5, include_hidden: true })
    if (!Array.isArray(reply?.sessions)) throw new Error('Could not check this bot’s chat in Hermes. Try again.')
    return adopt(bot, chatOf(reply.sessions.find((s: any) => typeof s?.id === 'string' && s.id && s.archived !== true)))
  }
  const findChat = async (bot: string): Promise<Chat | undefined> => chats.get(bot) ?? lookup(bot)

  /**
   * Creates the Bot Chat, once per bot however many sends ask at the same moment. The title is
   * written at once, as Hermes Desktop does: until it is, the registry has no Bot Chat and anyone
   * else would create a second. If the title write fails, the registry decides who won.
   */
  function create(bot: string): Promise<Chat> {
    let running = creating.get(bot)
    if (running) return running
    running = (async () => {
      try {
        const existing = await lookup(bot)
        if (existing) return existing
        const created = await gateway.request(bot, 'session.create', { profile: bot, title: BOT_CHAT, hidden: true, follow_profile_config: true, source: 'gui', request_id: deps.id() }, 30000)
        if (typeof created?.stored_session_id !== 'string' || typeof created?.session_id !== 'string') throw new Error('Hermes could not start this chat. Try again.')
        try {
          await gateway.request(bot, 'session.title', { session_id: created.session_id, title: BOT_CHAT })
        } catch {
          // Someone else took the title in between (Hermes Desktop, another bot): theirs is the Bot Chat.
          // An older Hermes without this call has no winner, and the first prompt stores ours.
          const winner = await lookup(bot)
          if (winner && winner.registry !== created.stored_session_id) return winner
        }
        const chat: Chat = { registry: created.stored_session_id, resolved: created.stored_session_id, live: created.session_id }
        chats.set(bot, chat)
        return chat
      } finally {
        creating.delete(bot)
      }
    })()
    creating.set(bot, running)
    return running
  }

  /** Attaches to the chat so its events arrive and prompts can be sent; picks up a reply in progress. */
  function attach(bot: string, chat: Chat): Promise<string> {
    if (chat.live) return Promise.resolve(chat.live)
    chat.attaching ??= (async () => {
      try {
        const reply = await gateway.request(bot, 'session.resume', { profile: bot, session_id: chat.resolved, source: 'gui', omit_messages: true }, 30000)
        if (typeof reply?.session_id !== 'string' || !reply.session_id) throw new Error('Hermes could not open this chat. Try again.')
        // The chat was replaced while this was in flight: its attachment belongs to nobody.
        if (chats.get(bot) !== chat) throw new Error('This chat changed in Hermes. Try again.')
        chat.live = reply.session_id
        if (reply.running === true && !lives.has(bot)) {
          const text = typeof reply.inflight?.assistant === 'string' ? reply.inflight.assistant : ''
          begin(bot, { text: text.slice(-MAX_MESSAGE), startedAt: typeof reply.turn_started_at === 'number' ? Math.round(reply.turn_started_at * 1000) : deps.now() })
        }
        return chat.live!
      } finally {
        chat.attaching = undefined
      }
    })()
    return chat.attaching
  }

  /** Asks a bot's own connection for its model and Bot Chat, a few bots at a time. */
  function refreshDetail(bot: string): Promise<void> {
    let running = refreshing.get(bot)
    if (running) return running
    running = (async () => {
      if (refreshSlots > 0) refreshSlots--
      else await new Promise<void>((resolve) => refreshQueue.push(resolve))
      try {
        const reply = await gateway.request(bot, 'profiles.list', { include_sessions: true })
        const row = (Array.isArray(reply?.profiles) ? reply.profiles : []).find((r: any) => r?.name === bot)
        if (!row) return
        details.set(bot, { row, at: deps.now() })
        adopt(bot, chatOf(row.canonical_session))
      } catch {
        /* Keep the last known detail; the next list tries again. */
      } finally {
        refreshing.delete(bot)
        const next = refreshQueue.shift()
        if (next) next()
        else refreshSlots++
      }
    })()
    refreshing.set(bot, running)
    return running
  }

  return {
    async status(): Promise<Status> {
      try {
        const reply = await gateway.request(DEFAULT_PROFILE, 'profiles.list', {})
        if (!Array.isArray(reply?.profiles)) throw new HermesError('not_running', 'Hermes answered in a form this plugin does not know. Update Hermes or the plugin.')
        return { state: 'running', message: '' }
      } catch (error) {
        return { state: 'unavailable', message: error instanceof HermesError ? error.message : 'Could not reach Hermes. Press Retry.' }
      }
    },

    /**
     * The roster. The default profile names every bot; only a bot's own connection knows its model
     * and Bot Chat, so each is asked there: awaited the first time, refreshed in the background after.
     */
    async listBots(): Promise<Bot[]> {
      const reply = await gateway.request(DEFAULT_PROFILE, 'profiles.list', { include_sessions: false })
      const rows: any[] = (Array.isArray(reply?.profiles) ? reply.profiles : []).filter((row: any) => typeof row?.name === 'string' && BOT_ID.test(row.name)).slice(0, MAX_BOTS)
      const names = new Set(rows.map((row) => row.name))
      for (const bot of [...details.keys()]) if (!names.has(bot)) details.delete(bot)
      const cold: Promise<void>[] = []
      for (const row of rows) {
        const held = details.get(row.name)
        // A bot writing a reply is asked often; any other only now and then, since asking opens a connection.
        const age = lives.has(row.name) ? DETAIL_AGE : QUIET_DETAIL_AGE
        if (held && deps.now() - held.at < age) continue
        const refresh = refreshDetail(row.name)
        if (!held) cold.push(refresh)
      }
      // A bot whose connection is slow to open shows without its preview for now, never blocks the list.
      if (cold.length) await Promise.race([Promise.all(cold), new Promise((resolve) => deps.wait(COLD_WAIT, resolve))])
      return botsView({ profiles: rows.map((row) => details.get(row.name)?.row ?? row) }, (id) => lives.has(id))
    },

    /** One page of the bot's Bot Chat: the newest without `older`, the page before with it. */
    async readThread(input: { botId: unknown; older?: unknown; limit?: unknown }): Promise<Thread> {
      const bot = known(input?.botId)
      if (input.older !== undefined && (typeof input.older !== 'string' || !CURSOR.test(input.older))) throw new Error('Reopen this chat.')
      const limit = Number.isInteger(input.limit) ? Math.min(MAX_PAGE_SIZE, Math.max(1, input.limit as number)) : PAGE_SIZE
      const chat = await findChat(bot)
      if (!chat) return { messages: [] }
      // Attaching is what lets the panel show a reply while it is written; history does not need it.
      if (input.older === undefined) await attach(bot, chat).catch(() => undefined)
      const reply = await gateway.request(bot, 'session.transcript', {
        profile: bot,
        session_id: chat.resolved,
        order: 'latest',
        limit,
        ...(typeof input.older === 'string' ? { cursor: input.older } : {})
      })
      const live = input.older === undefined && chats.get(bot) === chat ? lives.get(bot) : undefined
      return {
        chat: chat.registry,
        messages: rowsView(reply),
        ...(typeof reply?.next_cursor === 'string' && CURSOR.test(reply.next_cursor) ? { older: reply.next_cursor } : {}),
        ...(live ? { live: { text: live.text, startedAt: live.startedAt, ...(live.tool ? { tool: live.tool } : {}) } } : {})
      }
    },

    /** Sends to the bot's Bot Chat, creating it (hidden, following the profile's model) on first use. */
    async send(input: { botId: unknown; text: unknown }): Promise<{ ok: true }> {
      const bot = known(input?.botId)
      const text = typeof input.text === 'string' ? input.text.trim() : ''
      if (!text) throw new Error('Type a message first.')
      if (text.length > MAX_MESSAGE) throw new Error(`Keep a message under ${MAX_MESSAGE.toLocaleString('en-US')} characters.`)
      const chat = (await findChat(bot)) ?? (await create(bot))
      const live = await attach(bot, chat)
      try {
        await gateway.request(bot, 'prompt.submit', { session_id: live, profile: bot, text, input_id: deps.id() }, 30000)
      } catch (error) {
        if (error instanceof HermesError && error.code === 'refused') throw new Error('Hermes did not take this message. Check the bot in Hermes, then try again.')
        throw error
      }
      if (chats.get(bot) === chat && !lives.has(bot)) begin(bot, { text: '', startedAt: deps.now() })
      return { ok: true }
    },

    close: () => gateway.close()
  }
}

export type Hermes = ReturnType<typeof createHermes>
