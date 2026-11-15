// Runs the worker with a fake desktop session and a fake fetch, so no test ever reads a real
// keychain or reaches a real Grok Bot account. Always go through mount() below: it is the
// only place that builds a worker, and it never uses the real defaults.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { removeRoutineMessage, routinesFrom, scheduleMessage, toEntry, waitingState } from '../shared/model.ts'
import type { DesktopSession } from './session.ts'
import { register } from './worker.ts'

const BOT = '11111111-2222-4333-8444-555555555555'
const GATEWAY = 'https://box.example.cursorvm.com'
const ROUTE = { gatewayUrl: GATEWAY, gatewayToken: 'made-up-gateway-token', headers: {} }
const ACCOUNT = { key: 'account-a', accessToken: 'made-up-access-token' }

type Call = { url: string; body: any }

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers })
}

/** A fake gateway: records each request and answers from `answer`, or with canned data. */
function fakeFetch(answer?: (call: Call) => Response | undefined) {
  const calls: Call[] = []
  const fetch = async (url: any, init: any) => {
    const call = { url: String(url), body: JSON.parse(init.body) }
    calls.push(call)
    const custom = answer?.(call)
    if (custom) return custom
    if (call.url.endsWith('/api/listAgents')) {
      return json({
        agents: [
          { id: BOT, harness: 'box', name: 'Researcher', description: 'Find things', avatarColor: 'green' },
          { id: 'group-1', name: 'Team', isGroup: true }
        ]
      })
    }
    if (call.url.endsWith('/api/getAgentTranscriptTail')) {
      return json({
        entries: [
          { id: 'u1', kind: 'message', role: 'user', content: 'hi', timestampMs: 1 },
          { id: 's1', kind: 'send-message', message: { type: 'text', content: 'hello' }, timestampMs: 2 },
          {
            id: 'e1',
            kind: 'event',
            timestampMs: 3,
            event: { type: 'automation-changed', action: 'created', automationId: 'daily', automationName: 'Daily check' }
          }
        ]
      })
    }
    if (call.url.endsWith('/ListGrokBotAgents')) return json({ agents: [] })
    if (call.url.endsWith('/SendGrokBotUserMessage')) return json({ delivery: 2 })
    if (call.url.endsWith('/DeleteGrokBotAgent')) return json({})
    if (call.url.endsWith('/api/sendPrompt')) return json({ accepted: true, messageId: 'm1' })
    return json({})
  }
  return { fetch: fetch as typeof globalThis.fetch, calls }
}

async function mount(
  options: {
    session?: (deps?: { expectedAccountKey?: string }) => Promise<DesktopSession>
    answer?: (call: Call) => Response | undefined
  } = {}
) {
  const network = fakeFetch(options.answer)
  const readSession = options.session ?? (async () => ({ route: ROUTE, account: ACCOUNT }))
  const worker = await mountWorker(
    { default: (orca: any) => register(orca, { readSession, network: { fetch: network.fetch } }) },
    { host: mockHost() }
  )
  const writes = () =>
    network.calls
      .filter((call) => !call.url.endsWith('/api/listAgents'))
      .map((call) => [call.url.replace(`${GATEWAY}/api/`, ''), call.body])
  return { worker, calls: network.calls, writes }
}

test('lists bots and reads a thread in the shapes the panel draws', async () => {
  const { worker } = await mount()
  assert.deepEqual(await worker.request('status'), { ok: true, message: '' })
  assert.deepEqual(await worker.request('bots.list'), [
    {
      id: BOT,
      name: 'Researcher',
      instructions: 'Find things',
      avatarShape: 'square',
      avatarColor: 'green',
      serverRun: false,
      hidden: false
    }
  ])
  const entries = (await worker.request('thread.read', { id: BOT })) as ReturnType<typeof toEntry>[]
  assert.deepEqual(
    entries.map((entry) => [entry.role, entry.text]),
    [
      ['user', 'hi'],
      ['bot', 'hello'],
      ['event', 'Routine created: Daily check']
    ]
  )
  assert.deepEqual(
    routinesFrom(entries).map((routine) => routine.name),
    ['Daily check']
  )
  await worker.deactivate()
})

