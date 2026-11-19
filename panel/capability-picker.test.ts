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

test('the Backend panel explains a desktop it must replace, follows the step to the end, and resumes a browser install', async () => {
  const saved = ['document', 'window', 'setTimeout'].map((k) => Object.getOwnPropertyDescriptor(globalThis, k))
  const doc = Object.assign(new Element(), { createElement: () => new Element() })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new Element(), { innerWidth: 380, innerHeight: 600 }) })
  // Poll timers fire on the next turn instead of after 2.5 seconds.
  Object.defineProperty(globalThis, 'setTimeout', { configurable: true, value: (fn: () => void) => { setImmediate(fn); return 0 } })
  const all = (n: Element): Element[] => [n, ...n.children.flatMap(all)]
  try {
    const root = new Element()
    const requests: [string, any][] = []
    const notes: string[] = []
    let desktop: any = { mode: 'shared', maxInstances: 2, idleMinutes: 480, state: 'repair', reason: 'no-folder', runtime: 'Docker' }
    let browser: any = { browser: 'setup' }
    let polls = 0
    let failNextPoll = false
    let holdDesktop = false
    const frame = { plugin: { request: async (name: string, input: any) => {
      requests.push([name, input])
      if (name === 'computer.status') {
        // The first poll after the step starts times out: that must not end the step.
        if (failNextPoll) { failNextPoll = false; throw new Error('timed out') }
        // The step runs for two polls, then finishes.
        if (desktop.step?.running && !holdDesktop && ++polls > 2) desktop = { ...desktop, state: 'running', reason: undefined, step: { ...desktop.step, running: false } }
        return { vm: 'repair', ...browser, desktop }
      }
      if (name === 'desktop.act') {
        desktop = { ...desktop, step: { id: 7, action: input.action, running: true } }
        return { step: desktop.step }
      }
      return { ok: true }
    } } }
    const picker = createCapabilityPicker(root as any, frame as any, { changed: async () => {}, manage: () => {}, notify: (t) => notes.push(t) })
    const bot = { id: 'a', name: 'Scout', state: 'idle', computer: 'vm' } as any
    await picker.open('computer', bot, new Element() as any)
    const text = () => all(root).map((n) => n.textContent)
    const key = (k: string) => all(root).find((n) => n.dataset.key === k)!
    // You did not make this desktop: say what is wrong with it in plain words.
    assert.ok(text().includes('A private desktop already exists, but it cannot be used'))
    assert.ok(text().some((t) => /could not confirm the writable folder/.test(t)))
    // An unconfirmed folder is not promised to survive the replacement.
    assert.ok(text().some((t) => /may not be kept/.test(t)))
    assert.equal(text().some((t) => /folder and browser sign-ins are kept/.test(t)), false)
    const steps = all(root).filter((n) => /: (done|next|not yet)$/.test(n.attrs.get('aria-label') ?? ''))
    assert.deepEqual(steps.map((n) => n.attrs.get('aria-label')), [
      'Install the container app: done', 'Start it: done', 'Get the desktop ready: done', 'Replace the desktop: next'
    ])
    assert.equal(key('desktop:recreate').textContent, 'Replace with a fresh desktop')
    failNextPoll = true
    key('desktop:recreate').emit()
    await flush()
    assert.deepEqual(requests.find(([n]) => n === 'desktop.act')![1], { action: 'recreate', botId: 'a' })
    assert.equal(key('desktop:recreate').textContent, 'Replacing…')
    await flush()
    await flush()
    assert.equal(key('desktop:recreate').textContent, 'Replacing…', 'a failed poll keeps following the step')
    assert.equal(key('desktop:recreate').disabled, true)
    for (let i = 0; i < 8; i++) await flush()
    assert.deepEqual(notes, ['Private desktop updated.'])
    assert.ok(text().includes('Running'))
    assert.equal(key('desktop:stop').textContent, 'Stop')
    picker.close()
    // A step that fails reports its fixed wording.
    desktop = { ...desktop, state: 'stopped', step: { id: 8, action: 'start', running: false, error: 'The container app is not ready. Start Docker or Podman, then try again.' } }
    polls = 0
    await picker.open('computer', bot, new Element() as any)
    assert.equal(notes.length, 1, 'an old finished step is not announced again on reopen')
    picker.close()
    // Reopened while the browser installs and a desktop step runs: each is followed on its own,
    // and the browser button frees up even though the desktop step is still going.
    desktop = { ...desktop, step: { id: 9, action: 'prepare', running: true } }
    holdDesktop = true
    browser = { browser: 'setup', browserInstalling: true }
    let browserPolls = 0
    const status = frame.plugin.request
    frame.plugin.request = (async (name: string, input: any) => {
      if (name === 'computer.status' && ++browserPolls > 2) browser = { browser: 'ready' }
      return status(name, input)
    }) as any
    await picker.open('computer', { ...bot, computer: 'browser' }, new Element() as any)
    assert.equal(key('browser:install').textContent, 'Installing…')
    for (let i = 0; i < 8; i++) await flush()
    assert.equal(notes.at(-1), 'The browser is ready.')
    assert.equal(desktop.step.running, true)
    picker.close()
  } finally {
    for (const [i, k] of ['document', 'window', 'setTimeout'].entries()) {
      if (saved[i]) Object.defineProperty(globalThis, k, saved[i]!)
      else delete (globalThis as any)[k]
    }
  }
})

