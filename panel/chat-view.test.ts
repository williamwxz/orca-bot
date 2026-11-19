import { assert, test } from 'orca/testing'
import { createChatView, dayLabel } from './chat-view.ts'
import type { Bot, ChatMessage, Thread } from '../shared/bots.ts'

// A deliberately small DOM fake: no browser, network or timers of its own.
class Element {
  children: Element[] = []
  parent?: Element
  text = ''
  className = ''
  hidden = false
  disabled = false
  value = ''
  type = ''
  dataset: Record<string, string> = {}
  attributes = new Map<string, string>()
  events = new Map<string, ((event: any) => void)[]>()
  scrollHeight = 500
  scrollTop = 0
  clientHeight = 500
  constructor(public tag: string) {}
  set textContent(value: string) {
    this.text = value
    this.children = []
  }
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join('')
  }
  private adopt(nodes: Element[]): Element[] {
    const flat = nodes.flatMap((n) => (n.tag === '#fragment' ? n.children.splice(0) : [n]))
    for (const n of flat) n.parent = this
    return flat
  }
  append(...nodes: Element[]) {
    this.children.push(...this.adopt(nodes))
  }
  prepend(...nodes: Element[]) {
    this.children.unshift(...this.adopt(nodes))
  }
  replaceChildren(...nodes: Element[]) {
    this.text = ''
    this.children = this.adopt(nodes)
  }
  replaceWith(node: Element) {
    const siblings = this.parent!.children
    siblings[siblings.indexOf(this)] = node
    node.parent = this.parent
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value)
  }
  addEventListener(name: string, fn: (event: any) => void) {
    this.events.set(name, [...(this.events.get(name) ?? []), fn])
  }
  emit(name: string, event: any = {}) {
    for (const fn of this.events.get(name) ?? []) fn({ preventDefault() {}, ...event })
  }
  requestSubmit() {
    this.emit('submit')
  }
  all(): Element[] {
    return [this, ...this.children.flatMap((c) => c.all())]
  }
}
const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}
const m = (id: string, role: 'user' | 'bot', text: string, at = 1795000000000): ChatMessage => ({ id, at, role, kind: 'text', text })
const bot: Bot = { id: 'honex', name: 'Honex', model: 'claude', preview: '', lastActive: 0, working: false }

function setup(read: (input: any) => Thread | Error) {
  const keys = ['document', 'setTimeout', 'clearTimeout'] as const
  const saved = keys.map((k) => Object.getOwnPropertyDescriptor(globalThis, k))
  const doc = Object.assign(new Element('document'), {
    hidden: false,
    createElement: (tag: string) => new Element(tag),
    createTextNode: (text: string) => Object.assign(new Element('#text'), { text }),
    createDocumentFragment: () => new Element('#fragment')
  })
  const timers: (() => void)[] = []
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc })
  Object.defineProperty(globalThis, 'setTimeout', { configurable: true, value: (fn: () => void) => timers.push(fn) })
  Object.defineProperty(globalThis, 'clearTimeout', { configurable: true, value: () => {} })
  const calls: [string, any][] = []
  const notes: string[] = []
  let host = 0
  let sendFails: string | undefined
  const frame = {
    plugin: {
      request: async (name: string, input: any) => {
        calls.push([name, input])
        if (name === 'message.send') {
          if (sendFails) throw new Error(sendFails)
          return { ok: true }
        }
        const value = read(input)
        if (value instanceof Error) throw value
        return value
      }
    }
  } as never
  const root = new Element('root')
  const view = createChatView(root as never, frame, () => new Element('avatar') as never, { back: () => {}, notify: (t) => notes.push(t), hostGeneration: () => host })
  const find = (cls: string) => root.all().filter((e) => e.className.split(' ').includes(cls))
  const shown = () => find('chat-message').filter((e) => !e.hidden && !e.className.includes('live')).map((e) => e.textContent)
  return {
    view, root, calls, notes, find, shown,
    input: () => root.all().find((e) => e.tag === 'textarea')!,
    form: () => root.all().find((e) => e.tag === 'form')!,
    poll: async () => {
      timers.splice(0).at(-1)?.()
      await flush()
    },
    setHost: (h: number) => (host = h),
    failSend: (text?: string) => (sendFails = text),
    restore: () => keys.forEach((k, i) => (saved[i] ? Object.defineProperty(globalThis, k, saved[i]!) : delete (globalThis as any)[k]))
  }
}