test('create, update, delete and send make exactly the expected gateway calls', async () => {
  const { worker, writes } = await mount()
  await worker.request('bots.create', { name: 'Writer', instructions: 'Be brief' })
  await worker.request('bots.update', { id: BOT, hidden: true })
  await worker.request('bots.delete', { id: BOT })
  await worker.request('message.send', { id: BOT, text: 'Hello there' })
  const sent = writes()
  const nonce = sent[4][1].clientNonce
  assert.match(nonce, /^[0-9a-f-]{36}$/)
  assert.deepEqual(sent, [
    ['createAgent', { name: 'Writer', description: 'Be brief', title: '', avatarShape: '', avatarColor: '', origin: 'user' }],
    // An update always resends the name and instructions the bot already has.
    ['updateAgent', { id: BOT, profile: { name: 'Researcher', description: 'Find things' } }],
    ['setAgentHiddenFromSidebar', { id: BOT, isHidden: true }],
    ['deleteAgent', { id: BOT }],
    ['sendPrompt', { agentId: BOT, prompt: 'Hello there', clientNonce: nonce }]
  ])
  await worker.deactivate()
})

test('failed gateway deletion reaches the panel without retry or refresh', async () => {
  const { worker, calls } = await mount({
    answer: call => call.url.endsWith('/api/deleteAgent') ? json({ failedAgentIds: [BOT] }) : undefined
  })
  await assert.rejects(worker.request('bots.delete', { id: BOT }), /could not delete/)
  assert.equal(calls.length, 1)
  await worker.deactivate()
})

test('refuses bad input before any request is made', async () => {
  const { worker, calls } = await mount()
  await assert.rejects(worker.request('bots.delete', { id: 'Researcher' }), /Unknown bot id/)
  await assert.rejects(worker.request('thread.read', { id: '../listAgents' }), /Unknown bot id/)
  await assert.rejects(worker.request('message.send', { id: BOT, text: '  ' }), /Message is required/)
  await assert.rejects(worker.request('bots.create', { name: 'x'.repeat(81) }), /Name is too long/)
  assert.deepEqual(calls, [])
  await worker.deactivate()
})

test('gateway 409 falls over once with the same nonce', async () => {
  const { worker, calls } = await mount({
    answer: call => call.url.endsWith('/api/sendPrompt') ? json({}, 409) : undefined
  })
  assert.deepEqual(await worker.request('message.send', { id: BOT, text: 'Hello' }), { sent: true })
  assert.equal(calls.length, 2)
  assert.ok(calls[1].url.endsWith('/SendGrokBotUserMessage'))
  assert.equal(calls[1].body.messageId, calls[0].body.clientNonce)
  await worker.deactivate()
})

test('a send is never repeated when its outcome is unclear', async () => {
  const { worker, writes } = await mount({
    answer: (call) => (call.url.endsWith('/api/sendPrompt') ? json({ message: 'boom' }, 503) : undefined)
  })
  await assert.rejects(
    worker.request('message.send', { id: BOT, text: 'Hello' }),
    /outcome is unknown. Check Grok Bot before trying again/
  )
  assert.equal(writes().length, 1)
  await worker.deactivate()
})

test('a signed-out app is reported as a setup problem, and Refresh reads the app again', async () => {
  let signedIn = false
  const { worker } = await mount({
    session: async () => {
      if (!signedIn) {
        throw Object.assign(new Error('Open the Grok Bot app and sign in, then retry.'), {
          code: 'not_signed_in'
        })
      }
      return { route: ROUTE, account: ACCOUNT }
    }
  })
  assert.deepEqual(await worker.request('status'), {
    ok: false,
    message: 'Open the Grok Bot app and sign in, then retry.'
  })
  signedIn = true
  assert.deepEqual(await worker.request('status'), { ok: true, message: '' })
  await worker.deactivate()
})

