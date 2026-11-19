import { assert, test } from 'orca/testing'
import { BOT_CHAT, createHermes } from './hermes.ts'
import { HermesError } from './hermes-gateway.ts'
import type { Gateway, GatewayEvent } from './hermes-gateway.ts'
import { register } from './worker.ts'

type Call = { profile: string; method: string; params: any }
function fake(answer: (call: Call) => unknown) {
  const calls: Call[] = []
  const listeners: ((profile: string, event: GatewayEvent) => void)[] = []
  const drops: ((profile: string) => void)[] = []
  const held: string[] = []
  let clock = 1000
  let ids = 0
  const gateway = {
    request: async (profile: string, method: string, params: any = {}) => {
      const call = { profile, method, params }
      calls.push(call)
      const value = answer(call)
      if (value instanceof Error) throw value
      return value
    },
    connected: () => true,
    onEvent: (listener: (profile: string, event: GatewayEvent) => void) => {
      listeners.push(listener)
      return () => {}
    },
    onDrop: (listener: (profile: string) => void) => {
      drops.push(listener)
      return () => {}
    },
    hold: (profile: string) => void held.push(profile),
    close: () => {}
  } as unknown as Gateway
  const hermes = createHermes({ gateway, now: () => clock, id: () => `id-${++ids}`, wait: (_ms, done) => void setImmediate(done) })
  const emit = (profile: string, type: string, sessionId: string, payload: Record<string, any> = {}) => listeners.forEach((l) => l(profile, { type, sessionId, payload }))
  return { hermes, calls, emit, held, drop: (profile: string) => drops.forEach((l) => l(profile)), tick: (ms: number) => (clock += ms) }
}
const rows = [
  { role: 'user', row_kind: 'message', text: 'hi', row_id: 1, timestamp: 10 },
  { role: 'assistant', row_kind: 'message', text: 'hello', row_id: 2, timestamp: 11 }
]
/** A Hermes with two bots; `honex` has a Bot Chat, `fresh` has none yet. */
const standard = (call: Call): unknown => {
  if (call.method === 'profiles.list' && call.profile === 'default' && !call.params.include_sessions)
    return { profiles: [{ name: 'default', is_default: true, path: '/SECRET' }, { name: 'honex', path: '/SECRET' }, { name: 'fresh', path: '/SECRET' }, { name: 'Bad Name' }] }
  if (call.method === 'profiles.list')
    return { profiles: [{ name: call.profile, is_default: call.profile === 'default', model: `${call.profile}-model`, canonical_session: call.profile === 'honex' ? { id: 'chat-honex', preview: 'last line', last_active: 50 } : null }] }
  if (call.method === 'session.list') return { sessions: call.profile === 'honex' ? [{ id: 'chat-honex' }] : [] }
  if (call.method === 'session.resume') return { session_id: `live-${call.params.session_id}`, running: false }
  if (call.method === 'session.transcript') return { rows, next_cursor: call.params.cursor ? null : 'cursor-1', reset: true }
  if (call.method === 'session.create') return { session_id: 'live-new', stored_session_id: 'chat-new' }
  if (call.method === 'session.title') return { ok: true }
  if (call.method === 'prompt.submit') return { status: 'queued' }
  return new HermesError('refused', 'Hermes refused this request.', 'unknown_method')
}

test('the roster asks each bot on its own connection, then reuses the answer for a while', async () => {
  const { hermes, calls, tick } = fake(standard)
  const bots = await hermes.listBots()
  assert.deepEqual(bots, [
    { id: 'honex', name: 'Honex', model: 'honex-model', preview: 'last line', lastActive: 50000, working: false },
    { id: 'default', name: 'Hermes', model: 'default-model', preview: '', lastActive: 0, working: false },
    { id: 'fresh', name: 'Fresh', model: 'fresh-model', preview: '', lastActive: 0, working: false }
  ])
  assert.doesNotMatch(JSON.stringify(bots), /SECRET/)
  assert.deepEqual(calls.filter((c) => c.params.include_sessions).map((c) => c.profile).sort(), ['default', 'fresh', 'honex'])
  const before = calls.length
  await hermes.listBots()
  assert.equal(calls.length, before + 1)
  // Bots nobody has open are asked again only after a minute.
  tick(9000)
  await hermes.listBots()
  assert.equal(calls.length, before + 2)
  tick(60000)
  await hermes.listBots()
  assert.equal(calls.length, before + 3 + 3)
  assert.deepEqual(await hermes.status(), { state: 'running', message: '' })
})

