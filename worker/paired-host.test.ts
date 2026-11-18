import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { readHosts, registerPairedHost } from './paired-host.ts'
import { createRelay } from './relay-host.ts'
import { READY, RELAYED } from './relay-frames.ts'
import { register } from './worker.ts'
import { fileHostPrefs } from './host-prefs.ts'
import { TESTED_OPENMAUSBOT_VERSION } from '../shared/omb-version.ts'

const hosts = [{ id: 'mini-1', name: 'Mac Mini' }]
test('bots run here without paired servers, and nothing is guessed once a server is paired', async () => {
  const deps = { call: async () => ({ environments: hosts }) }
  const offline = {
    call: async () => {
      throw new Error('offline')
    }
  }
  assert.deepEqual(await readHosts(undefined, { call: async () => ({ environments: [] }) }), {
    selected: 'local',
    hosts: [],
    message: ''
  })
  // Not knowing the servers is not the same as having none: nothing starts here on a guess.
  const unknown = await readHosts(undefined, offline)
  assert.equal(unknown.selected, '')
  assert.match(unknown.message, /Could not read/)
  assert.deepEqual(await readHosts('local', deps), { selected: 'local', hosts, message: '' })
  assert.deepEqual(await readHosts('mini-1', deps), { selected: 'mini-1', hosts, message: '' })
  const unchosen = await readHosts(undefined, deps)
  assert.equal(unchosen.selected, '')
  assert.match(unchosen.message, /Choose where/)
  // A saved server that is gone or unreadable never becomes this computer.
  assert.match((await readHosts('gone', deps)).message, /no longer paired/)
  assert.equal((await readHosts('mini-1', offline)).selected, 'mini-1')
  assert.match((await readHosts('mini-1', offline)).message, /Could not read/)
})

/** Orca on this computer with one paired server, whose relay answers each request with `answer`. */
function relayTo(answer: (name: string, input: unknown) => unknown) {
  let open = false
  return {
    call: async (args: string[]): Promise<any> => {
      if (args[0] === 'environment') return { environments: hosts }
      throw new Error(`unexpected ${args.join(' ')}`)
    },
    // Stands in for the terminal: answers PING with the bundle's hash and the rest with `answer`.
    link: () => ({
      bundle: async () => ({ hash: '0123456789abcdef', files: {} }),
      call: fakeTerminal(
        answer,
        () => open,
        (value) => {
          open = value
        }
      )
    })
  }
}

test('the panel chooses the host, relays dashboard open and permissions, and keeps local separate', async () => {
  const local: string[] = []
  const relayed: string[] = []
  const host = mockHost()
  const worker = await mountWorker(
    {
      default: (orca) =>
        registerPairedHost(
          orca,
          (api) => {
            api.panels.handle('status', () => {
              local.push('status')
              return { state: 'running', message: '', port: 8799 }
            })
            api.panels.handle('setup.get', () => ({
              answered: false,
              agents: { claude: true, codex: false }
            }))
            api.panels.handle('chat.open', () => {
              local.push('open')
              return { message: 'Opened.' }
            })
            api.panels.handle('prefs.get', () => ({
              shareTools: false,
              linkAgents: false,
              agents: { claude: false, codex: false }
            }))
            api.panels.handle('prefs.set', () => ({
              shareTools: true,
              linkAgents: false,
              agents: { claude: false, codex: false }
            }))
            for (const name of ['server.install', 'server.stop']) {
              api.panels.handle(name, () => {
                throw new Error('Must run on selected remote host')
              })
            }
            api.panels.handle('tools.import', () => {
              local.push('import')
              return { added: [], skipped: [] }
            })
          },
          relayTo((name, input) => {
            relayed.push(name)
            if (name === 'chat.open') return { message: '' }
            if (name === 'setup.get')
              return {
                answered: true,
                shareTools: true,
                linkAgents: false,
                agents: { claude: true, codex: true }
              }
            if (name === 'prefs.get')
              return { shareTools: true, linkAgents: false, agents: { claude: true, codex: true } }
            if (name === 'prefs.set')
              return {
                shareTools: true,
                linkAgents: Boolean((input as { linkAgents?: boolean }).linkAgents),
                agents: { claude: true, codex: true }
              }
            if (name === 'tools.import') return { added: ['cursor'], skipped: [] }
            if (name === 'server.install') return { accepted: true }
            if (name === 'server.stop') return { stopped: true, message: 'Stopped.' }
            return { state: 'running', message: '' }
          })
        )
    },
    { host }
  )
  try {
    assert.equal(((await worker.request('hosts.get', {})) as { selected: string }).selected, '')
    const waiting = (await worker.request('status', {})) as { state: string; message: string }
    assert.equal(waiting.state, 'start_failed')
    assert.match(waiting.message, /Choose where/)
    assert.deepEqual(local, [])
    await assert.rejects(worker.request('hosts.select', { id: 'other' }), /not paired/)
    await assert.rejects(worker.request('hosts.select', {}), /Choose where/)
    assert.deepEqual(await worker.request('hosts.select', { id: 'mini-1' }), {
      selected: 'mini-1',
      hosts,
      message: ''
    })
    assert.equal(host.data().storage.botHost, 'mini-1')
    assert.match(
      ((await worker.request('status', {})) as { message: string }).message,
      /Connected to Mac Mini/
    )
    assert.deepEqual(await worker.request('setup.get', {}), {
      answered: true,
      shareTools: true,
      linkAgents: false,
      agents: { claude: true, codex: true }
    })
    assert.deepEqual(await worker.request('chat.open', {}), { message: '' })
    assert.deepEqual(await worker.request('prefs.get', {}), {
      shareTools: true,
      linkAgents: false,
      agents: { claude: true, codex: true }
    })
    assert.deepEqual(await worker.request('prefs.set', { linkAgents: true }), {
      shareTools: true,
      linkAgents: true,
      agents: { claude: true, codex: true }
    })
    assert.deepEqual(await worker.request('tools.import', {}), { added: ['cursor'], skipped: [] })
    assert.deepEqual(
      [local, relayed],
      [[], ['status', 'setup.get', 'chat.open', 'prefs.get', 'prefs.set', 'tools.import']]
    )
    assert.deepEqual(await worker.request('server.install', {}), { accepted: true })
    assert.deepEqual(await worker.request('server.stop', {}), {
      stopped: true,
      message: 'Stopped.'
    })
    assert.deepEqual(relayed.slice(-2), ['server.install', 'server.stop'])
    await worker.request('hosts.select', { id: 'local' })
    await worker.request('status', {})
    assert.deepEqual(local, ['status'])
  } finally {
    await worker.deactivate()
  }
})

