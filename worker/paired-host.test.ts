import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { readHosts, registerPairedHost } from './paired-host.ts'
import { createRelay } from './relay-host.ts'
import { READY } from './relay-frames.ts'

const hosts = [{ id: 'mini-1', name: 'Mac Mini' }]
test('bots run here without paired servers, and nothing is guessed once a server is paired', async () => {
  const deps = { call: async () => ({ environments: hosts }) }
  const offline = { call: async () => { throw new Error('offline') } }
  assert.deepEqual(await readHosts(undefined, { call: async () => ({ environments: [] }) }), { selected: 'local', hosts: [], message: '' })
  assert.deepEqual(await readHosts(undefined, offline), { selected: 'local', hosts: [], message: '' })
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
    link: () => ({ bundle: async () => ({ hash: '0123456789abcdef', files: {} }), call: fakeTerminal(answer, () => open, value => { open = value }) })
  }
}

test('the panel chooses the host, and the choice applies at once and is remembered', async () => {
  const local: string[] = []
  const relayed: string[] = []
  const host = mockHost()
  const worker = await mountWorker({ default: orca => registerPairedHost(orca, api => {
    api.panels.handle('status', () => { local.push('status'); return { state: 'running', message: '', port: 8799 } })
    api.panels.handle('setup.get', () => ({ answered: false, agents: { claude: true, codex: false } }))
    api.panels.handle('chat.open', () => { local.push('open'); return { message: 'Opened.' } })
    api.panels.handle('tools.import', () => { local.push('import'); return { imported: [], skipped: [] } })
  }, relayTo((name) => { relayed.push(name); return { state: 'running', message: '' } })) }, { host })
  try {
    assert.equal((await worker.request('hosts.get', {}) as { selected: string }).selected, '')
    const waiting = await worker.request('status', {}) as { state: string; message: string }
    assert.equal(waiting.state, 'start_failed')
    assert.match(waiting.message, /Choose where/)
    assert.deepEqual(local, [])
    await assert.rejects(worker.request('hosts.select', { id: 'other' }), /not paired/)
    await assert.rejects(worker.request('hosts.select', {}), /Choose where/)
    assert.deepEqual(await worker.request('hosts.select', { id: 'mini-1' }), { selected: 'mini-1', hosts, message: '' })
    assert.equal(host.data().storage.botHost, 'mini-1')
    assert.match((await worker.request('status', {}) as { message: string }).message, /Connected to Mac Mini/)
    assert.deepEqual(await worker.request('setup.get', {}), { answered: true, agents: { claude: false, codex: false } })
    assert.match((await worker.request('chat.open', {}) as { message: string }).message, /runs on Mac Mini/)
    await assert.rejects(worker.request('tools.import', {}), /in Orca on Mac Mini/)
    assert.deepEqual([local, relayed], [[], ['status']])
    await worker.request('hosts.select', { id: 'local' })
    await worker.request('status', {})
    assert.deepEqual([local, relayed], [['status'], ['status']])
  } finally { await worker.deactivate() }
})

test('a failed remote send never starts a local server or resends the message', async () => {
  let local = false, sends = 0
  const worker = await mountWorker({ default: orca => registerPairedHost(orca, api => {
    api.panels.handle('message.send', () => { local = true })
  }, relayTo(() => { sends++; throw new Error('Disconnected') })) }, { host: mockHost({ storage: { botHost: 'mini-1' } }) })
  try {
    await assert.rejects(worker.request('message.send', { botId: 'b', text: 'hello' }), /Disconnected/)
    assert.equal(local, false)
    assert.equal(sends, 1)
  } finally { await worker.deactivate() }
})

/** The smallest terminal that runs a real relay: no backlog limit, one terminal. */
function fakeTerminal(answer: (name: string, input: unknown) => unknown, isOpen: () => boolean, setOpen: (open: boolean) => void) {
  let lines: string[] = []
  let feed: ((chunk: string) => void) | undefined
  return async (args: string[]): Promise<any> => {
    const key = `${args[0]} ${args[1]}`
    if (key === 'worktree list') return { worktrees: [{ id: 'repo::/home', isMainWorktree: true }] }
    if (key === 'terminal create') { lines = [READY]; feed = undefined; setOpen(true); return { terminal: { handle: 'term_1' } } }
    if (key === 'terminal close') { setOpen(false); return {} }
    if (!isOpen()) throw new Error('closed')
    if (key === 'terminal send') {
      const text = args[args.indexOf('--text') + 1]
      if (!feed) {
        feed = createRelay({ hash: '0123456789abcdef', write: out => lines.push(...out.split('\r\n').filter(Boolean)), load: () => undefined, save: () => {} }, api => {
          for (const name of ['status', 'bots.list', 'thread.read', 'message.send', 'bots.addMausBot']) api.panels.handle(name as never, ((input: unknown) => answer(name, input)) as never)
        })
      } else feed(`${text}\r`)
      await new Promise(resolve => setImmediate(resolve))
      return {}
    }
    if (key === 'terminal read') {
      const from = Number(args[args.indexOf('--cursor') + 1] ?? lines.length)
      return { terminal: { status: 'running', tail: lines.slice(from), nextCursor: String(lines.length) } }
    }
    throw new Error(`unexpected ${key}`)
  }
}
