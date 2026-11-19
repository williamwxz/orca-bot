import { readFileSync } from 'node:fs'
import { register } from './worker.ts'
import { openChat } from './omb-open.ts'
import type { CliDeps } from './omb-cli.ts'
import { assert, test, mockHost, mountWorker } from 'orca/testing'
import {
  withServerLock,
  checkNode,
  validateInstallLock,
  ensureInstalled,
  ensureServer,
  findServer,
  startServer as actualStartServer,
  stopServer,
  serverHealthy,
  claudeSetupStatus
} from './omb-server.ts'
import type { ServerDeps } from './omb-server.ts'
import { TESTED_OPENMAUSBOT_VERSION as version, compareVersions } from '../shared/omb-version.ts'

function fake() {
  let time = 0
  const files = new Map<string, string>()
  const calls: { file: string; args: string[]; options: unknown }[] = []
  const signals: number[] = []
  const timers = new Set<() => void>()
  let unique = 0
  const deps: ServerDeps = {
    pid: 42,
    uniqueId: () => String(++unique),
    createExclusive: (path, content) => {
      if (files.has(path)) return false
      files.set(path, content)
      return true
    },
    modifiedAt: () => 0,
    fetch: async () => {
      throw new Error('offline')
    },
    execFile: async (file, args, options) => {
      calls.push({ file, args, options })
      if (file === 'node') return 'v24.1.0\n'
      files.set(`${args[args.indexOf('--prefix') + 1]}/node_modules/.bin/openmausbot`, '')
      return ''
    },
    spawn: async (file, args, options) => {
      calls.push({ file, args, options })
      return {
        pid: 42,
        unref: () => {
          files.set('unref', 'yes')
        }
      }
    },
    isDirectory: (path) => files.has(path),
    realpath: (path) => path,
    exists: (path) => files.has(path),
    mkdir: (path) => {
      files.set(path, '')
    },
    open: (path) => {
      files.set(path, '')
      return 7
    },
    close: (fd) => {
      files.set('closed', String(fd))
    },
    read: (path) => {
      if (!files.has(path)) throw new Error('missing')
      return files.get(path)!
    },
    write: (path, value) => {
      files.set(path, value)
    },
    remove: (path) => {
      files.delete(path)
    },
    installAsset: (name) =>
      readFileSync(new URL(`./install-assets/${name}`, import.meta.url), 'utf8'),
    removeTree: (path) => {
      for (const key of files.keys())
        if (key === path || key.startsWith(path + '/')) files.delete(key)
    },
    rename: (from, to) => {
      for (const [key, value] of [...files]) {
        if (key === from || key.startsWith(from + '/')) {
          files.set(to + key.slice(from.length), value)
          files.delete(key)
        }
      }
    },
    kill: (pid) => {
      signals.push(pid)
    },
    processAlive: (pid) => pid === 42,
    portFree: async () => true,
    now: () => time,
    sleep: async (ms) => {
      time += ms
    },
    setTimer: (fn, ms) => {
      assert.ok(ms > 0 && ms <= 1500)
      timers.add(fn)
      return fn
    },
    clearTimer: (timer) => {
      timers.delete(timer as () => void)
    },
    userInfo: () => ({ username: 'fake-user', shell: '/fake/shell' }),
    home: '/fake',
    platform: 'darwin',
    env: { PATH: '/fake/bin' }
  }
  return { deps, files, calls, signals, timers }
}

// Startup fixtures describe health after spawning. The preflight must see no server.
async function startServer(bin: string, port: number, deps: ServerDeps, share = false) {
  const fetch = deps.fetch
  const spawn = deps.spawn
  let spawned = false
  deps.fetch = async (...args) => {
    if (!spawned) throw new Error('not started')
    return fetch(...args)
  }
  deps.spawn = async (...args) => {
    spawned = true
    return spawn(...args)
  }
  try {
    return await actualStartServer(bin, port, deps, share)
  } finally {
    deps.fetch = fetch
    deps.spawn = spawn
  }
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
    signal.addEventListener('abort', () => {
      aborted = true
    })
    queueMicrotask(() => {
      for (const fn of timers) fn()
    })
    return new Promise(() => {})
  }
  assert.deepEqual(await findServer(deps), { port: 18799, version })
  assert.equal(aborted, true)
  assert.equal(timers.size, 0)
})

