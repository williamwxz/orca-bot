// The panel. It holds no Grok Bot logic: every action is a request to the plugin's worker.
import {
  avatarHue,
  readableAvatarText,
  sidebarBots,
  removeRoutineMessage,
  routinesFrom,
  scheduleMessage,
  waitingState,
  type Bot,
  type Entry
} from '../shared/model.ts'
import type { Requests } from '../src/protocol.ts'
import { renderMarkdown } from './markdown.ts'

type FrameApi = {
  locale: string
  plugin: { request(name: string, input: unknown, options?: { timeoutMs?: number }): Promise<unknown> }
  shell?: { openExternal(url: string): Promise<unknown> }
}
const frame = (globalThis as unknown as { orca: FrameApi }).orca

function request<K extends keyof Requests>(
  name: K,
  input: Requests[K]['input'],
  timeoutMs = 30_000
): Promise<Requests[K]['output']> {
  return frame.plugin.request(name, input, { timeoutMs }) as Promise<Requests[K]['output']>
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const app = $('app')
const botsEl = $('bots')
const messagesEl = $('messages')
const input = $<HTMLTextAreaElement>('input')
const modal = $('modal')
const wide = matchMedia('(min-width: 620px)')

const state = {
  bots: [] as Bot[],
  selected: null as string | null,
  entries: [] as Entry[],
  limit: 60,
  pending: [] as string[],
  previews: new Map<string, string>(),
  showHidden: false,
  query: '',
  infoOpen: false,
  threadError: '',
  waiting: new Map<string, { newestTsAtSend: number; startedAt: number }>(),
  selectedBot: null as Bot | null,
  lastPoll: 0,
  drawn: ''
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  const { class: className, ...rest } = props
  if (className) node.className = className
  Object.assign(node, rest)
  node.append(...children)
  return node
}

function errorText(error: unknown): string {
  const e = error as { message?: string; code?: string }
  return e?.message || e?.code || String(error)
}

// Hand-drawn silhouettes, not extracted desktop assets. All share a 48-unit canvas.
const SHAPES: Record<string, string> = {
  blob: 'M8 12Q15 2 30 6Q44 10 43 27Q40 44 23 43Q4 41 5 25Z',
  pebble: 'M7 18Q13 4 29 7Q45 10 42 28Q37 45 18 41Q2 36 7 18Z',
  bean: 'M10 9Q26 0 38 13Q48 24 37 39Q27 48 22 35Q21 26 12 27Q0 24 10 9Z',
  egg: 'M24 4C34 4 43 25 40 34C36 48 10 47 7 33C5 22 16 4 24 4Z',
  squircle: 'M24 4Q43 4 43 24Q43 44 24 44Q4 44 4 24Q4 4 24 4Z',
  tablet: 'M12 5H36Q42 5 42 12V36Q42 43 35 43H12Q6 43 6 36V12Q6 5 12 5Z',
  capsule: 'M20 4H28Q40 4 40 17V31Q40 44 28 44H20Q8 44 8 31V17Q8 4 20 4Z',
  cylinder: 'M7 12C7 2 41 2 41 12V36C41 46 7 46 7 36Z',
  hex: 'M14 4L36 8L45 26L33 43L12 39L3 21Z',
  gem: 'M14 5H34L45 20L24 44L3 20Z',
  crystal: 'M22 3L39 12L44 31L24 45L6 33L8 13Z',
  wedge: 'M9 7Q11 2 17 6L42 25Q49 32 39 37L12 44Q5 45 6 36Z',
  shield: 'M6 7Q24 2 42 7V24Q40 36 24 45Q8 36 6 24Z',
  dome: 'M5 39V24C5 0 43 0 43 24V39Q43 43 38 43H10Q5 43 5 39Z',
  arch: 'M8 43V22C8 0 40 0 40 22V43H29V24Q24 15 19 24V43Z',
  cloud: 'M11 39C0 37 0 22 10 19C7 4 27 1 32 13C46 9 50 31 39 36Q25 45 11 39Z',
  teardrop: 'M24 3C29 12 44 22 42 32C39 49 9 48 6 32C4 22 19 10 24 3Z',
  leaf: 'M43 5C43 30 33 45 15 42C-2 37 3 16 17 10Q29 5 43 5Z',
  heart: 'M24 14C9 -6 -5 18 10 31L24 44L38 31C53 18 39 -6 24 14Z',
  square: 'M10 5H38Q43 5 43 10V38Q43 43 38 43H10Q5 43 5 38V10Q5 5 10 5Z',
  sparkle: 'M24 2Q31 17 46 24Q31 31 24 46Q17 31 2 24Q17 17 24 2Z'
}
function avatar(bot: Bot, size = ''): HTMLElement {
  const node = el('span', { class: `avatar ${size}` })
  node.style.color = avatarHue(bot.avatarColor)
  node.setAttribute('aria-hidden', 'true')
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 48 48')
  svg.setAttribute('focusable', 'false')
  const shape = document.createElementNS(svg.namespaceURI, 'path')
  shape.setAttribute('d', Object.hasOwn(SHAPES, bot.avatarShape) ? SHAPES[bot.avatarShape] : SHAPES.square)
  shape.setAttribute('fill', 'currentColor')
  svg.append(shape)
  for (const x of [19, 29]) {
    const eye = document.createElementNS(svg.namespaceURI, 'rect')
    eye.setAttribute('x', String(x))
    eye.setAttribute('y', '17')
    eye.setAttribute('width', '5')
    eye.setAttribute('height', '10')
    eye.setAttribute('rx', '2.5')
    eye.setAttribute('fill', '#fff8ed')
    eye.setAttribute('transform', `rotate(-22 ${x + 2.5} 22)`)
    svg.append(eye)
  }
  node.append(svg)
  return node
}

const current = () => state.bots.find((bot) => bot.id === state.selected) ??
  (state.selectedBot?.id === state.selected ? state.selectedBot : null)

function setView(): void {
  const bot = current()
  app.dataset.view = !bot ? 'list' : state.infoOpen ? 'info' : 'chat'
}

// ---------- Bot list ----------

function renderBots(): void {
  const scrollTop = botsEl.scrollTop
  const focused = document.activeElement as HTMLElement | null
  const focusKey = botsEl.contains(focused) ? focused?.dataset.listKey : undefined
  botsEl.replaceChildren()
  const row = (bot: Bot) => {
    const button = el(
      'button',
      { class: 'bot', type: 'button' },
      avatar(bot),
      el(
        'span',
        { class: 'text' },
        el('span', { class: 'name' }, bot.name),
        el('span', { class: 'preview' }, state.previews.get(bot.id) ?? '')
      )
    )
    button.dataset.listKey = bot.id
    button.setAttribute('aria-pressed', String(bot.id === state.selected))
    button.onclick = () => select(bot.id)
    return button
  }
  const { main, visible, hidden } = sidebarBots(state.bots, state.query)
  if (main) {
    const header = row(main)
    header.classList.add('main-bot')
    header.replaceChildren(avatar(main, 'large'), el('span', { class: 'name' }, main.name))
    botsEl.append(header)
  }
  botsEl.append(...visible.map(row))
  if (state.query && !main && !visible.length && !hidden.length) botsEl.append(el('p', { class: 'note' }, 'No matching bots.'))
  if (!state.bots.length) {
    botsEl.append(el('p', { class: 'note' }, 'No bots yet. Press + to create one.'))
  }
  if (hidden.length) {
    const toggle = el(
      'button',
      { class: 'group-label', type: 'button' },
      el('span', {}, 'Hidden Bots'),
      el('span', {}, String(hidden.length))
    )
    toggle.dataset.listKey = 'hidden-toggle'
    toggle.setAttribute('aria-expanded', String(state.showHidden || Boolean(state.query)))
    toggle.onclick = () => {
      state.showHidden = !state.showHidden
      renderBots()
    }
    botsEl.append(toggle)
    if (state.showHidden || state.query) botsEl.append(...hidden.map(row))
  }
  if (focusKey) {
    const replacement = [...botsEl.querySelectorAll<HTMLElement>('[data-list-key]')]
      .find(node => node.dataset.listKey === focusKey)
    replacement?.focus({ preventScroll: true })
  }
  botsEl.scrollTop = scrollTop
}

async function loadPreviews(): Promise<void> {
  for (const bot of state.bots.filter((item) => !item.hidden)) {
    try {
      const entries = await request('thread.read', { id: bot.id, limit: 5 })
      const last = [...entries].reverse().find((entry) => entry.role !== 'event' && entry.text)
      if (last) state.previews.set(bot.id, last.text.replace(/\s+/g, ' ').slice(0, 80))
    } catch {
      // A preview is decoration: leave it blank.
    }
    renderBots()
  }
}

/** After a write: use the list the worker sent, or reload when it could not read one. */
function applyWrite(bots: Bot[] | null): void {
  if (bots) applyBots(bots)
  else void start()
}

function applyBots(bots: Bot[]): void {
  state.bots = bots
  state.selectedBot = null
  if (state.selected && !current()) {
    state.selected = null
    state.infoOpen = false
    state.entries = []
  }
  renderBots()
  renderHeader()
  renderInfo()
  setView()
}

let listing = false
async function loadBots(): Promise<void> {
  if (listing) return
  listing = true
  try {
    applyBots(await request('bots.list', {}))
  } finally {
    listing = false
  }
  if (!state.selected) {
    let remembered: string | null = null
    try {
      remembered = localStorage.getItem('selectedBot')
    } catch {
      // storage can be unavailable
    }
    const first =
      state.bots.find((bot) => bot.id === remembered) ??
      (wide.matches ? state.bots.find((bot) => !bot.hidden) : undefined)
    if (first) select(first.id)
  }
  void loadPreviews()
}

// Background roster reads never rebuild the conversation or details editor.
async function refreshBots(): Promise<void> {
  if (document.visibilityState !== 'visible' || !modal.hidden || listing || starting || app.dataset.view === 'empty') return
  listing = true
  let signedOut = false
  try {
    const bots = await request('bots.list', {})
    state.selectedBot = current()
    state.bots = bots
    renderBots()
    renderHeader()
  } catch (error) {
    signedOut = errorText(error).startsWith('Open the Grok Bot app and sign in')
  } finally {
    listing = false
  }
  if (signedOut) void start()
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void refreshBots()
})
setInterval(() => void refreshBots(), 60_000)

