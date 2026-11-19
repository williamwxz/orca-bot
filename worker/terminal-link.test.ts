import { renameGroup } from './omb-roster.ts'
import { HttpStatusError } from './omb-http.ts'
import { assert, test } from 'orca/testing'
import { gunzipSync } from 'node:zlib'
import { createRelay } from './relay-host.ts'
import { READY } from './relay-frames.ts'
import { createTerminalLink, loaderCommand, pluginBundle } from './terminal-link.ts'
import type { Bundle, LinkDeps, Saved } from './terminal-link.ts'

const host = { id: 'mini-1', name: 'Mac Mini' }
const bundle: Bundle = { hash: '0123456789abcdef', files: { 'worker/relay-host.ts': '// relay' } }

/** A paired server's Orca as the CLI sees it: terminals keep 2000 lines and lose some spaces. */
function fakeServer(
  handlers: Record<string, (input: any) => unknown>,
  options: { worktrees?: unknown[]; hosts?: string[] } = {}
) {
  const terminals = new Map<
    string,
    {
      lines: string[]
      dropped: number
      status: string
      feed?: (chunk: string) => void
      command: string
    }
  >()
  const calls: string[][] = []
  let count = 0
  const flag = (args: string[], name: string) => args[args.indexOf(name) + 1]
  const call = async (args: string[]): Promise<any> => {
    calls.push(args)
    assert.ok((options.hosts ?? [host.id]).includes(flag(args, '--environment')))
    const key = `${args[0]} ${args[1]}`
    if (key === 'worktree list')
      return { worktrees: options.worktrees ?? [{ id: 'repo::/Users/me', isMainWorktree: true }] }
    if (key === 'terminal create') {
      const handle = `term_${++count}`
      terminals.set(handle, {
        lines: ['me@mini ~ % node -e …', READY],
        dropped: 0,
        status: 'running',
        command: flag(args, '--command')
      })
      return { terminal: { handle } }
    }
    const terminal = terminals.get(flag(args, '--terminal'))
    if (!terminal) throw new Error('unknown terminal')
    const write = (text: string) => {
      for (const line of text.split('\r\n').filter(Boolean))
        terminal.lines.push(line.replace(/ /g, (space, at) => (at % 7 === 0 ? '' : space)))
      while (terminal.lines.length > 2000) {
        terminal.lines.shift()
        terminal.dropped++
      }
    }
    if (key === 'terminal send') {
      const text = `${flag(args, '--text')}\r`
      if (!terminal.feed) {
        // The loader's job: take the bundle, then hand the terminal to relay-host.ts.
        const received = JSON.parse(gunzipSync(Buffer.from(text.trim(), 'base64')).toString())
        assert.deepEqual(received, bundle)
        terminal.feed = createRelay(
          { hash: received.hash, write, load: () => undefined, save: () => {} },
          (api) => {
            for (const [name, handler] of Object.entries(handlers))
              api.panels.handle(name as never, handler as never)
          }
        )
      } else terminal.feed(text)
      await new Promise((resolve) => setImmediate(resolve))
      return { accepted: true }
    }
    if (key === 'terminal read') {
      const end = terminal.dropped + terminal.lines.length
      if (!args.includes('--cursor'))
        return {
          terminal: {
            status: terminal.status,
            tail: terminal.lines.slice(-1),
            latestCursor: String(end),
            nextCursor: String(end)
          }
        }
      const from = Number(flag(args, '--cursor')),
        limit = Number(flag(args, '--limit'))
      const start = Math.max(from, terminal.dropped)
      const tail = terminal.lines.slice(start - terminal.dropped, start - terminal.dropped + limit)
      return {
        terminal: {
          status: terminal.status,
          tail,
          truncated: from < terminal.dropped,
          nextCursor: String(start + tail.length)
        }
      }
    }
    if (key === 'terminal close') {
      terminal.status = 'exited'
      return { closed: true }
    }
    throw new Error(`unexpected ${key}`)
  }
  return { call, calls, terminals }
}