test('a bot whose own connection fails still shows; Hermes being down is reported as unavailable', async () => {
  const flaky = fake((call) => (call.profile === 'honex' && call.method === 'profiles.list' ? new HermesError('closed', 'x') : standard(call)))
  assert.deepEqual((await flaky.hermes.listBots()).map((b) => [b.id, b.model]), [['default', 'default-model'], ['honex', ''], ['fresh', 'fresh-model']])
  const down = fake(() => new HermesError('not_running', 'Hermes is not running. Open Hermes, then press Retry.'))
  assert.deepEqual(await down.hermes.status(), { state: 'unavailable', message: 'Hermes is not running. Open Hermes, then press Retry.' })
  const odd = fake(() => new Error('ECONNREFUSED /Users/SECRET'))
  assert.deepEqual(await odd.hermes.status(), { state: 'unavailable', message: 'Could not reach Hermes. Press Retry.' })
})

test('a chat reads newest first by page, older pages by cursor, and a bot with no chat reads empty', async () => {
  const { hermes, calls } = fake(standard)
  const page = await hermes.readThread({ botId: 'honex', limit: 500 })
  assert.deepEqual(page.messages.map((m) => `${m.role}:${m.text}`), ['user:hi', 'bot:hello'])
  assert.equal(page.older, 'cursor-1')
  assert.equal(page.live, undefined)
  const transcript = calls.find((c) => c.method === 'session.transcript')!
  assert.deepEqual(transcript.params, { profile: 'honex', session_id: 'chat-honex', order: 'latest', limit: 200 })
  assert.equal(calls.find((c) => c.method === 'session.list')!.params.title, BOT_CHAT)
  const older = await hermes.readThread({ botId: 'honex', older: 'cursor-1' })
  assert.equal(older.older, undefined)
  assert.equal(calls.at(-1)!.params.cursor, 'cursor-1')
  // Reading history neither attaches again nor creates anything.
  assert.equal(calls.filter((c) => c.method === 'session.resume').length, 1)
  assert.deepEqual(await hermes.readThread({ botId: 'fresh' }), { messages: [] })
  assert.equal(calls.some((c) => c.method === 'session.create'), false)
  for (const bad of [{ botId: '../x' }, { botId: 7 }, { botId: 'honex', older: 'a b' }, { botId: 'honex', older: 5 }])
    await assert.rejects(hermes.readThread(bad as never))
})

test('the reply shows while it is written and leaves when it is stored', async () => {
  const { hermes, calls, emit, drop, held } = fake(standard)
  await hermes.readThread({ botId: 'honex' })
  emit('honex', 'message.start', 'live-chat-honex')
  emit('honex', 'message.delta', 'live-chat-honex', { text: 'Hel' })
  emit('honex', 'message.delta', 'live-chat-honex', { text: null })
  emit('honex', 'message.delta', 'live-chat-honex', { text: 'lo' })
  emit('honex', 'tool.start', 'live-chat-honex', { name: 'terminal', context: 'cat ~/.ssh/id_rsa' })
  // Another bot's event with the same session ID, or an unknown session, changes nothing.
  emit('fresh', 'message.delta', 'live-chat-honex', { text: 'X' })
  emit('honex', 'message.delta', 'someone-else', { text: 'X' })
  assert.deepEqual((await hermes.readThread({ botId: 'honex' })).live, { text: 'Hello', startedAt: 1000, tool: 'Used terminal' })
  assert.deepEqual(held, ['honex'])
  assert.equal((await hermes.listBots()).find((b) => b.id === 'honex')!.working, true)
  emit('honex', 'tool.complete', 'live-chat-honex')
  assert.equal((await hermes.readThread({ botId: 'honex' })).live!.tool, undefined)
  emit('honex', 'message.complete', 'live-chat-honex', { text: 'Hello' })
  assert.equal((await hermes.readThread({ botId: 'honex' })).live, undefined)
  // A dropped connection can no longer say the reply ended: it is not left "working" forever.
  // Its live ID is forgotten too, so the next read attaches again on the new connection.
  emit('honex', 'message.start', 'live-chat-honex')
  drop('honex')
  assert.equal((await hermes.listBots()).find((b) => b.id === 'honex')!.working, false)
  const resumes = () => calls.filter((c) => c.method === 'session.resume').length
  const before = resumes()
  await hermes.readThread({ botId: 'honex' })
  assert.equal(resumes(), before + 1)
})

