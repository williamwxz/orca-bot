import { test, assert } from 'orca/testing'
import { createCapabilityPicker } from './capability-picker.ts'

class Element {
  children: Element[] = []
  textContent = ''
  className = ''
  hidden = false
  disabled = false
  dataset: Record<string, string> = {}
  style: Record<string, string> = {}
  attrs = new Map<string, string>()
  events = new Map<string, ((e: any) => void)[]>()
  append(...nodes: Element[]) {
    this.children.push(...nodes)
  }
  replaceChildren(...nodes: Element[]) {
    this.children = nodes
  }
  contains(node: Element): boolean {
    return this === node || this.children.some((c) => c.contains(node))
  }
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v)
  }
  addEventListener(k: string, f: (e: any) => void) {
    this.events.set(k, [...(this.events.get(k) ?? []), f])
  }
  emit(k = 'click', e: any = {}) {
    for (const f of this.events.get(k) ?? []) f({ preventDefault() {}, stopPropagation() {}, ...e })
  }
  focus() {
    ;(document as any).activeElement = this
  }
  getBoundingClientRect() {
    return { left: 350, bottom: 550, width: 250, height: 200 }
  }
}
const flush = () => new Promise<void>((r) => setImmediate(r))
test('capability pickers group models, retain missing current choice, assign repeatedly, gate busy and fence stale async work', async () => {
  const saved = ['document', 'window'].map((k) => Object.getOwnPropertyDescriptor(globalThis, k))
  const doc = Object.assign(new Element(), { createElement: () => new Element() })
  const win = Object.assign(new Element(), { innerWidth: 380, innerHeight: 600 })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: win })
  let host = 0,
    changed = 0,
    failure = ''
  const managed: unknown[] = []
  const root = new Element(),
    trigger = new Element(),
    outside = new Element()
  const bot = {
    id: 'a',
    name: 'Work',
    model: 'old/provider/model',
    modelLabel: 'Old model',
    state: 'idle'
  } as any
  const data = {
    connectors: [
      {
        name: 'work-mail',
        rawName: 'gmail',
        provider: 'Cursor',
        fingerprint: 'exact-account',
        enabled: true,
        present: true,
        bots: ['b']
      },
      {
        name: 'owned',
        rawName: 'owned',
        provider: 'OpenMausBot',
        fingerprint: 'owned',
        enabled: true,
        present: true,
        bot: 'a',
        bots: ['a']
      }
    ],
    bots: [{ id: 'a', name: 'Work' }]
  }
  let delayed: Promise<any> | undefined
  const calls: { name: string; input: any }[] = []
  const frame = {
    plugin: {
      request: async (name: string, input: any) => {
        calls.push({ name, input })
        if (delayed) return delayed
        if (failure && name === 'bots.act') throw new Error(failure)
        if (name === 'models.list')
          return {
            groups: [
              {
                instanceId: 'claude.work',
                label: 'Claude Work',
                models: [{ id: 'anthropic/sonnet', label: 'Sonnet' }]
              }
            ]
          }
        if (name === 'mcp.act') data.connectors[0].bots = input.bots
        if (name.startsWith('mcp.')) return structuredClone(data)
        return { ok: true }
      }
    }
  }
  const picker = createCapabilityPicker(root as any, frame as any, {
    changed: async () => {
      changed++
    },
    manage: (...args) => managed.push(args),
    hostGeneration: () => host
  })
  const item = (key: string) => root.children.find((n) => n.dataset.key === key)!
  try {
    await picker.open('model', bot, trigger as any)
    assert.ok(root.children.some((n) => n.textContent === 'Current: Old model'))
    assert.ok(root.children.some((n) => n.textContent === 'Claude Work'))
    assert.equal(root.children.some((n) => n.textContent === 'Cancel'), false)
    assert.equal(root.children.at(-1), item('claude.work/anthropic/sonnet'))
    assert.equal(root.style.left, '122px')
    assert.equal(root.style.top, '392px')
    let stopped = false
    item('claude.work/anthropic/sonnet').emit('click', {
      stopPropagation() {
        stopped = true
      }
    })
    assert.equal(stopped, true)
    await flush()
    assert.deepEqual(calls.find((c) => c.name === 'bots.act')!.input, {
      botId: 'a',
      action: 'model',
      instanceId: 'claude.work',
      model: 'anthropic/sonnet'
    })
    assert.equal(changed, 1)
    assert.equal(item('claude.work/anthropic/sonnet').attrs.get('aria-checked'), 'true')
    doc.emit('keydown', { key: 'Escape' })
    assert.equal((document as any).activeElement, trigger)
    await picker.open('model', { ...bot, state: 'working' }, trigger as any)
    assert.equal(item('claude.work/anthropic/sonnet').disabled, true)
    assert.ok(root.children.some((n) => n.textContent.includes('finishes its reply')))
    picker.update(bot)
    failure = 'Provider is updating'
    item('claude.work/anthropic/sonnet').emit()
    await flush()
    assert.ok(root.children.some((n) => n.textContent === failure))
    assert.equal(picker.switching(), false)
    failure = ''
    await picker.open('connectors', bot, trigger as any)
    assert.equal(root.children.some((n) => n.textContent === 'Cancel'), false)
    assert.equal(root.children.at(-1)?.textContent, 'Manage connectors…')
    doc.emit('keydown', { key: 'ArrowUp' })
    assert.equal((document as any).activeElement, root.children.at(-1))
    doc.emit('keydown', { key: 'ArrowDown' })
    assert.equal((document as any).activeElement, item('work-mail'))
    assert.equal(item('work-mail').children[0].dataset.icon, 'gmail')
    assert.equal(item('owned').disabled, true)
    item('work-mail').emit()
    await flush()
    assert.deepEqual(data.connectors[0].bots, ['b', 'a'])
    assert.equal(root.hidden, false)
    assert.equal(item('work-mail').attrs.get('aria-checked'), 'true')
    assert.equal(
      item('work-mail')
        .children.find((n) => n.textContent === '✓')
        ?.attrs.get('aria-hidden'),
      'true'
    )
    item('work-mail').emit()
    await flush()
    assert.deepEqual(data.connectors[0].bots, ['b'])
    outside.focus()
    doc.emit('click', { target: outside })
    assert.equal(root.hidden, true)
    assert.equal((document as any).activeElement, outside)
    for (const event of ['blur', 'resize']) {
      await picker.open('model', bot, trigger as any)
      outside.focus()
      win.emit(event)
      assert.equal(root.hidden, true)
      assert.equal((document as any).activeElement, outside)
    }
    await picker.open('connectors', bot, trigger as any)
    root.children.find((n) => n.textContent === 'Manage connectors…')!.emit()
    assert.deepEqual(managed, [['a', true]])
    let finish!: (value: any) => void
    delayed = new Promise((resolve) => {
      finish = resolve
    })
    const pending = picker.open('model', bot, trigger as any)
    host++
    picker.close()
    finish({ groups: [] })
    await pending
    assert.equal(root.hidden, true)
    assert.equal(root.children.length, 0)
    delayed = Promise.resolve({ groups: [] })
    await picker.open('model', bot, trigger as any)
    assert.match(root.children.at(-1)!.textContent, /No ready models/)
    for (const key of ['ArrowDown', 'ArrowUp']) {
      doc.emit('keydown', { key })
      assert.equal((document as any).activeElement, root)
    }
    doc.emit('keydown', { key: 'Escape' })
    assert.equal(root.hidden, true)
    assert.equal((document as any).activeElement, trigger)
    delayed = undefined
    await picker.open('model', bot, trigger as any)
    delayed = new Promise((resolve) => {
      finish = resolve
    })
    item('claude.work/anthropic/sonnet').emit()
    const before = changed
    picker.close()
    finish({ ok: true })
    await flush()
    assert.equal(changed, before)
  } finally {
    for (const [i, k] of ['document', 'window'].entries()) {
      if (saved[i]) Object.defineProperty(globalThis, k, saved[i]!)
      else delete (globalThis as any)[k]
    }
  }
})

