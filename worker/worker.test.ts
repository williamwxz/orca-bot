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
    assert.equal(
      ((await worker.request('status', { retry: true })) as { state: string }).state,
      'starting'
    )
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
    await worker.request('chat.open', {
      botId,
      activeTaskId: 'panel-thread',
      threadId: 'panel-thread'
    })
    assert.deepEqual(calls[0], { port: 18799, startedByPlugin: true, botId })
    await worker.request('bots.list', {})
    await worker.request('chat.open', { botId, activeTaskId: 'panel-thread' })
    assert.deepEqual(calls[1], {
      port: 18799,
      startedByPlugin: true,
      botId,
      activeTaskId: 'server-thread'
    })
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
            {
              id: botId,
              name: 'Bot',
              title: '',
              main: false,
              state: 'idle',
              unread: false,
              modelLabel: ''
            }
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
      const host = mockHost({
        storage: { setupAnswered: true },
        settings: { shareClaudeSetup: true }
      })
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
                return {
                  port: 18799,
                  version: testedVersion,
                  started: starts > 1,
                  startedByPlugin: owned
                }
              },
              claudeSetupStatus: async (_port, share) => {
                inspections++
                return {
                  restart: mismatch,
                  message: share ? 'Claude tools on.' : 'Claude tools off.'
                }
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
        shareTools: false,
        linkAgents: false,
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
      await assert.rejects(
        worker.request('setup.answer', { shareTools: 'yes', linkAgents: true }),
        /Choose/
      )
      assert.deepEqual(
        await worker.request('setup.answer', { shareTools: allowed, linkAgents: allowed }),
        {
          answered: true
        }
      )
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
  const worker = await mountWorker(
    { default: (orca) => register(orca, deps) },
    { host: mockHost() }
  )
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
    const worker = await mountWorker(
      { default: (orca) => register(orca, deps) },
      { host: mockHost() }
    )
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
    ensureServer: async () => ({
      port: 8799,
      version: testedVersion,
      started: false,
      startedByPlugin: true
    }),
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
  const worker = await mountWorker(
    { default: (orca) => register(orca, deps) },
    { host: mockHost() }
  )
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
  const worker = await mountWorker(
    { default: (orca) => register(orca, deps) },
    { host: mockHost() }
  )
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
  const worker = await mountWorker(
    { default: (orca) => register(orca, deps) },
    { host: mockHost() }
  )
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

test('outdated owned server defers agent linking until updated when idle', async () => {
  let now = 0,
    busy = true,
    current = '0.1.158',
    stops = 0
  const links: boolean[] = []
  let release!: () => void
  const host = mockHost({
    storage: { setupAnswered: true, openmausbotInstallConsent: true },
    settings: { linkAgents: true }
  })
  const worker = await mountWorker(
    {
      default: (orca) =>
        register(orca, {
          ...setupDeps(),
          now: () => now,
          ensureServer: async () => ({
            port: 8799,
            version: current,
            started: stops > 0,
            startedByPlugin: true
          }),
          claudeSetupStatus: async () =>
            current === testedVersion
              ? { restart: false, message: '' }
              : {
                  restart: true,
                  updating: true,
                  message: `OpenMausBot will update to ${testedVersion} when bots are idle.`
                },
          rosterBusy: async () => busy,
          stopServer: async () => {
            stops++
            await new Promise<void>((resolve) => {
              release = resolve
            })
            current = testedVersion
            return { stopped: true, message: '' }
          },
          syncAgentLinks: async ({ enabled }) => {
            links.push(enabled)
          }
        })
    },
    { host }
  )
  try {
    await worker.request('status', {})
    await new Promise<void>((resolve) => setImmediate(resolve))
    let status = (await worker.request('status', {})) as any
    assert.equal(status.state, 'running')
    assert.equal(status.message, `OpenMausBot will update to ${testedVersion} when bots are idle.`)
    assert.deepEqual(links, [])
    busy = false
    now = 2000
    status = (await worker.request('status', {})) as any
    assert.equal(status.state, 'starting')
    assert.equal(status.message, `Updating OpenMausBot to ${testedVersion}…`)
    await new Promise<void>((resolve) => setImmediate(resolve))
    release()
    await new Promise<void>((resolve) => setImmediate(resolve))
    status = (await worker.request('status', {})) as any
    assert.equal(status.state, 'running')
    assert.equal(status.version, testedVersion)
    assert.deepEqual(links, [true])
  } finally {
    release?.()
    await worker.deactivate()
  }
})

test('polls and tool import cannot approve installation; the explicit action persists consent', async () => {
  const host = mockHost()
  const permissions: boolean[] = []
  const worker = await mountWorker(
    {
      default: (orca) =>
        register(orca, {
          ...setupDeps(),
          ensureServer: async (_share, allowInstall) => {
            permissions.push(allowInstall === true)
            if (!allowInstall) throw new ServerError('needs_install', 'Install OpenMausBot.')
            return { port: 8799, version: testedVersion, started: true, startedByPlugin: true }
          },
          importTools: async () => ({ added: [], skipped: [] })
        })
    },
    { host }
  )
  try {
    await worker.request('status', {})
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(((await worker.request('status', {})) as any).state, 'needs_install')
    await assert.rejects(worker.request('tools.import', {}))
    assert.deepEqual(permissions, [false, false])
    await worker.request('server.install', {})
    await worker.request('status', {})
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(((await worker.request('status', {})) as any).state, 'running')
    assert.deepEqual(permissions, [false, false, true])
    await worker.request('server.stop', {})
    await worker.request('status', { retry: true })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(permissions.at(-1), true)
  } finally {
    await worker.deactivate()
  }
})

test('idle update requires consent, preserves old server on integrity failure and rechecks busy', async () => {
  for (const scenario of ['no-consent', 'integrity', 'became-busy', 'success']) {
    let stops = 0,
      prepares = 0,
      probes = 0
    const events: string[] = []
    const worker = await mountWorker(
      {
        default: (orca) =>
          register(orca, {
            ...setupDeps(),
            ensureServer: async () => ({
              port: 8799,
              version: stops ? testedVersion : '0.1.158',
              started: stops > 0,
              startedByPlugin: true
            }),
            claudeSetupStatus: async () => ({
              restart: !stops,
              updating: !stops,
              message: 'Update pending.'
            }),
            rosterBusy: async () => {
              probes++
              events.push('busy')
              return scenario === 'became-busy' && probes > 1
            },
            prepareServer: async (allow) => {
              assert.equal(allow, true)
              prepares++
              events.push('verify')
              if (scenario === 'integrity')
                throw new ServerError('install_failed', 'Integrity mismatch.')
            },
            stopServer: async () => {
              stops++
              events.push('stop')
              return { stopped: true, message: '' }
            }
          })
      },
      { host: mockHost({ storage: { openmausbotInstallConsent: scenario !== 'no-consent' } }) }
    )
    try {
      await worker.request('status', {})
      await new Promise<void>((resolve) => setImmediate(resolve))
      await worker.request('status', {})
      await new Promise<void>((resolve) => setImmediate(resolve))
      const state = (await worker.request('status', {})) as any
      assert.equal(state.state, 'running')
      assert.equal(prepares, scenario === 'no-consent' ? 0 : 1)
      assert.equal(stops, scenario === 'success' ? 1 : 0)
      if (scenario === 'no-consent') assert.equal(state.needsInstall, true)
      if (scenario === 'integrity') assert.match(state.message, /Integrity mismatch/)
      if (scenario === 'success') assert.deepEqual(events, ['busy', 'verify', 'busy', 'stop'])
    } finally {
      await worker.deactivate()
    }
  }
})

test('an in-flight send prevents idle restart even before the server reports busy', async () => {
  let now = 0,
    stops = 0
  let finish!: () => void
  const botId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const worker = await mountWorker(
    {
      default: (orca) =>
        register(orca, {
          ...setupDeps(),
          now: () => now,
          claudeSetupStatus: async () => ({ restart: true, message: 'Apply setup.' }),
          rosterBusy: async () => false,
          listBots: async () => [{ id: botId, name: 'Bot', state: 'idle' } as any],
          sendMessage: async () => {
            await new Promise<void>((resolve) => {
              finish = resolve
            })
            return { sendId: 'fake-send-id-000000' }
          },
          stopServer: async () => {
            stops++
            return { stopped: false, message: '' }
          }
        })
    },
    { host: mockHost() }
  )
  try {
    await worker.request('status', {})
    await new Promise<void>((resolve) => setImmediate(resolve))
    await worker.request('bots.list', {})
    const sending = worker.request('message.send', { botId, text: 'Work' })
    await new Promise<void>((resolve) => setImmediate(resolve))
    await worker.request('status', {})
    assert.equal(stops, 0)
    finish()
    await sending
    now = 2000
    await worker.request('status', {})
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(stops, 1)
  } finally {
    finish?.()
    await worker.deactivate()
  }
})

test('bot actions validate payloads before dependencies and remove deleted bots from the worker roster', async () => {
  const botId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const actions: unknown[] = []
  const renames: unknown[] = []
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
          stopServer: async () => ({ stopped: true, message: '' }),
          openChat: async () => ({ message: '' }),
          readThread: async () => ({ messages: [], hasMore: false }),
          sendMessage: async () => ({ sendId: 'fake' }),
          addMausBot: async () => {},
          renameGroup: async (input) => { renames.push(input) },
          actOnBot: async (input) => {
            actions.push(input)
          },
          listBots: async () => [
            {
              id: botId,
              name: 'Bot',
              title: '',
              main: false,
              state: 'idle',
              unread: false,
              modelLabel: 'Codex'
            }
          ]
        })
    },
    { host: mockHost() }
  )
  try {
    await assert.rejects(worker.request('bots.act', { botId, action: 'delete' }), /not running/)
    await worker.request('status', {})
    await new Promise<void>((resolve) => setImmediate(resolve))
    await worker.request('bots.list', {})
    for (const name of ['', 'Pinned', 'x'.repeat(61)])
      await assert.rejects(worker.request('groups.rename', { section: 'Ops', name }))
    await worker.request('groups.rename', { section: 'Ops', name: ' Ops ' })
    assert.equal(renames.length, 0)
    await worker.request('groups.rename', { section: ' Ops ', name: ' New ', port: 9999 })
    assert.deepEqual(renames, [{ port: 18799, section: 'Ops', name: 'New' }])
    for (const input of [
      { action: 'pin', pinned: 'true' },
      { action: 'rename', name: ' ' },
      { action: 'rename', name: 'x'.repeat(81) },
      { action: 'group', section: 4 },
      { action: 'group', section: 'x'.repeat(61) },
      { action: 'unknown' }
    ])
      await assert.rejects(worker.request('bots.act', { botId, ...input }))
    await assert.rejects(
      worker.request('bots.act', { botId: 'invalid', action: 'delete' }),
      /Invalid bot ID/
    )
    assert.equal(actions.length, 0)
    await worker.request('bots.act', { botId, action: 'pin', pinned: true, port: 9999 })
    assert.deepEqual(actions, [{ botId, action: 'pin', pinned: true, port: 18799 }])
    await worker.request('bots.act', { botId, action: 'delete' })
    await assert.rejects(worker.request('thread.read', { botId }), /not in the roster/)
    await assert.rejects(
      worker.request('bots.act', { botId, action: 'delete' }),
      /not in the roster/
    )
    assert.equal(actions.length, 2)
  } finally {
    await worker.deactivate()
  }
})

