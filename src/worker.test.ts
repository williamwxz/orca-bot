import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { register, versionMessage } from './worker.ts'
import { ServerError } from './omb-server.ts'
import type { ServerResult } from './omb-server.ts'
import { TESTED_OPENMAUSBOT_VERSION as testedVersion } from '../shared/omb-version.ts'

// Every mounted worker uses fake lifecycle functions; no real defaults are called.
test('status answers starting immediately and running after the fake attempt settles', async () => {
  let settle!: (server: ServerResult) => void
  let calls = 0
  const attempt = new Promise<ServerResult>((resolve) => { settle = resolve })
  const worker = await mountWorker({ default: (orca) => register(orca, {
    ensureServer: () => {
      calls++
      return attempt
    },
    openChat: async () => ({ message: 'Opened' }),
    readThread: async () => ({ messages: [], hasMore: false }),
    sendMessage: async () => ({ sendId: 'fake-send-id-000000' }),
    listModels: async () => [],
    createBot: async () => { throw new Error('Unused') },
    setModel: async () => {},
    addMausBot: async () => {},
    listBots: async () => [],
    stopServer: async () => ({ stopped: true, message: 'Stopped' })
  }) }, { host: mockHost() })
  try {
    assert.equal((await worker.request('status', {}) as { state: string }).state, 'starting')
    assert.equal((await worker.request('status', {}) as { state: string }).state, 'starting')
    assert.equal(calls, 1)
    settle({ port: 8799, version: testedVersion, started: true, startedByPlugin: true })
    await attempt
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    assert.deepEqual(await worker.request('status', {}), {
      state: 'running', message: '', port: 8799, version: testedVersion, testedVersion
    })
    assert.deepEqual(await worker.request('server.stop', {}), { stopped: true, message: 'Stopped' })
    assert.equal((await worker.request('status', {}) as { state: string }).state, 'start_failed')
    assert.equal(calls, 1)
  } finally {
    await worker.deactivate()
  }
})

test('worker preserves failure until explicit Retry', async () => {
  let calls = 0
  const worker = await mountWorker({ default: (orca) => register(orca, {
    ensureServer: async () => {
      calls++
      throw new ServerError('needs_node', 'Install Node.js 24 or newer, then press Retry.')
    },
    openChat: async () => ({ message: 'Opened' }),
    readThread: async () => ({ messages: [], hasMore: false }),
    sendMessage: async () => ({ sendId: 'fake-send-id-000000' }),
    listModels: async () => [],
    createBot: async () => { throw new Error('Unused') },
    setModel: async () => {},
    addMausBot: async () => {},
    listBots: async () => [],
    stopServer: async () => ({ stopped: false, message: 'No server' })
  }) }, { host: mockHost() })
  try {
    await worker.request('status', {})
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    assert.equal((await worker.request('status', {}) as { state: string }).state, 'needs_node')
    assert.equal(calls, 1)
    assert.equal((await worker.request('status', { retry: true }) as { state: string }).state, 'starting')
  } finally {
    await worker.deactivate()
  }
})

test('version messages explain compatibility in either direction', () => {
  assert.equal(versionMessage('999.0'), `OpenMausBot 999.0 is newer than the version Bot Deck was tested with (${testedVersion}). It should work; tell us if something looks wrong.`)
  assert.equal(versionMessage('0.0'), `OpenMausBot 0.0 is older than Bot Deck expects (${testedVersion}). Update OpenMausBot.`)
  assert.equal(versionMessage(testedVersion), '')
})


test('version messages support suffixed and unknown versions', () => {
  assert.match(versionMessage('0.2.0-beta.1'), /newer than/)
  assert.match(versionMessage('development'), /version .* is unknown/)
  assert.match(versionMessage('unknown'), /cannot compare/)
})