test('with several backends the model picker chooses a backend first, then its model', async () => {
  const saved = ['document', 'window'].map((k) => Object.getOwnPropertyDescriptor(globalThis, k))
  const doc = Object.assign(new Element(), { createElement: () => new Element() })
  const win = Object.assign(new Element(), { innerWidth: 380, innerHeight: 600 })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: win })
  const calls: { name: string; input: any }[] = []
  const frame = {
    plugin: {
      request: async (name: string, input: any) => {
        calls.push({ name, input })
        if (name === 'models.list')
          return {
            groups: [
              { instanceId: 'claude', label: 'Claude', models: [{ id: 'sonnet', label: 'Sonnet' }] },
              { instanceId: 'grok', label: 'Grok', models: [{ id: 'grok-5', label: 'Grok 5' }] },
              { instanceId: 'empty', label: 'Empty', models: [] }
            ]
          }
        return { ok: true }
      }
    }
  }
  const root = new Element()
  const trigger = new Element()
  const bot = { id: 'a', name: 'Grok Bot', model: 'claude/sonnet', modelLabel: 'Sonnet', backendLabel: 'Claude', state: 'idle' } as any
  const picker = createCapabilityPicker(root as any, frame as any, { changed: async () => {}, manage: () => {} })
  const item = (key: string) => root.children.find((n) => n.dataset.key === key)!
  try {
    await picker.open('model', bot, trigger as any)
    assert.equal(root.children[0].textContent, 'Model for Grok Bot')
    assert.deepEqual(
      root.children.filter((n) => n.dataset.key?.startsWith('backend:')).map((n) => n.dataset.key),
      ['backend:claude', 'backend:grok']
    )
    assert.equal(item('backend:claude').attrs.get('aria-checked'), 'true')
    assert.match(item('backend:claude').textContent, /Claude · Sonnet/)
    assert.equal(item('backend:grok').attrs.get('aria-checked'), 'false')
    item('backend:grok').emit()
    assert.equal(root.children[0].textContent, 'Model for Grok Bot')
    assert.ok(root.children.some((n) => n.textContent === 'Grok'))
    item('grok/grok-5').emit()
    await flush()
    assert.deepEqual(calls.find((c) => c.name === 'bots.act')!.input, {
      botId: 'a',
      action: 'model',
      instanceId: 'grok',
      model: 'grok-5'
    })
    assert.equal(item('grok/grok-5').attrs.get('aria-checked'), 'true')
    item('backends').emit()
    assert.equal(item('backend:grok').attrs.get('aria-checked'), 'true')
    assert.match(item('backend:grok').textContent, /Grok · Grok 5/)
    // The Model button opens the current backend's models directly.
    await picker.open('model', { ...bot, model: 'grok/grok-5' }, trigger as any, 'models')
    assert.equal(root.children[0].textContent, 'Model for Grok Bot')
    assert.ok(item('grok/grok-5'))
    assert.ok(item('backends'))
    picker.close()
  } finally {
    for (const [i, k] of ['document', 'window'].entries()) {
      if (saved[i]) Object.defineProperty(globalThis, k, saved[i]!)
      else delete (globalThis as any)[k]
    }
  }
})

