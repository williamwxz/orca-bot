import { assert, test } from 'orca/testing'
import { assertAllowedCredentialUrl, createGatewayClient, ensureSandbox, gatewayCall, type Route } from './gateway.ts'
import { createConnection } from './connection.ts'
import { toBot, toEntry } from '../shared/model.ts'

const route: Route = { gatewayUrl: 'https://example.cursorvm.com', gatewayToken: 'fake-gateway-secret', headers: { 'x-anyrun-network-token': 'fake-network-secret' } }
const bot = { agentId: 'example-bot', name: 'Planner', description: 'Plan', isHiddenFromSidebar: true }
const list = { agents: [bot] }
const headers = { 'content-type': 'application/json', authorization: `Bearer ${route.gatewayToken}`, ...route.headers }
function fake(script: (Response | Error | object)[]) {
  const calls: any[] = []
  const fetch = (async (url: any, init: any) => {
    calls.push({ url, method: init.method, headers: init.headers, body: JSON.parse(init.body), redirect: init.redirect })
    const next = script.shift()
    if (next instanceof Error) throw next
    if (next === undefined) throw new Error('Unexpected request')
    return next instanceof Response ? next : new Response(JSON.stringify(next))
  }) as typeof globalThis.fetch
  let refreshes = 0
  const client = createGatewayClient({ fetch, getRoute: () => route, refreshRoute: () => { refreshes++; return route }, randomUUID: () => 'example-nonce' })
  return { fetch, calls, client, refreshes: () => refreshes }
}
function expected(method: string, body: object) {
  return { url: `${route.gatewayUrl}/api/${method}`, method: 'POST', headers, body, redirect: 'error' }
}
const bad = () => new Response('{"message":"Denied"}', { status: 403 })
const sleeping = () => new Response('{}', { status: 417, headers: { 'x-anyrun-error-source': 'anyrun-proxy', 'x-anyrun-failure-reason': 'pod_hibernated' } })

test('credential destinations require HTTPS and exact host boundaries', () => {
  for (const url of ['http://cursor.sh', 'https://example.invalid', 'https://user:pass@cursor.sh', 'https://evilcursor.sh', 'https://cursor.sh.evil.com', 'https://localhost', 'https://cursorvm.com']) {
    assert.throws(() => assertAllowedCredentialUrl(url), /not allowed/)
  }
  for (const url of ['https://cursor.sh', 'https://api.cursor.com', route.gatewayUrl]) assertAllowedCredentialUrl(url)
  assert.throws(() => assertAllowedCredentialUrl(route.gatewayUrl, 'backend'))
})

test('EnsureSandBox exact request, aliases, normalized headers and fallback version', async () => {
  const f = fake([{ gateway_url: route.gatewayUrl + '/', gateway_token: route.gatewayToken, gateway_headers: { 'X-Test': 42, ignored: null, empty: '' } }])
  assert.deepEqual(await ensureSandbox({ key: 'example-account', accessToken: 'fake-access-secret', teamId: '42' }, 'bad', f), { ...route, headers: { 'x-test': '42' } })
  assert.deepEqual(f.calls, [{ url: 'https://api2.cursor.sh/aiserver.v1.GrokBotService/EnsureSandBox', method: 'POST', redirect: 'error', body: {}, headers: {
    'content-type': 'application/json', 'connect-protocol-version': '1', authorization: 'Bearer fake-access-secret', 'x-cursor-client-type': 'sand', 'x-cursor-client-version': '0.20.0', 'x-sand-box-namespace': 'prod', 'x-cursor-team-id': '42'
  } }])
  for (const status of [401, 403]) {
    await assert.rejects(ensureSandbox({ key: 'example-account', accessToken: 'fake-access-secret' }, undefined, fake([new Response('{}', { status })])), (e: any) => e.code === 'not_signed_in' && e.message === 'Open the Grok Bot app and sign in, then retry.')
  }
  const g = fake([{ gatewayUrl: route.gatewayUrl, gatewayToken: route.gatewayToken, networkToken: 'fake-network-secret' }])
  assert.deepEqual(await ensureSandbox({ key: 'example-account', accessToken: 'fake-access-secret' }, '1.2.3', g), route)
  assert.equal(g.calls[0].headers['x-cursor-client-version'], '1.2.3')
  assert.equal(g.calls[0].headers['x-cursor-team-id'], undefined)
})

