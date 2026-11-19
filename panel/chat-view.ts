import type { Requests } from '../worker/protocol.ts'
import { MAX_MESSAGE, elapsed, mergeMessages } from '../shared/bots.ts'
import type { Bot, ChatMessage, Live } from '../shared/bots.ts'

export type FrameApi = {
  plugin: {
    request<K extends keyof Requests>(name: K, input: Requests[K]['input']): Promise<Requests[K]['output']>
  }
  shell?: { openExternal(url: string): Promise<unknown> }
}
export type ChatHooks = {
  back(): void
  notify(text: string): void
  /** Rises when the bot host changes; a reply asked before it is dropped. */
  hostGeneration(): number
  /** The chosen host's stable ID: drafts follow it, so returning to a host finds its drafts. */
  hostKey(): string
}

/** Messages fetched on each poll; enough to cover what a turn adds between two polls. */
const POLL_ROWS = 40
/** Messages fetched when a chat opens and for each "earlier" page. */
const PAGE_ROWS = 80

const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = '') => {
  const el = document.createElement(tag)
  el.textContent = text
  if (cls) el.className = cls
  return el
}

export function dayLabel(at: number, previous: number | undefined, now = Date.now()): string | undefined {
  if (!at) return undefined
  const day = new Date(at)
  if (previous && new Date(previous).toDateString() === day.toDateString()) return undefined
  const today = new Date(now)
  if (day.toDateString() === today.toDateString()) return 'Today'
  if (day.toDateString() === new Date(now - 86400000).toDateString()) return 'Yesterday'
  return day.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', ...(day.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }) })
}

/**
 * One bot's Bot Chat: the newest messages on open, earlier ones a page at a time, the reply as it
 * is written, and a composer. It polls, so it works the same over a paired server's relay.
 */
