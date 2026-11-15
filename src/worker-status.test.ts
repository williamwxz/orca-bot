// All worker mounts inject both session and network; no real desktop defaults are used.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { DesktopSession } from './session.ts'
import { register } from './worker.ts'

const BOT = '11111111-2222-4333-8444-555555555555'
const ROUTE = { gatewayUrl: 'https://box.example.cursorvm.com', gatewayToken: 'made-up-token', headers: {} }
const ACCOUNT = { key: 'fixture-account', accessToken: 'made-up-access-token' }
type Call = { url: string; body: any }
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}
function fakeFetch(answer?: (call: Call) => Response | undefined) {
  const calls: Call[] = []
  const fetch = async (url: any, init: any) => {
    const call = { url: String(url), body: JSON.parse(init.body) }
    calls.push(call)
    const custom = answer?.(call)
    if (custom) return custom
    if (call.url.endsWith('/api/listAgents')) return json({ agents: [{ id: BOT, harness: 'temporal' }] })
    throw new Error('Unexpected fake request')
  }
  return { fetch: fetch as typeof globalThis.fetch, calls }
}
async function mount(options: {
  session?: () => Promise<DesktopSession>
  answer?: (call: Call) => Response | undefined
} = {}) {
  const network = fakeFetch(options.answer)
  const readSession = options.session ?? (async () => ({ route: ROUTE, account: ACCOUNT }))
  const worker = await mountWorker(
    { default: (orca: any) => register(orca, { readSession, network: { fetch: network.fetch } }) },
    { host: mockHost() }
  )
  return { worker, calls: network.calls }
}
test('status handler formats server activity and keeps a stable phrase across polls', async () => {
  let activity = { kind: 'tool', tool: 'SetStatus', detail: 'is checking the NVDA shares' }
  let running = true
  const { worker } = await mount({ answer: call => call.url.endsWith('/ListGrokBotAgentStatuses')
    ? json({ statuses: [{ agentId: BOT, isRunning: running,
      live: { isRunning: running, updatedAtMs: String(Date.now()), activity } }] }) : undefined })
  try {
    await worker.request('bots.list')
    assert.deepEqual(await worker.request('status.read', { id: BOT }), { state: 'working', text: 'Checking the NVDA shares' })
    activity = { kind: 'thinking', tool: '', detail: '' }
    const first = await worker.request('status.read', { id: BOT })
    for (let i = 0; i < 10; i += 1) assert.deepEqual(await worker.request('status.read', { id: BOT }), first)
    running = false
    assert.deepEqual(await worker.request('status.read', { id: BOT }), { state: 'idle', text: '' })
  } finally {
    await worker.deactivate()
  }
})
test('status failures and missing live records give idle without an error', async () => {
  for (const response of [json({}, 503), json({ statuses: [] }), json({ code: 'unauthenticated' }, 403)]) {
    const { worker } = await mount({ answer: call => call.url.endsWith('/ListGrokBotAgentStatuses') ? response : undefined })
    try {
      await worker.request('bots.list')
      assert.deepEqual(await worker.request('status.read', { id: BOT }), { state: 'idle', text: '' })
    } finally {
      await worker.deactivate()
    }
  }
})
test('status rejects bad ids and box bots do not make status requests', async () => {
  const { worker, calls } = await mount({ answer: call => call.url.endsWith('/api/listAgents')
    ? json({ agents: [{ id: BOT, harness: 'box' }] }) : undefined })
  try {
    await assert.rejects(worker.request('status.read', { id: '../bad' }), /Unknown bot id/)
    assert.equal(calls.length, 0)
    await worker.request('bots.list')
    assert.deepEqual(await worker.request('status.read', { id: BOT }), { state: 'idle', text: '' })
    assert.equal(calls.length, 1)
  } finally {
    await worker.deactivate()
  }
})