test('a desktop that did not start warns what replacing it removes', async () => {
  const { desktopStep } = await import('./desktop-setup.ts')
  const failed = desktopStep({ mode: 'shared', maxInstances: 2, idleMinutes: 480, state: 'failed' }, false)
  assert.equal(failed.action, 'recreate')
  assert.match(failed.line, /apps and files stored anywhere else inside it are removed/)
  const old = desktopStep({ mode: 'shared', maxInstances: 2, idleMinutes: 480, state: 'repair', reason: 'old-image' }, false)
  assert.match(old.line, /older OpenMausBot.*keeps its shared folder and browser sign-ins/)
  // Old image and an unconfirmed folder at once: the shown reason is the image, but nothing is
  // promised about the folder.
  const both = desktopStep({ mode: 'shared', maxInstances: 2, idleMinutes: 480, state: 'repair', reason: 'old-image', folderUnverified: true }, false)
  assert.match(both.line, /older OpenMausBot/)
  assert.match(both.line, /may not be kept/)
  assert.doesNotMatch(both.line, /keeps its shared folder/)
  const failedUnverified = desktopStep({ mode: 'shared', maxInstances: 2, idleMinutes: 480, state: 'failed', folderUnverified: true }, false)
  assert.match(failedUnverified.line, /may not be kept/)
})

