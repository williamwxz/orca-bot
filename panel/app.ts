import { createSetup, agentNames } from './setup.ts'
import { createChatView } from './chat-view.ts'
import { createSettings } from './settings.ts'
import { createBotMenu } from './bot-menu.ts'
import { INSTALL_NOTICE } from '../shared/omb-version.ts'
import { groupRoster } from '../shared/roster.ts'
import type { FrameApi } from './chat-view.ts'
import type { Bot, BotAction } from '../shared/roster.ts'
import type { Hosts } from '../worker/paired-host.ts'
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

const hostSelect = element<HTMLSelectElement>('host')
let hosts: Hosts | undefined
const hostChosen = () =>
  !hosts || hosts.selected === 'local' || hosts.hosts.some((host) => host.id === hosts!.selected)
const remoteName = () =>
  hosts && hosts.selected !== 'local'
    ? hosts.hosts.find((host) => host.id === hosts!.selected)?.name
    : undefined

function renderSetup(hostName = remoteName()): void {
  const state = setup.state
  const target = hostName ?? 'this computer'
  element('setup').hidden = element('list-header').hidden || !state.loaded || state.answered
  element('link-agents-label').hidden = !agentNames(state.agents)
  element('share-tools-copy').textContent =
    `Claude bots use the Claude connectors, MCP servers, skills and instructions on ${target}. Codex bots always use the Codex setup on ${target}.`
  element('agent-host').textContent = ` on ${target}`
  element('agent-names').textContent = agentNames(state.agents)
  element('import-tools-label').hidden = state.tools.length === 0
  element('import-tools-copy').textContent =
    `Adds ${state.tools.length} ${state.tools.length === 1 ? 'tool' : 'tools'} from ${[...new Set(state.tools.map((t) => t.source))].join(', ')} on ${target} to OpenMausBot, switched off. Turn them on per bot in the Bot Dashboard. Tokens saved in those apps on ${target} are copied to OpenMausBot there.`
  element('setup-message').textContent = state.message
  for (const id of ['setup-allow', 'setup-skip'])
    element<HTMLButtonElement>(id).disabled = state.busy
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

function renderHosts(): void {
  if (!hosts) return
  const choices = [
    ...(hostChosen() ? [] : [['', 'Choose\u2026']]),
    ['local', 'This computer'],
    ...hosts.hosts.map((host) => [host.id, host.name])
  ]
  hostSelect.replaceChildren(
    ...choices.map(([value, label]) => {
      const option = document.createElement('option')
      option.value = value
      option.textContent = label
      option.disabled = !value
      return option
    })
  )
  hostSelect.value = hostChosen() ? hosts.selected : ''
}
async function loadHosts(): Promise<void> {
  try {
    hosts = await frame.plugin.request('hosts.get', {})
  } catch {
    /* Keep the last choice shown; status reports the problem. */
  }
  renderHosts()
  askForHost()
}
// Rises on every host change, so answers from the previous host are dropped, not shown.
let hostGeneration = 0
async function chooseHost(id: string): Promise<void> {
  if (!id) return
  hostGeneration++
  botMenu.close()
  hostSelect.disabled = true
  const nextRemote = hosts?.hosts.find((host) => host.id === id)?.name
  settings.beginHostChange(nextRemote)
  setup.state.loaded = false
  renderSetup(nextRemote)
  let hostProblem = ''
  // Clear the old host's bots at once, so nothing of theirs can be clicked while switching.
  bots = []
  selected = undefined
  previews.clear()
  readBots.clear()
  chatView.update(bots)
  renderBots()
  running.hidden = true
  result.textContent = ''
  message.hidden = false
  message.textContent = 'Connecting\u2026'
  try {
    hosts = await frame.plugin.request('hosts.select', { id })
  } catch (error) {
    hostProblem = error instanceof Error ? error.message : 'Could not change where your bots run.'
    message.textContent = hostProblem
    await loadHosts()
  } finally {
    hostSelect.disabled = false
    renderHosts()
  }
  await refreshAfterChange()
  await settings.hostChanged(hostProblem)
}
hostSelect.addEventListener('change', () => void chooseHost(hostSelect.value))
const settings = createSettings(frame, element, () => refreshAfterChange())
let settingsShown = false
function showSettings(show: boolean): void {
  settingsShown = show
  botMenu.close()
  element('main-view').hidden = show
  element('settings-view').hidden = !show
  if (show) void settings.open()
}
element('open-settings').addEventListener('click', () => showSettings(true))
element('settings-back').addEventListener('click', () => showSettings(false))
// With servers paired and none chosen, the choice comes first, before anything starts.
let askedHost = false
function askForHost(): void {
  if (askedHost || hostChosen() || !hosts?.hosts.length) return
  askedHost = true
  showSettings(true)
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
const deleting = new Set<string>()
const readBots = new Set<string>()
const previews = new Map<string, string>()
const rosterView = element<HTMLElement>('roster-view')

const botMenu = createBotMenu(element('bot-menu'), async (input: BotAction) => {
  if (changing.has(input.botId)) return
  changing.add(input.botId)
  if (input.action === 'delete') deleting.add(input.botId)
  renderBots()
  try {
    const target = bots.find((bot) => bot.id === input.botId)
    result.textContent = input.action === 'delete'
      ? `${target?.defaultBot ? 'Hiding' : 'Deleting'} ${target?.name ?? 'bot'}…`
      : ''
    await frame.plugin.request('bots.act', input)
    if (input.action === 'delete') {
      if (selected === input.botId) selected = undefined
      bots = bots.flatMap((bot) => {
        if (bot.id !== input.botId) return [bot]
        return bot.defaultBot ? [{ ...bot, addable: true }] : []
      })
      chatView.update(bots)
      renderBots()
    }
    await refreshAfterChange()
    if (input.action === 'delete')
      result.textContent = `${target?.defaultBot ? 'Hidden' : 'Deleted'} ${target?.name ?? 'bot'}.`
  } catch (error) {
    result.textContent = error instanceof Error ? error.message : 'Could not update this bot.'
  } finally {
    deleting.delete(input.botId)
    changing.delete(input.botId)
    renderBots()
  }
}, async (input) => {
  await frame.plugin.request('groups.rename', input)
  bots = bots.map((bot) => ({
    ...bot,
    section: bot.section === input.section ? input.name : bot.section,
    knownSections: bot.knownSections?.map((name) => name === input.section ? input.name : name)
  }))
  renderBots()
  await refreshAfterChange()
  return Array.from(roster.querySelectorAll<HTMLElement>('[data-focus]')).find(
    (node) => node.dataset.focus === `group-${input.name}`
  )
})

const chatView = createChatView(
  element('bot-view'),
  frame,
  makeAvatar,
  (id) => void open(id),
  () => {
    rosterView.hidden = false
    element('list-header').hidden = false
    renderHosts()
    renderSetup()
    renderBots()
  },
  (id, preview) => {
    if (preview) previews.set(id, preview)
    else previews.delete(id)
  }
)
function showBot(bot: Bot): void {
  botMenu.close()
  readBots.add(bot.id)
  rosterView.hidden = true
  element('list-header').hidden = true
  renderHosts()
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
  result.textContent = 'Opening\u2026'
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

function makeBotRow(bot: Bot, sections: string[]): HTMLElement {
  const row = document.createElement('div')
  row.className = `bot-row${selected === bot.id ? ' selected' : ''}`
  const chat = document.createElement('button')
  chat.type = 'button'
  chat.className = 'bot-chat'
  chat.dataset.focus = `${bot.id}-chat`
  chat.setAttribute('aria-disabled', String(opening || changing.has(bot.id)))
  chat.setAttribute('aria-busy', String(deleting.has(bot.id)))
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
  chat.addEventListener('click', () => {
    if (!opening && !changing.has(bot.id)) showBot(bot)
  })
  row.addEventListener('click', (event) => {
    if (opening || changing.has(bot.id)) return
    if (!(event?.target as Element | undefined)?.closest?.('button')) showBot(bot)
  })
  const openMenu = (event: Event) => botMenu.open(bot, sections, event, chat, changing.has(bot.id))
  row.addEventListener('contextmenu', openMenu)
  row.addEventListener('keydown', (event) => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) openMenu(event)
  })
  const model = document.createElement('span')
  model.className = 'model'
  model.textContent = previews.get(bot.id) ?? bot.modelLabel
  copy.append(model)
  const state = document.createElement('span')
  state.className = 'state'
  if (deleting.has(bot.id)) {
    const spinner = document.createElement('span')
    spinner.className = 'deleting-spinner'
    spinner.setAttribute('aria-hidden', 'true')
    state.append(spinner)
  } else if (bot.unread && !readBots.has(bot.id)) {
    const unread = document.createElement('span')
    unread.className = 'unread-dot'
    unread.setAttribute('aria-label', 'Unread')
    unread.title = 'Unread'
    state.append(unread)
  }
  row.append(chat, state)
  return row
}

function renderBots(): void {
  const key = JSON.stringify([bots, selected, opening, [...changing], [...deleting], [...readBots], [...previews]])
  if (key === rosterKey) return
  rosterKey = key
  const focused = (document.activeElement as HTMLElement)?.dataset.focus
  roster.replaceChildren()
  const grouped = groupRoster(bots)
  if (!grouped.ungroupedTop.length && !grouped.groups.length) {
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
  for (const bot of grouped.ungroupedTop) {
    roster.append(makeBotRow(bot, grouped.sections))
  }
  for (const group of grouped.groups) {
    const heading = document.createElement('div')
    heading.className = 'roster-group-title'
    heading.textContent = group.title
    if (grouped.sections.includes(group.title)) {
      heading.tabIndex = 0
      heading.setAttribute('role', 'button')
      heading.dataset.focus = `group-${group.title}`
      heading.setAttribute('aria-haspopup', 'menu')
      const openGroup = (event: Event) => botMenu.openGroup(group.title, event, heading)
      heading.addEventListener('contextmenu', openGroup)
      heading.addEventListener('keydown', (event) => {
        if (['Enter', ' ', 'ContextMenu'].includes(event.key) || (event.shiftKey && event.key === 'F10'))
          openGroup(event)
      })
    }
    roster.append(heading)
    for (const bot of group.bots) {
      roster.append(makeBotRow(bot, grouped.sections))
    }
  }
  for (const bot of grouped.addable) {
    const add = document.createElement('button')
    add.className = 'add-mausbot'
    add.type = 'button'
    add.append(icon('plus'), document.createTextNode('Add MausBot'))
    add.disabled = changing.has(bot.id)
    add.addEventListener('click', () => void addMausBot(bot))
    roster.append(add)
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
  const generation = hostGeneration
  const current = () => generation === hostGeneration
  try {
    // Ask Orca again while the chosen server is unknown, so a passing failure recovers by itself.
    if (!hostChosen()) await loadHosts()
    try {
      const initial = !setup.state.loaded
      setup.load(await frame.plugin.request('setup.get', {}))
      if (initial) {
        shareTools.checked = setup.state.shareTools
        linkAgents.checked = setup.state.linkAgents
      }
      if (!setup.state.answered && !setup.state.toolsLoaded)
        setup.loadTools((await frame.plugin.request('tools.find', {})).tools)
      renderSetup()
    } catch {
      /* Retry with the next refresh; bots still load. */
    }
    const status = await frame.plugin.request('status', { retry: explicitRetry })
    if (!current()) return
    settings.setStatus(status, remoteName())
    element<HTMLButtonElement>('open-page').disabled = opening || status.state !== 'running'
    // Avoid duplicating the install notice in both #message and #install-card.
    const installShown = !element('install-card').hidden
    const headerMessage = installShown
      ? status.state === 'needs_install'
        ? ''
        : status.message.replace(INSTALL_NOTICE, '').trim()
      : status.message
    message.textContent = headerMessage
    message.hidden = !headerMessage
    running.hidden = status.state !== 'running'
    // While servers are listed, choosing one is the way forward; Retry is for failures.
    retry.hidden =
      status.state === 'running' ||
      status.state === 'starting' ||
      status.state === 'needs_install' ||
      (!hostChosen() && !!hosts?.hosts.length)
    if (status.state === 'starting') delay = 2000
    if (status.state === 'running') {
      try {
        const nextBots = await frame.plugin.request('bots.list', {})
        if (!current()) return
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
    if (!current()) return
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
  if (!document.hidden) void start()
})
window.addEventListener('pagehide', () => clearTimeout(timer))
const start = () => {
  void settings.checkUpdates()
  return loadHosts().then(() => refresh())
}
window.addEventListener('pageshow', () => void start())
void start()
