import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { register, versionMessage } from './worker.ts'
import { ServerError } from './omb-server.ts'
import type { ServerResult } from './omb-server.ts'
import { TESTED_OPENMAUSBOT_VERSION as testedVersion } from '../shared/omb-version.ts'

// Every mounted worker uses fake lifecycle functions; no real defaults are called.
test('status answers starting immediately and running after the fake attempt settles', async () => {
  let settle!: (server: ServerResult) => void
  let calls = 0
  const attempt = new Promise<ServerResult>((resolve) => {
    settle = resolve
  })
  const worker = await mountWorker(
    {
      default: (orca) =>
        register(orca, {
          checkHealth: async () => true,
          now: () => 0,
          ensureServer: () => {
            calls++
            return attempt
          },
          openChat: async () => ({ message: 'Opened' }),
          readThread: async () => ({ messages: [], hasMore: false }),
          sendMessage: async () => ({ sendId: 'fake-send-id-000000' }),
          addMausBot: async () => {},
          listBots: async () => [],
          stopServer: async () => ({ stopped: true, message: 'Stopped' })
        })
    },
    { host: mockHost() }
  )
  try {
    assert.equal(((await worker.request('status', {})) as { state: string }).state, 'starting')
    assert.equal(((await worker.request('status', {})) as { state: string }).state, 'starting')
    assert.equal(calls, 1)
    settle({ port: 8799, version: testedVersion, started: true, startedByPlugin: true })
    await attempt
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    assert.deepEqual(await worker.request('status', {}), {
      state: 'running',
      message: '',
      port: 8799,
      version: testedVersion,
      testedVersion
    })
    assert.deepEqual(await worker.request('server.stop', {}), { stopped: true, message: 'Stopped' })
    assert.equal(((await worker.request('status', {})) as { state: string }).state, 'start_failed')
    assert.equal(calls, 1)
  } finally {
    await worker.deactivate()
  }
})

test('worker preserves failure until explicit Retry', async () => {
  let calls = 0
  const worker = await mountWorker(
    {
      default: (orca) =>
        register(orca, {
          checkHealth: async () => true,
          now: () => 0,
          ensureServer: async () => {
            calls++
            throw new ServerError('needs_node', 'Install Node.js 24 or newer, then press Retry.')
          },
          openChat: async () => ({ message: 'Opened' }),
          readThread: async () => ({ messages: [], hasMore: false }),
          sendMessage: async () => ({ sendId: 'fake-send-id-000000' }),
          addMausBot: async () => {},
          listBots: async () => [],
          stopServer: async () => ({ stopped: false, message: 'No server' })
        })
    },
    { host: mockHost() }
  )
  try {
    await worker.request('status', {})
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    assert.equal(((await worker.request('status', {})) as { state: string }).state, 'needs_node')
    assert.equal(calls, 1)
    assert.equal(((await worker.request('status', { retry: true })) as { state: string }).state, 'starting')
  } finally {
    await worker.deactivate()
  }
})

test('version messages explain compatibility in either direction', () => {
  assert.equal(
    versionMessage('999.0'),
    `OpenMausBot 999.0 is newer than the version Bot Team for Orca was tested with (${testedVersion}). It should work; tell us if something looks wrong.`
  )
  assert.equal(
    versionMessage('0.0'),
    `OpenMausBot 0.0 is older than Bot Team for Orca expects (${testedVersion}). Update OpenMausBot.`
  )
  assert.equal(versionMessage(testedVersion), '')
})

test('version messages support suffixed and unknown versions', () => {
  assert.match(versionMessage('0.2.0-beta.1'), /newer than/)
  assert.match(versionMessage('development'), /version .* is unknown/)
  assert.match(versionMessage('unknown'), /cannot compare/)
})

