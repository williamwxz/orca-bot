import { assert, test } from 'orca/testing'
import { deleteServerBot, listServerBots, sendServerMessage } from './server.ts'
import { request } from './gateway.ts'

const account = { key: 'fixture-account', accessToken: 'fixture-access-token', teamId: '42' }
const input = { agentId: 'fixture-runtime-id', messageId: 'fixture-nonce', text: 'Hello' }
const base = 'https://api2.cursor.sh/aiserver.v1.GrokBotService/'
function fake(body: unknown, status = 200) {
  const calls: any[] = []
  const fetch = (async (url: any, init: any) => {
    calls.push({ url, ...init, body: JSON.parse(init.body) })
    return new Response(JSON.stringify(body), { status })
  }) as typeof globalThis.fetch
  return { fetch, calls }
}
function check(call: any, method: string, body: unknown) {
  assert.equal(call.url, base + method)
  assert.equal(call.method, 'POST')
  assert.equal(call.redirect, 'error')
  assert.ok(call.signal instanceof AbortSignal)
  assert.deepEqual(call.body, body)
  assert.deepEqual(call.headers, {
    'content-type': 'application/json',
    'connect-protocol-version': '1',
    authorization: 'Bearer fixture-access-token',
    'x-cursor-client-type': 'sand',
    'x-cursor-client-version': '1.2.3',
    'x-sand-box-namespace': 'prod',
    'x-cursor-team-id': '42'
  })
}
test('backend calls have exact URLs, headers and bodies and keep both roster ids', async () => {
  const row = { agentId: 'fixture-runtime-id', id: 'fixture-record-id', harness: 'temporal' }
  const roster = fake({ agents: [{ ...row, name: 'Example' }] })
  assert.deepEqual(await listServerBots(account, '1.2.3', roster), [row])
  check(roster.calls[0], 'ListGrokBotAgents', {})
  const send = fake({ delivery: 2 })
  const before = Date.now()
  assert.deepEqual(await sendServerMessage(account, '1.2.3', input, send), { delivery: 'accepted' })
  const sentAtMs = send.calls[0].body.sentAtMs
  assert.match(sentAtMs, /^\d+$/)
  assert.ok(Number(sentAtMs) >= before && Number(sentAtMs) <= Date.now())
  check(send.calls[0], 'SendGrokBotUserMessage', { ...input, sentAtMs })
  const deletion = fake({})
  await deleteServerBot(account, '1.2.3', input.agentId, deletion)
  check(deletion.calls[0], 'DeleteGrokBotAgent', { id: input.agentId })
})
test('optional team and invalid app version use the shared header rules', async () => {
  const f = fake({ agents: [] })
  await listServerBots({ key: account.key, accessToken: account.accessToken }, 'invalid', f)
  assert.equal(f.calls[0].headers['x-cursor-team-id'], undefined)
  assert.equal(f.calls[0].headers['x-cursor-client-version'], '0.20.0')
})
test('delivery values and both enum name forms are mapped conservatively', async () => {
  for (const delivery of [1, 2, 3, 'ACCEPTED_BOX', 'ACCEPTED_TEMPORAL', 'DUPLICATE',
    'GROK_BOT_USER_MESSAGE_DELIVERY_ACCEPTED_BOX', 'GROK_BOT_USER_MESSAGE_DELIVERY_ACCEPTED_TEMPORAL',
    'GROK_BOT_USER_MESSAGE_DELIVERY_DUPLICATE']) {
    assert.deepEqual(await sendServerMessage(account, undefined, input, fake({ delivery })), { delivery: 'accepted' })
  }
  for (const delivery of [0, undefined, 99, 'UNSPECIFIED', 'unknown', '1']) {
    assert.deepEqual(await sendServerMessage(account, undefined, input, fake({ delivery })), { delivery: 'unknown' })
  }
  for (const delivery of [4, 'REFUSED', 'GROK_BOT_USER_MESSAGE_DELIVERY_REFUSED']) {
    await assert.rejects(sendServerMessage(account, undefined, input, fake({ delivery })), /Grok Bot refused/)
  }
  await assert.rejects(sendServerMessage(account, undefined, input, fake({
    delivery: 2, refusal: { message: `Denied ${account.accessToken}` }
  })), (e: any) => e.code === 'server_refused' && e.message === 'Grok Bot refused the message: Denied [redacted]')
})
test('Connect access errors, unsupported methods and delete NotFound', async () => {
  for (const code of ['unauthenticated', 'permission_denied', 'unimplemented']) {
    const response = () => fake({ code, message: account.accessToken }, code === 'unimplemented' ? 501 : 403)
    await assert.rejects(listServerBots(account, undefined, response()), (e: any) =>
      e.code === (code === 'unimplemented' ? 'unsupported_version' : 'not_signed_in'))
    for (const write of [
      () => sendServerMessage(account, undefined, input, response()),
      () => deleteServerBot(account, undefined, input.agentId, response())
    ]) {
      await assert.rejects(write(), (e: any) => {
        assert.equal(e.message.includes(account.accessToken), false)
        assert.equal(e.code, code === 'unimplemented' ? 'unsupported_version' : 'server_refused')
        assert.match(e.message, code === 'unimplemented' ? /^This version of Grok Bot is not supported yet$/ : /Grok Bot refused/)
        return true
      })
    }
  }
  await deleteServerBot(account, undefined, input.agentId, fake({ code: 'not_found' }, 404))
  await assert.rejects(deleteServerBot(account, undefined, input.agentId, fake({}, 404)), (e: any) => e.status === 404)
})
test('backend transport redacts errors and enforces the backend URL policy', async () => {
  await assert.rejects(listServerBots(account, undefined, fake({ message: account.accessToken }, 400)), (e: any) =>
    !e.message.includes(account.accessToken) && e.message.includes('[redacted]'))
  const f = fake({})
  for (const url of ['http://api2.cursor.sh', 'https://example.cursorvm.com', 'https://cursor.sh.evil.invalid', 'https://user:pass@api2.cursor.sh']) {
    await assert.rejects(request(url, {}, {}, 'ListGrokBotAgents', f, [account.accessToken], 'backend'), /not allowed/)
  }
  assert.equal(f.calls.length, 0)
  const fetch = (async () => { throw new Error(account.accessToken) }) as typeof globalThis.fetch
  await assert.rejects(sendServerMessage(account, undefined, input, { fetch }), (e: any) =>
    e.code === 'outcome_unknown' && !e.message.includes(account.accessToken))
})
test('backend send deadline and 5xx are unknown with one request and no replay', async () => {
  let expire: () => void = () => {}
  let calls = 0
  const fetch = (async () => {
    calls += 1
    return new Promise(() => {})
  }) as typeof globalThis.fetch
  const pending = sendServerMessage(account, undefined, input, {
    fetch,
    setTimeout: ((fn: () => void) => { expire = fn; return 1 }) as any,
    clearTimeout: (() => {}) as any
  })
  expire()
  await assert.rejects(pending, (e: any) => e.code === 'outcome_unknown')
  assert.equal(calls, 1)
  for (const status of [500, 503]) {
    const f = fake({ message: account.accessToken }, status)
    await assert.rejects(sendServerMessage(account, undefined, input, f), (e: any) => e.code === 'outcome_unknown')
    assert.equal(f.calls.length, 1)
  }
})