test('listBots filters groups and normalizes gateway aliases', async () => {
  const f = fake([{ agents: [bot, { id: 'example-group', memberAgentIds: ['example-bot'] }, { id: 'example-group-two', isGroup: true }, {}] }])
  assert.deepEqual(await f.client.listBots(), [toBot(bot)])
  assert.deepEqual(f.calls, [expected('listAgents', {})])
  await assert.rejects(fake([bad()]).client.listBots(), /403/)
})

test('createBot exact wire profile and failure', async () => {
  const f = fake([{ agent: bot }])
  assert.deepEqual(await f.client.createBot({ name: ' Planner ', instructions: 'Plan' }), toBot(bot))
  assert.deepEqual(f.calls, [expected('createAgent', { name: 'Planner', description: 'Plan', title: '', avatarShape: '', avatarColor: '', origin: 'user' })])
  await assert.rejects(fake([bad()]).client.createBot({ name: 'Planner' }), /403/)
})

test('updateBot preserves profile and sets visibility separately', async () => {
  const f = fake([list, {}, {}])
  assert.deepEqual(await f.client.updateBot('example-bot', { hidden: true }), toBot(bot))
  assert.deepEqual(f.calls, [expected('listAgents', {}), expected('updateAgent', { id: 'example-bot', profile: { name: 'Planner', description: 'Plan' } }), expected('setAgentHiddenFromSidebar', { id: 'example-bot', isHidden: true })])
  await assert.rejects(fake([list, bad()]).client.updateBot('example-bot', { name: 'New' }), /403/)
})

test('deleteBot sends the supplied id directly', async () => {
  const f = fake([{}])
  assert.equal(await f.client.deleteBot('example-bot'), undefined)
  assert.deepEqual(f.calls, [expected('deleteAgent', { id: 'example-bot' })])
  await assert.rejects(fake([bad()]).client.deleteBot('example-bot'), /403/)
})

test('deleteBot reports a refused deletion even with HTTP 200', async () => {
  const f = fake([{ transcript: [], refusedAgentIds: ['example-bot'] }])
  await assert.rejects(f.client.deleteBot('example-bot'), (e: any) =>
    e.code === 'delete_refused' && e.message === 'Grok Bot refused to delete this bot. Delete it in the Grok Bot app.')
  assert.deepEqual(f.calls, [expected('deleteAgent', { id: 'example-bot' })])
})

test('deleteBot reports a failed deletion even with HTTP 200', async () => {
  const f = fake([{ failedAgentIds: ['example-bot'] }])
  await assert.rejects(f.client.deleteBot('example-bot'), (e: any) =>
    e.code === 'delete_failed' && e.message === 'Grok Bot could not delete this bot. Try again, or delete it in the Grok Bot app.')
  assert.deepEqual(f.calls, [expected('deleteAgent', { id: 'example-bot' })])
})

test('deleteBot succeeds unless the supplied id is listed as refused or failed', async () => {
  for (const body of [{}, { refusedAgentIds: [], failedAgentIds: [] }, { refusedAgentIds: ['other-bot'], failedAgentIds: ['other-bot'] }]) {
    const f = fake([body])
    assert.equal(await f.client.deleteBot('example-bot'), undefined)
    assert.deepEqual(f.calls, [expected('deleteAgent', { id: 'example-bot' })])
  }
})

test('readThread clamps limits and normalizes entries', async () => {
  const entry = { id: 'example-entry', kind: 'message', content: [{ text: 'Hi' }], role: 'user', timestampMs: 1 }
  const f = fake([{ entries: [entry] }])
  assert.deepEqual(await f.client.readThread('example-bot', 999), [toEntry(entry)])
  assert.deepEqual(f.calls, [expected('getAgentTranscriptTail', { id: 'example-bot', limit: 200 })])
  const g = fake([{ entries: [] }]); await g.client.readThread('example-bot', -2)
  assert.equal(g.calls[0].body.limit, 1)
  await assert.rejects(fake([bad()]).client.readThread('example-bot'), /403/)
})

