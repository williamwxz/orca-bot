import { assert, test } from 'orca/testing'

// A small page fake for the panel's start-up script: elements by ID, events, no real DOM.
class Node {
  children: Node[] = []
  hidden = false
  value = ''
  className = ''
  type = ''
  title = ''
  innerHTML = ''
  text = ''
  dataset: Record<string, string> = {}
  style: Record<string, string> = {}
  events = new Map<string, ((event: any) => void)[]>()
  constructor(public tag: string, public selected = false) {}
  set textContent(value: string) {
    this.text = value
    this.children = []
  }
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join('')
  }
  append(...nodes: Node[]) {
    this.children.push(...nodes.flatMap((n) => (n.tag === '#fragment' ? n.children.splice(0) : [n])))
  }
  prepend(...nodes: Node[]) {
    this.children.unshift(...nodes)
  }
  replaceChildren(...nodes: Node[]) {
    this.text = ''
    this.children = []
    this.append(...nodes)
  }
  replaceWith() {}
  remove() {}
  setAttribute() {}
  removeAttribute() {}
  focus() {}
  querySelector() {
    return null
  }
  scrollTo() {}
  addEventListener(name: string, fn: (event: any) => void) {
    this.events.set(name, [...(this.events.get(name) ?? []), fn])
  }
  emit(name: string) {
    for (const fn of this.events.get(name) ?? []) fn({ preventDefault() {} })
  }
  all(): Node[] {
    return [this, ...this.children.flatMap((c) => c.all())]
  }
}
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}

test('a host list asked for before a host change never replaces that change', async () => {
  const ids = new Map<string, Node>()
  const byId = (id: string) => ids.get(id) ?? (ids.set(id, new Node('div')), ids.get(id)!)
  const doc = Object.assign(new Node('document'), {
    hidden: false,
    activeElement: null,
    getElementById: byId,
    createElement: (tag: string) => new Node(tag),
    createTextNode: (text: string) => Object.assign(new Node('#text'), { text }),
    createDocumentFragment: () => new Node('#fragment')
  })
  const paired = { hosts: [{ id: 'server', name: 'Mac mini' }], message: '' }
  const roster = (where: string) => [{ id: `${where}-bot`, name: `${where} bot`, model: '', preview: '', lastActive: 0, working: false }]
  let selected = 'server'
  let answerSlowList!: () => void
  let slowList: Promise<void> | undefined
  const asked: string[] = []
  const orca = {
    plugin: {
      request: async (name: string, input: any) => {
        asked.push(name)
        if (name === 'hosts.get') {
          const then = selected
          if (slowList) await slowList
          return { selected: then, ...paired }
        }
        if (name === 'hosts.select') {
          selected = input.id
          return { selected, ...paired }
        }
        if (name === 'status') return { state: 'running', message: '' }
        if (name === 'bots.list') return roster(selected)
        return { messages: [] }
      }
    },
    shell: { openExternal() {} }
  }
  const globals: Record<string, unknown> = {
    document: doc,
    window: Object.assign(new Node('window'), { innerWidth: 1000, setTimeout: () => 0 }),
    orca,
    Option: class extends Node {
      constructor(text: string, value: string, _default: boolean, selected: boolean) {
        super('option', selected)
        this.text = text
        this.value = value
      }
    },
    setTimeout: () => 0,
    clearTimeout: () => {}
  }
  const saved = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const)
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  try {
    await import('./app.ts')
    await flush()
    const names = () => byId('roster').all().filter((n) => n.className === 'bot-name').map((n) => n.textContent)
    assert.deepEqual(names(), ['server bot'])
    // Retry asks for the host list again, slowly; meanwhile the person picks This computer.
    slowList = new Promise<void>((resolve) => (answerSlowList = resolve))
    byId('retry').emit('click')
    await flush()
    const picker = byId('host')
    picker.value = 'local'
    picker.emit('change')
    await flush()
    assert.deepEqual(names(), ['local bot'])
    // The old answer (still naming the server) arrives last and changes nothing.
    answerSlowList()
    await flush()
    // The next refresh still knows This computer is the choice.
    doc.emit('visibilitychange')
    await flush()
    assert.deepEqual(names(), ['local bot'])
    assert.equal(picker.children.find((o) => o.selected)?.value, 'local')
    // A refresh while a host change waits for its answer is not run.
    asked.length = 0
    let answerSelect!: () => void
    const waiting = new Promise<void>((resolve) => (answerSelect = resolve))
    const request = orca.plugin.request
    orca.plugin.request = async (name, input) => {
      if (name === 'hosts.select') await waiting
      return request(name, input)
    }
    picker.value = 'server'
    picker.emit('change')
    doc.emit('visibilitychange')
    await flush()
    // Nothing but the pending choice has been asked (it is recorded once answered).
    assert.deepEqual(asked, [])
    answerSelect()
    await flush()
    assert.equal(asked[0], 'hosts.select')
    assert.deepEqual(names(), ['server bot'])
  } finally {
    for (const [key, descriptor] of saved) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete (globalThis as any)[key]
  }
})