test('Backend is a panel from the right with the bot\'s screen, a Works on grid with real status, and a hint', async () => {
  const saved = ['document', 'window'].map((k) => Object.getOwnPropertyDescriptor(globalThis, k))
  const doc = Object.assign(new Element(), { createElement: () => new Element() })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new Element(), { innerWidth: 380, innerHeight: 600 }) })
  const all = (n: Element): Element[] => [n, ...n.children.flatMap(all)]
  try {
    const root = new Element()
    root.className = 'bot-menu'
    const acts: any[] = []
    const notes: string[] = []
    const opened: string[] = []
    let native = true
    const frame = { plugin: { request: async (name: string, input: any) => {
      if (name === 'computer.status') return { now: 'vm', cloud: 'setup', vm: 'repair', browser: 'ready' }
      if (name === 'bots.act') acts.push(input)
      return { ok: true }
    } } }
    // Not narrow: Backend is a panel from the right at every width.
    const picker = createCapabilityPicker(root as any, frame as any, {
      changed: async () => {}, manage: () => {}, notify: (t) => notes.push(t), sheet: () => false,
      openNative: (id) => opened.push(id), nativeAvailable: () => native
    })
    const bot = { id: 'a', name: 'Scout', model: 'claude/s', modelLabel: 'Sonnet', state: 'idle', computer: 'vm' } as any
    await picker.open('computer', bot, new Element() as any)
    assert.match(root.className, / sheet$/)
    assert.equal(root.style.left, '')
    assert.equal(root.children[0].className, 'sheet-head')
    assert.equal(root.children[0].children[0].textContent, 'Backend for Scout')
    const text = () => all(root).map((n) => n.textContent)
    assert.ok(text().includes("Scout's screen"))
    assert.ok(text().includes('Right now: Private desktop'))
    assert.ok(text().includes('Works on'))
    const tiles = () => all(root).filter((n) => n.className.includes('works-tile'))
    assert.deepEqual(tiles().map((n) => n.dataset.key), ['auto', 'cloud', 'vm', 'local', 'browser', 'off'])
    const tile = (key: string) => tiles().find((n) => n.dataset.key === key)!
    assert.equal(tile('vm').attrs.get('aria-checked'), 'true')
    assert.equal(tile('cloud').attrs.get('aria-label'), 'Cloud desktop: Not set up yet')
    assert.equal(tile('vm').attrs.get('aria-label'), 'Private desktop: Needs repair')
    assert.equal(tile('browser').attrs.get('aria-label'), 'Browser: Only websites')
    assert.match(tile('cloud').className, /flagged/)
    assert.ok(text().some((t) => /Private desktop needs repair\. Do that below/.test(t)))
    // No desktop detail in this status: no setup block, and no native link for Private desktop.
    assert.equal(all(root).some((n) => n.dataset.key === 'native'), false)
    tile('browser').emit()
    await flush()
    assert.deepEqual(acts, [{ botId: 'a', action: 'computer', computer: 'browser' }])
    assert.deepEqual(notes, ['Backend updated.'])
    assert.equal(tile('browser').attrs.get('aria-checked'), 'true')
    assert.ok(text().includes('The built-in browser only: websites, no desktop.'))
    tile('cloud').emit()
    await flush()
    assert.ok(text().includes('Connect a cloud desktop in native OpenMausBot'))
    all(root).find((n) => n.dataset.key === 'native')!.emit()
    assert.deepEqual(opened, ['a'])
    assert.equal(root.hidden, true)
    assert.doesNotMatch(root.className, /sheet/)
    native = false
    await picker.open('computer', { ...bot, computer: 'off' }, new Element() as any)
    assert.equal(all(root).some((n) => n.dataset.key === 'native'), false)
    assert.ok(text().includes("This bot's computer is off"))
    root.children[0].children[1].emit()
    assert.equal(root.hidden, true)
  } finally {
    for (const [i, k] of ['document', 'window'].entries()) {
      if (saved[i]) Object.defineProperty(globalThis, k, saved[i]!)
      else delete (globalThis as any)[k]
    }
  }
})