test('sendMessage confirms ids, looks up nonces and reports unknown delivery', async () => {
  const f = fake([{ messageId: 'example-message' }])
  assert.deepEqual(await f.client.sendMessage('example-bot', 'Hello'), { delivery: 'accepted', messageId: 'example-message' })
  assert.deepEqual(f.calls, [expected('sendPrompt', { agentId: 'example-bot', prompt: 'Hello', clientNonce: 'example-nonce' })])
  const g = fake([{ accepted: true }, { entries: [{ id: 'example-message', clientNonce: 'example-nonce' }] }])
  assert.deepEqual(await g.client.sendMessage('example-bot', 'Hello'), { delivery: 'accepted', messageId: 'example-message' })
  assert.deepEqual(g.calls[1], expected('getAgentTranscriptTail', { id: 'example-bot', limit: 20 }))
  for (const lookup of [{ entries: [] }, { entries: [{ id: 'example-other', clientNonce: 'example-other-nonce' }] }, bad()]) {
    assert.deepEqual(await fake([{ accepted: true }, lookup]).client.sendMessage('example-bot', 'Hello'), { delivery: 'accepted' })
  }
  const unknown = fake([{}])
  assert.deepEqual(await unknown.client.sendMessage('example-bot', 'Hello'), { delivery: 'unknown' })
  assert.equal(unknown.calls.length, 1)
  await assert.rejects(fake([bad()]).client.sendMessage('example-bot', 'Hello'), /403/)
})

test('sendPrompt 409 is a definite server-bot rejection regardless of its body', async () => {
  for (const response of [
    new Response(JSON.stringify({ message: "This Bot runs on the server, and this version of the app can't message it. Update the app and try again." }), { status: 409 }),
    new Response(JSON.stringify({ message: 'Different server wording' }), { status: 409 }),
    new Response('not JSON', { status: 409 }),
    new Response(new ReadableStream({ start(controller) { controller.error(new Error('unreadable body')) } }), { status: 409 })
  ]) {
    const f = fake([response])
    await assert.rejects(f.client.sendMessage('example-bot', 'Hello'), (e: any) => {
      assert.equal(e.code, 'server_bot')
      assert.equal(e.message, "This bot runs on Grok Bot's server. Open the Grok Bot app and sign in, then retry.")
      assert.equal(e.status, 409)
      assert.equal(e.method, 'sendPrompt')
      assert.equal(e.delivery, undefined)
      return true
    })
    assert.deepEqual(f.calls, [expected('sendPrompt', { agentId: 'example-bot', prompt: 'Hello', clientNonce: 'example-nonce' })])
    assert.equal(f.refreshes(), 0)
  }
  const f = fake([new Response('{"message":"Conflict"}', { status: 409 })])
  await assert.rejects(f.client.deleteBot('example-bot'), (e: any) => e.code === 'gateway_error' && e.status === 409)
  assert.equal(f.calls.length, 1)
})

test('refresh retries eligible reads exactly once, never writes', async () => {
  const f = fake([sleeping(), list]); await f.client.listBots()
  assert.equal(f.refreshes(), 1); assert.equal(f.calls.length, 2)
  const g = fake([sleeping(), sleeping()]); await assert.rejects(g.client.listBots()); assert.equal(g.calls.length, 2)
  const h = fake([sleeping()]); await assert.rejects(h.client.createBot({ name: 'Planner' })); assert.equal(h.refreshes(), 0); assert.equal(h.calls.length, 1)
  const i = fake([new Response('{}', { status: 417 })]); await assert.rejects(i.client.listBots()); assert.equal(i.refreshes(), 0)
})

