import { test, assert } from 'orca/testing'
import { INSTALL_NOTICE } from '../shared/omb-version.ts'

class Element {
  children: Element[] = []
  events = new Map<string, ((event?: any) => void)[]>()
  attributes = new Map<string, string>()
  style: Record<string, string> = {}
  set innerHTML(value: string) { this.children = value ? [new Element()] : [] }
  textContent = ''
  hidden = false
  disabled = false
  checked = true
  className = ''
  value = ''
  selected = false
  select() { this.selected = true }
  dataset: Record<string, string> = {}
  append(...children: Element[]) {
    this.children.push(...children)
  }
  replaceChildren(...children: Element[]) {
    this.children = children
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value)
  }
  contains(node: Element): boolean {
    return this === node || this.children.some((child) => child.contains(node))
  }
  getBoundingClientRect() {
    return { left: 20, bottom: 100, width: 196, height: 180 }
  }
  querySelectorAll(): Element[] {
    return this.children
      .flatMap((child) => [child, ...child.querySelectorAll()])
      .filter((child) => child.dataset.focus)
  }
  get firstElementChild() {
    return this.children[0]
  }
  addEventListener(name: string, fn: (event?: any) => void) {
    this.events.set(name, [...(this.events.get(name) ?? []), fn])
  }
  emit(name: string, event?: any) {
    for (const fn of this.events.get(name) ?? []) fn({ stopPropagation() {}, ...event })
  }
  focusCalls = 0
  focus() {
    this.focusCalls++
    ;(document as any).activeElement = this
  }
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
  let needsInstall = false
  let grouped = false
  let pinned = true
  let defaultBot = false
  let failRename: string | undefined
  let failList = false
  let failAct = false
  let section = 'Research'
  let holdAct = false
  let finishAct: (() => void) | undefined
  let holdOpen = false
  let finishOpen: (() => void) | undefined
  let answered = false
  let reject!: (error: Error) => void
  let resolve!: () => void
  let host = 'local'
  const prefs = { shareTools: true, linkAgents: false }
  let hostsBroken = false
  let selectionFails = false
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
          if (selectionFails) throw new Error('Pairing unavailable.')
          host = (input as { id: string }).id
          return { selected: host, hosts: [{ id: 'mini-1', name: 'Mac Mini' }], message: '' }
        }
        if (name === 'status' && hostsBroken)
          return { state: 'start_failed', message: 'Could not read Orca’s paired servers.' }
        if (name === 'bots.list' && failList) throw new Error('Offline')
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
              defaultBot,
              ...(grouped ? { pinned, section, knownSections: [section] } : {}),
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
        if (name === 'setup.get') return { answered, agents: { claude: true, codex: false } }
        if (name === 'server.install') {
          installed = true
          return { accepted: true }
        }
        if (name === 'status' && !installed)
          return { state: 'needs_install', message: 'Install OpenMausBot with approval.' }
        if (name === 'status')
          return { state: 'running', needsInstall, message: needsInstall ? INSTALL_NOTICE : '' }
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
        if (name === 'chat.open' && holdOpen)
          return new Promise((resolve) => {
            finishOpen = () => resolve({ message: '' })
          })
        if (name === 'chat.open') return { message: host === 'local' ? 'Opened.' : '' }
        if (name === 'groups.rename') {
          if (failRename) throw new Error(failRename)
          section = (input as any).name
          if (holdAct) await new Promise<void>((resolve) => { finishAct = resolve })
          return { ok: true }
        }
        if (name === 'bots.act' && failAct) throw new Error('Delete failed')
        if (name === 'bots.act' && holdAct)
          return new Promise((resolve) => {
            finishAct = () => resolve({ ok: true })
          })
        if (name === 'bots.act') return { ok: true }
        if (name === 'mcp.list') return { connectors: [], bots: [] }
        if (name === 'server.stop') return { stopped: true, message: 'Stopped.' }
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
    assert.equal(get('message').textContent, '')
    assert.equal(get('message').hidden, true)
    assert.equal(get('settings-install-card').hidden, false)
    assert.match(
      get('install-card-notice').textContent,
      /openmausbot@0.1.169.*npm.*75 MB.*~\/.orca-bot/
    )
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
    assert.equal(calls.some(call => call.name === 'tools.import'), false)
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
    assert.deepEqual(
      [get('pref-share-tools').checked, get('pref-link-agents').checked],
      [true, false]
    )
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
    assert.equal(get('update-banner').hidden, false)
    assert.match(get('update-banner-text').textContent, /^Updated/)
    assert.equal(get('update-banner-install').hidden, true)
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
    assert.equal(get('pref-share-tools').disabled, false)

    assert.equal(get('permissions-note').textContent, '')
    assert.equal(get('stop-server').hidden, false)

    assert.match(
      get('pref-share-tools-copy').textContent,
      /Claude.*on Mac Mini.*Codex.*on Mac Mini/
    )
    assert.equal(get('pref-agent-host').textContent, ' on Mac Mini')
    assert.match(get('share-tools-copy').textContent, /Claude.*on Mac Mini.*Codex.*on Mac Mini/)
    assert.equal(get('agent-host').textContent, ' on Mac Mini')
    get('pref-share-tools').checked = false
    get('pref-share-tools').emit('change')
    await flush()
    assert.deepEqual(calls.filter((call) => call.name === 'prefs.set').at(-1)?.input, {
      shareTools: false
    })

    assert.equal(calls.some((call) => call.name === 'tools.import'), false)
    get('open-page').emit('click')
    await flush()
    assert.equal(get('result').textContent, '')
    // The same single install card handles an existing server that needs an update.
    for (const target of ['local', 'mini-1']) {
      host = target
      needsInstall = true
      win.emit('pageshow')
      await flush()
      assert.equal(get('install-card').hidden, false)
      assert.equal(get('message').textContent, '')
      assert.equal(get('message').hidden, true)
    }
    needsInstall = false
    grouped = true
    win.emit('pageshow')
    await flush()
    assert.equal(get('roster').children[0].textContent, 'Pinned')
    const menu = get('bot-menu')
    holdOpen = true
    get('open-page').emit('click')
    await flush()
    let row = get('roster').children.find((child) => child.className.startsWith('bot-row'))!
    const trigger = row.children[0]
    assert.equal(trigger.disabled, false)
    assert.equal(trigger.attributes.get('aria-disabled'), 'true')
    row.emit('keydown', { key: 'ContextMenu', preventDefault() {}, stopPropagation() {} })
    assert.equal(menu.hidden, false)
    assert.equal((doc as any).activeElement, menu.children[0])
    assert.equal(menu.style.left, '20px')
    assert.equal(menu.style.top, '100px')
    doc.emit('keydown', { key: 'ArrowDown', preventDefault() {} })
    assert.equal((doc as any).activeElement, menu.children[1])
    doc.emit('keydown', { key: 'ArrowUp', preventDefault() {} })
    assert.equal((doc as any).activeElement, menu.children[0])
    doc.emit('keydown', { key: 'ArrowUp', preventDefault() {} })
    assert.equal((doc as any).activeElement, menu.children.at(-1))
    doc.emit('keydown', { key: 'Escape', preventDefault() {} })
    assert.equal(menu.hidden, true)
    assert.equal((doc as any).activeElement, trigger)
    row.emit('keydown', { key: 'F10', shiftKey: true, preventDefault() {}, stopPropagation() {} })
    assert.equal(menu.hidden, false)
    doc.emit('keydown', { key: 'Escape', preventDefault() {} })
    finishOpen!()
    holdOpen = false
    await flush()
    const openMenu = () => {
      get('roster')
        .children.find((child) => child.className.startsWith('bot-row'))!
        .emit('contextmenu')
      assert.equal(menu.hidden, false)
    }
    const clickLabel = (root: Element, label: string) => {
      const find = (node: Element): Element | undefined =>
        node.textContent === label ? node : node.children.map(find).find(Boolean)
      const button = find(root)
      assert.ok(button)
      button!.emit('click')
    }
    const menuTrigger = get('roster').children.find((child) => child.className.startsWith('bot-row'))!.children[0]
    const outside = get('open-settings')
    for (const event of ['click', 'blur', 'resize']) {
      openMenu()
      outside.focus()
      const before = menuTrigger.focusCalls
      if (event === 'click') doc.emit(event, { target: outside })
      else win.emit(event)
      assert.equal(menu.hidden, true)
      assert.equal(menuTrigger.focusCalls, before)
      assert.equal((doc as any).activeElement, outside)
    }
    openMenu()
    const beforeEscape = menuTrigger.focusCalls
    doc.emit('keydown', { key: 'Escape', preventDefault() {} })
    assert.equal(menu.hidden, true)
    assert.equal(menuTrigger.focusCalls, beforeEscape + 1)
    assert.equal((doc as any).activeElement, menuTrigger)
    openMenu()
    clickLabel(menu, 'Connectors')
    await flush()
    assert.ok(menu.children.some(child => child.textContent === 'No MCP connectors are turned on yet.'))
    clickLabel(menu, 'Manage connectors')
    await flush()
    assert.equal(menu.hidden, true)
    assert.equal(get('main-view').hidden, true)
    assert.equal(get('mcp-view').hidden, false)
    assert.ok(get('mcp-groups').querySelectorAll().some(child => child.dataset.focus === 'tab-provider' && child.attributes.get('aria-selected') === 'true'))
    get('mcp-back').emit('click')
    get('settings-back').emit('click')
    assert.equal(get('main-view').hidden, false)
    openMenu()
    clickLabel(menu, 'Rename')
    const beforeCancel = menuTrigger.focusCalls
    clickLabel(menu, 'Cancel')
    assert.equal(menuTrigger.focusCalls, beforeCancel + 1)
    assert.equal((doc as any).activeElement, menuTrigger)
    assert.equal(menu.hidden, true)
    assert.equal((doc as any).activeElement?.className, 'bot-chat')
    holdAct = true
    openMenu()
    clickLabel(menu, 'Unpin')
    await flush()
    openMenu()
    assert.equal(menu.children[0].disabled, true)
    assert.equal(menu.children[1].disabled, true)
    const actionCount = calls.filter((call) => call.name === 'bots.act').length
    clickLabel(menu, 'Unpin')
    assert.equal(calls.filter((call) => call.name === 'bots.act').length, actionCount)
    doc.emit('keydown', { key: 'Escape', preventDefault() {} })
    finishAct!()
    holdAct = false
    await flush()
    assert.deepEqual(calls.filter((call) => call.name === 'bots.act').at(-1)?.input, {
      botId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      action: 'pin',
      pinned: false
    })
    openMenu()
    clickLabel(menu, 'Rename')
    menu.children[1].value = 'New name'
    clickLabel(menu, 'Save')
    await flush()
    assert.equal(
      (calls.filter((call) => call.name === 'bots.act').at(-1)?.input as any).name,
      'New name'
    )
    openMenu()
    clickLabel(menu, 'Group')
    clickLabel(menu, '✓ Research')
    await flush()
    assert.equal(
      (calls.filter((call) => call.name === 'bots.act').at(-1)?.input as any).section,
      'Research'
    )
    openMenu()
    clickLabel(menu, 'Group')
    menu.children.at(-1)!.children[0].value = 'New group'
    clickLabel(menu, 'Add')
    await flush()
    assert.equal(
      (calls.filter((call) => call.name === 'bots.act').at(-1)?.input as any).section,
      'New group'
    )
    openMenu()
    const beforeDelete = calls.filter((call) => call.name === 'bots.act').length
    clickLabel(menu, 'Delete')
    assert.equal(calls.filter((call) => call.name === 'bots.act').length, beforeDelete)
    holdAct = true
    clickLabel(menu, 'Delete')
    const deletingRow = () => get('roster').children.find((child) => child.className.startsWith('bot-row'))!
    const spinner = () => deletingRow().children.at(-1)!.children.find((child) => child.className === 'deleting-spinner')
    assert.equal(spinner()?.attributes.get('aria-hidden'), 'true')
    assert.match(get('result').textContent, /^Deleting .*…$/)
    assert.equal(deletingRow().children[0].attributes.get('aria-busy'), 'true')
    holdNextBots = true
    finishAct!()
    holdAct = false
    await flush()
    assert.equal(get('roster').children.some((child) => child.className.startsWith('bot-row')), false)
    holdBots!([{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Remote bot', state: 'idle', modelLabel: 'Codex', pinned: true, section: 'Research' }])
    await flush()
    assert.equal(spinner(), undefined)
    failAct = true
    openMenu()
    clickLabel(menu, 'Delete')
    clickLabel(menu, 'Delete')
    assert.ok(spinner())
    await flush()
    assert.equal(spinner(), undefined)
    assert.equal(get('result').textContent, 'Delete failed')
    failAct = false
    failList = true
    openMenu()
    clickLabel(menu, 'Delete')
    clickLabel(menu, 'Delete')
    await flush()
    assert.equal(get('roster').children.some((child) => child.className.startsWith('bot-row')), false)
    assert.match(get('refresh-note').textContent, /Could not refresh/)
    failList = false
    assert.equal(
      (calls.filter((call) => call.name === 'bots.act').at(-1)?.input as any).action,
      'delete'
    )
    pinned = false
    defaultBot = true
    win.emit('pageshow')
    await flush()
    assert.equal(get('roster').children[0].textContent, 'Research')
    const groupHeading = () => get('roster').children.find((child) => child.className === 'roster-group-title')!
    for (const event of ['contextmenu', 'ContextMenu', 'F10', 'Enter', ' ']) {
      const header = groupHeading()
      assert.ok(header.dataset.focus)
      assert.equal(header.attributes.get('role'), 'button')
      if (event === 'contextmenu') header.emit(event)
      else header.emit('keydown', { key: event, shiftKey: true })
      assert.deepEqual(menu.children.map((child) => child.textContent), ['Rename'])
      clickLabel(menu, 'Rename')
      assert.equal(menu.children[0].textContent, 'Rename group')
      assert.equal(menu.children[1].value, section)
      assert.equal(menu.children[1].selected, true)
      assert.equal(menu.children[1].attributes.get('maxlength'), '60')
      menu.children[1].emit('keydown', { key: 'Escape' })
      assert.equal(menu.hidden, true)
      assert.equal((doc as any).activeElement, header)
    }
    groupHeading().emit('contextmenu')
    clickLabel(menu, 'Rename')
    menu.children[1].value = 'bad\nname'
    clickLabel(menu, 'Save')
    assert.equal(menu.hidden, false)
    assert.match(menu.children[3].textContent, /control characters/)
    menu.children[1].value = 'Operations'
    for (const message of ['A group with that name already exists.', 'This group no longer exists.']) {
      failRename = message
      clickLabel(menu, 'Save')
      await flush()
      assert.equal(menu.hidden, false)
      assert.equal(menu.children[1].value, 'Operations')
      assert.equal(menu.children[1].disabled, false)
      assert.equal((doc as any).activeElement, menu.children[1])
      assert.equal(menu.children[3].textContent, message)
    }
    failRename = undefined
    menu.children[1].value = ' Operations '
    const save = menu.children[2].children[1]
    holdAct = true
    save.emit('click')
    save.emit('click')
    assert.equal(calls.filter((call) => call.name === 'groups.rename').length, 3)
    assert.equal(menu.hidden, false)
    assert.equal(menu.children[1].disabled, true)
    assert.equal(save.disabled, true)
    finishAct!()
    holdAct = false
    await flush()
    assert.equal(groupHeading().textContent, 'Operations')
    assert.equal((doc as any).activeElement, groupHeading())
    groupHeading().emit('contextmenu')
    clickLabel(menu, 'Rename')
    menu.children[1].value = 'Pinned'
    menu.children[1].emit('keydown', { key: 'Enter' })
    await flush()
    assert.equal(groupHeading().textContent, 'Pinned')
    assert.equal((doc as any).activeElement, groupHeading())
    groupHeading().emit('contextmenu')
    clickLabel(menu, 'Rename')
    menu.children[1].value = 'Research'
    clickLabel(menu, 'Save')
    await flush()
    assert.equal(groupHeading().textContent, 'Research')

    openMenu()
    clickLabel(menu, 'Group')
    clickLabel(menu, 'Remove from group')
    await flush()
    assert.equal(
      (calls.filter((call) => call.name === 'bots.act').at(-1)?.input as any).section,
      null
    )
    openMenu()
    failList = true
    clickLabel(menu, 'Hide from list')
    assert.ok(spinner())
    assert.match(get('result').textContent, /^Hiding .*…$/)
    await flush()
    assert.ok(get('roster').children.some((child) => child.className === 'add-mausbot'))
    assert.equal(get('roster').children.some((child) => child.className.startsWith('bot-row')), false)
    failList = false
    assert.equal(
      (calls.filter((call) => call.name === 'bots.act').at(-1)?.input as any).action,
      'delete'
    )
    grouped = false

    get('open-settings').emit('click')
    await flush()
    selectionFails = true
    get('host').value = 'local'
    get('host').emit('change')
    await flush()
    await flush()
    assert.match(get('settings-message').textContent, /Pairing unavailable/)
    selectionFails = false
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
    assert.equal(get('pref-share-tools').disabled, false)
    assert.equal(get('permissions-note').textContent, '')
    assert.equal(get('settings-message').textContent, '')
    // Chat capability management returns to the same conversation with Back.
    get('settings-back').emit('click')
    get('roster').children.find(c => c.className.startsWith('bot-row'))!.children[0].emit('click')
    await flush()
    const descendants = (node: Element): Element[] => [node, ...node.children.flatMap(descendants)]
    descendants(get('bot-view')).find(c => c.className === 'capability-pill' && c.textContent.startsWith('Connectors'))!.emit('click')
    await flush()
    descendants(get('bot-view')).find(c => c.textContent === 'Manage connectors…')!.emit('click')
    await flush()
    assert.equal(get('mcp-view').hidden, false)
    assert.equal(get('bot-view').hidden, true)
    get('mcp-back').emit('click')
    await flush()
    assert.equal(get('main-view').hidden, false)
    assert.equal(get('bot-view').hidden, false)
    assert.equal(get('settings-view').hidden, true)
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
    get('open-settings').emit('click')
    await flush()
    get('mcp-manage').emit('click')
    await flush()
    win.emit('pageshow')
    await flush()
    await flush()
    doc.emit('visibilitychange')
    await flush()
    await flush()
    assert.equal(get('mcp-view').hidden, false)
    assert.equal(get('settings-view').hidden, true)
    assert.equal(get('main-view').hidden, true)
    host = 'local'
    win.emit('pageshow')
    await flush()
    await flush()
    assert.equal(get('mcp-view').hidden, true)
    assert.equal(get('settings-view').hidden, false)
  } finally {
    win.emit('pagehide')
    keys.forEach((key, i) => {
      if (originals[i]) Object.defineProperty(globalThis, key, originals[i]!)
      else Reflect.deleteProperty(globalThis, key)
    })
  }
})