test('the Backend panel sets up a private desktop and installs the browser in place', async () => {
  const saved = ['document', 'window'].map((k) => Object.getOwnPropertyDescriptor(globalThis, k))
  const doc = Object.assign(new Element(), { createElement: () => new Element() })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new Element(), { innerWidth: 380, innerHeight: 600 }) })
  const all = (n: Element): Element[] => [n, ...n.children.flatMap(all)]
  try {
    const root = new Element()
    const requests: [string, any][] = []
    const notes: string[] = []
    let desktop: any = { mode: 'shared', maxInstances: 2, idleMinutes: 480, state: 'repair', runtime: 'Docker' }
    let browser: any = { browser: 'setup' }
    let finishStep!: () => void
    const frame = { plugin: { request: async (name: string, input: any) => {
      requests.push([name, input])
      if (name === 'computer.status') return { vm: 'repair', ...browser, desktop }
      if (name === 'desktop.act') {
        await new Promise<void>((resolve) => { finishStep = resolve })
        desktop = { ...desktop, state: 'running' }
        return desktop
      }
      if (name === 'browser.install') { browser = { browser: 'setup', browserInstalling: true }; return { installing: true } }
      return { ok: true }
    } } }
    const picker = createCapabilityPicker(root as any, frame as any, { changed: async () => {}, manage: () => {}, notify: (t) => notes.push(t) })
    const bot = { id: 'a', name: 'Scout', state: 'idle', computer: 'vm' } as any
    await picker.open('computer', bot, new Element() as any)
    const text = () => all(root).map((n) => n.textContent)
    const key = (k: string) => all(root).find((n) => n.dataset.key === k)!
    assert.ok(text().includes('Private desktop'))
    assert.ok(text().includes('Replace the older or unsafe desktop'))
    const steps = all(root).filter((n) => n.tag === 'li' || n.attrs.has('aria-label') && /: (done|next|not yet)$/.test(n.attrs.get('aria-label')!))
    assert.deepEqual(steps.map((n) => n.attrs.get('aria-label')), [
      'Install the container app: done', 'Start it: done', 'Get the desktop ready: done', 'Create the desktop: done'
    ])
    assert.equal(key('desktop:recreate').textContent, 'Delete and recreate')
    key('desktop:recreate').emit()
    await flush()
    assert.deepEqual(requests.find(([n]) => n === 'desktop.act')![1], { action: 'recreate', botId: 'a' })
    assert.equal(key('desktop:recreate').textContent, 'Recreating…')
    assert.equal(key('desktop:recreate').disabled, true)
    finishStep()
    await flush()
    await flush()
    assert.deepEqual(notes, ['Private desktop updated.'])
    assert.ok(text().includes('Running'))
    assert.equal(key('desktop:stop').textContent, 'Stop')
    picker.close()
    await picker.open('computer', { ...bot, computer: 'browser' }, new Element() as any)
    assert.ok(text().includes('Built-in browser'))
    key('browser:install').emit()
    await flush()
    assert.ok(requests.some(([n]) => n === 'browser.install'))
    assert.equal(key('browser:install').textContent, 'Installing…')
    assert.equal(key('browser:install').disabled, true)
    picker.close()
  } finally {
    for (const [i, k] of ['document', 'window'].entries()) {
      if (saved[i]) Object.defineProperty(globalThis, k, saved[i]!)
      else delete (globalThis as any)[k]
    }
  }
})

