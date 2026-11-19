import { assert, test } from 'orca/testing'
import { HermesError, MAX_CONNECTIONS, createGateway } from './hermes-gateway.ts'
import type { GatewayDeps, Socket } from './hermes-gateway.ts'

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
function fake(options: { attachFails?: (profile: string, start: boolean) => Error | undefined; silent?: boolean } = {}) {
  const sockets: (Socket & { profile: string; sent: any[]; closed: boolean; emit(frame: unknown): void })[] = []
  const attaches: [string, boolean][] = []
  const timers: { run: () => void; ms: number }[] = []
  let clock = 0
  const deps: GatewayDeps = {
    attach: async (profile, start) => {
      attaches.push([profile, start])
      const problem = options.attachFails?.(profile, start)
      if (problem) throw problem
      return { url: `ws://127.0.0.1:9120/api/ws?${profile}`, protocols: ['hermes-gateway-v1', 'ticket-SECRET'] }
    },
    socket: (url) => {
      const socket: any = { profile: url.split('?')[1], sent: [], closed: false, onopen: null, onmessage: null, onclose: null, onerror: null }
      socket.send = (text: string) => {
        const frame = JSON.parse(text)
        socket.sent.push(frame)
        // Echo each request back as its answer unless the test answers by hand.
        if (!options.silent && frame.method) setImmediate(() => socket.emit({ jsonrpc: '2.0', id: frame.id, result: { method: frame.method, params: frame.params } }))
      }
      socket.close = () => {
        socket.closed = true
      }
      socket.emit = (frame: unknown) => socket.onmessage?.({ data: JSON.stringify(frame) })
      sockets.push(socket)
      setImmediate(() => socket.onopen?.({}))
      return socket
    },
    now: () => ++clock,
    setTimer: (run, ms) => {
      const timer = { run, ms }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer) => void timers.splice(timers.indexOf(timer as never), 1)
  }
  return { deps, sockets, attaches, timers }
}

test('each bot gets one connection of its own, reused across requests', async () => {
  const { deps, sockets, attaches } = fake()
  const gateway = createGateway(deps)
  assert.deepEqual(await gateway.request('honex', 'profiles.list', { a: 1 }), { method: 'profiles.list', params: { a: 1 } })
  await gateway.request('honex', 'ping')
  await gateway.request('default', 'ping')
  assert.deepEqual(attaches, [['honex', false], ['default', false]])
  assert.equal(sockets.length, 2)
  assert.equal(gateway.connected('honex'), true)
  await assert.rejects(gateway.request('../x', 'ping'), /Unknown bot/)
  gateway.close()
  assert.equal(sockets.every((s) => s.closed), true)
  assert.equal(gateway.connected('honex'), false)
})

test('refusals, timeouts and a dropped connection become fixed wording, and the next request reconnects', async () => {
  const { deps, sockets, timers } = fake({ silent: true })
  const gateway = createGateway(deps)
  const refused = gateway.request('honex', 'session.transcript', {})
  await flush()
  await flush()
  sockets[0].emit({ jsonrpc: '2.0', id: sockets[0].sent[0].id, error: { code: 4001, message: 'invalid_params', data: { detail: 'SECRET /Users/me' } } })
  await assert.rejects(refused, (error: unknown) => error instanceof HermesError && error.code === 'refused' && error.reason === 'invalid_params' && !/SECRET/.test(error.message))
  const slow = gateway.request('honex', 'ping', {}, 5000)
  await flush()
  assert.equal(timers.at(-1)!.ms, 5000)
  timers.at(-1)!.run()
  await assert.rejects(slow, /took too long/)
  const cut = gateway.request('honex', 'ping')
  await flush()
  sockets[0].onclose?.({})
  await assert.rejects(cut, /connection to Hermes closed/)
  assert.equal(gateway.connected('honex'), false)
  void gateway.request('honex', 'ping').catch(() => {})
  await flush()
  await flush()
  assert.equal(sockets.length, 2)
})

test('events reach listeners, and a question from Hermes is declined at once', async () => {
  const { deps, sockets } = fake()
  const gateway = createGateway(deps)
  const seen: unknown[] = []
  const stop = gateway.onEvent((profile, event) => seen.push([profile, event]))
  await gateway.request('honex', 'ping')
  sockets[0].emit({ jsonrpc: '2.0', method: 'event', params: { type: 'message.delta', session_id: 's1', payload: { text: 'hi' }, seq: 3 } })
  sockets[0].emit({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready' } })
  sockets[0].emit({ jsonrpc: '2.0', method: 'other', params: { type: 'x' } })
  sockets[0].onmessage?.({ data: 'not json' })
  assert.deepEqual(seen, [
    ['honex', { type: 'message.delta', sessionId: 's1', payload: { text: 'hi' } }],
    ['honex', { type: 'gateway.ready', sessionId: '', payload: {} }]
  ])
  sockets[0].emit({ jsonrpc: '2.0', id: 'srq-7', method: 'approval', params: { command: 'rm -rf build' } })
  assert.deepEqual(sockets[0].sent.at(-1), { jsonrpc: '2.0', id: 'srq-7', error: { code: -32601, message: 'not implemented' } })
  stop()
  sockets[0].emit({ jsonrpc: '2.0', method: 'event', params: { type: 'message.delta', session_id: 's1', payload: {} } })
  assert.equal(seen.length, 2)
})

test('a bot with no gateway yet gets one started once; a missing Hermes is said plainly', async () => {
  const starting = fake({ attachFails: (_p, start) => (start ? undefined : new HermesError('not_running', 'Hermes is not running. Open Hermes, then press Retry.')) })
  await createGateway(starting.deps).request('honex', 'ping')
  assert.deepEqual(starting.attaches, [['honex', false], ['honex', true]])
  const missing = fake({ attachFails: () => new HermesError('not_installed', 'Hermes is not installed on this computer. Install it, then press Retry.') })
  await assert.rejects(createGateway(missing.deps).request('honex', 'ping'), /not installed/)
  assert.deepEqual(missing.attaches, [['honex', false]])
})

test('the connection unused longest closes when there are too many', async () => {
  const { deps, sockets } = fake()
  const gateway = createGateway(deps)
  for (let i = 0; i <= MAX_CONNECTIONS; i++) await gateway.request(`bot-${i}`, 'ping')
  assert.equal(sockets.filter((s) => s.closed).map((s) => s.profile).join(), 'bot-0')
  assert.equal(gateway.connected(`bot-${MAX_CONNECTIONS}`), true)
})
