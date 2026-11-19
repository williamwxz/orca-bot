import { test, assert } from 'orca/testing'
import { createLearningSheet } from './learning-sheet.ts'

class Element {
  children: Element[] = []
  textContent = ''
  className = ''
  hidden = false
  disabled = false
  checked = false
  type = ''
  tabIndex = -1
  dataset: Record<string, string> = {}
  attrs = new Map<string, string>()
  events = new Map<string, ((e: any) => void)[]>()
  constructor(public tag = 'div') {}
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

test('skills sheet lists skills and memory, switches a skill, and ignores replies after it closes or the host changes', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const doc = Object.assign(new Element(), { createElement: (tag: string) => new Element(tag) })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc })
  try {
    const learning = {
      skills: [
        { name: 'weekly-sales-report', description: 'Builds the weekly report.', enabled: true, learned: true },
        { name: 'release-notes', description: 'Write release notes.', enabled: false, learned: false }
      ],
      waiting: 1,
      memory: { text: '- likes short replies', lines: 47, maxLines: 200, overflow: false, topics: 2, upkeep: false }
    }
    const calls: [string, any][] = []
    let reply: (value: any) => void = () => {}
    let failNext = false
    const frame = {
      plugin: {
        request: (name: string, input: any) => {
          calls.push([name, input])
          if (failNext) {
            failNext = false
            return Promise.reject(new Error('This skill is gone. Reopen the list.'))
          }
          return new Promise((resolve) => (reply = resolve))
        }
      }
    } as any
    const notes: string[] = []
    const counts: [string, number][] = []
    let host = 0
    let dismissed = 0
    const root = new Element()
    const trigger = new Element()
    const sheet = createLearningSheet(
      root as any,
      frame,
      { notify: (m) => notes.push(m), counted: (id, n) => counts.push([id, n]), hostGeneration: () => host },
      () => dismissed++
    )
    const bot = { id: 'a', name: 'Work', state: 'idle' } as any

    void sheet.open(bot, trigger as any)
    assert.equal(root.hidden, false)
    assert.match(root.text(), /Loading/)
    reply(learning)
    await flush()
    const text = root.text()
    assert.match(text, /Skills and memory for Work/)
    assert.match(text, /weekly-sales-report Learned Builds the weekly report\./)
    assert.match(text, /1 skill change is waiting for your answer in the full chat\./)
    assert.match(text, /47 of 200 lines load each turn\. 2 topic notes read when needed\./)
    assert.match(text, /- likes short replies/)
    assert.match(text, /Nightly memory tidy-up is off/)
    assert.deepEqual(counts, [['a', 1]])

    // Switching one skill sends only that change and redraws from the fresh list.
    const toggle = root.all().find((e) => e.dataset.key === 'release-notes')!
    assert.equal(toggle.checked, false)
    toggle.checked = true
    toggle.emit('change')
    assert.deepEqual(calls.at(-1), ['learning.skill', { botId: 'a', name: 'release-notes', enabled: true }])
    assert.equal(root.all().every((e) => e.tag !== 'input' || e.disabled), true)
    reply({ ...learning, skills: learning.skills.map((s) => ({ ...s, enabled: true })) })
    await flush()
    assert.deepEqual(notes.at(-1), 'release-notes is on.')
    assert.deepEqual(counts.at(-1), ['a', 2])
    assert.equal(root.all().some((e) => e.tag === 'input' && e.disabled), false)

    // A refused change keeps the list and says why.
    failNext = true
    root.all().find((e) => e.dataset.key === 'release-notes')!.emit('change')
    await flush()
    assert.equal(notes.at(-1), 'This skill is gone. Reopen the list.')

    // Escape closes it; a late reply for a closed sheet is dropped.
    doc.emit('keydown', { key: 'Escape' })
    assert.equal(root.hidden, true)
    assert.equal(dismissed, 1)
    void sheet.open(bot, trigger as any)
    host = 1
    reply({ skills: [], waiting: 0 })
    await flush()
    assert.match(root.text(), /Loading/)
    sheet.close()

    // No skills and no memory yet.
    host = 2
    const fresh = createLearningSheet(new Element() as any, frame, { hostGeneration: () => host })
    const freshRoot = new Element()
    const other = createLearningSheet(freshRoot as any, frame, {})
    void other.open(bot, trigger as any)
    reply({ skills: [], waiting: 0 })
    await flush()
    assert.match(freshRoot.text(), /No skills yet\. Type \/learn/)
    assert.match(freshRoot.text(), /Nothing remembered yet\./)
    // A click outside closes it.
    doc.emit('click', { target: new Element() })
    assert.equal(freshRoot.hidden, true)
    assert.equal(fresh.isOpen(), false)
  } finally {
    if (saved) Object.defineProperty(globalThis, 'document', saved)
    else delete (globalThis as any).document
  }
})
