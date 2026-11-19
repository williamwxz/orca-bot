import { assert, test } from 'orca/testing'
import { createChatView } from './chat-view.ts'
import type { Bot } from '../shared/roster.ts'

// A deliberately small DOM fake: no browser, network, subprocess or worker defaults.
class Element {
  tag: string
  text = ''
  children: Element[] = []
  events = new Map<string, ((event: any) => void)[]>()
  attributes = new Map<string, string>()
  className = ''
  dataset: Record<string, string> = {}
  style = {}
  contains(node: Element): boolean {
    return this === node || this.children.some((c) => c.contains(node))
  }
  getBoundingClientRect() {
    return { left: 20, bottom: 80, width: 240, height: 180 }
  }
  value = ''
  hidden = false
  disabled = false
  scrollHeight = 800
  scrollTop = 0
  clientHeight = 200
  constructor(tag: string) {
    this.tag = tag
  }
  set textContent(value: string) {
    this.text = value
    this.children = []
  }
  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join('')
  }
  append(...children: Element[]) {
    this.children.push(...children)
  }
  replaceChildren(...children: Element[]) {
    this.text = ''
    this.children = children
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value)
  }
  get firstElementChild() {
    return this.children[0]
  }
  addEventListener(name: string, fn: (event: any) => void) {
    this.events.set(name, [...(this.events.get(name) ?? []), fn])
  }
  emit(name: string, event: any = {}) {
    for (const fn of this.events.get(name) ?? [])
      fn({ preventDefault() {}, stopPropagation() {}, ...event })
  }
  focus() {
    ;(document as any).activeElement = this
  }
  requestSubmit() {
    this.emit('submit')
  }
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
const all = (node: Element): Element[] => [node, ...node.children.flatMap(all)]

test('panel renders safe text, keeps scroll and avatar, respects IME, restores failures, and links through shell', async () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const documentFake = new Element('document') as any
  documentFake.createElement = (tag: string) => new Element(tag)
  documentFake.createTextNode = (text: string) => {
    const el = new Element('#text')
    el.textContent = text
    return el
  }
  documentFake.hidden = false
  Object.defineProperty(globalThis, 'document', { value: documentFake, configurable: true })
  Object.defineProperty(globalThis, 'window', { value: new Element('window'), configurable: true })
  const root = new Element('section')
  const bot: Bot = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    name: 'Helper',
    modelLabel: 'Codex',
    main: false,
    unread: true,
    state: 'working',
    title: ''
  }
  const calls: string[] = [],
    links: string[] = []
  let fail!: (error: Error) => void
  try {
    const view = createChatView(
      root as any,
      {
        plugin: {
          request: (async (name: string) => {
            calls.push(name)
            if (name === 'message.send')
              return new Promise((_resolve, reject) => {
                fail = reject
              })
            return {
              hasMore: true,
              messages: [
                {
                  id: '1',
                  at: 1,
                  role: 'bot',
                  kind: 'text',
                  text: '<script>literal</script>\nhttps://example.invalid'
                },
                {
                  id: '2',
                  at: 2,
                  role: 'bot',
                  kind: 'unsupported',
                  text: 'This needs the full chat.'
                }
              ]
            }
          }) as any
        },
        shell: {
          openExternal: async (url) => {
            links.push(url)
          }
        }
      },
      () => new Element('avatar') as any,
      () => {},
      () => {}
    )
    view.open(bot)
    await flush()
    assert.match(root.textContent, /Earlier messages are in the full chat/)
    assert.match(root.textContent, /<script>literal<\/script>/)
    assert.equal(
      all(root).some((el) => el.tag === 'script'),
      false
    )
    all(root)
      .find((el) => el.tag === 'a')!
      .emit('click')
    assert.deepEqual(links, ['https://example.invalid'])
    const list = all(root).find((el) => el.className === 'messages')!
    list.scrollTop = 37
    const identity = all(root).find((el) => el.className === 'thread-identity')!
    const firstAvatar = identity.children[0]
    view.update([bot])
    assert.equal(list.scrollTop, 37)
    assert.equal(identity.children[0], firstAvatar)
    const input = all(root).find((el) => el.tag === 'textarea')!
    input.value = 'Reply'
    input.emit('input')
    input.emit('keydown', { key: 'Enter', isComposing: true })
    input.emit('keydown', { key: 'Enter', shiftKey: true })
    assert.equal(calls.filter((call) => call === 'message.send').length, 0)
    input.emit('keydown', { key: 'Enter' })
    assert.match(root.textContent, /Sending…/)
    fail(new Error('Could not confirm sending.'))
    await flush()
    assert.equal(input.value, 'Reply')
    assert.match(root.textContent, /Could not confirm sending/)
    assert.equal(all(root).find((el) => el.className === 'working-line')!.hidden, true)
    assert.equal(calls.filter((call) => call === 'message.send').length, 1)
    documentFake.hidden = true
    documentFake.emit('visibilitychange')
    const before = calls.length
    await flush()
    assert.equal(calls.length, before)
    root.children[0].children[0].emit('click')
    assert.equal(root.hidden, true)
  } finally {
    // Always clear scheduled fake-view work, including on an assertion failure.
    root.children[0]?.children[0]?.emit('click')
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
    else delete (globalThis as any).document
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as any).window
  }
})