test('read transport caps bytes, rejects non-JSON, permits empty bodies and redacts errors', async () => {
  assert.deepEqual(await gatewayCall(route, 'listAgents', {}, fake([new Response('')])), {})
  await assert.rejects(gatewayCall(route, 'listAgents', {}, fake([new Response('x'.repeat(2 * 1024 * 1024 + 1))])), (e: any) => e.code === 'response_too_large')
  await assert.rejects(gatewayCall(route, 'listAgents', {}, fake([new Response('not json')])), (e: any) => e.code === 'unsupported_version')
  const detail = `${route.gatewayToken} ${route.headers['x-anyrun-network-token']} ${'x'.repeat(500)}`
  await assert.rejects(gatewayCall(route, 'listAgents', {}, fake([new Response(JSON.stringify({ message: detail }), { status: 400 })])), (e: any) => {
    assert.equal(e.status, 400); assert.equal(e.method, 'listAgents')
    assert.ok(!e.message.includes(route.gatewayToken)); assert.ok(!e.message.includes('fake-network-secret')); assert.ok(e.message.length < 330); return true
  })
  await assert.rejects(gatewayCall(route, 'listAgents', {}, fake([new Error(detail)])), (e: any) => !e.message.includes('fake-'))
})

test('deadline aborts even an uncooperative fetch; ambiguous writes warn without retry', async () => {
  let expire: () => void = () => {}
  let signal: AbortSignal | undefined
  const deps = {
    fetch: (async (_url: any, init: any) => { signal = init.signal; return new Promise(() => {}) }) as typeof globalThis.fetch,
    setTimeout: ((fn: () => void, ms: number) => { assert.equal(ms, 30000); expire = fn; return 1 }) as any,
    clearTimeout: (() => {}) as any
  }
  const pending = gatewayCall(route, 'listAgents', {}, deps)
  expire()
  await assert.rejects(pending, (e: any) => e.code === 'timeout'); assert.equal(signal?.aborted, true)
  for (const response of [new Response('{}', { status: 503 }), new Error('dropped')]) {
    const f = fake([response])
    await assert.rejects(f.client.sendMessage('example-bot', 'Hello'), (e: any) => e.code === 'outcome_unknown' && e.delivery === 'unknown' && /Check.*before trying again/.test(e.message))
    assert.equal(f.calls.length, 1)
  }
})

test('unsupported response containers fail explicitly', async () => {
  for (const raw of [{}, { agents: 'wrong' }, null]) {
    await assert.rejects(fake([new Response(JSON.stringify(raw))]).client.listBots(), (e: any) => e.code === 'unsupported_version' && e.message === 'This version of Grok Bot is not supported yet')
  }
  await assert.rejects(fake([{}]).client.readThread('example-bot'), (e: any) => e.code === 'unsupported_version')
  assert.equal(await fake([{}]).client.createBot({ name: 'Planner' }), undefined)
})

test('all writes report ambiguous server outcomes without replay', async () => {
  for (const operation of ['create', 'update', 'delete']) {
    const f = fake([...(operation === 'update' ? [list] : []), new Response('{}', { status: 500 })])
    const result = operation === 'create' ? f.client.createBot({ name: 'Planner' }) : operation === 'update' ? f.client.updateBot('example-bot', { instructions: 'New' }) : f.client.deleteBot('example-bot')
    await assert.rejects(result, (e: any) => e.code === 'outcome_unknown' && /Check/.test(e.message))
    assert.equal(f.calls.length, operation === 'update' ? 2 : 1)
  }
})

test('each send obtains a fresh nonce and transcript reads can refresh', async () => {
  let nonce = 0
  const f = fake([{ messageId: 'example-one' }, { messageId: 'example-two' }])
  const client = createGatewayClient({ ...f, getRoute: () => route, refreshRoute: () => route, randomUUID: () => `example-nonce-${++nonce}` })
  await client.sendMessage('example-bot', 'First'); await client.sendMessage('example-bot', 'Second')
  assert.notEqual(f.calls[0].body.clientNonce, f.calls[1].body.clientNonce)
  const g = fake([sleeping(), { entries: [] }])
  assert.deepEqual(await g.client.readThread('example-bot'), [])
  assert.equal(g.refreshes(), 1)
  assert.deepEqual(g.calls[0], g.calls[1])
})


