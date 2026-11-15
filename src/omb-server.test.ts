import { register } from './worker.ts'
import { openChat } from './omb-open.ts'
import type { CliDeps } from './omb-cli.ts'
import { assert, test, mockHost, mountWorker } from 'orca/testing'
import { checkNode, ensureInstalled, ensureServer, findServer, startServer, stopServer } from './omb-server.ts'
import type { ServerDeps } from './omb-server.ts'
import { TESTED_OPENMAUSBOT_VERSION as version, compareVersions } from '../shared/omb-version.ts'

function fake() {
  let time = 0
  const files = new Map<string, string>()
  const calls: { file: string; args: string[]; options: unknown }[] = []
  const signals: number[] = []
  const timers = new Set<() => void>()
  const deps: ServerDeps = {
    fetch: async () => { throw new Error('offline') },
    execFile: async (file, args, options) => {
      calls.push({ file, args, options })
      if (file === 'node') return 'v24.1.0\n'
      files.set(`/fake/.bot-deck/openmausbot/${version}/node_modules/.bin/openmausbot`, '')
      return ''
    },
    spawn: async (file, args, options) => {
      calls.push({ file, args, options })
      return { pid: 42, unref: () => { files.set('unref', 'yes') } }
    },
    exists: (path) => files.has(path),
    mkdir: (path) => { files.set(path, '') },
    open: (path) => {
      files.set(path, '')
      return 7
    },
    close: (fd) => { files.set('closed', String(fd)) },
    read: (path) => {
      if (!files.has(path)) throw new Error('missing')
      return files.get(path)!
    },
    write: (path, value) => { files.set(path, value) },
    remove: (path) => { files.delete(path) },
    kill: (pid) => { signals.push(pid) },
    processAlive: (pid) => pid === 42,
    portFree: async () => true,
    now: () => time,
    sleep: async (ms) => { time += ms },
    setTimer: (fn, ms) => {
      assert.ok(ms > 0 && ms <= 1500)
      timers.add(fn)
      return fn
    },
    clearTimer: (timer) => { timers.delete(timer as () => void) },
    home: '/fake',
    platform: 'darwin',
    env: { PATH: '/fake/bin' }
  }
  return { deps, files, calls, signals, timers }
}

function response(value: unknown) {
  return { ok: true, json: async () => value }
}

function healthy(pid = 43) {
  return response({ app: 'openmausbot', version, pid })
}

test('findServer returns undefined when all ports are offline', async () => {
  const { deps } = fake()
  assert.equal(await findServer(deps), undefined)
})

test('findServer skips a different application and uses ports in order', async () => {
  const { deps } = fake()
  const urls: string[] = []
  deps.fetch = async (url) => {
    urls.push(url)
    return url.includes(':8799/') ? response({ app: 'other', version }) : healthy()
  }
  assert.deepEqual(await findServer(deps), { port: 18799, version })
  assert.deepEqual(urls, ['http://127.0.0.1:8799/api/health', 'http://127.0.0.1:18799/api/health'])
})

test('findServer times out a slow port even when fetch ignores abort', async () => {
  const { deps, timers } = fake()
  let aborted = false
  deps.fetch = async (url, { signal }) => {
    if (!url.includes(':8799/')) return healthy()
    signal.addEventListener('abort', () => { aborted = true })
    queueMicrotask(() => { for (const fn of timers) fn() })
    return new Promise(() => {})
  }
  assert.deepEqual(await findServer(deps), { port: 18799, version })
  assert.equal(aborted, true)
  assert.equal(timers.size, 0)
})

test('checkNode reports missing and old Node', async () => {
  const { deps } = fake()
  deps.execFile = async () => { throw new Error('ENOENT') }
  await assert.rejects(checkNode(deps), /not found.*24/)
  deps.execFile = async () => 'v22.10.0'
  await assert.rejects(checkNode(deps), /too old.*24/)
})

test('checkNode uses PATH and appends known folders', async () => {
  const { deps, calls } = fake()
  assert.equal(await checkNode(deps), '24.1.0')
  assert.deepEqual(calls[0], {
    file: 'node', args: ['--version'], options: {
      env: { PATH: '/fake/bin:/opt/homebrew/bin:/usr/local/bin:/fake/.local/bin:/fake/.volta/bin' }, timeout: 10000
    }
  })
})

test('ensureInstalled skips an existing binary', async () => {
  const { deps, files, calls } = fake()
  const bin = `/fake/.bot-deck/openmausbot/${version}/node_modules/.bin/openmausbot`
  files.set(bin, '')
  assert.equal(await ensureInstalled(version, deps), bin)
  assert.equal(calls.length, 0)
})