test('chat and roster handlers refuse before running and validate bot IDs', async () => {
  const calls: unknown[] = []
  const worker = await mountWorker(
    {
      default: (orca) =>
        register(orca, {
          checkHealth: async () => true,
          now: () => 0,
          ensureServer: async () => ({
            port: 18799,
            version: testedVersion,
            started: true,
            startedByPlugin: true
          }),
          stopServer: async () => ({ stopped: true, message: 'Stopped' }),
          openChat: async (input) => {
            calls.push(input)
            return { message: 'Opened' }
          },
          readThread: async () => ({ messages: [], hasMore: false }),
          sendMessage: async () => ({ sendId: 'fake-send-id-000000' }),
          addMausBot: async () => {},
          listBots: async (input) => {
            calls.push(input)
            return []
          }
        })
    },
    { host: mockHost() }
  )
  try {
    for (const name of ['chat.open', 'bots.list', 'bots.addMausBot']) {
      await assert.rejects(worker.request(name, {}), /OpenMausBot is not running yet/)
    }
    assert.equal(calls.length, 0)
    await assert.rejects(worker.command('orcabot.open'), /OpenMausBot is not running yet/)
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
    assert.deepEqual(await worker.command('orcabot.open'), { message: 'Opened' })
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
  const worker = await mountWorker(
    {
      default: (orca) =>
        register(orca, {
          checkHealth: async () => true,
          now: () => 0,
          ensureServer: async () => ({
            port: 18799,
            version: testedVersion,
            started: false,
            startedByPlugin: true
          }),
          stopServer: async () => ({ stopped: true, message: 'Stopped' }),
          openChat: async (input) => {
            calls.push(input)
            return { message: 'Opened' }
          },
          readThread: async () => ({ messages: [], hasMore: false }),
          sendMessage: async () => ({ sendId: 'fake-send-id-000000' }),
          addMausBot: async () => {},
          listBots: async () => {
            if (failRefresh) throw new Error('Offline')
            return [
              {
                id: botId,
                name: 'Bot',
                title: '',
                main: true,
                state: 'idle',
                unread: false,
                modelLabel: 'Codex',
                activeTaskId
              }
            ]
          }
        })
    },
    { host: mockHost() }
  )
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

test('thread and send require a roster bot, with fresh worker-generated send IDs', async () => {
  const botId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const calls: any[] = []
  const worker = await mountWorker(
    {
      default: (orca) =>
        register(orca, {
          checkHealth: async () => true,
          now: () => 0,
          ensureServer: async () => ({
            port: 18799,
            version: testedVersion,
            started: false,
            startedByPlugin: false
          }),
          stopServer: async () => ({ stopped: false, message: '' }),
          openChat: async () => ({ message: '' }),
          addMausBot: async () => {},
          listBots: async () => [
            { id: botId, name: 'Bot', title: '', main: false, state: 'idle', unread: false, modelLabel: '' }
          ],
          readThread: async (input) => {
            calls.push(input)
            return { messages: [], hasMore: false }
          },
          sendMessage: async (input) => {
            calls.push(input)
            return { sendId: input.sendId }
          }
        })
    },
    { host: mockHost() }
  )
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
  } finally {
    await worker.deactivate()
  }
})

test('status rechecks known health at most every two seconds and restarts discovery when gone', async () => {
  let now = 0,
    attempts = 0,
    checks = 0
  let healthy = true
  const worker = await mountWorker(
    {
      default: (orca) =>
        register(orca, {
          now: () => now,
          checkHealth: async (port) => {
            assert.equal(port, 18799)
            checks++
            return healthy
          },
          ensureServer: async () => {
            attempts++
            if (attempts > 1) return new Promise(() => {})
            return { port: 18799, version: testedVersion, started: false, startedByPlugin: false }
          },
          stopServer: async () => ({ stopped: false, message: '' }),
          openChat: async () => ({ message: '' }),
          listBots: async () => [],
          addMausBot: async () => {},
          readThread: async () => ({ messages: [], hasMore: false }),
          sendMessage: async () => ({ sendId: 'fake-send-id-000000' })
        })
    },
    { host: mockHost() }
  )
  try {
    assert.equal(((await worker.request('status', {})) as any).state, 'starting')
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(((await worker.request('status', {})) as any).state, 'running')
    await Promise.all([worker.request('status', {}), worker.request('status', {})])
    assert.equal(checks, 1)
    healthy = false
    now = 2000
    assert.equal(((await worker.request('status', {})) as any).state, 'starting')
    assert.equal(checks, 2)
    assert.equal(attempts, 2)
    await assert.rejects(worker.request('bots.list', {}), /not running yet/)
  } finally {
    await worker.deactivate()
  }
})

test('status restarts owned mismatched setup only after idle, reflects setting changes and exposes notice', async () => {
  for (const owned of [false, true])
    for (const busyInitially of [false, true]) {
      let now = 0,
        busy = busyInitially,
        mismatch = true,
        starts = 0,
        stops = 0,
        inspections = 0
      let release!: () => void
      const host = mockHost({ storage: { setupAnswered: true }, settings: { shareClaudeSetup: true } })
      let api: any
      const choices: boolean[] = []
      const worker = await mountWorker(
        {
          default: (orca) => {
            api = orca
            register(orca, {
              now: () => now,
              checkHealth: async () => true,
              ensureServer: async (share) => {
                starts++
                choices.push(share)
                mismatch = false
                return { port: 18799, version: testedVersion, started: starts > 1, startedByPlugin: owned }
              },
              claudeSetupStatus: async (_port, share) => {
                inspections++
                return { restart: mismatch, message: share ? 'Claude tools on.' : 'Claude tools off.' }
              },
              rosterBusy: async () => busy,
              stopServer: async () => {
                stops++
                await new Promise<void>((resolve) => {
                  release = resolve
                })
                return { stopped: true, message: '' }
              },
              openChat: async () => ({ message: '' }),
              listBots: async () => [],
              addMausBot: async () => {},
              readThread: async () => ({ messages: [], hasMore: false }),
              sendMessage: async () => ({ sendId: 'fake-send-id-000000' })
            })
          }
        },
        { host }
      )
      try {
        await worker.request('status', {})
        await new Promise<void>((resolve) => setImmediate(resolve))
        mismatch = true
        await api.settings.set('shareClaudeSetup', false)
        let status = (await worker.request('status', {})) as any
        if (!owned || busyInitially) {
          assert.equal(status.state, 'running')
          assert.equal(stops, 0)
          assert.equal(starts, 1)
          if (!owned) {
            assert.equal(inspections, 0)
            continue
          }
          busy = false
          now = 2000
          status = (await worker.request('status', {})) as any
        }
        assert.equal(status.state, 'starting')
        assert.equal(status.message, 'Restarting OpenMausBot to apply your Claude setup…')
        await worker.request('status', {})
        assert.equal(stops, 1)
        release()
        await new Promise<void>((resolve) => setImmediate(resolve))
        assert.equal(((await worker.request('status', {})) as any).state, 'running')
        assert.equal(starts, 2)
        assert.deepEqual(choices, [true, false])
        now = 4000
        assert.equal(((await worker.request('status', {})) as any).state, 'running')
        assert.equal(stops, 1)
      } finally {
        release?.()
        await worker.deactivate()
      }
    }
})

test('automatic restart respects stop refusal and contains restart failures', async () => {
  for (const stopped of [false, true]) {
    let starts = 0
    const worker = await mountWorker(
      {
        default: (orca) =>
          register(orca, {
            now: () => 0,
            checkHealth: async () => true,
            ensureServer: async () => {
              if (++starts > 1) throw new Error('private path')
              return { port: 18799, version: testedVersion, started: false, startedByPlugin: true }
            },
            claudeSetupStatus: async () => ({ restart: true, message: '' }),
            rosterBusy: async () => false,
            stopServer: async () => ({ stopped, message: '' }),
            openChat: async () => ({ message: '' }),
            listBots: async () => [],
            addMausBot: async () => {},
            readThread: async () => ({ messages: [], hasMore: false }),
            sendMessage: async () => ({ sendId: 'fake-send-id-000000' })
          })
      },
      { host: mockHost() }
    )
    try {
      await worker.request('status', {})
      await new Promise<void>((resolve) => setImmediate(resolve))
      await worker.request('status', {})
      await new Promise<void>((resolve) => setImmediate(resolve))
      const status = (await worker.request('status', {})) as any
      assert.equal(status.state, stopped ? 'start_failed' : 'running')
      assert.equal(starts, stopped ? 2 : 1)
      assert.doesNotMatch(JSON.stringify(status), /private path/)
    } finally {
      await worker.deactivate()
    }
  }
})

function setupDeps(owned = true) {
  return {
    now: () => 10000,
    checkHealth: async () => true,
    findAgents: () => ({ claude: true, codex: false }),
    ensureServer: async (_share: boolean) => ({
      port: 8799,
      version: testedVersion,
      started: true,
      startedByPlugin: owned
    }),
    syncAgentLinks: async (_input: { enabled: boolean; owned: boolean; port: number }) => {},
    stopServer: async () => ({ stopped: true, message: '' }),
    openChat: async () => ({ message: '' }),
    listBots: async () => [],
    addMausBot: async () => {},
    readThread: async () => ({ messages: [], hasMore: false }),
    sendMessage: async () => ({ sendId: 'fake-send-id-000000' })
  }
}

test('setup.get reports persisted answer and found agents', async () => {
  for (const answered of [false, true]) {
    const worker = await mountWorker(
      { default: (orca) => register(orca, setupDeps()) },
      { host: mockHost({ storage: { setupAnswered: answered } }) }
    )
    try {
      assert.deepEqual(await worker.request('setup.get', {}), {
        answered,
        agents: { claude: true, codex: false }
      })
    } finally {
      await worker.deactivate()
    }
  }
})
test('setup.answer writes both choices then persists answer and cannot answer twice', async () => {
  for (const allowed of [false, true]) {
    const host = mockHost()
    const worker = await mountWorker({ default: (orca) => register(orca, setupDeps()) }, { host })
    try {
      await assert.rejects(worker.request('setup.answer', { shareTools: 'yes', linkAgents: true }), /Choose/)
      assert.deepEqual(await worker.request('setup.answer', { shareTools: allowed, linkAgents: allowed }), {
        answered: true
      })
      assert.deepEqual(host.data().settings, { shareClaudeSetup: allowed, linkAgents: allowed })
      assert.equal(host.data().storage.setupAnswered, true)
      await worker.request('setup.answer', { shareTools: !allowed, linkAgents: !allowed })
      assert.deepEqual(host.data().settings, { shareClaudeSetup: allowed, linkAgents: allowed })
    } finally {
      await worker.deactivate()
    }
  }
})
test('unanswered setup prevents sharing even with a retained true setting', async () => {
  const deps = setupDeps()
  const choices: boolean[] = []
  const start = deps.ensureServer
  deps.ensureServer = async (share) => {
    choices.push(share)
    return start(share)
  }
  const worker = await mountWorker(
    { default: (orca) => register(orca, deps) },
    { host: mockHost({ settings: { shareClaudeSetup: true, linkAgents: true } }) }
  )
  try {
    await worker.request('status', {})
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.deepEqual(choices, [false])
    assert.equal(((await worker.request('status', {})) as any).message, '')
  } finally {
    await worker.deactivate()
  }
})
test('link choices apply only to owned servers and later Settings changes reconcile on health checks', async () => {
  for (const owned of [false, true]) {
    const deps = setupDeps(owned)
    let now = 0,
      api: any
    deps.now = () => now
    const links: boolean[] = []
    deps.syncAgentLinks = async (input) => {
      assert.equal(input.owned, true)
      links.push(input.enabled)
    }
    const worker = await mountWorker(
      {
        default: (orca) => {
          api = orca
          register(orca, deps)
        }
      },
      { host: mockHost() }
    )
    try {
      await worker.request('status', {})
      await new Promise<void>((resolve) => setImmediate(resolve))
      await worker.request('setup.answer', { shareTools: true, linkAgents: true })
      assert.deepEqual(links, owned ? [true] : [])
      await worker.request('status', {})
      await api.settings.set('linkAgents', false)
      now = 2000
      await worker.request('status', {})
      assert.deepEqual(links, owned ? [true, true, false] : [])
    } finally {
      await worker.deactivate()
    }
  }
})
test('setup link failure keeps unanswered state and allows retry with a generic error', async () => {
  const deps = setupDeps()
  let fail = true
  deps.syncAgentLinks = async () => {
    if (fail) throw new Error('private-output')
  }
  const host = mockHost()
  const worker = await mountWorker({ default: (orca) => register(orca, deps) }, { host })
  try {
    await worker.request('status', {})
    await new Promise<void>((resolve) => setImmediate(resolve))
    await assert.rejects(
      worker.request('setup.answer', { shareTools: true, linkAgents: true }),
      /Could not finish setup. Please try again./
    )
    assert.notEqual(host.data().storage.setupAnswered, true)
    fail = false
    await worker.request('setup.answer', { shareTools: false, linkAgents: false })
    assert.equal(host.data().storage.setupAnswered, true)
  } finally {
    await worker.deactivate()
  }
})
test('health link failure preserves running server with a generic notice', async () => {
  const deps = setupDeps()
  deps.syncAgentLinks = async () => {
    throw new Error('private-output')
  }
  const worker = await mountWorker(
    { default: (orca) => register(orca, deps) },
    { host: mockHost({ storage: { setupAnswered: true }, settings: { linkAgents: true } }) }
  )
  try {
    await worker.request('status', {})
    await new Promise<void>((resolve) => setImmediate(resolve))
    const status = (await worker.request('status', {})) as any
    assert.equal(status.state, 'running')
    assert.equal(status.message, 'Could not update Bot Team for Orca setup.')
  } finally {
    await worker.deactivate()
  }
})

test('failed links back off for 60 seconds, keep the notice, and retry immediately on a setting change', async () => {
  const deps = setupDeps()
  let now = 0,
    calls = 0,
    api: any,
    fail = true
  deps.now = () => now
  deps.syncAgentLinks = async () => {
    calls++
    if (fail) throw new Error('Could not add Bot Team for Orca to Codex.')
  }
  const worker = await mountWorker(
    {
      default: (orca) => {
        api = orca
        register(orca, deps)
      }
    },
    { host: mockHost({ storage: { setupAnswered: true }, settings: { linkAgents: true } }) }
  )
  try {
    await worker.request('status', {})
    await new Promise<void>((resolve) => setImmediate(resolve))
    await worker.request('status', {})
    assert.equal(calls, 1)
    for (now = 2000; now < 60000; now += 2000) {
      const status = (await worker.request('status', {})) as any
      assert.equal(status.message, 'Could not add Bot Team for Orca to Codex.')
      assert.equal(calls, 1)
    }
    await worker.request('status', {})
    assert.equal(calls, 2)
    now = 60001
    await api.settings.set('linkAgents', false)
    await worker.request('status', {})
    assert.equal(calls, 3)
    now = 62001
    await worker.request('status', {})
    assert.equal(calls, 3)
    fail = false
    now = 62002
    await api.settings.set('linkAgents', true)
    assert.equal(((await worker.request('status', {})) as any).message, '')
    assert.equal(calls, 4)
  } finally {
    await worker.deactivate()
  }
})

test('setup answers bypass a previous link backoff but failed answers do not cause rapid automatic retries', async () => {
  const deps = setupDeps()
  let now = 0,
    calls = 0,
    fail = true
  deps.now = () => now
  deps.syncAgentLinks = async () => {
    calls++
    if (fail) throw new Error('Could not add Bot Team for Orca to Claude.')
  }
  const worker = await mountWorker({ default: (orca) => register(orca, deps) }, { host: mockHost() })
  try {
    await worker.request('status', {})
    await new Promise<void>((resolve) => setImmediate(resolve))
    await worker.request('status', {})
    assert.equal(calls, 1)
    now = 1
    await assert.rejects(
      worker.request('setup.answer', { shareTools: true, linkAgents: true }),
      /Could not finish setup/
    )
    assert.equal(calls, 2)
    now = 2001
    assert.equal(
      ((await worker.request('status', {})) as any).message,
      'Could not add Bot Team for Orca to Claude.'
    )
    assert.equal(calls, 2)
    fail = false
    await worker.request('setup.answer', { shareTools: true, linkAgents: true })
    assert.equal(calls, 3)
    assert.equal(((await worker.request('setup.get', {})) as any).answered, true)
    assert.equal(((await worker.request('status', {})) as any).message, '')
  } finally {
    await worker.deactivate()
  }
})

test('tools handlers coalesce imports, refuse unowned servers, and sanitize failures', async () => {
  for (const owned of [true, false]) {
    let calls = 0
    let finish!: (result: { added: string[]; skipped: [] }) => void
    const result = new Promise<{ added: string[]; skipped: [] }>((resolve) => {
      finish = resolve
    })
    const worker = await mountWorker(
      {
        default: (orca) =>
          register(orca, {
            checkHealth: async () => true,
            now: () => 0,
            ensureServer: async () => ({
              port: 1234,
              version: testedVersion,
              started: owned,
              startedByPlugin: owned
            }),
            stopServer: async () => ({ stopped: true, message: '' }),
            openChat: async () => ({ message: '' }),
            listBots: async () => [],
            addMausBot: async () => {},
            readThread: async () => ({ messages: [], hasMore: false }),
            sendMessage: async () => ({ sendId: 'fake' }),
            findTools: async () => [{ name: 'test', source: 'Cursor' }],
            importTools: async () => {
              calls++
              return result
            }
          })
      },
      { host: mockHost() }
    )
    try {
      assert.deepEqual(await worker.request('tools.find', {}), {
        tools: [{ name: 'test', source: 'Cursor' }]
      })
      const first = worker.request('tools.import', {})
      if (!owned) {
        await assert.rejects(first, /server Bot Team for Orca started/)
        assert.equal(calls, 0)
        continue
      }
      const second = worker.request('tools.import', {})
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.equal(calls, 1)
      finish({ added: ['test'], skipped: [] })
      assert.deepEqual(await first, { added: ['test'], skipped: [] })
      assert.deepEqual(await second, { added: ['test'], skipped: [] })
    } finally {
      await worker.deactivate()
    }
  }
})

const flushRepair = () => new Promise<void>((resolve) => setImmediate(resolve))

test('background repair uses owned health checks, throttles 30s and silently backs off failures 60s', async () => {
  for (const owned of [false, true]) {
    let now = 0,
      calls = 0,
      fail = false
    const deps = {
      ...setupDeps(owned),
      now: () => now,
      ensureServer: async () => ({
        port: 8799,
        version: testedVersion,
        started: false,
        startedByPlugin: owned
      }),
      repairChat: async (input: { port: number; startedByPlugin: boolean }) => {
        assert.deepEqual(input, { port: 8799, startedByPlugin: true })
        calls++
        if (fail) throw new Error('http://127.0.0.1:8799/pair#private-output')
        return true
      }
    }
    const worker = await mountWorker({ default: (orca) => register(orca, deps) }, { host: mockHost() })
    try {
      await worker.request('status', {})
      await flushRepair()
      for (now = 0; now < 30000; now += 2000) {
        assert.equal(((await worker.request('status', {})) as any).message, '')
        await flushRepair()
        assert.equal(calls, owned ? 1 : 0)
      }
      fail = true
      await worker.request('status', {})
      await flushRepair()
      assert.equal(calls, owned ? 2 : 0)
      for (now = 32000; now < 90000; now += 2000) {
        assert.equal(((await worker.request('status', {})) as any).message, '')
        await flushRepair()
        assert.equal(calls, owned ? 2 : 0)
      }
      fail = false
      await worker.request('status', {})
      await flushRepair()
      assert.equal(calls, owned ? 3 : 0)
    } finally {
      await worker.deactivate()
    }
  }
})

test('background repair and explicit opens share the guard in both directions', async () => {
  let now = 0,
    repairs = 0,
    opens = 0
  let release!: () => void
  let gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const deps = {
    ...setupDeps(),
    now: () => now,
    ensureServer: async () => ({ port: 8799, version: testedVersion, started: false, startedByPlugin: true }),
    repairChat: async () => {
      repairs++
      await gate
      return true
    },
    openChat: async () => {
      opens++
      await gate
      return { message: 'Opened' }
    }
  }
  const worker = await mountWorker({ default: (orca) => register(orca, deps) }, { host: mockHost() })
  try {
    await worker.request('status', {})
    await flushRepair()
    await worker.request('status', {})
    await flushRepair()
    assert.equal(repairs, 1)
    const click = worker.request('chat.open', {})
    await flushRepair()
    assert.equal(opens, 0)
    now = 30000
    await worker.request('status', {})
    await flushRepair()
    assert.equal(repairs, 1)
    release()
    assert.deepEqual(await click, { message: '' })
    await flushRepair()
    gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const opening = worker.request('chat.open', {})
    await flushRepair()
    assert.equal(opens, 1)
    now = 32000
    await worker.request('status', {})
    await flushRepair()
    assert.equal(repairs, 1)
    release()
    assert.deepEqual(await opening, { message: 'Opened' })
    now = 34000
    await worker.request('status', {})
    await flushRepair()
    assert.equal(repairs, 2)
  } finally {
    release()
    await worker.deactivate()
  }
})

test('own setup restart checks again immediately despite the 30s throttle', async () => {
  let now = 0,
    repairs = 0,
    starts = 0,
    mismatch = false
  const deps = {
    ...setupDeps(),
    now: () => now,
    ensureServer: async () => {
      starts++
      mismatch = false
      return { port: 8799, version: testedVersion, started: starts > 1, startedByPlugin: true }
    },
    claudeSetupStatus: async () => ({ restart: mismatch, message: '' }),
    rosterBusy: async () => false,
    repairChat: async () => {
      repairs++
      return true
    }
  }
  const worker = await mountWorker({ default: (orca) => register(orca, deps) }, { host: mockHost() })
  try {
    await worker.request('status', {})
    await flushRepair()
    await worker.request('status', {})
    await flushRepair()
    assert.equal(repairs, 1)
    mismatch = true
    now = 2000
    await worker.request('status', {})
    await flushRepair()
    assert.equal(starts, 2)
    assert.equal(repairs, 2)
  } finally {
    await worker.deactivate()
  }
})

test('health recovery checks immediately after starting our replacement server', async () => {
  let now = 0,
    repairs = 0,
    starts = 0,
    healthy = true
  const deps = {
    ...setupDeps(),
    now: () => now,
    checkHealth: async () => healthy,
    ensureServer: async () => {
      starts++
      healthy = true
      return { port: 8799, version: testedVersion, started: starts > 1, startedByPlugin: true }
    },
    repairChat: async () => {
      repairs++
      return true
    }
  }
  const worker = await mountWorker({ default: (orca) => register(orca, deps) }, { host: mockHost() })
  try {
    await worker.request('status', {})
    await flushRepair()
    await worker.request('status', {})
    await flushRepair()
    assert.equal(repairs, 1)
    healthy = false
    now = 2000
    await worker.request('status', {})
    await flushRepair()
    assert.equal(starts, 2)
    assert.equal(repairs, 2)
  } finally {
    await worker.deactivate()
  }
})