function linkDeps(
  server: ReturnType<typeof fakeServer>,
  store: { saved?: Saved } = {},
  timers: (() => void)[] = []
): LinkDeps {
  let clock = 0
  return {
    later: (_ms, fn) => {
      timers.push(fn)
      return () => {
        const at = timers.indexOf(fn)
        if (at >= 0) timers.splice(at, 1)
      }
    },
    call: server.call,
    bundle: async () => bundle,
    sleep: async (ms) => {
      clock += ms
    },
    now: () => clock,
    load: async () => store.saved,
    save: async (saved) => {
      store.saved = saved
    }
  }
}

test('requests reach the host worker through one terminal, with long messages and large replies intact', async () => {
  const sent: unknown[] = []
  const big = 'é'.repeat(16000)
  const server = fakeServer({
    status: () => ({ state: 'running', message: '', port: 8799 }),
    'message.send': (input) => {
      sent.push(input)
      return { sendId: 'remote-1' }
    },
    // Random-looking text gzip cannot shrink, so the reply spans several 400-line windows.
    'thread.read': () => ({
      messages: Array.from({ length: 2500 }, (_, i) => ({
        id: `m${i}`,
        text: `${(i * 7919) % 104729} ${Math.sin(i).toString(36)}`
      })),
      hasMore: false
    }),
    'bots.list': () => {
      throw new Error('OpenMausBot is not running yet.')
    }
  })
  const store: { saved?: Saved } = {}
  const link = createTerminalLink(linkDeps(server, store))
  assert.deepEqual(await link.request(host, 'status', {}), {
    state: 'running',
    message: '',
    port: 8799
  })
  assert.deepEqual(await link.request(host, 'message.send', { botId: 'b', text: big }), {
    sendId: 'remote-1'
  })
  assert.deepEqual(sent, [{ botId: 'b', text: big }])
  const thread = await link.request(host, 'thread.read', { botId: 'b' })
  assert.equal(thread.messages.length, 2500)
  assert.equal(thread.messages[2499].id, 'm2499')
  await assert.rejects(link.request(host, 'bots.list', {}), /not running yet/)
  // An answer from the host keeps the connection; only one terminal was ever opened.
  assert.equal(server.terminals.size, 1)
  assert.deepEqual(store.saved, { hostId: 'mini-1', handle: 'term_1' })
  // Nothing typed on the command line carries the message or the bundle.
  assert.ok(
    server.calls.filter((args) => args[1] !== 'send').every((args) => !args.join(' ').includes('é'))
  )
  await link.disconnect()
  assert.equal(server.terminals.get('term_1')!.status, 'exited')
  assert.equal(store.saved, undefined)
})

test('a restarted plugin reuses the open terminal, and replaces it when the code changed or it closed', async () => {
  const server = fakeServer({ status: () => ({ state: 'running', message: '' }) })
  const store: { saved?: Saved } = {}
  await createTerminalLink(linkDeps(server, store)).request(host, 'status', {})
  await createTerminalLink(linkDeps(server, store)).request(host, 'status', {})
  assert.equal(server.terminals.size, 1)
  server.terminals.get('term_1')!.status = 'exited'
  await createTerminalLink(linkDeps(server, store)).request(host, 'status', {})
  assert.equal(server.terminals.size, 2)
  assert.deepEqual(store.saved, { hostId: 'mini-1', handle: 'term_2' })
  const changed = {
    ...linkDeps(server, store),
    bundle: async () => ({ ...bundle, hash: 'fedcba9876543210' })
  }
  // The fake loader only accepts the original bundle, so a fresh terminal fails to start.
  await assert.rejects(
    createTerminalLink(changed).request(host, 'status', {}),
    /Could not start Bot Team for Orca on Mac Mini/
  )
  assert.equal(server.terminals.get('term_2')!.status, 'exited')
  assert.equal(server.terminals.get('term_3')!.status, 'exited')
})

test('a server without a project or without Node explains what to do and leaves no terminal behind', async () => {
  const empty = fakeServer({}, { worktrees: [] })
  await assert.rejects(
    createTerminalLink(linkDeps(empty)).request(host, 'status', {}),
    /Add a project to Orca on Mac Mini/
  )
  const noNode = fakeServer({})
  const deps = linkDeps(noNode)
  const call = deps.call
  deps.call = async (args) => {
    const result = await call(args)
    if (args[1] === 'create')
      noNode.terminals
        .get(result.terminal.handle)!
        .lines.splice(1, 1, 'zsh: command not found: node')
    return result
  }
  await assert.rejects(createTerminalLink(deps).request(host, 'status', {}), /Node.js 24 or newer/)
  assert.equal(noNode.terminals.get('term_1')!.status, 'exited')
})

