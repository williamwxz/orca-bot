import { assert, test } from 'orca/testing'
import { createSettings } from './settings.ts'
import type { FrameApi } from './chat-view.ts'
import type { Updates } from '../worker/updates.ts'

class Element {
  hidden = false
  disabled = false
  checked = false
  textContent = ''
  events = new Map<string, () => Promise<void> | void>()
  addEventListener(name: string, action: () => Promise<void> | void) {
    this.events.set(name, action)
  }
  async click() {
    this.events.get('click')?.()
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

function fake() {
  const elements = new Map<string, Element>()
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element())
    return elements.get(id)!
  }
  const available: Updates = {
    version: '0.1.3',
    latest: '0.1.4',
    state: 'available',
    message: 'Version 0.1.4 is available.',
    autoUpdate: false
  }
  const requests: string[] = []
  const state = {
    updates: available,
    install: async (): Promise<Updates> => ({
      ...available,
      state: 'updated',
      message: 'Updated.'
    }),
    preferences: async () => ({ shareTools: false, linkAgents: false, agents: { claude: true } })
  }
  const frame = {
    plugin: {
      request: async (name: string) => {
        requests.push(name)
        if (name === 'updates.get') return state.updates
        if (name === 'updates.install') return state.install()
        if (name === 'prefs.get') return state.preferences()
        if (name === 'server.install') return { accepted: true }
        throw new Error('Unexpected request')
      }
    }
  } as FrameApi
  let changed = 0
  const settings = createSettings(frame, element as any, async () => {
    changed++
  })
  return { element, state, settings, requests, changed: () => changed }
}

test('main update banner keeps success and thrown error feedback visible', async () => {
  for (const fails of [false, true]) {
    const { settings, element, state } = fake()
    if (fails)
      state.install = async () => {
        throw new Error('Update connection failed.')
      }
    await settings.checkUpdates()
    await element('update-banner-install').click()
    assert.equal(element('update-banner').hidden, false)
    assert.match(element('update-banner-text').textContent, fails ? /connection failed/ : /Updated/)
    assert.equal(element('update-banner-install').hidden, !fails)
    await settings.checkUpdates()
    assert.match(element('update-banner-text').textContent, fails ? /connection failed/ : /Updated/)
  }
})

test('approval-required update hides both install buttons until Check now or a new release', async () => {
  for (const action of ['check', 'new-version']) {
    const { settings, element, state, requests } = fake()
    state.install = async () => ({
      ...state.updates,
      state: 'approval_required',
      message: 'Approve access in Orca Settings, then Plugins.'
    })
    await settings.checkUpdates()
    await element('update-banner-install').click()
    assert.equal(element('update-banner').hidden, false)
    assert.match(element('update-banner-text').textContent, /Approve access/)
    for (const id of ['update-banner-install', 'update-install']) {
      assert.equal(element(id).hidden, true)
      assert.equal(element(id).disabled, true)
      await element(id).click()
    }
    assert.equal(requests.filter((name) => name === 'updates.install').length, 1)
    if (action === 'check') await element('update-check').click()
    else {
      state.updates = { ...state.updates, latest: '0.1.5', message: 'Version 0.1.5 is available.' }
      await settings.checkUpdates()
    }
    assert.equal(element('update-banner-install').hidden, false)
    assert.equal(element('update-install').disabled, false)
    assert.match(element('update-banner-text').textContent, /available/)
  }
})

test('host changes reload permissions, clear stale errors and discard replies from the previous host', async () => {
  const { settings, element, state } = fake()
  state.preferences = async () => {
    throw new Error('Choose where your bots run.')
  }
  await settings.open()
  assert.equal(element('pref-share-tools').disabled, true)
  assert.match(element('permissions-note').textContent, /Choose where/)
  settings.beginHostChange()
  state.preferences = async () => ({
    shareTools: true,
    linkAgents: false,
    agents: { claude: true }
  })
  await settings.hostChanged()
  assert.equal(element('pref-share-tools').disabled, false)
  assert.equal(element('pref-share-tools').checked, true)
  assert.equal(element('permissions-note').textContent, '')
  let release!: (value: any) => void
  state.preferences = () =>
    new Promise((resolve) => {
      release = resolve
    })
  const stale = settings.hostChanged()
  settings.beginHostChange()
  state.preferences = async () => {
    throw new Error('Manage permissions on the paired server.')
  }
  await settings.hostChanged('Host selection failed.')
  release({ shareTools: true, linkAgents: true, agents: { claude: true } })
  await stale
  assert.equal(element('pref-share-tools').disabled, true)
  assert.equal(element('pref-link-agents').checked, false)
  assert.match(element('permissions-note').textContent, /paired server/)
  assert.equal(element('settings-message').textContent, 'Host selection failed.')
})

test('Settings offers explicit installation approval locally and on the remote host', async () => {
  const { settings, element, requests, changed } = fake()
  settings.setStatus(
    { state: 'needs_install', message: 'Install with approval.', testedVersion: '0.1.169' },
    undefined
  )
  assert.equal(element('settings-install-card').hidden, false)
  assert.match(element('omb-status').textContent, /approval/)
  assert.equal(requests.includes('server.install'), false)
  await element('settings-install-omb').click()
  assert.equal(requests.filter((name) => name === 'server.install').length, 1)
  assert.equal(changed(), 1)
  settings.setStatus(
    {
      state: 'needs_install',
      message: 'Install OpenMausBot in Orca on Server.',
      testedVersion: '0.1.169'
    },
    'Server'
  )
  assert.equal(element('settings-install-card').hidden, false)
  assert.match(element('omb-status').textContent, /Installation on Server needs your approval/)
  assert.match(element('settings-install-card-notice').textContent, /on Server/)
  await element('settings-install-omb').click()
  assert.equal(requests.filter((name) => name === 'server.install').length, 2)
})

test('switching hosts updates all permission copy immediately before any preferences reply', () => {
  const { settings, element } = fake()
  settings.setStatus(undefined, 'Old host')
  settings.beginHostChange('New host')
  assert.match(
    element('pref-import-copy').textContent,
    /apps such as Cursor and Claude Desktop on New host/
  )
  assert.match(element('pref-import-copy').textContent, /Tokens saved in those apps on New host/)
  assert.match(
    element('pref-share-tools-copy').textContent,
    /Claude.*on New host.*Codex.*on New host/
  )
  assert.equal(element('pref-agent-host').textContent, ' on New host')
  settings.beginHostChange()
  assert.match(element('pref-import-copy').textContent, /on this computer/)
  assert.equal(element('pref-agent-host').textContent, ' on this computer')
})
