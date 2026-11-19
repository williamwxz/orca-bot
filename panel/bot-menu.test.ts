import { test, assert } from 'orca/testing'
import { createBotMenu } from './bot-menu.ts'
import type { Connectors, ConnectorAction } from '../worker/mcp-connectors.ts'

class Element {
  children: Element[] = []
  textContent = ''
  className = ''
  hidden = true
  disabled = false
  style = {}
  dataset: Record<string, string> = {}
  attrs = new Map<string, string>()
  events = new Map<string, (event?: any) => void>()
  append(...nodes: Element[]) {
    this.children.push(...nodes)
  }
  replaceChildren(...nodes: Element[]) {
    this.children = nodes
  }
  setAttribute(key: string, value: string) {
    this.attrs.set(key, value)
  }
  contains(node: Element): boolean {
    return this === node || this.children.some((c) => c.contains(node))
  }
  addEventListener(name: string, cb: (event?: any) => void) {
    this.events.set(name, cb)
  }
  focus() {
    ;(document as any).activeElement = this
  }
  getBoundingClientRect() {
    return { left: 300, bottom: 500, width: 240, height: 200 }
  }
  emit(name = 'click', event?: any) {
    this.events.get(name)?.({ stopPropagation() {}, ...event })
  }
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

test('bot menu connector checklist loads, toggles repeatedly, handles errors and ignores closed or replaced responses', async () => {
  const originals = ['document', 'window'].map((key) =>
    Object.getOwnPropertyDescriptor(globalThis, key)
  )
  const doc = Object.assign(new Element(), { createElement: () => new Element() })
  const win = Object.assign(new Element(), { innerWidth: 380, innerHeight: 600 })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: win })
  const root = new Element()
  const bot = { id: 'work', name: 'Work Assistant' } as any
  let data: Connectors = {
    bots: [{ id: 'work', name: 'Work Assistant' }],
    connectors: [
      {
        name: 'gmail',
        rawName: 'gmail',
        provider: 'Claude Desktop',
        fingerprint: 'personal',
        present: true,
        enabled: true,
        bots: ['personal']
      },
      {
        name: 'pinned',
        rawName: 'pinned',
        provider: 'Cursor',
        fingerprint: 'pinned',
        present: true,
        enabled: true,
        bot: 'work',
        bots: ['work']
      },
      {
        name: 'off',
        rawName: 'off',
        provider: 'Codex',
        fingerprint: 'off',
        present: true,
        enabled: false,
        bots: []
      }
    ]
  }
  const actions: ConnectorAction[] = []
  const managed: unknown[] = []
  let pending: Promise<Connectors> | undefined
  let failure = ''
  const menu = createBotMenu(
    root as any,
    async () => {},
    async () => undefined,
    {
      list: async () => pending ?? structuredClone(data),
      act: async (input) => {
        actions.push(input)
        if (failure) throw new Error(failure)
        if (input.action === 'assign') data.connectors[0].bots = input.bots
        return structuredClone(data)
      },
      manage: (...args) => managed.push(args)
    },
    {
      frame: {
        plugin: {
          request: async () => ({
            groups: [
              { instanceId: 'codex', label: 'Codex', models: [{ id: 'gpt-6', label: 'GPT-6' }] }
            ]
          })
        }
      } as any,
      hooks: { changed: async () => {}, manage: () => {} }
    }
  )
  const click = (label: string) => root.children.find((c) => c.textContent === label)!.emit()
  try {
    menu.open(bot, [], { clientX: 370, clientY: 590 })
    assert.deepEqual(
      root.children.map((c) => c.textContent),
      ['Pin', 'Model', 'Backend', 'Connectors', 'Rename', 'Group', '', 'Delete']
    )
    click('Model')
    menu.openGroup('Team')
    await flush()
    assert.deepEqual(root.children.map(c => c.textContent), ['Rename'])
    menu.open(bot, [])
    click('Model')
    await flush()
    assert.ok(root.children.some((c) => c.textContent === 'GPT-6'))
    doc.emit('keydown', { key: 'Escape', preventDefault() {} })
    menu.open({ ...bot, state: 'working' }, [])
    click('Model')
    await flush()
    assert.ok(root.children.some((c) => c.textContent.includes('finishes its reply')))
    assert.equal(root.children.find((c) => c.textContent === 'GPT-6')!.disabled, true)
    menu.close()
    menu.open(bot, [])
    click('Connectors')
    assert.ok(root.children.some((c) => c.textContent === 'Loading connectors…'))
    await flush()
    let choice = root.children.find((c) => c.attrs.get('role') === 'menuitemcheckbox')!
    assert.equal(root.children.filter((c) => c.attrs.get('role') === 'menuitemcheckbox').length, 1)
    assert.equal(choice.attrs.get('aria-checked'), 'false')
    choice.emit()
    assert.equal(
      root.children.find((c) => c.attrs.get('role') === 'menuitemcheckbox')!.disabled,
      true
    )
    await flush()
    assert.deepEqual(actions.at(-1), {
      action: 'assign',
      name: 'gmail',
      fingerprint: 'personal',
      bots: ['personal', 'work']
    })
    choice = root.children.find((c) => c.attrs.get('role') === 'menuitemcheckbox')!
    assert.equal(root.hidden, false)
    assert.equal(choice.attrs.get('aria-checked'), 'true')
    assert.equal((document as any).activeElement, choice)
    failure = 'A bot is currently working. Retry once all bots are idle.'
    choice.emit()
    await flush()
    assert.ok(root.children.some((c) => c.textContent === failure))
    failure = ''
    click('✓ gmail · Claude Desktop')
    await flush()
    assert.deepEqual(data.connectors[0].bots, ['personal'])
    click('Manage connectors')
    assert.equal(root.hidden, true)
    assert.deepEqual(managed, [['work', true]])
    let resolve!: (value: Connectors) => void
    pending = new Promise((done) => {
      resolve = done
    })
    menu.open(bot, [])
    click('Connectors')
    menu.close()
    resolve(data)
    await flush()
    assert.equal(root.hidden, true)
    assert.equal(root.children.length, 0)
    pending = undefined
    data = { connectors: [], bots: [] }
    menu.open(bot, [])
    click('Connectors')
    await flush()
    assert.ok(root.children.some((c) => c.textContent === 'No connectors are turned on yet.'))
    click('Manage connectors')
    assert.deepEqual(managed.at(-1), ['work', false])
    pending = Promise.reject(new Error('Server offline'))
    menu.open(bot, [])
    click('Connectors')
    await flush()
    assert.ok(root.children.some((c) => c.textContent === 'Server offline'))
    assert.ok(root.children.some((c) => c.textContent === 'Manage connectors'))
    doc.emit('keydown', { key: 'Escape', preventDefault() {} })
    assert.equal(root.hidden, true)
  } finally {
    for (const [i, key] of ['document', 'window'].entries()) {
      if (originals[i]) Object.defineProperty(globalThis, key, originals[i]!)
      else delete (globalThis as any)[key]
    }
  }
})