test('corrupt preference files heal and failed background persistence never wedges status', async () => {
  const { fileHostPrefs } = await import('./host-prefs.ts')
  for (const corrupt of ['', '{']) {
    const files = new Map<string, string>([['/fake/preferences.json', corrupt]])
    let fail = false
    const prefs = fileHostPrefs('/fake/preferences.json', {
      readFileSync: (path) => files.get(String(path)) as never,
      mkdirSync: () => undefined,
      writeFileSync: (path, data) => {
        if (fail) throw new Error('private failure')
        files.set(String(path), String(data))
      },
      renameSync: (from, to) => {
        files.set(String(to), files.get(String(from))!)
        files.delete(String(from))
      },
      unlinkSync: (path) => {
        files.delete(String(path))
      }
    })
    const host = mockHost({
      settings: { shareClaudeSetup: true },
      storage: { setupAnswered: true }
    })
    const worker = await mountWorker(
      { default: (api) => register(api, { ...setupDeps(), hostPrefs: prefs }) },
      { host }
    )
    try {
      fail = true
      await worker.request('status', {})
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.equal(((await worker.request('status', {})) as any).state, 'running')
      await assert.rejects(
        worker.request('prefs.set', { linkAgents: true }),
        /Could not save bot permissions/
      )
      await assert.rejects(worker.request('server.install', {}), /Could not save bot permissions/)
      fail = false
      await worker.request('status', { retry: true })
      assert.equal(prefs.read()?.shareTools, true)
      assert.equal(prefs.read()?.stopped, false)
    } finally {
      await worker.deactivate()
    }
  }
})