test('ensureInstalled runs npm with exact args and a five minute limit', async () => {
  const { deps, calls } = fake()
  await ensureInstalled(version, deps)
  assert.equal(calls[0].file, 'npm')
  assert.deepEqual(calls[0].args, ['install', '--prefix', `/fake/.bot-deck/openmausbot/${version}`, '--no-audit', '--no-fund', `openmausbot@${version}`])
  assert.equal((calls[0].options as { timeout: number }).timeout, 300000)
})

test('failed installation preserves files and redacts tokens from last lines', async () => {
  const { deps, files } = fake()
  files.set('partial', 'keep')
  deps.execFile = async () => { throw new Error('old\n'.repeat(20) + 'npm_badsecret token=private Authorization: Bearer hidden') }
  await assert.rejects(ensureInstalled(version, deps), (error: Error) => {
    assert.match(error.message, /install.*OpenMausBot/)
    assert.doesNotMatch(error.message, /badsecret|private|hidden/)
    assert.match(error.message, /REDACTED/)
    return true
  })
  assert.equal(files.get('partial'), 'keep')
})

test('startServer detaches, truncates log, saves launcher and child pids and waits for health', async () => {
  const { deps, files, calls } = fake()
  files.set('/fake/.bot-deck/server.log', 'private pairing code')
  let checks = 0
  deps.fetch = async () => {
    checks++
    if (checks === 1) throw new Error('starting')
    return healthy()
  }
  assert.deepEqual(await startServer('/fake/bin/omb', 8799, deps), { port: 8799, version })
  assert.equal(checks, 2)
  assert.deepEqual(calls[0].args, ['serve', '--port', '8799', '--data-dir', '/fake/.bot-deck/data'])
  assert.equal(calls[0].file, '/fake/bin/omb')
  assert.equal((calls[0].options as { detached: boolean }).detached, true)
  assert.deepEqual((calls[0].options as { stdio: unknown }).stdio, ['ignore', 7, 7])
  assert.equal(files.get('/fake/.bot-deck/server.log'), '')
  assert.deepEqual(JSON.parse(files.get('/fake/.bot-deck/server.pid')!), { launcherPid: 42, serverPid: 43, port: 8799 })
  assert.equal(files.get('unref'), 'yes')
  assert.equal(files.get('closed'), '7')
})

test('startServer times out without reading the log or killing another process', async () => {
  const { deps, signals } = fake()
  deps.read = () => { throw new Error('must not read log') }
  await assert.rejects(startServer('/fake/bin/omb', 8799, deps), /30 seconds/)
  assert.deepEqual(signals, [])
})

test('ensureServer shares an in-flight attempt and prefers a running server', async () => {
  const { deps, calls } = fake()
  deps.fetch = async () => healthy()
  const first = ensureServer(deps)
  const second = ensureServer(deps)
  assert.equal(first, second)
  assert.deepEqual(await first, { port: 8799, version, started: false, startedByPlugin: false })
  assert.equal(calls.length, 0)
})

test('ensureServer skips occupied ports and installs and starts once', async () => {
  const { deps, calls } = fake()
  let launched = false
  const spawn = deps.spawn
  deps.spawn = async (...args) => {
    launched = true
    return spawn(...args)
  }
  deps.fetch = async () => {
    if (launched) return healthy()
    throw new Error('offline')
  }
  deps.portFree = async (port) => port === 18799
  const first = ensureServer(deps)
  assert.equal(first, ensureServer(deps))
  assert.deepEqual(await first, { port: 18799, version, started: true, startedByPlugin: true })
  assert.equal(calls.length, 3)
  assert.deepEqual(calls[2].args, ['serve', '--port', '18799', '--data-dir', '/fake/.bot-deck/data'])
})

test('stopServer refuses a pid mismatch and only signals a matching OpenMausBot', async () => {
  const { deps, files, signals } = fake()
  files.set('/fake/.bot-deck/server.pid', JSON.stringify({ port: 8799, launcherPid: 42, serverPid: 43 }))
  deps.fetch = async () => healthy(99)
  assert.equal((await stopServer(deps)).stopped, false)
  assert.deepEqual(signals, [])
  deps.fetch = async () => response({ app: 'other', version, pid: 42 })
  assert.equal((await stopServer(deps)).stopped, false)
  assert.deepEqual(signals, [])
  let checksAfterSignal = 0
  deps.fetch = async () => {
    if (signals.length) {
      checksAfterSignal++
      assert.equal(files.has('/fake/.bot-deck/server.pid'), true)
      if (checksAfterSignal === 2) throw new Error('stopped')
    }
    return healthy()
  }
  assert.equal((await stopServer(deps)).stopped, true)
  assert.equal(checksAfterSignal, 2)
  assert.deepEqual(signals, [42])
  assert.equal(files.has('/fake/.bot-deck/server.pid'), false)
})