test('the late status redraw keeps the keyboard on the tile the person moved to', async () => {
  const saved = ['document', 'window'].map((k) => Object.getOwnPropertyDescriptor(globalThis, k))
  const doc = Object.assign(new Element(), { createElement: () => new Element() })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new Element(), { innerWidth: 380, innerHeight: 600 }) })
  const all = (n: Element): Element[] => [n, ...n.children.flatMap(all)]
  try {
    const root = new Element()
    let arrive!: (value: unknown) => void
    const frame = { plugin: { request: async () => new Promise((resolve) => { arrive = resolve }) } }
    const picker = createCapabilityPicker(root as any, frame as any, { changed: async () => {}, manage: () => {} })
    const opening = picker.open('computer', { id: 'a', name: 'Scout', state: 'idle' } as any, new Element() as any)
    await flush()
    all(root).find((n) => n.dataset.key === 'cloud')!.focus()
    arrive({ cloud: 'setup' })
    await opening
    assert.equal((document as any).activeElement.dataset.key, 'cloud')
    assert.equal((document as any).activeElement.attrs.get('aria-label'), 'Cloud desktop: Not set up yet')
    picker.close()
  } finally {
    for (const [i, k] of ['document', 'window'].entries()) {
      if (saved[i]) Object.defineProperty(globalThis, k, saved[i]!)
      else delete (globalThis as any)[k]
    }
  }
})

test('in a narrow panel the model picker is also a sheet; in a wide one it is a dropdown', async () => {
  const saved = ['document', 'window'].map((k) => Object.getOwnPropertyDescriptor(globalThis, k))
  const doc = Object.assign(new Element(), { createElement: () => new Element() })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new Element(), { innerWidth: 380, innerHeight: 600 }) })
  try {
    const root = new Element()
    const frame = { plugin: { request: async () => ({ groups: [{ instanceId: 'claude', label: 'Claude', models: [{ id: 's', label: 'Sonnet' }] }] }) } }
    let narrow = true
    const picker = createCapabilityPicker(root as any, frame as any, { changed: async () => {}, manage: () => {}, sheet: () => narrow })
    const bot = { id: 'a', name: 'Scout', model: 'claude/s', modelLabel: 'Sonnet', state: 'idle' } as any
    await picker.open('model', bot, new Element() as any)
    assert.match(root.className, / sheet$/)
    assert.equal(root.children[0].children[0].textContent, 'Model for Scout')
    narrow = false
    await picker.open('model', bot, new Element() as any)
    assert.doesNotMatch(root.className, /sheet/)
    picker.close()
  } finally {
    for (const [i, k] of ['document', 'window'].entries()) {
      if (saved[i]) Object.defineProperty(globalThis, k, saved[i]!)
      else delete (globalThis as any)[k]
    }
  }
})
