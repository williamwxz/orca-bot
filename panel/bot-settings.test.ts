import { test, assert } from 'orca/testing'
import { createBotSettings } from './bot-settings.ts'

class Element {
  children: Element[] = []
  textContent = ''
  className = ''
  hidden = false
  disabled = false
  checked = false
  value = ''
  type = ''
  title = ''
  dataset: Record<string, string> = {}
  attrs = new Map<string, string>()
  events = new Map<string, ((e: any) => void)[]>()
  constructor(public tag = 'div') {}
  get tagName() {
    return this.tag.toUpperCase()
  }
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
  all(): Element[] {
    return [this, ...this.children.flatMap((c) => c.all())]
  }
  text(): string {
    return [this.textContent, ...this.children.map((c) => c.text())].filter(Boolean).join(' ')
  }
}
const flush = () => new Promise<void>((r) => setImmediate(r))
const hash = 'ab'.repeat(32)
const learning = {
  skills: [
    { name: 'weekly-sales-report', description: 'Builds the weekly report.', enabled: true, from: 'learned', switchable: true },
    { name: 'release-notes', description: 'Write release notes.', enabled: false, from: 'claude', switchable: true },
    { name: 'house-style', description: 'Repo style.', enabled: true, from: 'project', switchable: false }
  ],
  waiting: 1,
  memory: { text: '- likes short replies', lines: 47, maxLines: 200, overflow: false, topics: 2, upkeep: false, hash }
}
const digest = { id: 'r1', name: 'Morning digest', prompt: 'Collect news.', enabled: true, when: { kind: 'daily', time: '07:30', weekdays: [1, 2, 3, 4, 5] }, nextRunAt: Date.UTC(2026, 10, 20, 15, 30) }

function setup() {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const doc = Object.assign(new Element(), { createElement: (tag: string) => new Element(tag) })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc })
  const calls: [string, any][] = []
  const replies: Record<string, any> = { 'learning.read': learning, 'schedules.list': [digest] }
  const pending: Record<string, (v: any) => void> = {}
  let hold = false
  let failNext: string | undefined
  const frame = {
    plugin: {
      request: (name: string, input: any) => {
        calls.push([name, input])
        if (failNext) {
          const message = failNext
          failNext = undefined
          return Promise.reject(new Error(message))
        }
        if (hold) return new Promise((resolve) => (pending[name] = resolve))
        return Promise.resolve(structuredClone(replies[name]))
      }
    }
  } as any
  const notes: string[] = []
  const opened: string[] = []
  let host = 0
  const root = new Element()
  const sheet = createBotSettings(root as any, frame, {
    notify: (m) => notes.push(m),
    hostGeneration: () => host,
    openModel: (b) => opened.push(`model:${b.id}`),
    openConnectors: (b) => opened.push(`connectors:${b.id}`),
    openBackend: (b) => opened.push(`backend:${b.id}`)
  })
  const key = (k: string) => root.all().find((e) => e.dataset.key === k)!
  return {
    doc, root, sheet, calls, replies, pending, notes, opened, key,
    hold: (on: boolean) => (hold = on),
    fail: (m: string) => (failNext = m),
    setHost: (h: number) => (host = h),
    restore: () => (saved ? Object.defineProperty(globalThis, 'document', saved) : delete (globalThis as any).document)
  }
}
const bot = { id: 'a', name: 'Work', state: 'idle', model: 'claude/sonnet', modelLabel: 'Sonnet', connectorCount: 2 } as any

