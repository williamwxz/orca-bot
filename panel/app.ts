import type { Requests } from '../src/protocol.ts'
import { stateLabel } from '../shared/roster.ts'
import type { Bot } from '../shared/roster.ts'
import { availableModels, defaultModel } from '../shared/models.ts'
import type { ModelGroup } from '../shared/models.ts'
import { avatarSvg } from '../shared/appearance.ts'

type FrameApi = { plugin: { request<K extends keyof Requests>(name: K, input: Requests[K]['input']): Promise<Requests[K]['output']> } }
const frame = (globalThis as unknown as { orca: FrameApi }).orca
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const message = element<HTMLParagraphElement>('message')
const retry = element<HTMLButtonElement>('retry')
const running = element<HTMLElement>('running')
const roster = element<HTMLElement>('roster')
const refreshNote = element<HTMLElement>('refresh-note')
const result = element<HTMLElement>('result')
const dialog = element<HTMLDialogElement>('create-dialog')
const form = element<HTMLFormElement>('create-form')
const nameInput = element<HTMLInputElement>('bot-name')
const modelInput = element<HTMLSelectElement>('bot-model')
const createButton = element<HTMLButtonElement>('create')
const dialogError = element<HTMLElement>('dialog-error')
let timer: ReturnType<typeof setTimeout> | undefined
let refreshPending: Promise<void> | undefined
let opening = false
let creating = false
let selected: string | undefined
let models: ModelGroup[] = []
let bots: Bot[] = []
let rosterKey = ''
const changing = new Set<string>()
const icons = {
  plus: '<path d="M8 3v10M3 8h10"/>',
  chat: '<path d="M3 3h10v8H7l-4 3V3Z"/>',
  clock: '<circle cx="8" cy="8" r="5.5"/><path d="M8 4.5V8l2.5 1.5"/>',
  close: '<path d="m4 4 8 8M12 4l-8 8"/>'
}
function icon(kind: keyof typeof icons): SVGElement {
  const span = document.createElement('span')
  span.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[kind]}</svg>`
  return span.firstElementChild as SVGElement
}
for (const [id, kind] of [['open', 'chat'], ['new-bot', 'plus'], ['create', 'plus'], ['cancel', 'close']] as const) element(id).prepend(icon(kind))

function fillModels(select: HTMLSelectElement, current = defaultModel(models), label = 'Current model'): void {
  select.replaceChildren()
  const groups = availableModels(models)
  if (current && !groups.some((group) => group.options.some((option) => option.value === current))) {
    const option = new Option(label, current)
    option.disabled = true
    select.add(option)
  }
  for (const group of groups) {
    const section = document.createElement('optgroup')
    section.label = group.label
    for (const option of group.options) section.append(new Option(option.label, option.value))
    select.append(section)
  }
  if (!groups.length && !current) select.add(new Option('No available models', ''))
  select.value = current
}

async function open(botId?: string): Promise<void> {
  if (opening) return
  opening = true
  selected = botId
  renderBots()
  result.textContent = 'Opening…'
  try {
    result.textContent = (await frame.plugin.request('chat.open', botId ? { botId } : {})).message
  } catch (error) {
    result.textContent = error instanceof Error ? error.message : 'Could not open chat.'
  } finally {
    opening = false
    renderBots()
  }
}

async function changeModel(bot: Bot, select: HTMLSelectElement): Promise<void> {
  if (changing.has(bot.id)) return
  changing.add(bot.id)
  select.disabled = true
  try {
    const response = await frame.plugin.request('bots.model', { botId: bot.id, model: select.value })
    result.textContent = response.message
    await refreshAfterChange()
  } catch (error) {
    result.textContent = error instanceof Error ? error.message : 'Could not change model.'
    select.value = bot.model ?? ''
  } finally {
    changing.delete(bot.id)
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
  const key = JSON.stringify([bots, models, selected, opening, [...changing]])
  if (key === rosterKey) return
  rosterKey = key
  const focused = (document.activeElement as HTMLElement)?.dataset.focus
  roster.replaceChildren()
  if (!bots.some((bot) => !bot.addable)) {
    const empty = document.createElement('p')
    empty.className = 'empty'
    empty.textContent = 'Your team starts here. Create a bot to get going.'
    roster.append(empty)
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
    const avatar = document.createElement('span')
    avatar.className = 'avatar'
    if (bot.avatar) {
      const img = document.createElement('img')
      img.src = bot.avatar
      img.alt = ''
      avatar.append(img)
    } else avatar.innerHTML = avatarSvg(bot.id)
    const name = document.createElement('span')
    name.className = 'bot-name'
    name.textContent = bot.name
    chat.append(avatar, name)
    if (bot.main) {
      const main = document.createElement('span')
      main.className = 'main-badge'
      main.textContent = 'Main'
      chat.append(main)
    }
    chat.addEventListener('click', () => void open(bot.id))
    const model = document.createElement('select')
    model.className = 'model'
    model.dataset.focus = `${bot.id}-model`
    model.setAttribute('aria-label', `Model for ${bot.name}`)
    fillModels(model, bot.model, bot.modelLabel)
    model.disabled = bot.state !== 'idle' || changing.has(bot.id) || !availableModels(models).length
    model.title = bot.state !== 'idle' ? 'This bot is busy. Wait until it is idle to change its model.' : bot.modelLabel
    model.addEventListener('change', () => void changeModel(bot, model))
    const state = document.createElement('span')
    state.className = `state ${bot.state}`
    if (bot.state === 'waiting') state.append(icon('clock'))
    state.append(document.createTextNode(stateLabel(bot.state)))
    if (bot.state !== 'idle') state.title = 'Wait until this bot is idle to change its model.'
    if (bot.unread) {
      const unread = document.createElement('span')
      unread.className = 'unread-dot'
      unread.setAttribute('aria-label', 'Unread')
      unread.title = 'Unread'
      state.append(unread)
    }
    row.append(chat, model, state)
    roster.append(row)
  }
  if (focused) Array.from(roster.querySelectorAll<HTMLElement>('[data-focus]')).find((node) => node.dataset.focus === focused)?.focus()
}

function refresh(explicitRetry = false): Promise<void> {
  refreshPending ??= refreshNow(explicitRetry).finally(() => { refreshPending = undefined })
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
    const status = await frame.plugin.request('status', { retry: explicitRetry })
    message.textContent = status.message
    message.hidden = !status.message
    running.hidden = status.state !== 'running'
    retry.hidden = status.state === 'running' || status.state === 'starting'
    if (status.state === 'starting') delay = 2000
    if (status.state === 'running') {
      try {
        const [nextBots, nextModels] = await Promise.all([frame.plugin.request('bots.list', {}), frame.plugin.request('models.list', {})])
        bots = nextBots
        models = nextModels
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

element('open').addEventListener('click', () => void open())
element('new-bot').addEventListener('click', async () => {
  dialogError.textContent = ''
  form.reset()
  createButton.disabled = true
  dialog.showModal()
  nameInput.focus()
  try {
    models = await frame.plugin.request('models.list', {})
    fillModels(modelInput)
    createButton.disabled = !modelInput.value
    if (!modelInput.value) dialogError.textContent = 'No AI models are available. Set up an AI account in OpenMausBot, then reopen this dialog.'
  } catch (error) {
    dialogError.textContent = error instanceof Error ? error.message : 'Could not load models.'
  }
})
element('cancel').addEventListener('click', () => { if (!creating) dialog.close() })
dialog.addEventListener('cancel', (event) => { if (creating) event.preventDefault() })
form.addEventListener('submit', async (event) => {
  event.preventDefault()
  if (creating || !modelInput.value || !nameInput.value.trim()) return
  creating = true
  createButton.disabled = true
  nameInput.disabled = true
  modelInput.disabled = true
  dialogError.textContent = ''
  let created: { id: string } | undefined
  try {
    created = await frame.plugin.request('bots.create', { name: nameInput.value.trim(), model: modelInput.value })
    dialog.close()
  } catch (error) {
    dialogError.textContent = error instanceof Error ? error.message : 'Could not create bot. Check the roster before trying again.'
  } finally {
    creating = false
    createButton.disabled = false
    nameInput.disabled = false
    modelInput.disabled = false
  }
  if (created) {
    // A successful creation is final even if opening the browser subsequently fails.
    await refreshAfterChange()
    await open(created.id)
  }
})
retry.addEventListener('click', () => void refresh(true))
document.addEventListener('visibilitychange', () => {
  clearTimeout(timer)
  if (!document.hidden) void refresh()
})
window.addEventListener('pagehide', () => clearTimeout(timer))
window.addEventListener('pageshow', () => void refresh())
void refresh()