test('numeric version comparison handles multi-digit parts and omitted zeros', () => {
  assert.equal(compareVersions('1.10', '1.9'), 1)
  assert.equal(compareVersions('1', '1.0.0'), 0)
  assert.equal(compareVersions('0.9', '1'), -1)
})


test('startup refuses health when its launcher has exited', async () => {
  const { deps, files } = fake()
  deps.fetch = async () => healthy()
  deps.processAlive = () => false
  await assert.rejects(startServer('/fake/bin/omb', 8799, deps), /launcher exited/)
  assert.equal(files.has('/fake/.bot-deck/server.pid'), false)
})

test('stop keeps the pid file if health continues after signaling the launcher', async () => {
  const { deps, files, signals } = fake()
  files.set('/fake/.bot-deck/server.pid', JSON.stringify({ launcherPid: 42, serverPid: 43, port: 8799 }))
  deps.fetch = async () => healthy()
  const result = await stopServer(deps)
  assert.equal(result.stopped, false)
  assert.match(result.message, /health is still responding/)
  assert.deepEqual(signals, [42])
  assert.equal(files.has('/fake/.bot-deck/server.pid'), true)
})

test('stop refuses a dead launcher and legacy pid records', async () => {
  const { deps, files, signals } = fake()
  files.set('/fake/.bot-deck/server.pid', JSON.stringify({ launcherPid: 42, serverPid: 43, port: 8799 }))
  deps.fetch = async () => healthy()
  deps.processAlive = () => false
  assert.equal((await stopServer(deps)).stopped, false)
  files.set('/fake/.bot-deck/server.pid', JSON.stringify({ pid: 42, port: 8799 }))
  assert.equal((await stopServer(deps)).stopped, false)
  assert.deepEqual(signals, [])
})

test('ensureServer reuses suffixed, unparseable and missing versions without spawning', async () => {
  for (const reported of ['0.2.0-beta.1', 'development', '', undefined]) {
    const { deps, calls } = fake()
    deps.fetch = async () => response({ app: 'openmausbot', version: reported, pid: 43 })
    assert.deepEqual(await ensureServer(deps), { port: 8799, version: reported || 'unknown', started: false, startedByPlugin: false })
    assert.equal(calls.length, 0)
  }
})

test('versions compare their numeric prefix and report unknown without one', () => {
  assert.equal(compareVersions('0.2.0-beta.1', '0.1.999'), 1)
  assert.equal(compareVersions('1.2.3-dev', '1.2.3'), 0)
  assert.equal(compareVersions('development', '1.2.3'), undefined)
  assert.equal(compareVersions('1.2.3', 'unknown'), undefined)
})

test('fresh workers recover pairing ownership only from a matching persisted server identity', async () => {
  for (const record of [undefined, { port: 8799, serverPid: 99 }, { port: 18799, serverPid: 43 }, { port: 8799, serverPid: 43 }]) {
    const { deps, files } = fake()
    deps.fetch = async () => healthy(43)
    if (record) files.set('/fake/.bot-deck/server.pid', JSON.stringify(record))
    const cliCalls: string[][] = []
    const cli: CliDeps = {
      home: '/fake', platform: 'darwin', env: {},
      exists: () => true,
      sleep: async () => {},
      execFile: async (_file, args) => {
        cliCalls.push(args)
        if (args[0] === 'snapshot') return 'button "Connect" [ref=e11]'
        if (args[0] === 'pair') return 'http://127.0.0.1:8799/pair#code=FAKE-ONLY'
        if (args[1] === 'list') return JSON.stringify({ ok: true, result: { tabs: [] } })
        return JSON.stringify({ ok: true, result: { browserPageId: 'fake-page' } })
      }
    }
    const worker = await mountWorker({ default: (orca) => register(orca, {
      ensureServer: () => ensureServer(deps),
      stopServer: async () => ({ stopped: false, message: 'Unused' }),
      openChat: (input) => openChat(input, cli),
      readThread: async () => ({ messages: [], hasMore: false }),
      sendMessage: async () => ({ sendId: 'fake-send-id-000000' }),
      listModels: async () => [],
      createBot: async () => { throw new Error('Unused') },
      setModel: async () => {},
      addMausBot: async () => {},
      listBots: async () => []
    }) }, { host: mockHost() })
    try {
      await worker.request('status', {})
      await new Promise<void>((resolve) => setImmediate(resolve))
      await worker.request('chat.open', {})
      const owned = record?.port === 8799 && record.serverPid === 43
      assert.equal(cliCalls.filter((args) => args[0] === 'pair').length, owned ? 1 : 0)
      await worker.request('chat.open', {})
      assert.equal(cliCalls.filter((args) => args[0] === 'pair').length, owned ? 2 : 0)
    } finally {
      await worker.deactivate()
    }
  }
})