test('accepted sends render once, clock ticks independently, replies stop it, and routines retain first observation', async () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalNow = Date.now,
    originalSet = globalThis.setTimeout,
    originalClear = globalThis.clearTimeout
  let now = 10000,
    serial = 0
  const timers = new Map<number, { fn: () => void; delay: number }>()
  const doc = new Element('document') as any
  doc.createElement = (tag: string) => new Element(tag)
  doc.createTextNode = (text: string) => {
    const el = new Element('#text')
    el.textContent = text
    return el
  }
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true })
  Object.defineProperty(globalThis, 'window', { value: new Element('window'), configurable: true })
  Date.now = () => now
  globalThis.setTimeout = ((fn: () => void, delay: number) => {
    timers.set(++serial, { fn, delay })
    return serial
  }) as any
  globalThis.clearTimeout = ((id: number) => {
    timers.delete(id)
  }) as any
  const root = new Element('section')
  const bot: Bot = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    name: 'Helper',
    modelLabel: 'gpt-6',
    main: false,
    unread: false,
    state: 'idle',
    title: ''
  }
  let messages: any[] = [],
    reads = 0
  let accept!: () => void
  const refresh = async () => {
    doc.emit('visibilitychange')
    await flush()
  }
  try {
    const view = createChatView(
      root as any,
      {
        plugin: {
          request: (async (name: string) => {
            if (name === 'message.send')
              return new Promise<void>((resolve) => {
                accept = resolve
              })
            reads++
            return { hasMore: false, messages }
          }) as any
        }
      },
      () => new Element('avatar') as any,
      () => {},
      () => {}
    )
    view.open(bot)
    await flush()
    const input = all(root).find((el) => el.tag === 'textarea')!
    const working = all(root).find((el) => el.className === 'working-line')!
    const list = all(root).find((el) => el.className === 'messages')!
    input.value = 'Hi'
    input.emit('input')
    input.emit('keydown', { key: 'Enter' })
    assert.match(list.textContent, /Hi/)
    accept()
    await flush()
    assert.equal(list.textContent, 'Hi')
    assert.equal(working.hidden, false)
    assert.match(working.textContent, /Working · 0s/)
    const beforeReads = reads
    now += 3000
    const tick = [...timers.values()].find((timer) => timer.delay === 1000)!
    tick.fn()
    assert.match(working.textContent, /Working · 3s/)
    assert.equal(reads, beforeReads)
    messages = [{ id: 'hi', at: 10000, role: 'user', kind: 'text', text: 'Hi' }]
    await refresh()
    assert.equal(list.textContent, 'Hi')
    assert.equal(working.hidden, false)
    view.update([{ ...bot, state: 'working' }])
    messages = [...messages, { id: 'reply', at: now, role: 'bot', kind: 'text', text: 'Hello!' }]
    await refresh()
    assert.equal(list.textContent, 'HiHello!')
    assert.equal(working.hidden, true)
    view.update([{ ...bot, state: 'working' }])
    assert.equal(working.hidden, true)
    root.children[0].children[0].emit('click')
    view.update([bot])
    view.update([{ ...bot, state: 'working' }])
    now += 65000
    view.open({ ...bot, state: 'working' })
    await flush()
    assert.match(working.textContent, /Working · 1m 5s/)
    assert.equal(working.hidden, false)
    root.children[0].children[0].emit('click')
    assert.equal(timers.size, 0)
  } finally {
    root.children[0]?.children[0]?.emit('click')
    Date.now = originalNow
    globalThis.setTimeout = originalSet
    globalThis.clearTimeout = originalClear
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
    else delete (globalThis as any).document
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as any).window
  }
})