test('chat and roster handlers refuse before running and validate bot IDs', async () => {
  const calls: unknown[] = []
  const worker = await mountWorker({ default: (orca) => register(orca, {
    ensureServer: async () => ({ port: 18799, version: testedVersion, started: true, startedByPlugin: true }),
    stopServer: async () => ({ stopped: true, message: 'Stopped' }),
    openChat: async (input) => {
      calls.push(input)
      return { message: 'Opened' }
    },
    readThread: async () => ({ messages: [], hasMore: false }),
    sendMessage: async () => ({ sendId: 'fake-send-id-000000' }),
    listModels: async () => [],
    createBot: async () => { throw new Error('Unused') },
    setModel: async () => {},
    addMausBot: async () => {},
    listBots: async (input) => {
      calls.push(input)
      return []
    }
  }) }, { host: mockHost() })
  try {
    for (const name of ['chat.open', 'bots.list', 'models.list', 'bots.create', 'bots.model', 'bots.addMausBot']) {
      await assert.rejects(worker.request(name, {}), /OpenMausBot is not running yet/)
    }
    assert.equal(calls.length, 0)
    await assert.rejects(worker.command('botdeck.open'), /OpenMausBot is not running yet/)
    await worker.request('status', {})
    await new Promise<void>((resolve) => setImmediate(resolve))
    for (const botId of ['bad', 123, null, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/evil']) {
      await assert.rejects(worker.request('chat.open', { botId }), /Invalid bot ID/)
    }
    const botId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    assert.deepEqual(await worker.request('chat.open', { botId }), { message: 'Opened' })
    assert.deepEqual(calls[0], { port: 18799, startedByPlugin: true, botId })
    assert.deepEqual(await worker.request('bots.list', {}), [])
    assert.deepEqual(calls[1], { port: 18799 })
    assert.deepEqual(await worker.command('botdeck.open'), { message: 'Opened' })
    assert.deepEqual(calls[2], { port: 18799, startedByPlugin: true, botId: undefined })
    await worker.request('server.stop', {})
    await assert.rejects(worker.request('chat.open', {}), /OpenMausBot is not running yet/)
  } finally {
    await worker.deactivate()
  }
})

test('bot chat resolves its thread from the last worker roster, never panel input', async () => {
  const botId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const calls: unknown[] = []
  let failRefresh = false
  let activeTaskId: string | undefined = 'server-thread'
  const worker = await mountWorker({ default: (orca) => register(orca, {
    ensureServer: async () => ({ port: 18799, version: testedVersion, started: false, startedByPlugin: true }),
    stopServer: async () => ({ stopped: true, message: 'Stopped' }),
    openChat: async (input) => {
      calls.push(input)
      return { message: 'Opened' }
    },
    readThread: async () => ({ messages: [], hasMore: false }),
    sendMessage: async () => ({ sendId: 'fake-send-id-000000' }),
    listModels: async () => [],
    createBot: async () => { throw new Error('Unused') },
    setModel: async () => {},
    addMausBot: async () => {},
    listBots: async () => {
      if (failRefresh) throw new Error('Offline')
      return [{ id: botId, name: 'Bot', title: '', main: true, state: 'idle', unread: false, modelLabel: 'Codex', activeTaskId }]
    }
  }) }, { host: mockHost() })
  try {
    await worker.request('status', {})
    await new Promise<void>((resolve) => setImmediate(resolve))
    await worker.request('chat.open', { botId, activeTaskId: 'panel-thread', threadId: 'panel-thread' })
    assert.deepEqual(calls[0], { port: 18799, startedByPlugin: true, botId })
    await worker.request('bots.list', {})
    await worker.request('chat.open', { botId, activeTaskId: 'panel-thread' })
    assert.deepEqual(calls[1], { port: 18799, startedByPlugin: true, botId, activeTaskId: 'server-thread' })
    failRefresh = true
    await assert.rejects(worker.request('bots.list', {}), /Offline/)
    await worker.request('chat.open', { botId })
    assert.deepEqual(calls[2], calls[1])
    failRefresh = false
    activeTaskId = undefined
    await worker.request('bots.list', {})
    await worker.request('chat.open', { botId, activeTaskId: 'panel-thread' })
    assert.deepEqual(calls[3], calls[0])
  } finally {
    await worker.deactivate()
  }
})

test('create is coalesced by refusal, returns a receipt, and later opens its thread even if roster refresh fails', async () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  let resolveCreate!: (value: { id: string; activeTaskId: string }) => void
  const creation = new Promise<{ id: string; activeTaskId: string }>((resolve) => { resolveCreate = resolve })
  const calls: unknown[] = []
  const worker = await mountWorker({ default: (orca) => register(orca, {
    ensureServer: async () => ({ port: 18799, version: testedVersion, started: true, startedByPlugin: true }),
    stopServer: async () => ({ stopped: false, message: '' }),
    openChat: async (input) => {
      calls.push(input)
      return { message: '' }
    },
    listBots: async () => { throw new Error('offline') },
    readThread: async () => ({ messages: [], hasMore: false }),
    sendMessage: async () => ({ sendId: 'fake-send-id-000000' }),
    listModels: async () => [],
    createBot: (input) => {
      calls.push(input)
      return creation
    },
    setModel: async (input) => { calls.push(input) },
    addMausBot: async (input) => { calls.push(input) }
  }) }, { host: mockHost() })
  try {
    await worker.request('status', {})
    await new Promise<void>((resolve) => setImmediate(resolve))
    const first = worker.request('bots.create', { name: 'Helper', model: 'claude/sonnet' })
    await new Promise<void>((resolve) => setImmediate(resolve))
    await assert.rejects(worker.request('bots.create', { name: 'Helper', model: 'claude/sonnet' }), /already being created/)
    resolveCreate({ id, activeTaskId: 'new-thread' })
    assert.deepEqual(await first, { id, activeTaskId: 'new-thread' })
    await assert.rejects(worker.request('bots.list', {}), /offline/)
    await worker.request('chat.open', { botId: id })
    assert.deepEqual(calls, [{ port: 18799, name: 'Helper', model: 'claude/sonnet' }, { port: 18799, startedByPlugin: true, botId: id, activeTaskId: 'new-thread' }])
    await worker.request('bots.model', { botId: id, model: 'claude/sonnet' })
    await worker.request('bots.addMausBot', { botId: id })
    assert.deepEqual(calls.slice(2), [{ port: 18799, botId: id, model: 'claude/sonnet' }, { port: 18799, botId: id }])
  } finally {
    await worker.deactivate()
  }
})

