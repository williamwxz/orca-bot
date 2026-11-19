import { createToast } from './toast.ts'
import { createChatView } from './chat-view.ts'
import type { FrameApi } from './chat-view.ts'
import type { Bot } from '../shared/bots.ts'
import type { Hosts } from '../worker/paired-host.ts'

const frame = (globalThis as unknown as { orca: FrameApi }).orca
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const message = element<HTMLParagraphElement>('message')
const retry = element<HTMLButtonElement>('retry')
const running = element<HTMLElement>('running')
const roster = element<HTMLElement>('roster')
const hostSelect = element<HTMLSelectElement>('host')
const toast = createToast(element('toast'))
const LOCAL = 'local'
const wide = () => window.innerWidth >= 720

let bots: Bot[] = []
let hosts: Hosts | undefined
let chatting: string | undefined
/** Rises when the bot host changes: replies asked of the previous host are dropped. */
let hostGeneration = 0
let timer: ReturnType<typeof setTimeout> | undefined
let refreshing = false

/** A drawn avatar: the bot's initial on a colour picked from its name. */
export function avatar(bot: Pick<Bot, 'id' | 'name' | 'working'>): HTMLElement {
  const el = document.createElement('span')
  el.className = `avatar avatar-${bot.working ? 'working' : 'idle'} drawn`
  let hash = 0
  for (const char of bot.id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  el.style.background = `hsl(${hash % 360} 55% 45%)`
  el.style.color = '#fff'
  el.textContent = (bot.name.trim()[0] ?? '?').toUpperCase()
  el.setAttribute('aria-hidden', 'true')
  return el
}

function when(at: number, now = Date.now()): string {
  if (!at) return ''
  const minutes = Math.floor((now - at) / 60000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`
  return `${Math.floor(minutes / 1440)}d`
}

const chatView = createChatView(element('bot-view'), frame, avatar, {
  back: () => showBot(undefined),
  notify: toast.show,
  hostGeneration: () => hostGeneration
})

function showBot(bot: Bot | undefined): void {
  chatting = bot?.id
  if (bot) chatView.open(bot)
  else chatView.close()
  element('sidebar').hidden = !!bot && !wide()
  renderBots()
}

function renderBots(): void {
  const focused = (document.activeElement as HTMLElement | null)?.dataset?.focus
  roster.replaceChildren(
    ...bots.map((bot) => {
      const row = document.createElement('div')
      row.className = `bot-row${chatting === bot.id ? ' selected' : ''}`
      const chat = document.createElement('button')
      chat.type = 'button'
      chat.className = 'bot-chat'
      chat.dataset.focus = bot.id
      chat.setAttribute('aria-label', `Open ${bot.name}'s chat`)
      const copy = document.createElement('span')
      copy.className = 'bot-copy'
      const heading = document.createElement('span')
      heading.className = 'bot-heading'
      const name = document.createElement('span')
      name.className = 'bot-name'
      name.textContent = bot.name
      heading.append(name)
      const line = document.createElement('span')
      line.className = 'model'
      line.textContent = bot.working ? 'Working…' : bot.preview || bot.model || 'No messages yet'
      copy.append(heading, line)
      chat.append(avatar(bot), copy)
      chat.addEventListener('click', () => showBot(bot))
      const state = document.createElement('span')
      state.className = 'state'
      state.textContent = when(bot.lastActive)
      row.append(chat, state)
      return row
    })
  )
  if (!bots.length) {
    const empty = document.createElement('p')
    empty.className = 'empty'
    empty.textContent = 'No bots yet. Create a profile in Hermes and it appears here.'
    roster.append(empty)
  }
  if (focused) (roster.querySelector(`[data-focus="${focused}"]`) as HTMLElement | null)?.focus()
}

function renderHosts(): void {
  const choices = [{ id: LOCAL, name: 'This computer' }, ...(hosts?.hosts ?? [])]
  // The picker only matters once an Orca server is paired, or when the saved choice is one that
  // is no longer there (an unpaired server) and another has to be chosen.
  const chosen = choices.some((host) => host.id === hosts?.selected)
  hostSelect.hidden = choices.length < 2 && (!hosts || chosen)
  hostSelect.replaceChildren(
    ...(chosen ? [] : [new Option('Choose where your bots run…', '', true, true)]),
    ...choices.map((host) => new Option(host.name, host.id, false, host.id === hosts?.selected))
  )
}

async function refresh(retrying = false): Promise<void> {
  if (refreshing) return
  refreshing = true
  clearTimeout(timer)
  const generation = hostGeneration
  try {
    hosts ??= await frame.plugin.request('hosts.get', {})
    if (generation !== hostGeneration) return
    renderHosts()
    // No choice yet, or the chosen server is no longer paired: nothing is asked of any host.
    if (!hosts.selected || hosts.message) {
      if (chatting) showBot(undefined)
      bots = []
      message.hidden = false
      message.textContent = hosts.message || 'Choose where your bots run.'
      running.hidden = true
      retry.hidden = !hosts.message.includes('Retry')
      return
    }
    const status = await frame.plugin.request('status', retrying ? { retry: true } : {})
    if (generation !== hostGeneration) return
    if (status.state !== 'running') {
      message.hidden = false
      message.textContent = status.message || 'Could not reach Hermes.'
      running.hidden = true
      retry.hidden = false
      bots = []
      // Back to the list, sidebar and all: closing only the chat would leave a narrow panel empty.
      showBot(undefined)
      return
    }
    const next = await frame.plugin.request('bots.list', {})
    if (generation !== hostGeneration) return
    bots = next
    message.hidden = true
    retry.hidden = true
    running.hidden = false
    renderBots()
    const open = bots.find((bot) => bot.id === chatting)
    if (open) chatView.update(open)
    else if (chatting) showBot(undefined)
  } catch (error) {
    if (generation !== hostGeneration) return
    message.hidden = false
    message.textContent = error instanceof Error ? error.message : 'Could not load the bots.'
    retry.hidden = false
  } finally {
    refreshing = false
    if (!document.hidden) timer = setTimeout(() => void refresh(), bots.some((bot) => bot.working) ? 2000 : 5000)
  }
}

hostSelect.addEventListener('change', async () => {
  const id = hostSelect.value
  if (!id) return
  hostGeneration++
  bots = []
  chatting = undefined
  chatView.close()
  element('sidebar').hidden = false
  running.hidden = true
  message.hidden = false
  message.textContent = 'Connecting to Hermes…'
  try {
    hosts = await frame.plugin.request('hosts.select', { id })
  } catch (error) {
    toast.show(error instanceof Error ? error.message : 'Could not change where bots run.')
    hosts = undefined
  }
  refreshing = false
  void refresh(true)
})
retry.addEventListener('click', () => {
  hosts = undefined
  void refresh(true)
})
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void refresh()
  else clearTimeout(timer)
})
window.addEventListener('resize', () => {
  element('sidebar').hidden = !!chatting && !wide()
})
void refresh()