test('checkNode reports missing and old Node', async () => {
  const { deps } = fake()
  deps.execFile = async () => {
    throw new Error('ENOENT')
  }
  await assert.rejects(checkNode(deps), /not found.*24/)
  deps.execFile = async () => 'v22.10.0'
  await assert.rejects(checkNode(deps), /too old.*24/)
})

test('checkNode uses PATH and appends known folders', async () => {
  const { deps, calls } = fake()
  assert.equal(await checkNode(deps), '24.1.0')
  assert.deepEqual(calls[0], {
    file: 'node',
    args: ['--version'],
    options: {
      env: {
        USER: 'fake-user',
        LOGNAME: 'fake-user',
        SHELL: '/fake/shell',
        LANG: 'en_US.UTF-8',
        PATH: '/fake/bin:/opt/homebrew/bin:/usr/local/bin:/fake/.local/bin:/fake/.volta/bin'
      },
      timeout: 10000
    }
  })
})

test('ensureInstalled skips an existing binary', async () => {
  const { deps, files, calls } = fake()
  const bin = `/fake/.orca-bot/openmausbot/${version}/node_modules/.bin/openmausbot`
  files.set(bin, '')
  assert.equal(await ensureInstalled(version, deps, true), bin)
  assert.equal(calls.length, 0)
})

test('ensureInstalled runs npm with exact args and a five minute limit', async () => {
  const { deps, calls } = fake()
  await ensureInstalled(version, deps, true)
  assert.equal(calls[0].file, 'npm')
  assert.deepEqual(calls[0].args, [
    'ci',
    '--prefix',
    `/fake/.orca-bot/openmausbot/${version}.staging-42-2`,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--registry=https://registry.npmjs.org',
    '--cache',
    `/fake/.orca-bot/openmausbot/${version}.staging-42-2/.npm-cache`
  ])
  assert.equal((calls[0].options as { timeout: number }).timeout, 300000)
})

test('failed installation cleans staging, preserves unrelated files and hides subprocess output', async () => {
  const { deps, files } = fake()
  files.set('partial', 'keep')
  deps.execFile = async () => {
    throw new Error('old\n'.repeat(20) + 'npm_badsecret token=private Authorization: Bearer hidden')
  }
  await assert.rejects(ensureInstalled(version, deps, true), (error: Error) => {
    assert.match(error.message, /install.*OpenMausBot/)
    assert.doesNotMatch(error.message, /badsecret|private|hidden/)
    return true
  })
  assert.equal(files.get('partial'), 'keep')
})

test('startServer detaches, truncates log, saves launcher and child pids and waits for health', async () => {
  const { deps, files, calls } = fake()
  files.set('/fake/.orca-bot/server.log', 'private pairing code')
  let checks = 0
  deps.fetch = async () => {
    checks++
    if (checks === 1) throw new Error('starting')
    return healthy()
  }
  assert.deepEqual(await startServer('/fake/bin/omb', 8799, deps), { port: 8799, version })
  assert.equal(checks, 2)
  assert.deepEqual(calls[0].args, ['serve', '--port', '8799', '--data-dir', '/fake/.orca-bot/data'])
  assert.equal(calls[0].file, '/fake/bin/omb')
  assert.equal((calls[0].options as { detached: boolean }).detached, true)
  assert.equal((calls[0].options as any).env.OMB_CLAUDE_INHERIT_USER_CONFIG, undefined)
  assert.deepEqual((calls[0].options as { stdio: unknown }).stdio, ['ignore', 7, 7])
  assert.equal(files.get('/fake/.orca-bot/server.log'), '')
  assert.deepEqual(JSON.parse(files.get('/fake/.orca-bot/server.pid')!), {
    launcherPid: 42,
    serverPid: 43,
    port: 8799,
    claudeHome: false,
    inherit: false,
    env: 2
  })
  assert.equal(files.get('unref'), 'yes')
  assert.equal(files.get('closed'), '7')
})

test('startServer times out without reading the log or killing another process', async () => {
  const { deps, signals } = fake()
  deps.read = () => {
    throw new Error('must not read log')
  }
  await assert.rejects(startServer('/fake/bin/omb', 8799, deps), /30 seconds/)
  assert.deepEqual(signals, [])
})