export function createChatView(root: HTMLElement, frame: FrameApi, avatar: (bot: Bot) => HTMLElement, hooks: ChatHooks) {
  let bot: Bot | undefined
  let generation = 0
  let messages: ChatMessage[] = []
  let older: string | undefined
  /** The conversation shown: when the worker names another, everything held belongs to the old one. */
  let chatId: string | undefined
  let live: Live | undefined
  let loaded = false
  let loadingOlder = false
  let sending = false
  /** Sent from here and not yet in the stored history: shown at once, dropped when its row arrives. */
  let pending: { text: string; at: number; before: Set<string> }[] = []
  /** Stored rows already taken as the copy of a sent message: each acknowledges one send only. */
  const acknowledged = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let clock: ReturnType<typeof setTimeout> | undefined
  /** Unsent text per bot on one host: the same profile name on another host is another bot. */
  const drafts = new Map<string, string>()
  const draftKey = (id: string) => `${hooks.hostKey()}:${id}`
  const rendered = new Map<string, { element: HTMLElement; text: string }>()
  let renderedIds: string[] = []

  const header = node('div', '', 'thread-header')
  const backButton = node('button', '←', 'thread-back')
  backButton.type = 'button'
  backButton.setAttribute('aria-label', 'Back to bots')
  backButton.addEventListener('click', () => hooks.back())
  const identity = node('div', '', 'thread-identity')
  header.append(backButton, identity)
  const list = node('div', '', 'messages')
  list.setAttribute('aria-label', 'Messages')
  const earlier = node('button', 'Show earlier messages', 'thread-earlier')
  earlier.type = 'button'
  earlier.addEventListener('click', () => void loadOlder())
  const rows = node('div', '', 'thread-rows')
  const liveRow = node('div', '', 'chat-message text bot live')
  const note = node('p', '', 'thread-note')
  note.setAttribute('role', 'status')
  const working = node('div', '', 'working-line')
  working.hidden = true
  const composer = node('form', '', 'composer')
  const input = node('textarea')
  input.id = 'quick-message'
  input.rows = 3
  input.maxLength = MAX_MESSAGE
  const label = node('label', 'Message')
  label.htmlFor = 'quick-message'
  const send = node('button', '↑')
  send.type = 'submit'
  send.setAttribute('aria-label', 'Send')
  send.title = 'Send'
  const box = node('div', '', 'composer-box')
  box.append(input)
  composer.append(label, box, send)
  list.append(earlier, rows, liveRow)
  root.append(header, list, note, working, composer)

  const atBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 60
  const current = (token: number, host: number) => token === generation && host === hooks.hostGeneration()

  function body(parent: HTMLElement, text: string): void {
    const pattern = /https?:\/\/[^\s<>)\]]+/g
    let start = 0
    for (const match of text.matchAll(pattern)) {
      parent.append(document.createTextNode(text.slice(start, match.index)))
      const link = node('a', match[0])
      link.href = match[0]
      link.addEventListener('click', (event) => {
        event.preventDefault()
        void frame.shell?.openExternal(match[0])
      })
      parent.append(link)
      start = match.index + match[0].length
    }
    parent.append(document.createTextNode(text.slice(start)))
  }

  function row(message: ChatMessage): HTMLElement {
    const el = node('div', '', `chat-message ${message.kind} ${message.role}`)
    if (message.kind === 'text') body(el, message.text)
    else el.textContent = message.text
    return el
  }

  /** Draws what changed: new rows are added in place, so a long history is never rebuilt on a poll. */
  function render(): void {
    if (!bot) return
    const stick = atBottom()
    const before = list.scrollHeight
    const top = list.scrollTop
    const shown = [...messages, ...pending.map((p, i) => ({ id: `pending-${p.at}-${i}`, at: p.at, role: 'user' as const, kind: 'text' as const, text: p.text }))]
    const ids = shown.map((m) => m.id)
    const appended = ids.length >= renderedIds.length && renderedIds.every((id, i) => ids[i] === id)
    const prepended = !appended && ids.length >= renderedIds.length && renderedIds.every((id, i) => ids[ids.length - renderedIds.length + i] === id)
    if (!appended && !prepended) {
      rows.replaceChildren()
      rendered.clear()
    }
    const fragment = document.createDocumentFragment()
    const fresh = appended ? shown.slice(renderedIds.length) : prepended ? shown.slice(0, ids.length - renderedIds.length) : shown
    let previousAt = appended && renderedIds.length ? shown[renderedIds.length - 1]?.at : undefined
    for (const message of fresh) {
      const stamp = dayLabel(message.at, previousAt)
      if (stamp) {
        const separator = node('time', '', 'day-separator')
        separator.setAttribute('data-label', stamp)
        separator.setAttribute('aria-label', stamp)
        fragment.append(separator)
      }
      previousAt = message.at || previousAt
      const el = row(message)
      rendered.set(message.id, { element: el, text: message.text })
      fragment.append(el)
    }
    if (prepended) rows.prepend(fragment)
    else rows.append(fragment)
    // A stored row whose text changed since it was drawn (a reply that finished) is redrawn alone.
    for (const message of shown) {
      const held = rendered.get(message.id)
      if (held && held.text !== message.text) {
        const el = row(message)
        held.element.replaceWith(el)
        rendered.set(message.id, { element: el, text: message.text })
      }
    }
    renderedIds = ids
    earlier.hidden = !older
    earlier.disabled = loadingOlder
    earlier.textContent = loadingOlder ? 'Loading…' : 'Show earlier messages'
    liveRow.hidden = !live?.text
    if (live?.text) {
      liveRow.replaceChildren()
      body(liveRow, live.text)
    }
    note.textContent = loaded && !shown.length && !live ? 'No messages yet. Say hello.' : loaded ? '' : 'Loading…'
    renderWorking()
    send.disabled = sending || !input.value.trim()
    if (prepended) list.scrollTop = top + (list.scrollHeight - before)
    else if (stick) list.scrollTop = list.scrollHeight
    else list.scrollTop = top
  }

  function renderWorking(): void {
    clearTimeout(clock)
    working.hidden = !live || !bot
    if (!live || !bot) return
    const text = `${live.tool ?? 'Working'} · ${elapsed(live.startedAt, Date.now())}`
    working.replaceChildren(avatar({ ...bot, working: true }), node('span', text))
    clock = setTimeout(renderWorking, 1000)
  }

  /** The chat (generation) whose read is in flight. A read for an older chat never blocks a new one. */
  let reading: number | undefined
  let readAgain = false
  /** Asks for a read. One runs at a time per chat and only it sets the next poll; a request made meanwhile runs right after. */
  function read(): void {
    if (reading === generation) {
      readAgain = true
      return
    }
    void readOnce()
  }
  /** Drops everything shown for the previous conversation of this bot. */
  function forget(): void {
    messages = []
    older = undefined
    pending = []
    acknowledged.clear()
    rendered.clear()
    renderedIds = []
    rows.replaceChildren()
  }
  async function readOnce(): Promise<void> {
    clearTimeout(timer)
    const target = bot
    if (!target || document.hidden) return
    const token = generation
    const host = hooks.hostGeneration()
    reading = token
    readAgain = false
    try {
      const thread = await frame.plugin.request('thread.read', { botId: target.id, limit: loaded ? POLL_ROWS : PAGE_ROWS })
      if (current(token, host)) {
        // Archived or replaced in Hermes: the old history and any unacknowledged sends go with it.
        // A first chat appearing replaces nothing: a first send waiting for it keeps its place.
        if (loaded && chatId !== undefined && thread.chat !== chatId) {
          forget()
          loaded = false
        }
        chatId = thread.chat
        if (!loaded) {
          messages = thread.messages
          older = thread.older
          loaded = true
        } else {
          const known = new Set(messages.map((m) => m.id))
          // Nothing held yet (a first chat just appeared), or a poll that shares no row with what is
          // held missed some in between: start from this page and its cursor. Pending sends stay.
          if (!messages.length || (thread.messages.length && !thread.messages.some((m) => known.has(m.id)))) {
            messages = thread.messages
            older = thread.older
          } else messages = mergeMessages(messages, thread.messages, 'newer')
        }
        live = thread.live
        // A sent message leaves "pending" once a stored row that was not there when it was sent carries
        // its text. One row acknowledges one send, so sending the same text twice waits for two rows.
        pending = pending.filter((p) => {
          const row = thread.messages.find((m) => m.role === 'user' && !p.before.has(m.id) && !acknowledged.has(m.id) && m.text.trim() === p.text.trim())
          if (row) acknowledged.add(row.id)
          return !row
        })
        note.textContent = ''
        render()
      }
    } catch (error) {
      if (current(token, host)) note.textContent = error instanceof Error ? error.message : 'Could not load messages.'
    }
    // A read for a chat that is no longer open ends quietly: the open chat runs its own loop.
    if (reading === token) reading = undefined
    if (!current(token, host)) return
    if (readAgain) return void readOnce()
    if (!document.hidden) timer = setTimeout(read, live || sending || pending.length ? 1200 : 5000)
  }

  async function loadOlder(): Promise<void> {
    const target = bot
    if (!target || !older || loadingOlder) return
    const token = generation
    const host = hooks.hostGeneration()
    loadingOlder = true
    render()
    try {
      const page = await frame.plugin.request('thread.read', { botId: target.id, older, limit: PAGE_ROWS })
      if (!current(token, host)) return
      // A page from a conversation that has since been replaced is not this one's history.
      if (page.chat === chatId) {
        messages = mergeMessages(messages, page.messages, 'older')
        older = page.older
      }
    } catch (error) {
      if (!current(token, host)) return
      hooks.notify(error instanceof Error ? error.message : 'Could not load earlier messages.')
    }
    loadingOlder = false
    render()
  }

  composer.addEventListener('submit', async (event) => {
    event.preventDefault()
    const target = bot
    const text = input.value.trim()
    if (!target || !text || sending) return
    const token = generation
    const host = hooks.hostGeneration()
    sending = true
    const entry = { text, at: Date.now(), before: new Set(messages.filter((m) => m.role === 'user').map((m) => m.id)) }
    pending.push(entry)
    input.value = ''
    drafts.delete(draftKey(target.id))
    render()
    list.scrollTop = list.scrollHeight
    try {
      await frame.plugin.request('message.send', { botId: target.id, text })
    } catch (error) {
      if (!current(token, host)) return
      // Nothing was sent: the text goes back into the composer, never resent on its own.
      pending = pending.filter((p) => p !== entry)
      if (!input.value) input.value = text
      hooks.notify(error instanceof Error ? error.message : 'Could not send. Try again.')
    }
    if (!current(token, host)) return
    sending = false
    render()
    read()
  })
  input.addEventListener('input', () => {
    if (bot) drafts.set(draftKey(bot.id), input.value)
    send.disabled = sending || !input.value.trim()
  })
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault()
      composer.requestSubmit()
    }
  })
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) read()
    else clearTimeout(timer)
  })

  function close(): void {
    generation++
    clearTimeout(timer)
    clearTimeout(clock)
    readAgain = false
    bot = undefined
    root.hidden = true
  }

  return {
    close,
    open(next: Bot): void {
      close()
      bot = next
      forget()
      chatId = undefined
      live = undefined
      loaded = false
      loadingOlder = false
      sending = false
      identity.replaceChildren(avatar(next))
      const names = node('div')
      names.append(node('strong', next.name), node('small', next.model))
      identity.append(names)
      input.value = drafts.get(draftKey(next.id)) ?? ''
      input.placeholder = `Message ${next.name}`
      root.hidden = false
      render()
      read()
    },
    /** A fresh roster row for the open bot: its name or model may have changed in Hermes. */
    update(next: Bot): void {
      if (bot?.id !== next.id) return
      const wasWorking = bot.working
      bot = next
      // The roster saw the bot start working before this chat's own poll did: look now.
      if (next.working && !wasWorking && !live) read()
    }
  }
}