test('the gear opens bot settings, whose rows open the model and connector pickers, gated while working and dismissed on bot switch or close', async () => {
  const keys = ['document', 'window', 'setTimeout', 'clearTimeout'] as const
  const originals = keys.map((k) => Object.getOwnPropertyDescriptor(globalThis, k))
  const doc = Object.assign(new Element('document'), {
    createElement: (tag: string) => new Element(tag),
    createTextNode: (text: string) => Object.assign(new Element('text'), { textContent: text })
  })
  const win = Object.assign(new Element('window'), { innerWidth: 380, innerHeight: 700 })
  for (const [key, value] of [
    ['document', doc],
    ['window', win],
    ['setTimeout', () => 0],
    ['clearTimeout', () => {}]
  ] as const)
    Object.defineProperty(globalThis, key, { configurable: true, value })
  const root = new Element('root')
  let current: Bot = {
    id: 'a',
    name: 'Work',
    title: '',
    main: false,
    unread: false,
    state: 'idle',
    model: 'codex/gpt-6',
    connectorCount: 2,
    modelLabel: 'GPT-6'
  }
  const rows = {
    connectors: [
      {
        name: 'mail',
        rawName: 'gmail',
        provider: 'Cursor',
        fingerprint: 'exact',
        enabled: true,
        present: true,
        bots: ['a']
      },
      {
        name: 'docs',
        rawName: 'docs',
        provider: 'Codex',
        fingerprint: 'docs',
        enabled: true,
        present: true,
        bots: ['a']
      }
    ],
    bots: [{ id: 'a', name: 'Work' }]
  }
  const managed: unknown[] = []
  const calls: any[] = []
  let delayed: Promise<any> | undefined
  const view = createChatView(
    root as any,
    {
      plugin: {
        request: async (name: string, input: any) => {
          calls.push({ name, input })
          if (name === 'thread.read') return { messages: [], hasMore: false }
          if (name === 'learning.read') return { skills: [], waiting: 0 }
          if (name === 'schedules.list') return []
          if (name === 'models.list')
            return (
              delayed ?? {
                groups: [
                  {
                    instanceId: 'claude',
                    label: 'Claude',
                    models: [{ id: 'sonnet', label: 'Sonnet' }]
                  }
                ]
              }
            )
          if (name === 'mcp.act')
            rows.connectors.find((c) => c.name === input.name)!.bots = input.bots
          if (name === 'bots.act') {
            current = { ...current, model: 'claude/sonnet', modelLabel: 'Sonnet' }
            return { ok: true }
          }
          return structuredClone(rows)
        }
      }
    } as any,
    () => new Element('avatar') as any,
    () => {},
    () => {},
    undefined,
    {
      changed: async () => {
        view.update([current])
      },
      manage: (...args) => managed.push(args)
    }
  )
  const gear = () => all(root).find((n) => n.attributes.get('aria-label') === 'Bot settings')!
  const key = (k: string) => all(root).find((n) => n.dataset.key === k)!
  const sheet = () => all(root).find((n) => n.className.includes('bot-settings') && n.tag === 'div')!
  try {
    view.open(current)
    await flush()
    // The pills are gone; the model shows under the name and everything else is behind the gear.
    assert.equal(all(root).some((n) => n.className === 'capability-pill'), false)
    assert.ok(all(root).some((n) => n.tag === 'small' && n.textContent === 'GPT-6'))
    gear().emit('click')
    await flush()
    assert.equal(gear().attributes.get('aria-expanded'), 'true')
    assert.match(sheet().textContent, /Work settings/)
    assert.match(sheet().textContent, /Connectors2 allowed/)
    assert.deepEqual(calls.filter((c) => ['learning.read', 'schedules.list'].includes(c.name)).map((c) => c.input), [{ botId: 'a' }, { botId: 'a' }])
    assert.equal(
      calls.some((c) => c.name === 'mcp.list'),
      false
    )
    key('open:model').emit('click')
    await flush()
    assert.equal(sheet().hidden, true)
    assert.equal(gear().attributes.get('aria-expanded'), 'true')
    all(root)
      .find((n) => n.dataset.key === 'claude/sonnet')!
      .emit('click')
    await flush()
    assert.ok(all(root).some((n) => n.tag === 'small' && n.textContent === 'Sonnet'))
    assert.equal(
      calls.some((c) => c.name === 'mcp.list'),
      false
    )
    assert.equal(calls.filter((c) => c.name === 'bots.act').length, 1)
    doc.emit('keydown', { key: 'Escape' })
    assert.equal((document as any).activeElement, gear())
    view.update([{ ...current, state: 'working' }])
    gear().emit('click')
    await flush()
    assert.equal(key('open:model').disabled, true)
    view.update([current])
    assert.equal(key('open:model').disabled, false)
    view.update([{ ...current, connectorCount: 1 }])
    assert.match(sheet().textContent, /Connectors1 allowed/)
    key('open:connectors').emit('click')
    await flush()
    all(root)
      .find((n) => n.dataset.key === 'mail')!
      .emit('click')
    await flush()
    assert.equal(calls.filter((c) => c.name === 'mcp.list').length, 1)
    all(root)
      .find((n) => n.dataset.key === 'mail')!
      .emit('click')
    await flush()
    assert.equal(calls.filter((c) => c.name === 'mcp.list').length, 1)
    all(root)
      .find((n) => n.textContent === 'Manage connectors…')!
      .emit('click')
    assert.deepEqual(managed, [['a', true]])
    let finish!: (x: any) => void
    delayed = new Promise((resolve) => {
      finish = resolve
    })
    gear().emit('click')
    await flush()
    key('open:model').emit('click')
    view.open({ ...current, id: 'b', name: 'Personal' })
    finish({ groups: [{ instanceId: 'late', label: 'STALE', models: [] }] })
    await flush()
    assert.equal(root.textContent.includes('STALE'), false)
    assert.equal(all(root).find((n) => n.className.includes('capability-menu'))!.hidden, true)
    view.close()
    assert.equal(root.hidden, true)
  } finally {
    for (const [i, key] of keys.entries()) {
      if (originals[i]) Object.defineProperty(globalThis, key, originals[i]!)
      else delete (globalThis as any)[key]
    }
  }
})