test('the host refuses requests a paired client may not make', async () => {
  const server = fakeServer({
    'updates.install': () => ({ state: 'updated' }),
    'hosts.select': () => ({ selected: 'local' })
  })
  for (const forbidden of ['updates.install', 'hosts.select']) {
    await assert.rejects(
      createTerminalLink(linkDeps(server)).request(host, forbidden, {}),
      /Unsupported bot request/
    )
  }
})

test('the bundle is the worker and shared source without tests, and the loader is plain JavaScript in single quotes', async () => {
  const real = await pluginBundle()
  assert.match(real.hash, /^[0-9a-f]{16}$/)
  assert.ok(
    real.files['worker/relay-host.ts'] &&
      real.files['worker/worker.ts'] &&
      real.files['shared/roster.ts']
  )
  assert.ok(
    Object.keys(real.files).every(
      (name) => /^(worker|shared)\/[\w.-]+\.ts$/.test(name) && !name.endsWith('.test.ts')
    )
  )
  const command = loaderCommand()
  assert.match(command, /^ node -e '[^']+'$/)
  assert.doesNotMatch(command, /eval|\n/)
})

test('the server terminal closes after the link sits idle, and the next request opens a new one', async () => {
  const server = fakeServer({ status: () => ({ state: 'running', message: '' }) })
  const store: { saved?: Saved } = {}
  const timers: (() => void)[] = []
  const link = createTerminalLink(linkDeps(server, store, timers))
  await link.request(host, 'status', {})
  await link.request(host, 'status', {})
  await new Promise((resolve) => setImmediate(resolve))
  // Each request replaces the pending idle close, so only one is ever waiting.
  assert.equal(timers.length, 1)
  timers[0]()
  for (let i = 0; i < 20 && server.terminals.get('term_1')!.status !== 'exited'; i++)
    await new Promise((resolve) => setImmediate(resolve))
  assert.equal(server.terminals.get('term_1')!.status, 'exited')
  assert.equal(store.saved, undefined)
  await link.request(host, 'status', {})
  assert.equal(server.terminals.size, 2)
})

test('the link stays open until a running private desktop step ends, and keeps waiting through unanswered checks', async () => {
  // A replace is "remove" then "run" inside the host's worker: closing between them would
  // leave the desktop removed. The step finishes on the fourth check; one check goes unanswered.
  let checks = 0
  const server = fakeServer({
    status: () => ({ state: 'running', message: '' }),
    'desktop.step': () => {
      checks++
      return { step: { id: 1, action: 'recreate', running: checks < 4 } }
    }
  })
  // After the first check, one read of the terminal fails: that check goes unanswered.
  const deps = linkDeps(server)
  let dropped = false
  deps.call = async (args) => {
    if (checks === 1 && !dropped && args[0] === 'terminal' && args[1] === 'read' && args.includes('--cursor')) {
      dropped = true
      throw new Error('connection reset')
    }
    return server.call(args)
  }
  const link = createTerminalLink(deps)
  await link.request(host, 'status', {})
  await link.disconnect()
  assert.ok(dropped)
  assert.equal(checks, 4)
  assert.equal(server.terminals.get('term_1')!.status, 'exited')
  // A host whose worker has no job request (an older version) closes without waiting.
  const plain = fakeServer({ status: () => ({ state: 'running', message: '' }) })
  const other = createTerminalLink(linkDeps(plain))
  await other.request(host, 'status', {})
  await other.disconnect()
  assert.equal(plain.terminals.get('term_1')!.status, 'exited')
})

test('switching to another paired host answers at once while the first host finishes its desktop step', async () => {
  const hostB = { id: 'mini-2', name: 'Mac Studio' }
  let release!: () => void
  let running = true
  const server = fakeServer(
    {
      status: () => ({ state: 'running', message: '' }),
      'desktop.step': () => ({ step: { id: 1, action: 'prepare', running } })
    },
    { hosts: [host.id, hostB.id] }
  )
  const timers: (() => void)[] = []
  const deps = linkDeps(server, {}, timers)
  // Waiting between job checks parks until the test releases it.
  deps.sleep = () => new Promise<void>((resolve) => { release = () => { running = false; resolve() } })
  const link = createTerminalLink(deps)
  await link.request(host, 'status', {})
  assert.deepEqual(await link.request(hostB, 'status', {}), { state: 'running', message: '' })
  assert.equal(server.terminals.get('term_1')!.status, 'running', 'host A is still finishing')
  assert.equal(server.terminals.get('term_2')!.status, 'running')
  release()
  for (let i = 0; i < 20 && server.terminals.get('term_1')!.status !== 'exited'; i++)
    await new Promise((resolve) => setImmediate(resolve))
  assert.equal(server.terminals.get('term_1')!.status, 'exited')
})