test('asks for a fresh route when the app has none cached, and when the cloud computer slept', async () => {
  let asleep = true
  const { worker, calls } = await mount({
    session: async () => ({ account: ACCOUNT, appVersion: '1.2.3' }),
    answer: (call) => {
      if (call.url.endsWith('/EnsureSandBox')) return json({ gatewayUrl: GATEWAY, gatewayToken: 'made-up-fresh-token' })
      if (call.url.endsWith('/api/listAgents') && asleep) {
        asleep = false
        return json({}, 417, {
          'x-anyrun-error-source': 'anyrun-proxy',
          'x-anyrun-failure-reason': 'pod_hibernated'
        })
      }
      return undefined
    }
  })
  const bots = (await worker.request('bots.list')) as unknown[]
  assert.equal(bots.length, 1)
  assert.deepEqual(
    calls.map((call) => call.url.split('/').pop()),
    ['EnsureSandBox', 'listAgents', 'EnsureSandBox', 'listAgents']
  )
  await worker.deactivate()
})

test('drops the route when the signed-in account changes during a refresh', async () => {
  let current = 'account-a'
  const { worker } = await mount({
    session: async (deps) => {
      if (deps?.expectedAccountKey && deps.expectedAccountKey !== current) {
        throw Object.assign(new Error('The Grok Bot account changed. Reconnect and retry.'), {
          code: 'account_changed'
        })
      }
      return { account: { key: current, accessToken: 'made-up-access-token' } }
    },
    answer: (call) => {
      if (call.url.endsWith('/EnsureSandBox')) return json({ gatewayUrl: GATEWAY, gatewayToken: 'made-up-fresh-token' })
      if (call.url.endsWith('/api/listAgents')) {
        current = 'account-b'
        return json({}, 417, {
          'x-anyrun-error-source': 'anyrun-proxy',
          'x-anyrun-failure-reason': 'pod_hibernated'
        })
      }
      return undefined
    }
  })
  await assert.rejects(worker.request('bots.list'), /account changed/)
  await worker.deactivate()
})

test('waiting starts without a reply and ignores user and event entries', () => {
  const entries = [
    toEntry({ kind: 'message', role: 'user', timestampMs: 101, text: 'Hello' }),
    toEntry({ kind: 'event', timestampMs: 102, event: { type: 'updated' } })
  ]
  assert.equal(waitingState([], 100, 100), 'working')
  assert.equal(waitingState(entries, 100, 200), 'working')
})

test('a streaming bot reply keeps waiting until it finishes', () => {
  const entry = toEntry({ kind: 'message', role: 'assistant', timestampMs: 101, isStreaming: true, text: 'Hello' })
  assert.equal(waitingState([entry], 100, 200), 'working')
  assert.equal(waitingState([{ ...entry, streaming: false }], 100, 200), 'done')
  assert.equal(waitingState([{ ...entry, streaming: false }], 100, 180_100), 'done')
})

test('older bot messages and messages at the send timestamp do not complete waiting', () => {
  for (const timestampMs of [99, 100]) {
    const entry = toEntry({ kind: 'message', role: 'assistant', timestampMs, text: 'Older' })
    assert.equal(waitingState([entry], 100, 200), 'working')
  }
})

test('waiting slows at exactly three minutes, including unfinished streaming replies', () => {
  assert.equal(waitingState([], 100, 180_099), 'working')
  assert.equal(waitingState([], 100, 180_100), 'slow')
  const entry = toEntry({ kind: 'message', role: 'assistant', timestampMs: 101, isStreaming: true })
  assert.equal(waitingState([entry], 100, 180_100), 'slow')
})

test('scheduling and routine removal are plain messages to the bot', () => {
  assert.equal(
    scheduleMessage({ name: ' Standup ', task: 'Summarize PRs', when: 'every day at 09:00', timeZone: 'UTC' }),
    'Please create a scheduled routine.\nName: Standup\nWhen: every day at 09:00 (time zone: UTC)\nTask: Summarize PRs\nConfirm once it is scheduled.'
  )
  assert.match(removeRoutineMessage('Standup'), /delete the scheduled routine "Standup"/)
  const deleted = [
    toEntry({ kind: 'event', id: 'a', timestampMs: 1, event: { type: 'automation-changed', action: 'created', automationId: 'x', automationName: 'X' } }),
    toEntry({ kind: 'event', id: 'b', timestampMs: 2, event: { type: 'automation-changed', action: 'deleted', automationId: 'x', automationName: 'X' } })
  ]
  assert.deepEqual(routinesFrom(deleted), [])
})

