import { test, assert } from 'orca/testing'
import { readFileSync } from 'node:fs'
import { createMcpView } from './mcp-view.ts'
import type { Connectors, ConnectorAction } from '../worker/mcp-connectors.ts'

class Element {
  children: Element[] = []
  textContent = ''
  hidden = false
  disabled = false
  checked = false
  type = ''
  dataset: Record<string, string> = {}
  contains(node: Element): boolean {
    return this === node || this.children.some((child) => child.contains(node))
  }
  querySelectorAll() {
    return this.children.flatMap(all).filter((el) => el.dataset.focus)
  }
  attrs = new Map<string, string>()
  events = new Map<string, () => void>()
  append(...children: Element[]) {
    this.children.push(...children)
  }
  prepend(child: Element) {
    this.children.unshift(child)
  }
  replaceChildren(...children: Element[]) {
    this.children = children
  }
  setAttribute(key: string, value: string) {
    this.attrs.set(key, value)
  }
  addEventListener(name: string, action: () => void) {
    this.events.set(name, action)
  }
  focus() {
    ;(document as any).activeElement = this
  }
  emit(name = 'click') {
    this.events.get(name)?.()
  }
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
function all(el: Element): Element[] {
  return [el, ...el.children.flatMap(all)]
}

test('MCP menu provides host-aware groups, zero-bot prompt, assignments, loading, remove and back focus', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const elements = new Map<string, Element>()
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element())
    return elements.get(id)!
  }
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => new Element() }
  })
  let data: Connectors = {
    connectors: [
      {
        name: 'mail',
        fingerprint: 'f'.repeat(64),
        rawName: 'Work mail',
        provider: 'Codex',
        enabled: false,
        present: false,
        bots: []
      }
    ],
    bots: [
      { id: 'a', name: 'Chief of Staff' },
      { id: 'b', name: 'Personal' }
    ]
  }
  const actions: ConnectorAction[] = []
  let complete: (() => void) | undefined
  let delayed: Promise<Connectors> | undefined
  const view = createMcpView(
    {
      plugin: {
        request: async (name: string, input: ConnectorAction) => {
          if (name === 'mcp.list') return delayed ?? structuredClone(data)
          actions.push(input)
          await new Promise<void>((resolve) => {
            complete = resolve
          })
          const row = data.connectors[0]
          if (input.action === 'group' || input.action === 'toggle') {
            row.enabled = input.enabled
            row.present = true
          } else if (input.action === 'assign') row.bots = input.bots
          else {
            row.enabled = false
            row.present = false
            row.bots = []
          }
          return structuredClone(data)
        }
      }
    } as any,
    get as any
  )
  try {
    view.hostChanged('remote', 'Remote workstation')
    get('mcp-manage').emit()
    await flush()
    assert.equal(get('settings-view').hidden, true)
    assert.equal(get('mcp-view').hidden, false)
    assert.match(get('mcp-security').textContent, /on Remote workstation/)
    assert.match(get('mcp-summary').textContent, /0 enabled · 1 available/)
    let nodes = all(get('mcp-groups'))
    assert.ok(nodes.some((n) => n.textContent.includes('Codex setup on Remote workstation')))
    nodes.find((n) => n.textContent === 'All on')!.emit()
    assert.equal(get('mcp-refresh').disabled, true)
    assert.ok(
      all(get('mcp-groups'))
        .filter((n) => n.type === 'checkbox')
        .every((n) => n.disabled)
    )
    complete!()
    await flush()
    nodes = all(get('mcp-groups'))
    assert.ok(nodes.some((n) => n.textContent === 'No bots assigned'))
    nodes.find((n) => n.dataset.focus === 'mail-access')!.emit()
    nodes = all(get('mcp-groups'))
    assert.equal(
      nodes.find((n) => n.dataset.focus === 'tab-bot')!.attrs.get('aria-selected'),
      'true'
    )
    const select = nodes.find((n) => n.dataset.focus === 'mail-allow-a')!
    select.focus()
    select.checked = true
    select.emit('change')
    complete!()
    await flush()
    assert.equal((document as any).activeElement.dataset.focus, 'mail-allow-a')
    assert.deepEqual(actions.at(-1), {
      action: 'assign',
      name: 'mail',
      fingerprint: 'f'.repeat(64),
      bots: ['a']
    })
    assert.equal(
      all(get('mcp-groups')).find((n) => n.dataset.focus === 'mail-allow-a')!.checked,
      true
    )
    get('mcp-refresh').focus()
    get('mcp-refresh').emit()
    await flush()
    assert.equal((document as any).activeElement, get('mcp-refresh'))
    get('mcp-back').focus()
    await view.refresh()
    assert.equal((document as any).activeElement, get('mcp-back'))
    all(get('mcp-groups'))
      .find((n) => n.dataset.focus === 'tab-provider')!
      .emit()
    all(get('mcp-groups'))
      .find((n) => n.textContent === 'Remove')!
      .emit()
    assert.ok(all(get('mcp-groups')).some((n) => n.textContent === 'Remove mail?'))
    all(get('mcp-groups'))
      .find((n) => n.dataset.focus === 'mail-confirm')!
      .emit()
    complete!()
    await flush()
    assert.deepEqual(actions.at(-1), {
      action: 'remove',
      name: 'mail',
      fingerprint: 'f'.repeat(64)
    })
    get('mcp-back').emit()
    assert.equal(get('mcp-view').hidden, true)
    assert.equal((document as any).activeElement, get('mcp-manage'))
    // Ignore a response from the old host after selecting another host.
    let finish!: (value: Connectors) => void
    delayed = new Promise((resolve) => {
      finish = resolve
    })
    const pending = view.refresh()
    view.hostChanged('other', 'Other host')
    finish(data)
    await pending
    assert.match(get('mcp-summary').textContent, /unavailable on Other host/)
    assert.equal(get('mcp-groups').children.length, 0)
  } finally {
    if (original) Object.defineProperty(globalThis, 'document', original)
    else delete (globalThis as any).document
  }
})