test('restart uses persisted sync snapshot to distinguish native changes from remote changes', async () => {
  let shared = {
    shareTools: false,
    linkAgents: false,
    setupAnswered: true,
    installConsent: false,
    stopped: false
  }
  const prefs = {
    read: () => ({ ...shared }),
    write: (patch: object) => Object.assign(shared, patch)
  }
  const mount = async (data: any) => {
    const host = mockHost(data)
    const worker = await mountWorker(
      { default: (api) => register(api, { ...setupDeps(), hostPrefs: prefs }) },
      { host }
    )
    return { worker, host }
  }
  const first = await mount({})
  await first.worker.request('prefs.get', {})
  const saved = first.host.data()
  await first.worker.deactivate()
  // Native Settings was changed while the worker was closed.
  saved.settings.shareClaudeSetup = true
  const second = await mount(saved)
  assert.equal(((await second.worker.request('prefs.get', {})) as any).shareTools, true)
  assert.equal(shared.shareTools, true)
  const synced = second.host.data()
  await second.worker.deactivate()
  // Native Settings is unchanged; the remote choice must win on the next startup.
  shared.shareTools = false
  shared.linkAgents = true
  const third = await mount(synced)
  try {
    const result = (await third.worker.request('prefs.get', {})) as any
    assert.equal(result.shareTools, false)
    assert.equal(result.linkAgents, true)
    assert.equal((third.host.data().storage.syncedHostPrefs as any).linkAgents, true)
  } finally {
    await third.worker.deactivate()
  }
})