test('host preferences sync two-way between a remote host local worker and a paired client', async () => {
  const files = new Map<string, string>()
  const hostPrefs = fileHostPrefs('/fake/.orca-bot/preferences.json', {
    mkdirSync: () => undefined,
    renameSync: (from, to) => {
      files.set(String(to), files.get(String(from))!)
      files.delete(String(from))
    },
    unlinkSync: (path) => {
      files.delete(String(path))
    },
    readFileSync: (path) => {
      const content = files.get(String(path))
      if (content === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return content as never
    },
    writeFileSync: (path, data) => {
      files.set(String(path), String(data))
    }
  })

  const makeDeps = () => ({
    hostPrefs,
    findAgents: () => ({ claude: true, codex: false }),
    checkHealth: async () => true,
    now: () => 0,
    ensureServer: async () => ({
      port: 18799,
      version: TESTED_OPENMAUSBOT_VERSION,
      started: false,
      startedByPlugin: true
    }),
    openChat: async () => ({ message: '' }),
    readThread: async () => ({ messages: [], hasMore: false }),
    sendMessage: async () => ({ sendId: 's1' }),
    addMausBot: async () => {},
    listBots: async () => [],
    stopServer: async () => ({ stopped: true, message: 'Stopped' })
  })

  const serverHost = mockHost({
    settings: { shareClaudeSetup: true, linkAgents: false },
    storage: { setupAnswered: true }
  })
  let serverApi: any
  const serverLocal = await mountWorker(
    {
      default: (orca) => {
        serverApi = orca
        register(orca, makeDeps())
      }
    },
    { host: serverHost }
  )
  const relayWorker = await mountWorker(
    { default: (orca) => register(orca, makeDeps()) },
    { host: mockHost() }
  )
  try {
    // A fresh relay reads defaults without persisting false over an uninitialized host.
    await relayWorker.request('prefs.get', {})
    assert.equal(hostPrefs.read(), undefined)
    // Installation can create a partial file before native Orca has synchronized.
    hostPrefs.write({ installConsent: true })
    // Seeded from Mac Mini's local Orca settings, visible to the paired client immediately.
    await Promise.all([serverLocal.request('prefs.get', {}), serverLocal.request('setup.get', {})])
    assert.equal(hostPrefs.read()?.shareTools, true)
    assert.equal(hostPrefs.read()?.setupAnswered, true)
    assert.deepEqual(await relayWorker.request('prefs.get', {}), {
      shareTools: true,
      linkAgents: false,
      agents: { claude: true, codex: false }
    })

    // Paired client toggles linkAgents ON -> Mac Mini's local Orca worker picks it up too.
    await relayWorker.request('prefs.set', { linkAgents: true, shareTools: false })
    assert.deepEqual(await serverLocal.request('prefs.get', {}), {
      shareTools: false,
      linkAgents: true,
      agents: { claude: true, codex: false }
    })
    assert.equal(serverHost.data().settings.shareClaudeSetup, false)
    assert.equal(serverHost.data().settings.linkAgents, true)
    // Native Orca Settings changes propagate back; unrelated host changes survive the patch.
    await serverApi.settings.set('shareClaudeSetup', true)
    hostPrefs.write({ installConsent: true })
    await serverLocal.request('prefs.get', {})
    assert.equal(((await relayWorker.request('prefs.get', {})) as any).shareTools, true)
    assert.equal(hostPrefs.read()?.installConsent, true)
    await relayWorker.request('status', {})
    assert.equal(serverHost.data().storage.openmausbotInstallConsent, true)
    // A stale paired-client cache cannot overwrite the canonical host preferences on restart.
    const staleHost = mockHost({
      settings: { shareClaudeSetup: false, linkAgents: false },
      storage: { setupAnswered: false, openmausbotInstallConsent: false }
    })
    const restarted = await mountWorker(
      { default: (orca) => register(orca, makeDeps()) },
      { host: staleHost }
    )
    try {
      assert.equal(((await restarted.request('prefs.get', {})) as any).linkAgents, true)
      assert.equal(staleHost.data().storage.openmausbotInstallConsent, true)
      assert.equal(staleHost.data().storage.setupAnswered, true)
    } finally {
      await restarted.deactivate()
    }
  } finally {
    await serverLocal.deactivate()
    await relayWorker.deactivate()
  }
})

test('a failed remote send never starts a local server or resends the message', async () => {
  let local = false,
    sends = 0
  const worker = await mountWorker(
    {
      default: (orca) =>
        registerPairedHost(
          orca,
          (api) => {
            api.panels.handle('message.send', () => {
              local = true
            })
          },
          relayTo(() => {
            sends++
            throw new Error('Disconnected')
          })
        )
    },
    { host: mockHost({ storage: { botHost: 'mini-1' } }) }
  )
  try {
    await assert.rejects(
      worker.request('message.send', { botId: 'b', text: 'hello' }),
      /Disconnected/
    )
    assert.equal(local, false)
    assert.equal(sends, 1)
  } finally {
    await worker.deactivate()
  }
})

/** The smallest terminal that runs a real relay: no backlog limit, one terminal. */
function fakeTerminal(
  answer: (name: string, input: unknown) => unknown,
  isOpen: () => boolean,
  setOpen: (open: boolean) => void
) {
  let lines: string[] = []
  let feed: ((chunk: string) => void) | undefined
  return async (args: string[]): Promise<any> => {
    const key = `${args[0]} ${args[1]}`
    if (key === 'worktree list') return { worktrees: [{ id: 'repo::/home', isMainWorktree: true }] }
    if (key === 'terminal create') {
      lines = [READY]
      feed = undefined
      setOpen(true)
      return { terminal: { handle: 'term_1' } }
    }
    if (key === 'terminal close') {
      setOpen(false)
      return {}
    }
    if (!isOpen()) throw new Error('closed')
    if (key === 'terminal send') {
      const text = args[args.indexOf('--text') + 1]
      if (!feed) {
        feed = createRelay(
          {
            hash: '0123456789abcdef',
            write: (out) => lines.push(...out.split('\r\n').filter(Boolean)),
            load: () => undefined,
            save: () => {}
          },
          (api) => {
            for (const name of RELAYED)
              api.panels.handle(name as never, ((input: unknown) => answer(name, input)) as never)
          }
        )
      } else feed(`${text}\r`)
      await new Promise((resolve) => setImmediate(resolve))
      return {}
    }
    if (key === 'terminal read') {
      const from = Number(args[args.indexOf('--cursor') + 1] ?? lines.length)
      return {
        terminal: { status: 'running', tail: lines.slice(from), nextCursor: String(lines.length) }
      }
    }
    throw new Error(`unexpected ${key}`)
  }
}

test('relay page store is saved with paired-client state and reloads after reconnect', () => {
  let saved: any
  let pages: any
  const io = {
    hash: 'fake',
    write: () => {},
    load: () => saved,
    save: (store: any) => {
      saved = JSON.parse(JSON.stringify(store))
    }
  }
  createRelay(io, (_api, store) => {
    pages = store
  })
  pages.set('http://127.0.0.1:8799', 'client-page')
  createRelay(io, (_api, store) => {
    pages = store
  })
  assert.equal(pages.get('http://127.0.0.1:8799'), 'client-page')
  pages.set('http://127.0.0.1:8799', undefined)
  createRelay(io, (_api, store) => {
    pages = store
  })
  assert.equal(pages.get('http://127.0.0.1:8799'), undefined)
})