test('attaching picks up a reply already in progress', async () => {
  const { hermes } = fake((call) => (call.method === 'session.resume' ? { session_id: 'live-1', running: true, turn_started_at: 2, inflight: { assistant: 'so far' } } : standard(call)))
  assert.deepEqual((await hermes.readThread({ botId: 'honex' })).live, { text: 'so far', startedAt: 2000 })
})

test('sending goes to the Bot Chat, creating it hidden on first use', async () => {
  const { hermes, calls } = fake(standard)
  assert.deepEqual(await hermes.send({ botId: 'honex', text: '  hello  ' }), { ok: true })
  assert.deepEqual(calls.at(-1), { profile: 'honex', method: 'prompt.submit', params: { session_id: 'live-chat-honex', profile: 'honex', text: 'hello', input_id: 'id-1' } })
  assert.equal(calls.some((c) => c.method === 'session.create'), false)
  assert.notEqual((await hermes.readThread({ botId: 'honex' })).live, undefined)
  await hermes.send({ botId: 'fresh', text: 'first' })
  assert.deepEqual(calls.find((c) => c.method === 'session.create'), { profile: 'fresh', method: 'session.create', params: { profile: 'fresh', title: 'Bot Chat', hidden: true, follow_profile_config: true, source: 'gui', request_id: 'id-2' } })
  assert.deepEqual(calls.find((c) => c.method === 'session.title'), { profile: 'fresh', method: 'session.title', params: { session_id: 'live-new', title: 'Bot Chat' } })
  assert.equal(calls.at(-1)!.params.session_id, 'live-new')
  for (const bad of [{ botId: 'honex', text: '   ' }, { botId: 'honex', text: 'x'.repeat(16001) }, { botId: 'honex', text: 5 }, { botId: 'BAD', text: 'x' }])
    await assert.rejects(hermes.send(bad as never))
})

test('a failed lookup never creates a second Bot Chat, and a refused message says so', async () => {
  const blind = fake((call) => (call.method === 'session.list' ? new HermesError('timeout', 'Hermes took too long to answer. Try again.') : standard(call)))
  await assert.rejects(blind.hermes.send({ botId: 'fresh', text: 'hi' }), /took too long/)
  assert.equal(blind.calls.some((c) => c.method === 'session.create' || c.method === 'prompt.submit'), false)
  const malformed = fake((call) => (call.method === 'session.list' ? { nothing: true } : standard(call)))
  await assert.rejects(malformed.hermes.send({ botId: 'fresh', text: 'hi' }), /Could not check this bot’s chat/)
  assert.equal(malformed.calls.some((c) => c.method === 'session.create'), false)
  const refusing = fake((call) => (call.method === 'prompt.submit' ? new HermesError('refused', 'Hermes refused this request.', 'session_busy') : standard(call)))
  await assert.rejects(refusing.hermes.send({ botId: 'honex', text: 'hi' }), /did not take this message/)
  assert.equal((await refusing.hermes.readThread({ botId: 'honex' })).live, undefined)
})

test('only wording written here reaches the panel', async () => {
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>()
  const api = { panels: { handle: (name: string, fn: never) => void handlers.set(name, fn) } } as never
  const leaky = fake((call) => (call.method === 'profiles.list' ? new Error('ENOENT: /Users/SECRET/.hermes/state.db') : standard(call)))
  register(api, leaky.hermes)
  await assert.rejects(handlers.get('bots.list')!({}), /^Error: Hermes could not do that\. Try again\.$/)
  await assert.rejects(handlers.get('thread.read')!({ botId: '../x' }), /^Error: Unknown bot\.$/)
  await assert.rejects(handlers.get('message.send')!(undefined), /^Error: Unknown bot\.$/)
  assert.deepEqual(await handlers.get('status')!({}), { state: 'unavailable', message: 'Could not reach Hermes. Press Retry.' })
})

