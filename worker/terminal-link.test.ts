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
  options: { worktrees?: unknown[] } = {}
) {
  const terminals = new Map<
    string,
    { lines: string[]; dropped: number; status: string; feed?: (chunk: string) => void; command: string }
  >()
  const calls: string[][] = []
  let count = 0
  const flag = (args: string[], name: string) => args[args.indexOf(name) + 1]
  const call = async (args: string[]): Promise<any> => {
    calls.push(args)
    assert.equal(flag(args, '--environment'), host.id)
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
  assert.deepEqual(await link.request(host, 'status', {}), { state: 'running', message: '', port: 8799 })
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
      noNode.terminals.get(result.terminal.handle)!.lines.splice(1, 1, 'zsh: command not found: node')
    return result
  }
  await assert.rejects(createTerminalLink(deps).request(host, 'status', {}), /Node.js 24 or newer/)
  assert.equal(noNode.terminals.get('term_1')!.status, 'exited')
})

test('the host refuses requests a paired client may not make', async () => {
  const server = fakeServer({ 'server.stop': () => ({ stopped: true }) })
  await assert.rejects(
    createTerminalLink(linkDeps(server)).request(host, 'server.stop', {}),
    /Unsupported bot request/
  )
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
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(server.terminals.get('term_1')!.status, 'exited')
  assert.equal(store.saved, undefined)
  await link.request(host, 'status', {})
  assert.equal(server.terminals.size, 2)
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
