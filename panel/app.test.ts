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
  root.children.flatMap((child) =>
    child.className === 'bot-name' ? [child.textContent] : botNames(child)
  )
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
  let installed = false
  let answered = false
  let reject!: (error: Error) => void
  let resolve!: () => void
  let host = 'local'
  const prefs = { shareTools: true, linkAgents: false }
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
        if (name === 'status' && hostsBroken)
          return { state: 'start_failed', message: 'Could not read Orca’s paired servers.' }
        if (name === 'bots.list' && holdNextBots) {
          holdNextBots = false
          return new Promise((done) => {
            holdBots = done
          })
        }
        if (name === 'bots.list' && host !== 'local')
          return [
            {
              id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
              name: 'Remote bot',
              state: 'idle',
              modelLabel: 'Claude'
            }
          ]
        if (name === 'updates.get')
          return {
            version: '0.1.3',
            latest: '0.1.4',
            state: 'available',
            message: 'Version 0.1.4 is available.',
            autoUpdate: false
          }
        if (name === 'updates.auto')
          return {
            version: '0.1.3',
            latest: '0.1.4',
            state: 'available',
            message: 'Version 0.1.4 is available.',
            autoUpdate: (input as { on: boolean }).on
          }
        if (name === 'updates.install')
          return {
            version: '0.1.3',
            latest: '0.1.4',
            state: 'updated',
            message: 'Updated. Orca restarts Bot Team for Orca with the new version.',
            autoUpdate: true
          }
        if (name === 'prefs.get') return { ...prefs, agents: { claude: true, codex: false } }
        if (name === 'prefs.set') {
          Object.assign(prefs, input)
          return { ...prefs, agents: { claude: true, codex: false } }
        }
        if (name === 'tools.find') return { tools: [{ name: 'fake', source: 'Cursor' }] }
        if (name === 'setup.get') return { answered, agents: { claude: true, codex: false } }
        if (name === 'server.install') {
          installed = true
          return { accepted: true }
        }
        if (name === 'status' && !installed)
          return { state: 'needs_install', message: 'Install OpenMausBot with approval.' }
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
  keys.forEach((key, i) =>
    Object.defineProperty(globalThis, key, { value: values[i], configurable: true })
  )
  try {
    await import('./app.ts')
    await flush()
    assert.equal(get('install-card').hidden, false)
    assert.equal(get('settings-install-card').hidden, false)
    assert.match(get('install-card-notice').textContent, /openmausbot@0.1.169.*npm.*75 MB.*~\/.orca-bot/)
    assert.equal(
      calls.some((call) => call.name === 'server.install'),
      false
    )
    assert.equal(
      calls.some((call) => call.name === 'bots.list'),
      false
    )
    get('install-omb').emit('click')
    await flush()
    await flush()
    assert.equal(calls.filter((call) => call.name === 'server.install').length, 1)
    assert.equal(get('install-card').hidden, true)
    assert.equal(get('settings-install-card').hidden, true)
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
    // A new version shows a banner that asks before updating.
    assert.equal(get('update-banner').hidden, false)
    assert.equal(get('update-banner-text').textContent, 'Version 0.1.4 is available.')
    // Settings replace the bot list, with the host picker, permissions and updates.
    get('open-settings').emit('click')
    await flush()
    assert.deepEqual([get('main-view').hidden, get('settings-view').hidden], [true, false])
    assert.deepEqual(
      get('host').children.map((option) => [option.value, option.textContent]),
      [
        ['local', 'This computer'],
        ['mini-1', 'Mac Mini']
      ]
    )
    assert.equal(get('host').value, 'local')
    assert.deepEqual([get('pref-share-tools').checked, get('pref-link-agents').checked], [true, false])
    assert.equal(get('pref-agent-names').textContent, 'Claude')
    assert.equal(get('update-install').hidden, false)
    assert.match(get('omb-status').textContent, /^Running/)
    get('pref-link-agents').checked = true
    get('pref-link-agents').emit('change')
    await flush()
    assert.deepEqual(calls.find((call) => call.name === 'prefs.set')?.input, { linkAgents: true })
    assert.equal(get('pref-link-agents').checked, true)
    get('update-auto').checked = true
    get('update-auto').emit('change')
    await flush()
    assert.deepEqual(calls.find((call) => call.name === 'updates.auto')?.input, { on: true })
    get('update-banner-install').emit('click')
    await flush()
    assert.ok(calls.some((call) => call.name === 'updates.install'))
    assert.equal(get('update-banner').hidden, true)
    assert.match(get('settings-message').textContent, /^Updated/)
    get('settings-back').emit('click')
    assert.deepEqual([get('main-view').hidden, get('settings-view').hidden], [false, true])
    const listed = calls.filter((call) => call.name === 'bots.list').length
    get('host').value = 'mini-1'
    get('host').emit('change')
    await flush()
    assert.deepEqual(calls.find((call) => call.name === 'hosts.select')?.input, { id: 'mini-1' })
    assert.equal(get('host').value, 'mini-1')
    assert.equal(get('host').disabled, false)
    assert.equal(calls.filter((call) => call.name === 'bots.list').length, listed + 1)
    assert.deepEqual(botNames(get('roster')), ['Remote bot'])
    // Switching clears the old host's bots at once, and a late answer from that host is dropped.
    holdNextBots = true
    win.emit('pageshow')
    await flush()
    assert.ok(holdBots)
    get('host').value = 'local'
    get('host').emit('change')
    assert.equal(get('running').hidden, true)
    assert.deepEqual(botNames(get('roster')), [])
    await flush()
    // Hold the new host's list too, to look at the moment the stale answer lands.
    const stale = holdBots!
    holdNextBots = true
    stale([
      {
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        name: 'Stale bot',
        state: 'idle',
        modelLabel: 'Claude'
      }
    ])
    await flush()
    await flush()
    await flush()
    assert.notEqual(holdBots, stale)
    assert.deepEqual(botNames(get('roster')), [])
    holdBots!([
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        name: 'Fake bot',
        state: 'idle',
        modelLabel: 'Codex'
      }
    ])
    await flush()
    await flush()
    assert.deepEqual(botNames(get('roster')), ['Fake bot'])
    // When Orca cannot list servers, Retry shows and asks Orca again before checking status.
    host = 'mini-1'
    hostsBroken = true
    win.emit('pageshow')
    await flush()
    await flush()
    assert.equal(get('retry').hidden, false)
    hostsBroken = false
    const asked = calls.filter((call) => call.name === 'hosts.get').length
    get('retry').emit('click')
    await flush()
    await flush()
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