test('refresh is shared and subsequent requests obtain the provider route', async () => {
  const f = fake([sleeping(), sleeping(), list, list, list])
  const refreshed = { ...route, gatewayUrl: 'https://refreshed.cursorvm.com' }
  const switched = { ...route, gatewayUrl: 'https://switched.cursorvm.com' }
  let active = route
  let refreshes = 0
  let release: (route: Route) => void = () => {}
  const pending = new Promise<Route>(resolve => { release = resolve })
  const client = createGatewayClient({ ...f, getRoute: () => active, refreshRoute: () => {
    refreshes++
    return pending
  } })
  const reads = Promise.all([client.listBots(), client.listBots()])
  // Wait until both sleeping responses have been consumed and refresh has started.
  while (refreshes === 0) await new Promise(resolve => setTimeout(resolve, 0))
  release(refreshed)
  await reads
  assert.equal(refreshes, 1)
  assert.equal(f.calls[2].url, `${refreshed.gatewayUrl}/api/listAgents`)
  assert.equal(f.calls[3].url, `${refreshed.gatewayUrl}/api/listAgents`)
  active = switched
  await client.listBots()
  assert.equal(f.calls[4].url, `${switched.gatewayUrl}/api/listAgents`)
})

test('error redaction preserves non-secret headers and short route values', async () => {
  const message = '1 seat left in prod sand application/json 1.2.3'
  const response = () => new Response(JSON.stringify({ message }), { status: 400 })
  await assert.rejects(ensureSandbox({ key: 'example-account', accessToken: 'fake-access-secret' }, '1.2.3', fake([response()])), (e: any) => e.message.endsWith(message))
  await assert.rejects(gatewayCall({ ...route, headers: { 'x-short': 'prod' } }, 'listAgents', {}, fake([response()])), (e: any) => e.message.endsWith(message))
})

test('successful writes tolerate arbitrary response bodies', async () => {
  for (const body of ['', 'not json', 'null', '42', '[]', '{}', '{"agent":{}}']) {
    assert.equal(await fake([new Response(body)]).client.createBot({ name: 'Planner' }), undefined)
    assert.equal(await fake([new Response(body)]).client.deleteBot('unknown-example'), undefined)
    assert.deepEqual(await fake([new Response(body)]).client.sendMessage('unknown-example', 'Hello'), { delivery: 'unknown' })
    await fake([list, new Response(body)]).client.updateBot('example-bot', { name: 'Updated' })
  }
  for (const operation of ['readThread', 'sendMessage', 'deleteBot'] as const) {
    const f = fake([new Response('{}', { status: 404 })])
    await assert.rejects(f.client[operation]('unknown-example', 'Hello' as never), (e: any) => e.status === 404)
    assert.equal(f.calls.length, 1)
  }
})


test('successful write headers establish success even if the body fails or stalls', async () => {
  for (const response of [
    new Response('x'.repeat(2 * 1024 * 1024 + 1)),
    new Response(new ReadableStream({ start(controller) { controller.error(new Error('fake-body-secret')) } }))
  ]) {
    assert.equal(await fake([response]).client.createBot({ name: 'Planner' }), undefined)
  }
  let expire: () => void = () => {}
  const client = createGatewayClient({
    fetch: (async () => new Response(new ReadableStream())) as typeof globalThis.fetch,
    getRoute: () => route,
    refreshRoute: () => route,
    setTimeout: ((fn: () => void) => { expire = fn; return 1 }) as any,
    clearTimeout: (() => {}) as any
  })
  const pending = client.createBot({ name: 'Planner' })
  await new Promise(resolve => setTimeout(resolve, 0))
  expire()
  assert.equal(await pending, undefined)
})

test('a short credential header is stripped from error text, a short ordinary one is not', async () => {
  const route = {
    gatewayUrl: 'https://box.example.cursorvm.com',
    gatewayToken: 'fake-gateway-secret',
    headers: { 'x-anyrun-network-token': 'abc123', 'x-region': 'prod' }
  }
  const fetch = (async () =>
    new Response(JSON.stringify({ message: 'abc123 is not valid in prod' }), { status: 400 })) as typeof globalThis.fetch
  await assert.rejects(gatewayCall(route, 'listAgents', {}, { fetch }), (error: any) => {
    assert.equal(error.message, 'Request failed (400): [redacted] is not valid in prod')
    return true
  })
})


