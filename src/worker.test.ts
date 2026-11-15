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
    signInAgain: async () => ({ message: 'Opened' }),
    listBots: async () => [],
    stopServer: async () => ({ stopped: true, message: 'Stopped' })
  }) }, { host: mockHost() })
  try {
    assert.equal((await worker.request('status', {}) as { state: string }).state, 'starting')
    assert.equal((await worker.request('status', {}) as { state: string }).state, 'starting')
    assert.equal(calls, 1)
    settle({ port: 8799, version: testedVersion, started: true })
    await attempt
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    assert.deepEqual(await worker.request('status', {}), {
      state: 'running', message: 'OpenMausBot is ready.', port: 8799, version: testedVersion, testedVersion
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
    signInAgain: async () => ({ message: 'Opened' }),
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
  assert.equal(versionMessage(testedVersion), 'OpenMausBot is ready.')
})


test('version messages support suffixed and unknown versions', () => {
  assert.match(versionMessage('0.2.0-beta.1'), /newer than/)
  assert.match(versionMessage('development'), /version .* is unknown/)
  assert.match(versionMessage('unknown'), /cannot compare/)
})

test('chat and roster handlers refuse before running and validate bot IDs', async () => {
  const calls: unknown[] = []
  const worker = await mountWorker({ default: (orca) => register(orca, {
    ensureServer: async () => ({ port: 18799, version: testedVersion, started: true }),
    stopServer: async () => ({ stopped: true, message: 'Stopped' }),
    openChat: async (input) => {
      calls.push(input)
      return { message: 'Opened' }
    },
    signInAgain: async (input) => {
      calls.push({ ...input, signIn: true })
      return { message: 'Opened' }
    },
    listBots: async (input) => {
      calls.push(input)
      return []
    }
  }) }, { host: mockHost() })
  try {
    for (const name of ['chat.open', 'chat.signIn', 'bots.list']) {
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
    await worker.request('chat.signIn', {})
    assert.deepEqual(calls[1], { port: 18799, startedByPlugin: true, botId: undefined, signIn: true })
    assert.deepEqual(await worker.request('bots.list', {}), [])
    assert.deepEqual(calls[2], { port: 18799 })
    assert.deepEqual(await worker.command('botdeck.open'), { message: 'Opened' })
    assert.deepEqual(calls[3], { port: 18799, startedByPlugin: true, botId: undefined })
    await worker.request('server.stop', {})
    await assert.rejects(worker.request('chat.open', {}), /OpenMausBot is not running yet/)
  } finally {
    await worker.deactivate()
  }
})