test('ensureServer shares an in-flight attempt and prefers a running server', async () => {
  const { deps, calls } = fake()
  deps.fetch = async () => healthy()
  const first = ensureServer(deps, false, true)
  const second = ensureServer(deps, false, true)
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
  const first = ensureServer(deps, false, true)
  assert.equal(first, ensureServer(deps, false, true))
  assert.deepEqual(await first, { port: 18799, version, started: true, startedByPlugin: true })
  assert.equal(calls.length, 3)
  assert.deepEqual(calls[2].args, [
    'serve',
    '--port',
    '18799',
    '--data-dir',
    '/fake/.orca-bot/data'
  ])
})

test('stopServer refuses a pid mismatch and only signals a matching OpenMausBot', async () => {
  const { deps, files, signals } = fake()
  files.set(
    '/fake/.orca-bot/server.pid',
    JSON.stringify({ port: 8799, launcherPid: 42, serverPid: 43 })
  )
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
      assert.equal(files.has('/fake/.orca-bot/server.pid'), true)
      if (checksAfterSignal === 2) throw new Error('stopped')
    }
    return healthy()
  }
  assert.equal((await stopServer(deps)).stopped, true)
  assert.equal(checksAfterSignal, 2)
  assert.deepEqual(signals, [42])
  assert.equal(files.has('/fake/.orca-bot/server.pid'), false)
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
  assert.equal(files.has('/fake/.orca-bot/server.pid'), false)
})

test('stop keeps the pid file if health continues after signaling the launcher', async () => {
  const { deps, files, signals } = fake()
  files.set(
    '/fake/.orca-bot/server.pid',
    JSON.stringify({ launcherPid: 42, serverPid: 43, port: 8799 })
  )
  deps.fetch = async () => healthy()
  const result = await stopServer(deps)
  assert.equal(result.stopped, false)
  assert.match(result.message, /health is still responding/)
  assert.deepEqual(signals, [42])
  assert.equal(files.has('/fake/.orca-bot/server.pid'), true)
})

test('stop refuses a dead launcher and legacy pid records', async () => {
  const { deps, files, signals } = fake()
  files.set(
    '/fake/.orca-bot/server.pid',
    JSON.stringify({ launcherPid: 42, serverPid: 43, port: 8799 })
  )
  deps.fetch = async () => healthy()
  deps.processAlive = () => false
  assert.equal((await stopServer(deps)).stopped, false)
  files.set('/fake/.orca-bot/server.pid', JSON.stringify({ pid: 42, port: 8799 }))
  assert.equal((await stopServer(deps)).stopped, false)
  assert.deepEqual(signals, [])
})

