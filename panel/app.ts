import { createToast } from './toast.ts'
import { createMcpView } from './mcp-view.ts'
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
const toast = createToast(element('toast'))
const addButton = element<HTMLButtonElement>('add-bot')
let creating = false
let serverRunning = false
function updateAddButton() {
  addButton.disabled = creating || !serverRunning
  addButton.setAttribute('aria-busy', String(creating))
}
addButton.addEventListener('click', event => {
  event.stopPropagation()
  if (!addButton.disabled) botMenu.openCreate(addButton)
})
const setup = createSetup((answer) => frame.plugin.request('setup.answer', answer))
const shareTools = element<HTMLInputElement>('share-tools')
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
  element('setup-message').textContent = state.message
  for (const id of ['setup-allow', 'setup-skip'])
    element<HTMLButtonElement>(id).disabled = state.busy
  shareTools.disabled = linkAgents.disabled = state.busy
}
async function answerSetup(allow: boolean): Promise<void> {
  setup.state.shareTools = shareTools.checked
  setup.state.linkAgents = linkAgents.checked
  const applying = setup.answer(allow)
  renderSetup()
  await applying
  if (setup.state.answered && setup.state.message) toast.show(setup.state.message)
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
let connectorHostId: string | undefined
function updateConnectorHost(id: string, name?: string): void {
  if (connectorHostId === id) return
  if (connectorHostId !== undefined) {
    hostGeneration++
    creating = serverRunning = false
    updateAddButton()
    toast.hide()
    botMenu.close()
    chatView.close()
    bots = []
    selected = undefined
    rosterView.hidden = false
    element('list-header').hidden = false
    renderBots()
  }
  connectorHostId = id
  mcp.hostChanged(id, name)
}
async function loadHosts(): Promise<void> {
  try {
    hosts = await frame.plugin.request('hosts.get', {})
  } catch {
    /* Keep the last choice shown; status reports the problem. */
  }
  renderHosts()
  updateConnectorHost(hosts?.selected ?? '', remoteName())
  askForHost()
}
// Rises on every host change, so answers from the previous host are dropped, not shown.
let hostGeneration = 0
async function chooseHost(id: string): Promise<void> {
  if (!id) return
  hostGeneration++
  creating = serverRunning = false
  updateAddButton()
  toast.hide()
  botMenu.close()
  hostSelect.disabled = true
  const nextRemote = hosts?.hosts.find((host) => host.id === id)?.name
  updateConnectorHost(id, nextRemote)
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
  await mcp.refresh()
}
hostSelect.addEventListener('change', () => void chooseHost(hostSelect.value))
const mcp = createMcpView(frame, element, toast.show)
const settings = createSettings(frame, element, () => refreshAfterChange(), toast.show)
let settingsShown = false
let mcpStatus = ''
function showSettings(show: boolean): void {
  settingsShown = show
  botMenu.close()
  chatView.dismissCapabilities()
  element('main-view').hidden = show
  element('settings-view').hidden = !show
  element('mcp-view').hidden = true
  if (show) { void settings.open(); void mcp.refresh() }
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

let rosterRevision = 0
async function readRoster(): Promise<Bot[]> {
  const generation = hostGeneration
  let revision: number
  let next: Bot[]
  do {
    revision = rosterRevision
    next = await frame.plugin.request('bots.list', {})
  } while (generation === hostGeneration && revision !== rosterRevision)
  return next
}

async function refreshCapabilities(): Promise<void> {
  const generation = hostGeneration
  const next = await readRoster()
  if (generation !== hostGeneration) return
  bots = next
  chatView.update(bots)
  renderBots()
}
function manageCapabilities(botId: string, enabled: boolean, fromChat = false) {
  showSettings(true)
  if (fromChat) chatView.close()
  mcp.open({ tab: enabled ? 'bot' : 'provider', botId,
    ...(fromChat ? { back: () => {
      showSettings(false)
      const bot = bots.find(b => b.id === botId)
      if (bot) showBot(bot)
    } } : {})
  })
}
const botMenu = createBotMenu(element('bot-menu'), async (input: BotAction) => {
  if (changing.has(input.botId)) return
  const generation = hostGeneration
  changing.add(input.botId)
  if (input.action === 'delete') deleting.add(input.botId)
  renderBots()
  try {
    const target = bots.find((bot) => bot.id === input.botId)
    await frame.plugin.request('bots.act', input)
    if (generation !== hostGeneration) return
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
    if (generation !== hostGeneration) return
    if (input.action === 'delete')
      toast.show(`${target?.defaultBot ? 'Hidden' : 'Deleted'} ${target?.name ?? 'bot'}.`)
    else if (input.action === 'rename') toast.show(`Renamed to ${input.name}.`)
    else if (input.action === 'pin') toast.show(input.pinned ? 'Pinned.' : 'Unpinned.')
    else toast.show(input.action === 'model' ? 'Model updated.' : 'Group updated.')
  } catch (error) {
    if (generation === hostGeneration) toast.show(error instanceof Error ? error.message : 'Could not update this bot.')
  } finally {
    deleting.delete(input.botId)
    changing.delete(input.botId)
    renderBots()
  }
}, async (input) => {
  const generation = hostGeneration
  await frame.plugin.request('groups.rename', input)
  if (generation !== hostGeneration) return
  bots = bots.map((bot) => ({
    ...bot,
    section: bot.section === input.section ? input.name : bot.section,
    knownSections: bot.knownSections?.map((name) => name === input.section ? input.name : name)
  }))
  renderBots()
  await refreshAfterChange()
  if (generation !== hostGeneration) return
  toast.show(`Renamed group to ${input.name}.`)
  return Array.from(roster.querySelectorAll<HTMLElement>('[data-focus]')).find(
    (node) => node.dataset.focus === `group-${input.name}`
  )
}, {
  list: () => frame.plugin.request('mcp.list', {}),
  act: input => frame.plugin.request('mcp.act', input),
  manage: (botId, enabled) => manageCapabilities(botId, enabled)
}, { frame, hooks: { notify: toast.show, changed: refreshCapabilities, manage: (botId, enabled) => manageCapabilities(botId, enabled), hostGeneration: () => hostGeneration } }, async input => {
  if (creating || !serverRunning) throw new Error('Wait until the server is ready.')
  const generation = hostGeneration
  creating = true
  updateAddButton()
  renderBots()
  try {
    const created = await frame.plugin.request('bots.create', input)
    if (generation !== hostGeneration) return
    ++rosterRevision
    const bot: Bot = { id: created.botId, name: created.name, title: '', state: 'idle',
      unread: false, main: false, modelLabel: '', section: created.section ?? input.section }
    bots = [...bots.filter(item => item.id !== bot.id), bot]
    chatView.update(bots)
    renderBots()
    showBot(bot)
    toast.show(`Created ${created.name}.`)
  } finally {
    if (generation === hostGeneration) { creating = false; updateAddButton(); renderBots() }
  }
}
)

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
  },
  { notify: toast.show, changed: refreshCapabilities, manage: (botId, enabled) => manageCapabilities(botId, enabled, true), hostGeneration: () => hostGeneration }
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
async function open(botId?: string, success?: string): Promise<void> {
  if (opening) return
  const generation = hostGeneration
  opening = true
  element<HTMLButtonElement>('open-page').disabled = true
  selected = botId
  renderBots()
  try {
    const reply = await frame.plugin.request('chat.open', botId ? { botId } : {})
    if (generation === hostGeneration) toast.show(success ?? reply.message)
  } catch (error) {
    if (generation === hostGeneration) toast.show(error instanceof Error ? error.message : 'Could not open chat.')
  } finally {
    opening = false
    element<HTMLButtonElement>('open-page').disabled = false
    renderBots()
  }
}

async function addMausBot(bot: Bot): Promise<void> {
  if (changing.has(bot.id)) return
  const generation = hostGeneration
  changing.add(bot.id)
  renderBots()
  try {
    await frame.plugin.request('bots.addMausBot', { botId: bot.id })
    await refreshAfterChange()
    if (generation === hostGeneration) await open(bot.id, `Added ${bot.name}.`)
  } catch (error) {
    if (generation === hostGeneration) toast.show(error instanceof Error ? error.message : 'Could not add MausBot.')
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
  const key = JSON.stringify([bots, creating, addButton.disabled, selected, opening, [...changing], [...deleting], [...readBots], [...previews]])
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
    const add = document.createElement('button')
    add.type = 'button'
    add.className = 'bot-menu-btn primary'
    add.textContent = 'Add bot'
    add.disabled = addButton.disabled
    add.addEventListener('click', event => { event.stopPropagation(); botMenu.openCreate(add) })
    roster.append(add, openButton)
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
      const openGroup = (event: Event) => botMenu.openGroup(group.title, event, heading, addButton.disabled)
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
      renderSetup()
    } catch {
      /* Retry with the next refresh; bots still load. */
    }
    const status = await frame.plugin.request('status', { retry: explicitRetry })
    if (!current()) return
    serverRunning = status.state === 'running'
    updateAddButton()
    settings.setStatus(status, remoteName())
    const connectorStatus = JSON.stringify([status.state, status.port, remoteName()])
    if (connectorStatus !== mcpStatus) {
      mcpStatus = connectorStatus
      if (settingsShown) void mcp.refresh()
    }
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
        const nextBots = await readRoster()
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
    serverRunning = false
    updateAddButton()
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