test('getAccount shares the route load and reset and requires a signed-in account', async () => {
  let reads = 0
  let account: { key: string; accessToken: string } | undefined = { key: 'fixture-account', accessToken: 'fixture-token' }
  const connection = createConnection({
    readSession: async () => {
      reads += 1
      return { route, account, appVersion: '1.2.3' }
    },
    network: { fetch: fake([]).fetch }
  })
  const [, signedIn] = await Promise.all([connection.getRoute(), connection.getAccount()])
  assert.deepEqual(signedIn, { account, appVersion: '1.2.3' })
  assert.equal(reads, 1)
  account = undefined
  connection.reset()
  await assert.rejects(connection.getAccount(), (e: any) => e.code === 'not_signed_in')
  assert.equal(reads, 2)
})

test('routed backend timeout remains unknown and sends exactly once', async () => {
  let expire: () => void = () => {}
  const calls: string[] = []
  const client = createGatewayClient({
    getRoute: () => route,
    refreshRoute: () => route,
    getAccount: () => ({ account: { key: 'fixture-account', accessToken: 'fixture-token' } }),
    fetch: (async (url: any) => {
      calls.push(String(url))
      if (String(url).endsWith('/listAgents')) return new Response(JSON.stringify({ agents: [{ id: 'example-bot', harness: 'temporal' }] }))
      if (String(url).endsWith('/GetGrokBotUserRuntimeSettings')) return new Response('{}')
      return new Promise(() => {})
    }) as typeof globalThis.fetch,
    setTimeout: ((fn: () => void) => { expire = fn; return 1 }) as any,
    clearTimeout: (() => {}) as any
  })
  await client.listBots()
  const pending = client.sendMessage('example-bot', 'Hello')
  await new Promise(resolve => setTimeout(resolve, 0))
  expire()
  await assert.rejects(pending, (e: any) => e.code === 'outcome_unknown')
  assert.equal(calls.filter(url => url.endsWith('/SendGrokBotUserMessage')).length, 1)
  assert.ok(calls.every(url => !url.endsWith('/sendPrompt')))
})

test('reset supersedes a pending account load without retaining its credentials', async () => {
  let release: (value: any) => void = () => {}
  let reads = 0
  const connection = createConnection({
    readSession: () => {
      reads += 1
      if (reads === 1) return new Promise(resolve => { release = resolve })
      return Promise.resolve({ route, account: { key: 'fixture-new', accessToken: 'fixture-new-token' } })
    },
    network: { fetch: fake([]).fetch }
  })
  const old = connection.getAccount()
  const rejected = assert.rejects(old, (e: any) => e.code === 'superseded')
  connection.reset()
  const current = await connection.getAccount()
  release({ route, account: { key: 'fixture-old', accessToken: 'fixture-old-token' } })
  await rejected
  assert.equal(current.account.key, 'fixture-new')
  assert.equal((await connection.getAccount()).account.key, 'fixture-new')
})

function mainFixture(answer: (method: string) => unknown | Promise<unknown>, getAccount = () => ({ account: { key: 'fixture-account', accessToken: 'fixture-token' } })) {
  const calls: string[] = []
  const fetch = (async (url: any) => {
    const method = String(url).split('/').pop()!
    calls.push(method)
    const value = await answer(method)
    return value instanceof Response ? value : new Response(JSON.stringify(value))
  }) as typeof globalThis.fetch
  return {
    calls,
    client: createGatewayClient({ fetch, getRoute: () => route, refreshRoute: () => route, getAccount })
  }
}

test('runtime settings mark only the matching listed bot, with one lookup per list', async () => {
  let id = 'renamed'
  const f = mainFixture(method => method === 'listAgents'
    ? { agents: [{ id: 'renamed', name: 'Assistant', harness: 'box' }, { id: 'other', name: 'Grok Bot', harness: 'box', main: true }] }
    : { settings: { mainAgentId: id } })
  assert.deepEqual((await f.client.listBots()).map(bot => [bot.id, bot.main]), [['renamed', true], ['other', false]])
  id = 'not-in-roster'
  assert.ok((await f.client.listBots()).every(bot => !bot.main))
  assert.deepEqual(f.calls, ['listAgents', 'GetGrokBotUserRuntimeSettings', 'listAgents', 'GetGrokBotUserRuntimeSettings'])
})