test('a terminal whose worker stops answering mid-step is left running, never closed on a guess', async () => {
  const server = fakeServer({
    status: () => ({ state: 'running', message: '' }),
    'desktop.step': () => ({ step: { id: 1, action: 'recreate', running: true } })
  })
  const deps = linkDeps(server)
  let failing = false
  deps.call = async (args) => {
    // Every read of the answer fails, but the terminal itself is still running.
    if (failing && args[0] === 'terminal' && args[1] === 'read' && args.includes('--cursor')) throw new Error('read failed')
    return server.call(args)
  }
  const link = createTerminalLink(deps)
  await link.request(host, 'status', {})
  failing = true
  await link.disconnect()
  assert.equal(server.terminals.get('term_1')!.status, 'running')
  assert.equal(server.calls.some((args) => args[0] === 'terminal' && args[1] === 'close'), false)
})

test('returning to a host before its desktop step ends takes back the same terminal and job', async () => {
  const hostB = { id: 'mini-2', name: 'Mac Studio' }
  let running = true
  const server = fakeServer(
    {
      status: () => ({ state: 'running', message: '' }),
      'desktop.step': () => ({ step: { id: 1, action: 'prepare', running } })
    },
    { hosts: [host.id, hostB.id] }
  )
  const store: { saved?: Saved } = {}
  const deps = linkDeps(server, store)
  let parked: (() => void)[] = []
  deps.sleep = () => new Promise<void>((resolve) => parked.push(resolve))
  const flushAll = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)) }
  const link = createTerminalLink(deps)
  // A → This computer → A.
  await link.request(host, 'status', {})
  void link.disconnect()
  await flushAll()
  await link.request(host, 'status', {})
  assert.equal(server.terminals.size, 1, 'no second terminal on A')
  for (const wake of parked.splice(0)) wake()
  await flushAll()
  assert.equal(server.terminals.get('term_1')!.status, 'running', 'the old retirement does not close the reclaimed terminal')
  // A → B → A: B gets its own terminal; A is taken back, and saved as the current one again.
  await link.request(hostB, 'status', {})
  await flushAll()
  assert.equal(server.terminals.get('term_2')!.status, 'running')
  assert.equal(store.saved?.hostId, hostB.id)
  await link.request(host, 'status', {})
  assert.equal(store.saved?.handle, 'term_1')
  assert.equal(server.terminals.get('term_1')!.status, 'running')
  // When A's step ends and the link lets A go, it closes.
  running = false
  void link.disconnect()
  await flushAll()
  for (const wake of parked.splice(0)) wake()
  await flushAll()
  assert.equal(server.terminals.get('term_1')!.status, 'exited')
})

test('paired launcher detaches with fake process dependencies and validates the returned pid', async () => {
  const { EventEmitter } = await import('node:events')
  const { orphanSpawn } = await import('./relay-host.ts')
  for (const output of ['42', 'invalid']) {
    const calls: unknown[][] = []
    const launch = (...args: unknown[]) => {
      calls.push(args)
      const shell = new EventEmitter()
      const stdout = Object.assign(new EventEmitter(), {
        setEncoding() {
          return this
        }
      })
      queueMicrotask(() => {
        stdout.emit('data', output)
        shell.emit('close', 0)
      })
      return Object.assign(shell, { stdout })
    }
    const result = orphanSpawn(
      '/fake/openmausbot',
      ['serve'],
      {
        env: { PATH: '/fake/bin' },
        stdio: ['ignore', 7, 7]
      },
      launch as any
    )
    if (output === '42') assert.equal((await result).pid, 42)
    else await assert.rejects(result, /Could not start/)
    assert.equal(calls[0][0], '/bin/sh')
    assert.match((calls[0][1] as string[])[1], /& echo \$!$/)
    assert.deepEqual(calls[0][2], {
      env: { PATH: '/fake/bin' },
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore', 7]
    })
  }
})