test('a stop persists across local and relay workers until explicit retry, installation, or import', async () => {
  let saved: any = { installConsent: true }
  let starts = 0
  const prefs = {
    read: () => ({ ...saved }),
    write: (patch: object) => Object.assign(saved, patch)
  }
  const mount = () =>
    mountWorker(
      {
        default: (api) =>
          register(api, {
            ...setupDeps(),
            hostPrefs: prefs,
            ensureServer: async () => {
              starts++
              return { port: 8799, version: testedVersion, started: true, startedByPlugin: true }
            },
            importTools: async () => ({ added: [], skipped: [] })
          })
      },
      { host: mockHost() }
    )
  const owner = await mount()
  await owner.request('status', {})
  await new Promise<void>((resolve) => setImmediate(resolve))
  const observer = await mount()
  await observer.request('status', {})
  await new Promise<void>((resolve) => setImmediate(resolve))
  await owner.request('server.stop', {})
  assert.equal(saved.stopped, true)
  assert.match(((await observer.request('status', {})) as any).message, /was stopped/)
  await observer.deactivate()
  await owner.deactivate()
  for (const resume of ['retry', 'server.install', 'tools.import']) {
    const next = await mount()
    try {
      const before = starts
      assert.match(((await next.request('status', {})) as any).message, /was stopped/)
      assert.equal(starts, before)
      if (resume === 'retry') await next.request('status', { retry: true })
      else await next.request(resume, {})
      await next.request('status', {})
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.equal(saved.stopped, false)
      assert.equal(starts, before + 1)
      await next.request('server.stop', {})
    } finally {
      await next.deactivate()
    }
  }
})

