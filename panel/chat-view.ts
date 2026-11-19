import { createCapabilityPicker } from './capability-picker.ts'
import { createLearningSheet } from './learning-sheet.ts'
import type { CapabilityHooks } from './capability-picker.ts'
import { dayLabel, threadPreview } from './presentation.ts'
import type { Requests } from '../worker/protocol.ts'
import type { Bot } from '../shared/roster.ts'
import { computerLabel, modelText } from '../shared/roster.ts'
import {
  collapseActivities,
  refreshInterval,
  sendDraft,
  reconcileAttempts,
  elapsedTime,
  displayText
} from '../shared/chat.ts'
import type { Thread, Composer } from '../shared/chat.ts'
import { MAX_ATTACHMENTS, uploadProblem } from '../shared/attachments.ts'
import type { SentFile, Uploaded } from '../shared/attachments.ts'

/** A file picked for the next message: uploaded at once, sent with the message. */
type Pending = {
  id: number
  name: string
  kind: Uploaded['kind']
  state: 'uploading' | 'ready' | 'failed'
  attachment?: Uploaded
  preview?: string
}
function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

export type FrameApi = {
  plugin: {
    request<K extends keyof Requests>(
      name: K,
      input: Requests[K]['input']
    ): Promise<Requests[K]['output']>
  }
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
export function createChatView(
  root: HTMLElement,
  frame: FrameApi,
  avatar: (bot: Bot) => HTMLElement,
  open: (id: string) => void,
  back: () => void,
  preview?: (id: string, text: string | undefined) => void,
  capabilities?: CapabilityHooks,
  /** Why the Bot Dashboard can't open here, or undefined when it can. */
  dashboardNote: () => string | undefined = () => undefined
) {
  let bot: Bot | undefined
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let reading = false
  let identityKey = ''
  let clockTimer: ReturnType<typeof setTimeout> | undefined
  const observedWorking = new Map<string, number>()
  const finishedWorking = new Set<string>()
  let loaded = false
  let workingKey = ''
  let thread: Thread = { messages: [], hasMore: false }
  const drafts = new Map<string, Composer>()
  let state: Composer = { draft: '', attempts: [], sending: false }
  const pendingByBot = new Map<string, Pending[]>()
  let nextPending = 0
  const pending = () => (bot ? (pendingByBot.get(bot.id) ?? []) : [])
  const ready = () => pending().filter((p) => p.state === 'ready').map((p) => p.attachment!)
  const notify = (text: string) => (capabilities?.notify ? capabilities.notify(text) : (note.textContent = text))
  // Drafts, pending sends and uploads belong to the host they were made on: a host change drops
  // them, even for a bot with the same ID.
  let uploadHost = capabilities?.hostGeneration?.()
  function syncHost(): void {
    const host = capabilities?.hostGeneration?.()
    if (host === uploadHost) return
    uploadHost = host
    for (const list of pendingByBot.values())
      for (const entry of list) if (entry.preview) URL.revokeObjectURL?.(entry.preview)
    pendingByBot.clear()
    drafts.clear()
    skillCounts.clear()
  }
  function addFiles(files: File[]): void {
    syncHost()
    if (!bot || !files.length) return
    if (dashboardNote()) {
      notify('Files and photos can be sent only when bots run on this computer.')
      return
    }
    const id = bot.id
    const host = uploadHost
    const list = pendingByBot.get(id) ?? []
    pendingByBot.set(id, list)
    for (const file of files) {
      if (list.length >= MAX_ATTACHMENTS) {
        notify(`Send at most ${MAX_ATTACHMENTS} files in one message.`)
        break
      }
      const mime = file.type || 'application/octet-stream'
      const problem = uploadProblem(file.name || 'File', mime, file.size)
      if (problem) {
        notify(problem)
        continue
      }
      const entry: Pending = {
        id: ++nextPending,
        name: file.name || 'Pasted image',
        kind: mime.startsWith('image/') ? 'image' : 'file',
        state: 'uploading',
        ...(mime.startsWith('image/') && typeof URL.createObjectURL === 'function'
          ? { preview: URL.createObjectURL(file) }
          : {})
      }
      list.push(entry)
      void (async () => {
        try {
          const data = base64(new Uint8Array(await file.arrayBuffer()))
          const uploaded = await frame.plugin.request('attachment.upload', { name: entry.name, mime, data })
          // The host changed while this was uploading: the file is not for the new host.
          if (host !== capabilities?.hostGeneration?.()) return
          entry.attachment = uploaded
          entry.kind = uploaded.kind
          entry.state = 'ready'
        } catch (error) {
          if (host !== capabilities?.hostGeneration?.()) return
          entry.state = 'failed'
          notify(error instanceof Error ? error.message : `Could not upload ${entry.name}.`)
        }
        if (bot?.id === id) renderTray()
      })()
    }
    renderTray()
  }
  function removePending(entry: Pending): void {
    if (!bot) return
    const list = pendingByBot.get(bot.id) ?? []
    pendingByBot.set(bot.id, list.filter((p) => p !== entry))
    if (entry.preview) URL.revokeObjectURL?.(entry.preview)
    renderTray()
    input.focus()
  }
  function renderTray(): void {
    const items = pending()
    tray.hidden = !items.length
    tray.replaceChildren(
      ...items.map((entry) => {
        const chip = node('div')
        chip.className = `composer-file ${entry.state}`
        if (entry.preview) {
          const img = node('img')
          img.src = entry.preview
          img.alt = ''
          chip.append(img)
        } else chip.append(node('span', entry.kind === 'image' ? '🖼' : '📎'))
        const name = node('span', entry.name)
        name.className = 'composer-file-name'
        chip.append(name)
        if (entry.state !== 'ready')
          chip.append(node('small', entry.state === 'uploading' ? 'Uploading…' : 'Failed'))
        const remove = button(`Remove ${entry.name}`, () => removePending(entry))
        remove.textContent = '×'
        remove.className = 'composer-file-remove'
        chip.append(remove)
        return chip
      })
    )
    updateSend()
  }
  function updateSend(): void {
    const files = ready()
    send.disabled =
      state.sending ||
      pending().some((p) => p.state === 'uploading') ||
      (!state.draft.trim() && !files.length) ||
      state.draft.length > 16000
  }
  function messageBody(parent: HTMLElement, text: string, attachments: SentFile[] = []): void {
    if (text) linkedText(parent, displayText(text))
    if (!attachments.length) return
    const files = node('div')
    files.className = 'chat-files'
    for (const file of attachments)
      files.append(node('span', `${file.kind === 'image' ? '🖼' : '📎'} ${file.name}`))
    parent.append(files)
  }
  const header = node('div')
  header.className = 'thread-header'
  const identity = node('div')
  identity.className = 'thread-identity'
  const backButton = button('←', () => {
    close()
    back()
  })
  backButton.className = 'thread-back'
  backButton.setAttribute('aria-label', 'Back to bots')
  // Where the bot works, as OpenMausBot's chat header shows it: a computer icon.
  const computerButton = button('Backend', () => {
    if (!bot || !picker) return
    learning?.close()
    void picker.open('computer', bot, computerButton)
    computerButton.setAttribute('aria-expanded', 'true')
  })
  computerButton.className = 'computer-button'
  computerButton.innerHTML =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.75" y="2.5" width="12.5" height="8.5" rx="1.5"/><path d="M5.5 13.75h5M8 11v2.75"/></svg>'
  computerButton.setAttribute('aria-haspopup', 'menu')
  computerButton.setAttribute('aria-expanded', 'false')
  header.append(backButton, identity, ...(capabilities ? [computerButton] : []))
  const capabilityMenu = node('div')
  capabilityMenu.className = 'bot-menu capability-menu'
  capabilityMenu.hidden = true
  const modelPill = button('Model', () => {
    if (!bot || !picker) return
    learning?.close()
    void picker.open('model', bot, modelPill, 'models')
    modelPill.setAttribute('aria-expanded', 'true')
  })
  const connectorPill = button('Connectors', () => {
    if (!bot || !picker) return
    learning?.close()
    void picker.open('connectors', bot, connectorPill)
    connectorPill.setAttribute('aria-expanded', 'true')
  })
  const skillsPill = button('Skills', () => {
    if (!bot || !learning) return
    picker?.close(false)
    void learning.open(bot, skillsPill)
    skillsPill.setAttribute('aria-expanded', 'true')
  })
  // Enabled skills per bot, once its sheet has been opened on this host.
  const skillCounts = new Map<string, number>()
  const learningRoot = node('div')
  const learning = capabilities
    ? createLearningSheet(
        learningRoot,
        frame,
        {
          notify,
          hostGeneration: capabilities.hostGeneration,
          counted: (id, count) => {
            skillCounts.set(id, count)
            renderCapabilities()
          }
        },
        () => skillsPill.setAttribute('aria-expanded', 'false')
      )
    : undefined
  const bar = node('div')
  bar.className = 'chat-capabilities'
  for (const pill of [modelPill, connectorPill, skillsPill]) {
    pill.className = 'capability-pill'
    pill.setAttribute('aria-haspopup', 'menu')
    pill.setAttribute('aria-expanded', 'false')
    bar.append(pill)
  }
  skillsPill.setAttribute('aria-haspopup', 'dialog')
  const picker = capabilities
    ? createCapabilityPicker(
        capabilityMenu,
        frame,
        {
          ...capabilities,
          busyChanged: () => renderCapabilities(),
          connectorCountChanged: (id, count) => {
            if (bot?.id !== id) return
            bot = { ...bot, connectorCount: count }
            renderCapabilities()
          },
          changed: () => capabilities.changed()
        },
        () => {
          computerButton.setAttribute('aria-expanded', 'false')
          modelPill.setAttribute('aria-expanded', 'false')
          connectorPill.setAttribute('aria-expanded', 'false')
          renderCapabilities()
        }
      )
    : undefined
  function renderCapabilities() {
    if (!bot) return
    const busy = bot.state === 'working' || !!picker?.switching()
    const why =
      bot.state === 'working'
        ? 'Wait until the reply finishes to change models.'
        : picker?.switching()
          ? 'Saving capability changes…'
          : undefined
    const where = computerLabel(bot.computer)
    computerButton.title = `Backend: ${where}`
    computerButton.setAttribute('aria-label', `Backend: ${where}`)
    computerButton.disabled = !!picker?.switching()
    modelPill.textContent = `${modelText(bot) || 'Model'} ▾`
    modelPill.setAttribute('aria-label', `Model: ${modelText(bot) || 'not selected'}`)
    modelPill.disabled = busy
    modelPill.title = why ?? 'Choose a model'
    const count = bot.connectorCount ?? 0
    connectorPill.title = 'Choose connectors for this bot'
    connectorPill.textContent = `${count ? `Connectors · ${count}` : 'Connectors'} ▾`
    connectorPill.setAttribute('aria-label', count ? `Connectors: ${count} allowed` : 'Connectors')
    const skills = skillCounts.get(bot.id)
    skillsPill.title = 'Skills and memory'
    skillsPill.textContent = `${skills ? `Skills · ${skills}` : 'Skills'} ▾`
    skillsPill.setAttribute('aria-label', skills ? `Skills and memory: ${skills} skills on` : 'Skills and memory')
  }
  const list = node('div')
  list.className = 'messages'
  list.setAttribute('aria-label', 'Recent messages')
  const note = node('p')
  note.className = 'thread-note'
  note.setAttribute('role', 'status')
  const working = node('div')
  working.className = 'working-line'
  const composer = node('form')
  composer.className = 'composer'
  const label = node('label', 'Message')
  label.htmlFor = 'quick-message'
  const input = node('textarea')
  input.id = 'quick-message'
  input.maxLength = 16000
  input.rows = 3
  const send = node('button', '↑')
  send.type = 'submit'
  send.setAttribute('aria-label', 'Send')
  send.title = 'Send'
  const fileInput = node('input')
  fileInput.type = 'file'
  fileInput.multiple = true
  fileInput.hidden = true
  fileInput.setAttribute('aria-hidden', 'true')
  const attach = node('button', '+')
  attach.type = 'button'
  attach.className = 'attach'
  attach.setAttribute('aria-label', 'Attach files or photos')
  attach.title = 'Attach files or photos'
  attach.addEventListener('click', () => fileInput.click())
  fileInput.addEventListener('change', () => {
    addFiles(Array.from(fileInput.files ?? []))
    fileInput.value = ''
  })
  const tray = node('div')
  tray.className = 'composer-files'
  tray.setAttribute('aria-label', 'Attachments')
  const box = node('div')
  box.className = 'composer-box'
  box.append(tray, input)
  composer.append(label, attach, fileInput, box, send)
  working.hidden = true
  const workingText = node('span')
  const workingLabel = document.createTextNode('')
  const sheen = node('span')
  sheen.className = 'working-sheen'
  sheen.setAttribute('aria-hidden', 'true')
  const letters = node('span')
  sheen.append(letters)
  workingText.append(workingLabel, sheen)
  root.append(header, ...(capabilities ? [bar] : []), list, note, working, composer, capabilityMenu, ...(learning ? [learningRoot] : []))
  const atBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 40
  function linkedText(parent: HTMLElement, text: string): void {
    const pattern = /https?:\/\/[^\s<>]+/g
    let start = 0
    for (const match of text.matchAll(pattern)) {
      parent.append(document.createTextNode(text.slice(start, match.index)))
      const link = node('a', match[0])
      link.href = match[0]
      link.addEventListener('click', (event) => {
        event.preventDefault()
        if (!frame.shell) {
          note.textContent = 'Open the full chat to use this link.'
          return
        }
        void frame.shell.openExternal(match[0]).catch(() => {
          note.textContent = 'Could not open this link.'
        })
      })
      parent.append(link)
      start = match.index + match[0].length
    }
    parent.append(document.createTextNode(text.slice(start)))
  }
  function render(): void {
    if (!bot) return
    const bottom = atBottom(),
      top = list.scrollTop
    const nextIdentityKey = JSON.stringify([
      bot.id,
      bot.name,
      capabilities ? '' : modelText(bot),
      bot.avatar
    ])
    if (identityKey !== nextIdentityKey) {
      identityKey = nextIdentityKey
      identity.replaceChildren(avatar(bot))
      const names = node('div')
      names.append(node('strong', bot.name))
      if (!capabilities) names.append(node('small', modelText(bot)))
      identity.append(names)
    }
    renderCapabilities()
    input.placeholder = `Message ${bot.name}`
    renderWorking()
    list.replaceChildren()
    if (thread.hasMore) list.append(node('p', 'Earlier messages are in the full chat.'))
    let previousAt: number | undefined
    for (const message of collapseActivities(thread.messages)) {
      const stamp = dayLabel(message.at, previousAt)
      if (stamp) {
        const separator = node('time')
        separator.className = 'day-separator'
        separator.dateTime = new Date(message.at).toISOString()
        separator.setAttribute('data-label', stamp)
        separator.setAttribute('aria-label', stamp)
        list.append(separator)
      }
      previousAt = message.at
      const item = node('div')
      item.className = `chat-message ${message.kind} ${message.role}`
      if (message.kind === 'text') messageBody(item, message.text, message.attachments)
      else item.append(document.createTextNode(message.text))
      if (message.kind === 'unsupported')
        item.append(
          button('Open bot', () => {
            if (bot) open(bot.id)
          })
        )
      list.append(item)
    }
    for (const attempt of state.attempts) {
      const item = node('div')
      item.className = `chat-message text user ${attempt.state}`
      messageBody(item, attempt.text, attempt.attachments)
      if (attempt.error || attempt.state === 'pending')
        item.append(node('small', attempt.error ?? 'Sending…'))
      list.append(item)
    }
    if (!thread.messages.length && !state.attempts.length)
      list.append(node('p', 'No recent messages.'))
    attach.hidden = !!dashboardNote()
    renderTray()
    if (input.value !== state.draft) input.value = state.draft
    list.scrollTop = bottom ? list.scrollHeight : top
  }
  function renderWorking(): void {
    clearTimeout(clockTimer)
    if (!bot) return
    if (bot.state === 'working' && !observedWorking.has(bot.id))
      observedWorking.set(bot.id, Date.now())
    const since = state.sendFailed
      ? undefined
      : (state.wait?.since ??
        (bot.state === 'working' && !finishedWorking.has(bot.id)
          ? observedWorking.get(bot.id)
          : undefined))
    working.hidden = since === undefined
    if (since === undefined) {
      workingKey = ''
      working.replaceChildren()
      return
    }
    const key = JSON.stringify([bot.id, bot.avatar])
    if (workingKey !== key) {
      workingKey = key
      working.replaceChildren(avatar({ ...bot, state: 'working' }), workingText)
    }
    workingLabel.textContent = `Working · ${elapsedTime(since, Date.now())}`
    letters.setAttribute('data-text', workingLabel.textContent)
    if (!document.hidden) clockTimer = setTimeout(renderWorking, 1000)
  }
  function schedule(): void {
    clearTimeout(timer)
    if (bot && !document.hidden)
      timer = setTimeout(
        () => void read(),
        refreshInterval(bot.state, state.sending || !!state.wait)
      )
  }
  async function read(): Promise<void> {
    if (!bot || document.hidden || reading) return
    const id = bot.id,
      token = generation
    reading = true
    try {
      const next = await frame.plugin.request('thread.read', { botId: id, limit: 20 })
      if (token !== generation) return
      const reply = next.messages.some(
        (entry) =>
          entry.role === 'bot' &&
          entry.kind === 'text' &&
          (state.wait
            ? !state.wait.baseline.has(entry.id) && entry.at >= state.wait.sentAt - 5000
            : loaded && !thread.messages.some((old) => old.id === entry.id))
      )
      if (reply) {
        state.wait = undefined
        if (bot?.state === 'working') finishedWorking.add(bot.id)
      }
      thread = next
      preview?.(id, threadPreview(next.messages))
      loaded = true
      Object.assign(state, reconcileAttempts(state.attempts, next.messages, state.matchedIds))
      note.textContent = ''
      render()
    } catch {
      if (token === generation) {
        note.replaceChildren(
          document.createTextNode('Could not refresh messages. '),
          button('Open bot', () => open(id))
        )
      }
    } finally {
      if (token === generation) {
        reading = false
        schedule()
      }
    }
  }
  composer.addEventListener('submit', (event) => {
    event.preventDefault()
    syncHost()
    if (!bot) return
    const id = bot.id,
      current = state
    const all = pending()
    if (all.some((p) => p.state === 'uploading')) return
    const sending = all.filter((p) => p.state === 'ready')
    const files = sending.map((p) => p.attachment!)
    // Enter submits even while Send is disabled: refuse here, before any file leaves the tray.
    if (current.sending || (!current.draft.trim() && !files.length) || current.draft.length > 16000)
      return
    pendingByBot.set(id, all.filter((p) => p.state !== 'ready'))
    const host = uploadHost
    void sendDraft(
      current,
      thread.messages.map((message) => message.id),
      (text, attachments) =>
        frame.plugin.request('message.send', {
          botId: id,
          text,
          ...(attachments.length ? { attachments } : {})
        }),
      () => {
        if (state === current && bot?.id === id) {
          render()
          schedule()
        }
      },
      Date.now,
      files
    ).then(() => {
      // The host changed while this was sending: its draft and files are not the new host's.
      if (host !== capabilities?.hostGeneration?.()) {
        for (const entry of sending) if (entry.preview) URL.revokeObjectURL?.(entry.preview)
        return
      }
      if (current.sendFailed) {
        // Keep failed files with the restored draft so the person can retry as is.
        pendingByBot.set(id, [...sending, ...(pendingByBot.get(id) ?? [])])
      } else for (const entry of sending) if (entry.preview) URL.revokeObjectURL?.(entry.preview)
      if (bot?.id === id) {
        renderTray()
        void read()
      }
    })
  })
  input.addEventListener('input', () => {
    state.draft = input.value
    updateSend()
  })
  input.addEventListener('paste', (event) => {
    const files = Array.from(event.clipboardData?.files ?? [])
    if (!files.length) return
    event.preventDefault()
    addFiles(files)
  })
  composer.addEventListener('dragover', (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return
    event.preventDefault()
    composer.classList?.add('dropping')
  })
  composer.addEventListener('dragleave', () => composer.classList?.remove('dropping'))
  composer.addEventListener('drop', (event) => {
    composer.classList?.remove('dropping')
    const files = Array.from(event.dataTransfer?.files ?? [])
    if (!files.length) return
    event.preventDefault()
    addFiles(files)
  })
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault()
      composer.requestSubmit()
    }
  })
  function close(): void {
    generation++
    picker?.close(false)
    learning?.close()
    bot = undefined
    reading = false
    clearTimeout(timer)
    clearTimeout(clockTimer)
    root.hidden = true
  }
  document.addEventListener('visibilitychange', () => {
    clearTimeout(timer)
    clearTimeout(clockTimer)
    if (!document.hidden) {
      renderWorking()
      void read()
    }
  })
  window.addEventListener('pagehide', () => {
    clearTimeout(timer)
    clearTimeout(clockTimer)
  })
  window.addEventListener('pageshow', () => {
    renderWorking()
    void read()
  })
  return {
    close,
    dismissCapabilities: () => {
      picker?.close(false)
      learning?.close()
    },
    open(next: Bot) {
      close()
      syncHost()
      bot = next
      loaded = false
      thread = { messages: [], hasMore: false }
      state = drafts.get(next.id) ?? { draft: '', attempts: [], sending: false }
      drafts.set(next.id, state)
      root.hidden = false
      note.textContent = 'Loading…'
      render()
      list.scrollTop = list.scrollHeight
      input.focus()
      void read()
    },
    update(next: Bot[]) {
      for (const entry of next) {
        if (entry.state === 'working') {
          if (!observedWorking.has(entry.id)) observedWorking.set(entry.id, Date.now())
        } else {
          observedWorking.delete(entry.id)
          finishedWorking.delete(entry.id)
        }
      }
      if (!bot) return
      const latest = next.find((item) => item.id === bot!.id && !item.addable)
      if (!latest) {
        close()
        back()
        return
      }
      const changed = latest.state !== bot.state
      if (changed && latest.state === 'working') state.sendFailed = false
      bot = latest
      picker?.update(latest)
      render()
      if (changed) schedule()
    }
  }
}
