import { randomUUID } from 'node:crypto'
import { createGateway, HermesError } from './hermes-gateway.ts'
import type { Gateway, GatewayEvent } from './hermes-gateway.ts'
import { BOT_ID, MAX_MESSAGE, MAX_PAGE_SIZE, PAGE_SIZE, botsView, rowsView, toolLine } from '../shared/bots.ts'
import type { Bot, Live, Status, Thread } from '../shared/bots.ts'

/** Hermes' Bot Mode keeps one conversation per bot, found by this exact title on the bot's profile. */
export const BOT_CHAT = 'Bot Chat'
const DEFAULT_PROFILE = 'default'
const CURSOR = /^[\x21-\x7e]{1,2000}$/

export type HermesDeps = { gateway: Gateway; now(): number; id(): string; wait(ms: number, done: (value?: unknown) => void): void }
export const defaultHermesDeps = (): HermesDeps => ({ gateway: createGateway(), now: Date.now, id: randomUUID, wait: (ms, done) => void setTimeout(done, ms) })
/** How long a bot's model and preview are reused before asking its connection again. */
const DETAIL_AGE = 8000
const COLD_WAIT = 4000
const MAX_BOTS = 60

type Chat = {
  /** The stored conversation's ID: what history is read by. */
  stored: string
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
  const lives = new Map<string, Live & { bot: string }>()
  const details = new Map<string, { row: any; at: number }>()
  const refreshing = new Map<string, Promise<void>>()
  function refreshDetail(bot: string): Promise<void> {
    let running = refreshing.get(bot)
    if (running) return running
    running = (async () => {
      try {
        const reply = await gateway.request(bot, 'profiles.list', { include_sessions: true })
        const row = (Array.isArray(reply?.profiles) ? reply.profiles : []).find((r: any) => r?.name === bot)
        if (!row) return
        details.set(bot, { row, at: deps.now() })
        const id = row.canonical_session?.id
        // A new Bot Chat (the old one was archived in Hermes) replaces the one held here.
        if (typeof id === 'string' && id && chats.get(bot)?.stored !== id) chats.set(bot, { stored: id })
      } catch {
        /* Keep the last known detail; the next list tries again. */
      } finally {
        refreshing.delete(bot)
      }
    })()
    refreshing.set(bot, running)
    return running
  }

  const botOf = (sessionId: string) => [...chats].find(([, chat]) => chat.live === sessionId || chat.stored === sessionId)?.[0]
  gateway.onEvent((profile, event: GatewayEvent) => {
    const bot = botOf(event.sessionId)
    if (!bot || bot !== profile) return
    const key = bot
    if (event.type === 'message.start') lives.set(key, { bot, text: '', startedAt: deps.now() })
    else if (event.type === 'message.complete' || event.type === 'error') lives.delete(key)
    else {
      const live = lives.get(key)
      if (!live) return
      if (event.type === 'message.delta' && typeof event.payload.text === 'string') live.text = (live.text + event.payload.text).slice(-MAX_MESSAGE)
      else if (event.type === 'tool.start') live.tool = toolLine(event.payload.name, event.payload.context)
      else if (event.type === 'tool.complete') live.tool = undefined
    }
  })
  /** A connection that dropped can no longer say a reply ended: forget what it was streaming. */
  const settle = (bot: string) => {
    if (gateway.connected(bot)) return
    lives.delete(bot)
    const chat = chats.get(bot)
    if (chat) chat.live = undefined
  }

  const known = (botId: unknown): string => {
    if (typeof botId !== 'string' || !BOT_ID.test(botId)) throw new Error('Unknown bot.')
    return botId
  }

  /** The bot's Bot Chat, looked up by its exact title. A failed lookup never reads as "none". */
  async function findChat(bot: string): Promise<Chat | undefined> {
    const held = chats.get(bot)
    if (held) return held
    const reply = await gateway.request(bot, 'session.list', { profile: bot, title: BOT_CHAT, limit: 5, include_hidden: true })
    if (!Array.isArray(reply?.sessions)) throw new Error('Could not check this bot’s chat in Hermes. Try again.')
    const row = reply.sessions.find((s: any) => typeof s?.id === 'string' && s.id && s.archived !== true)
    if (!row) return undefined
    const chat: Chat = { stored: row.id }
    chats.set(bot, chat)
    return chat
  }

  /** Attaches to the chat so its events arrive and prompts can be sent; picks up a reply in progress. */
  function attach(bot: string, chat: Chat): Promise<string> {
    settle(bot)
    if (chat.live) return Promise.resolve(chat.live)
    chat.attaching ??= (async () => {
      try {
        const reply = await gateway.request(bot, 'session.resume', { profile: bot, session_id: chat.stored, source: 'gui', omit_messages: true }, 30000)
        if (typeof reply?.session_id !== 'string' || !reply.session_id) throw new Error('Hermes could not open this chat. Try again.')
        chat.live = reply.session_id
        if (reply.running === true && !lives.has(bot)) {
          const text = typeof reply.inflight?.assistant === 'string' ? reply.inflight.assistant : ''
          lives.set(bot, { bot, text: text.slice(-MAX_MESSAGE), startedAt: typeof reply.turn_started_at === 'number' ? Math.round(reply.turn_started_at * 1000) : deps.now() })
        }
        return chat.live!
      } finally {
        chat.attaching = undefined
      }
    })()
    return chat.attaching
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
        if (held && deps.now() - held.at < DETAIL_AGE) continue
        const refresh = refreshDetail(row.name)
        if (!held) cold.push(refresh)
      }
      // A bot whose connection is slow to open shows without its preview for now, never blocks the list.
      if (cold.length) await Promise.race([Promise.all(cold), new Promise((resolve) => deps.wait(COLD_WAIT, resolve))])
      for (const bot of [...lives.keys()]) settle(bot)
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
        session_id: chat.stored,
        order: 'latest',
        limit,
        ...(typeof input.older === 'string' ? { cursor: input.older } : {})
      })
      const live = input.older === undefined ? lives.get(bot) : undefined
      return {
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
      let chat = await findChat(bot)
      if (!chat) {
        const created = await gateway.request(bot, 'session.create', { profile: bot, title: BOT_CHAT, hidden: true, follow_profile_config: true, source: 'gui', request_id: deps.id() }, 30000)
        if (typeof created?.stored_session_id !== 'string' || typeof created?.session_id !== 'string') throw new Error('Hermes could not start this chat. Try again.')
        chat = { stored: created.stored_session_id, live: created.session_id }
        chats.set(bot, chat)
      }
      const live = await attach(bot, chat)
      try {
        await gateway.request(bot, 'prompt.submit', { session_id: live, profile: bot, text, input_id: deps.id() }, 30000)
      } catch (error) {
        if (error instanceof HermesError && error.code === 'refused') throw new Error('Hermes did not take this message. Check the bot in Hermes, then try again.')
        throw error
      }
      if (!lives.has(bot)) lives.set(bot, { bot, text: '', startedAt: deps.now() })
      return { ok: true }
    },

    close: () => gateway.close()
  }
}

export type Hermes = ReturnType<typeof createHermes>
