import type { Requests } from '../src/protocol.ts'
import { mainFirst, stateLabel } from '../shared/roster.ts'
import type { Bot } from '../shared/roster.ts'

type FrameApi = {
  plugin: {
    request<K extends keyof Requests>(name: K, input: Requests[K]['input']): Promise<Requests[K]['output']>
  }
}
const frame = (globalThis as unknown as { orca: FrameApi }).orca
const message = document.getElementById('message') as HTMLParagraphElement
const retry = document.getElementById('retry') as HTMLButtonElement
const running = document.getElementById('running') as HTMLElement
const roster = document.getElementById('roster') as HTMLElement
const refreshNote = document.getElementById('refresh-note') as HTMLElement
const result = document.getElementById('result') as HTMLElement
const openButton = document.getElementById('open') as HTMLButtonElement
const signIn = document.getElementById('sign-in') as HTMLButtonElement
const newBot = document.getElementById('new-bot') as HTMLButtonElement
let timer: ReturnType<typeof setTimeout> | undefined
let resultTimer: ReturnType<typeof setTimeout> | undefined
let refreshing = false
let opening = false
let refreshAgain = false
let rosterKey: string | undefined

function actionButtons(): HTMLButtonElement[] {
  return Array.from(running.querySelectorAll('button'))
}

async function open(botId?: string, pair = false): Promise<void> {
  if (opening) return
  opening = true
  actionButtons().forEach((button) => { button.disabled = true })
  clearTimeout(resultTimer)
  result.textContent = 'Opening…'
  try {
    const response = pair
      ? await frame.plugin.request('chat.signIn', {})
      : await frame.plugin.request('chat.open', botId ? { botId } : {})
    result.textContent = response.message
  } catch (error) {
    result.textContent = error instanceof Error ? error.message : 'Could not open chat. Please try again.'
  } finally {
    opening = false
    actionButtons().forEach((button) => { button.disabled = false })
    resultTimer = setTimeout(() => { result.textContent = '' }, 6000)
  }
}

function renderBots(bots: Bot[]): void {
  const key = JSON.stringify(bots)
  if (key === rosterKey) return
  rosterKey = key
  const focused = (document.activeElement as HTMLElement | null)?.dataset.botId
  roster.replaceChildren()
  if (!bots.length) {
    const empty = document.createElement('p')
    empty.textContent = 'No bots yet. Press New bot to create one.'
    roster.append(empty)
  }
  for (const bot of mainFirst(bots)) {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'bot-row'
    row.dataset.botId = bot.id
    row.disabled = opening
    row.title = bot.title || bot.name
    const name = document.createElement('span')
    name.className = 'bot-name'
    name.textContent = bot.name
    row.append(name)
    if (bot.main) {
      const main = document.createElement('span')
      main.className = 'main-badge'
      main.textContent = 'Main'
      row.append(main)
    }
    const state = document.createElement('span')
    state.className = `state ${bot.state}`
    state.textContent = stateLabel(bot.state)
    row.append(state)
    if (bot.unread) {
      const unread = document.createElement('span')
      unread.className = 'unread-dot'
      unread.setAttribute('aria-label', 'Unread')
      row.append(unread)
    }
    const model = document.createElement('span')
    model.className = 'model'
    model.textContent = bot.modelLabel
    row.append(model)
    row.setAttribute('aria-label', [bot.name, bot.main ? 'Main' : '', stateLabel(bot.state), bot.unread ? 'Unread' : '', bot.modelLabel, 'Open chat'].filter(Boolean).join(', '))
    row.addEventListener('click', () => void open(bot.id))
    roster.append(row)
    if (focused === bot.id) row.focus()
  }
}

async function refresh(explicitRetry = false): Promise<void> {
  clearTimeout(timer)
  if (document.hidden) return
  if (refreshing) {
    refreshAgain = true
    return
  }
  refreshing = true
  retry.disabled = true
  let delay = 5000
  try {
    const status = await frame.plugin.request('status', { retry: explicitRetry })
    message.textContent = status.state === 'running'
      ? `Running OpenMausBot ${status.version}. ${status.message}`
      : status.message
    running.hidden = status.state !== 'running'
    retry.hidden = status.state === 'running' || status.state === 'starting'
    if (status.state === 'starting') delay = 2000
    if (status.state === 'running' && !document.hidden) {
      try {
        renderBots(await frame.plugin.request('bots.list', {}))
        refreshNote.textContent = ''
      } catch {
        refreshNote.textContent = 'Could not refresh'
      }
    }
  } catch {
    message.textContent = 'Could not read status. Please retry.'
    retry.hidden = false
  } finally {
    refreshing = false
    retry.disabled = false
    if (!document.hidden) timer = setTimeout(() => void refresh(), refreshAgain ? 0 : delay)
    refreshAgain = false
  }
}

openButton.addEventListener('click', () => void open())
signIn.addEventListener('click', () => void open(undefined, true))
newBot.addEventListener('click', () => void open())
retry.addEventListener('click', () => void refresh(true))
document.addEventListener('visibilitychange', () => {
  clearTimeout(timer)
  if (!document.hidden) void refresh()
})
window.addEventListener('pagehide', () => {
  clearTimeout(timer)
  clearTimeout(resultTimer)
})
window.addEventListener('pageshow', () => void refresh())
void refresh()
