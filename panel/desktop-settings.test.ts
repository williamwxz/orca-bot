import { assert, test } from 'orca/testing'
import { createDesktopSettings } from './desktop-settings.ts'

class Element {
  tag: string
  children: Element[] = []
  textContent = ''
  className = ''
  hidden = false
  disabled = false
  value = ''
  type = ''
  min = ''
  max = ''
  step = ''
  dataset: Record<string, string> = {}
  attrs = new Map<string, string>()
  events = new Map<string, ((e: any) => void)[]>()
  constructor(tag = 'div') { this.tag = tag }
  append(...nodes: Element[]) { this.children.push(...nodes) }
  replaceChildren(...nodes: Element[]) { this.children = nodes }
  setAttribute(k: string, v: string) { this.attrs.set(k, v) }
  addEventListener(k: string, f: (e: any) => void) { this.events.set(k, [...(this.events.get(k) ?? []), f]) }
  emit(k = 'click', e: any = {}) { for (const f of this.events.get(k) ?? []) f({ stopPropagation() {}, ...e }) }
}
const flush = () => new Promise<void>((r) => setImmediate(r))
const all = (n: Element): Element[] => [n, ...n.children.flatMap(all)]

test('Settings → Private desktops sets up the shared desktop, switches isolation and saves the idle time', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const savedTimer = Object.getOwnPropertyDescriptor(globalThis, 'setTimeout')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: (tag: string) => new Element(tag) } })
  Object.defineProperty(globalThis, 'setTimeout', { configurable: true, value: (fn: () => void) => { setImmediate(fn); return 0 } })
  try {
    const els = new Map<string, Element>()
    const get = (id: string) => els.get(id) ?? (els.set(id, new Element()), els.get(id)!)
    const calls: [string, any][] = []
    const notes: string[] = []
    let status: any = { mode: 'shared', maxInstances: 2, idleMinutes: 480, state: 'not-prepared', runtime: 'Docker' }
    let failedOnce = false
    const frame = { plugin: { request: async (name: string, input: any) => {
      calls.push([name, input])
      if (name === 'desktop.status') {
        // One poll fails while the step runs: the controls stay and the next poll carries on.
        if (status.step?.running && !failedOnce) { failedOnce = true; throw new Error('timed out') }
        return status
      }
      if (name === 'desktop.act') {
        status = { ...status, step: { id: 1, action: input.action, running: true } }
        setTimeout(() => { status = { ...status, state: 'not-created', step: { id: 1, action: input.action, running: false } } }, 0)
        return { step: status.step }
      }
      if (name === 'desktop.settings') { status = { ...status, ...input }; return status }
      return {}
    } } }
    const view = createDesktopSettings(frame as any, get as any, (t) => notes.push(t))
    await view.refresh()
    const text = (id: string) => all(get(id)).map((n) => n.textContent)
    const find = (id: string, match: (n: Element) => boolean) => all(get(id)).find(match)!
    assert.ok(text('desktops-setup').includes('Get the desktop ready'))
    find('desktops-setup', (n) => n.dataset.key === 'desktop:prepare').emit()
    for (let i = 0; i < 8; i++) await flush()
    assert.deepEqual(calls.find(([n]) => n === 'desktop.act')![1], { action: 'prepare' })
    assert.deepEqual(notes, ['Private desktop updated.'])
    assert.ok(text('desktops-setup').includes('Create the private desktop'))
    // Isolation: Shared is chosen; choosing Per bot saves it and shows the maximum.
    const radio = (label: string) => find('desktops-options', (n) => n.attrs.get('role') === 'radio' && n.textContent === label)
    assert.equal(radio('Shared').attrs.get('aria-checked'), 'true')
    assert.equal(all(get('desktops-options')).some((n) => n.tag === 'select'), false)
    radio('Per bot').emit()
    await flush()
    await flush()
    assert.deepEqual(calls.find(([n]) => n === 'desktop.settings')![1], { mode: 'per-bot' })
    assert.equal(radio('Per bot').attrs.get('aria-checked'), 'true')
    assert.ok(text('desktops-setup').some((t) => /Create each bot's desktop from its Backend panel/.test(t)))
    const select = find('desktops-options', (n) => n.tag === 'select')
    select.value = '4'
    select.emit('change')
    await flush()
    await flush()
    assert.deepEqual(calls.filter(([n]) => n === 'desktop.settings').at(-1)![1], { maxInstances: 4 })
    const minutes = () => find('desktops-options', (n) => n.tag === 'input')
    minutes().value = '3'
    minutes().emit('change')
    assert.equal(notes.at(-1), 'Enter a whole number from 5 to 1,440.')
    assert.equal(minutes().value, '480')
    minutes().value = '60'
    minutes().emit('change')
    await flush()
    await flush()
    assert.deepEqual(calls.filter(([n]) => n === 'desktop.settings').at(-1)![1], { idleMinutes: 60 })
    view.clear()
    assert.equal(get('desktops-options').children.length, 0)
  } finally {
    if (saved) Object.defineProperty(globalThis, 'document', saved)
    else delete (globalThis as any).document
    if (savedTimer) Object.defineProperty(globalThis, 'setTimeout', savedTimer)
  }
})