test('a send that Grok Bot does not confirm is reported as unclear, not as sent', async () => {
  const { worker, writes } = await mount({
    answer: (call) => (call.url.endsWith('/api/sendPrompt') ? json({}) : undefined)
  })
  await assert.rejects(
    worker.request('message.send', { id: BOT, text: 'Hello' }),
    /did not confirm the message. Check the conversation before sending it again/
  )
  assert.equal(writes().length, 1)
  await worker.deactivate()
})

test('a write that worked is not reported as failed when the list after it cannot be read', async () => {
  let created = false
  const { worker, writes } = await mount({
    answer: (call) => {
      if (call.url.endsWith('/api/createAgent')) created = true
      if (call.url.endsWith('/api/listAgents') && created) return json({ message: 'down' }, 500)
      return undefined
    }
  })
  assert.equal(await worker.request('bots.create', { name: 'Writer' }), null)
  assert.equal(writes().length, 1)
  await worker.deactivate()
})

test('a route requested for one account is not kept after the app switches to another', async () => {
  let current = 'account-a'
  const { worker, calls } = await mount({
    session: async (deps) => {
      if (deps?.expectedAccountKey && deps.expectedAccountKey !== current) {
        throw Object.assign(new Error('The Grok Bot account changed. Reconnect and retry.'), {
          code: 'account_changed'
        })
      }
      return { account: { key: current, accessToken: 'made-up-access-token' } }
    },
    answer: (call) => {
      if (!call.url.endsWith('/EnsureSandBox')) return undefined
      // The person switches accounts while the first route request is in flight.
      current = 'account-b'
      return json({ gatewayUrl: GATEWAY, gatewayToken: 'made-up-fresh-token' })
    }
  })
  await assert.rejects(worker.request('bots.list'), /account changed/)
  // Nothing was sent to the gateway with the stale route.
  assert.deepEqual(calls.map((call) => call.url.split('/').pop()), ['EnsureSandBox'])
  await worker.deactivate()
})

test('a slow load that Refresh has replaced cannot install its route', async () => {
  const OLD = { ...ROUTE, gatewayUrl: 'https://old.example.cursorvm.com' }
  let releaseOld: (session: DesktopSession) => void = () => {}
  let reads = 0
  const { worker, calls } = await mount({
    session: () => {
      reads += 1
      // The first read hangs until released; later reads answer at once with the new route.
      if (reads === 1) return new Promise<DesktopSession>((resolve) => (releaseOld = resolve))
      return Promise.resolve({ route: ROUTE, account: ACCOUNT })
    }
  })
  const stale = worker.request('bots.list')
  const staleOutcome = assert.rejects(stale, /connection changed/)
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.deepEqual(await worker.request('status'), { ok: true, message: '' })
  releaseOld({ route: OLD, account: { key: 'account-old', accessToken: 'made-up-old-token' } })
  await staleOutcome
  await worker.request('bots.list')
  assert.ok(calls.length > 0)
  assert.ok(calls.every((call) => call.url.startsWith(GATEWAY)))
  await worker.deactivate()
})

test('temporal bots send and delete through the backend without gateway writes', async () => {
  const { worker, calls } = await mount({
    answer: call => call.url.endsWith('/api/listAgents')
      ? json({ agents: [{ id: BOT, harness: 'temporal' }] }) : undefined
  })
  const bots = await worker.request('bots.list') as any[]
  assert.equal(bots[0].serverRun, true)
  assert.deepEqual(await worker.request('message.send', { id: BOT, text: 'Hello' }), { sent: true })
  await worker.request('bots.delete', { id: BOT })
  assert.equal(calls.filter(call => call.url.endsWith('/SendGrokBotUserMessage')).length, 1)
  assert.equal(calls.filter(call => call.url.endsWith('/DeleteGrokBotAgent')).length, 1)
  assert.ok(calls.every(call => !/\/api\/(sendPrompt|deleteAgent)$/.test(call.url)))
  await worker.deactivate()
})