test('the bot menu opens a bot in the Dashboard only when the Dashboard is available', () => {
  const originals = ['document', 'window'].map((key) => Object.getOwnPropertyDescriptor(globalThis, key))
  const doc = Object.assign(new Element(), { createElement: () => new Element() })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new Element(), { innerWidth: 380, innerHeight: 600 }) })
  try {
    const root = new Element()
    const opened: string[] = []
    let available = true
    const menu = createBotMenu(root as any, async () => {}, async () => undefined, undefined, undefined, undefined, {
      open: (id) => opened.push(id),
      available: () => available
    })
    const bot = { id: 'work', name: 'Work' } as any
    menu.open(bot, [])
    assert.deepEqual(root.children.map((c) => c.textContent), ['Open native OpenMausBot', 'Pin', 'Rename', 'Group', '', 'Delete'])
    assert.equal((document as any).activeElement, root.children[0])
    root.children[0].emit()
    assert.deepEqual(opened, ['work'])
    assert.equal(root.hidden, true)
    available = false
    menu.open(bot, [])
    assert.equal(root.children[0].textContent, 'Pin')
  } finally {
    for (const [i, key] of ['document', 'window'].entries()) {
      if (originals[i]) Object.defineProperty(globalThis, key, originals[i]!)
      else delete (globalThis as any)[key]
    }
  }
})