test('setup and settings markup contain no blind import controls', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
  for (const id of ['import-tools-label', 'import-tools', 'pref-import'])
    assert.equal(html.includes(`id="${id}"`), false)
  for (const id of ['mcp-view', 'mcp-manage', 'mcp-back', 'mcp-refresh'])
    assert.ok(html.includes(`id="${id}"`))
})

test('same-host resumes retain menu and in-flight state, true host changes restore Settings, empty and pinned rows are clear', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const elements = new Map<string, Element>()
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element())
    return elements.get(id)!
  }
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => new Element() }
  })
  let data: Connectors = {
    connectors: [
      {
        name: 'native',
        fingerprint: 'a'.repeat(64),
        rawName: 'native',
        provider: 'OpenMausBot',
        present: true,
        enabled: false,
        bots: [],
        bot: 'owner'
      }
    ],
    bots: []
  }
  let finish!: (data: Connectors) => void
  let delayed: Promise<Connectors> | undefined
  const actions: unknown[] = []
  const view = createMcpView(
    {
      plugin: {
        request: async (name: string, input: unknown) => {
          if (name === 'mcp.act') actions.push(input)
          return delayed ?? data
        }
      }
    } as any,
    get as any
  )
  try {
    view.hostChanged('local')
    get('mcp-manage').emit()
    await flush()
    let nodes = all(get('mcp-groups'))
    assert.equal(
      nodes.some((n) => n.dataset.focus === 'native-access'),
      false
    )
    assert.equal(nodes.find((n) => n.textContent === 'All on')!.disabled, true)
    nodes.find((n) => n.dataset.focus === 'native-remove')!.focus()
    nodes.find((n) => n.dataset.focus === 'native-remove')!.emit()
    assert.equal(actions.length, 0)
    nodes = all(get('mcp-groups'))
    assert.ok(nodes.some((n) => n.textContent.includes('permanently deleted. No local source')))
    assert.equal((document as any).activeElement.dataset.focus, 'native-cancel')
    nodes.find((n) => n.dataset.focus === 'native-cancel')!.emit()
    assert.equal((document as any).activeElement.dataset.focus, 'native-remove')
    assert.equal(actions.length, 0)
    delayed = new Promise((resolve) => {
      finish = resolve
    })
    const pending = view.refresh()
    view.hostChanged('local')
    assert.equal(get('mcp-view').hidden, false)
    assert.equal(get('mcp-refresh').disabled, true)
    view.hostChanged('remote', 'Remote host')
    assert.equal(get('mcp-view').hidden, true)
    assert.equal(get('settings-view').hidden, false)
    finish(data)
    await pending
    assert.equal(get('mcp-groups').children.length, 0)
    delayed = undefined
    data = { connectors: [], bots: [] }
    get('mcp-manage').emit()
    await flush()
    assert.ok(
      all(get('mcp-groups')).some(
        (n) => n.textContent === 'No MCP connectors found on Remote host.'
      )
    )
    view.hostChanged('local')
    await view.refresh()
    assert.ok(
      all(get('mcp-groups')).some(
        (n) => n.textContent === 'No MCP connectors found on this computer.'
      )
    )
  } finally {
    if (original) Object.defineProperty(globalThis, 'document', original)
    else delete (globalThis as any).document
  }
})