test('two first sends at once create one Bot Chat; a lost title race adopts the winner', async () => {
  const { hermes, calls } = fake(standard)
  await Promise.all([hermes.send({ botId: 'fresh', text: 'one' }), hermes.send({ botId: 'fresh', text: 'two' })])
  assert.equal(calls.filter((c) => c.method === 'session.create').length, 1)
  assert.deepEqual(calls.filter((c) => c.method === 'prompt.submit').map((c) => c.params.session_id), ['live-new', 'live-new'])
  // Hermes Desktop created the chat between our lookup and our title write: ours is abandoned.
  let lookups = 0
  const raced = fake((call) => {
    if (call.method === 'session.list') return { sessions: ++lookups > 1 ? [{ id: 'chat-desktop' }] : [] }
    if (call.method === 'session.title') return new HermesError('refused', 'Hermes refused this request.')
    return standard(call)
  })
  await raced.hermes.send({ botId: 'fresh', text: 'hi' })
  assert.equal(raced.calls.find((c) => c.method === 'session.resume')!.params.session_id, 'chat-desktop')
  assert.equal(raced.calls.at(-1)!.params.session_id, 'live-chat-desktop')
})

test('a compacted chat is read on its newest segment, and an archived one is let go', async () => {
  let canonical: unknown = { id: 'chat-root', resolved_id: 'chat-tip', preview: 'p', last_active: 5 }
  const { hermes, calls, emit, tick } = fake((call) => {
    if (call.method === 'profiles.list' && call.profile === 'honex') return { profiles: [{ name: 'honex', canonical_session: canonical }] }
    if (call.method === 'session.list') return { sessions: canonical ? [canonical] : [] }
    return standard(call)
  })
  await hermes.listBots()
  await hermes.readThread({ botId: 'honex' })
  assert.equal(calls.find((c) => c.method === 'session.resume')!.params.session_id, 'chat-tip')
  assert.equal(calls.find((c) => c.method === 'session.transcript')!.params.session_id, 'chat-tip')
  emit('honex', 'message.start', 'live-chat-tip')
  // Archived in Hermes: the roster refresh says so, and nothing keeps reading or sending to it.
  canonical = null
  tick(9000)
  await hermes.listBots()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(await hermes.readThread({ botId: 'honex' }), { messages: [] })
  assert.equal((await hermes.listBots()).find((b) => b.id === 'honex')!.working, false)
})

test('a big roster asks a few bots at a time', async () => {
  let running = 0
  let most = 0
  const gates: (() => void)[] = []
  const many = Array.from({ length: 12 }, (_, i) => ({ name: `bot-${i}` }))
  const { hermes } = fake((call) => {
    if (call.profile === 'default' && !call.params.include_sessions) return { profiles: many }
    return standard(call)
  })
  const slow = fake(() => undefined)
  void slow
  // Count how many detail requests are in flight together.
  const calls: string[] = []
  const gateway = {
    request: (profile: string, _method: string, params: any = {}) => {
      if (!params.include_sessions) return Promise.resolve({ profiles: many })
      calls.push(profile)
      most = Math.max(most, ++running)
      return new Promise((resolve) => gates.push(() => (running--, resolve({ profiles: [{ name: profile }] }))))
    },
    connected: () => true,
    onEvent: () => () => {},
    onDrop: () => () => {},
    hold: () => {},
    close: () => {}
  } as unknown as Gateway
  const limited = createHermes({ gateway, now: () => 0, id: () => 'x', wait: () => {} })
  const listing = limited.listBots()
  for (let i = 0; i < 40 && gates.length + calls.length < 24; i++) {
    await new Promise((resolve) => setImmediate(resolve))
    gates.splice(0).forEach((open) => open())
  }
  await listing
  assert.equal(calls.length, 12)
  assert.equal(most, 4)
  void hermes
})