test('files upload when picked, wait before sending, go out by ID, and never cross a host change', async () => {
  const saved = ['document', 'window'].map((k) => Object.getOwnPropertyDescriptor(globalThis, k))
  const documentFake = new Element('document') as any
  documentFake.createElement = (tag: string) => new Element(tag)
  documentFake.createTextNode = (text: string) => {
    const el = new Element('#text')
    el.textContent = text
    return el
  }
  documentFake.hidden = false
  Object.defineProperty(globalThis, 'document', { value: documentFake, configurable: true })
  Object.defineProperty(globalThis, 'window', { value: new Element('window'), configurable: true })
  const root = new Element('section')
  const bot: Bot = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Helper', modelLabel: 'm', main: false, unread: false, state: 'idle', title: '' }
  const uploads: any[] = []
  const sends: any[] = []
  const notes: string[] = []
  let finishUpload!: () => void
  let remote = false
  let host = 0
  let history: any[] = []
  let holdSend = false
  let failSend!: (error: Error) => void
  const file = (name: string, type: string, size = 3) => ({ name, type, size, arrayBuffer: async () => new TextEncoder().encode('hi!').buffer })
  try {
    const view = createChatView(
      root as any,
      {
        plugin: {
          request: (async (name: string, input: any) => {
            if (name === 'attachment.upload') {
              uploads.push(input)
              await new Promise<void>((resolve) => { finishUpload = resolve })
              return { id: `upload-${uploads.length}`, kind: input.mime === 'image/png' ? 'image' : 'file', name: input.name }
            }
            if (name === 'message.send') {
              sends.push(input)
              if (holdSend) return new Promise((_resolve, reject) => { failSend = reject })
              return { sendId: 'x' }
            }
            return { hasMore: false, messages: history }
          }) as any
        }
      },
      () => new Element('span') as any,
      () => {},
      () => {},
      undefined,
      { changed: async () => {}, manage: () => {}, notify: (text: string) => notes.push(text), hostGeneration: () => host },
      () => (remote ? 'remote' : undefined)
    )
    view.open(bot)
    await flush()
    const nodes = () => all(root)
    const attach = nodes().find((n) => n.attributes.get('aria-label') === 'Attach files or photos')!
    const fileInput = nodes().find((n) => n.tag === 'input')! as any
    const send = nodes().find((n) => n.attributes.get('aria-label') === 'Send')!
    const form = nodes().find((n) => n.tag === 'form')!
    const textarea = nodes().find((n) => n.tag === 'textarea')!
    const tray = () => nodes().find((n) => n.className === 'composer-files')!
    assert.equal(attach.hidden, false)
    fileInput.files = [new File(['hi!'], 'shot.png', { type: 'image/png' }), file('huge.mov', 'video/quicktime', 30 * 1024 * 1024)]
    fileInput.emit('change')
    assert.match(notes[0], /huge\.mov is larger than 25 MB/)
    assert.match(tray().textContent, /shot\.png.*Uploading…/)
    assert.equal(send.disabled, true, 'nothing sends while a file is uploading')
    await flush()
    assert.deepEqual(uploads[0], { name: 'shot.png', mime: 'image/png', data: 'aGkh' })
    finishUpload()
    await flush()
    assert.equal(send.disabled, false, 'a photo alone can be sent')
    // Enter submits even with Send disabled: an over-long draft must not eat the attachment.
    textarea.value = 'x'.repeat(16001)
    textarea.emit('input')
    assert.equal(send.disabled, true)
    form.emit('submit')
    await flush()
    assert.equal(sends.length, 0)
    assert.match(tray().textContent, /shot\.png/)
    textarea.value = ''
    textarea.emit('input')
    form.emit('submit')
    await flush()
    await flush()
    assert.deepEqual(sends, [{ botId: bot.id, text: '', attachments: ['upload-1'] }])
    assert.equal(tray().hidden, true)
    assert.ok(nodes().some((n) => n.className === 'chat-files' && n.textContent === '🖼 shot.png'))
    // History arrives from the worker with names only.
    history = [{ id: 'm1', at: Date.now(), role: 'user', kind: 'text', text: 'See', attachments: [{ kind: 'file', name: 'plan.pdf' }] }]
    view.open(bot)
    await flush()
    assert.ok(nodes().some((n) => n.className === 'chat-files' && n.textContent === '📎 plan.pdf'))
    // A file attached on one host is gone after switching hosts, even for the same bot ID,
    // and an upload that finishes after the switch is dropped.
    fileInput.files = [new File(['hi!'], 'local-only.png', { type: 'image/png' })]
    fileInput.emit('change')
    await flush()
    assert.match(tray().textContent, /local-only\.png/)
    host++
    finishUpload()
    await flush()
    view.open(bot)
    await flush()
    assert.equal(tray().hidden, true)
    form.emit('submit')
    await flush()
    assert.equal(sends.length, 1)
    // A send still in flight when the host changes must not put its draft or files into the
    // new host's composer when it fails.
    fileInput.files = [new File(['hi!'], 'in-flight.png', { type: 'image/png' })]
    fileInput.emit('change')
    await flush()
    finishUpload()
    await flush()
    textarea.value = 'for the old host'
    textarea.emit('input')
    holdSend = true
    form.emit('submit')
    await flush()
    assert.equal(sends.length, 2)
    host++
    view.open(bot)
    await flush()
    failSend(new Error('offline'))
    await flush()
    await flush()
    assert.equal(tray().hidden, true)
    assert.equal(textarea.value, '')
    assert.equal(nodes().some((n) => /in-flight\.png|for the old host/.test(n.textContent) && n.className.includes('chat-message')), false)
    holdSend = false
    remote = true
    view.open(bot)
    assert.equal(attach.hidden, true)
    fileInput.files = [file('a.txt', 'text/plain')]
    fileInput.emit('change')
    assert.match(notes.at(-1)!, /only when bots run on this computer/)
    assert.equal(uploads.length, 3)
    view.close()
  } finally {
    for (const [i, k] of ['document', 'window'].entries()) {
      if (saved[i]) Object.defineProperty(globalThis, k, saved[i]!)
      else delete (globalThis as any)[k]
    }
  }
})