test('MCP menu requests and busy failures traverse paired terminal relay unchanged', async () => {
  const rows = { connectors: [{ name: 'mail', rawName: 'mail', provider: 'Cursor', enabled: true, present: true, bots: [] }], bots: [{ id: 'a', name: 'Work' }] }
  const actions: unknown[] = []
  const server = fakeServer({
    'mcp.list': () => rows,
    'mcp.act': input => {
      actions.push(input)
      if (input.action === 'assign') throw new Error('A bot is currently working. Retry once all bots are idle.')
      return rows
    }
  })
  const link = createTerminalLink(linkDeps(server))
  assert.deepEqual(await link.request(host, 'mcp.list', {}), rows)
  const action = { action: 'group', provider: 'Cursor', enabled: true }
  assert.deepEqual(await link.request(host, 'mcp.act', action), rows)
  assert.deepEqual(actions, [action])
  await assert.rejects(link.request(host, 'mcp.act', { action: 'assign', name: 'mail', bots: ['a'] }), /currently working/)
})

test('MCP actions have headroom beyond the ordinary 30 second relay timeout', async () => {
  let finish: ((value: unknown) => void) | undefined
  const server = fakeServer({ 'mcp.act': () => new Promise(resolve => { finish = resolve }) })
  const deps = linkDeps(server)
  let clock = 0
  deps.now = () => clock
  deps.sleep = async ms => {
    clock += ms
    if (clock > 35000 && finish) { finish({ connectors: [], bots: [] }); finish = undefined }
  }
  const link = createTerminalLink(deps)
  assert.deepEqual(await link.request(host, 'mcp.act', { action: 'group', provider: 'Cursor', targets: [], enabled: true }), { connectors: [], bots: [] })
  assert.ok(clock > 30000)
})

test('group rename crosses terminal relay and preserves server refusal messages', async () => {
  const calls: unknown[] = []
  let status = 200
  const server = fakeServer({
    'groups.rename': async (input) => {
      await renameGroup({ ...input, port: 18799 }, {
        avatar: async () => undefined,
        request: async (...args) => {
          calls.push(args)
          if (status !== 200) throw new HttpStatusError(status)
          return { sections: ['New'] }
        }
      })
      return { ok: true }
    }
  })
  const link = createTerminalLink(linkDeps(server))
  try {
    assert.deepEqual(await link.request(host, 'groups.rename', { section: 'R&D', name: 'New' }), { ok: true })
    assert.deepEqual(calls[0], [18799, '/api/sidebar-sections?section=R%26D', { name: 'New' }, 'PATCH'])
    status = 404
    await assert.rejects(link.request(host, 'groups.rename', { section: 'Ops', name: 'New' }), /no longer exists/)
    status = 409
    await assert.rejects(link.request(host, 'groups.rename', { section: 'Ops', name: 'New' }), /refused.*busy/)
  } finally { await link.disconnect() }
})

test('models and thread-aware model actions traverse the paired relay with validation and safe refusals', async () => {
  const groups = { groups: [{ instanceId: 'claude.work', label: 'Claude Work', models: [{ id: 'anthropic/sonnet', label: 'Sonnet' }] }] }
  const actions: unknown[] = []
  const server = fakeServer({ 'models.list': () => groups, 'bots.act': input => {
    actions.push(input)
    if (input.model === 'busy') throw new Error('This bot is busy. Wait until it finishes.')
    return { ok: true }
  } })
  const link = createTerminalLink(linkDeps(server))
  try {
    assert.deepEqual(await link.request(host, 'models.list', {}), groups)
    const input = { botId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', action: 'model', instanceId: 'claude.work', model: 'anthropic/sonnet' }
    assert.deepEqual(await link.request(host, 'bots.act', input), { ok: true })
    assert.deepEqual(actions, [input])
    await assert.rejects(link.request(host, 'bots.act', { ...input, instanceId: '../bad' }), /valid provider/)
    assert.equal(actions.length, 1)
    await assert.rejects(link.request(host, 'bots.act', { ...input, model: 'busy' }), /busy/)
  } finally { await link.disconnect() }
})
