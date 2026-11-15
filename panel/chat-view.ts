import type { Requests } from '../src/protocol.ts'
import type { Bot } from '../shared/roster.ts'
import { collapseActivities, refreshInterval, sendDraft } from '../shared/chat.ts'
import type { Thread, Composer } from '../shared/chat.ts'

export type FrameApi = {
  plugin: { request<K extends keyof Requests>(name: K, input: Requests[K]['input']): Promise<Requests[K]['output']> }
  shell?: { openExternal(url: string): Promise<unknown> }
}
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => {
  const el = document.createElement(tag)
  el.textContent = text
  return el
}
function button(label: string, click: () => void): HTMLButtonElement {
  const el = node('button', label)
  el.type = 'button'
  el.setAttribute('aria-label', label)
  el.addEventListener('click', click)
  return el
}
export function createChatView(root: HTMLElement, frame: FrameApi, avatar: (bot: Bot) => HTMLElement, open: (id: string) => void, back: () => void) {
  let bot: Bot | undefined
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let reading = false
  let identityKey = ''
  let thread: Thread = { messages: [], hasMore: false }
  const drafts = new Map<string, Composer>()
  let state: Composer = { draft: '', attempts: [], sending: false }
  const header = node('div'); header.className = 'thread-header'
  const identity = node('div'); identity.className = 'thread-identity'
  const full = button('Open full chat', () => { if (bot) open(bot.id) })
  full.textContent = '↗'; full.title = 'Open full chat'
  header.append(button('←', () => { close(); back() }), identity, full)
  header.firstElementChild!.setAttribute('aria-label', 'Back to bots')
  const list = node('div'); list.className = 'messages'; list.setAttribute('aria-label', 'Recent messages')
  const note = node('p'); note.className = 'thread-note'; note.setAttribute('role', 'status')
  const working = node('div'); working.className = 'working-line'
  const composer = node('form'); composer.className = 'composer'
  const label = node('label', 'Message'); label.htmlFor = 'quick-message'
  const input = node('textarea'); input.id = 'quick-message'; input.maxLength = 16000; input.rows = 3
  const send = node('button', 'Send'); send.type = 'submit'
  composer.append(label, input, send)
  root.append(header, list, note, working, composer)
  const atBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 40
  function linkedText(parent: HTMLElement, text: string): void {
    const pattern = /https?:\/\/[^\s<>]+/g
    let start = 0
    for (const match of text.matchAll(pattern)) {
      parent.append(document.createTextNode(text.slice(start, match.index)))
      const link = node('a', match[0]); link.href = match[0]
      link.addEventListener('click', (event) => {
        event.preventDefault()
        if (!frame.shell) { note.textContent = 'Open the full chat to use this link.'; return }
        void frame.shell.openExternal(match[0]).catch(() => { note.textContent = 'Could not open this link.' })
      })
      parent.append(link)
      start = match.index + match[0].length
    }
    parent.append(document.createTextNode(text.slice(start)))
  }
  function render(): void {
    if (!bot) return
    const bottom = atBottom(), top = list.scrollTop
    const nextIdentityKey = JSON.stringify([bot.id, bot.name, bot.modelLabel, bot.state, bot.avatar])
    if (identityKey !== nextIdentityKey) {
      identityKey = nextIdentityKey
      identity.replaceChildren(avatar(bot))
      const names = node('div'); names.append(node('strong', bot.name), node('small', bot.modelLabel)); identity.append(names)
      working.replaceChildren()
      if (bot.state === 'working') working.append(avatar(bot), node('span', `${bot.name} is working…`))
      working.hidden = bot.state !== 'working'
    }
    list.replaceChildren()
    if (thread.hasMore) list.append(node('p', 'Earlier messages are in the full chat.'))
    for (const message of collapseActivities(thread.messages)) {
      const item = node('div'); item.className = `chat-message ${message.kind} ${message.role}`
      if (message.kind === 'text') linkedText(item, message.text)
      else item.append(document.createTextNode(message.text))
      if (message.kind === 'unsupported') item.append(button('Open full chat', () => { if (bot) open(bot.id) }))
      list.append(item)
    }
    for (const attempt of state.attempts) {
      const item = node('div'); item.className = `chat-message text user ${attempt.state}`
      linkedText(item, attempt.text.length > 4000 ? attempt.text.slice(0, 4000) + '… Open the full chat for the rest.' : attempt.text)
      item.append(node('small', attempt.error ?? (attempt.state === 'pending' ? 'Sending…' : 'Sent — waiting for refresh')))
      list.append(item)
    }
    if (!thread.messages.length && !state.attempts.length) list.append(node('p', 'No recent messages.'))
    send.disabled = state.sending || !state.draft.trim() || state.draft.length > 16000
    if (input.value !== state.draft) input.value = state.draft
    list.scrollTop = bottom ? list.scrollHeight : top
  }
  function schedule(): void {
    clearTimeout(timer)
    if (bot && !document.hidden) timer = setTimeout(() => void read(), refreshInterval(bot.state, state.sending))
  }
  async function read(): Promise<void> {
    if (!bot || document.hidden || reading) return
    const id = bot.id, token = generation
    reading = true
    try {
      const next = await frame.plugin.request('thread.read', { botId: id, limit: 20 })
      if (token !== generation) return
      thread = next
      const matched = new Set<string>()
      state.attempts = state.attempts.filter((attempt) => {
        if (attempt.state !== 'sent') return true
        const text = attempt.text.length > 4000 ? attempt.text.slice(0, 4000) + '… Open the full chat for the rest.' : attempt.text
        const echo = next.messages.find((entry) => entry.role === 'user' && entry.kind === 'text' && entry.text === text && !attempt.baseline.has(entry.id) && !matched.has(entry.id))
        if (echo) matched.add(echo.id)
        return !echo
      })
      note.textContent = ''
      render()
    } catch {
      if (token === generation) { note.replaceChildren(document.createTextNode('Could not refresh messages. '), button('Open full chat', () => open(id))) }
    } finally {
      if (token === generation) { reading = false; schedule() }
    }
  }
  composer.addEventListener('submit', (event) => {
    event.preventDefault()
    if (!bot) return
    const id = bot.id, current = state
    void sendDraft(current, thread.messages.map((message) => message.id), (text) => frame.plugin.request('message.send', { botId: id, text }), () => {
      if (state === current && bot?.id === id) { render(); schedule() }
    }).then(() => { if (bot?.id === id) void read() })
  })
  input.addEventListener('input', () => { state.draft = input.value; send.disabled = state.sending || !state.draft.trim() || state.draft.length > 16000 })
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); composer.requestSubmit() }
  })
  function close(): void { generation++; bot = undefined; reading = false; clearTimeout(timer); root.hidden = true }
  document.addEventListener('visibilitychange', () => { clearTimeout(timer); if (!document.hidden) void read() })
  window.addEventListener('pagehide', () => clearTimeout(timer))
  window.addEventListener('pageshow', () => void read())
  return {
    open(next: Bot) {
      close(); bot = next; thread = { messages: [], hasMore: false }
      state = drafts.get(next.id) ?? { draft: '', attempts: [], sending: false }; drafts.set(next.id, state)
      root.hidden = false; note.textContent = 'Loading…'; render(); list.scrollTop = list.scrollHeight; input.focus(); void read()
    },
    update(next: Bot[]) {
      if (!bot) return
      const latest = next.find((item) => item.id === bot!.id && !item.addable)
      if (!latest) { close(); back(); return }
      const changed = latest.state !== bot.state
      bot = latest; render(); if (changed) schedule()
    }
  }
}