test('a step whose host stops answering is given up after a bounded wait, not followed forever', async () => {
  const saved = ['document', 'window', 'setTimeout'].map((k) => Object.getOwnPropertyDescriptor(globalThis, k))
  Object.defineProperty(globalThis, 'document', { configurable: true, value: Object.assign(new Element(), { createElement: () => new Element() }) })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new Element(), { innerWidth: 380, innerHeight: 600 }) })
  Object.defineProperty(globalThis, 'setTimeout', { configurable: true, value: (fn: () => void) => { setImmediate(fn); return 0 } })
  const all = (n: Element): Element[] => [n, ...n.children.flatMap(all)]
  try {
    const { FOLLOW_MISSES } = await import('./capability-picker.ts')
    const root = new Element()
    const notes: string[] = []
    let polls = 0
    let online = true
    let wentOffline = false
    const lifecycle: string[] = []
    // A replace was running; it finishes while the host is unreachable.
    let desktop: any = { mode: 'shared', maxInstances: 2, idleMinutes: 480, state: 'repair', reason: 'old-image', step: { id: 3, action: 'recreate', running: true } }
    const frame = { plugin: { request: async (name: string, input: any) => {
      if (name === 'desktop.act') { lifecycle.push(input.action); return { step: { id: 4, action: input.action, running: true } } }
      if (name !== 'computer.status') return { ok: true }
      polls++
      // One good "still running" answer after opening, then the host goes away.
      if (polls > 2 && online && !wentOffline) { wentOffline = true; online = false; desktop = { ...desktop, state: 'running', reason: undefined, step: { id: 3, action: 'recreate', running: false } } }
      if (!online) throw new Error('offline')
      return { vm: 'ready', desktop }
    } } }
    const picker = createCapabilityPicker(root as any, frame as any, { changed: async () => {}, manage: () => {}, notify: (t) => notes.push(t) })
    await picker.open('computer', { id: 'a', name: 'Scout', state: 'idle', computer: 'vm' } as any, new Element() as any)
    const key = (k: string) => all(root).find((n) => n.dataset.key === k)!
    assert.equal(key('desktop:recreate').textContent, 'Replacing…')
    for (let i = 0; i < FOLLOW_MISSES * 3 + 10; i++) await new Promise<void>((r) => setImmediate(r))
    assert.deepEqual(notes, ['Could not confirm how the step ended. Check the private desktop again.'])
    const settled = polls
    for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r))
    assert.equal(polls, settled, 'no more polling once given up')
    // Only a re-check is offered: the cached status still says "replace".
    assert.equal(all(root).some((n) => n.dataset.key === 'desktop:recreate'), false)
    assert.equal(key('desktop:check').textContent, 'Check again')
    online = true
    key('desktop:check').emit()
    for (let i = 0; i < 6; i++) await new Promise<void>((r) => setImmediate(r))
    assert.deepEqual(lifecycle, [], 'the first click sends no lifecycle step')
    // The fresh status shows the replace already worked.
    assert.equal(key('desktop:stop').textContent, 'Stop')
    picker.close()
  } finally {
    for (const [i, k] of ['document', 'window', 'setTimeout'].entries()) {
      if (saved[i]) Object.defineProperty(globalThis, k, saved[i]!)
      else delete (globalThis as any)[k]
    }
  }
})

test('a re-check that finds the step still running follows it again to the end', async () => {
  const saved = ['document', 'window', 'setTimeout'].map((k) => Object.getOwnPropertyDescriptor(globalThis, k))
  Object.defineProperty(globalThis, 'document', { configurable: true, value: Object.assign(new Element(), { createElement: () => new Element() }) })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new Element(), { innerWidth: 380, innerHeight: 600 }) })
  Object.defineProperty(globalThis, 'setTimeout', { configurable: true, value: (fn: () => void) => { setImmediate(fn); return 0 } })
  const all = (n: Element): Element[] => [n, ...n.children.flatMap(all)]
  try {
    const { FOLLOW_MISSES } = await import('./capability-picker.ts')
    const root = new Element()
    const notes: string[] = []
    let online = false
    let polls = 0
    let desktop: any = { mode: 'shared', maxInstances: 2, idleMinutes: 480, state: 'not-prepared', step: { id: 6, action: 'prepare', running: true } }
    const frame = { plugin: { request: async (name: string) => {
      if (name !== 'computer.status') return { ok: true }
      // The first status (on open) answers; then the host is unreachable until the re-check.
      if (++polls > 1 && !online) throw new Error('offline')
      if (online && polls > 3) desktop = { ...desktop, state: 'not-created', step: { ...desktop.step, running: false } }
      return { vm: 'setup', desktop }
    } } }
    const picker = createCapabilityPicker(root as any, frame as any, { changed: async () => {}, manage: () => {}, notify: (t) => notes.push(t) })
    await picker.open('computer', { id: 'a', name: 'Scout', state: 'idle', computer: 'vm' } as any, new Element() as any)
    for (let i = 0; i < FOLLOW_MISSES * 3 + 10; i++) await new Promise<void>((r) => setImmediate(r))
    const key = (k: string) => all(root).find((n) => n.dataset.key === k)!
    assert.equal(key('desktop:check').textContent, 'Check again')
    online = true
    polls = 1
    key('desktop:check').emit()
    for (let i = 0; i < 12; i++) await new Promise<void>((r) => setImmediate(r))
    assert.equal(notes.at(-1), 'Private desktop updated.')
    assert.equal(key('desktop:create').textContent, 'Create private desktop')
    assert.equal(key('desktop:create').disabled, false)
    picker.close()
  } finally {
    for (const [i, k] of ['document', 'window', 'setTimeout'].entries()) {
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
