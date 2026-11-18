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
    assert.equal(item('work-mail').children[0].dataset.icon, 'gmail')
    assert.equal(item('owned').disabled, true)
    item('work-mail').emit()
    await flush()
    assert.deepEqual(data.connectors[0].bots, ['b', 'a'])
    assert.equal(root.hidden, false)
    assert.equal(item('work-mail').attrs.get('aria-checked'), 'true')
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