test('Settings stops following a step whose report disappears, and says the outcome is unconfirmed', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const savedTimer = Object.getOwnPropertyDescriptor(globalThis, 'setTimeout')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: (tag: string) => new Element(tag) } })
  Object.defineProperty(globalThis, 'setTimeout', { configurable: true, value: (fn: () => void) => { setImmediate(fn); return 0 } })
  try {
    const { FOLLOW_MISSES } = await import('./capability-picker.ts')
    const els = new Map<string, Element>()
    const get = (id: string) => els.get(id) ?? (els.set(id, new Element()), els.get(id)!)
    let reads = 0
    // The worker restarted after accepting the step: every status succeeds, none mentions it.
    const frame = { plugin: { request: async (name: string) => {
      if (name === 'desktop.act') return { step: { id: 5, action: 'prepare', running: true } }
      if (name === 'desktop.status') { reads++; return { mode: 'shared', maxInstances: 2, idleMinutes: 480, state: 'not-prepared' } }
      return {}
    } } }
    const view = createDesktopSettings(frame as any, get as any, () => {})
    await view.refresh()
    all(get('desktops-setup')).find((n) => n.dataset.key === 'desktop:prepare')!.emit()
    for (let i = 0; i < FOLLOW_MISSES * 4 + 10; i++) await flush()
    assert.match(get('desktops-note').textContent, /Could not confirm how the last step ended/)
    const settled = reads
    for (let i = 0; i < 10; i++) await flush()
    assert.equal(reads, settled, 'no more polling once given up')
    // Only a re-check until fresh status arrives; then the real next step returns.
    assert.equal(all(get('desktops-setup')).some((n) => n.dataset.key === 'desktop:prepare'), false)
    all(get('desktops-setup')).find((n) => n.dataset.key === 'desktop:check')!.emit()
    for (let i = 0; i < 6; i++) await flush()
    assert.equal(all(get('desktops-setup')).find((n) => n.dataset.key === 'desktop:prepare')!.disabled, false)
  } finally {
    if (saved) Object.defineProperty(globalThis, 'document', saved)
    else delete (globalThis as any).document
    if (savedTimer) Object.defineProperty(globalThis, 'setTimeout', savedTimer)
  }
})

test('leaving Settings drops a status read still in flight, so nothing polls or announces later', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const savedTimer = Object.getOwnPropertyDescriptor(globalThis, 'setTimeout')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: (tag: string) => new Element(tag) } })
  let timers = 0
  Object.defineProperty(globalThis, 'setTimeout', { configurable: true, value: (fn: () => void) => { timers++; setImmediate(fn); return 0 } })
  try {
    const els = new Map<string, Element>()
    const get = (id: string) => els.get(id) ?? (els.set(id, new Element()), els.get(id)!)
    let answer!: (value: unknown) => void
    const notes: string[] = []
    const frame = { plugin: { request: async (name: string) => {
      if (name === 'desktop.status') return new Promise((resolve) => { answer = resolve })
      return {}
    } } }
    const view = createDesktopSettings(frame as any, get as any, (t) => notes.push(t))
    const loading = view.refresh()
    view.clear()
    answer({ mode: 'shared', maxInstances: 2, idleMinutes: 480, state: 'stopped', step: { id: 2, action: 'start', running: true } })
    await loading
    for (let i = 0; i < 6; i++) await flush()
    assert.equal(timers, 0, 'no poll was scheduled')
    assert.deepEqual(notes, [])
    assert.equal(get('desktops-setup').children.length, 0)
  } finally {
    if (saved) Object.defineProperty(globalThis, 'document', saved)
    else delete (globalThis as any).document
    if (savedTimer) Object.defineProperty(globalThis, 'setTimeout', savedTimer)
  }
})
