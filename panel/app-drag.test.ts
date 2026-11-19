import { test, assert } from 'orca/testing'

// A file of its own, so app.ts starts fresh with a grouped roster.
class Element {
  children: Element[] = []
  events = new Map<string, ((event?: any) => void)[]>()
  attributes = new Map<string, string>()
  style: Record<string, string> = {}
  set innerHTML(value: string) { this.children = value ? [new Element()] : [] }
  textContent = ''
  hidden = false
  disabled = false
  draggable = false
  checked = true
  className = ''
  value = ''
  dataset: Record<string, string> = {}
  append(...children: Element[]) { this.children.push(...children) }
  replaceChildren(...children: Element[]) { this.children = children }
  setAttribute(name: string, value: string) { this.attributes.set(name, value) }
  contains(node: Element): boolean { return this === node || this.children.some((child) => child.contains(node)) }
  getBoundingClientRect() { return { left: 20, bottom: 100, width: 196, height: 180 } }
  querySelectorAll(selector: string): Element[] {
    const all = this.children.flatMap((child) => [child, ...child.querySelectorAll('*')])
    if (selector === '[data-drop]') return all.filter((child) => child.dataset.drop)
    if (selector.startsWith('.')) return all.filter((child) => child.className.split(' ').includes(selector.slice(1)))
    if (selector === '[data-focus]') return all.filter((child) => child.dataset.focus)
    return all
  }
  get classList() {
    const names = () => this.className.split(' ').filter(Boolean)
    return {
      add: (name: string) => { if (!names().includes(name)) this.className = [...names(), name].join(' ') },
      remove: (name: string) => { this.className = names().filter((n) => n !== name).join(' ') },
      toggle: (name: string, on: boolean) => { this.className = [...names().filter((n) => n !== name), ...(on ? [name] : [])].join(' ') }
    }
  }
  addEventListener(name: string, fn: (event?: any) => void) { this.events.set(name, [...(this.events.get(name) ?? []), fn]) }
  emit(name: string, event?: any) { for (const fn of this.events.get(name) ?? []) fn({ stopPropagation() {}, ...event }) }
  get firstElementChild() { return this.children[0] }
  focus() { ;(document as any).activeElement = this }
}
const botNames = (root: Element): string[] =>
  root.children.flatMap((child) => (child.className === 'bot-name' ? [child.textContent] : botNames(child)))
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

test('dragging a bot onto another group moves it there and leaves its own group alone', async () => {
  const keys = ['document', 'window', 'orca', 'setTimeout', 'clearTimeout'] as const
  const originals = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key))
  const elements = new Map<string, Element>()
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element())
    return elements.get(id)!
  }
  const doc = Object.assign(new Element(), {
    getElementById: get,
    createElement: () => new Element(),
    createTextNode: (text: string) => Object.assign(new Element(), { textContent: text })
  })
  const win = Object.assign(new Element(), { setTimeout: () => 1 })
  const roster = [
    { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Scout', state: 'idle', modelLabel: 'm', pinned: true, section: 'Ops' },
    { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Quill', state: 'idle', modelLabel: 'm', section: 'Studio' }
  ]
  const acts: unknown[] = []
  const frame = {
    plugin: {
      request: async (name: string, input: any) => {
        if (name === 'hosts.get') return { selected: 'local', hosts: [], message: '' }
        if (name === 'status') return { state: 'running', message: '' }
        if (name === 'setup.get') return { answered: true, agents: {} }
        if (name === 'bots.list') return structuredClone(roster)
        if (name === 'bots.act') {
          acts.push(input)
          const bot = roster.find((b) => b.id === input.botId)!
          if (input.action === 'pin') bot.pinned = input.pinned
          if (input.action === 'group') bot.section = input.section ?? undefined
          return { ok: true }
        }
        return {}
      }
    }
  }
  const values = [doc, win, frame, () => 1, () => {}]
  keys.forEach((key, i) => Object.defineProperty(globalThis, key, { value: values[i], configurable: true }))
  try {
    await import('./app.ts')
    await flush()
    const children = () => get('roster').children
    const heading = (title: string) => children().find((c) => c.className.startsWith('roster-group-title') && c.textContent === title)!
    const row = (name: string) =>
      children().find((c) => c.className.startsWith('bot-row') && botNames(c).includes(name))!
    assert.deepEqual(children().filter((c) => c.className.startsWith('roster-group-title')).map((c) => c.textContent), ['Pinned', 'Studio'])
    const transfer = { setData() {}, effectAllowed: '', dropEffect: '' }
    let prevented = false
    const event = { dataTransfer: transfer, preventDefault() { prevented = true } }
    const scout = row('Scout')
    assert.equal(scout.draggable, true)
    scout.emit('dragstart', event)
    assert.match(scout.className, /dragging/)
    prevented = false
    heading('Pinned').emit('dragover', event)
    assert.equal(prevented, false, 'its own group is not a drop target')
    heading('Studio').emit('dragover', event)
    assert.equal(prevented, true)
    assert.equal(transfer.dropEffect, 'move')
    assert.match(row('Quill').className, /drop-target/)
    row('Quill').emit('drop', event)
    await flush()
    await flush()
    assert.deepEqual(acts, [
      { botId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', action: 'pin', pinned: false },
      { botId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', action: 'group', section: 'Studio' }
    ])
    assert.match(get('toast').children[0].textContent, /Moved Scout to Studio/)
    assert.deepEqual(children().filter((c) => c.className.startsWith('roster-group-title')).map((c) => c.textContent), ['Studio'])
    assert.equal(children().some((c) => /drop-target|dragging/.test(c.className)), false)
  } finally {
    keys.forEach((key, i) => {
      if (originals[i]) Object.defineProperty(globalThis, key, originals[i]!)
      else Reflect.deleteProperty(globalThis, key)
    })
  }
})