test('bot settings shows model, connectors, computer, skills, memory and schedules; rows hand off to the pickers', async () => {
  const t = setup()
  try {
    await t.sheet.open(bot, new Element() as any)
    const text = t.root.text()
    assert.match(text, /Work settings/)
    assert.match(text, /Model Sonnet Change/)
    assert.match(text, /Connectors 2 allowed Choose/)
    assert.match(text, /weekly-sales-report Learned Builds the weekly report\./)
    assert.match(text, /release-notes Claude Code Write release notes\./)
    assert.match(text, /1 skill change is waiting/)
    assert.match(text, /47 of 200 lines load each turn\. 2 topic notes read when needed\./)
    assert.match(text, /Nightly memory tidy-up is off/)
    assert.match(text, /Morning digest Weekdays at 07:30 · next/)
    assert.match(text, /Collect news\./)
    assert.deepEqual(t.calls.map(([n]) => n), ['learning.read', 'schedules.list'])
    assert.equal(t.key('skill:house-style').disabled, true)
    // A working bot keeps its model until the reply ends; a roster refresh redraws only on change.
    t.sheet.update({ ...bot, state: 'working' })
    assert.equal(t.key('open:model').disabled, true)
    t.sheet.update({ ...bot })
    assert.equal(t.key('open:model').disabled, false)
    t.key('open:connectors').emit('click')
    assert.deepEqual(t.opened, ['connectors:a'])
    assert.equal(t.root.hidden, true)
  } finally {
    t.restore()
  }
})

test('skills switch and memory saves with its version; a refused save keeps the draft', async () => {
  const t = setup()
  try {
    await t.sheet.open(bot, new Element() as any)
    t.replies['learning.skill'] = learning
    const toggle = t.key('skill:release-notes')
    toggle.checked = true
    toggle.emit('change')
    await flush()
    assert.deepEqual(t.calls.at(-1), ['learning.skill', { botId: 'a', name: 'release-notes', enabled: true }])
    assert.equal(t.notes.at(-1), 'release-notes is on.')

    // The edit keeps the version it started from even when a skill switch refreshes memory meanwhile.
    t.replies['learning.skill'] = { ...learning, memory: { ...learning.memory, hash: 'ee'.repeat(32) } }
    t.key('memory:edit').emit('click')
    t.key('skill:release-notes').emit('change')
    await flush()
    const area = t.key('memory:text')
    assert.equal(area.value, '- likes short replies')
    area.value = '- likes short replies\n- prefers tables'
    area.emit('input')
    // A refresh mid-edit keeps the draft.
    t.sheet.update({ ...bot, connectorCount: 3 })
    assert.equal(t.key('memory:text').value, '- likes short replies\n- prefers tables')
    t.fail('The bot changed its memory while you were editing. Copy your text, reopen memory and edit again.')
    t.key('memory:save').emit('click')
    await flush()
    assert.match(t.notes.at(-1)!, /The bot changed its memory/)
    assert.equal(t.key('memory:text').value, '- likes short replies\n- prefers tables')
    t.replies['memory.save'] = { ...learning, memory: { ...learning.memory, text: '- likes short replies\n- prefers tables' } }
    t.key('memory:save').emit('click')
    await flush()
    assert.deepEqual(t.calls.at(-1), ['memory.save', { botId: 'a', text: '- likes short replies\n- prefers tables', hash }])
    assert.equal(t.notes.at(-1), 'Memory saved.')
    assert.equal(t.key('memory:text'), undefined)
    assert.match(t.root.text(), /- prefers tables/)
  } finally {
    t.restore()
  }
})