test('removed bulk-import APIs are absent from production protocol, setup and command manifest', () => {
  for (const file of [
    '../worker/worker.ts',
    '../worker/protocol.ts',
    '../worker/relay-frames.ts',
    './setup.ts',
    '../orca-plugin.json'
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8')
    for (const retired of [
      'tools.import',
      'tools.find',
      'importTools',
      'importMessage',
      'bringTools',
      'toolsLoaded',
      'loadTools'
    ])
      assert.equal(source.includes(retired), false, `${file} still contains ${retired}`)
  }
})

test('two-way access preserves other bots, clean catalog jumps to auditing without assignment popovers', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const elements = new Map<string, Element>()
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element())
    return elements.get(id)!
  }
  const events = new Map<string, (event: any) => void>()
  const doc = {
    createElement: () => new Element(),
    addEventListener: (name: string, action: (event: any) => void) => events.set(name, action),
    activeElement: undefined as Element | undefined
  }
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc })
  const data: Connectors = {
    connectors: [
      {
        name: 'gmail-cursor',
        rawName: 'gmail',
        provider: 'Cursor',
        fingerprint: 'work',
        present: true,
        enabled: true,
        bots: ['work']
      },
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
        name: 'off',
        rawName: 'off',
        provider: 'Codex',
        fingerprint: 'off',
        present: true,
        enabled: false,
        bots: []
      },
      {
        name: 'pinned',
        rawName: 'pinned',
        provider: 'OpenMausBot',
        fingerprint: 'pinned',
        present: true,
        enabled: true,
        bots: ['personal'],
        bot: 'personal'
      }
    ],
    bots: [
      { id: 'work', name: 'Work Assistant' },
      { id: 'personal', name: 'Personal Assistant' }
    ]
  }
  const actions: ConnectorAction[] = []
  const view = createMcpView(
    {
      plugin: {
        request: async (method: string, input: ConnectorAction) => {
          if (method === 'mcp.act') {
            actions.push(input)
            if (input.action === 'assign')
              data.connectors.find((c) => c.name === input.name)!.bots = input.bots
          }
          return structuredClone(data)
        }
      }
    } as any,
    get as any
  )
  const find = (key: string) => all(get('mcp-groups')).find((n) => n.dataset.focus === key)!
  try {
    view.open({ tab: 'bot', botId: 'work' })
    await flush()
    assert.equal(find('tab-bot').attrs.get('aria-selected'), 'true')
    assert.equal(find('gmail-cursor-allow-work').checked, true)
    assert.equal(find('gmail-allow-work').checked, false)
    assert.equal(find('pinned-allow-work'), undefined)
    assert.equal(find('off-allow-work'), undefined)
    find('select-personal').emit()
    assert.ok(all(get('mcp-groups')).some((n) => n.textContent === 'Pinned to this bot'))
    assert.equal(find('pinned-allow-personal'), undefined)
    find('select-work').emit()
    find('gmail-allow-work').emit('change')
    await flush()
    assert.deepEqual(actions.at(-1), {
      action: 'assign',
      name: 'gmail',
      fingerprint: 'personal',
      bots: ['personal', 'work']
    })
    find('more-connectors').emit()
    assert.equal(find('tab-provider').attrs.get('aria-selected'), 'true')
    assert.equal(find('off-access'), undefined)
    find('gmail-access').emit()
    assert.equal(find('tab-bot').attrs.get('aria-selected'), 'true')
    find('select-work').emit()
    find('gmail-allow-work').emit('change')
    await flush()
    assert.deepEqual(actions.at(-1), {
      action: 'assign',
      name: 'gmail',
      fingerprint: 'personal',
      bots: ['personal']
    })
    find('tab-provider').emit()
    assert.equal(find('gmail-access').textContent, '1 bot')
    assert.equal(
      all(get('mcp-groups')).some((n) => n.dataset.focus?.includes('-unassign-')),
      false
    )
    data.connectors.forEach((c) => {
      c.enabled = false
    })
    await view.refresh()
    find('tab-bot').emit()
    assert.ok(
      all(get('mcp-groups')).some((n) => n.textContent === 'No MCP connectors are enabled yet.')
    )
    find('more-connectors').emit()
    assert.equal(find('tab-provider').attrs.get('aria-selected'), 'true')
  } finally {
    if (original) Object.defineProperty(globalThis, 'document', original)
    else delete (globalThis as any).document
  }
})
