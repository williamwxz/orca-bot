import { createSetup, agentNames } from './setup.ts'
import { createChatView } from './chat-view.ts'
import type { FrameApi } from './chat-view.ts'
import type { Bot } from '../shared/roster.ts'
import { avatarSvg } from '../shared/appearance.ts'

const frame = (globalThis as unknown as { orca: FrameApi }).orca
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const message = element<HTMLParagraphElement>('message')
const retry = element<HTMLButtonElement>('retry')
const running = element<HTMLElement>('running')
const roster = element<HTMLElement>('roster')
const refreshNote = element<HTMLElement>('refresh-note')
const result = element<HTMLElement>('result')
const setup = createSetup(
  (answer) => frame.plugin.request('setup.answer', answer),
  () => frame.plugin.request('tools.import', {})
)
const shareTools = element<HTMLInputElement>('share-tools')
const importTools = element<HTMLInputElement>('import-tools')
const linkAgents = element<HTMLInputElement>('link-agents')
function renderSetup(): void {
  const state = setup.state
  element('setup').hidden = element('list-header').hidden || !state.loaded || state.answered
  element('link-agents-label').hidden = !agentNames(state.agents)
  element('agent-names').textContent = agentNames(state.agents)
  element('import-tools-label').hidden = state.tools.length === 0
  element('import-tools-copy').textContent =
    `Adds ${state.tools.length} ${state.tools.length === 1 ? 'tool' : 'tools'} from ${[...new Set(state.tools.map((t) => t.source))].join(', ')} to OpenMausBot, switched off. Turn them on per bot in the Bot Dashboard. Tokens saved in those apps are copied to OpenMausBot on this computer.`
  element('setup-message').textContent = state.message
  for (const id of ['setup-allow', 'setup-skip']) element<HTMLButtonElement>(id).disabled = state.busy
  importTools.disabled = shareTools.disabled = linkAgents.disabled = state.busy
}
async function answerSetup(allow: boolean): Promise<void> {
  setup.state.importTools = importTools.checked
  setup.state.shareTools = shareTools.checked
  setup.state.linkAgents = linkAgents.checked
  const applying = setup.answer(allow)
  renderSetup()
  await applying
  if (setup.state.answered && setup.state.message) result.textContent = setup.state.message
  renderSetup()
  await refreshAfterChange()
}
element('setup-allow').addEventListener('click', () => void answerSetup(true))
element('setup-skip').addEventListener('click', () => void answerSetup(false))
element('open-page').addEventListener('click', () => void open())
let timer: ReturnType<typeof setTimeout> | undefined
let refreshPending: Promise<void> | undefined
let opening = false
let selected: string | undefined
let bots: Bot[] = []
let rosterKey = ''
const changing = new Set<string>()
const readBots = new Set<string>()
const previews = new Map<string, string>()
const rosterView = element<HTMLElement>('roster-view')
const chatView = createChatView(
  element('bot-view'),
  frame,
  makeAvatar,
  (id) => void open(id),
  () => {
    rosterView.hidden = false
    element('list-header').hidden = false
    renderSetup()
    renderBots()
  },
  (id, preview) => {
    if (preview) previews.set(id, preview)
    else previews.delete(id)
  }
)
function showBot(bot: Bot): void {
  readBots.add(bot.id)
  rosterView.hidden = true
  element('list-header').hidden = true
  renderSetup()
  chatView.open(bot)
  renderBots()
}
function makeAvatar(bot: Bot): HTMLElement {
  const avatar = document.createElement('span')
  avatar.className = `avatar avatar-${bot.state} ${bot.avatar ? 'picture' : 'drawn'}`
  if (bot.avatar) {
    const img = document.createElement('img')
    img.src = bot.avatar
    img.alt = ''
    avatar.append(img)
  } else avatar.innerHTML = avatarSvg(bot.id)
  if (bot.state === 'waiting') {
    const badge = document.createElement('span')
    badge.className = 'clock-badge'
    badge.setAttribute('aria-label', 'Waiting')
    badge.append(icon('clock'))
    avatar.append(badge)
  }
  if (bot.state === 'working') {
    const label = document.createElement('span')
    label.className = 'motion-label'
    label.textContent = 'Working'
    avatar.append(label)
  }
  return avatar
}
const icons = {
  plus: '<path d="M8 3v10M3 8h10"/>',
  crown: '<path d="M3 12 1.5 5l4 2L8 3l2.5 4 4-2-1.5 7Z"/><path d="M3 14h10"/>',
  clock: '<circle cx="8" cy="8" r="5.5"/><path d="M8 4.5V8l2.5 1.5"/>'
}
function icon(kind: keyof typeof icons): SVGElement {
  const span = document.createElement('span')
  span.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[kind]}</svg>`
  return span.firstElementChild as SVGElement
}
async function open(botId?: string): Promise<void> {
  if (opening) return
  opening = true
  element<HTMLButtonElement>('open-page').disabled = true
  selected = botId
  renderBots()
  result.textContent = 'Opening…'
  try {
    result.textContent = (await frame.plugin.request('chat.open', botId ? { botId } : {})).message
  } catch (error) {
    result.textContent = error instanceof Error ? error.message : 'Could not open chat.'
  } finally {
    opening = false
    element<HTMLButtonElement>('open-page').disabled = false
    renderBots()
  }
}

async function addMausBot(bot: Bot): Promise<void> {
  if (changing.has(bot.id)) return
  changing.add(bot.id)
  renderBots()
  try {
    await frame.plugin.request('bots.addMausBot', { botId: bot.id })
    await refreshAfterChange()
    await open(bot.id)
  } catch (error) {
    result.textContent = error instanceof Error ? error.message : 'Could not add MausBot.'
  } finally {
    changing.delete(bot.id)
    renderBots()
  }
}

function renderBots(): void {
  const key = JSON.stringify([bots, selected, opening, [...changing], [...readBots], [...previews]])
  if (key === rosterKey) return
  rosterKey = key
  const focused = (document.activeElement as HTMLElement)?.dataset.focus
  roster.replaceChildren()
  if (!bots.some((bot) => !bot.addable)) {
    const empty = document.createElement('p')
    empty.className = 'empty'
    empty.textContent = 'No bots yet.'
    roster.append(empty)
    const openButton = document.createElement('button')
    openButton.type = 'button'
    openButton.textContent = 'Jump to Bot Dashboard'
    openButton.disabled = opening
    openButton.addEventListener('click', () => void open())
    roster.append(openButton)
  }
  for (const bot of bots) {
    if (bot.addable) {
      const add = document.createElement('button')
      add.className = 'add-mausbot'
      add.type = 'button'
      add.append(icon('plus'), document.createTextNode('Add MausBot'))
      add.disabled = changing.has(bot.id)
      add.addEventListener('click', () => void addMausBot(bot))
      roster.append(add)
      continue
    }
    const row = document.createElement('div')
    row.className = `bot-row${selected === bot.id ? ' selected' : ''}`
    const chat = document.createElement('button')
    chat.type = 'button'
    chat.className = 'bot-chat'
    chat.dataset.focus = `${bot.id}-chat`
    chat.disabled = opening
    chat.title = bot.title || `Open ${bot.name}'s chat`
    chat.setAttribute('aria-label', `Open ${bot.name}'s chat`)
    const avatar = makeAvatar(bot)
    const name = document.createElement('span')
    name.className = 'bot-name'
    name.textContent = bot.name
    const copy = document.createElement('span')
    copy.className = 'bot-copy'
    const heading = document.createElement('span')
    heading.className = 'bot-heading'
    heading.append(name)
    copy.append(heading)
    chat.append(avatar, copy)
    if (bot.main) {
      const main = document.createElement('span')
      main.className = 'main-badge'
      main.append(icon('crown'), document.createTextNode('Chief of Staff'))
      heading.append(main)
    }
    chat.addEventListener('click', () => showBot(bot))
    row.addEventListener('click', (event) => {
      if (!(event.target as Element).closest('button')) showBot(bot)
    })
    const model = document.createElement('span')
    model.className = 'model'
    model.textContent = previews.get(bot.id) ?? bot.modelLabel
    copy.append(model)
    const state = document.createElement('span')
    state.className = 'state'
    if (bot.unread && !readBots.has(bot.id)) {
      const unread = document.createElement('span')
      unread.className = 'unread-dot'
      unread.setAttribute('aria-label', 'Unread')
      unread.title = 'Unread'
      state.append(unread)
    }
    row.append(chat, state)
    roster.append(row)
  }
  if (focused)
    Array.from(roster.querySelectorAll<HTMLElement>('[data-focus]'))
      .find((node) => node.dataset.focus === focused)
      ?.focus()
}