function select(id: string): void {
  state.selected = id
  state.selectedBot = state.bots.find(bot => bot.id === id) ?? null
  state.entries = []
  state.pending = []
  state.limit = 60
  state.threadError = ''
  state.drawn = ''
  try {
    localStorage.setItem('selectedBot', id)
  } catch {
    // storage can be unavailable
  }
  renderBots()
  renderHeader()
  renderMessages(true)
  renderInfo()
  setView()
  void refreshThread(true)
  if (wide.matches) input.focus()
}

// ---------- Chat ----------

function renderHeader(): void {
  const bot = current()
  $('chat-avatar').replaceChildren(...(bot ? [avatar(bot, 'small')] : []))
  $('chat-title').textContent = bot?.name ?? ''
  $('chat').style.setProperty('--bot-hue', avatarHue(bot?.avatarColor ?? 'gray'))
  $('chat').style.setProperty('--bot-ink', readableAvatarText(bot?.avatarColor ?? 'gray'))
  input.placeholder = bot ? `Message ${bot.name}` : 'Message'
  input.disabled = !bot
  $<HTMLButtonElement>('send').disabled = !bot
  $('open-info').hidden = !bot
}

function timeLabel(ts: number): string {
  const date = new Date(ts)
  const sameDay = date.toDateString() === new Date().toDateString()
  return date.toLocaleString(frame.locale || undefined, {
    ...(sameDay ? {} : { month: 'short', day: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit'
  })
}

function bubble(entry: Entry): HTMLElement {
  if (entry.role === 'event' || entry.type === 'other') {
    return el('div', { class: 'note' }, entry.role === 'event' ? entry.text : `[${entry.text}]`)
  }
  if (entry.role === 'user') return el('div', { class: 'msg user' }, entry.text)

  const node = el('div', { class: 'msg' })
  if (entry.type === 'email' && entry.email) {
    node.append(
      el('div', { class: 'card-title' }, `Email draft: ${entry.email.subject}`),
      el('div', { class: 'muted' }, `To ${entry.email.to}`),
      renderMarkdown(entry.text)
    )
  } else if (entry.type === 'file') {
    node.append(el('div', { class: 'card-title' }, `📎 ${entry.text}`))
    node.append(el('div', { class: 'muted' }, 'Open the Grok Bot app to view this file.'))
  } else if (entry.type === 'form') {
    node.append(el('div', { class: 'card-title' }, entry.text))
    node.append(el('div', { class: 'muted' }, 'Answer this form in the Grok Bot app.'))
  } else {
    node.append(renderMarkdown(entry.text))
    if (entry.streaming) node.append(el('div', { class: 'muted' }, 'Writing…'))
  }
  if (entry.widget) {
    if (entry.widget.responded) {
      node.append(el('div', { class: 'muted' }, `You answered: ${entry.widget.responded}`))
    } else {
      const options = el('div', { class: 'options' })
      for (const option of entry.widget.options) {
        const button = el('button', { type: 'button' }, option.label)
        button.onclick = () => void send(option.value)
        options.append(button)
      }
      node.append(options)
    }
  }
  return node
}

function replyState(): 'working' | 'slow' | 'done' {
  const id = state.selected
  const waiting = id ? state.waiting.get(id) : undefined
  if (!id || !waiting) return 'done'
  const result = waitingState(state.entries, waiting.newestTsAtSend, waiting.startedAt, Date.now())
  if (result === 'done') state.waiting.delete(id)
  return result
}

function renderMessages(forceBottom = false): void {
  const waiting = replyState()
  const signature = JSON.stringify([state.selected, state.entries, state.pending, state.threadError, waiting])
  if (signature === state.drawn && !forceBottom) return
  state.drawn = signature
  if (forceBottom) stick = true

  const nodes: HTMLElement[] = []
  if (!current()) {
    nodes.push(el('div', { class: 'note' }, 'Pick a bot to start chatting.'))
  } else {
    if (state.entries.length >= state.limit && state.limit < 200) {
      const more = el('button', { class: 'link note', type: 'button' }, 'Load earlier messages')
      more.onclick = () => {
        state.limit = 200
        void refreshThread()
      }
      nodes.push(more)
    }
    let previous = 0
    for (const entry of state.entries) {
      if (entry.ts - previous > 30 * 60_000) nodes.push(el('div', { class: 'note' }, timeLabel(entry.ts)))
      previous = entry.ts
      nodes.push(bubble(entry))
    }
    for (const text of state.pending) nodes.push(el('div', { class: 'msg user pending' }, text))
    if (waiting === 'slow') {
      nodes.push(el('div', { class: 'note' }, 'Still working. The reply will appear here.'))
    } else if (waiting === 'working' && !state.entries.some(entry => entry.role === 'bot' && entry.streaming)) {
      const dots = el('span', { class: 'working-dots' }, ...[1, 2, 3].map(() => el('span', {}, '•')))
      dots.setAttribute('aria-hidden', 'true')
      nodes.push(el('div', { class: 'msg working' }, dots, 'Working…'))
    }
    if (state.threadError) nodes.push(el('div', { class: 'note error' }, state.threadError))
    if (!nodes.length) nodes.push(el('div', { class: 'note' }, 'Loading…'))
  }
  messagesEl.replaceChildren(...nodes)
  if (stick) messagesEl.scrollTop = messagesEl.scrollHeight
}

// Follow new messages while the reader is at the bottom, including after the chat column is
// shown again or resized (scrolling a hidden column does nothing).
let stick = true
messagesEl.onscroll = () => {
  if (!messagesEl.clientHeight) return
  stick = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80
}
new ResizeObserver(() => {
  if (stick) messagesEl.scrollTop = messagesEl.scrollHeight
}).observe(messagesEl)

let reading = false
async function refreshThread(forceBottom = false): Promise<void> {
  const id = state.selected
  if (!id || reading) return
  reading = true
  state.lastPoll = Date.now()
  try {
    const entries = await request('thread.read', { id, limit: state.limit })
    if (state.selected !== id) return
    state.entries = entries
    state.threadError = ''
    // A sent message is no longer pending once the thread shows it.
    const shown = new Set(entries.filter((entry) => entry.role === 'user').map((entry) => entry.text.trim()))
    state.pending = state.pending.filter((text) => !shown.has(text.trim()))
    const last = [...entries].reverse().find((entry) => entry.role !== 'event' && entry.text)
    if (last) state.previews.set(id, last.text.replace(/\s+/g, ' ').slice(0, 80))
    renderBots()
    renderInfo()
  } catch (error) {
    if (state.selected === id) state.threadError = `Could not load messages: ${errorText(error)}`
  } finally {
    reading = false
    if (state.selected === id) renderMessages(forceBottom)
  }
}

async function send(text: string): Promise<void> {
  const id = state.selected
  const body = text.trim()
  if (!id || !body) return
  const waiting = {
    newestTsAtSend: state.entries.reduce((newest, entry) => Math.max(newest, entry.ts), 0),
    startedAt: Date.now()
  }
  state.waiting.set(id, waiting)
  state.pending.push(body)
  renderMessages(true)
  try {
    const result = await request('message.send', { id, text: body }, 70_000)
    if (result?.sent !== true) throw new Error('The message was not confirmed. Check the conversation before sending it again.')
    if (state.selected === id) {
      state.threadError = ''
      renderMessages(true)
      void refreshThread(true)
    }
  } catch (error) {
    // A late failure must not remove a newer send's indicator, even after switching bots.
    if (state.waiting.get(id) === waiting) state.waiting.delete(id)
    if (state.selected !== id) return
    state.pending = state.pending.filter((item) => item !== body)
    state.threadError = `Not sent: ${errorText(error)}`
    if (!input.value) input.value = body
    renderMessages(true)
  }
}

// Poll while the panel is visible: quickly while a reply is expected, slowly otherwise.
setInterval(() => {
  if (document.visibilityState !== 'visible' || !state.selected || !modal.hidden) return
  renderMessages()
  const interval = replyState() === 'working' ? 1500 : 5000
  if (Date.now() - state.lastPoll >= interval) void refreshThread()
}, 500)

// ---------- Details ----------

function renderInfo(): void {
  const body = $('info-body')
  const bot = current()
  if (!bot) {
    body.replaceChildren()
    return
  }
  // Keep unsaved instruction edits across background refreshes.
  const editing = body.querySelector<HTMLTextAreaElement>('#instructions')
  if (editing && editing.dataset.bot === bot.id &&
    (document.activeElement === editing || editing.value !== editing.dataset.saved)) return

  const routines = routinesFrom(state.entries)
  const routineRows = el('div', { class: 'rows' })
  for (const routine of routines) {
    const remove = el('button', { class: 'link', type: 'button' }, 'Remove')
    remove.onclick = () =>
      confirmDialog({
        title: `Remove "${routine.name}"?`,
        body: `This asks ${bot.name} to delete the routine. The bot confirms in the chat.`,
        action: 'Ask bot to remove',
        run: () => send(removeRoutineMessage(routine.name))
      })
    routineRows.append(
      el(
        'div',
        { class: 'row' },
        el(
          'span',
          { class: 'text' },
          routine.name,
          el('div', { class: 'muted' }, `${routine.lastAction} ${timeLabel(routine.ts)}`)
        ),
        remove
      )
    )
  }
  if (!routines.length) {
    routineRows.append(el('div', { class: 'row muted' }, 'No routines in the loaded messages.'))
  }

  const schedule = el('button', { type: 'button' }, 'Schedule a task')
  schedule.onclick = () => scheduleDialog(bot)
  const findOlder = el('button', { class: 'link', type: 'button' }, 'Search older messages')
  findOlder.hidden = state.limit >= 200
  findOlder.onclick = () => {
    state.limit = 200
    void refreshThread()
  }

  const instructions = el('textarea', { id: 'instructions', rows: 6, value: bot.instructions })
  instructions.dataset.bot = bot.id
  instructions.dataset.saved = bot.instructions
  instructions.setAttribute('aria-label', 'Instructions')
  const saveError = el('div', { class: 'error' })
  const save = el('button', { type: 'button' }, 'Save instructions')
  save.onclick = async () => {
    save.disabled = true
    saveError.textContent = ''
    try {
      const value = instructions.value
      const bots = await request('bots.update', { id: bot.id, instructions: value })
      instructions.dataset.saved = value
      save.disabled = false
      applyWrite(bots)
    } catch (error) {
      saveError.textContent = errorText(error)
      save.disabled = false
    }
  }

  const hide = el('button', { type: 'button' }, bot.hidden ? 'Show in list' : 'Hide from list')
  hide.onclick = async () => {
    hide.disabled = true
    try {
      applyWrite(await request('bots.update', { id: bot.id, hidden: !bot.hidden }))
    } catch (error) {
      saveError.textContent = errorText(error)
      hide.disabled = false
    }
  }
  const remove = el('button', { class: 'danger', type: 'button' }, 'Delete bot')
  remove.onclick = () =>
    confirmDialog({
      title: `Delete ${bot.name}?`,
      body: 'This deletes the bot and its conversation from Grok Bot for good. It cannot be undone.',
      action: 'Delete bot',
      danger: true,
      run: async () => applyWrite(await request('bots.delete', { id: bot.id }))
    })

  body.replaceChildren(
    el('div', { class: 'profile' }, avatar(bot, 'large'), el('strong', {}, bot.name)),
    el(
      'div',
      { class: 'section' },
      el('h3', {}, 'Routines'),
      routineRows,
      el('div', { class: 'actions' }, schedule, findOlder)
    ),
    el(
      'div',
      { class: 'section' },
      el('h3', {}, 'Instructions'),
      instructions,
      el('div', { class: 'actions' }, save),
      saveError
    ),
    el('div', { class: 'section' }, el('h3', {}, 'Bot'), el('div', { class: 'actions' }, hide, remove))
  )
}

// ---------- Dialogs ----------

function closeDialog(): void {
  modal.hidden = true
  modal.replaceChildren()
}

function openDialog(title: string, content: Node[], action: HTMLButtonElement): HTMLElement {
  const cancel = el('button', { type: 'button' }, 'Cancel')
  cancel.onclick = closeDialog
  const error = el('div', { class: 'error' })
  const dialog = el(
    'form',
    { class: 'dialog' },
    el('h2', {}, title),
    ...content,
    error,
    el('div', { class: 'actions' }, cancel, action)
  )
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-label', title)
  modal.replaceChildren(dialog)
  modal.hidden = false
  ;(dialog.querySelector<HTMLElement>('input, textarea, select') ?? cancel).focus()
  return error
}

/** Wires a dialog's submit: runs `work`, closes on success, shows the error and stays open on failure. */
function submitWith(action: HTMLButtonElement, error: HTMLElement, work: () => Promise<unknown>): void {
  const form = action.form as HTMLFormElement
  form.onsubmit = async (event) => {
    event.preventDefault()
    action.disabled = true
    error.textContent = ''
    try {
      await work()
      closeDialog()
    } catch (failure) {
      error.textContent = errorText(failure)
      action.disabled = false
    }
  }
}

function confirmDialog(options: {
  title: string
  body: string
  action: string
  danger?: boolean
  run: () => Promise<unknown>
}): void {
  const action = el('button', { type: 'submit', class: options.danger ? 'danger' : 'primary' }, options.action)
  const error = openDialog(options.title, [el('p', {}, options.body)], action)
  submitWith(action, error, options.run)
}

function field(label: string, control: HTMLElement): HTMLElement[] {
  const id = `f-${label.toLowerCase().replace(/\W+/g, '-')}`
  control.id = id
  return [el('label', { htmlFor: id }, label), control]
}

function newBotDialog(): void {
  const name = el('input', { type: 'text', required: true, maxLength: 80, placeholder: 'Researcher' })
  const instructions = el('textarea', {
    rows: 5,
    maxLength: 8000,
    placeholder: 'What this bot is for and how it should work (optional)'
  })
  const action = el('button', { type: 'submit', class: 'primary' }, 'Create bot')
  const error = openDialog(
    'New bot',
    [...field('Name', name), ...field('Instructions', instructions)],
    action
  )
  submitWith(action, error, async () => {
    const wanted = name.value.trim()
    const before = new Set(state.bots.map((bot) => bot.id))
    const bots = await request('bots.create', { name: wanted, instructions: instructions.value })
    applyWrite(bots)
    const created =
      bots?.find((bot) => !before.has(bot.id)) ?? bots?.find((bot) => bot.name === wanted)
    if (created) select(created.id)
  })
}

function scheduleDialog(bot: Bot): void {
  const name = el('input', { type: 'text', required: true, maxLength: 80, placeholder: 'Daily summary' })
  const task = el('textarea', {
    rows: 4,
    required: true,
    maxLength: 4000,
    placeholder: 'What the bot should do each time'
  })
  const repeat = el('select', {})
  const choices: [string, string][] = [
    ['every day', 'Every day'],
    ['every weekday (Monday to Friday)', 'Weekdays'],
    ['every week on Monday', 'Weekly on Monday'],
    ['every hour', 'Every hour'],
    ['once', 'Once'],
    ['custom', 'Custom…']
  ]
  for (const [value, label] of choices) repeat.append(el('option', { value }, label))
  const time = el('input', { type: 'time', value: '09:00' })
  const custom = el('input', {
    type: 'text',
    maxLength: 200,
    placeholder: 'every 15 minutes on weekdays, 9am to 5pm'
  })
  const timeField = el('div', {}, ...field('Time', time))
  const customField = el('div', { hidden: true }, ...field('When', custom))
  repeat.onchange = () => {
    customField.hidden = repeat.value !== 'custom'
    timeField.hidden = repeat.value === 'custom' || repeat.value === 'every hour'
    custom.required = repeat.value === 'custom'
  }
  const action = el('button', { type: 'submit', class: 'primary' }, 'Ask bot to schedule')
  const error = openDialog(
    `Schedule a task for ${bot.name}`,
    [
      el('p', { class: 'muted' }, 'Grok Bot sets up routines from chat, so this sends the request as a message. The bot confirms once it is scheduled.'),
      ...field('Name', name),
      ...field('Task', task),
      ...field('Repeat', repeat),
      timeField,
      customField
    ],
    action
  )
  submitWith(action, error, async () => {
    const when =
      repeat.value === 'custom'
        ? custom.value
        : repeat.value === 'every hour'
          ? repeat.value
          : repeat.value === 'once'
            ? `once, at the next ${time.value}`
            : `${repeat.value} at ${time.value}`
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (state.selected !== bot.id) throw new Error('The selected bot changed. Try again.')
    void send(scheduleMessage({ name: name.value, task: task.value, when, timeZone }))
    state.infoOpen = false
    setView()
  })
}

// ---------- Wiring ----------

function showSetup(message: string): void {
  const retry = el('button', { class: 'primary', type: 'button' }, 'Retry')
  retry.onclick = () => void start()
  $('empty').replaceChildren(
    el('h2', {}, 'Connect to Grok Bot'),
    el('p', {}, message),
    el('p', { class: 'muted' }, 'Bot Deck uses the Grok Bot desktop app you are signed in to on this Mac. Open the Grok Bot app, sign in, then press Retry.'),
    el('p', { class: 'muted' }, 'To do that it reads the app’s saved login from your keychain. macOS may ask you to allow this the first time. The login stays in memory and is only sent to Grok Bot.'),
    retry
  )
  app.dataset.view = 'empty'
}

let starting = false
async function start(): Promise<void> {
  if (starting) return
  starting = true
  try {
    const status = await request('status', {})
    if (!status.ok) return showSetup(status.message)
    await loadBots()
  } catch (error) {
    showSetup(errorText(error))
  } finally {
    starting = false
  }
}
const search = $<HTMLInputElement>('bot-search')
function closeSearch(): void {
  search.value = ''
  state.query = ''
  $('search-field').hidden = true
  $('search-bots').setAttribute('aria-expanded', 'false')
  renderBots()
  $('search-bots').focus()
}
$('search-bots').onclick = () => {
  if (!$('search-field').hidden) return closeSearch()
  $('search-field').hidden = false
  $('search-bots').setAttribute('aria-expanded', 'true')
  search.focus()
}
search.oninput = () => {
  if (!search.value) return closeSearch()
  state.query = search.value
  renderBots()
}
search.onkeydown = event => {
  if (event.key === 'Escape' && !event.isComposing) {
    event.preventDefault()
    closeSearch()
  }
}
$('new-bot').onclick = newBotDialog
$('back').onclick = () => {
  state.selected = null
  state.infoOpen = false
  renderBots()
  setView()
}
$('open-info').onclick = () => {
  state.infoOpen = !state.infoOpen
  if (state.infoOpen && state.limit < 200) {
    state.limit = 200
    void refreshThread()
  }
  renderInfo()
  setView()
}
$('close-info').onclick = () => {
  state.infoOpen = false
  setView()
}

$('composer').onsubmit = (event) => {
  event.preventDefault()
  const text = input.value
  input.value = ''
  input.style.height = ''
  void send(text)
}
input.oninput = () => {
  input.style.height = 'auto'
  input.style.height = `${Math.min(input.scrollHeight + 2, 160)}px`
}
input.onkeydown = (event) => {
  // Enter sends; Shift+Enter adds a line; Enter that confirms an IME composition does neither.
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    $<HTMLFormElement>('composer').requestSubmit()
  }
}

messagesEl.onclick = (event) => {
  const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[data-external]')
  if (!link) return
  event.preventDefault()
  void frame.shell?.openExternal(link.dataset.external as string)
}
modal.onclick = (event) => {
  if (event.target === modal) closeDialog()
}
document.onkeydown = (event) => {
  if (event.key === 'Escape' && !modal.hidden) closeDialog()
}

// When the panel is widened enough to show the chat beside the list, fill it.
wide.onchange = () => {
  const first = state.bots.find((bot) => !bot.hidden)
  if (wide.matches && !state.selected && first) select(first.id)
}

renderHeader()
renderMessages()
void start()