test('box bots never use the backend', async () => {
  const { worker, calls } = await mount()
  await worker.request('bots.list')
  await worker.request('message.send', { id: BOT, text: 'Hello' })
  await worker.request('bots.delete', { id: BOT })
  assert.ok(calls.every(call => call.url.startsWith(GATEWAY)))
  await worker.deactivate()
})

test('refused gateway deletion falls over to the backend exactly once', async () => {
  const { worker, calls } = await mount({
    answer: call => call.url.endsWith('/api/deleteAgent') ? json({ refusedAgentIds: [BOT] }) : undefined
  })
  await worker.request('bots.delete', { id: BOT })
  assert.deepEqual(calls.map(call => call.url.split('/').pop()), ['deleteAgent', 'DeleteGrokBotAgent', 'listAgents'])
  assert.deepEqual(calls[1].body, { id: BOT })
  await worker.deactivate()
})

test('missing harness is enriched once by runtime id without adding server-only bots', async () => {
  const { worker, calls } = await mount({
    answer: call => {
      if (call.url.endsWith('/api/listAgents')) return json({ agents: [{ id: BOT }] })
      if (call.url.endsWith('/ListGrokBotAgents')) return json({ agents: [
        { agentId: BOT, id: 'fixture-record', harness: 'temporal' },
        { agentId: 'fixture-server-only', id: 'fixture-other-record', harness: 'temporal' }
      ] })
      return undefined
    }
  })
  const bots = await worker.request('bots.list') as any[]
  assert.equal(bots.length, 1)
  assert.equal(bots[0].serverRun, true)
  await worker.request('message.send', { id: BOT, text: 'Hello' })
  assert.deepEqual(calls.map(call => call.url.split('/').pop()), ['listAgents', 'ListGrokBotAgents', 'SendGrokBotUserMessage'])
  await worker.deactivate()
})

test('failed backend roster leaves the gateway list usable', async () => {
  const { worker } = await mount({
    answer: call => {
      if (call.url.endsWith('/api/listAgents')) return json({ agents: [{ id: BOT }] })
      if (call.url.endsWith('/ListGrokBotAgents')) return json({ code: 'unimplemented' }, 501)
      return undefined
    }
  })
  const bots = await worker.request('bots.list') as any[]
  assert.equal(bots.length, 1)
  assert.equal(bots[0].serverRun, false)
  await worker.deactivate()
})

test('backend account access with no account gives not_signed_in through mount', async () => {
  const { worker, calls } = await mount({
    session: async () => ({ route: ROUTE }),
    answer: call => call.url.endsWith('/api/listAgents') ? json({ agents: [{ id: BOT, harness: 'temporal' }] }) : undefined
  })
  await worker.request('bots.list')
  await assert.rejects(worker.request('message.send', { id: BOT, text: 'Hello' }), /Open the Grok Bot app and sign in/)
  assert.equal(calls.length, 1)
  await worker.deactivate()
})

test('every list replaces remembered harnesses', async () => {
  let harness = 'temporal'
  const { worker, calls } = await mount({
    answer: call => call.url.endsWith('/api/listAgents') ? json({ agents: [{ id: BOT, harness }] }) : undefined
  })
  await worker.request('bots.list')
  harness = 'box'
  await worker.request('bots.list')
  await worker.request('message.send', { id: BOT, text: 'Hello' })
  assert.ok(calls.at(-1)?.url.endsWith('/api/sendPrompt'))
  assert.ok(calls.every(call => call.url.startsWith(GATEWAY)))
  await worker.deactivate()
})

test('a backend rejection after gateway fallback never triggers another attempt', async () => {
  const { worker, calls } = await mount({
    answer: call => {
      if (call.url.endsWith('/api/sendPrompt')) return json({}, 409)
      if (call.url.endsWith('/SendGrokBotUserMessage')) return json({ code: 'unavailable' }, 503)
      return undefined
    }
  })
  await assert.rejects(worker.request('message.send', { id: BOT, text: 'Hello' }), /outcome is unknown/)
  assert.deepEqual(calls.map(call => call.url.split('/').pop()), ['sendPrompt', 'SendGrokBotUserMessage'])
  await worker.deactivate()
})