function refresh(explicitRetry = false): Promise<void> {
  refreshPending ??= refreshNow(explicitRetry).finally(() => {
    refreshPending = undefined
  })
  return refreshPending
}

async function refreshAfterChange(): Promise<void> {
  await refreshPending
  await refresh()
}

async function refreshNow(explicitRetry: boolean): Promise<void> {
  clearTimeout(timer)
  if (document.hidden) return
  retry.disabled = true
  let delay = 5000
  try {
    try {
      setup.load(await frame.plugin.request('setup.get', {}))
      if (!setup.state.answered && !setup.state.toolsLoaded)
        setup.loadTools((await frame.plugin.request('tools.find', {})).tools)
      renderSetup()
    } catch {
      /* Retry with the next refresh; bots still load. */
    }
    const status = await frame.plugin.request('status', { retry: explicitRetry })
    element<HTMLButtonElement>('open-page').disabled = opening || status.state !== 'running'
    message.textContent = status.message
    message.hidden = !status.message
    running.hidden = status.state !== 'running'
    retry.hidden = status.state === 'running' || status.state === 'starting'
    if (status.state === 'starting') delay = 2000
    if (status.state === 'running') {
      try {
        const nextBots = await frame.plugin.request('bots.list', {})
        for (const bot of nextBots) if (!bot.unread) readBots.delete(bot.id)
        bots = nextBots
        chatView.update(bots)
        renderBots()
        refreshNote.textContent = ''
      } catch {
        refreshNote.textContent = 'Could not refresh. Keeping the last list.'
      }
    }
  } catch {
    message.hidden = false
    message.textContent = 'Could not read status. Please retry.'
    retry.hidden = false
  } finally {
    retry.disabled = false
    if (!document.hidden) timer = setTimeout(() => void refresh(), delay)
  }
}

retry.addEventListener('click', () => void refresh(true))
document.addEventListener('visibilitychange', () => {
  clearTimeout(timer)
  if (!document.hidden) void refresh()
})
window.addEventListener('pagehide', () => clearTimeout(timer))
window.addEventListener('pageshow', () => void refresh())
void refresh()