test('thread and send require a roster bot, with fresh worker-generated send IDs', async () => {
  const botId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const calls: any[] = []
  const worker = await mountWorker({ default: (orca) => register(orca, {
    ensureServer: async () => ({ port: 18799, version: testedVersion, started: false, startedByPlugin: false }),
    stopServer: async () => ({ stopped: false, message: '' }),
    openChat: async () => ({ message: '' }), listModels: async () => [],
    createBot: async () => { throw new Error('unused') }, setModel: async () => {}, addMausBot: async () => {},
    listBots: async () => [{ id: botId, name: 'Bot', title: '', main: false, state: 'idle', unread: false, modelLabel: '' }],
    readThread: async (input) => { calls.push(input); return { messages: [], hasMore: false } },
    sendMessage: async (input) => { calls.push(input); return { sendId: input.sendId } }
  }) }, { host: mockHost() })
  try {
    await worker.request('status', {})
    await new Promise<void>((resolve) => setImmediate(resolve))
    for (const name of ['thread.read', 'message.send']) {
      await assert.rejects(worker.request(name, { botId, text: 'Hello' }), /not in the roster/)
      await assert.rejects(worker.request(name, { botId: 'bad', text: 'Hello' }), /Invalid bot ID/)
    }
    assert.equal(calls.length, 0)
    await worker.request('bots.list', {})
    await worker.request('thread.read', { botId, limit: 20 })
    await worker.request('message.send', { botId, text: 'Hello', sendId: 'untrusted-panel-value' })
    await worker.request('message.send', { botId, text: 'Again' })
    assert.deepEqual(calls[0], { port: 18799, botId, limit: 20 })
    assert.match(calls[1].sendId, /^[a-zA-Z0-9_-]{16,80}$/)
    assert.notEqual(calls[1].sendId, 'untrusted-panel-value')
    assert.notEqual(calls[1].sendId, calls[2].sendId)
  } finally { await worker.deactivate() }
})
