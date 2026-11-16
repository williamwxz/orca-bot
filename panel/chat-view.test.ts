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
    for (const fn of this.events.get(name) ?? []) fn({ preventDefault() {}, ...event })
  }
  focus() {}
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
                { id: '2', at: 2, role: 'bot', kind: 'unsupported', text: 'This needs the full chat.' }
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
