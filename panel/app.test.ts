import { test, assert } from 'orca/testing'

class Element {
  children: Element[] = []
  events = new Map<string, (() => void)[]>()
  textContent = ''
  hidden = false
  disabled = false
  checked = true
  className = ''
  value = ''
  dataset: Record<string, string> = {}
  append(...children: Element[]) {
    this.children.push(...children)
  }
  replaceChildren(...children: Element[]) {
    this.children = children
  }
  setAttribute() {}
  get firstElementChild() {
    return this.children[0]
  }
  addEventListener(name: string, fn: () => void) {
    this.events.set(name, [...(this.events.get(name) ?? []), fn])
  }
  emit(name: string) {
    for (const fn of this.events.get(name) ?? []) fn()
  }
  focus() {}
}
const botNames = (root: Element): string[] =>
  root.children.flatMap((child) => (child.className === 'bot-name' ? [child.textContent] : botNames(child)))
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

test('panel keeps bots below setup, opens the main page from the header, and retries failed approval', async () => {
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
  const win = new Element()
  const calls: { name: string; input: unknown }[] = []
  let answered = false
  let reject!: (error: Error) => void
  let resolve!: () => void
  let host = 'local'
  let hostsBroken = false
  let holdNextBots = false
  let holdBots: ((bots: unknown) => void) | undefined
  const frame = {
    plugin: {
      request: async (name: string, input: unknown) => {
        calls.push({ name, input })
        if (name === 'hosts.get')
          return hostsBroken
            ? { selected: host, hosts: [], message: 'Could not read Orca’s paired servers.' }
            : { selected: host, hosts: [{ id: 'mini-1', name: 'Mac Mini' }], message: '' }
        if (name === 'hosts.select') {
          host = (input as { id: string }).id
          return { selected: host, hosts: [{ id: 'mini-1', name: 'Mac Mini' }], message: '' }
        }
        if (name === 'status' && hostsBroken) return { state: 'start_failed', message: 'Could not read Orca’s paired servers.' }
        if (name === 'bots.list' && holdNextBots) {
          holdNextBots = false
          return new Promise((done) => { holdBots = done })
        }
        if (name === 'bots.list' && host !== 'local')
          return [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Remote bot', state: 'idle', modelLabel: 'Claude' }]
        if (name === 'tools.find') return { tools: [{ name: 'fake', source: 'Cursor' }] }
        if (name === 'setup.get') return { answered, agents: { claude: true, codex: false } }
        if (name === 'status') return { state: 'running', message: '' }
        if (name === 'bots.list')
          return [
            {
              id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              name: 'Fake bot',
              avatar: 'fake-avatar',
              state: 'idle',
              modelLabel: 'Codex'
            }
          ]
        if (name === 'chat.open') return { message: 'Opened.' }
        if (name === 'thread.read') return { messages: [], hasMore: false }
        if (name === 'setup.answer')
          return new Promise<void>((ok, fail) => {
            resolve = () => {
              answered = true
              ok()
            }
            reject = fail
          })
        throw new Error('Unexpected request')
      }
    }
  }
  const values = [doc, win, frame, () => 1, () => {}]
  keys.forEach((key, i) => Object.defineProperty(globalThis, key, { value: values[i], configurable: true }))
  try {
    await import('./app.ts')
    await flush()
    assert.equal(get('setup').hidden, false)
    assert.equal(get('roster').children.length, 1)
    assert.equal(get('message').hidden, true)
    assert.equal(get('agent-names').textContent, 'Claude')
    assert.equal(get('import-tools-label').hidden, false)
    assert.match(get('import-tools-copy').textContent, /Adds 1 tool from Cursor/)
    assert.equal(get('import-tools').checked, true)
    get('roster').children[0].children[0].emit('click')
    await flush()
    assert.equal(get('list-header').hidden, true)
    assert.equal(get('setup').hidden, true)
    win.emit('pageshow')
    await flush()
    assert.equal(get('setup').hidden, true)
    get('bot-view').children[0].children[0].emit('click')
    assert.equal(get('list-header').hidden, false)
    assert.equal(get('setup').hidden, false)
    get('open-page').emit('click')
    await flush()
    assert.deepEqual(calls.find((call) => call.name === 'chat.open')?.input, {})
    get('setup-allow').emit('click')
    await flush()
    assert.equal(get('setup-allow').disabled, true)
    assert.equal(get('setup-skip').disabled, true)
    assert.equal(get('setup-message').textContent, 'Setting up…')
    reject(new Error('private-output'))
    await flush()
    assert.equal(get('setup').hidden, false)
    assert.equal(get('setup-allow').disabled, false)
    assert.equal(get('setup-message').textContent, 'Could not finish setup. Please try again.')
    get('setup-skip').emit('click')
    await flush()
    assert.deepEqual(calls.filter((call) => call.name === 'setup.answer').at(-1)?.input, {
      shareTools: false,
      linkAgents: false
    })
    resolve()
    await flush()
    assert.equal(get('setup').hidden, true)
    get('roster').children[0].children[0].emit('click')
    await flush()
    assert.equal(get('list-header').hidden, true)
    get('bot-view').children[0].children[0].emit('click')
    assert.equal(get('list-header').hidden, false)
    assert.equal(get('setup').hidden, true)
    // The picker lists this computer and each paired server, and hides with the bot list.
    assert.equal(get('host-row').hidden, false)
    assert.deepEqual(get('host').children.map((option) => [option.value, option.textContent]), [['local', 'This computer'], ['mini-1', 'Mac Mini']])
    assert.equal(get('host').value, 'local')
    get('roster').children[0].children[0].emit('click'); await flush()
    assert.equal(get('host-row').hidden, true)
    get('bot-view').children[0].children[0].emit('click')
    const listed = calls.filter((call) => call.name === 'bots.list').length
    get('host').value = 'mini-1'
    get('host').emit('change'); await flush()
    assert.deepEqual(calls.find((call) => call.name === 'hosts.select')?.input, { id: 'mini-1' })
    assert.equal(get('host').value, 'mini-1')
    assert.equal(get('host').disabled, false)
    assert.equal(calls.filter((call) => call.name === 'bots.list').length, listed + 1)
    assert.deepEqual(botNames(get('roster')), ['Remote bot'])
    // Switching clears the old host's bots at once, and a late answer from that host is dropped.
    holdNextBots = true
    win.emit('pageshow'); await flush()
    assert.ok(holdBots)
    get('host').value = 'local'
    get('host').emit('change')
    assert.equal(get('running').hidden, true)
    assert.deepEqual(botNames(get('roster')), [])
    await flush()
    // Hold the new host's list too, to look at the moment the stale answer lands.
    const stale = holdBots!
    holdNextBots = true
    stale([{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Stale bot', state: 'idle', modelLabel: 'Claude' }])
    await flush(); await flush(); await flush()
    assert.notEqual(holdBots, stale)
    assert.deepEqual(botNames(get('roster')), [])
    holdBots!([{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Fake bot', state: 'idle', modelLabel: 'Codex' }])
    await flush(); await flush()
    assert.deepEqual(botNames(get('roster')), ['Fake bot'])
    // When Orca cannot list servers, Retry shows and asks Orca again before checking status.
    host = 'mini-1'
    hostsBroken = true
    win.emit('pageshow'); await flush(); await flush()
    assert.equal(get('retry').hidden, false)
    hostsBroken = false
    const asked = calls.filter((call) => call.name === 'hosts.get').length
    get('retry').emit('click'); await flush(); await flush()
    assert.equal(calls.filter((call) => call.name === 'hosts.get').length, asked + 1)
    assert.equal(get('retry').hidden, true)
    assert.deepEqual(botNames(get('roster')), ['Remote bot'])
  } finally {
    win.emit('pagehide')
    keys.forEach((key, i) => {
      if (originals[i]) Object.defineProperty(globalThis, key, originals[i]!)
      else Reflect.deleteProperty(globalThis, key)
    })
  }
})