test('schedules pause, run, delete after asking, and are created from the form', async () => {
  const t = setup()
  try {
    await t.sheet.open(bot, new Element() as any)
    t.replies['schedules.act'] = { schedules: [{ ...digest, enabled: false, nextRunAt: undefined }] }
    const toggle = t.key('schedule:r1:toggle')
    toggle.checked = false
    toggle.emit('change')
    await flush()
    assert.deepEqual(t.calls.at(-1), ['schedules.act', { botId: 'a', action: 'toggle', id: 'r1', enabled: false }])
    assert.match(t.root.text(), /Weekdays at 07:30 · paused/)
    t.key('schedule:r1:run').emit('click')
    await flush()
    assert.deepEqual(t.calls.at(-1), ['schedules.act', { botId: 'a', action: 'run', id: 'r1' }])
    assert.equal(t.notes.at(-1), 'Morning digest started.')
    const before = t.calls.length
    t.key('schedule:r1:ask').emit('click')
    assert.equal(t.calls.length, before)
    assert.match(t.root.text(), /Delete this schedule\?/)
    t.key('schedule:r1:keep').emit('click')
    assert.equal(t.key('schedule:r1:delete'), undefined)
    t.key('schedule:r1:ask').emit('click')
    t.replies['schedules.act'] = { schedules: [] }
    t.key('schedule:r1:delete').emit('click')
    await flush()
    assert.deepEqual(t.calls.at(-1), ['schedules.act', { botId: 'a', action: 'delete', id: 'r1' }])
    assert.match(t.root.text(), /No schedules\./)

    // New schedule: weekdays at a time, every N minutes, and once (which needs a date).
    t.key('schedule:new').emit('click')
    const fill = (k: string, v: string) => {
      const el = t.key(k)
      el.value = v
      el.emit(el.tag === 'select' ? 'change' : 'input')
    }
    fill('form:name', 'Standup notes')
    fill('form:prompt', 'Summarize yesterday.')
    fill('form:kind', 'weekdays')
    fill('form:time', '08:45')
    t.replies['schedules.act'] = { schedules: [{ ...digest, id: 'r9', name: 'Standup notes' }] }
    t.key('form:save').emit('click')
    await flush()
    assert.deepEqual(t.calls.at(-1), ['schedules.act', { botId: 'a', action: 'create', name: 'Standup notes', prompt: 'Summarize yesterday.', when: { kind: 'daily', time: '08:45', weekdays: [1, 2, 3, 4, 5] } }])
    assert.equal(t.notes.at(-1), 'Standup notes is scheduled.')
    assert.equal(t.key('form:name'), undefined)
    t.key('schedule:new').emit('click')
    fill('form:name', 'Inbox sweep')
    fill('form:prompt', 'Check mail.')
    fill('form:kind', 'interval')
    fill('form:minutes', '30')
    t.key('form:save').emit('click')
    await flush()
    assert.deepEqual(t.calls.at(-1)![1].when, { kind: 'interval', everyMinutes: 30 })
    t.key('schedule:new').emit('click')
    fill('form:kind', 'once')
    const sent = t.calls.length
    t.key('form:save').emit('click')
    assert.equal(t.calls.length, sent)
    assert.equal(t.notes.at(-1), 'Choose a date and time.')
    fill('form:at', '2027-01-05T09:30')
    t.key('form:save').emit('click')
    await flush()
    assert.deepEqual(t.calls.at(-1)![1].when, { kind: 'once', at: new Date('2027-01-05T09:30').getTime() })
    // A change that was made but whose list could not be reread offers nothing to repeat.
    t.replies['schedules.act'] = {}
    t.key('schedule:new').emit('click')
    fill('form:name', 'Again')
    fill('form:prompt', 'x')
    t.key('form:save').emit('click')
    await flush()
    assert.match(t.root.text(), /Done\. The list could not be refreshed/)
    assert.equal(t.key('schedule:new'), undefined)
    assert.equal(t.key('form:save'), undefined)
  } finally {
    t.restore()
  }
})

test('replies after the panel closed or the host changed are dropped; Escape and clicks outside close it', async () => {
  const t = setup()
  try {
    t.hold(true)
    void t.sheet.open(bot, new Element() as any)
    assert.match(t.root.text(), /Loading/)
    t.setHost(1)
    t.pending['learning.read'](learning)
    t.pending['schedules.list']([digest])
    await flush()
    assert.doesNotMatch(t.root.text(), /Morning digest/)
    t.hold(false)
    await t.sheet.open(bot, new Element() as any)
    assert.match(t.root.text(), /Morning digest/)
    t.doc.emit('keydown', { key: 'Escape' })
    assert.equal(t.root.hidden, true)
    await t.sheet.open(bot, new Element() as any)
    t.doc.emit('click', { target: new Element() })
    assert.equal(t.sheet.isOpen(), false)
    // A failed load says so instead of loading forever.
    t.fail('Could not read this bot’s skills. Try again.')
    await t.sheet.open(bot, new Element() as any)
    assert.match(t.root.text(), /Could not read this bot’s skills/)
  } finally {
    t.restore()
  }
})