test('ensureServer reuses suffixed, unparseable and missing versions without spawning', async () => {
  for (const reported of ['0.2.0-beta.1', 'development', '', undefined]) {
    const { deps, calls } = fake()
    deps.fetch = async () => response({ app: 'openmausbot', version: reported, pid: 43 })
    assert.deepEqual(await ensureServer(deps, false, true), {
      port: 8799,
      version: reported || 'unknown',
      started: false,
      startedByPlugin: false
    })
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
  for (const record of [
    undefined,
    { port: 8799, serverPid: 99 },
    { port: 18799, serverPid: 43 },
    { port: 8799, serverPid: 43 }
  ]) {
    const { deps, files } = fake()
    deps.fetch = async () => healthy(43)
    if (record) files.set('/fake/.orca-bot/server.pid', JSON.stringify(record))
    const cliCalls: string[][] = []
    const cli: CliDeps = {
      userInfo: () => ({ username: 'fake-user', shell: '/fake/shell' }),
      home: '/fake',
      platform: 'darwin',
      env: {},
      exists: () => true,
      sleep: async () => {},
      execFile: async (_file, args) => {
        cliCalls.push(args)
        if (args[0] === 'storage') return JSON.stringify({ ok: true, result: { value: null } })
        if (args[0] === 'snapshot') return 'button "Connect" [ref=e11]'
        if (args[0] === 'pair') return 'http://127.0.0.1:8799/pair#code=FAKE-ONLY'
        if (args[1] === 'list') return JSON.stringify({ ok: true, result: { tabs: [] } })
        return JSON.stringify({ ok: true, result: { browserPageId: 'fake-page' } })
      }
    }
    const worker = await mountWorker(
      {
        default: (orca) =>
          register(orca, {
            checkHealth: async () => true,
            now: () => 0,
            ensureServer: () => ensureServer(deps, false, true),
            stopServer: async () => ({ stopped: false, message: 'Unused' }),
            openChat: (input) => openChat(input, cli),
            readThread: async () => ({ messages: [], hasMore: false }),
            sendMessage: async () => ({ sendId: 'fake-send-id-000000' }),
            addMausBot: async () => {},
            listBots: async () => []
          })
      },
      { host: mockHost() }
    )
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

test('status health probe uses only the known port with a one second deadline', async () => {
  const { deps, timers } = fake()
  const urls: string[] = []
  const timer = deps.setTimer
  deps.setTimer = (fn, ms) => {
    assert.equal(ms, 1000)
    return timer(fn, ms)
  }
  deps.fetch = async (url) => {
    urls.push(url)
    return healthy()
  }
  assert.equal(await serverHealthy(18799, deps), true)
  assert.deepEqual(urls, ['http://127.0.0.1:18799/api/health'])
  deps.fetch = async () => {
    queueMicrotask(() => {
      for (const fn of timers) fn()
    })
    return new Promise(() => {})
  }
  assert.equal(await serverHealthy(18799, deps), false)
  assert.equal(timers.size, 0)
})

const profiles = '/fake/Library/Application Support/orca/claude-profiles'
const selectedHome = `${profiles}/fake-profile/home`
test('selected-host accepts only an absolute contained directory ending in home, with optional newline', async () => {
  for (const [selection, directory, accepted] of [
    [selectedHome, true, true],
    [selectedHome + '\n', true, true],
    [undefined, true, false],
    ['fake-profile/home', true, false],
    ['/elsewhere/home', true, false],
    [profiles + '-other/home', true, false],
    [profiles + '/fake-profile/config', true, false],
    [selectedHome, false, false],
    [profiles + '/../outside/home', true, false]
  ] as const) {
    const { deps, files, calls } = fake()
    if (selection !== undefined) files.set(`${profiles}/selected-host`, selection)
    deps.isDirectory = () => directory
    deps.fetch = async () => healthy()
    const reads: string[] = [],
      read = deps.read
    deps.read = (path) => {
      reads.push(path)
      return read(path)
    }
    const result = await startServer('/fake/bin/omb', 8799, deps)
    assert.equal(
      (calls[0].options as any).env.CLAUDE_CONFIG_DIR,
      accepted ? selectedHome : undefined
    )
    assert.deepEqual(reads, [`${profiles}/selected-host`, '/fake/.orca-bot/server.lock'])
    assert.equal(JSON.stringify(result).includes(selectedHome), false)
    assert.equal(files.get('/fake/.orca-bot/server.pid')!.includes(selectedHome), false)
  }
})

test('server environment and pid flags cover home, sharing and explicit config combinations', async () => {
  for (const found of [false, true])
    for (const share of [false, true])
      for (const preset of [false, true]) {
        const { deps, files, calls } = fake()
        if (found) {
          files.set(`${profiles}/selected-host`, selectedHome)
          files.set(selectedHome, '')
        }
        if (preset) deps.env.CLAUDE_CONFIG_DIR = '/explicit/config'
        deps.env.OMB_CLAUDE_INHERIT_USER_CONFIG = 'parent-value'
        deps.fetch = async () => healthy()
        await startServer('/fake/bin/omb', 8799, deps, share)
        assert.deepEqual((calls[0].options as any).env, {
          USER: 'fake-user',
          LOGNAME: 'fake-user',
          SHELL: '/fake/shell',
          LANG: 'en_US.UTF-8',
          PATH: '/fake/bin:/opt/homebrew/bin:/usr/local/bin:/fake/.local/bin:/fake/.volta/bin',
          ...(preset || found
            ? { CLAUDE_CONFIG_DIR: preset ? '/explicit/config' : selectedHome }
            : {}),
          ...(share ? { OMB_CLAUDE_INHERIT_USER_CONFIG: '1' } : {})
        })
        assert.deepEqual(JSON.parse(files.get('/fake/.orca-bot/server.pid')!), {
          launcherPid: 42,
          serverPid: 43,
          port: 8799,
          claudeHome: found || preset,
          inherit: share,
          env: 2
        })
        assert.equal((await claudeSetupStatus(8799, share, deps)).restart, false)
        assert.equal((await claudeSetupStatus(8799, !share, deps)).restart, true)
        assert.equal((await claudeSetupStatus(8799, share, deps)).message, '')
      }
})

test('cross-platform selected-host roots and symlink escape checks use injected filesystem only', async () => {
  for (const [platform, home, env, root] of [
    ['linux', '/fake', {}, '/fake/.config/orca/claude-profiles'],
    ['linux', '/fake', { XDG_CONFIG_HOME: '/custom' }, '/custom/orca/claude-profiles'],
    ['win32', 'C:\\fake', { APPDATA: 'C:\\roaming' }, 'C:\\roaming\\orca\\claude-profiles']
  ] as const) {
    const { deps, files, calls } = fake()
    Object.assign(deps, { platform, home, env })
    const sep = platform === 'win32' ? '\\' : '/'
    const selected = root + sep + 'profile' + sep + 'home'
    files.set(root + sep + 'selected-host', selected)
    files.set(selected, '')
    deps.fetch = async () => healthy()
    await startServer('/fake/bin/omb', 8799, deps)
    assert.equal((calls[0].options as any).env.CLAUDE_CONFIG_DIR, selected)
  }
  const { deps, files, calls } = fake()
  files.set(`${profiles}/selected-host`, selectedHome)
  files.set(selectedHome, '')
  deps.realpath = (path) => (path === selectedHome ? '/elsewhere/home' : path)
  deps.fetch = async () => healthy()
  await startServer('/fake/bin/omb', 8799, deps)
  assert.equal((calls[0].options as any).env.CLAUDE_CONFIG_DIR, undefined)
})

test('profile paths never reach errors, public results, pid records or plugin logs', async () => {
  const { deps, files } = fake()
  files.set(`${profiles}/selected-host`, selectedHome)
  files.set(selectedHome, '')
  deps.spawn = async () => {
    throw new Error(selectedHome)
  }
  const logs: unknown[] = []
  const methods = ['log', 'warn', 'error', 'info', 'debug'] as const
  const originals = methods.map((method) => console[method])
  for (const method of methods)
    console[method] = (...args) => {
      logs.push(args)
    }
  try {
    await assert.rejects(startServer('/fake/bin/omb', 8799, deps), (error: Error) => {
      assert.equal(String(error).includes(selectedHome), false)
      return true
    })
    deps.read = () => {
      throw new Error(selectedHome)
    }
    assert.deepEqual(await claudeSetupStatus(8799, true, deps), { restart: false, message: '' })
    assert.deepEqual(logs, [])
  } finally {
    methods.forEach((method, i) => {
      console[method] = originals[i]
    })
  }
})

test('legacy flags require restart only for an owned healthy server', async () => {
  const { deps, files } = fake()
  files.set(
    '/fake/.orca-bot/server.pid',
    JSON.stringify({ launcherPid: 42, serverPid: 43, port: 8799 })
  )
  deps.fetch = async () => healthy()
  assert.equal((await claudeSetupStatus(8799, true, deps)).restart, true)
  deps.fetch = async () => healthy(99)
  assert.deepEqual(await claudeSetupStatus(8799, true, deps), { restart: false, message: '' })
})

test('environment version migrates owned records once even when Claude flags match', async () => {
  const { deps, files } = fake()
  deps.fetch = async () => healthy()
  for (const env of [undefined, 1, 2, 3]) {
    files.set(
      '/fake/.orca-bot/server.pid',
      JSON.stringify({
        launcherPid: 42,
        serverPid: 43,
        port: 8799,
        claudeHome: false,
        inherit: true,
        env
      })
    )
    assert.equal((await claudeSetupStatus(8799, true, deps)).restart, env === undefined || env < 2)
  }
  await startServer('/fake/bin/omb', 8799, deps)
  const record = JSON.parse(files.get('/fake/.orca-bot/server.pid')!)
  assert.equal(record.env, 2)
  assert.doesNotMatch(JSON.stringify(record), /fake-user|fake\/shell|USER|LOGNAME|SHELL|LANG/)
  assert.equal((await claudeSetupStatus(8799, false, deps)).restart, false)
})

test('outdated owned server requests an idle update while unowned or newer servers do not', async () => {
  const { deps, files } = fake()
  files.set(
    '/fake/.orca-bot/server.pid',
    JSON.stringify({
      launcherPid: 42,
      serverPid: 43,
      port: 8799,
      claudeHome: false,
      inherit: false,
      env: 2
    })
  )
  deps.fetch = async () => response({ app: 'openmausbot', version: '0.1.158', pid: 43 })
  assert.deepEqual(await claudeSetupStatus(8799, false, deps), {
    restart: true,
    updating: true,
    message: `OpenMausBot will update to ${version} when bots are idle.`
  })
  deps.fetch = async () => response({ app: 'openmausbot', version: '0.1.158', pid: 99 })
  assert.deepEqual(await claudeSetupStatus(8799, false, deps), { restart: false, message: '' })
  deps.fetch = async () => response({ app: 'openmausbot', version: '99.0.0', pid: 43 })
  assert.deepEqual(await claudeSetupStatus(8799, false, deps), { restart: false, message: '' })
})

test('fresh status and direct install require consent before downloads or starting a process', async () => {
  const { deps, calls, files } = fake()
  await assert.rejects(ensureServer(deps), new RegExp(`Install openmausbot@${version}`))
  await assert.rejects(ensureInstalled(version, deps), /Install openmausbot/)
  assert.deepEqual(calls, [])
  assert.deepEqual([...files.keys()], ['/fake/.orca-bot'])
})

test('existing installations and unowned servers work without download consent', async () => {
  const { deps, calls, files } = fake()
  deps.fetch = async () => healthy(99)
  assert.equal((await ensureServer(deps)).startedByPlugin, false)
  assert.equal(calls.length, 0)
  const bin = `/fake/.orca-bot/openmausbot/${version}/node_modules/.bin/openmausbot`
  files.set(bin, '')
  assert.equal(await ensureInstalled(version, deps), bin)
  assert.equal(calls.length, 0)
})

test('committed lock pins every package with SHA-512 and rejects missing or altered pins', () => {
  const { deps } = fake()
  const pkg = deps.installAsset('package.json')
  const source = deps.installAsset('package-lock.json')
  validateInstallLock(pkg, source, version)
  const lock = JSON.parse(source)
  lock.packages['node_modules/openmausbot'].integrity = 'sha1-unverified'
  assert.throws(() => validateInstallLock(pkg, JSON.stringify(lock), version), /SHA-512/)
  lock.packages['node_modules/openmausbot'].version = '0.1.158'
  assert.throws(() => validateInstallLock(pkg, JSON.stringify(lock), version), /Invalid pinned/)
})

test('npm integrity mismatch refuses publication, cleans staging and never starts a child', async () => {
  const { deps, files, calls } = fake()
  deps.execFile = async () => {
    throw new Error('EINTEGRITY sha512 checksum mismatch')
  }
  await assert.rejects(ensureInstalled(version, deps, true), /integrity verification failed/)
  assert.equal(
    [...files.keys()].some((key) => key.includes('.staging')),
    false
  )
  assert.equal(
    files.has(`/fake/.orca-bot/openmausbot/${version}/node_modules/.bin/openmausbot`),
    false
  )
  assert.deepEqual(calls, [])
})

test('lifecycle locks wait for live owners, recover dead or truncated stale locks, and release on failure', async () => {
  const path = '/fake/.orca-bot/server.lock'
  const { deps, files } = fake()
  files.set(path, JSON.stringify({ pid: 99, createdAt: 0, token: 'other' }))
  deps.processAlive = (pid) => pid === 99
  let entered = false
  await assert.rejects(
    withServerLock(deps, async () => {
      entered = true
    }),
    /in progress/
  )
  assert.equal(entered, false)
  assert.ok(files.has(path))
  deps.processAlive = () => false
  await withServerLock(deps, async () => {
    assert.equal(JSON.parse(files.get(path)!).pid, 42)
    await withServerLock(deps, async () => {
      entered = true
    })
  })
  assert.equal(entered, true)
  assert.equal(files.has(path), false)
  files.set(path, '{')
  deps.modifiedAt = () => -40000
  await assert.rejects(
    withServerLock(deps, async () => {
      throw new Error('operation failed')
    }),
    /operation failed/
  )
  assert.equal(files.has(path), false)
})

test('a contender rechecks installation and server health after the other owner releases the lock', async () => {
  const { deps, files, calls } = fake()
  const lock = '/fake/.orca-bot/server.lock'
  const bin = `/fake/.orca-bot/openmausbot/${version}/node_modules/.bin/openmausbot`
  files.set(lock, JSON.stringify({ pid: 99, createdAt: 0, token: 'other' }))
  deps.processAlive = () => true
  const sleep = deps.sleep
  deps.sleep = async (ms) => {
    await sleep(ms)
    files.set(bin, '')
    files.delete(lock)
  }
  assert.equal(await ensureInstalled(version, deps, true), bin)
  assert.equal(calls.length, 0)
  files.set(lock, JSON.stringify({ pid: 99, createdAt: 0, token: 'other' }))
  deps.sleep = async (ms) => {
    await sleep(ms)
    deps.fetch = async () => healthy(99)
    files.delete(lock)
  }
  assert.equal((await ensureServer(deps)).started, false)
  assert.equal(calls.length, 0)
  assert.equal((await actualStartServer(bin, 8799, deps)).port, 8799)
  assert.equal(calls.length, 0)
})

test('installation cleans only dead-owner staging directories and respects persisted stop intent', async () => {
  const { deps, files } = fake()
  const root = '/fake/.orca-bot/openmausbot/'
  const dead = `${version}.staging-99-old`
  const live = `${version}.staging-42-live`
  files.set(root + dead, '')
  files.set(root + live, '')
  deps.readdir = () => [dead, live, 'unrelated', `${version}.staging`]
  await ensureInstalled(version, deps, true)
  assert.equal(files.has(root + dead), false)
  assert.equal(files.has(root + live), true)
  files.set('/fake/.orca-bot/preferences.json', '{"stopped":true}')
  await assert.rejects(ensureServer(deps), /was stopped/)
})

test('independent lifecycle callers serialize while nested operations reuse their own lock', async () => {
  const { deps, files } = fake()
  let releaseOwner!: () => void
  let releaseWaiter!: () => void
  const gate = new Promise<void>((resolve) => {
    releaseOwner = resolve
  })
  deps.sleep = async () =>
    new Promise<void>((resolve) => {
      releaseWaiter = resolve
    })
  deps.fetch = async () => healthy(99)
  const order: string[] = []
  const owner = withServerLock(deps, async () => {
    order.push('owner')
    await gate
    // An external ensureServer is already waiting: do not join its lock-blocked promise.
    await ensureServer(deps)
    order.push('nested')
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  const waiter = ensureServer(deps).then(() => {
    order.push('waiter')
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(order, ['owner'])
  releaseOwner()
  await owner
  assert.equal(files.has('/fake/.orca-bot/server.lock'), false)
  releaseWaiter()
  await waiter
  assert.deepEqual(order, ['owner', 'nested', 'waiter'])
})

test('live reused PIDs do not preserve locks older than fifteen minutes or a reboot', async () => {
  for (const mode of ['age', 'reboot', 'missing-timestamp']) {
    const { deps, files } = fake()
    const path = '/fake/.orca-bot/server.lock'
    deps.now = () => 2_000_000
    deps.processAlive = () => true
    const createdAt = mode === 'age' ? 2_000_000 - 15 * 60 * 1000 - 1 : 1_999_000
    if (mode === 'reboot') deps.uptimeMs = () => 500
    files.set(
      path,
      JSON.stringify({ pid: 99, ...(mode !== 'missing-timestamp' ? { createdAt } : {}) })
    )
    let entered = false
    await withServerLock(deps, async () => {
      entered = true
    })
    assert.equal(entered, true)
    assert.equal(files.has(path), false)
  }
})

test('a recent live lock reports typed contention rather than being stolen', async () => {
  const { deps, files } = fake()
  files.set('/fake/.orca-bot/server.lock', JSON.stringify({ pid: 99, createdAt: 0 }))
  deps.processAlive = () => true
  await assert.rejects(
    withServerLock(deps, async () => {}),
    (error: any) => error.state === 'start_failed' && error.busy === true
  )
  assert.ok(files.has('/fake/.orca-bot/server.lock'))
})