test('a chat opens on its newest page, adds new rows in place, and pages back through earlier ones', async () => {
  let page: Thread = { messages: [m('r3', 'user', 'three'), m('r4', 'bot', 'four')], older: 'c1' }
  const t = setup((input) => (input.older === 'c1' ? { messages: [m('r1', 'user', 'one'), m('r2', 'bot', 'two')] } : page))
  try {
    t.view.open(bot)
    await flush()
    assert.deepEqual(t.calls[0], ['thread.read', { botId: 'honex', limit: 80 }])
    assert.deepEqual(t.shown(), ['three', 'four'])
    const first = t.find('chat-message')[0]
    // A poll with one new row keeps the rows already drawn and adds only the new one.
    page = { messages: [m('r4', 'bot', 'four'), m('r5', 'user', 'five')], older: 'c1' }
    await t.poll()
    assert.equal(t.calls.at(-1)![1].limit, 40)
    assert.deepEqual(t.shown(), ['three', 'four', 'five'])
    assert.equal(t.find('chat-message')[0], first)
    const earlier = t.find('thread-earlier')[0]
    assert.equal(earlier.hidden, false)
    earlier.emit('click')
    await flush()
    assert.deepEqual(t.calls.at(-1), ['thread.read', { botId: 'honex', older: 'c1', limit: 80 }])
    assert.deepEqual(t.shown(), ['one', 'two', 'three', 'four', 'five'])
    assert.equal(earlier.hidden, true)
    // A stored row whose text changed is redrawn alone.
    page = { messages: [m('r5', 'user', 'five!')] }
    await t.poll()
    assert.deepEqual(t.shown(), ['one', 'two', 'three', 'four', 'five!'])
  } finally {
    t.restore()
  }
})

test('the reply shows while it is written, with the tool running now', async () => {
  let page: Thread = { messages: [m('r1', 'user', 'hi')], live: { text: 'Hel', tool: 'terminal: ls', startedAt: Date.now() - 5000 } }
  const t = setup(() => page)
  try {
    t.view.open(bot)
    await flush()
    const live = t.find('live')[0]
    assert.equal(live.hidden, false)
    assert.equal(live.textContent, 'Hel')
    assert.match(t.find('working-line')[0].textContent, /^terminal: ls · \ds$/)
    page = { messages: [m('r1', 'user', 'hi'), m('r2', 'bot', 'Hello')] }
    await t.poll()
    assert.equal(live.hidden, true)
    assert.equal(t.find('working-line')[0].hidden, true)
    assert.deepEqual(t.shown(), ['hi', 'Hello'])
  } finally {
    t.restore()
  }
})

test('a sent message shows at once and gives way to its stored row; a failed send returns the text', async () => {
  let page: Thread = { messages: [] }
  const t = setup(() => page)
  try {
    t.view.open(bot)
    await flush()
    assert.equal(t.find('thread-note')[0].textContent, 'No messages yet. Say hello.')
    t.input().value = ' hello there '
    t.input().emit('input')
    t.form().requestSubmit()
    assert.deepEqual(t.shown(), ['hello there'])
    assert.equal(t.input().value, '')
    await flush()
    assert.deepEqual(t.calls.find(([name]) => name === 'message.send'), ['message.send', { botId: 'honex', text: 'hello there' }])
    page = { messages: [m('r1', 'user', 'hello there', Date.now())] }
    await t.poll()
    assert.deepEqual(t.shown(), ['hello there'])
    t.failSend('Hermes did not take this message. Check the bot in Hermes, then try again.')
    t.input().value = 'again'
    t.form().requestSubmit()
    await flush()
    assert.equal(t.input().value, 'again')
    assert.match(t.notes.at(-1)!, /did not take this message/)
    assert.deepEqual(t.shown(), ['hello there'])
    // Nothing is sent for an empty message.
    const sends = t.calls.filter(([name]) => name === 'message.send').length
    t.input().value = '   '
    t.form().requestSubmit()
    assert.equal(t.calls.filter(([name]) => name === 'message.send').length, sends)
  } finally {
    t.restore()
  }
})

test('a reply for another bot or another host is dropped, and a failed read says why', async () => {
  let answer: Thread | Error = { messages: [m('r1', 'bot', 'from honex')] }
  const t = setup(() => answer)
  try {
    t.view.open(bot)
    t.view.open({ ...bot, id: 'other', name: 'Other' })
    await flush()
    assert.deepEqual(t.calls.map(([, input]) => input.botId), ['honex', 'other'])
    assert.deepEqual(t.shown(), ['from honex'])
    t.view.open(bot)
    t.setHost(1)
    await flush()
    assert.deepEqual(t.shown(), [])
    t.setHost(0)
    answer = new Error('Hermes could not do that. Try again.')
    t.view.open(bot)
    await flush()
    assert.equal(t.find('thread-note')[0].textContent, 'Hermes could not do that. Try again.')
    t.view.close()
    assert.equal(t.root.hidden, true)
  } finally {
    t.restore()
  }
})

test('day separators name today, yesterday and older days', () => {
  const now = new Date(2026, 10, 19, 12).getTime()
  assert.equal(dayLabel(now - 3600000, undefined, now), 'Today')
  assert.equal(dayLabel(now - 86400000, undefined, now), 'Yesterday')
  assert.equal(dayLabel(now - 3600000, now - 7200000, now), undefined)
  assert.match(dayLabel(new Date(2026, 10, 10).getTime(), undefined, now)!, /Nov/)
  assert.equal(dayLabel(0, undefined, now), undefined)
})