test('idle restart rechecks host state under the lifecycle lock and skips an upgrade another worker finished', async () => {
  let changed = false
  let stops = 0
  const worker = await mountWorker(
    {
      default: (api) =>
        register(api, {
          ...setupDeps(),
          ensureServer: async () => ({
            port: 8799,
            version: changed ? testedVersion : '0.1.158',
            started: false,
            startedByPlugin: true
          }),
          claudeSetupStatus: async () => ({ restart: !changed, updating: !changed, message: '' }),
          rosterBusy: async () => false,
          withLifecycle: async (operation) => {
            changed = true
            return operation()
          },
          stopServer: async () => {
            stops++
            return { stopped: true, message: '' }
          }
        })
    },
    { host: mockHost({ storage: { openmausbotInstallConsent: true } }) }
  )
  try {
    await worker.request('status', {})
    await new Promise<void>((resolve) => setImmediate(resolve))
    await worker.request('status', {})
    await new Promise<void>((resolve) => setImmediate(resolve))
    const status = (await worker.request('status', {})) as any
    assert.equal(status.state, 'running')
    assert.equal(status.version, testedVersion)
    assert.equal(stops, 0)
  } finally {
    await worker.deactivate()
  }
})

test('unchanged status and preference polls write no settings, storage, or host snapshots', async () => {
  const shared = {
    shareTools: false,
    linkAgents: false,
    setupAnswered: false,
    installConsent: false,
    stopped: false
  }
  const writes: string[] = []
  const worker = await mountWorker(
    {
      default: (api) =>
        register(
          {
            ...api,
            settings: {
              ...api.settings,
              set: async (key, value) => {
                writes.push(`settings:${key}`)
                await api.settings.set(key, value)
              }
            },
            storage: {
              ...api.storage,
              set: async (key, value) => {
                writes.push(`storage:${key}`)
                await api.storage.set(key, value)
              }
            }
          },
          {
            ...setupDeps(),
            hostPrefs: {
              read: () => ({ ...shared }),
              write: (patch) => {
                writes.push('host')
                return Object.assign(shared, patch)
              }
            }
          }
        )
    },
    { host: mockHost() }
  )
  try {
    await worker.request('prefs.get', {})
    assert.deepEqual(writes, ['storage:syncedHostPrefs'])
    writes.length = 0
    for (let i = 0; i < 3; i++) {
      await worker.request('status', {})
      await worker.request('prefs.get', {})
    }
    assert.deepEqual(writes, [])
    shared.linkAgents = true
    await worker.request('prefs.get', {})
    assert.deepEqual(writes, ['settings:linkAgents', 'storage:syncedHostPrefs'])
    writes.length = 0
    await worker.request('status', {})
    await worker.request('prefs.get', {})
    assert.deepEqual(writes, [])
  } finally {
    await worker.deactivate()
  }
})

test('lock contention during idle restart preserves running status and rechecks on the next poll', async () => {
  let attempts = 0
  let healthChecks = 0
  let busyRoster = false
  let updated = false
  let now = 10000
  const worker = await mountWorker(
    {
      default: (api) =>
        register(api, {
          ...setupDeps(),
          now: () => now,
          checkHealth: async () => {
            healthChecks++
            return true
          },
          ensureServer: async () => ({
            port: 8799,
            version: updated ? testedVersion : '0.1.158',
            started: false,
            startedByPlugin: true
          }),
          claudeSetupStatus: async () => ({ restart: !updated, updating: !updated, message: '' }),
          rosterBusy: async () => busyRoster,
          withLifecycle: async (operation) => {
            if (++attempts === 1) throw new ServerError('start_failed', 'Lock is busy', true)
            updated = true
            return operation()
          }
        })
    },
    { host: mockHost({ storage: { openmausbotInstallConsent: true } }) }
  )
  try {
    await worker.request('status', {})
    await new Promise<void>((resolve) => setImmediate(resolve))
    await worker.request('status', {})
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(attempts, 1)
    busyRoster = true
    const checkedBefore = healthChecks
    const restored = (await worker.request('status', {})) as any
    assert.equal(restored.state, 'running')
    assert.equal(healthChecks, checkedBefore + 1)
    busyRoster = false
    now += 2000
    await worker.request('status', {})
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(attempts, 2)
    assert.equal(((await worker.request('status', {})) as any).version, testedVersion)
  } finally {
    await worker.deactivate()
  }
})