test('main settings network, feature and authentication failures leave the list usable', async () => {
  for (const failure of ['network', 'unimplemented', 'unauthenticated', 'permission_denied', 'feature-off']) {
    const f = mainFixture(method => {
      if (method === 'listAgents') return { agents: [{ id: 'example-bot', harness: 'box', main: true }] }
      if (failure === 'network') throw new Error('fixture network down')
      if (failure === 'feature-off') return { settings: {} }
      return new Response(JSON.stringify({ code: failure }), { status: failure === 'unimplemented' ? 501 : 403 })
    })
    const bots = await f.client.listBots()
    assert.equal(bots.length, 1)
    assert.equal(bots[0].main, false)
    assert.equal(f.calls.length, 2)
  }
})

test('optional account failure leaves main unset without backend requests', async () => {
  const f = mainFixture(() => ({ agents: [{ id: 'example-bot' }] }), () => { throw new Error('fixture signed out') })
  assert.equal((await f.client.listBots())[0].main, false)
  assert.deepEqual(f.calls, ['listAgents'])
})

test('main settings and roster enrichment start in parallel and settle independently', async () => {
  let releaseMain: (value: unknown) => void = () => {}
  const mainPending = new Promise(resolve => { releaseMain = resolve })
  let rosterStarted: () => void = () => {}
  const rosterReady = new Promise<void>(resolve => { rosterStarted = resolve })
  const f = mainFixture(method => {
    if (method === 'listAgents') return { agents: [{ id: 'example-bot' }] }
    if (method === 'GetGrokBotUserRuntimeSettings') return mainPending
    rosterStarted()
    return { agents: [{ agentId: 'example-bot', id: 'server-record', harness: 'temporal' }] }
  })
  const list = f.client.listBots()
  await rosterReady // This cannot resolve if roster enrichment waits for main settings.
  releaseMain({ settings: { mainAgentId: 'example-bot' } })
  const bots = await list
  assert.equal(bots[0].main, true)
  assert.equal(bots[0].serverRun, true)
  assert.deepEqual(f.calls, ['listAgents', 'GetGrokBotUserRuntimeSettings', 'ListGrokBotAgents'])

  const rosterFailure = mainFixture(method => {
    if (method === 'listAgents') return { agents: [{ id: 'example-bot' }] }
    if (method === 'ListGrokBotAgents') throw new Error('fixture roster unavailable')
    return { settings: { mainAgentId: 'example-bot' } }
  })
  assert.equal((await rosterFailure.client.listBots())[0].main, true)
})

test('a main settings deadline returns the roster without failing or replaying', async () => {
  let expire: (() => void) | undefined
  const calls: string[] = []
  const client = createGatewayClient({
    getRoute: () => route, refreshRoute: () => route,
    getAccount: () => ({ account: { key: 'fixture-account', accessToken: 'fixture-token' } }),
    fetch: (async (url: any) => {
      const method = String(url).split('/').pop()!
      calls.push(method)
      if (method === 'listAgents') return new Response(JSON.stringify({ agents: [{ id: 'example-bot', harness: 'box' }] }))
      return new Promise(() => {})
    }) as typeof globalThis.fetch,
    setTimeout: ((fn: () => void) => { expire = fn; return 1 }) as any,
    clearTimeout: (() => {}) as any
  })
  const pending = client.listBots()
  // Drain the finite promise chain until the optional request has installed its deadline.
  while (!calls.includes('GetGrokBotUserRuntimeSettings')) await Promise.resolve()
  expire!()
  const bots = await pending
  assert.equal(bots.length, 1)
  assert.equal(bots[0].main, false)
  assert.deepEqual(calls, ['listAgents', 'GetGrokBotUserRuntimeSettings'])
})
